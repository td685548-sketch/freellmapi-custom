/**
 * OpenCode Console OAuth device login for OpenCode Free accounts.
 *
 * Mounted at /api/thruline-accounts/opencode-oauth. Guarded like the other
 * Thruline provider-account routes: dashboard session + `use_x_gateway`, with
 * `edit_keys` for anything that changes the stored credential and `view_keys`
 * for reading the login state.
 */
import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import type { SessionUser } from '../services/auth.js';
import { AccountError } from '../custom/provider-accounts/http.js';
import type { AccountActor } from '../custom/provider-accounts/attempts.js';
import {
  cancelOpenCodeConsoleLogin,
  disconnectOpenCodeConsoleLogin,
  openCodeConsoleLoginStatus,
  pollOpenCodeConsoleLogin,
  startOpenCodeConsoleLogin,
} from '../custom/provider-accounts/opencode-oauth.js';

export const opencodeConsoleOAuthRouter = Router();
opencodeConsoleOAuthRouter.use(requireAuth, requirePermission('use_x_gateway'));
opencodeConsoleOAuthRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

type SessionRequest = Request & { user?: SessionUser; sessionToken?: string };

function actor(req: SessionRequest): AccountActor {
  if (!req.user || !req.sessionToken) throw new AccountError(401, 'Authentication required.');
  return { userId: req.user.userId, sessionToken: req.sessionToken };
}

function accountId(req: Request): number {
  const value = String(req.params.accountId);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AccountError(400, 'Invalid account ID.');
  return Number(value);
}

function attemptId(req: Request): string {
  const value = String(req.params.attemptId ?? '');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new AccountError(400, 'Invalid login attempt ID.');
  return value;
}

/** Start a Console device login for an OpenCode Free account. */
opencodeConsoleOAuthRouter.post('/:accountId/start', requirePermission('edit_keys'), async (req, res) => {
  const result = await startOpenCodeConsoleLogin(accountId(req), actor(req as SessionRequest));
  res.status(201).json(result);
});

/** Poll a pending login attempt until it connects or expires. */
opencodeConsoleOAuthRouter.post('/:attemptId/poll', requirePermission('edit_keys'), async (req, res) => {
  res.json(await pollOpenCodeConsoleLogin(attemptId(req), actor(req as SessionRequest)));
});

/** Whether an account currently holds a Console login. */
opencodeConsoleOAuthRouter.get('/:accountId/status', requirePermission('view_keys'), (req, res) => {
  res.json(openCodeConsoleLoginStatus(accountId(req)));
});

/** Drop the stored Console login and restore the keyless credential. */
opencodeConsoleOAuthRouter.post('/:accountId/disconnect', requirePermission('edit_keys'), (req, res) => {
  res.json(disconnectOpenCodeConsoleLogin(accountId(req)));
});

/** Cancel a pending login attempt. */
opencodeConsoleOAuthRouter.delete('/:attemptId', requirePermission('edit_keys'), (req, res) => {
  cancelOpenCodeConsoleLogin(attemptId(req), actor(req as SessionRequest));
  res.status(204).end();
});
