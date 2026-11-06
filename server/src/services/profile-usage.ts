import { getDb } from '../db/index.js';
import type { ProfileAnalytics } from '@freellmapi/shared/user-analytics.js';
import { getRequestAnalytics } from './user-analytics.js';
import { hashClientProfileKey } from '../lib/system-prompt.js';

// Usage and per-minute limit of client profiles (`sk-cp-…` keys). The profile CRUD
// itself lives in routes/client-profiles.ts (upstream); this module only adds the
// attribution, the limit and the analytics on top of it.

export const MAX_PROFILE_RPM = 1000;

export interface GateProfile {
  id: number;
  rpmLimit: number | null;
  /** Lowercase model ids the key may use; empty = any. */
  allowedModels: string[];
  maxTokens: number | null;
}

/** The stored JSON list, tolerant of anything unexpected (an unreadable list restricts nothing it cannot name, so it reads as empty). */
export function parseAllowedModels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string' && m.length > 0) : [];
  } catch { return []; }
}

/** The enabled profile a key belongs to, or null (unknown/disabled keys fall through to the normal 401). */
export function profileForGate(token: string): GateProfile | null {
  const row = getDb()
    .prepare('SELECT id, rpm_limit AS rpmLimit, allowed_models AS allowedModels, max_tokens_cap AS maxTokens FROM client_profiles WHERE token_hash = ? AND enabled = 1')
    .get(hashClientProfileKey(token)) as (Omit<GateProfile, 'allowedModels'> & { allowedModels: string | null }) | undefined;
  return row ? { ...row, allowedModels: parseAllowedModels(row.allowedModels) } : null;
}

/** Set (1..1000) or clear (null = unlimited) a profile's requests-per-minute cap. False when the profile does not exist. */
export function setProfileRpmLimit(profileId: number, rpmLimit: number | null): boolean {
  const value = rpmLimit === null ? null : Math.max(1, Math.min(MAX_PROFILE_RPM, Math.floor(rpmLimit)));
  return getDb().prepare('UPDATE client_profiles SET rpm_limit = ? WHERE id = ?').run(value, profileId).changes > 0;
}

export function getProfileAnalytics(profileId: number, days: number): ProfileAnalytics | null {
  const row = getDb()
    .prepare('SELECT id, name, enabled, rpm_limit AS rpmLimit FROM client_profiles WHERE id = ?')
    .get(profileId) as { id: number; name: string; enabled: number; rpmLimit: number | null } | undefined;
  if (!row) return null;
  return {
    profileId: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    rpmLimit: row.rpmLimit,
    ...getRequestAnalytics('profile_id', row.id, days),
  };
}
