import { z } from 'zod';
import {
  CONTEXT_POLICY_DEFAULT,
  CONTEXT_POLICY_LIMITS,
  CONTEXT_PRESETS,
  type ClientHistoryMode,
  type ContextPolicy,
  type ContextPolicyDefault,
  type ContextPolicyInput,
  type ContextPolicySuggested,
  type ContextPreset,
  type ContextPresetKey,
  type ContextPresetValues,
} from '@freellmapi/shared/context-budget.js';
import { getDb } from '../../db/index.js';

const CONTEXT_POLICY_DEFAULT_KEY = 'context_policy_default';
const INHERITED_UPDATED_AT = '1970-01-01T00:00:00.000Z';

const L = CONTEXT_POLICY_LIMITS;

const PRESET_NUMERIC_FIELDS = [
  'maxInputTokens',
  'outputReserveTokens',
  'safetyMarginPct',
  'summarySharePct',
  'knowledgeSharePct',
  'dropBlockTurns',
] as const satisfies ReadonlyArray<keyof ContextPresetValues>;

export type ContextPolicyErrorCode =
  | 'context_policy_invalid'
  | 'context_policy_budget_too_small'
  | 'context_policy_shares_too_large'
  | 'context_policy_preset_mismatch';

/** Validation/domain error thrown by context policy store operations. */
export class ContextPolicyError extends Error {
  readonly code: ContextPolicyErrorCode;
  readonly status: number;

  constructor(code: ContextPolicyErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'ContextPolicyError';
    this.code = code;
    this.status = status;
  }
}

const presetEnumSchema = z.enum(['saver', 'balanced', 'max_context', 'custom']);
const presetKeyEnumSchema = z.enum(['saver', 'balanced', 'max_context']);
const clientHistoryModeSchema = z.enum(['passthrough', 'trim_on_overflow', 'enforce_budget']);

const policyInputSchema = z
  .object({
    enabled: z.boolean().optional(),
    preset: presetEnumSchema.optional(),
    maxInputTokens: z.number().int().max(L.maxMaxInputTokens).nullable().optional(),
    outputReserveTokens: z.number().int().min(L.outputReserve[0]).max(L.outputReserve[1]).optional(),
    safetyMarginPct: z.number().int().min(L.safetyMarginPct[0]).max(L.safetyMarginPct[1]).optional(),
    summarySharePct: z.number().int().min(L.sharePct[0]).max(L.sharePct[1]).optional(),
    knowledgeSharePct: z.number().int().min(L.sharePct[0]).max(L.sharePct[1]).optional(),
    dropBlockTurns: z.number().int().min(L.dropBlockTurns[0]).max(L.dropBlockTurns[1]).optional(),
    summarize: z.boolean().optional(),
    clientHistoryMode: clientHistoryModeSchema.optional(),
    knowledgeMinScore: z.number().finite().min(L.knowledgeMinScore[0]).max(L.knowledgeMinScore[1]).nullable().optional(),
  })
  .strict();

const defaultPolicySchema = z
  .object({
    enabled: z.boolean().optional(),
    preset: presetKeyEnumSchema.optional(),
    fallbackWindowTokens: z
      .number()
      .int()
      .min(L.fallbackWindowTokens[0])
      .max(L.fallbackWindowTokens[1])
      .optional(),
    imageTokens: z.number().int().min(L.imageTokens[0]).max(L.imageTokens[1]).optional(),
  })
  .strict();

interface PolicyRow {
  profile_id: number;
  enabled: number;
  preset: ContextPreset;
  max_input_tokens: number | null;
  output_reserve_tokens: number;
  safety_margin_pct: number;
  summary_share_pct: number;
  knowledge_share_pct: number;
  drop_block_turns: number;
  summarize: number;
  client_history_mode: ClientHistoryMode;
  knowledge_min_score: number | null;
  updated_at: string;
}

const policyCache = new Map<number, ContextPolicy>();

function rowToPolicy(row: PolicyRow): ContextPolicy {
  return {
    profileId: row.profile_id,
    enabled: row.enabled === 1,
    inherited: false,
    preset: row.preset,
    maxInputTokens: row.max_input_tokens,
    outputReserveTokens: row.output_reserve_tokens,
    safetyMarginPct: row.safety_margin_pct,
    summarySharePct: row.summary_share_pct,
    knowledgeSharePct: row.knowledge_share_pct,
    dropBlockTurns: row.drop_block_turns,
    summarize: row.summarize === 1,
    clientHistoryMode: row.client_history_mode,
    knowledgeMinScore: row.knowledge_min_score,
    updatedAt: row.updated_at,
  };
}

function buildInheritedPolicy(profileId: number, def: ContextPolicyDefault): ContextPolicy {
  return {
    profileId,
    enabled: def.enabled,
    inherited: true,
    preset: def.preset,
    ...CONTEXT_PRESETS[def.preset],
    updatedAt: INHERITED_UPDATED_AT,
  };
}

/** Clears the in-memory per-profile policy cache (primarily for tests). */
export function clearContextPolicyCache(): void {
  policyCache.clear();
}

/** Reads the system-wide fallback context policy default from `settings`. */
export function getContextPolicyDefault(): ContextPolicyDefault {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(CONTEXT_POLICY_DEFAULT_KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...CONTEXT_POLICY_DEFAULT };
    const parsedJson: unknown = JSON.parse(row.value);
    const parsed = defaultPolicySchema.safeParse(parsedJson);
    if (!parsed.success) return { ...CONTEXT_POLICY_DEFAULT };
    return {
      enabled: parsed.data.enabled ?? CONTEXT_POLICY_DEFAULT.enabled,
      preset: parsed.data.preset ?? CONTEXT_POLICY_DEFAULT.preset,
      fallbackWindowTokens: parsed.data.fallbackWindowTokens ?? CONTEXT_POLICY_DEFAULT.fallbackWindowTokens,
      imageTokens: parsed.data.imageTokens ?? CONTEXT_POLICY_DEFAULT.imageTokens,
    };
  } catch {
    return { ...CONTEXT_POLICY_DEFAULT };
  }
}

/** Validates and persists the system-wide default context policy, invalidating cached policies. */
export function setContextPolicyDefault(input: Partial<ContextPolicyDefault>): ContextPolicyDefault {
  const parsed = defaultPolicySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ContextPolicyError(
      'context_policy_invalid',
      `Invalid default context policy: ${issue?.message ?? 'validation failed'}`,
    );
  }
  const current = getContextPolicyDefault();
  const next: ContextPolicyDefault = {
    enabled: parsed.data.enabled ?? current.enabled,
    preset: parsed.data.preset ?? current.preset,
    fallbackWindowTokens: parsed.data.fallbackWindowTokens ?? current.fallbackWindowTokens,
    imageTokens: parsed.data.imageTokens ?? current.imageTokens,
  };
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(CONTEXT_POLICY_DEFAULT_KEY, JSON.stringify(next));
  policyCache.clear();
  return next;
}

/** Resolves a client profile's context policy (row override or inherited system default), cached per profile_id. */
export function resolveContextPolicy(profileId: number): ContextPolicy {
  const cached = policyCache.get(profileId);
  if (cached) return { ...cached };

  const row = getDb()
    .prepare('SELECT * FROM custom_context_policies WHERE profile_id = ?')
    .get(profileId) as PolicyRow | undefined;

  const resolved = row ? rowToPolicy(row) : buildInheritedPolicy(profileId, getContextPolicyDefault());
  policyCache.set(profileId, resolved);
  return { ...resolved };
}

function validateAndMergePolicy(current: ContextPolicy, input: ContextPolicyInput, nowIso: string): ContextPolicy {
  const parsed = policyInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ContextPolicyError(
      'context_policy_invalid',
      `Invalid context policy: ${issue?.message ?? 'validation failed'}`,
    );
  }
  const patch = parsed.data;

  if (
    patch.maxInputTokens !== undefined &&
    patch.maxInputTokens !== null &&
    patch.maxInputTokens < L.minMaxInputTokens
  ) {
    throw new ContextPolicyError(
      'context_policy_budget_too_small',
      `maxInputTokens must be at least ${L.minMaxInputTokens}`,
    );
  }

  const preset: ContextPreset = patch.preset ?? current.preset;
  let numericValues: Pick<
    ContextPresetValues,
    'maxInputTokens' | 'outputReserveTokens' | 'safetyMarginPct' | 'summarySharePct' | 'knowledgeSharePct' | 'dropBlockTurns'
  >;

  if (preset !== 'custom') {
    const presetDefaults = CONTEXT_PRESETS[preset as ContextPresetKey];
    for (const field of PRESET_NUMERIC_FIELDS) {
      const supplied = patch[field];
      if (supplied !== undefined && supplied !== presetDefaults[field]) {
        throw new ContextPolicyError(
          'context_policy_preset_mismatch',
          `Field ${field} does not match preset '${preset}'`,
        );
      }
    }
    numericValues = {
      maxInputTokens: presetDefaults.maxInputTokens,
      outputReserveTokens: presetDefaults.outputReserveTokens,
      safetyMarginPct: presetDefaults.safetyMarginPct,
      summarySharePct: presetDefaults.summarySharePct,
      knowledgeSharePct: presetDefaults.knowledgeSharePct,
      dropBlockTurns: presetDefaults.dropBlockTurns,
    };
  } else {
    numericValues = {
      maxInputTokens: patch.maxInputTokens !== undefined ? patch.maxInputTokens : current.maxInputTokens,
      outputReserveTokens: patch.outputReserveTokens ?? current.outputReserveTokens,
      safetyMarginPct: patch.safetyMarginPct ?? current.safetyMarginPct,
      summarySharePct: patch.summarySharePct ?? current.summarySharePct,
      knowledgeSharePct: patch.knowledgeSharePct ?? current.knowledgeSharePct,
      dropBlockTurns: patch.dropBlockTurns ?? current.dropBlockTurns,
    };
  }

  if (numericValues.summarySharePct + numericValues.knowledgeSharePct > L.maxShareSum) {
    throw new ContextPolicyError(
      'context_policy_shares_too_large',
      `summarySharePct + knowledgeSharePct must not exceed ${L.maxShareSum}`,
    );
  }

  return {
    profileId: current.profileId,
    enabled: patch.enabled ?? current.enabled,
    inherited: false,
    preset,
    ...numericValues,
    summarize: patch.summarize ?? current.summarize,
    clientHistoryMode: patch.clientHistoryMode ?? current.clientHistoryMode,
    knowledgeMinScore: patch.knowledgeMinScore !== undefined ? patch.knowledgeMinScore : current.knowledgeMinScore,
    updatedAt: nowIso,
  };
}

/** Validates and saves a per-profile context policy override, invalidating that profile's cache entry. */
export function saveContextPolicy(profileId: number, input: ContextPolicyInput): ContextPolicy {
  const current = resolveContextPolicy(profileId);
  const next = validateAndMergePolicy(current, input, new Date().toISOString());

  getDb()
    .prepare(
      `INSERT INTO custom_context_policies (
         profile_id, enabled, preset, max_input_tokens, output_reserve_tokens,
         safety_margin_pct, summary_share_pct, knowledge_share_pct, drop_block_turns,
         summarize, client_history_mode, knowledge_min_score, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         enabled = excluded.enabled,
         preset = excluded.preset,
         max_input_tokens = excluded.max_input_tokens,
         output_reserve_tokens = excluded.output_reserve_tokens,
         safety_margin_pct = excluded.safety_margin_pct,
         summary_share_pct = excluded.summary_share_pct,
         knowledge_share_pct = excluded.knowledge_share_pct,
         drop_block_turns = excluded.drop_block_turns,
         summarize = excluded.summarize,
         client_history_mode = excluded.client_history_mode,
         knowledge_min_score = excluded.knowledge_min_score,
         updated_at = excluded.updated_at`,
    )
    .run(
      profileId,
      next.enabled ? 1 : 0,
      next.preset,
      next.maxInputTokens,
      next.outputReserveTokens,
      next.safetyMarginPct,
      next.summarySharePct,
      next.knowledgeSharePct,
      next.dropBlockTurns,
      next.summarize ? 1 : 0,
      next.clientHistoryMode,
      next.knowledgeMinScore,
      next.updatedAt,
    );

  policyCache.delete(profileId);
  return { ...next, profileId };
}

/** Deletes a per-profile context policy override so the profile reverts to the system default. */
export function deleteContextPolicy(profileId: number): boolean {
  const info = getDb().prepare('DELETE FROM custom_context_policies WHERE profile_id = ?').run(profileId);
  policyCache.delete(profileId);
  return info.changes > 0;
}

/** Converts legacy character-based conversation settings into a suggested token budget policy. */
export function suggestedFromConversationSettings(settings: {
  maxChars: number;
  summarize: boolean;
}): ContextPolicySuggested {
  const raw = Math.ceil(settings.maxChars / 3.2 / 1000) * 1000;
  const maxInputTokens = Math.min(
    L.maxMaxInputTokens,
    Math.max(L.minMaxInputTokens, Number.isFinite(raw) ? raw : L.minMaxInputTokens),
  );
  return {
    maxInputTokens,
    summarize: Boolean(settings.summarize),
  };
}

/** Removes policies belonging to deleted client profiles and clears them from the in-memory cache. */
export function pruneOrphanPolicies(): number {
  const db = getDb();
  const orphans = db
    .prepare('SELECT profile_id FROM custom_context_policies WHERE profile_id NOT IN (SELECT id FROM client_profiles)')
    .all() as Array<{ profile_id: number }>;
  if (orphans.length === 0) return 0;

  const info = db
    .prepare('DELETE FROM custom_context_policies WHERE profile_id NOT IN (SELECT id FROM client_profiles)')
    .run();
  for (const row of orphans) {
    policyCache.delete(row.profile_id);
  }
  return info.changes;
}
