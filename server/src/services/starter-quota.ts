import { getDb } from '../db/index.js';
import type { UsageQuota } from '@freellmapi/shared/usage-quota.js';
import { getQuotaState, MAX_QUOTA_VALUE, setQuota } from './usage-quotas.js';
import { setUserRpmLimit } from './user-quotas.js';

export const STARTER_QUOTA_SETTING_KEY = 'default_member_usage_quota_v1';

export interface StarterQuotaConfig {
  enabled: boolean;
  dailyRequests: number | null;
  dailyTokens: number | null;
  monthlyRequests: number | null;
  monthlyTokens: number | null;
  rpmLimit: number;
}

export const DEFAULT_STARTER_QUOTA: StarterQuotaConfig = {
  enabled: true,
  dailyRequests: 100,
  dailyTokens: 500_000,
  monthlyRequests: null,
  monthlyTokens: 3_000_000,
  rpmLimit: 60,
};

function normalizeNullableLimit(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1 || n > MAX_QUOTA_VALUE) return fallback;
  return n;
}

function normalizeRpm(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(1000, Math.floor(value)));
}

function hasAnyUsageLimit(cfg: Pick<StarterQuotaConfig, 'dailyRequests' | 'dailyTokens' | 'monthlyRequests' | 'monthlyTokens'>): boolean {
  return (
    cfg.dailyRequests !== null ||
    cfg.dailyTokens !== null ||
    cfg.monthlyRequests !== null ||
    cfg.monthlyTokens !== null
  );
}

export function getStarterQuotaConfig(): StarterQuotaConfig {
  const db = getDb();
  const row = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(STARTER_QUOTA_SETTING_KEY) as { value: string } | undefined;

  if (!row?.value) {
    return { ...DEFAULT_STARTER_QUOTA };
  }

  try {
    const parsed = JSON.parse(row.value) as Partial<StarterQuotaConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STARTER_QUOTA.enabled,
      dailyRequests:
        parsed.dailyRequests === undefined
          ? DEFAULT_STARTER_QUOTA.dailyRequests
          : normalizeNullableLimit(parsed.dailyRequests, DEFAULT_STARTER_QUOTA.dailyRequests),
      dailyTokens:
        parsed.dailyTokens === undefined
          ? DEFAULT_STARTER_QUOTA.dailyTokens
          : normalizeNullableLimit(parsed.dailyTokens, DEFAULT_STARTER_QUOTA.dailyTokens),
      monthlyRequests:
        parsed.monthlyRequests === undefined
          ? DEFAULT_STARTER_QUOTA.monthlyRequests
          : normalizeNullableLimit(parsed.monthlyRequests, DEFAULT_STARTER_QUOTA.monthlyRequests),
      monthlyTokens:
        parsed.monthlyTokens === undefined
          ? DEFAULT_STARTER_QUOTA.monthlyTokens
          : normalizeNullableLimit(parsed.monthlyTokens, DEFAULT_STARTER_QUOTA.monthlyTokens),
      rpmLimit:
        parsed.rpmLimit === undefined
          ? DEFAULT_STARTER_QUOTA.rpmLimit
          : normalizeRpm(parsed.rpmLimit, DEFAULT_STARTER_QUOTA.rpmLimit),
    };
  } catch {
    return { ...DEFAULT_STARTER_QUOTA };
  }
}

export function setStarterQuotaConfig(patch: Partial<StarterQuotaConfig>): StarterQuotaConfig {
  const current = getStarterQuotaConfig();
  const next: StarterQuotaConfig = {
    enabled: patch.enabled ?? current.enabled,
    dailyRequests:
      patch.dailyRequests === undefined
        ? current.dailyRequests
        : normalizeNullableLimit(patch.dailyRequests, null),
    dailyTokens:
      patch.dailyTokens === undefined
        ? current.dailyTokens
        : normalizeNullableLimit(patch.dailyTokens, null),
    monthlyRequests:
      patch.monthlyRequests === undefined
        ? current.monthlyRequests
        : normalizeNullableLimit(patch.monthlyRequests, null),
    monthlyTokens:
      patch.monthlyTokens === undefined
        ? current.monthlyTokens
        : normalizeNullableLimit(patch.monthlyTokens, null),
    rpmLimit:
      patch.rpmLimit === undefined
        ? current.rpmLimit
        : normalizeRpm(patch.rpmLimit, current.rpmLimit),
  };

  getDb()
    .prepare(
      `INSERT INTO settings (key, value)
       VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(STARTER_QUOTA_SETTING_KEY, JSON.stringify(next));

  return next;
}

export function countUncappedMembers(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM users u
        WHERE u.role = 'member'
          AND NOT EXISTS (
            SELECT 1
              FROM custom_usage_quotas q
             WHERE q.subject_kind = 'user'
               AND q.subject_id = u.id
               AND (
                 q.daily_requests IS NOT NULL OR
                 q.daily_tokens IS NOT NULL OR
                 q.monthly_requests IS NOT NULL OR
                 q.monthly_tokens IS NOT NULL
               )
          )`,
    )
    .get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function applyStarterQuotaToNewMember(userId: number): { applied: boolean } {
  const cfg = getStarterQuotaConfig();
  if (cfg.rpmLimit !== 60) {
    setUserRpmLimit(userId, cfg.rpmLimit);
  }
  if (!cfg.enabled || !hasAnyUsageLimit(cfg)) {
    return { applied: false };
  }
  const existing = getQuotaState('user', userId);
  if (existing.tracked) {
    return { applied: false };
  }
  const quota: UsageQuota = {
    dailyRequests: cfg.dailyRequests,
    dailyTokens: cfg.dailyTokens,
    monthlyRequests: cfg.monthlyRequests,
    monthlyTokens: cfg.monthlyTokens,
  };
  setQuota('user', userId, quota);
  return { applied: true };
}

export function backfillStarterQuotaForUncappedMembers(): { updatedCount: number } {
  const cfg = getStarterQuotaConfig();
  if (!cfg.enabled || !hasAnyUsageLimit(cfg)) {
    return { updatedCount: 0 };
  }
  const db = getDb();
  const uncappedRows = db
    .prepare(
      `SELECT u.id
         FROM users u
        WHERE u.role = 'member'
          AND NOT EXISTS (
            SELECT 1
              FROM custom_usage_quotas q
             WHERE q.subject_kind = 'user'
               AND q.subject_id = u.id
               AND (
                 q.daily_requests IS NOT NULL OR
                 q.daily_tokens IS NOT NULL OR
                 q.monthly_requests IS NOT NULL OR
                 q.monthly_tokens IS NOT NULL
               )
          )`,
    )
    .all() as Array<{ id: number }>;

  if (uncappedRows.length === 0) {
    return { updatedCount: 0 };
  }

  const quota: UsageQuota = {
    dailyRequests: cfg.dailyRequests,
    dailyTokens: cfg.dailyTokens,
    monthlyRequests: cfg.monthlyRequests,
    monthlyTokens: cfg.monthlyTokens,
  };

  db.transaction(() => {
    for (const row of uncappedRows) {
      setQuota('user', row.id, quota);
      if (cfg.rpmLimit !== 60) {
        setUserRpmLimit(row.id, cfg.rpmLimit);
      }
    }
  })();

  return { updatedCount: uncappedRows.length };
}
