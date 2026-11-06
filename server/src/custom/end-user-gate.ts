import type { Request, Response } from 'express';
import type { EndUserQuota } from '@freellmapi/shared/end-users.js';
import { admitEndUser, hasEndUserQuota, normalizeEndUser } from '../services/end-user-quotas.js';

/** The end user a client-key request is made for: the X-End-User header, else the OpenAI `user` field. */
export function endUserOf(req: Request): string | null {
  const header = req.headers['x-end-user'];
  const fromHeader = normalizeEndUser(Array.isArray(header) ? header[0] : header);
  if (fromHeader) return fromHeader;
  const body = req.body as { user?: unknown } | undefined;
  return req.method === 'POST' && body && typeof body === 'object' ? normalizeEndUser(body.user) : null;
}

/**
 * Applies the key's per-end-user allowance to one request. Returns false after answering 429 itself.
 * A request with no end user, or a key without such an allowance, passes untouched.
 */
export function enforceEndUserQuota(profileId: number, endUser: string | null, quota: EndUserQuota, res: Response, tokensUsed: () => number): boolean {
  if (!endUser || !hasEndUserQuota(quota)) return true;
  const admission = admitEndUser(profileId, endUser, quota);
  if (!admission.ok) {
    const d = admission.denial;
    const retryAfter = Math.max(1, Math.ceil((d.resetsAtMs - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: {
        message: `This user has used their ${d.period} ${d.metric} allowance (${d.used.toLocaleString('en-US')} of ${d.limit.toLocaleString('en-US')}). It resets at ${new Date(d.resetsAtMs).toISOString()}.`,
        type: 'insufficient_quota',
        code: 'end_user_quota_exceeded',
        period: d.period, metric: d.metric, limit: d.limit, used: d.used, resets_at: new Date(d.resetsAtMs).toISOString(),
      },
    });
    return false;
  }
  let ended = false;
  const end = (finished: boolean) => {
    if (ended) return;
    ended = true;
    admission.settle(finished && res.statusCode < 400, finished ? tokensUsed() : 0);
  };
  res.on('finish', () => end(true));
  res.on('close', () => end(false));
  return true;
}
