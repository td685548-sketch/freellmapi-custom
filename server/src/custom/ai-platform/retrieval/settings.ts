import { z } from 'zod';
import {
  RETRIEVAL_LIMITS,
  type EmbeddingUsagePurpose,
  type RetrievalEmbeddingModelOption,
  type RetrievalMode,
  type RetrievalSettingsInput,
  type RetrievalSettingsView,
  type RetrievalUsageResponse,
  type RetrievalUsageRow,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb } from '../../../db/index.js';
import {
  getDefaultFamily,
  listEmbeddingModels,
  resolveFamily,
} from '../../../services/embeddings.js';
import { normalizeScope } from '../scope.js';
import { invalidateVectorCache } from './vector-store.js';

export class RetrievalStoreError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'RetrievalStoreError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface RetrievalSettingsRow {
  scope_kind: ScopeKind;
  scope_id: string;
  mode: RetrievalMode;
  embedding_model: string | null;
  dimensions: number;
  top_k: number;
  min_score: number;
  citations_enabled: number;
  index_generation: number;
  updated_at: string | null;
}

const DAY_MS = 86_400_000;

const retrievalSettingsInputSchema = z
  .object({
    mode: z.enum(['keyword', 'semantic', 'hybrid']).optional(),
    embeddingModel: z
      .string()
      .trim()
      .max(RETRIEVAL_LIMITS.maxModelNameChars)
      .nullable()
      .optional(),
    dimensions: z
      .number()
      .int()
      .min(RETRIEVAL_LIMITS.minDimensions)
      .max(RETRIEVAL_LIMITS.maxDimensions)
      .optional(),
    topK: z.number().int().min(1).max(RETRIEVAL_LIMITS.maxTopK).optional(),
    minScore: z.number().finite().min(0).max(1).optional(),
    citationsEnabled: z.boolean().optional(),
  })
  .strict();

function hasTable(table: string): boolean {
  return Boolean(
    getDb()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function tryNormalizeScope(scope: Scope): Scope {
  try {
    return normalizeScope(scope);
  } catch (err) {
    throw new RetrievalStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

export function validateScopeExists(scope: Scope): boolean {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch {
    return false;
  }

  const db = getDb();
  if (norm.kind === 'profile') {
    return Boolean(
      db.prepare('SELECT 1 FROM client_profiles WHERE id = ?').get(Number(norm.id)),
    );
  }
  if (norm.kind === 'support_tenant') {
    return (
      hasTable('x_support_tenants') &&
      Boolean(db.prepare('SELECT 1 FROM x_support_tenants WHERE id = ?').get(Number(norm.id)))
    );
  }
  return (
    hasTable('custom_ai_agents') &&
    Boolean(db.prepare('SELECT 1 FROM custom_ai_agents WHERE id = ?').get(norm.id))
  );
}

export function assertScopeExists(scope: Scope): Scope {
  const norm = tryNormalizeScope(scope);
  const db = getDb();

  if (norm.kind === 'agent') {
    if (!hasTable('custom_ai_agents')) {
      throw new RetrievalStoreError(
        'Agent scope is unavailable until orchestrator (US7) is installed.',
        'scope_unavailable',
        409,
      );
    }
    const agent = db.prepare('SELECT id FROM custom_ai_agents WHERE id = ?').get(norm.id);
    if (!agent) {
      throw new RetrievalStoreError(`Agent '${norm.id}' not found.`, 'scope_not_found', 404);
    }
    return norm;
  }

  if (norm.kind === 'profile') {
    const profile = db
      .prepare('SELECT id FROM client_profiles WHERE id = ?')
      .get(Number(norm.id));
    if (!profile) {
      throw new RetrievalStoreError(`Profile '${norm.id}' not found.`, 'scope_not_found', 404);
    }
    return norm;
  }

  if (
    !hasTable('x_support_tenants') ||
    !db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(Number(norm.id))
  ) {
    throw new RetrievalStoreError(
      `Support tenant '${norm.id}' not found.`,
      'scope_not_found',
      404,
    );
  }
  return norm;
}

function rowToSettingsState(
  norm: Scope,
  row: RetrievalSettingsRow | undefined,
): { settings: RetrievalSettingsView; indexGeneration: number } {
  return {
    settings: {
      scopeKind: norm.kind,
      scopeId: norm.id,
      mode: row?.mode ?? RETRIEVAL_LIMITS.defaultMode,
      embeddingModel: row?.embedding_model ?? null,
      dimensions: row?.dimensions ?? RETRIEVAL_LIMITS.defaultDimensions,
      topK: row?.top_k ?? RETRIEVAL_LIMITS.defaultTopK,
      minScore: row?.min_score ?? RETRIEVAL_LIMITS.defaultMinScore,
      citationsEnabled: row
        ? row.citations_enabled === 1
        : RETRIEVAL_LIMITS.defaultCitationsEnabled,
      updatedAt: row?.updated_at ?? null,
    },
    indexGeneration: row?.index_generation ?? 1,
  };
}

function readSettingsRow(norm: Scope): RetrievalSettingsRow | undefined {
  return getDb()
    .prepare(
      'SELECT * FROM custom_ai_retrieval_settings WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as RetrievalSettingsRow | undefined;
}

export function getRetrievalSettingsInternal(scope: Scope): {
  settings: RetrievalSettingsView;
  indexGeneration: number;
} {
  const norm = tryNormalizeScope(scope);
  return rowToSettingsState(norm, readSettingsRow(norm));
}

export function getRetrievalSettings(scope: Scope): RetrievalSettingsView {
  const norm = assertScopeExists(scope);
  return getRetrievalSettingsInternal(norm).settings;
}

function resolveEffectiveFamilyName(model: string | null): string {
  if (!model || model === 'auto') {
    return getDefaultFamily();
  }
  return resolveFamily(model) ?? model;
}

export function setRetrievalSettings(
  scope: Scope,
  input: RetrievalSettingsInput,
): {
  settings: RetrievalSettingsView;
  indexGeneration: number;
  modelOrDimsChanged: boolean;
  previousSettings: RetrievalSettingsView;
} {
  const norm = assertScopeExists(scope);
  const parsed = retrievalSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'settings';
    throw new RetrievalStoreError(
      `Invalid retrieval settings (${field}): ${issue?.message ?? 'validation failed'}`,
      'validation_error',
      400,
    );
  }

  const data = parsed.data;
  const allModels = listEmbeddingModels();
  const db = getDb();

  const result = db.transaction(() => {
    const prevState = getRetrievalSettingsInternal(norm);
    const previousSettings = prevState.settings;

    const nextMode = data.mode ?? previousSettings.mode;
    const nextTopK = data.topK ?? previousSettings.topK;
    const nextMinScore = data.minScore ?? previousSettings.minScore;
    const nextCitationsEnabled =
      data.citationsEnabled ?? previousSettings.citationsEnabled;
    const nextModel =
      data.embeddingModel === undefined
        ? previousSettings.embeddingModel
        : data.embeddingModel === ''
          ? null
          : data.embeddingModel;

    let maxFamilyDims: number | null = null;
    if (nextModel !== null && nextModel !== 'auto') {
      const resolvedFamily = resolveFamily(nextModel);
      if (allModels.length > 0 && !resolvedFamily) {
        throw new RetrievalStoreError(
          `Unknown embedding model '${nextModel}'.`,
          'invalid_embedding_model',
          400,
        );
      }
      const targetFamily = resolvedFamily ?? nextModel;
      const familyRows = allModels.filter((r) => r.family === targetFamily);
      if (familyRows.length > 0) {
        maxFamilyDims = Math.max(...familyRows.map((r) => r.dimensions));
      }
    }

    let nextDimensions = data.dimensions ?? previousSettings.dimensions;
    if (maxFamilyDims !== null && nextDimensions > maxFamilyDims) {
      if (data.dimensions !== undefined) {
        throw new RetrievalStoreError(
          `Dimensions ${nextDimensions} exceed maximum ${maxFamilyDims} for embedding model '${nextModel}'.`,
          'invalid_dimensions',
          400,
        );
      }
      nextDimensions = maxFamilyDims;
    }

    const prevEffectiveModel = resolveEffectiveFamilyName(previousSettings.embeddingModel);
    const nextEffectiveModel = resolveEffectiveFamilyName(nextModel);
    const modelOrDimsChanged =
      prevEffectiveModel !== nextEffectiveModel ||
      previousSettings.dimensions !== nextDimensions;

    const nextGeneration = modelOrDimsChanged
      ? prevState.indexGeneration + 1
      : prevState.indexGeneration;
    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO custom_ai_retrieval_settings (
        scope_kind, scope_id, mode, embedding_model, dimensions,
        top_k, min_score, citations_enabled, index_generation, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
        mode = excluded.mode,
        embedding_model = excluded.embedding_model,
        dimensions = excluded.dimensions,
        top_k = excluded.top_k,
        min_score = excluded.min_score,
        citations_enabled = excluded.citations_enabled,
        index_generation = excluded.index_generation,
        updated_at = excluded.updated_at`,
    ).run(
      norm.kind,
      norm.id,
      nextMode,
      nextModel,
      nextDimensions,
      nextTopK,
      nextMinScore,
      nextCitationsEnabled ? 1 : 0,
      nextGeneration,
      nowIso,
    );

    const saved = getRetrievalSettingsInternal(norm);
    return {
      settings: saved.settings,
      indexGeneration: saved.indexGeneration,
      modelOrDimsChanged,
      previousSettings,
    };
  })();

  if (result.modelOrDimsChanged) {
    invalidateVectorCache(norm);
  }
  return result;
}

export function bumpIndexGeneration(scope: Scope): number {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  const nextGen = db.transaction(() => {
    // New rows start at 2 because an absent row implicitly represents generation 1.
    db.prepare(
      `INSERT INTO custom_ai_retrieval_settings (scope_kind, scope_id, index_generation, updated_at)
       VALUES (?, ?, 2, datetime('now'))
       ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
         index_generation = custom_ai_retrieval_settings.index_generation + 1,
         updated_at = datetime('now')`,
    ).run(norm.kind, norm.id);
    const row = db
      .prepare(
        'SELECT index_generation FROM custom_ai_retrieval_settings WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as { index_generation: number };
    return row.index_generation;
  })();

  invalidateVectorCache(norm);
  return nextGen;
}

export function getIndexGeneration(scope: Scope): number {
  const norm = tryNormalizeScope(scope);
  const row = getDb()
    .prepare(
      'SELECT index_generation FROM custom_ai_retrieval_settings WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as { index_generation: number } | undefined;
  return row?.index_generation ?? 1;
}

export function listAvailableRetrievalModels(): RetrievalEmbeddingModelOption[] {
  const seen = new Set<string>();
  const options: RetrievalEmbeddingModelOption[] = [];
  for (const row of listEmbeddingModels()) {
    if (row.enabled !== 1 || seen.has(row.family)) continue;
    seen.add(row.family);
    options.push({
      family: row.family,
      modelId: row.model_id,
      displayName: row.display_name,
      dimensions: row.dimensions,
      platform: row.platform,
    });
  }
  return options;
}

function resolveEmbeddingModelDetails(scope: Scope): {
  requestedModel: string | null;
  resolvedModel: string;
  dimensions: number;
  hasEnabledProvider: boolean;
  allModelsCount: number;
} {
  const { settings } = getRetrievalSettingsInternal(scope);
  const requestedModel = settings.embeddingModel ?? null;
  const allModels = listEmbeddingModels();
  const enabledModels = allModels.filter((r) => r.enabled === 1);
  const resolvedModel = resolveEffectiveFamilyName(requestedModel);
  const hasEnabledProvider = enabledModels.some((r) => r.family === resolvedModel);
  return {
    requestedModel,
    resolvedModel,
    dimensions: settings.dimensions,
    hasEnabledProvider,
    allModelsCount: allModels.length,
  };
}

export function resolveScopeEmbeddingConfig(scope: Scope): {
  model: string | null;
  dimensions: number;
  modelConfigured: boolean;
} {
  const info = resolveEmbeddingModelDetails(scope);
  const explicit = Boolean(info.requestedModel && info.requestedModel !== 'auto');
  const modelConfigured =
    info.hasEnabledProvider || (explicit && info.allModelsCount === 0);
  return {
    model: modelConfigured ? info.resolvedModel : null,
    dimensions: info.dimensions,
    modelConfigured,
  };
}

export function resolveEffectiveEmbeddingModel(scope: Scope): {
  model: string | null;
  dimensions: number;
  hasConfiguredProvider: boolean;
} {
  const info = resolveEmbeddingModelDetails(scope);
  const explicit = Boolean(info.requestedModel && info.requestedModel !== 'auto');
  const model =
    info.hasEnabledProvider || (explicit && info.allModelsCount === 0)
      ? info.resolvedModel
      : null;
  return {
    model,
    dimensions: info.dimensions,
    hasConfiguredProvider: info.hasEnabledProvider,
  };
}

export function recordEmbeddingUsage(
  scope: Scope,
  model: string,
  purpose: EmbeddingUsagePurpose,
  inputTokens: number,
): void {
  const norm = tryNormalizeScope(scope);
  const day = new Date().toISOString().slice(0, 10);
  const safeTokens = Number.isFinite(inputTokens)
    ? Math.max(0, Math.floor(inputTokens))
    : 0;
  const modelName = model.trim() || 'unknown';

  getDb()
    .prepare(
      `INSERT INTO custom_ai_embedding_usage (
        day, scope_kind, scope_id, model, purpose, input_tokens, requests
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(day, scope_kind, scope_id, model, purpose) DO UPDATE SET
        input_tokens = custom_ai_embedding_usage.input_tokens + excluded.input_tokens,
        requests = custom_ai_embedding_usage.requests + 1`,
    )
    .run(day, norm.kind, norm.id, modelName, purpose, safeTokens);
}

export function getRetrievalUsage(opts?: {
  days?: number;
  scope?: Scope;
}): RetrievalUsageResponse {
  const rawDays = opts?.days ?? 30;
  const days = Number.isFinite(rawDays)
    ? Math.min(365, Math.max(1, Math.floor(rawDays)))
    : 30;
  const nowMs = Date.now();
  const to = new Date(nowMs).toISOString().slice(0, 10);
  const from = new Date(nowMs - (days - 1) * DAY_MS).toISOString().slice(0, 10);

  const norm = opts?.scope ? tryNormalizeScope(opts.scope) : null;
  const db = getDb();
  const sql = `
    SELECT day,
           scope_kind AS scopeKind,
           scope_id AS scopeId,
           model,
           purpose,
           input_tokens AS inputTokens,
           requests
      FROM custom_ai_embedding_usage
     WHERE day >= ? AND day <= ?${norm ? ' AND scope_kind = ? AND scope_id = ?' : ''}
     ORDER BY day DESC, scope_kind ASC, scope_id ASC, model ASC, purpose ASC
  `;
  const rows = (
    norm
      ? db.prepare(sql).all(from, to, norm.kind, norm.id)
      : db.prepare(sql).all(from, to)
  ) as RetrievalUsageRow[];

  let inputTokens = 0;
  let requests = 0;
  let indexTokens = 0;
  let queryTokens = 0;
  for (const row of rows) {
    inputTokens += row.inputTokens;
    requests += row.requests;
    if (row.purpose === 'index') indexTokens += row.inputTokens;
    else if (row.purpose === 'query') queryTokens += row.inputTokens;
  }

  return {
    from,
    to,
    days,
    totals: {
      inputTokens,
      requests,
      indexTokens,
      queryTokens,
    },
    rows,
  };
}
