import { withKeyProxy, withProxyResponseObserver } from '../../../lib/proxy.js';
import type { AccountRow } from '../../provider-accounts/store.js';
import { setAccountCooldown } from '../../provider-accounts/auto-ping.js';
import { parseQuotaHeaders, quotaReset } from './adapters.js';
import { applyQuotaRouting, recordQuotaWindows } from './store.js';

const DEFAULT_RETRY_MS = 60_000;

export function withQuotaTracking<T>(account: Pick<AccountRow, 'id' | 'provider'>, modelId: string | undefined, proxy: string | undefined, fn: () => T): T {
  // Re-check between combo steps: an earlier attempt may have just returned 429.
  if (!applyQuotaRouting([account], false, Date.now(), modelId).length) throw new Error('Account quota is exhausted; trying the next route.');
  return withProxyResponseObserver(response => {
    const windows = parseQuotaHeaders(response.headers, response.status);
    if (windows.length) recordQuotaWindows(account.id, windows.map(w => ({ ...w, ...(modelId ? { modelId } : {}) })), true);
    if (response.status === 429) {
      // Mirror the 429 into the real-time cooldown tracker right away.
      try {
        const now = Date.now();
        const resetAt = quotaReset(response.headers.get('retry-after'), now);
        const parsed = resetAt ? Date.parse(resetAt) - now : NaN;
        const retryMs = Number.isFinite(parsed) ? Math.max(1_000, parsed) : DEFAULT_RETRY_MS;
        setAccountCooldown(account.id, retryMs, modelId, 'HTTP 429: rate limited by provider');
      } catch {
        // Cooldown bookkeeping must never break the upstream response.
      }
    }
  }, () => withKeyProxy(proxy, fn));
}
