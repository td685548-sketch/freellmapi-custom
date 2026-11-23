import type { NextFunction, Request, Response } from 'express';
import { resolveAuth } from '../lib/system-prompt.js';
import { setRequestUser } from '../lib/client-context.js';
import { validateSession } from '../services/auth.js';
import { getSessionCookie } from '../services/session-cookie.js';
import { extractInferenceToken } from '../middleware/user-rate-limit.js';

// The Playground calls /v1 with the shared unified key, so its chats were nobody's in the per-account
// numbers. Attribution now reads the dashboard session cookie-first: the
// flm_session cookie is Path=/, so the browser sends it on same-origin /v1
// calls (fetch defaults to credentials: 'same-origin'). If no cookie
// validates, it falls back to the X-FreeLLM-Session header — the server-side
// loopbacks (customer-ai chatWithAssistant, copilot Tier 2) forward the
// caller's session that way because a server-side fetch has no cookie jar.
// A unified-key request with a valid session is attributed to that account;
// the first candidate that validates wins, so a valid cookie always beats a
// header for a different user.
//
// Attribution only, never auth: no per-account rate limit or allowance
// applies to the unified key, and this middleware never grants access —
// /v1 still requires the unified key itself. Forging attribution needs a
// valid session token, and anyone holding one can already present it as a
// cookie for full session auth, so the fallback grants no new capability.

export const PLAYGROUND_SESSION_HEADER = 'x-freellm-session';

function headerSession(req: Request): string | undefined {
  const raw = req.headers[PLAYGROUND_SESSION_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function playgroundAttribution(req: Request, _res: Response, next: NextFunction): void {
  const candidates = [getSessionCookie(req), headerSession(req)].filter((s): s is string => Boolean(s));
  if (candidates.length === 0) { next(); return; }
  try {
    // The unified-kind gate is shared by every candidate: a personal or
    // profile key is already attributed by its own gate, and a missing or
    // bogus key attributes nothing.
    if (resolveAuth(extractInferenceToken(req))?.kind === 'unified') {
      for (const session of candidates) {
        try {
          const user = validateSession(session);
          if (user) { setRequestUser(user.userId); break; }
        } catch { /* attribution is best effort */ }
      }
    }
  } catch { /* attribution is best effort */ }
  next();
}
