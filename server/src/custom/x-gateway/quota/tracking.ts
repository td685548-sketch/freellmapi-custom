import { withKeyProxy, withProxyResponseObserver } from '../../../lib/proxy.js';
import type { AccountRow } from '../../provider-accounts/store.js';
import { parseQuotaHeaders } from './adapters.js';
import { applyQuotaRouting, recordQuotaWindows } from './store.js';

export function withQuotaTracking<T>(account: Pick<AccountRow, 'id' | 'provider'>, modelId: string | undefined, proxy: string | undefined, fn: () => T): T {
  // Re-check between combo steps: an earlier attempt may have just returned 429.
  if (!applyQuotaRouting([account], false, Date.now(), modelId).length) throw new Error('Account quota is exhausted; trying the next route.');
  return withProxyResponseObserver(response => {
    const windows = parseQuotaHeaders(response.headers, response.status);
    if (windows.length) recordQuotaWindows(account.id, windows.map(w => ({ ...w, ...(modelId ? { modelId } : {}) })), true);
  }, () => withKeyProxy(proxy, fn));
}
