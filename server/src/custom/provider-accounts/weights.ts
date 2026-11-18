import {
  DEFAULT_CREDENTIAL_WEIGHT,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_QUEUE_SIZE,
  MAX_ACCOUNT_CONCURRENCY,
  MAX_ACCOUNT_QUEUE_SIZE,
  MAX_CREDENTIAL_WEIGHT,
  MIN_CREDENTIAL_WEIGHT,
  type AccountResiliencePatch,
  type AccountResiliencePolicy,
} from '@freellmapi/shared/account-resilience.js';
import { getDb } from '../../db/index.js';
import { AccountError } from './http.js';
import { getAccountLiveLoad } from './semaphore.js';

export {
  DEFAULT_CREDENTIAL_WEIGHT,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_QUEUE_SIZE,
  MAX_ACCOUNT_CONCURRENCY,
  MAX_ACCOUNT_QUEUE_SIZE,
  MAX_CREDENTIAL_WEIGHT,
  MIN_CREDENTIAL_WEIGHT,
};

interface RawResilienceRow {
  account_id: number;
  weight: number;
  max_concurrency: number | null;
  max_queue_size: number;
  fail_fast: number;
  refresh_circuit_until: string | null;
  refresh_failures: number;
  last_refresh_error: string | null;
  updated_at: string | null;
}

/**
 * Strict integer weight validation (`0..1_000_000`).
 * `0` soft-drains traffic from the credential without deleting or disabling it.
 */
export function validateCredentialWeight(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AccountError(400, 'Credential weight must be an integer.');
  }
  if (value < MIN_CREDENTIAL_WEIGHT || value > MAX_CREDENTIAL_WEIGHT) {
    throw new AccountError(
      400,
      `Credential weight must be between ${MIN_CREDENTIAL_WEIGHT} and ${MAX_CREDENTIAL_WEIGHT}.`,
    );
  }
  return value;
}

/**
 * Normalizes an optional/imported weight following CLIProxyAPI semantics:
 * `null`/`undefined` -> default `1`; `<= 0` -> `0` (soft-excluded); `> 1_000_000` -> error.
 */
export function normalizeCredentialWeight(value: number | null | undefined): number {
  if (value === null || value === undefined) return DEFAULT_CREDENTIAL_WEIGHT;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.trunc(value) !== value) {
    throw new AccountError(400, 'Credential weight must be an integer.');
  }
  if (value <= 0) return 0;
  if (value > MAX_CREDENTIAL_WEIGHT) {
    throw new AccountError(400, `Credential weight must not exceed ${MAX_CREDENTIAL_WEIGHT}.`);
  }
  return value;
}

export function isCredentialDraining(weight: number | null | undefined): boolean {
  return weight !== null && weight !== undefined && weight <= 0;
}

export function validateMaxConcurrency(value: unknown): number | null {
  if (value === null || value === undefined || value === 0) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_ACCOUNT_CONCURRENCY) {
    throw new AccountError(
      400,
      `Max concurrency must be null or an integer between 1 and ${MAX_ACCOUNT_CONCURRENCY}.`,
    );
  }
  return value;
}

export function validateMaxQueueSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_ACCOUNT_QUEUE_SIZE) {
    throw new AccountError(
      400,
      `Max queue size must be an integer between 0 and ${MAX_ACCOUNT_QUEUE_SIZE}.`,
    );
  }
  return value;
}

export function defaultAccountResiliencePolicy(accountId: number): AccountResiliencePolicy {
  return {
    accountId,
    weight: DEFAULT_CREDENTIAL_WEIGHT,
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    maxQueueSize: DEFAULT_MAX_QUEUE_SIZE,
    failFast: false,
    refreshCircuitUntil: null,
    refreshFailureCount: 0,
    lastRefreshError: null,
    updatedAt: null,
  };
}

export function hydrateResilienceRow(raw: RawResilienceRow): AccountResiliencePolicy {
  const rawWeight = Number(raw.weight);
  const weight =
    Number.isSafeInteger(rawWeight) && rawWeight >= MIN_CREDENTIAL_WEIGHT && rawWeight <= MAX_CREDENTIAL_WEIGHT
      ? rawWeight
      : DEFAULT_CREDENTIAL_WEIGHT;
  const rawMaxConc = raw.max_concurrency === null || raw.max_concurrency === undefined
    ? null
    : Number(raw.max_concurrency);
  const maxConcurrency =
    rawMaxConc !== null && Number.isSafeInteger(rawMaxConc) && rawMaxConc > 0
      ? rawMaxConc
      : null;
  const rawQueue = Number(raw.max_queue_size);
  const maxQueueSize =
    Number.isSafeInteger(rawQueue) && rawQueue >= 0 ? rawQueue : DEFAULT_MAX_QUEUE_SIZE;

  return {
    accountId: Number(raw.account_id),
    weight,
    maxConcurrency,
    maxQueueSize,
    failFast: Number(raw.fail_fast) === 1,
    refreshCircuitUntil: typeof raw.refresh_circuit_until === 'string' && raw.refresh_circuit_until
      ? raw.refresh_circuit_until
      : null,
    refreshFailureCount: Math.max(0, Math.trunc(Number(raw.refresh_failures ?? 0) || 0)),
    lastRefreshError: typeof raw.last_refresh_error === 'string' && raw.last_refresh_error
      ? raw.last_refresh_error
      : null,
    updatedAt: typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : null,
  };
}

export function getAccountResiliencePolicy(accountId: number): AccountResiliencePolicy {
  try {
    const row = getDb()
      .prepare('SELECT * FROM custom_x_account_resilience WHERE account_id = ?')
      .get(accountId) as RawResilienceRow | undefined;
    return row ? hydrateResilienceRow(row) : defaultAccountResiliencePolicy(accountId);
  } catch {
    return defaultAccountResiliencePolicy(accountId);
  }
}

export function listAccountResiliencePolicies(
  accountIds?: readonly number[],
): Map<number, AccountResiliencePolicy> {
  const result = new Map<number, AccountResiliencePolicy>();
  try {
    const rows = getDb()
      .prepare('SELECT * FROM custom_x_account_resilience ORDER BY account_id')
      .all() as RawResilienceRow[];
    const allowed = accountIds ? new Set(accountIds) : null;
    for (const raw of rows) {
      const hydrated = hydrateResilienceRow(raw);
      if (allowed && !allowed.has(hydrated.accountId)) continue;
      result.set(hydrated.accountId, hydrated);
    }
  } catch {
    // Allow pure in-memory unit tests without an initialized DB.
  }
  if (accountIds) {
    for (const id of accountIds) {
      if (!result.has(id)) {
        result.set(id, defaultAccountResiliencePolicy(id));
      }
    }
  }
  return result;
}

export function upsertAccountResiliencePolicy(
  accountId: number,
  patch: AccountResiliencePatch,
): AccountResiliencePolicy {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new AccountError(400, 'Invalid account ID.');
  }
  const current = getAccountResiliencePolicy(accountId);
  const nextWeight =
    patch.weight !== undefined ? validateCredentialWeight(patch.weight) : current.weight;
  const nextMaxConcurrency =
    patch.maxConcurrency !== undefined
      ? validateMaxConcurrency(patch.maxConcurrency)
      : current.maxConcurrency;
  const nextMaxQueueSize =
    patch.maxQueueSize !== undefined
      ? validateMaxQueueSize(patch.maxQueueSize)
      : current.maxQueueSize;
  const nextFailFast =
    patch.failFast !== undefined ? Boolean(patch.failFast) : current.failFast;
  const now = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO custom_x_account_resilience (
         account_id, weight, max_concurrency, max_queue_size, fail_fast,
         refresh_circuit_until, refresh_failures, last_refresh_error, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         weight = excluded.weight,
         max_concurrency = excluded.max_concurrency,
         max_queue_size = excluded.max_queue_size,
         fail_fast = excluded.fail_fast,
         updated_at = excluded.updated_at`,
    )
    .run(
      accountId,
      nextWeight,
      nextMaxConcurrency,
      nextMaxQueueSize,
      nextFailFast ? 1 : 0,
      current.refreshCircuitUntil,
      current.refreshFailureCount,
      current.lastRefreshError,
      now,
    );

  return getAccountResiliencePolicy(accountId);
}

export type WeightRoutableItem =
  | { id: number; provider: string }
  | { account: { id: number; provider: string }; modelId?: string; step?: number };

export interface AccountLoadSnapshot {
  running: number;
  queued?: number;
  maxConcurrency?: number | null;
  blockedUntil?: string | null;
}

export interface OrderAccountsOptions {
  policies?:
    | ReadonlyMap<number, Partial<AccountResiliencePolicy>>
    | Record<number, Partial<AccountResiliencePolicy>>;
  loads?:
    | ReadonlyMap<number, AccountLoadSnapshot>
    | Record<number, AccountLoadSnapshot>;
  rng?: () => number;
  stateless?: boolean;
  respectRefreshBackoff?: boolean;
  nowMs?: number;
}

function extractAccountRef(item: WeightRoutableItem): { id: number; provider: string; step?: number } {
  if ('account' in item) {
    return {
      id: item.account.id,
      provider: item.account.provider,
      ...(item.step !== undefined ? { step: item.step } : {}),
    };
  }
  return { id: item.id, provider: item.provider };
}

function lookupMapOrRecord<V>(
  source: ReadonlyMap<number, V> | Record<number, V> | undefined,
  id: number,
): V | undefined {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(id);
  return (source as Record<number, V>)[id];
}

// Smooth Weighted Round-Robin (Nginx SWRR) state per candidate-group signature.
const swrrCurrentWeights = new Map<string, Map<number, number>>();
let swrrDbRef: unknown = null;

function syncSwrrDb(): void {
  try {
    const db = getDb();
    if (swrrDbRef !== null && swrrDbRef !== db) {
      swrrCurrentWeights.clear();
    }
    swrrDbRef = db;
  } catch {
    // Allow pure unit tests without an initialized DB.
  }
}

export function resetWeightSchedulerForTests(): void {
  swrrCurrentWeights.clear();
}

function orderAccountIdsWithSwrr(
  entries: ReadonlyArray<{ accountId: number; weight: number }>,
): number[] {
  if (entries.length <= 1) return entries.map(e => e.accountId);
  syncSwrrDb();

  const signature = entries.map(e => `${e.accountId}:${e.weight}`).join(',');
  let state = swrrCurrentWeights.get(signature);
  if (!state) {
    state = new Map<number, number>();
    for (const e of entries) state.set(e.accountId, 0);
    swrrCurrentWeights.set(signature, state);
    if (swrrCurrentWeights.size > 512) {
      const oldestKey = swrrCurrentWeights.keys().next().value;
      if (oldestKey !== undefined) swrrCurrentWeights.delete(oldestKey);
    }
  }

  let totalWeight = 0;
  let winnerId = entries[0]!.accountId;
  let bestCurrent = Number.NEGATIVE_INFINITY;

  for (const e of entries) {
    const nextVal = (state.get(e.accountId) ?? 0) + e.weight;
    state.set(e.accountId, nextVal);
    totalWeight += e.weight;
    if (nextVal > bestCurrent) {
      bestCurrent = nextVal;
      winnerId = e.accountId;
    }
  }

  state.set(winnerId, (state.get(winnerId) ?? 0) - totalWeight);

  // Winner goes first; remaining accounts follow in descending effective weight (tie-break arrival order).
  const rest = entries
    .filter(e => e.accountId !== winnerId)
    .sort((a, b) => b.weight - a.weight);

  return [winnerId, ...rest.map(e => e.accountId)];
}

interface AnnotatedItem<T> {
  item: T;
  index: number;
  accountId: number;
  provider: string;
  stepKey: number;
  weight: number;
  running: number;
  queued: number;
  tier: 0 | 1 | 2;
  effectiveScore: number;
}

/**
 * Orders candidate accounts/routes by configured credential weight and live semaphore load:
 * - Excludes `weight === 0` (soft-drained) credentials without deleting them.
 * - Skips accounts in persisted OAuth refresh backoff (`refreshCircuitUntil > nowMs`) unless disabled.
 * - Steers away from saturated (`running >= maxConcurrency` or `blockedUntil` active) and busy in-flight accounts.
 * - Preserves exact input order when all weights are default (`1`) and no account has active load.
 * - Distributes traffic proportionally via Smooth Weighted Round-Robin (or custom `rng`) when weights > 1.
 */
export function orderAccountsByWeightAndLoad<T extends WeightRoutableItem>(
  items: readonly T[],
  options: OrderAccountsOptions = {},
): T[] {
  if (items.length === 0) return [];

  const nowMs = options.nowMs ?? Date.now();
  const respectRefreshBackoff = options.respectRefreshBackoff !== false;
  const uniqueIds = [...new Set(items.map(item => extractAccountRef(item).id))];
  const dbPolicies = options.policies ? null : listAccountResiliencePolicies(uniqueIds);

  const annotated: AnnotatedItem<T>[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    const ref = extractAccountRef(item);
    const policyPatch = lookupMapOrRecord(options.policies, ref.id) ?? dbPolicies?.get(ref.id);

    const rawWeight = policyPatch?.weight ?? DEFAULT_CREDENTIAL_WEIGHT;
    const weight =
      typeof rawWeight === 'number' && Number.isFinite(rawWeight)
        ? Math.min(MAX_CREDENTIAL_WEIGHT, Math.max(0, Math.trunc(rawWeight)))
        : DEFAULT_CREDENTIAL_WEIGHT;

    // Weight 0 soft-drains traffic without deleting the stored credential.
    if (weight <= 0) continue;

    if (respectRefreshBackoff && typeof policyPatch?.refreshCircuitUntil === 'string') {
      const untilMs = Date.parse(policyPatch.refreshCircuitUntil);
      if (Number.isFinite(untilMs) && untilMs > nowMs) {
        continue;
      }
    }

    const providedLoad = lookupMapOrRecord(options.loads, ref.id);
    const liveLoad = providedLoad ?? getAccountLiveLoad(ref.provider, ref.id);
    const running = Math.max(0, Math.trunc(liveLoad.running || 0));
    const queued = Math.max(0, Math.trunc(liveLoad.queued ?? 0));
    const maxConcurrency =
      providedLoad?.maxConcurrency !== undefined
        ? providedLoad.maxConcurrency
        : (policyPatch?.maxConcurrency ?? null);
    const maxQueueSize = policyPatch?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const failFast = policyPatch?.failFast === true;

    const blockedUntilStr =
      providedLoad?.blockedUntil !== undefined ? providedLoad.blockedUntil : liveLoad.blockedUntil;
    const isBlocked =
      typeof blockedUntilStr === 'string' && Number.isFinite(Date.parse(blockedUntilStr)) && Date.parse(blockedUntilStr) > nowMs;

    const isCapSaturated =
      maxConcurrency !== null && maxConcurrency !== undefined && maxConcurrency > 0 && running >= maxConcurrency;
    const saturated = isBlocked || isCapSaturated;
    const queueFull =
      saturated && (failFast || (maxQueueSize > 0 && queued >= maxQueueSize));

    const tier: 0 | 1 | 2 = !saturated ? 0 : !queueFull ? 1 : 2;
    const effectiveScore = weight / (1 + running + queued);

    annotated.push({
      item,
      index,
      accountId: ref.id,
      provider: ref.provider,
      stepKey: ref.step ?? -1,
      weight,
      running,
      queued,
      tier,
      effectiveScore,
    });
  }

  if (annotated.length <= 1) {
    return annotated.map(a => a.item);
  }

  // Group by combo step (`stepKey`) preserving first-seen step order so combo step fallbacks stay intact.
  const stepOrder: number[] = [];
  const stepGroups = new Map<number, AnnotatedItem<T>[]>();
  for (const entry of annotated) {
    let group = stepGroups.get(entry.stepKey);
    if (!group) {
      group = [];
      stepGroups.set(entry.stepKey, group);
      stepOrder.push(entry.stepKey);
    }
    group.push(entry);
  }

  const orderedResult: T[] = [];
  for (const stepKey of stepOrder) {
    const group = stepGroups.get(stepKey)!;
    if (group.length <= 1) {
      orderedResult.push(...group.map(g => g.item));
      continue;
    }

    // Partition by saturation tier (0: available, 1: saturated-queueable, 2: saturated-full).
    for (const tier of [0, 1, 2] as const) {
      const tierItems = group.filter(g => g.tier === tier);
      if (tierItems.length === 0) continue;
      if (tierItems.length === 1) {
        orderedResult.push(tierItems[0]!.item);
        continue;
      }

      const hasCustomWeights = tierItems.some(g => g.weight !== DEFAULT_CREDENTIAL_WEIGHT);
      const hasActiveLoad = tierItems.some(g => g.running > 0 || g.queued > 0);

      if (options.rng) {
        // Efraimidis-Spirakis weighted random key per unique account.
        const accountKeys = new Map<number, number>();
        for (const entry of tierItems) {
          if (!accountKeys.has(entry.accountId)) {
            const u = Math.min(1 - 1e-9, Math.max(1e-9, options.rng()));
            const score = Math.max(1e-6, entry.effectiveScore);
            accountKeys.set(entry.accountId, u ** (1 / score));
          }
        }
        const sorted = [...tierItems].sort((a, b) => {
          const diff = (accountKeys.get(b.accountId) ?? 0) - (accountKeys.get(a.accountId) ?? 0);
          return diff !== 0 ? diff : a.index - b.index;
        });
        orderedResult.push(...sorted.map(s => s.item));
        continue;
      }

      if (!hasCustomWeights && !hasActiveLoad) {
        orderedResult.push(...tierItems.map(t => t.item));
        continue;
      }

      if (hasActiveLoad || options.stateless) {
        const sorted = [...tierItems].sort((a, b) => {
          if (b.effectiveScore !== a.effectiveScore) {
            return b.effectiveScore - a.effectiveScore;
          }
          if (b.weight !== a.weight) {
            return b.weight - a.weight;
          }
          return a.index - b.index;
        });
        orderedResult.push(...sorted.map(s => s.item));
        continue;
      }

      // Proportional Smooth Weighted Round-Robin across unique accounts in this tier.
      const uniqueAccounts: Array<{ accountId: number; weight: number }> = [];
      const seenAccounts = new Set<number>();
      for (const entry of tierItems) {
        if (!seenAccounts.has(entry.accountId)) {
          seenAccounts.add(entry.accountId);
          uniqueAccounts.push({ accountId: entry.accountId, weight: entry.weight });
        }
      }
      const rankList = orderAccountIdsWithSwrr(uniqueAccounts);
      const rankMap = new Map<number, number>(rankList.map((id, idx) => [id, idx]));
      const sorted = [...tierItems].sort((a, b) => {
        const rankDiff = (rankMap.get(a.accountId) ?? 0) - (rankMap.get(b.accountId) ?? 0);
        return rankDiff !== 0 ? rankDiff : a.index - b.index;
      });
      orderedResult.push(...sorted.map(s => s.item));
    }
  }

  return orderedResult;
}
