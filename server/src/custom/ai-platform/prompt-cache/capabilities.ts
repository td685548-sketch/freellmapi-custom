import { z } from 'zod';
import {
  DEFAULT_PROMPT_CACHE_SETTINGS,
  PROMPT_CACHE_LIMITS,
  PROMPT_CACHE_SETTINGS_KEY,
  type PromptCacheCapability,
  type PromptCacheCapabilityInput,
  type PromptCacheCapabilitySource,
  type PromptCacheMode,
  type PromptCacheSettings,
} from '@freellmapi/shared/ai-platform-prompt-cache.js';
import { getDb } from '../../../db/index.js';

export class PromptCacheStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'PromptCacheStoreError';
    this.code = code;
    this.status = status;
  }
}

interface CapabilityRow {
  platform: string;
  model_pattern: string;
  source: PromptCacheCapabilitySource;
  mode: PromptCacheMode;
  max_breakpoints: number;
  min_tokens: number;
  ttl_seconds: number;
  updated_at: string;
}

export const promptCacheSettingsPatchSchema = z
  .object({
    forward: z.boolean().optional(),
    autoBreakpoints: z.boolean().optional(),
    preferStickyRoute: z.boolean().optional(),
  })
  .strict();

export const promptCacheCapabilityInputSchema = z
  .object({
    platform: z.string().trim().min(1).max(PROMPT_CACHE_LIMITS.platformMaxChars),
    modelPattern: z.string().trim().min(1).max(PROMPT_CACHE_LIMITS.modelPatternMaxChars),
    mode: z.enum(['explicit', 'implicit', 'none']),
    maxBreakpoints: z.number().int().min(0).max(PROMPT_CACHE_LIMITS.maxBreakpoints).optional(),
    minTokens: z.number().int().min(0).max(PROMPT_CACHE_LIMITS.maxMinTokens).optional(),
    ttlSeconds: z.number().int().min(0).max(PROMPT_CACHE_LIMITS.maxTtlSeconds).optional(),
  })
  .strict();

function rowToCapability(row: CapabilityRow): PromptCacheCapability {
  return {
    platform: row.platform,
    modelPattern: row.model_pattern,
    mode: row.mode,
    maxBreakpoints: row.max_breakpoints,
    minTokens: row.min_tokens,
    ttlSeconds: row.ttl_seconds,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function defaultUnmatchedCapability(platform: string): PromptCacheCapability {
  return {
    platform,
    modelPattern: '*',
    mode: 'none',
    maxBreakpoints: 0,
    minTokens: 0,
    ttlSeconds: 0,
    source: 'builtin',
    updatedAt: '',
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function matchesWildcard(pattern: string, value: string): boolean {
  const regexSrc = `^${pattern.toLowerCase().split('*').map(escapeRegex).join('.*')}$`;
  return new RegExp(regexSrc, 's').test(value.toLowerCase());
}

function nonWildcardCount(pattern: string): number {
  let count = 0;
  for (const ch of pattern) {
    if (ch !== '*') count++;
  }
  return count;
}

function compareCandidates(a: PromptCacheCapability, b: PromptCacheCapability): number {
  const aSource = a.source === 'override' ? 1 : 0;
  const bSource = b.source === 'override' ? 1 : 0;
  if (aSource !== bSource) return bSource - aSource;

  if (a.modelPattern.length !== b.modelPattern.length) {
    return b.modelPattern.length - a.modelPattern.length;
  }

  const aNonWild = nonWildcardCount(a.modelPattern);
  const bNonWild = nonWildcardCount(b.modelPattern);
  if (aNonWild !== bNonWild) return bNonWild - aNonWild;

  const aExactPlat = a.platform !== '*' ? 1 : 0;
  const bExactPlat = b.platform !== '*' ? 1 : 0;
  return bExactPlat - aExactPlat;
}

/** Reads global prompt cache settings, safely falling back to defaults if DB or table is unavailable. */
export function getPromptCacheSettings(): PromptCacheSettings {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(PROMPT_CACHE_SETTINGS_KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULT_PROMPT_CACHE_SETTINGS };
    const parsed: unknown = JSON.parse(row.value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_PROMPT_CACHE_SETTINGS };
    }
    const obj = parsed as Record<string, unknown>;
    return {
      forward: typeof obj.forward === 'boolean' ? obj.forward : DEFAULT_PROMPT_CACHE_SETTINGS.forward,
      autoBreakpoints:
        typeof obj.autoBreakpoints === 'boolean'
          ? obj.autoBreakpoints
          : DEFAULT_PROMPT_CACHE_SETTINGS.autoBreakpoints,
      preferStickyRoute:
        typeof obj.preferStickyRoute === 'boolean'
          ? obj.preferStickyRoute
          : DEFAULT_PROMPT_CACHE_SETTINGS.preferStickyRoute,
    };
  } catch {
    return { ...DEFAULT_PROMPT_CACHE_SETTINGS };
  }
}

/** Validates and persists a partial update to prompt cache settings. */
export function setPromptCacheSettings(patch: Partial<PromptCacheSettings>): PromptCacheSettings {
  const parsed = promptCacheSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PromptCacheStoreError(
      `Invalid prompt cache settings: ${issue?.message ?? 'validation failed'}`,
      'validation_error',
      400,
    );
  }
  const current = getPromptCacheSettings();
  const next: PromptCacheSettings = {
    forward: parsed.data.forward ?? current.forward,
    autoBreakpoints: parsed.data.autoBreakpoints ?? current.autoBreakpoints,
    preferStickyRoute: parsed.data.preferStickyRoute ?? current.preferStickyRoute,
  };
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(PROMPT_CACHE_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** Lists all builtin and override cache capability rows. */
export function listCacheCapabilities(): PromptCacheCapability[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT platform, model_pattern, source, mode, max_breakpoints, min_tokens, ttl_seconds, updated_at
           FROM custom_ai_cache_capabilities
          ORDER BY CASE source WHEN 'override' THEN 0 ELSE 1 END,
                   platform ASC,
                   length(model_pattern) DESC,
                   model_pattern ASC`,
      )
      .all() as CapabilityRow[];
    return rows.map(rowToCapability);
  } catch {
    return [];
  }
}

/** Inserts or updates an `override` row in `custom_ai_cache_capabilities`. */
export function upsertCacheCapabilityOverride(input: PromptCacheCapabilityInput): PromptCacheCapability {
  const parsed = promptCacheCapabilityInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'capability';
    throw new PromptCacheStoreError(
      `Invalid capability (${field}): ${issue?.message ?? 'validation failed'}`,
      'validation_error',
      400,
    );
  }
  const data = parsed.data;
  const platform = data.platform.toLowerCase();
  const modelPattern = data.modelPattern;
  const mode = data.mode;
  const maxBreakpoints =
    data.maxBreakpoints ?? (mode === 'explicit' ? PROMPT_CACHE_LIMITS.defaultMaxBreakpoints : 0);
  const minTokens =
    data.minTokens ?? (mode === 'none' ? 0 : PROMPT_CACHE_LIMITS.defaultMinTokens);
  const ttlSeconds =
    data.ttlSeconds ?? (mode === 'none' ? 0 : PROMPT_CACHE_LIMITS.defaultTtlSeconds);
  const updatedAt = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO custom_ai_cache_capabilities (
         platform, model_pattern, source, mode, max_breakpoints, min_tokens, ttl_seconds, updated_at
       ) VALUES (?, ?, 'override', ?, ?, ?, ?, ?)
       ON CONFLICT(platform, model_pattern, source) DO UPDATE SET
         mode = excluded.mode,
         max_breakpoints = excluded.max_breakpoints,
         min_tokens = excluded.min_tokens,
         ttl_seconds = excluded.ttl_seconds,
         updated_at = excluded.updated_at`,
    )
    .run(platform, modelPattern, mode, maxBreakpoints, minTokens, ttlSeconds, updatedAt);

  return {
    platform,
    modelPattern,
    mode,
    maxBreakpoints,
    minTokens,
    ttlSeconds,
    source: 'override',
    updatedAt,
  };
}

/** Deletes an `override` capability row (never deletes `builtin` rows). Returns whether a row was removed. */
export function deleteCacheCapabilityOverride(platform: string, modelPattern: string): boolean {
  const normPlatform = platform.trim().toLowerCase();
  const normPattern = modelPattern.trim();
  if (!normPlatform || !normPattern) return false;
  const info = getDb()
    .prepare(
      `DELETE FROM custom_ai_cache_capabilities
        WHERE lower(platform) = lower(?)
          AND lower(model_pattern) = lower(?)
          AND source = 'override'`,
    )
    .run(normPlatform, normPattern);
  return info.changes > 0;
}

/**
 * Resolves the effective prompt cache capability for `(platform, modelId)`.
 * `override` always beats `builtin`; within the same source, longest `modelPattern`
 * wins (tie-break: more non-`*` characters, then exact platform over `*`).
 */
export function resolveCacheCapability(platform: string, modelId: string): PromptCacheCapability {
  const normPlatform = (platform ?? '').trim().toLowerCase();
  const normModel = (modelId ?? '').trim();

  let candidates: PromptCacheCapability[];
  try {
    const rows = getDb()
      .prepare(
        `SELECT platform, model_pattern, source, mode, max_breakpoints, min_tokens, ttl_seconds, updated_at
           FROM custom_ai_cache_capabilities
          WHERE lower(platform) = ? OR platform = '*'`,
      )
      .all(normPlatform) as CapabilityRow[];
    candidates = rows
      .map(rowToCapability)
      .filter((cap) => matchesWildcard(cap.modelPattern, normModel));
  } catch {
    return defaultUnmatchedCapability(normPlatform);
  }

  if (candidates.length === 0) {
    return defaultUnmatchedCapability(normPlatform);
  }

  candidates.sort(compareCandidates);
  return candidates[0]!;
}
