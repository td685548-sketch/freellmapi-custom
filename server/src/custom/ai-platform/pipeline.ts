import type { Request, Response } from 'express';
import type { GateProfile } from '../../services/profile-usage.js';
import { getFlags } from './flags.js';
import { GatewayCallError, isInternalCall } from './loopback.js';
import { consumeMcpTakeoverPlan, refreshMcpTakeoverMessages } from './mcp-client/admission.js';
import { sendMcpLoopResult } from './mcp-client/respond.js';
import { runToolLoop } from './mcp-client/tool-loop.js';
import { buildProfileGuardContext, type ProfileGuardContext } from './output-guard/context.js';
import {
  captureCallerCacheControl,
  getActiveCacheTargetForRequest,
  getCapturedCacheUsageForRequest,
  markPromptCacheInterceptorInstalled,
} from './prompt-cache/runtime.js';
import { cacheUsageFilter } from './prompt-cache/stats.js';
import { detectWire } from './wire/detect.js';
import { installInterceptor, type OutputFilter } from './wire/interceptor.js';
import { injectRetrievedKnowledgeForSlot6 } from '../knowledge-inject.js';
import {
  getKnowledgeTokenCap,
  knowledgeCandidateMaxChars,
  selectPassagesWithinTokens,
  type PassageCandidate,
  type SelectPassagesOptions,
} from '../context-budget/gate.js';
import {
  capturePromptRequestContext,
  getCapturedPromptHeader,
} from './prompts/render.js';
import { getFlowBySlug, isFlowGrantedToProfile } from './orchestrator/definitions.js';
import { executeFlowHttpRequest, extractRequestedModel, isFlowModel } from './orchestrator/engine.js';

export type OutputFilterProvider = (ctx: ProfileGuardContext) => OutputFilter | null;

let registeredFilterProvider: OutputFilterProvider | null = null;

/**
 * Registers the policy-backed `outputFilterFor` adapter once `output-guard/policy.ts`
 * is integrated, avoiding missing-module errors during S0.
 */
export function registerOutputFilterProvider(provider: OutputFilterProvider | null): void {
  registeredFilterProvider = provider;
}

/**
 * Idempotently installs the prompt-cache usage stats filter on `res` before
 * `citationFilter` and `outputFilterFor` (filter order: stats -> citations -> outputGuard).
 * Returns immediately without wrapping `res` when `promptCache` is disabled.
 */
export function installPromptCacheFilterIfNeeded(
  req: Request,
  res: Response,
  profile: GateProfile,
): void {
  const flags = getFlags();
  if (!flags.promptCache) return;
  if (isInternalCall(req) !== null) return;

  const detected = detectWire(req);
  if (!detected) return;

  markPromptCacheInterceptorInstalled(res);
  const filter = cacheUsageFilter(profile.id, detected.wire, {
    res,
    getRoute: () => getActiveCacheTargetForRequest(res),
    getUpstreamUsage: () => getCapturedCacheUsageForRequest(res),
  });
  installInterceptor(req, res, detected.wire, [filter]);
}

/**
 * Idempotently installs the output guard interceptor on `res` before any early-handled
 * response (`answerQuickly`, `sendMcpLoopResult`, exact cache hit, or normal provider).
 * Skips verified internal loopback subcalls and returns immediately when `outputGuard` is off.
 */
export function installOutputGuardIfNeeded(
  req: Request,
  res: Response,
  profile: GateProfile,
  endUser: string | null,
): void {
  installPromptCacheFilterIfNeeded(req, res, profile);

  const flags = getFlags();
  if (!flags.outputGuard) return;
  if (isInternalCall(req) !== null) return;
  if (!registeredFilterProvider) return;

  const detected = detectWire(req);
  if (!detected) return;

  const ctx = buildProfileGuardContext(req, profile, endUser, detected.wire, detected.stream);
  const ac = new AbortController();
  ctx.signal = ac.signal;
  const filter = registeredFilterProvider(ctx);
  if (filter) {
    const cleanup = () => {
      res.off('close', onClose);
      res.off('finish', cleanup);
    };
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
      cleanup();
    };
    res.once('close', onClose);
    res.once('finish', cleanup);
    installInterceptor(req, res, detected.wire, [filter]);
  }
}

/**
 * T029 / T049 — Pipeline composition boundary (FR-008 fixed order).
 *
 * Single entry point called by `profile-gate.ts` before `next()`.
 * All 6 pillars default to `false`; when all flags are false (or on a valid
 * internal loopback call), this returns `'continue'` without modifying `req.body`
 * or `res` (preserving exact references).
 */
export async function runPreRequest(
  req: Request,
  res: Response,
  _profile: GateProfile,
  _endUser: string | null,
): Promise<'continue' | 'handled'> {
  const flags = getFlags();

  // Fast path: all flags false → no I/O, no req/res modification.
  if (
    !flags.prompts &&
    !flags.retrieval &&
    !flags.promptCache &&
    !flags.mcpClient &&
    !flags.outputGuard &&
    !flags.orchestrator
  ) {
    return 'continue';
  }

  // Valid internal loopback calls bypass orchestrator, MCP loop, and output guard
  // so sub-calls inherit routing/quotas without re-entering platform hooks.
  if (isInternalCall(req) !== null) {
    // The sub-call still renders the profile's versioned prompt (e.g. each MCP
    // tool-loop round), so it needs the caller's prompt variables forwarded by
    // callGateway; without this they fell back to their defaults.
    if (flags.prompts) capturePromptRequestContext(req, _profile, _endUser);
    return 'continue';
  }

  // Fixed FR-008 order:
  // 4. SLOT: orchestrator (flow:<slug> takeover)
  if (flags.orchestrator) {
    const detected = detectWire(req);
    if (detected) {
      const reqModel = extractRequestedModel(detected.wire, req).trim();
      if (reqModel.startsWith('flow:')) {
        const flowSlug = isFlowModel(reqModel);
        const flow = flowSlug ? getFlowBySlug(flowSlug) : null;
        if (!flow || !flow.enabled || !flow.published || flow.publishedVersion <= 0) {
          if (!res.headersSent) {
            res.status(404).json({
              error: {
                message: 'Flow not found.',
                type: 'not_found_error',
                code: 'flow_not_found',
              },
            });
          }
          return 'handled';
        }
        if (!isFlowGrantedToProfile(flow.id, _profile.id)) {
          if (!res.headersSent) {
            res.status(403).json({
              error: {
                message: 'Client key is not granted access to this flow.',
                type: 'permission_error',
                code: 'flow_not_granted',
              },
            });
          }
          return 'handled';
        }
        await executeFlowHttpRequest(
          req,
          res,
          _profile.id,
          _endUser,
          detected.wire,
          detected.stream,
          flowSlug!,
        );
        return 'handled';
      }
    }
  }
  // 5. SLOT: prompts (variable substitution & A/B rollout header)
  if (flags.prompts) {
    capturePromptRequestContext(req, _profile, _endUser);
    const headerVal = getCapturedPromptHeader();
    if (headerVal && !res.headersSent) {
      res.setHeader('X-FreeLLM-Prompt-Version', headerVal);
    }
  }
  // 6. SLOT: retrieval (semantic RAG injection)
  if (flags.promptCache) {
    installPromptCacheFilterIfNeeded(req, res, _profile);
  }
  if (flags.retrieval) {
    const tokenCap = getKnowledgeTokenCap(req);
    await injectRetrievedKnowledgeForSlot6(req, res, {
      profileId: _profile.id,
      maxChars:
        tokenCap !== null
          ? knowledgeCandidateMaxChars(tokenCap)
          : _profile.knowledge?.maxChars,
      knowledgeEnabled: _profile.knowledge?.enabled,
      ...(tokenCap !== null
        ? {
            tokenCap,
            selectPassages: <T extends PassageCandidate>(
              passages: readonly T[],
              options?: SelectPassagesOptions,
            ) => selectPassagesWithinTokens(passages, tokenCap, options),
          }
        : {}),
    });
    refreshMcpTakeoverMessages(req);
  }

  // 7. SLOT: mcpClient (tool definitions & server-side loop)
  const preparedMcp = flags.mcpClient ? consumeMcpTakeoverPlan(req) : null;
  if (preparedMcp) {
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);
    try {
      const result = await runToolLoop(req, {
        scope: preparedMcp.plan.scope,
        messages: preparedMcp.messages,
        model: preparedMcp.plan.model,
        callerTools: preparedMcp.plan.callerTools,
        maxRounds: preparedMcp.plan.maxRounds,
        signal: ac.signal,
        endUser: preparedMcp.endUser,
        params: preparedMcp.params,
      });

      if (!res.headersSent) {
        res.setHeader('x-freellm-tool-rounds', String(result.rounds));
        if (result.toolsSkippedReason === 'unsupported_model') {
          res.setHeader('x-freellm-tools-skipped', 'unsupported_model');
        }
        sendMcpLoopResult(
          res,
          preparedMcp.plan.wire,
          preparedMcp.plan.stream,
          result,
          result.servedModel ?? preparedMcp.plan.model,
        );
      }
    } catch (err) {
      if (!res.headersSent) {
        const status = err instanceof GatewayCallError ? err.status : 502;
        const code = err instanceof GatewayCallError ? err.code : 'mcp_loop_failed';
        res.status(status).json({
          error: {
            message: err instanceof Error ? err.message : 'MCP tool loop failed.',
            type: status === 429 ? 'rate_limit_error' : 'api_error',
            code,
          },
        });
      }
    } finally {
      res.off('close', onClose);
    }
    return 'handled';
  }

  // 8. SLOT: promptCache (per-provider cache breakpoints)
  if (flags.promptCache) {
    captureCallerCacheControl(req);
  }

  // 10. SLOT: outputGuard / response interceptor (idempotent; also installed before early handlers)
  installOutputGuardIfNeeded(req, res, _profile, _endUser);

  return 'continue';
}

// Ensure default outputFilterFor provider is registered when pipeline is loaded standalone.
void import('./output-guard/policy.js').catch(() => {});
