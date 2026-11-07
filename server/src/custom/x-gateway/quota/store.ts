import type { QuotaTier, XAccountQuota, XQuotaWindow } from '@freellmapi/shared/x-quota.js';
import { getDb } from '../../../db/index.js';
import { accountRow, listAccounts, type AccountRow } from '../../provider-accounts/store.js';
import { getXGatewayProvider } from '../../provider-accounts/catalog.js';
import { fetchAccountQuota, supportsQuota } from './adapters.js';

export const QUOTA_FRESHNESS_MS = 300_000;
const REFRESH_COOLDOWN_MS = 30_000;
const pending = new WeakMap<object, Map<number, Promise<XAccountQuota>>>();
interface SnapshotRow { account_id: number; snapshot_json: string; observed_at: string | null; checked_at: string | null; last_error: string | null }
const ranks: Record<QuotaTier, number> = { subscription: 0, cheap: 1, free: 2 };

export function defaultQuotaTier(provider: string): QuotaTier {
  if (['kiro', 'opencode', 'opencode-free', 'iflow'].includes(provider)) return 'free';
  const category = getXGatewayProvider(provider)?.category;
  if (category === 'free' || category === 'freeTier') return 'free';
  if (category === 'oauth' || category === 'webCookie' || provider === 'github-copilot') return 'subscription';
  return 'cheap';
}
function windows(row: SnapshotRow | undefined): XQuotaWindow[] {
  try { const parsed: unknown = JSON.parse(row?.snapshot_json ?? '[]'); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
export function isQuotaWindowFresh(window: XQuotaWindow, observedAt: string | null, now = Date.now()): boolean {
  const observed = Date.parse(observedAt ?? '');
  if (!Number.isFinite(observed) || observed > now || now - observed >= QUOTA_FRESHNESS_MS) return false;
  return !window.resetAt || Date.parse(window.resetAt) > now;
}
export function recordQuotaWindows(accountId: number, incoming: XQuotaWindow[], merge = false): void {
  if (!incoming.length) return;
  const db = getDb();
  if (!db.prepare('SELECT id FROM x_gateway_keys WHERE id = ?').get(accountId)) return;
  // Do not make old windows look freshly observed when a different header arrives.
  const now = new Date().toISOString();
  const prior = merge ? db.prepare('SELECT * FROM x_gateway_quota WHERE account_id = ?').get(accountId) as SnapshotRow | undefined : undefined;
  const existing = prior && Date.now() - Date.parse(prior.observed_at ?? '') < QUOTA_FRESHNESS_MS ? windows(prior) : [];
  const combined = new Map(existing.map(w => [`${w.id}:${w.modelId ?? ''}`, w]));
  for (const w of incoming) combined.set(`${w.id}:${w.modelId ?? ''}`, w);
  db.prepare(`INSERT INTO x_gateway_quota(account_id,snapshot_json,observed_at,checked_at,last_error) VALUES (?,?,?,?,NULL)
    ON CONFLICT(account_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, observed_at=excluded.observed_at,
    checked_at=excluded.checked_at,last_error=NULL`).run(accountId, JSON.stringify([...combined.values()].slice(0, 50)),
    // When merging, retain the oldest observation timestamp conservatively.
    prior?.observed_at && existing.length ? prior.observed_at : now, now);
}
export function setQuotaTier(accountId: number, tier: QuotaTier): void {
  accountRow(accountId);
  getDb().prepare(`INSERT INTO x_gateway_quota_tiers(account_id,tier) VALUES (?,?)
    ON CONFLICT(account_id) DO UPDATE SET tier=excluded.tier`).run(accountId, tier);
}
export function applyQuotaRouting<T extends Pick<AccountRow, 'id' | 'provider'>>(accounts: T[], sort = false, now = Date.now(), modelId?: string): T[] {
  const db = getDb();
  const snapshots = new Map((db.prepare('SELECT * FROM x_gateway_quota').all() as SnapshotRow[]).map(r => [r.account_id, r]));
  const tiers = sort ? new Map((db.prepare('SELECT account_id,tier FROM x_gateway_quota_tiers').all() as { account_id: number; tier: QuotaTier }[]).map(r => [r.account_id, r.tier])) : new Map<number, QuotaTier>();
  const result = accounts.filter(a => {
    const row = snapshots.get(a.id);
    return !windows(row).some(w => w.blocking && (!w.modelId || w.modelId === modelId)
      && w.remaining != null && w.remaining <= 0 && isQuotaWindowFresh(w, row?.observed_at ?? null, now));
  });
  if (sort) result.sort((a, b) => ranks[tiers.get(a.id) ?? defaultQuotaTier(a.provider)] - ranks[tiers.get(b.id) ?? defaultQuotaTier(b.provider)]);
  return result;
}
export function listAccountQuotas(): XAccountQuota[] {
  const db = getDb();
  const snapshots = new Map((db.prepare('SELECT * FROM x_gateway_quota').all() as SnapshotRow[]).map(r => [r.account_id, r]));
  const tiers = new Map((db.prepare('SELECT account_id,tier FROM x_gateway_quota_tiers').all() as { account_id: number; tier: QuotaTier }[]).map(r => [r.account_id, r.tier]));
  const date = new Date();
  const monthlyReset = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString();
  return listAccounts().flatMap(provider => provider.accounts.map(account => {
    const row = snapshots.get(account.id);
    const items = windows(row);
    return {
      accountId: account.id, provider: provider.id, providerName: provider.name, label: account.label,
      enabled: account.enabled && !['invalid', 'disabled'].includes(account.status),
      tier: tiers.get(account.id) ?? defaultQuotaTier(provider.id), supported: supportsQuota(accountRow(account.id)),
      windows: items, observedAt: row?.observed_at ?? null, checkedAt: row?.checked_at ?? null,
      error: row?.last_error ?? null,
      stale: !items.length || items.some(w => !isQuotaWindowFresh(w, row?.observed_at ?? null)),
      local: { requests: account.monthlyUsage.requests, tokens: account.monthlyUsage.tokens,
        requestCap: account.monthlyRequestCap, tokenCap: account.monthlyTokenCap, resetAt: monthlyReset },
    };
  }));
}
export async function refreshAccountQuota(accountId: number): Promise<XAccountQuota> {
  const account = accountRow(accountId);
  const db = getDb();
  let active = pending.get(db);
  if (!active) { active = new Map(); pending.set(db, active); }
  const inFlight = active.get(accountId);
  if (inFlight) return inFlight;
  const current = db.prepare('SELECT * FROM x_gateway_quota WHERE account_id = ?').get(accountId) as SnapshotRow | undefined;
  if (current?.checked_at && Date.now() - Date.parse(current.checked_at) < REFRESH_COOLDOWN_MS) return listAccountQuotas().find(a => a.accountId === accountId)!;
  const task = (async () => {
    try {
      const incoming = await fetchAccountQuota(account);
      if (!incoming.length) throw new Error('Provider returned no quota windows.');
      recordQuotaWindows(accountId, incoming);
    } catch {
      // Never persist upstream response bodies, tokens, URLs or proxy details.
      const error = supportsQuota(account) ? 'Quota refresh failed. Check account authorization or retry later.' : 'Quota API unavailable for this provider or custom endpoint.';
      if (db.prepare('SELECT id FROM x_gateway_keys WHERE id = ?').get(accountId)) {
        db.prepare(`INSERT INTO x_gateway_quota(account_id,checked_at,last_error) VALUES (?,?,?)
          ON CONFLICT(account_id) DO UPDATE SET checked_at=excluded.checked_at,last_error=excluded.last_error`)
          .run(accountId, new Date().toISOString(), error);
      }
    }
    const result = listAccountQuotas().find(a => a.accountId === accountId);
    if (!result) throw new Error('Account deleted during refresh.');
    return result;
  })();
  active.set(accountId, task);
  try { return await task; } finally { active.delete(accountId); }
}
