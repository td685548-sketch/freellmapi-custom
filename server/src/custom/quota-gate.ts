import type { Response } from 'express';
import { admitQuota, type SubjectKind } from '../services/usage-quotas.js';

/**
 * Applies a subject's daily / monthly allowance to one inference request. Returns false after
 * answering 429 itself; otherwise the request goes on, and when its response ends the allowance is
 * settled: kept (with the tokens the request used) if it succeeded, handed back if it failed or the
 * client hung up first.
 */
export function enforceUsageQuota(kind: SubjectKind, id: number, res: Response, tokensUsed: () => number): boolean {
  const admission = admitQuota(kind, id);
  if (!admission.ok) {
    const d = admission.denial;
    const retryAfter = Math.max(1, Math.ceil((d.resetsAtMs - Date.now()) / 1000));
    const who = kind === 'user' ? 'This account' : 'This client key';
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({
      error: {
        message: `${who} has used its ${d.period} ${d.metric} allowance (${d.used.toLocaleString('en-US')} of ${d.limit.toLocaleString('en-US')}). It resets at ${new Date(d.resetsAtMs).toISOString()}.`,
        type: 'insufficient_quota',
        code: `${kind}_quota_exceeded`,
        period: d.period,
        metric: d.metric,
        limit: d.limit,
        used: d.used,
        resets_at: new Date(d.resetsAtMs).toISOString(),
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
  res.on('close', () => end(false)); // a hang-up before 'finish' hands the request back
  return true;
}
