import crypto from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULT_SEMANTIC_CACHE_CONFIG,
  SEMANTIC_CACHE_LIMITS,
  type Scope,
  type ScopeKind,
  type SemanticCacheBypassReason,
  type SemanticCacheEntrySummary,
  type SemanticCacheLookupStatus,
  type SemanticCacheSettings,
  type SemanticCacheSettingsInput,
  type SemanticCacheStats,
  type Wire,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';
import { getDb } from '../../../db/index.js';
import type { Db } from '../../../db/types.js';
import { getDefaultFamily, type EmbeddingsResult } from '../../../services/embeddings.js';
import { normalizeScope } from '../scope.js';
import { getEmbeddingsRunnerForHybrid, type EmbeddingsRunner } from '../retrieval/indexer.js';
import { resolveEffectiveEmbeddingModel } from '../retrieval/settings.js';
import {
  cosineSimilarityUnit,
  decodeVectorBlob,
  encodeVectorBlob,
  l2Normalize,
} from '../retrieval/vector-store.js';
import type { EvaluatedRequestContract } from './contract.js';

export class SemanticCacheStoreError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'SemanticCacheStoreError';
    this.code = code;
    this.status = status;
  }
}

export const semanticCacheSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    semanticEnabled: z.boolean().optional(),
    minSimilarity: z
      .number()
      .finite()
      .min(SEMANTIC_CACHE_LIMITS.minAllowedSimilarity)
      .max(SEMANTIC_CACHE_LIMITS.maxAllowedSimilarity)
      .optional(),
    maxTemperature: z
      .number()
      .finite()
      .min(SEMANTIC_CACHE_LIMITS.minAllowedTemperature)
      .max(SEMANTIC_CACHE_LIMITS.maxAllowedTemperature)
      .optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(SEMANTIC_CACHE_LIMITS.minTtlSeconds)
      .max(SEMANTIC_CACHE_LIMITS.maxTtlSeconds)
      .optional(),
    maxEntries: z
      .number()
      .int()
      .min(SEMANTIC_CACHE_LIMITS.minMaxEntries)
      .max(SEMANTIC_CACHE_LIMITS.maxMaxEntries)
      .optional(),
    persistToDb: z.boolean().optional(),
    isolateByEndUser: z.boolean().optional(),
  })
  .strict();

interface SettingsRow {
  scope_kind: ScopeKind;
  scope_id: string;
  enabled: number;
  semantic_enabled: number;
  min_similarity: number;
  max_temperature: number;
  ttl_seconds: number;
  max_entries: number;
  persist_to_db: number;
  isolate_by_end_user: number;
  updated_at: string | null;
}

interface EntryRow {
  id: string;
  scope_kind: ScopeKind;
  scope_id: string;
  end_user_scope: string;
  wire: Wire;
  model: string;
  contract_hash: string;
  prompt_version_hash: string;
  exact_hash: string;
  response_json: string;
  embedding: Buffer | Uint8Array | ArrayBuffer | null;
  embedding_model: string | null;
  embedding_dims: number | null;
  tokens_saved: number;
  hit_count: number;
  created_at: string;
  expires_at: string;
}

interface MetricsRow {
  exact_hits: number;
  semantic_hits: number;
  misses: number;
  bypassed: number;
  tokens_saved_est: number;
}

interface MemoryCacheEntry {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  endUserScope: string;
  wire: Wire;
  model: string;
  contractHash: string;
  promptVersionHash: string;
  exactHash: string;
  response: Record<string, unknown>;
  responseJson: string;
  bytes: number;
  vector: Float32Array | null;
  embeddingModel: string | null;
  embeddingDims: number | null;
  tokensSaved: number;
  hitCount: number;
  createdAt: string;
  expiresAt: string;
}

interface InMemoryMetrics {
  exactHits: number;
  semanticHits: number;
  misses: number;
  bypassed: number;
  tokensSavedEst: number;
}

const SETTINGS_CACHE_TTL_MS = 5_000;

let boundDbInstance: Db | null = null;
const settingsCache = new Map<string, { settings: SemanticCacheSettings; expiresAt: number }>();
const memoryBuckets = new Map<string, Map<string, MemoryCacheEntry>>();
const memoryFallbackMetrics = new Map<string, InMemoryMetrics>();
let totalMemoryBytes = 0;
let semanticEmbedderOverride: EmbeddingsRunner | null = null;

function syncDbLifecycle(): Db | null {
  try {
    const db = getDb();
    if (boundDbInstance !== db) {
      boundDbInstance = db;
      settingsCache.clear();
      memoryBuckets.clear();
      memoryFallbackMetrics.clear();
      totalMemoryBytes = 0;
    }
    return db;
  } catch {
    return null;
  }
}

export function setSemanticCacheEmbedderForTests(fn: EmbeddingsRunner | null): void {
  semanticEmbedderOverride = fn;
}

export function resetSemanticCacheForTests(): void {
  settingsCache.clear();
  memoryBuckets.clear();
  memoryFallbackMetrics.clear();
  totalMemoryBytes = 0;
  semanticEmbedderOverride = null;
}

function isoNow(): string {
  return new Date().toISOString();
}

function roundScore(value: number): number {
  return Math.max(-1, Math.min(1, Math.round(value * 10_000) / 10_000));
}

function scopeMapKey(scope: Scope): string {
  return `${scope.kind}:${scope.id}`;
}

function hasTable(db: Db, table: string): boolean {
  try {
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
    );
  } catch {
    return false;
  }
}

function tryNormalizeScope(scope: Scope): Scope {
  try {
    return normalizeScope(scope);
  } catch (err) {
    throw new SemanticCacheStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

export function assertSemanticCacheScopeExists(scope: Scope): Scope {
  const norm = tryNormalizeScope(scope);
  const db = syncDbLifecycle();
  if (!db) {
    throw new SemanticCacheStoreError('Database is not initialized.', 'db_unavailable', 500);
  }

  if (norm.kind === 'profile') {
    const row = db.prepare('SELECT id FROM client_profiles WHERE id = ?').get(Number(norm.id));
    if (!row) {
      throw new SemanticCacheStoreError(`Profile '${norm.id}' not found.`, 'scope_not_found', 404);
    }
    return norm;
  }

  if (norm.kind === 'support_tenant') {
    if (
      !hasTable(db, 'x_support_tenants') ||
      !db.prepare('SELECT id FROM x_support_tenants WHERE id = ?').get(Number(norm.id))
    ) {
      throw new SemanticCacheStoreError(
        `Support tenant '${norm.id}' not found.`,
        'scope_not_found',
        404,
      );
    }
    return norm;
  }

  if (!hasTable(db, 'custom_ai_agents')) {
    throw new SemanticCacheStoreError(
      'Agent scope is unavailable until orchestrator tables are installed.',
      'scope_unavailable',
      409,
    );
  }
  const agent = db.prepare('SELECT id FROM custom_ai_agents WHERE id = ?').get(norm.id);
  if (!agent) {
    throw new SemanticCacheStoreError(`Agent '${norm.id}' not found.`, 'scope_not_found', 404);
  }
  return norm;
}

function rowToSettings(norm: Scope, row?: SettingsRow): SemanticCacheSettings {
  if (!row) {
    return {
      scopeKind: norm.kind,
      scopeId: norm.id,
      ...DEFAULT_SEMANTIC_CACHE_CONFIG,
      updatedAt: null,
    };
  }
  return {
    scopeKind: norm.kind,
    scopeId: norm.id,
    enabled: row.enabled === 1,
    semanticEnabled: row.semantic_enabled === 1,
    minSimilarity: row.min_similarity,
    maxTemperature: row.max_temperature,
    ttlSeconds: row.ttl_seconds,
    maxEntries: row.max_entries,
    persistToDb: row.persist_to_db === 1,
    isolateByEndUser: row.isolate_by_end_user === 1,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Fast, fail-safe settings lookup used on the inference hot path.
 * Never throws when DB or table is uninitialized; defaults to `enabled: false`.
 */
export function getSemanticCacheSettingsInternal(scope: Scope): SemanticCacheSettings {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch {
    return {
      scopeKind: scope.kind,
      scopeId: String(scope.id ?? ''),
      ...DEFAULT_SEMANTIC_CACHE_CONFIG,
      updatedAt: null,
    };
  }

  const db = syncDbLifecycle();
  const key = scopeMapKey(norm);
  const now = Date.now();
  const cached = settingsCache.get(key);
  if (cached && now < cached.expiresAt) {
    return { ...cached.settings };
  }

  if (!db || !hasTable(db, 'custom_ai_semantic_cache_settings')) {
    return rowToSettings(norm, undefined);
  }

  try {
    const row = db
      .prepare(
        'SELECT * FROM custom_ai_semantic_cache_settings WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as SettingsRow | undefined;
    const settings = rowToSettings(norm, row);
    settingsCache.set(key, { settings, expiresAt: now + SETTINGS_CACHE_TTL_MS });
    return { ...settings };
  } catch {
    return rowToSettings(norm, undefined);
  }
}

export function isSemanticCacheEnabledForScope(scope: Scope): boolean {
  return getSemanticCacheSettingsInternal(scope).enabled;
}

export function getSemanticCacheSettings(scope: Scope): SemanticCacheSettings {
  const norm = assertSemanticCacheScopeExists(scope);
  return getSemanticCacheSettingsInternal(norm);
}

function evictMemoryEntry(bucket: Map<string, MemoryCacheEntry>, exactHash: string): void {
  const existing = bucket.get(exactHash);
  if (!existing) return;
  bucket.delete(exactHash);
  totalMemoryBytes = Math.max(0, totalMemoryBytes - existing.bytes);
}

function enforceMemoryCapsForScope(norm: Scope, maxEntries: number): void {
  const key = scopeMapKey(norm);
  const bucket = memoryBuckets.get(key);
  if (bucket) {
    const now = isoNow();
    for (const [eHash, entry] of bucket) {
      if (entry.expiresAt <= now) {
        evictMemoryEntry(bucket, eHash);
      }
    }
    while (bucket.size > maxEntries) {
      const oldestKey = bucket.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      evictMemoryEntry(bucket, oldestKey);
    }
    if (bucket.size === 0) {
      memoryBuckets.delete(key);
    }
  }

  while (totalMemoryBytes > SEMANTIC_CACHE_LIMITS.maxTotalMemoryBytes && memoryBuckets.size > 0) {
    let evictedAny = false;
    for (const [bKey, bMap] of memoryBuckets) {
      const oldest = bMap.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        evictMemoryEntry(bMap, oldest);
        evictedAny = true;
        if (bMap.size === 0) memoryBuckets.delete(bKey);
        break;
      }
    }
    if (!evictedAny) break;
  }
}

export function setSemanticCacheSettings(
  scope: Scope,
  input: SemanticCacheSettingsInput,
): SemanticCacheSettings {
  const norm = assertSemanticCacheScopeExists(scope);
  const parsed = semanticCacheSettingsPatchSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') || 'settings';
    throw new SemanticCacheStoreError(
      `Invalid semantic cache settings (${field}): ${issue?.message ?? 'validation failed'}`,
      'validation_error',
      400,
    );
  }

  const db = syncDbLifecycle();
  if (!db) {
    throw new SemanticCacheStoreError('Database is not initialized.', 'db_unavailable', 500);
  }

  const prev = getSemanticCacheSettingsInternal(norm);
  const patch = parsed.data;
  const next: SemanticCacheSettings = {
    scopeKind: norm.kind,
    scopeId: norm.id,
    enabled: patch.enabled ?? prev.enabled,
    semanticEnabled: patch.semanticEnabled ?? prev.semanticEnabled,
    minSimilarity: patch.minSimilarity ?? prev.minSimilarity,
    maxTemperature: patch.maxTemperature ?? prev.maxTemperature,
    ttlSeconds: patch.ttlSeconds ?? prev.ttlSeconds,
    maxEntries: patch.maxEntries ?? prev.maxEntries,
    persistToDb: patch.persistToDb ?? prev.persistToDb,
    isolateByEndUser: patch.isolateByEndUser ?? prev.isolateByEndUser,
    updatedAt: isoNow(),
  };

  db.prepare(
    `INSERT INTO custom_ai_semantic_cache_settings (
       scope_kind, scope_id, enabled, semantic_enabled, min_similarity,
       max_temperature, ttl_seconds, max_entries, persist_to_db, isolate_by_end_user, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
       enabled = excluded.enabled,
       semantic_enabled = excluded.semantic_enabled,
       min_similarity = excluded.min_similarity,
       max_temperature = excluded.max_temperature,
       ttl_seconds = excluded.ttl_seconds,
       max_entries = excluded.max_entries,
       persist_to_db = excluded.persist_to_db,
       isolate_by_end_user = excluded.isolate_by_end_user,
       updated_at = excluded.updated_at`,
  ).run(
    norm.kind,
    norm.id,
    next.enabled ? 1 : 0,
    next.semanticEnabled ? 1 : 0,
    next.minSimilarity,
    next.maxTemperature,
    next.ttlSeconds,
    next.maxEntries,
    next.persistToDb ? 1 : 0,
    next.isolateByEndUser ? 1 : 0,
    next.updatedAt,
  );

  // If persistence was turned off, purge any previously persisted plaintext entries on disk.
  if (!next.persistToDb && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    db.prepare(
      'DELETE FROM custom_ai_semantic_cache_entries WHERE scope_kind = ? AND scope_id = ?',
    ).run(norm.kind, norm.id);
  }

  enforceMemoryCapsForScope(norm, next.maxEntries);

  const key = scopeMapKey(norm);
  settingsCache.set(key, { settings: next, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
  return { ...next };
}

function getOrCreateFallbackMetrics(norm: Scope): InMemoryMetrics {
  const key = scopeMapKey(norm);
  let m = memoryFallbackMetrics.get(key);
  if (!m) {
    m = { exactHits: 0, semanticHits: 0, misses: 0, bypassed: 0, tokensSavedEst: 0 };
    memoryFallbackMetrics.set(key, m);
  }
  return m;
}

export function recordSemanticCacheMetric(
  scope: Scope,
  kind: 'exact_hit' | 'semantic_hit' | 'miss' | 'bypassed',
  tokensSaved = 0,
): void {
  const norm = normalizeScope(scope);
  const safeTokens = Number.isFinite(tokensSaved) ? Math.max(0, Math.floor(tokensSaved)) : 0;

  const db = syncDbLifecycle();
  if (db && hasTable(db, 'custom_ai_semantic_cache_metrics')) {
    try {
      const exactDelta = kind === 'exact_hit' ? 1 : 0;
      const semDelta = kind === 'semantic_hit' ? 1 : 0;
      const missDelta = kind === 'miss' ? 1 : 0;
      const bypassDelta = kind === 'bypassed' ? 1 : 0;

      db.prepare(
        `INSERT INTO custom_ai_semantic_cache_metrics (
           scope_kind, scope_id, exact_hits, semantic_hits, misses, bypassed, tokens_saved_est, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
           exact_hits = custom_ai_semantic_cache_metrics.exact_hits + excluded.exact_hits,
           semantic_hits = custom_ai_semantic_cache_metrics.semantic_hits + excluded.semantic_hits,
           misses = custom_ai_semantic_cache_metrics.misses + excluded.misses,
           bypassed = custom_ai_semantic_cache_metrics.bypassed + excluded.bypassed,
           tokens_saved_est = custom_ai_semantic_cache_metrics.tokens_saved_est + excluded.tokens_saved_est,
           updated_at = datetime('now')`,
      ).run(norm.kind, norm.id, exactDelta, semDelta, missDelta, bypassDelta, safeTokens);
      return;
    } catch {
      // Fall back to in-memory counter if DB write fails.
    }
  }

  const mem = getOrCreateFallbackMetrics(norm);
  if (kind === 'exact_hit') mem.exactHits += 1;
  else if (kind === 'semantic_hit') mem.semanticHits += 1;
  else if (kind === 'miss') mem.misses += 1;
  else mem.bypassed += 1;
  mem.tokensSavedEst += safeTokens;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Strips internal chain-of-thought / reasoning blocks before persisting cached completions
 * so raw thinking text and provider signatures never land in unencrypted cache storage.
 */
export function sanitizeResponseForCache(response: Record<string, unknown>): Record<string, unknown> {
  const clone = structuredClone(response);

  if (Array.isArray(clone.choices)) {
    clone.choices = clone.choices.map((ch) => {
      const choice = asRecord(ch);
      if (!choice) return ch;
      const msg = asRecord(choice.message);
      if (msg) {
        delete msg.reasoning_content;
        delete msg.reasoning;
        delete msg.thought_signature;
      }
      return choice;
    });
  }

  if (Array.isArray(clone.content)) {
    clone.content = clone.content.filter((blk) => {
      const t = asRecord(blk)?.type;
      return t !== 'thinking' && t !== 'redacted_thinking';
    });
  }

  if (Array.isArray(clone.candidates)) {
    clone.candidates = clone.candidates.map((cand) => {
      const c = asRecord(cand);
      const content = c ? asRecord(c.content) : null;
      if (content && Array.isArray(content.parts)) {
        content.parts = content.parts.filter((p) => asRecord(p)?.thought !== true);
      }
      return cand;
    });
  }

  if (Array.isArray(clone.output)) {
    clone.output = clone.output.filter((item) => asRecord(item)?.type !== 'reasoning');
  }

  return clone;
}

function decodeRowVector(
  raw: Buffer | Uint8Array | ArrayBuffer | null,
  expectedDims: number | null,
): Float32Array | null {
  if (!raw || !expectedDims || expectedDims <= 0) return null;
  const bytes =
    raw instanceof Uint8Array
      ? raw
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : null;
  if (!bytes || bytes.byteLength !== expectedDims * 4) return null;
  try {
    return decodeVectorBlob(bytes);
  } catch {
    return null;
  }
}

function putInMemoryBucket(entry: MemoryCacheEntry, maxEntries: number): void {
  const key = `${entry.scopeKind}:${entry.scopeId}`;
  let bucket = memoryBuckets.get(key);

  if (entry.bytes > SEMANTIC_CACHE_LIMITS.maxMemoryEntryBytes) {
    if (bucket) {
      evictMemoryEntry(bucket, entry.exactHash);
    }
    return;
  }

  if (!bucket) {
    bucket = new Map();
    memoryBuckets.set(key, bucket);
  }

  if (bucket.has(entry.exactHash)) {
    evictMemoryEntry(bucket, entry.exactHash);
  }

  bucket.set(entry.exactHash, entry);
  totalMemoryBytes += entry.bytes;
  enforceMemoryCapsForScope({ kind: entry.scopeKind, id: entry.scopeId }, maxEntries);
}

function toEntrySummary(entry: {
  id: string;
  scopeKind: ScopeKind;
  scopeId: string;
  endUserScope: string;
  wire: Wire;
  model: string;
  contractHash: string;
  promptVersionHash: string;
  exactHash: string;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddingDims: number | null;
  tokensSaved: number;
  hitCount: number;
  createdAt: string;
  expiresAt: string;
}): SemanticCacheEntrySummary {
  return {
    id: entry.id,
    scopeKind: entry.scopeKind,
    scopeId: entry.scopeId,
    endUserScope: entry.endUserScope,
    wire: entry.wire,
    model: entry.model,
    contractHash: entry.contractHash,
    promptVersionHash: entry.promptVersionHash,
    exactHash: entry.exactHash,
    hasEmbedding: entry.hasEmbedding,
    embeddingModel: entry.embeddingModel,
    embeddingDims: entry.embeddingDims,
    tokensSaved: entry.tokensSaved,
    hitCount: entry.hitCount,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  };
}

function resolveSemanticEmbedder(scope: Scope): {
  runner: EmbeddingsRunner;
  model: string;
  dimensions: number;
} | null {
  if (semanticEmbedderOverride) {
    const resolved = resolveEffectiveEmbeddingModel(scope);
    return {
      runner: semanticEmbedderOverride,
      model: resolved.model || getDefaultFamily(),
      dimensions: resolved.dimensions,
    };
  }

  const hybridInfo = getEmbeddingsRunnerForHybrid();
  const resolved = resolveEffectiveEmbeddingModel(scope);
  if (!resolved.model || (!resolved.hasConfiguredProvider && !hybridInfo.isTestOverride)) {
    return null;
  }

  return {
    runner: hybridInfo.runner,
    model: resolved.model,
    dimensions: resolved.dimensions,
  };
}

async function runEmbeddingWithTimeout(
  runner: EmbeddingsRunner,
  model: string,
  text: string,
  dimensions: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<EmbeddingsResult | null> {
  if (signal?.aborted) return null;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const work = Promise.resolve().then(() => runner(model, [text], dimensions));
  work.catch(() => undefined);

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    if (signal) {
      onAbort = () => resolve(null);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    const res = await Promise.race([work, timeout]);
    return res;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

export interface SemanticCacheLookupOutcome {
  status: SemanticCacheLookupStatus;
  bypassReason?: SemanticCacheBypassReason;
  score: number | null;
  response: Record<string, unknown> | null;
  matchedEntry: SemanticCacheEntrySummary | null;
  semanticAvailable: boolean;
  queryVector: Float32Array | null;
  embeddingModel: string | null;
  embeddingDims: number | null;
}

export async function lookupSemanticCache(
  contract: EvaluatedRequestContract,
  settings: SemanticCacheSettings,
  opts?: { recordMetrics?: boolean; signal?: AbortSignal },
): Promise<SemanticCacheLookupOutcome> {
  const recordMetrics = opts?.recordMetrics ?? true;
  const db = syncDbLifecycle();
  const norm = contract.scope;

  if (contract.bypassed) {
    if (recordMetrics && contract.bypassReason !== 'disabled') {
      recordSemanticCacheMetric(norm, 'bypassed');
    }
    return {
      status: 'BYPASSED',
      bypassReason: contract.bypassReason,
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: false,
      queryVector: null,
      embeddingModel: null,
      embeddingDims: null,
    };
  }

  const now = isoNow();
  const bKey = scopeMapKey(norm);
  const bucket = memoryBuckets.get(bKey);

  // ── Tier 1a: In-memory LRU exact contract + query hash ──
  if (bucket) {
    const memHit = bucket.get(contract.exactHash);
    if (memHit) {
      if (
        memHit.expiresAt > now &&
        memHit.endUserScope === contract.endUserScope &&
        memHit.contractHash === contract.contractHash &&
        memHit.promptVersionHash === contract.promptVersionHash
      ) {
        // Refresh LRU order
        bucket.delete(contract.exactHash);
        bucket.set(contract.exactHash, memHit);
        if (recordMetrics) {
          memHit.hitCount += 1;
          if (settings.persistToDb && db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
            try {
              db.prepare(
                'UPDATE custom_ai_semantic_cache_entries SET hit_count = hit_count + 1 WHERE id = ?',
              ).run(memHit.id);
            } catch {
              // Fail open
            }
          }
          recordSemanticCacheMetric(norm, 'exact_hit', memHit.tokensSaved);
        }
        return {
          status: 'EXACT_HIT',
          score: 1,
          response: structuredClone(memHit.response),
          matchedEntry: toEntrySummary({
            ...memHit,
            hasEmbedding: memHit.vector !== null,
          }),
          semanticAvailable: settings.semanticEnabled,
          queryVector: null,
          embeddingModel: memHit.embeddingModel,
          embeddingDims: memHit.embeddingDims,
        };
      }
      evictMemoryEntry(bucket, contract.exactHash);
    }
  }

  // ── Tier 1b: SQLite exact contract + query hash ──
  if (settings.persistToDb && db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    try {
      const row = db
        .prepare(
          `SELECT * FROM custom_ai_semantic_cache_entries
            WHERE scope_kind = ?
              AND scope_id = ?
              AND end_user_scope = ?
              AND contract_hash = ?
              AND prompt_version_hash = ?
              AND exact_hash = ?
              AND expires_at > ?
            LIMIT 1`,
        )
        .get(
          norm.kind,
          norm.id,
          contract.endUserScope,
          contract.contractHash,
          contract.promptVersionHash,
          contract.exactHash,
          now,
        ) as EntryRow | undefined;

      if (row) {
        const parsed = asRecord(JSON.parse(row.response_json));
        if (parsed) {
          const nextHitCount = recordMetrics ? row.hit_count + 1 : row.hit_count;
          if (recordMetrics) {
            db.prepare(
              'UPDATE custom_ai_semantic_cache_entries SET hit_count = hit_count + 1 WHERE id = ?',
            ).run(row.id);
            recordSemanticCacheMetric(norm, 'exact_hit', row.tokens_saved);
          }

          const decodedVec = decodeRowVector(row.embedding, row.embedding_dims);
          const promoted: MemoryCacheEntry = {
            id: row.id,
            scopeKind: row.scope_kind,
            scopeId: row.scope_id,
            endUserScope: row.end_user_scope,
            wire: row.wire,
            model: row.model,
            contractHash: row.contract_hash,
            promptVersionHash: row.prompt_version_hash,
            exactHash: row.exact_hash,
            response: parsed,
            responseJson: row.response_json,
            bytes: Buffer.byteLength(row.response_json, 'utf8'),
            vector: decodedVec,
            embeddingModel: row.embedding_model,
            embeddingDims: row.embedding_dims,
            tokensSaved: row.tokens_saved,
            hitCount: nextHitCount,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
          };
          putInMemoryBucket(promoted, settings.maxEntries);

          return {
            status: 'EXACT_HIT',
            score: 1,
            response: structuredClone(parsed),
            matchedEntry: toEntrySummary({
              ...promoted,
              hasEmbedding: decodedVec !== null,
            }),
            semanticAvailable: settings.semanticEnabled,
            queryVector: null,
            embeddingModel: row.embedding_model,
            embeddingDims: row.embedding_dims,
          };
        }
      }
    } catch {
      // Fail open on DB read/parse errors
    }
  }

  // ── Tier 2: Semantic Vector Similarity Lookup ──
  if (!settings.semanticEnabled) {
    if (recordMetrics) recordSemanticCacheMetric(norm, 'miss');
    return {
      status: 'MISS',
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: false,
      queryVector: null,
      embeddingModel: null,
      embeddingDims: null,
    };
  }

  const embedderSpec = resolveSemanticEmbedder(norm);
  if (!embedderSpec) {
    if (recordMetrics) recordSemanticCacheMetric(norm, 'miss');
    return {
      status: 'MISS',
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: false,
      queryVector: null,
      embeddingModel: null,
      embeddingDims: null,
    };
  }

  const embedResult = await runEmbeddingWithTimeout(
    embedderSpec.runner,
    embedderSpec.model,
    contract.semanticQueryText,
    embedderSpec.dimensions,
    SEMANTIC_CACHE_LIMITS.embeddingTimeoutMs,
    opts?.signal,
  );

  const rawVec = embedResult?.vectors?.[0];
  if (!rawVec || !Array.isArray(rawVec) || rawVec.length === 0) {
    if (recordMetrics) recordSemanticCacheMetric(norm, 'miss');
    return {
      status: 'MISS',
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: false,
      queryVector: null,
      embeddingModel: null,
      embeddingDims: null,
    };
  }

  let queryVec: Float32Array;
  try {
    queryVec = l2Normalize(rawVec);
  } catch {
    if (recordMetrics) recordSemanticCacheMetric(norm, 'miss');
    return {
      status: 'MISS',
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: false,
      queryVector: null,
      embeddingModel: null,
      embeddingDims: null,
    };
  }

  // Verify non-zero vector norm so an all-zeros vector never spuriously matches minSimilarity: 0
  let nonZero = false;
  for (let i = 0; i < queryVec.length; i++) {
    if (queryVec[i] !== 0) {
      nonZero = true;
      break;
    }
  }
  const effectiveModel = embedResult?.family || embedResult?.modelId || embedderSpec.model;
  const effectiveDims = queryVec.length;

  if (!nonZero) {
    if (recordMetrics) recordSemanticCacheMetric(norm, 'miss');
    return {
      status: 'MISS',
      score: null,
      response: null,
      matchedEntry: null,
      semanticAvailable: true,
      queryVector: null,
      embeddingModel: effectiveModel,
      embeddingDims: effectiveDims,
    };
  }

  // Collect candidate entries scoped strictly by (scope_kind, scope_id, end_user_scope, contract_hash, prompt_version_hash)
  const candidatesByExactHash = new Map<string, MemoryCacheEntry>();

  if (bucket) {
    for (const [eHash, entry] of bucket) {
      if (entry.expiresAt <= now) {
        evictMemoryEntry(bucket, eHash);
        continue;
      }
      if (
        entry.endUserScope === contract.endUserScope &&
        entry.contractHash === contract.contractHash &&
        entry.promptVersionHash === contract.promptVersionHash &&
        entry.vector !== null &&
        entry.embeddingDims === effectiveDims &&
        entry.embeddingModel === effectiveModel
      ) {
        candidatesByExactHash.set(eHash, entry);
      }
    }
  }

  if (settings.persistToDb && db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    try {
      const rows = db
        .prepare(
          `SELECT * FROM custom_ai_semantic_cache_entries
            WHERE scope_kind = ?
              AND scope_id = ?
              AND end_user_scope = ?
              AND contract_hash = ?
              AND prompt_version_hash = ?
              AND expires_at > ?
              AND embedding IS NOT NULL
              AND embedding_dims = ?
              AND embedding_model = ?`,
        )
        .all(
          norm.kind,
          norm.id,
          contract.endUserScope,
          contract.contractHash,
          contract.promptVersionHash,
          now,
          effectiveDims,
          effectiveModel,
        ) as EntryRow[];

      for (const row of rows) {
        if (candidatesByExactHash.has(row.exact_hash)) continue;
        const vec = decodeRowVector(row.embedding, row.embedding_dims);
        if (!vec) continue;
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = asRecord(JSON.parse(row.response_json));
        } catch {
          parsed = null;
        }
        if (!parsed) continue;
        candidatesByExactHash.set(row.exact_hash, {
          id: row.id,
          scopeKind: row.scope_kind,
          scopeId: row.scope_id,
          endUserScope: row.end_user_scope,
          wire: row.wire,
          model: row.model,
          contractHash: row.contract_hash,
          promptVersionHash: row.prompt_version_hash,
          exactHash: row.exact_hash,
          response: parsed,
          responseJson: row.response_json,
          bytes: Buffer.byteLength(row.response_json, 'utf8'),
          vector: vec,
          embeddingModel: row.embedding_model,
          embeddingDims: row.embedding_dims,
          tokensSaved: row.tokens_saved,
          hitCount: row.hit_count,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
        });
      }
    } catch {
      // Fail open on SQLite scan error
    }
  }

  let bestEntry: MemoryCacheEntry | null = null;
  let bestScore = -2;

  for (const cand of candidatesByExactHash.values()) {
    if (!cand.vector || cand.vector.length !== effectiveDims) continue;
    const score = cosineSimilarityUnit(cand.vector, queryVec);
    if (
      score > bestScore ||
      (score === bestScore && bestEntry && cand.createdAt > bestEntry.createdAt)
    ) {
      bestScore = score;
      bestEntry = cand;
    }
  }

  if (bestEntry && bestScore >= settings.minSimilarity) {
    const rounded = roundScore(bestScore);
    if (recordMetrics) {
      bestEntry.hitCount += 1;
      if (settings.persistToDb && db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
        try {
          db.prepare(
            'UPDATE custom_ai_semantic_cache_entries SET hit_count = hit_count + 1 WHERE id = ?',
          ).run(bestEntry.id);
        } catch {
          // Fail open
        }
      }
      recordSemanticCacheMetric(norm, 'semantic_hit', bestEntry.tokensSaved);
    }
    putInMemoryBucket(bestEntry, settings.maxEntries);

    return {
      status: 'SEMANTIC_HIT',
      score: rounded,
      response: structuredClone(bestEntry.response),
      matchedEntry: toEntrySummary({
        ...bestEntry,
        hasEmbedding: true,
      }),
      semanticAvailable: true,
      queryVector: queryVec,
      embeddingModel: effectiveModel,
      embeddingDims: effectiveDims,
    };
  }

  if (recordMetrics) {
    recordSemanticCacheMetric(norm, 'miss');
  }

  return {
    status: 'MISS',
    score: bestEntry ? roundScore(bestScore) : null,
    response: null,
    matchedEntry: null,
    semanticAvailable: true,
    queryVector: queryVec,
    embeddingModel: effectiveModel,
    embeddingDims: effectiveDims,
  };
}

export interface StoreSemanticCacheInput {
  contract: EvaluatedRequestContract;
  settings: SemanticCacheSettings;
  response: Record<string, unknown>;
  tokensSaved: number;
  queryVector?: Float32Array | null;
  embeddingModel?: string | null;
  embeddingDims?: number | null;
}

export function storeSemanticCacheEntry(input: StoreSemanticCacheInput): boolean {
  if (input.contract.bypassed || !input.settings.enabled) return false;

  const sanitized = sanitizeResponseForCache(input.response);
  let responseJson: string;
  try {
    responseJson = JSON.stringify(sanitized);
  } catch {
    return false;
  }

  const bytes = Buffer.byteLength(responseJson, 'utf8');
  if (bytes > SEMANTIC_CACHE_LIMITS.maxDbEntryBytes) {
    return false;
  }

  const norm = input.contract.scope;
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + input.settings.ttlSeconds * 1000).toISOString();
  const safeTokens = Number.isFinite(input.tokensSaved)
    ? Math.max(0, Math.floor(input.tokensSaved))
    : 0;

  let normalizedVec: Float32Array | null = null;
  let vectorBlob: Buffer | null = null;
  let embModel: string | null = null;
  let embDims: number | null = null;

  if (
    input.queryVector &&
    input.queryVector.length > 0 &&
    input.embeddingModel &&
    input.embeddingDims === input.queryVector.length
  ) {
    try {
      normalizedVec = l2Normalize(input.queryVector);
      vectorBlob = encodeVectorBlob(normalizedVec);
      embModel = input.embeddingModel;
      embDims = normalizedVec.length;
    } catch {
      normalizedVec = null;
      vectorBlob = null;
      embModel = null;
      embDims = null;
    }
  }

  const id = crypto.randomUUID();
  const memEntry: MemoryCacheEntry = {
    id,
    scopeKind: norm.kind,
    scopeId: norm.id,
    endUserScope: input.contract.endUserScope,
    wire: input.contract.wire,
    model: input.contract.model,
    contractHash: input.contract.contractHash,
    promptVersionHash: input.contract.promptVersionHash,
    exactHash: input.contract.exactHash,
    response: sanitized,
    responseJson,
    bytes,
    vector: normalizedVec,
    embeddingModel: embModel,
    embeddingDims: embDims,
    tokensSaved: safeTokens,
    hitCount: 0,
    createdAt,
    expiresAt,
  };

  putInMemoryBucket(memEntry, input.settings.maxEntries);

  const db = syncDbLifecycle();
  if (input.settings.persistToDb && db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    try {
      db.transaction(() => {
        db.prepare(
          `INSERT INTO custom_ai_semantic_cache_entries (
             id, scope_kind, scope_id, end_user_scope, wire, model,
             contract_hash, prompt_version_hash, exact_hash, response_json,
             embedding, embedding_model, embedding_dims,
             tokens_saved, hit_count, created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(scope_kind, scope_id, end_user_scope, contract_hash, prompt_version_hash, exact_hash)
           DO UPDATE SET
             id = excluded.id,
             wire = excluded.wire,
             model = excluded.model,
             response_json = excluded.response_json,
             embedding = excluded.embedding,
             embedding_model = excluded.embedding_model,
             embedding_dims = excluded.embedding_dims,
             tokens_saved = excluded.tokens_saved,
             hit_count = 0,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at`,
        ).run(
          id,
          norm.kind,
          norm.id,
          input.contract.endUserScope,
          input.contract.wire,
          input.contract.model,
          input.contract.contractHash,
          input.contract.promptVersionHash,
          input.contract.exactHash,
          responseJson,
          vectorBlob,
          embModel,
          embDims,
          safeTokens,
          createdAt,
          expiresAt,
        );

        // Prune expired entries for this scope first, then enforce maxEntries cap
        db.prepare(
          'DELETE FROM custom_ai_semantic_cache_entries WHERE scope_kind = ? AND scope_id = ? AND expires_at <= ?',
        ).run(norm.kind, norm.id, createdAt);

        const countRow = db
          .prepare(
            'SELECT COUNT(*) AS cnt FROM custom_ai_semantic_cache_entries WHERE scope_kind = ? AND scope_id = ?',
          )
          .get(norm.kind, norm.id) as { cnt: number };
        const excess = (countRow?.cnt ?? 0) - input.settings.maxEntries;
        if (excess > 0) {
          db.prepare(
            `DELETE FROM custom_ai_semantic_cache_entries
              WHERE id IN (
                SELECT id FROM custom_ai_semantic_cache_entries
                 WHERE scope_kind = ? AND scope_id = ?
                 ORDER BY created_at ASC
                 LIMIT ?
              )`,
          ).run(norm.kind, norm.id, excess);
        }
      })();
    } catch {
      // Fail open: memory entry still active
    }
  }

  return true;
}

export function getSemanticCacheStats(scope: Scope): {
  stats: SemanticCacheStats;
  recentEntries: SemanticCacheEntrySummary[];
} {
  const norm = assertSemanticCacheScopeExists(scope);
  const db = syncDbLifecycle();
  const now = isoNow();
  const key = scopeMapKey(norm);

  const bucket = memoryBuckets.get(key);
  const distinctExactHashes = new Set<string>();
  const summaryMap = new Map<string, SemanticCacheEntrySummary>();

  let memoryEntriesCount = 0;
  if (bucket) {
    for (const [eHash, entry] of bucket) {
      if (entry.expiresAt <= now) {
        evictMemoryEntry(bucket, eHash);
        continue;
      }
      memoryEntriesCount += 1;
      distinctExactHashes.add(eHash);
      summaryMap.set(
        eHash,
        toEntrySummary({
          ...entry,
          hasEmbedding: entry.vector !== null,
        }),
      );
    }
  }

  let exactHits = 0;
  let semanticHits = 0;
  let misses = 0;
  let bypassed = 0;
  let tokensSavedEst = 0;

  if (db && hasTable(db, 'custom_ai_semantic_cache_metrics')) {
    const mRow = db
      .prepare(
        'SELECT exact_hits, semantic_hits, misses, bypassed, tokens_saved_est FROM custom_ai_semantic_cache_metrics WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as MetricsRow | undefined;
    if (mRow) {
      exactHits = Number(mRow.exact_hits) || 0;
      semanticHits = Number(mRow.semantic_hits) || 0;
      misses = Number(mRow.misses) || 0;
      bypassed = Number(mRow.bypassed) || 0;
      tokensSavedEst = Number(mRow.tokens_saved_est) || 0;
    }
  } else {
    const mem = memoryFallbackMetrics.get(key);
    if (mem) {
      exactHits = mem.exactHits;
      semanticHits = mem.semanticHits;
      misses = mem.misses;
      bypassed = mem.bypassed;
      tokensSavedEst = mem.tokensSavedEst;
    }
  }

  let dbEntriesCount = 0;
  if (db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    const countRow = db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM custom_ai_semantic_cache_entries WHERE scope_kind = ? AND scope_id = ? AND expires_at > ?',
      )
      .get(norm.kind, norm.id, now) as { cnt: number } | undefined;
    dbEntriesCount = Number(countRow?.cnt) || 0;

    const recentRows = db
      .prepare(
        `SELECT id, scope_kind, scope_id, end_user_scope, wire, model,
                contract_hash, prompt_version_hash, exact_hash,
                embedding IS NOT NULL AS has_emb, embedding_model, embedding_dims,
                tokens_saved, hit_count, created_at, expires_at
           FROM custom_ai_semantic_cache_entries
          WHERE scope_kind = ? AND scope_id = ? AND expires_at > ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(
        norm.kind,
        norm.id,
        now,
        SEMANTIC_CACHE_LIMITS.recentEntriesPreviewLimit,
      ) as Array<{
      id: string;
      scope_kind: ScopeKind;
      scope_id: string;
      end_user_scope: string;
      wire: Wire;
      model: string;
      contract_hash: string;
      prompt_version_hash: string;
      exact_hash: string;
      has_emb: number;
      embedding_model: string | null;
      embedding_dims: number | null;
      tokens_saved: number;
      hit_count: number;
      created_at: string;
      expires_at: string;
    }>;

    for (const r of recentRows) {
      distinctExactHashes.add(r.exact_hash);
      summaryMap.set(r.exact_hash, {
        id: r.id,
        scopeKind: r.scope_kind,
        scopeId: r.scope_id,
        endUserScope: r.end_user_scope,
        wire: r.wire,
        model: r.model,
        contractHash: r.contract_hash,
        promptVersionHash: r.prompt_version_hash,
        exactHash: r.exact_hash,
        hasEmbedding: r.has_emb === 1,
        embeddingModel: r.embedding_model,
        embeddingDims: r.embedding_dims,
        tokensSaved: r.tokens_saved,
        hitCount: r.hit_count,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      });
    }
  }

  const entriesCount = Math.max(dbEntriesCount, distinctExactHashes.size);
  const totalLookups = exactHits + semanticHits + misses;
  const hitRate =
    totalLookups > 0 ? roundScore((exactHits + semanticHits) / totalLookups) : 0;

  const recentEntries = Array.from(summaryMap.values())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, SEMANTIC_CACHE_LIMITS.recentEntriesPreviewLimit);

  return {
    stats: {
      exactHits,
      semanticHits,
      misses,
      bypassed,
      tokensSavedEst,
      entriesCount,
      memoryEntriesCount,
      hitRate,
    },
    recentEntries,
  };
}

export function flushSemanticCacheScope(
  scope: Scope,
  opts?: { resetMetrics?: boolean; model?: string; endUser?: string },
): { deletedEntries: number; metricsReset: boolean } {
  const norm = assertSemanticCacheScopeExists(scope);
  const db = syncDbLifecycle();
  const key = scopeMapKey(norm);
  const modelFilter = opts?.model?.trim();
  const endUserFilter = opts?.endUser?.trim();
  const targetEndUserScope = endUserFilter ? `user:${endUserFilter}` : undefined;

  let memDeleted = 0;
  const bucket = memoryBuckets.get(key);
  if (bucket) {
    for (const [eHash, entry] of [...bucket.entries()]) {
      if (modelFilter && entry.model !== modelFilter) continue;
      if (targetEndUserScope !== undefined && entry.endUserScope !== targetEndUserScope) continue;
      evictMemoryEntry(bucket, eHash);
      memDeleted += 1;
    }
    if (bucket.size === 0) {
      memoryBuckets.delete(key);
    }
  }

  let dbDeleted = 0;
  if (db && hasTable(db, 'custom_ai_semantic_cache_entries')) {
    const clauses = ['scope_kind = ?', 'scope_id = ?'];
    const params: Array<string | number> = [norm.kind, norm.id];
    if (modelFilter) {
      clauses.push('model = ?');
      params.push(modelFilter);
    }
    if (targetEndUserScope !== undefined) {
      clauses.push('end_user_scope = ?');
      params.push(targetEndUserScope);
    }
    const res = db
      .prepare(`DELETE FROM custom_ai_semantic_cache_entries WHERE ${clauses.join(' AND ')}`)
      .run(...params);
    dbDeleted = res.changes || 0;
  }

  const metricsReset = opts?.resetMetrics === true;
  if (metricsReset) {
    memoryFallbackMetrics.delete(key);
    if (db && hasTable(db, 'custom_ai_semantic_cache_metrics')) {
      db.prepare(
        `UPDATE custom_ai_semantic_cache_metrics
            SET exact_hits = 0,
                semantic_hits = 0,
                misses = 0,
                bypassed = 0,
                tokens_saved_est = 0,
                updated_at = datetime('now')
          WHERE scope_kind = ? AND scope_id = ?`,
      ).run(norm.kind, norm.id);
    }
  }

  return {
    deletedEntries: Math.max(dbDeleted, memDeleted),
    metricsReset,
  };
}
