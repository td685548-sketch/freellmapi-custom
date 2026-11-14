import type { Request, Response } from 'express';
import type { GateProfile } from '../../services/profile-usage.js';
import { getFlags } from './flags.js';
import { isInternalCall } from './loopback.js';

/**
 * T029 — Pipeline composition boundary (FR-008 fixed order).
 *
 * Single entry point called by `profile-gate.ts` before `next()`.
 * All 6 pillars default to `false`; when all flags are false (or on a valid
 * internal loopback call), this returns `'continue'` without modifying `req.body`
 * or `res` (preserving exact references).
 */
export async function runPreRequest(
  req: Request,
  _res: Response,
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

  // Fixed FR-008 order (slots wired in US2–US7):
  // 4. SLOT: orchestrator (flow:<slug> takeover)
  // 5. SLOT: prompts (variable substitution)
  // 6. SLOT: retrieval (semantic RAG injection)
  // 7. SLOT: mcpClient (tool definitions & server-side loop)
  // 8. SLOT: promptCache (per-provider cache breakpoints)
  // 10. SLOT: outputGuard / response interceptor (only when filters are non-empty)

  return 'continue';
}
