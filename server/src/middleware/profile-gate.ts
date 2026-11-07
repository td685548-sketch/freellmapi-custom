import type { NextFunction, Request, Response } from 'express';
import { setRequestAllowedModels, setRequestEndUser, setRequestProfile } from '../lib/client-context.js';
import { endUserOf, enforceEndUserQuota } from '../custom/end-user-gate.js';
import { injectKnowledge } from '../custom/knowledge-inject.js';
import { applyConversation } from '../custom/conversation-inject.js';
import { screenContent } from '../custom/content-filter-gate.js';
import { answerQuickly } from '../custom/quick-answer-gate.js';
import { capOutputTokens, checkModel, refuse } from '../custom/profile-restrictions.js';
import { enforceUsageQuota } from '../custom/quota-gate.js';
import { CLIENT_PROFILE_KEY_PREFIX } from '../lib/system-prompt.js';
import { profileForGate } from '../services/profile-usage.js';
import { checkUserRateLimit } from '../services/user-quotas.js';
import { extractInferenceToken } from './user-rate-limit.js';

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
  // Once admitted: add the stored conversation and the key's reference passages, then route.
  const proceed = () => {
    if (!applyConversation(req, res, profile.id, endUser, profile.conversations)) return;
    // A ready answer ends the request here (a stored conversation still records it).
    if (answerQuickly(req, res, profile.id, profile.quickAnswers)) return;
    if (profile.knowledge.enabled) injectKnowledge(req, profile.id, profile.knowledge.maxChars);
    next();
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
