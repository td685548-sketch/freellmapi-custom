import type { Request, Response } from 'express';
import type { GateProfile } from '../../services/profile-usage.js';
import { getFlags } from './flags.js';
import { GatewayCallError, isInternalCall } from './loopback.js';
import { consumeMcpTakeoverPlan } from './mcp-client/admission.js';
import { sendMcpLoopResult } from './mcp-client/respond.js';
import { runToolLoop } from './mcp-client/tool-loop.js';

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
    return 'continue';
  }

  // Fixed FR-008 order:
  // 4. SLOT: orchestrator (flow:<slug> takeover)
  // 5. SLOT: prompts (variable substitution)
  // 6. SLOT: retrieval (semantic RAG injection)

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
  // 10. SLOT: outputGuard / response interceptor (only when filters are non-empty)

  return 'continue';
}
