import { z } from 'zod';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  GUARD_ALLOWED_PATTERN_FLAGS,
  OUTPUT_GUARD_LIMITS,
  type GuardBufferingReason,
  type GuardDetectorsConfig,
  type GuardErrorCode,
  type GuardPolicyInput,
  type GuardPolicyView,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';

export class GuardStoreError extends Error {
  readonly status: number;
  readonly code: GuardErrorCode;
  readonly details?: unknown;

  constructor(message: string, code: GuardErrorCode, status: number, details?: unknown) {
    super(message);
    this.name = 'GuardStoreError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface GuardPolicyRow {
  scope_kind: ScopeKind;
  scope_id: string;
  mode: 'off' | 'log' | 'block';
  detectors_json: string;
  replacement_text: string;
  fail_mode: 'allow' | 'block';
  bypass_roles_json: string;
  hold_chars: number;
  max_delay_ms: number;
  revision: number;
  updated_by: number | null;
  updated_at: string | null;
}

const allowedFlagsSet = new Set<string>(GUARD_ALLOWED_PATTERN_FLAGS);

const patternRuleSchema = z
  .object({
    id: z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.patternIdMaxChars),
    name: z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.patternNameMaxChars),
    pattern: z.string().min(1).max(OUTPUT_GUARD_LIMITS.patternMaxChars),
    flags: z
      .string()
      .max(GUARD_ALLOWED_PATTERN_FLAGS.length)
      .refine(
        (flags) => {
          const seen = new Set<string>();
          for (const ch of flags) {
            if (!allowedFlagsSet.has(ch) || seen.has(ch)) return false;
            seen.add(ch);
          }
          return true;
        },
        { message: 'Pattern flags must be a unique subset of i, m, u, s.' },
      ),
  })
  .strict();

const detectorsSchema = z
  .object({
    keywords: z
      .object({
        enabled: z.boolean(),
        terms: z
          .array(z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.keywordMaxChars))
          .max(OUTPUT_GUARD_LIMITS.maxKeywords),
      })
      .strict(),
    patterns: z
      .object({
        enabled: z.boolean(),
        rules: z.array(patternRuleSchema).max(OUTPUT_GUARD_LIMITS.maxPatterns),
      })
      .strict(),
    promptLeak: z
      .object({
        enabled: z.boolean(),
        minShingles: z
          .number()
          .int()
          .min(OUTPUT_GUARD_LIMITS.minShingles)
          .max(OUTPUT_GUARD_LIMITS.maxMinShingles),
      })
      .strict(),
    pii: z
      .object({
        enabled: z.boolean(),
        action: z.enum(['mask', 'block']),
      })
      .strict(),
    maxLength: z
      .object({
        enabled: z.boolean(),
        chars: z
          .number()
          .int()
          .min(OUTPUT_GUARD_LIMITS.minLengthChars)
          .max(OUTPUT_GUARD_LIMITS.hardMaxLengthChars),
      })
      .strict(),
    moderation: z
      .object({
        enabled: z.boolean(),
      })
      .strict(),
    judge: z
      .object({
        enabled: z.boolean(),
        model: z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.judgeModelMaxChars),
        criteria: z.string().max(OUTPUT_GUARD_LIMITS.judgeCriteriaMaxChars),
      })
      .strict(),
  })
  .strict();

export const guardPolicyInputSchema = z
  .object({
    mode: z.enum(['off', 'log', 'block']),
    detectors: detectorsSchema,
    replacementText: z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.replacementMaxChars),
    failMode: z.enum(['allow', 'block']),
    bypassRoles: z
      .array(z.string().trim().min(1).max(OUTPUT_GUARD_LIMITS.bypassRoleMaxChars))
      .max(OUTPUT_GUARD_LIMITS.maxBypassRoles),
    holdChars: z
      .number()
      .int()
      .min(OUTPUT_GUARD_LIMITS.minHoldChars)
      .max(OUTPUT_GUARD_LIMITS.maxHoldChars),
    maxDelayMs: z
      .number()
      .int()
      .min(OUTPUT_GUARD_LIMITS.minDelayMs)
      .max(OUTPUT_GUARD_LIMITS.maxDelayMs),
    revision: z.number().int().min(0),
  })
  .strict();

function hasTable(table: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

export function assertScopeExists(scope: Scope): Scope {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch (err) {
    throw new GuardStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }

  if (norm.kind === 'agent') {
    throw new GuardStoreError(
      'Agent scope is unavailable until orchestrator (US7) is installed.',
      'scope_unavailable',
      409,
    );
  }

  const db = getDb();
  if (norm.kind === 'profile') {
    const row = db.prepare('SELECT id FROM client_profiles WHERE id = ?').get(Number(norm.id));
    if (!row) {
      throw new GuardStoreError(`Profile '${norm.id}' not found.`, 'scope_not_found', 404);
    }
    return norm;
  }

  if (
    !hasTable('x_support_tenants') ||
    !db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(Number(norm.id))
  ) {
    throw new GuardStoreError(`Support tenant '${norm.id}' not found.`, 'scope_not_found', 404);
  }
  return norm;
}

export function computeBufferingReason(
  policy: Pick<GuardPolicyInput, 'mode' | 'detectors'>,
): GuardBufferingReason {
  if (policy.mode === 'off') return 'none';
  if (policy.detectors.moderation.enabled || policy.detectors.judge.enabled) {
    return 'external_detector';
  }
  if (policy.detectors.patterns.enabled && policy.detectors.patterns.rules.length > 0) {
    return 'custom_pattern';
  }
  return 'streaming_window';
}

export function validatePolicyInput(input: unknown): GuardPolicyInput {
  const parsed = guardPolicyInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') || 'policy';
    throw new GuardStoreError(
      `Invalid output guard policy (${path}): ${issue?.message ?? 'validation failed'}`,
      'validation_error',
      422,
    );
  }
  return parsed.data;
}

function parseDetectorsJson(raw: string): GuardDetectorsConfig {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const checked = detectorsSchema.safeParse(parsed);
    if (checked.success) return checked.data;
  } catch {
    /* fallback to defaults */
  }
  return structuredClone(DEFAULT_GUARD_DETECTORS);
}

function parseBypassRolesJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    }
  } catch {
    /* fallback */
  }
  return [];
}

function rowToView(row: GuardPolicyRow): GuardPolicyView {
  const detectors = parseDetectorsJson(row.detectors_json);
  const bypassRoles = parseBypassRolesJson(row.bypass_roles_json);
  return {
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    mode: row.mode,
    detectors,
    replacementText: row.replacement_text,
    failMode: row.fail_mode,
    bypassRoles,
    holdChars: row.hold_chars,
    maxDelayMs: row.max_delay_ms,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    bufferingReason: computeBufferingReason({ mode: row.mode, detectors }),
  };
}

export function buildDefaultPolicyView(scope: Scope): GuardPolicyView {
  const detectors = structuredClone(DEFAULT_GUARD_DETECTORS);
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    mode: DEFAULT_GUARD_POLICY_BASE.mode,
    detectors,
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    failMode: DEFAULT_GUARD_POLICY_BASE.failMode,
    bypassRoles: [],
    holdChars: DEFAULT_GUARD_POLICY_BASE.holdChars,
    maxDelayMs: DEFAULT_GUARD_POLICY_BASE.maxDelayMs,
    revision: 0,
    updatedBy: null,
    updatedAt: null,
    bufferingReason: 'none',
  };
}

export function getStoredPolicy(scope: Scope): GuardPolicyRow | null {
  const norm = normalizeScope(scope);
  const row = getDb()
    .prepare('SELECT * FROM custom_ai_output_policies WHERE scope_kind = ? AND scope_id = ?')
    .get(norm.kind, norm.id) as GuardPolicyRow | undefined;
  return row ?? null;
}

export function getEffectivePolicy(scope: Scope): GuardPolicyView {
  const norm = assertScopeExists(scope);
  const row = getStoredPolicy(norm);
  return row ? rowToView(row) : buildDefaultPolicyView(norm);
}

/**
 * Reads effective policy for runtime inference without throwing if scope was deleted
 * mid-flight; falls back to default 'off' policy if no row exists.
 */
export function getRuntimePolicySnapshot(scope: Scope): GuardPolicyView {
  const norm = normalizeScope(scope);
  const row = getStoredPolicy(norm);
  return row ? rowToView(row) : buildDefaultPolicyView(norm);
}

export function upsertPolicy(
  scope: Scope,
  input: GuardPolicyInput,
  actorId: number | null,
): GuardPolicyView {
  const norm = assertScopeExists(scope);
  const valid = validatePolicyInput(input);
  const db = getDb();
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const existing = getStoredPolicy(norm);
    const currentRevision = existing ? existing.revision : 0;

    if (valid.revision !== currentRevision) {
      const current = existing ? rowToView(existing) : buildDefaultPolicyView(norm);
      throw new GuardStoreError(
        `Revision conflict: expected ${currentRevision}, got ${valid.revision}.`,
        'revision_conflict',
        409,
        { current },
      );
    }

    const detectorsJson = JSON.stringify(valid.detectors);
    const bypassRolesJson = JSON.stringify(valid.bypassRoles);

    if (!existing) {
      db.prepare(
        `INSERT INTO custom_ai_output_policies (
          scope_kind, scope_id, mode, detectors_json, replacement_text,
          fail_mode, bypass_roles_json, hold_chars, max_delay_ms,
          revision, updated_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        norm.kind,
        norm.id,
        valid.mode,
        detectorsJson,
        valid.replacementText,
        valid.failMode,
        bypassRolesJson,
        valid.holdChars,
        valid.maxDelayMs,
        actorId,
        nowIso,
      );
    } else {
      const res = db
        .prepare(
          `UPDATE custom_ai_output_policies
              SET mode = ?,
                  detectors_json = ?,
                  replacement_text = ?,
                  fail_mode = ?,
                  bypass_roles_json = ?,
                  hold_chars = ?,
                  max_delay_ms = ?,
                  revision = revision + 1,
                  updated_by = ?,
                  updated_at = ?
            WHERE scope_kind = ? AND scope_id = ? AND revision = ?`,
        )
        .run(
          valid.mode,
          detectorsJson,
          valid.replacementText,
          valid.failMode,
          bypassRolesJson,
          valid.holdChars,
          valid.maxDelayMs,
          actorId,
          nowIso,
          norm.kind,
          norm.id,
          currentRevision,
        );

      if (res.changes === 0) {
        const latest = getStoredPolicy(norm);
        const current = latest ? rowToView(latest) : buildDefaultPolicyView(norm);
        throw new GuardStoreError(
          'Revision conflict during update.',
          'revision_conflict',
          409,
          { current },
        );
      }
    }

    const saved = getStoredPolicy(norm);
    return saved ? rowToView(saved) : buildDefaultPolicyView(norm);
  })();
}

export function purgeGuardScope(kind: ScopeKind, id: string): number {
  const norm = normalizeScope({ kind, id });
  const db = getDb();
  let deleted = 0;
  if (hasTable('custom_ai_output_policies')) {
    deleted += db
      .prepare('DELETE FROM custom_ai_output_policies WHERE scope_kind = ? AND scope_id = ?')
      .run(norm.kind, norm.id).changes;
  }
  if (hasTable('custom_ai_guard_events')) {
    deleted += db
      .prepare('DELETE FROM custom_ai_guard_events WHERE scope_kind = ? AND scope_id = ?')
      .run(norm.kind, norm.id).changes;
  }
  return deleted;
}
