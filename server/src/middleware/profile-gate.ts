import type { NextFunction, Request, Response } from 'express';
import { setRequestAllowedModels, setRequestEndUser, setRequestProfile } from '../lib/client-context.js';
import { endUserOf, enforceEndUserQuota } from '../custom/end-user-gate.js';
import { injectKnowledge } from '../custom/knowledge-inject.js';
import { applyConversation } from '../custom/conversation-inject.js';
import { screenContent } from '../custom/content-filter-gate.js';
import { answerQuickly } from '../custom/quick-answer-gate.js';
import { latestUserText } from '../custom/content-filter-gate.js';
import { findQuickAnswer } from '../services/quick-answers.js';
import { capOutputTokens, checkModel, refuse } from '../custom/profile-restrictions.js';
import { enforceUsageQuota } from '../custom/quota-gate.js';
import { CLIENT_PROFILE_KEY_PREFIX } from '../lib/system-prompt.js';
import { profileForGate } from '../services/profile-usage.js';
import { checkUserRateLimit } from '../services/user-quotas.js';
import { extractInferenceToken } from './user-rate-limit.js';
import { runPreRequest } from '../custom/ai-platform/pipeline.js';
import { captureInternalCall, isEnrichmentAlreadyApplied, isInternalCall } from '../custom/ai-platform/loopback.js';
import { prepareMcpTakeover, refreshMcpTakeoverMessages } from '../custom/ai-platform/mcp-client/admission.js';

/**
 * Attributes /v1 and /v1beta traffic made with a client-profile key (`sk-cp-…`) to
 * that profile, and enforces the profile's per-minute cap when it has one.
 *
 * The cap reuses the per-account sliding window. Profile ids live in the same
 * number space as user ids there, so a profile is keyed by its NEGATIVE id.
 *
 * Unknown or disabled keys are not answered here: they continue to the normal
 * authentication, which rejects them exactly as before.
 */
export function profileInferenceGate(req: Request, res: Response, next: NextFunction): void {
  captureInternalCall(req);
  const token = extractInferenceToken(req);
  if (!token || !token.startsWith(CLIENT_PROFILE_KEY_PREFIX)) return next();

  const profile = profileForGate(token);
  if (!profile) return next();

  const context = setRequestProfile(profile.id);
  const endUser = endUserOf(req);
  if (endUser) setRequestEndUser(endUser);

  // Restrictions first: a refused request costs the key neither a rate-limit slot nor an allowance.
  if (profile.allowedModels.length > 0) {
    const allowed = new Set(profile.allowedModels);
    const refusal = checkModel(req, allowed);
    if (refusal) { refuse(res, refusal, allowed); return; }
    setRequestAllowedModels(allowed);
  }
  if (profile.maxTokens !== null) capOutputTokens(req, profile.maxTokens);
  // Content rules next, for the same reason: a blocked message costs nothing.
  if (!screenContent(req, res, profile.id, endUser, profile.contentFilter)) return;

  const tokens = () => context?.userTokens ?? 0;
  const internalCall = isInternalCall(req) !== null;
  let conversationApplied = false;

  // F06: Apply stored conversation ONCE on outer request so history & reply capture
  // work across both MCP takeover and normal gateway paths, and invalid X-Conversation-Id
  // is still rejected when MCP is enabled.
  if (!internalCall) {
    if (!applyConversation(req, res, profile.id, endUser, profile.conversations)) return;
    conversationApplied = true;
  }

  // Keep quick-answer policy intact: if a quick answer matches, do not take over with MCP
  // so normal outer RPM/quota + quick-answer response runs unchanged.
  let quickAnswerMatches = false;
  if (!internalCall && profile.quickAnswers.enabled) {
    const qaPath = req.originalUrl.split('?')[0]!.replace(/\/+$/, '');
    if (req.method === 'POST' && (qaPath === '/v1/chat/completions' || qaPath === '/v1/messages')) {
      const qaText = latestUserText(req);
      if (qaText && findQuickAnswer(profile.id, qaText, profile.quickAnswers.minSimilarity)) {
        quickAnswerMatches = true;
      }
    }
  }

  // T049 / F05 / F06 / F09: Prepare MCP server-side takeover BEFORE outer RPM/quota admission.
  // Only a safely convertible takeover skips outer quota; each inner round settles once.
  const mcpPlan = quickAnswerMatches ? null : prepareMcpTakeover(req, profile, endUser);
  if (mcpPlan !== null) {
    if (profile.knowledge.enabled) {
      injectKnowledge(req, profile.id, profile.knowledge.maxChars);
      refreshMcpTakeoverMessages(req);
    }
    runPreRequest(req, res, profile, endUser)
      .then((result) => {
        if (result !== 'handled' && !res.headersSent) {
          res.status(500).json({
            error: {
              message: 'MCP takeover failed to complete.',
              type: 'internal_error',
              code: 'mcp_takeover_unhandled',
            },
          });
        }
      })
      .catch(() => {
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: 'MCP takeover failed.',
              type: 'internal_error',
              code: 'mcp_takeover_error',
            },
          });
        }
      });
    return;
  }

  // Once admitted: add the stored conversation and the key's reference passages, then route.
  const proceed = () => {
    if (!internalCall) {
      if (!conversationApplied && !applyConversation(req, res, profile.id, endUser, profile.conversations)) return;
      // A ready answer ends the request here (a stored conversation still records it).
      if (answerQuickly(req, res, profile.id, profile.quickAnswers)) return;
    }
    if (profile.knowledge.enabled && !isEnrichmentAlreadyApplied(req)) {
      injectKnowledge(req, profile.id, profile.knowledge.maxChars);
    }
    // Pipeline composition boundary (T029): call AI platform pre-request hook before next().
    // With all flags off, the promise resolves without changing the request/response.
    runPreRequest(req, res, profile, endUser).then(result => {
      if (result === 'handled') return;
      next();
    }).catch(err => next(err));
  };
  // The end user's own allowance before the key's, so a refused end user does not touch the key's totals.
  const quota = () => enforceEndUserQuota(profile.id, endUser, profile.endUserQuota, res, tokens)
    && enforceUsageQuota('profile', profile.id, res, tokens);
  if (profile.rpmLimit === null) { if (quota()) proceed(); return; }

  const limit = checkUserRateLimit(-profile.id, profile.rpmLimit);
  res.setHeader('X-RateLimit-Limit-Profile-RPM', limit.limit.toString());
  res.setHeader('X-RateLimit-Remaining-Profile-RPM', limit.remaining.toString());
  res.setHeader('X-RateLimit-Reset-Profile-RPM', limit.resetSeconds.toString());
  if (!limit.allowed) {
    res.status(429).json({
      error: {
        message: `Rate limit exceeded. This key allows ${limit.limit} requests per minute. Please retry in ${limit.resetSeconds} seconds.`,
        type: 'rate_limit_exceeded',
        code: 'profile_rate_limit_exceeded',
      },
    });
    return;
  }
  if (quota()) proceed();
}
