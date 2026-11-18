import {
  AI_PLATFORM_LIMITS,
  DEFAULT_PILLAR_FLAGS,
  PILLARS,
  type Pillar,
  type PillarFlags,
} from '@freellmapi/shared/ai-platform.js';
import { getDb } from '../../db/index.js';
import { isTursoDatabase, tursoSettingsVersion } from '../../db/turso.js';
import type { Db } from '../../db/types.js';

export type { Pillar, PillarFlags };

const SETTINGS_KEY = 'ai_platform_flags_v1';
const TURSO_FLAGS_CACHE_TTL_MS = 30_000;

interface FlagsCacheEntry {
  db: Db;
  settingsVersion: number;
  flags: PillarFlags;
  expiresAt: number;
}

let cache: FlagsCacheEntry | null = null;

function freshDefaults(): PillarFlags {
  return { ...DEFAULT_PILLAR_FLAGS };
}

function parseFlagsJson(raw: string | undefined): PillarFlags {
  if (!raw) return freshDefaults();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return freshDefaults();
    }
    const obj = parsed as Record<string, unknown>;
    const out = freshDefaults();
    for (const pillar of PILLARS) {
      out[pillar] = obj[pillar] === true;
    }
    return out;
  } catch {
    return freshDefaults();
  }
}

function readFlagsFromDb(db: Db = getDb()): PillarFlags {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;
  return parseFlagsJson(row?.value);
}

/**
 * Returns all 6 AI platform pillar flags, cached for 5 seconds (30 seconds on Turso,
 * invalidated immediately on local settings changes).
 * Missing key, malformed JSON, or DB errors safely resolve to all false.
 */
export function getFlags(): PillarFlags {
  const now = Date.now();
  try {
    const db = getDb();
    const settingsVersion = tursoSettingsVersion(db);
    if (
      cache &&
      cache.db === db &&
      cache.settingsVersion === settingsVersion &&
      now < cache.expiresAt
    ) {
      return { ...cache.flags };
    }
    const flags = readFlagsFromDb(db);
    const ttlMs = isTursoDatabase(db) ? TURSO_FLAGS_CACHE_TTL_MS : AI_PLATFORM_LIMITS.flagsCacheTtlMs;
    cache = { db, settingsVersion: tursoSettingsVersion(db), flags, expiresAt: now + ttlMs };
    return { ...flags };
  } catch {
    return freshDefaults();
  }
}

/**
 * Checks whether a single AI platform pillar is enabled.
 * Cached; DB or parse errors resolve to false.
 */
export function isPillarEnabled(pillar: Pillar): boolean {
  return getFlags()[pillar] === true;
}

/**
 * Persists a partial boolean patch to `ai_platform_flags_v1`, preserving unsent keys
 * and invalidating the cache only after the DB write succeeds.
 */
export function setFlags(patch: Partial<Record<Pillar, boolean>>): PillarFlags {
  const db = getDb();
  const next = readFlagsFromDb(db);
  for (const pillar of PILLARS) {
    if (Object.prototype.hasOwnProperty.call(patch, pillar)) {
      const val = patch[pillar];
      if (typeof val !== 'boolean') {
        throw new Error(`Invalid boolean flag value for pillar '${pillar}'`);
      }
      next[pillar] = val;
    }
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SETTINGS_KEY, JSON.stringify(next));
  const ttlMs = isTursoDatabase(db) ? TURSO_FLAGS_CACHE_TTL_MS : AI_PLATFORM_LIMITS.flagsCacheTtlMs;
  cache = {
    db,
    settingsVersion: tursoSettingsVersion(db),
    flags: { ...next },
    expiresAt: Date.now() + ttlMs,
  };
  return { ...next };
}

/** Clears the in-memory flags cache (tests only). */
export function resetFlagsCacheForTests(): void {
  cache = null;
}
