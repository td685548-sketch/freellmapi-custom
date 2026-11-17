import { Router } from 'express';
import { z } from 'zod';
import { accountRow } from '../../provider-accounts/store.js';
import { listAccountQuotas, QUOTA_FRESHNESS_MS, refreshAccountQuota, refreshAllSupportedQuotas, setQuotaTier } from './store.js';
import { consumeCodexResetCredit, fetchCodexResetCredits } from './codex-reset.js';
import { consumeClaudeResetGrant, fetchClaudeResetGrants } from './claude-reset.js';

export const xQuotaRouter = Router();
xQuotaRouter.get('/quota', (_req, res) => res.json({ accounts: listAccountQuotas(), freshnessMs: QUOTA_FRESHNESS_MS }));
xQuotaRouter.post('/quota/refresh', async (req, res) => {
  const force = req.query.force === '1' || req.query.force === 'true';
  res.json({ accounts: await refreshAllSupportedQuotas(force), freshnessMs: QUOTA_FRESHNESS_MS });
});
const tierSchema = z.object({ tier: z.enum(['subscription', 'cheap', 'free']) }).strict();
xQuotaRouter.use('/quota/:id', (req, res, next) => {
  if (!/^[1-9]\d*$/.test(String(req.params.id)) || !Number.isSafeInteger(Number(req.params.id))) {
    res.status(400).json({ error: { message: 'Invalid account ID.', type: 'invalid_request_error' } }); return;
  }
  try { accountRow(Number(req.params.id)); } catch {
    res.status(404).json({ error: { message: 'Account not found.', type: 'not_found' } }); return;
  }
  next();
});
xQuotaRouter.post('/quota/:id/refresh', async (req, res) => res.json(await refreshAccountQuota(Number(req.params.id))));
xQuotaRouter.put('/quota/:id/tier', (req, res) => {
  const parsed = tierSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: { message: 'Invalid routing tier.', type: 'invalid_request_error' } }); return; }
  setQuotaTier(Number(req.params.id), parsed.data.tier);
  res.json({ ok: true, tier: parsed.data.tier });
});

xQuotaRouter.get('/quota/:id/codex-reset-credits', async (req, res) => {
  try {
    const account = accountRow(Number(req.params.id));
    if (account.provider !== 'codex') {
      res.status(400).json({ error: { message: 'Codex reset credits are only available for Codex accounts.', type: 'invalid_request_error' } });
      return;
    }
    const info = await fetchCodexResetCredits(account);
    res.json(info);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Failed to load Codex reset credits.';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: { message, type: 'upstream_error' } });
  }
});

xQuotaRouter.post('/quota/:id/codex-reset-credits', async (req, res) => {
  try {
    const account = accountRow(Number(req.params.id));
    if (account.provider !== 'codex') {
      res.status(400).json({ error: { message: 'Codex reset credits are only available for Codex accounts.', type: 'invalid_request_error' } });
      return;
    }
    const result = await consumeCodexResetCredit(account);
    if (result.ok) {
      const quota = await refreshAccountQuota(account.id, true).catch(() => null);
      res.json({
        ok: true,
        code: result.code,
        reset: true,
        windows_reset: result.windowsReset,
        redeemRequestId: result.redeemRequestId,
        credit: result.credit,
        quota,
      });
      return;
    }
    if (result.noCredit) {
      res.status(409).json({
        ok: false,
        code: 'no_credit',
        reset: false,
        windows_reset: result.windowsReset,
        message: 'No Codex reset credits available.',
      });
      return;
    }
    const status = result.status >= 400 && result.status < 500 ? result.status : 502;
    res.status(status).json({
      ok: false,
      code: result.code ?? 'unknown_response',
      reset: false,
      windows_reset: result.windowsReset,
      message: result.message ?? 'Codex reset credit consume returned an unexpected response.',
    });
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Failed to consume Codex reset credit.';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: { message, type: 'upstream_error' } });
  }
});

xQuotaRouter.get('/quota/:id/claude-reset', async (req, res) => {
  try {
    const account = accountRow(Number(req.params.id));
    if (account.provider !== 'claude') {
      res.status(400).json({ error: { message: 'Claude reset grants are only available for Claude accounts.', type: 'invalid_request_error' } });
      return;
    }
    const info = await fetchClaudeResetGrants(account);
    res.json(info);
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Failed to load Claude reset grants.';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: { message, type: 'upstream_error' } });
  }
});

const claudeResetBodySchema = z.object({ grantId: z.string().trim().max(40).optional() }).strict();

xQuotaRouter.post('/quota/:id/claude-reset', async (req, res) => {
  try {
    const account = accountRow(Number(req.params.id));
    if (account.provider !== 'claude') {
      res.status(400).json({ error: { message: 'Claude reset grants are only available for Claude accounts.', type: 'invalid_request_error' } });
      return;
    }
    const parsed = claudeResetBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: 'Invalid grantId.', type: 'invalid_request_error' } });
      return;
    }
    const result = await consumeClaudeResetGrant(account, parsed.data.grantId);
    if (result.ok) {
      const quota = await refreshAccountQuota(account.id, true).catch(() => null);
      res.json({ ...result, ok: true, quota });
      return;
    }
    if (result.reason === 'no_grant') {
      res.status(409).json({ ...result, ok: false });
      return;
    }
    const status = result.status >= 400 && result.status < 500 ? result.status : 502;
    res.status(status).json({
      ...result,
      ok: false,
      message: result.message ?? 'Claude reset request returned an unexpected response.',
    });
  } catch (err) {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const message = err instanceof Error ? err.message : 'Failed to redeem Claude reset grant.';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: { message, type: 'upstream_error' } });
  }
});
