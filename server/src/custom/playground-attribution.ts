import type { NextFunction, Request, Response } from 'express';
import { resolveAuth } from '../lib/system-prompt.js';
import { setRequestUser } from '../lib/client-context.js';
import { validateSession } from '../services/auth.js';
import { extractInferenceToken } from '../middleware/user-rate-limit.js';

// The Playground calls /v1 with the shared unified key, so its chats were nobody's in the per-account
// numbers. It now also sends the dashboard session (X-FreeLLM-Session, same origin as the token it
// already sends to /api); a unified-key request with a valid session is attributed to that account.
// Attribution only: no per-account rate limit or allowance applies to the unified key.

export const PLAYGROUND_SESSION_HEADER = 'x-freellm-session';

export function playgroundAttribution(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers[PLAYGROUND_SESSION_HEADER];
  const session = Array.isArray(raw) ? raw[0] : raw;
  if (session) {
    try {
      if (resolveAuth(extractInferenceToken(req))?.kind === 'unified') {
        const user = validateSession(session);
        if (user) setRequestUser(user.userId);
      }
    } catch { /* attribution is best effort */ }
  }
  next();
}
