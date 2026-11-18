import crypto from 'node:crypto';
import {
  EVAL_CANARY_LIMITS,
  PROMPT_VARIANT_HEADER,
  type PromptCanaryActionResponse,
  type PromptCanaryConfig,
  type PromptCanaryUpdateInput,
  type PromptVariantKind,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-eval-canary.js';
import type { PromptVariable } from '@freellmapi/shared/ai-platform-prompts.js';
import { getDb, type Db } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';
import {
  PromptNotFoundError,
  PromptStoreError,
  RevisionConflictError,
  getPromptScopeState,
  getPromptVersion,
  getPublishedPrompt,
} from './store.js';

export { PROMPT_VARIANT_HEADER };

interface PromptCanaryRow {
  scope_kind: ScopeKind;
  scope_id: string;
  enabled: number;
  candidate_version: number | null;
  traffic_percent: number;
  published_impressions: number;
  published_errors: number;
  published_total_latency_ms: number;
  canary_impressions: number;
  canary_errors: number;
  canary_total_latency_ms: number;
  updated_by: number | null;
  updated_at: string | null;
}

export interface WeightedOption {
  weight: number;
}

export interface SelectedPromptVariant {
  variant: PromptVariantKind;
  headerValue: string;
  version: number | null;
  body: string | null;
  variables: PromptVariable[];
  canaryActive: boolean;
}

function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tryNormalizeCanaryScope(scope: Scope): Scope {
  try {
    return normalizeScope(scope);
  } catch (err) {
    throw new PromptStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function avgLatency(totalMs: number, impressions: number): number {
  if (impressions <= 0 || totalMs <= 0) return 0;
  return Math.round(totalMs / impressions);
}

function rowToCanaryConfig(scope: Scope, row?: PromptCanaryRow): PromptCanaryConfig {
  const pubImpressions = row?.published_impressions ?? 0;
  const pubTotalLatency = row?.published_total_latency_ms ?? 0;
  const canImpressions = row?.canary_impressions ?? 0;
  const canTotalLatency = row?.canary_total_latency_ms ?? 0;

  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    enabled: row?.enabled === 1,
    candidateVersion: row?.candidate_version ?? null,
    trafficPercent: row?.traffic_percent ?? EVAL_CANARY_LIMITS.defaultTrafficPercent,
    publishedImpressions: pubImpressions,
    publishedErrors: row?.published_errors ?? 0,
    publishedTotalLatencyMs: pubTotalLatency,
    publishedAvgLatencyMs: avgLatency(pubTotalLatency, pubImpressions),
    canaryImpressions: canImpressions,
    canaryErrors: row?.canary_errors ?? 0,
    canaryTotalLatencyMs: canTotalLatency,
    canaryAvgLatencyMs: avgLatency(canTotalLatency, canImpressions),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/**
 * Portkey-style weighted traffic selector (`selectProviderByWeight` pattern).
 */
export function selectVariantByWeight<T extends WeightedOption>(
  options: readonly T[],
  randomFn: () => number = Math.random,
): T {
  const totalWeight = options.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) {
    throw new PromptStoreError('Total traffic weight must be greater than zero.', 'invalid_weights', 400);
  }

  let cursor = Math.min(0.999999999, Math.max(0, randomFn())) * totalWeight;
  for (const item of options) {
    const w = Math.max(0, item.weight);
    if (cursor < w) {
      return item;
    }
    cursor -= w;
  }
  return options[options.length - 1]!;
}

/**
 * Deterministic SHA-256 bucket in `[0, 100)` so multi-turn conversations (`X-Conversation-Id`)
 * or recurring `endUser` sessions remain sticky and never flip system prompts mid-chat.
 */
export function computeStickyBucketPercent(
  scope: Scope,
  candidateVersion: number,
  stickyKey: string,
): number {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.kind}:${scope.id}:v${candidateVersion}:${stickyKey}`)
    .digest();
  const uint32 = digest.readUInt32BE(0);
  return (uint32 / 0x1_0000_0000) * 100;
}

export function getCanaryConfig(scope: Scope): PromptCanaryConfig {
  const norm = tryNormalizeCanaryScope(scope);
  const db = getDb();
  if (!hasTable(db, 'custom_ai_prompt_canary')) {
    return rowToCanaryConfig(norm);
  }
  const row = db
    .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
    .get(norm.kind, norm.id) as PromptCanaryRow | undefined;
  return rowToCanaryConfig(norm, row);
}

export function setCanaryConfig(
  scope: Scope,
  input: PromptCanaryUpdateInput,
  actorId: number | null,
): PromptCanaryConfig {
  const norm = tryNormalizeCanaryScope(scope);
  if (
    typeof input.trafficPercent !== 'number' ||
    !Number.isInteger(input.trafficPercent) ||
    input.trafficPercent < EVAL_CANARY_LIMITS.minTrafficPercent ||
    input.trafficPercent > EVAL_CANARY_LIMITS.maxTrafficPercent
  ) {
    throw new PromptStoreError(
      `trafficPercent must be an integer between ${EVAL_CANARY_LIMITS.minTrafficPercent} and ${EVAL_CANARY_LIMITS.maxTrafficPercent}.`,
      'validation_error',
      422,
    );
  }

  const state = getPromptScopeState(norm);
  const candidateVersion = input.candidateVersion ?? null;

  if (candidateVersion !== null) {
    if (!Number.isInteger(candidateVersion) || candidateVersion < 1) {
      throw new PromptStoreError('candidateVersion must be a positive integer.', 'validation_error', 422);
    }
    // Verify the version exists in this exact scope
    getPromptVersion(norm, candidateVersion);
  }

  if (input.enabled) {
    if (state.head.publishedVersion === null) {
      throw new PromptStoreError(
        'A published prompt version is required before enabling a canary split.',
        'no_published_version',
        409,
      );
    }
    if (candidateVersion === null) {
      throw new PromptStoreError(
        'candidateVersion is required when enabling a canary split.',
        'validation_error',
        422,
      );
    }
    if (candidateVersion === state.head.publishedVersion) {
      throw new PromptStoreError(
        'Canary candidate version must differ from the currently published version.',
        'same_version_conflict',
        409,
      );
    }
  }

  const db = getDb();
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
      .get(norm.kind, norm.id) as PromptCanaryRow | undefined;

    const resetCounters =
      Boolean(input.resetMetrics) ||
      !existing ||
      existing.candidate_version !== candidateVersion;

    if (!existing) {
      db.prepare(
        `INSERT INTO custom_ai_prompt_canary (
           scope_kind, scope_id, enabled, candidate_version, traffic_percent,
           published_impressions, published_errors, published_total_latency_ms,
           canary_impressions, canary_errors, canary_total_latency_ms,
           updated_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, ?, ?)`,
      ).run(
        norm.kind,
        norm.id,
        input.enabled ? 1 : 0,
        candidateVersion,
        input.trafficPercent,
        actorId,
        nowIso,
      );
    } else if (resetCounters) {
      db.prepare(
        `UPDATE custom_ai_prompt_canary
            SET enabled = ?,
                candidate_version = ?,
                traffic_percent = ?,
                published_impressions = 0,
                published_errors = 0,
                published_total_latency_ms = 0,
                canary_impressions = 0,
                canary_errors = 0,
                canary_total_latency_ms = 0,
                updated_by = ?,
                updated_at = ?
          WHERE scope_kind = ? AND scope_id = ?`,
      ).run(
        input.enabled ? 1 : 0,
        candidateVersion,
        input.trafficPercent,
        actorId,
        nowIso,
        norm.kind,
        norm.id,
      );
    } else {
      db.prepare(
        `UPDATE custom_ai_prompt_canary
            SET enabled = ?,
                candidate_version = ?,
                traffic_percent = ?,
                updated_by = ?,
                updated_at = ?
          WHERE scope_kind = ? AND scope_id = ?`,
      ).run(
        input.enabled ? 1 : 0,
        candidateVersion,
        input.trafficPercent,
        actorId,
        nowIso,
        norm.kind,
        norm.id,
      );
    }

    const saved = db
      .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
      .get(norm.kind, norm.id) as PromptCanaryRow | undefined;
    return rowToCanaryConfig(norm, saved);
  })();
}

function syncUnderlyingSystemPromptForPromote(db: Db, norm: Scope, body: string): void {
  if (norm.kind === 'profile' && hasTable(db, 'client_profiles')) {
    db.prepare(
      "UPDATE client_profiles SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(body, Number(norm.id));
  } else if (norm.kind === 'support_tenant' && hasTable(db, 'x_support_tenants')) {
    db.prepare('UPDATE x_support_tenants SET system_prompt = ?, updated_at = ? WHERE id = ?').run(
      body,
      new Date().toISOString(),
      Number(norm.id),
    );
  }
}

/**
 * One-click promote: atomically promotes the active canary `candidateVersion` to
 * become the scope's `published` version and turns off the canary split.
 */
export function promoteCanary(
  scope: Scope,
  expectedRevision: number | undefined,
  actorId: number | null,
): PromptCanaryActionResponse {
  const norm = tryNormalizeCanaryScope(scope);
  const db = getDb();
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const state = getPromptScopeState(norm);
    if (expectedRevision !== undefined && expectedRevision !== state.head.revision) {
      throw new RevisionConflictError(state);
    }

    const canaryRow = db
      .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
      .get(norm.kind, norm.id) as PromptCanaryRow | undefined;

    const candidateVer = canaryRow?.candidate_version ?? null;
    if (!canaryRow || candidateVer === null) {
      throw new PromptStoreError(
        'No canary candidate version is configured to promote.',
        'no_canary_candidate',
        409,
      );
    }

    const candidateRow = db
      .prepare(
        'SELECT id, version, body, status FROM custom_ai_prompt_versions WHERE scope_kind = ? AND scope_id = ? AND version = ?',
      )
      .get(norm.kind, norm.id, candidateVer) as
      | { id: number; version: number; body: string; status: string }
      | undefined;

    if (!candidateRow) {
      throw new PromptNotFoundError(`Canary candidate version ${candidateVer} not found.`);
    }

    db.prepare(
      `UPDATE custom_ai_prompt_versions
          SET status = 'archived'
        WHERE scope_kind = ? AND scope_id = ? AND status = 'published'`,
    ).run(norm.kind, norm.id);

    db.prepare("UPDATE custom_ai_prompt_versions SET status = 'published' WHERE id = ?").run(
      candidateRow.id,
    );

    const nextDraftVersion =
      state.head.draftVersion === candidateRow.version ? null : state.head.draftVersion;
    const nextRevision = state.head.revision + 1;

    db.prepare(
      `INSERT INTO custom_ai_prompt_heads
         (scope_kind, scope_id, published_version, draft_version, revision)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         published_version = excluded.published_version,
         draft_version = excluded.draft_version,
         revision = excluded.revision`,
    ).run(norm.kind, norm.id, candidateRow.version, nextDraftVersion, nextRevision);

    syncUnderlyingSystemPromptForPromote(db, norm, candidateRow.body);

    db.prepare(
      `UPDATE custom_ai_prompt_canary
          SET enabled = 0,
              candidate_version = NULL,
              published_impressions = 0,
              published_errors = 0,
              published_total_latency_ms = 0,
              canary_impressions = 0,
              canary_errors = 0,
              canary_total_latency_ms = 0,
              updated_by = ?,
              updated_at = ?
        WHERE scope_kind = ? AND scope_id = ?`,
    ).run(actorId, nowIso, norm.kind, norm.id);

    const updatedCanary = db
      .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
      .get(norm.kind, norm.id) as PromptCanaryRow | undefined;

    return {
      canary: rowToCanaryConfig(norm, updatedCanary),
      publishedVersion: candidateRow.version,
      revision: nextRevision,
    };
  })();
}

/**
 * One-click abort / instant rollback: immediately disables canary traffic routing
 * so 100% of requests revert to the published version while retaining the telemetry
 * counters for post-mortem inspection.
 */
export function abortCanary(
  scope: Scope,
  actorId: number | null,
): PromptCanaryActionResponse {
  const norm = tryNormalizeCanaryScope(scope);
  const db = getDb();
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const state = getPromptScopeState(norm);
    db.prepare(
      `INSERT INTO custom_ai_prompt_canary (
         scope_kind, scope_id, enabled, candidate_version, traffic_percent, updated_by, updated_at
       ) VALUES (?, ?, 0, NULL, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         enabled = 0,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).run(norm.kind, norm.id, EVAL_CANARY_LIMITS.defaultTrafficPercent, actorId, nowIso);

    const updatedCanary = db
      .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
      .get(norm.kind, norm.id) as PromptCanaryRow | undefined;

    return {
      canary: rowToCanaryConfig(norm, updatedCanary),
      publishedVersion: state.head.publishedVersion,
      revision: state.head.revision,
    };
  })();
}

/**
 * Selects either the `published` prompt or the `canary(vN)` candidate prompt for an
 * incoming inference request. Sticky when `conversationId` or `endUser` is present.
 */
export function selectPromptVariant(
  scope: Scope,
  opts?: {
    conversationId?: string | null;
    endUser?: string | null;
    randomFn?: () => number;
  },
): SelectedPromptVariant {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch {
    return {
      variant: 'published',
      headerValue: 'published',
      version: null,
      body: null,
      variables: [],
      canaryActive: false,
    };
  }

  const published = getPublishedPrompt(norm);
  const db = getDb();
  if (!hasTable(db, 'custom_ai_prompt_canary')) {
    return {
      variant: 'published',
      headerValue: 'published',
      version: published?.version ?? null,
      body: published?.body ?? null,
      variables: published?.variables ?? [],
      canaryActive: false,
    };
  }

  const canaryRow = db
    .prepare('SELECT * FROM custom_ai_prompt_canary WHERE scope_kind = ? AND scope_id = ?')
    .get(norm.kind, norm.id) as PromptCanaryRow | undefined;

  if (
    !canaryRow ||
    canaryRow.enabled !== 1 ||
    canaryRow.candidate_version === null ||
    !published ||
    canaryRow.candidate_version === published.version
  ) {
    return {
      variant: 'published',
      headerValue: 'published',
      version: published?.version ?? null,
      body: published?.body ?? null,
      variables: published?.variables ?? [],
      canaryActive: false,
    };
  }

  let candidate: { version: number; body: string; variables: PromptVariable[] } | null = null;
  try {
    const found = getPromptVersion(norm, canaryRow.candidate_version);
    candidate = { version: found.version, body: found.body, variables: found.variables };
  } catch {
    candidate = null;
  }

  if (!candidate) {
    return {
      variant: 'published',
      headerValue: 'published',
      version: published.version,
      body: published.body,
      variables: published.variables,
      canaryActive: false,
    };
  }

  const trafficPercent = Math.min(
    EVAL_CANARY_LIMITS.maxTrafficPercent,
    Math.max(EVAL_CANARY_LIMITS.minTrafficPercent, canaryRow.traffic_percent),
  );

  const convKey = opts?.conversationId?.trim() || '';
  const userKey = opts?.endUser?.trim() || '';
  const stickyKey = convKey ? `conv:${convKey}` : userKey ? `user:${userKey}` : '';

  let chosenVariant: PromptVariantKind;
  if (stickyKey) {
    const bucket = computeStickyBucketPercent(norm, candidate.version, stickyKey);
    chosenVariant = bucket < trafficPercent ? 'canary' : 'published';
  } else {
    const picked = selectVariantByWeight(
      [
        { variant: 'canary' as const, weight: trafficPercent },
        { variant: 'published' as const, weight: 100 - trafficPercent },
      ],
      opts?.randomFn,
    );
    chosenVariant = picked.variant;
  }

  if (chosenVariant === 'canary') {
    return {
      variant: 'canary',
      headerValue: `canary(v${candidate.version})`,
      version: candidate.version,
      body: candidate.body,
      variables: candidate.variables,
      canaryActive: true,
    };
  }

  return {
    variant: 'published',
    headerValue: 'published',
    version: published.version,
    body: published.body,
    variables: published.variables,
    canaryActive: true,
  };
}

/**
 * Atomically increments live impressions, errors, and cumulative latency counters
 * for an active canary split. Safe no-op if the table or row does not exist.
 */
export function recordCanaryOutcome(
  scope: Scope,
  variant: PromptVariantKind,
  outcome: { latencyMs: number; error: boolean },
): void {
  try {
    const norm = normalizeScope(scope);
    const db = getDb();
    if (!hasTable(db, 'custom_ai_prompt_canary')) return;
    const safeLatency = Math.max(0, Math.round(Number.isFinite(outcome.latencyMs) ? outcome.latencyMs : 0));
    const errDelta = outcome.error ? 1 : 0;

    if (variant === 'canary') {
      db.prepare(
        `UPDATE custom_ai_prompt_canary
            SET canary_impressions = canary_impressions + 1,
                canary_errors = canary_errors + ?,
                canary_total_latency_ms = canary_total_latency_ms + ?
          WHERE scope_kind = ? AND scope_id = ? AND enabled = 1`,
      ).run(errDelta, safeLatency, norm.kind, norm.id);
    } else {
      db.prepare(
        `UPDATE custom_ai_prompt_canary
            SET published_impressions = published_impressions + 1,
                published_errors = published_errors + ?,
                published_total_latency_ms = published_total_latency_ms + ?
          WHERE scope_kind = ? AND scope_id = ? AND enabled = 1`,
      ).run(errDelta, safeLatency, norm.kind, norm.id);
    }
  } catch {
    /* telemetry write must never break inference responses */
  }
}

export function disableCanaryIfMatchesPublished(
  db: Db,
  scope: Scope,
  publishedVersion: number,
): void {
  if (!hasTable(db, 'custom_ai_prompt_canary')) return;
  db.prepare(
    `UPDATE custom_ai_prompt_canary
        SET enabled = 0,
            updated_at = ?
      WHERE scope_kind = ? AND scope_id = ? AND candidate_version = ? AND enabled = 1`,
  ).run(new Date().toISOString(), scope.kind, scope.id, publishedVersion);
}
