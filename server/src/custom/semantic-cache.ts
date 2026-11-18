import crypto from 'node:crypto';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import {
  cacheActive,
  cacheMaxEntries,
  cachePersistencePreference,
  cacheTtlMs,
  isCacheableTemperature,
  type CacheDirective,
} from '../services/cache.js';
import { getDefaultFamily, runEmbeddings } from '../services/embeddings.js';

export const SEMANTIC_CACHE_ENABLED_SETTING = 'semantic_cache_enabled';
export const SEMANTIC_CACHE_THRESHOLD_SETTING = 'semantic_cache_threshold';
export const SEMANTIC_CACHE_MIN_THRESHOLD = 0.85;
export const SEMANTIC_CACHE_MAX_THRESHOLD = 0.99;
export const SEMANTIC_CACHE_DEFAULT_THRESHOLD = 0.94;

const EMBEDDING_TIMEOUT_MS = 2_500;
const MAX_MEM_ENTRIES = 500;
const MAX_SCAN_PER_PARTITION = 100;
const MIN_QUERY_CHARS = 8;
const MAX_QUERY_CHARS = 4_000;

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{10,}/i,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|password|passwd|secret|passcode)\s*[:=]/i,
  /\b(?:otp|pin|verification code)\b[\s\S]{0,24}\b\d{4,8}\b/i,
];

export type SemanticEmbedderFn = (
  text: string,
) => Promise<{ family: string; vector: number[] } | null>;

export interface SemanticLookupInput {
  cacheDirective: CacheDirective;
  stream: boolean;
  authScope: string;
  endUser?: string | undefined;
  restrictionSignature?: string | undefined;
  model: string | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  top_p?: number | undefined;
  max_tokens?: number | undefined;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  stop?: unknown;
  response_format?: unknown;
  n?: unknown;
  seed?: unknown;
  top_k?: unknown;
  min_p?: unknown;
  presence_penalty?: unknown;
  frequency_penalty?: unknown;
  repetition_penalty?: unknown;
  logit_bias?: unknown;
  logprobs?: unknown;
  top_logprobs?: unknown;
  reasoning_effort?: unknown;
  compression?: unknown;
}

export interface SemanticCacheHit {
  body: unknown;
  similarity: number;
  platform: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

export interface PendingSemanticEntry {
  partitionHash: string;
  embeddingFamily: string;
  vector: number[];
  queryPreview: string;
}

export interface SemanticStoreInput {
  body: unknown;
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface SemanticCacheStats {
  semanticEnabled: boolean;
  semanticThreshold: number;
  semanticEntries: number;
  semanticHits: number;
  semanticMisses: number;
  semanticSavedTokens: number;
}

interface StoredSemanticEntry {
  memKey: string;
  dbId: number | null;
  partitionHash: string;
  embeddingFamily: string;
  vector: number[];
  queryPreview: string;
  body: unknown;
  platform: string;
  modelId: string;
  keyId: number | null;
  promptTokens: number;
  completionTokens: number;
  hitCount: number;
  createdAt: number;
  expiresAt: number;
}

let customEmbedderForTests: SemanticEmbedderFn | null = null;
const memEntries = new Map<string, StoredSemanticEntry>();
let lastDbRef: unknown = null;
let hydrated = false;
let nextMemId = 1;
let semanticHits = 0;
let semanticMisses = 0;
let semanticSavedTokens = 0;

function readSettingSafe(key: string): string | undefined {
  try {
    return getSetting(key);
  } catch {
    return undefined;
  }
}

function syncDbLifecycle(): void {
  try {
    const db = getDb();
    if (lastDbRef !== db) {
      memEntries.clear();
      semanticHits = 0;
      semanticMisses = 0;
      semanticSavedTokens = 0;
      nextMemId = 1;
      hydrated = false;
      lastDbRef = db;
    }
  } catch {
    // DB may not be initialized in unit tests that bypass DB
  }
}

function hasSemanticTable(): boolean {
  try {
    const db = getDb();
    return Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_semantic_cache_entries'")
        .get(),
    );
  } catch {
    return false;
  }
}

function hydrateFromDbOnce(): void {
  syncDbLifecycle();
  if (hydrated) return;
  hydrated = true;
  if (!cachePersistencePreference() || !hasSemanticTable()) return;

  try {
    const db = getDb();
    const now = Date.now();
    const limit = Math.max(1, Math.min(cacheMaxEntries(), MAX_MEM_ENTRIES));
    const rows = db
      .prepare(
        `SELECT * FROM custom_semantic_cache_entries
          WHERE expires_at > ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(now, limit) as Array<{
      id: number;
      partition_hash: string;
      embedding_family: string;
      vector_json: string;
      query_preview: string;
      response_json: string;
      platform: string;
      model_id: string;
      key_id: number | null;
      prompt_tokens: number;
      completion_tokens: number;
      hit_count: number;
      created_at: number;
      expires_at: number;
    }>;

    // Insert oldest-first so MRU order mirrors id ASC -> newest at tail
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const r = rows[i]!;
      let vec: number[];
      let body: unknown;
      try {
        const parsedVec = JSON.parse(r.vector_json) as unknown;
        if (!Array.isArray(parsedVec) || parsedVec.length === 0) continue;
        vec = parsedVec.map(Number).filter(Number.isFinite);
        if (vec.length !== parsedVec.length) continue;
        body = JSON.parse(r.response_json) as unknown;
      } catch {
        continue;
      }
      const memKey = `db:${r.id}`;
      memEntries.set(memKey, {
        memKey,
        dbId: r.id,
        partitionHash: r.partition_hash,
        embeddingFamily: r.embedding_family,
        vector: vec,
        queryPreview: r.query_preview,
        body,
        platform: r.platform,
        modelId: r.model_id,
        keyId: r.key_id,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        hitCount: r.hit_count,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      });
    }
  } catch {
    // best-effort hydration
  }
}

export function clampSemanticThreshold(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return SEMANTIC_CACHE_DEFAULT_THRESHOLD;
  const clamped = Math.max(SEMANTIC_CACHE_MIN_THRESHOLD, Math.min(SEMANTIC_CACHE_MAX_THRESHOLD, num));
  return Math.round(clamped * 10_000) / 10_000;
}

export function isSemanticCacheEnabled(): boolean {
  const stored = readSettingSafe(SEMANTIC_CACHE_ENABLED_SETTING);
  if (!stored || stored.trim() === '') return false;
  return /^(1|true|on|yes)$/i.test(stored.trim());
}

export function getSemanticCacheThreshold(): number {
  const stored = readSettingSafe(SEMANTIC_CACHE_THRESHOLD_SETTING);
  if (!stored || stored.trim() === '') return SEMANTIC_CACHE_DEFAULT_THRESHOLD;
  return clampSemanticThreshold(stored);
}

export function setSemanticCachePreferences(prefs: {
  semanticEnabled?: boolean;
  semanticThreshold?: number;
}): void {
  if (prefs.semanticEnabled !== undefined) {
    setSetting(SEMANTIC_CACHE_ENABLED_SETTING, prefs.semanticEnabled ? '1' : '0');
  }
  if (prefs.semanticThreshold !== undefined) {
    setSetting(
      SEMANTIC_CACHE_THRESHOLD_SETTING,
      String(clampSemanticThreshold(prefs.semanticThreshold)),
    );
  }
}

export function setSemanticEmbedderForTests(fn: SemanticEmbedderFn | null): void {
  customEmbedderForTests = fn;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function extractEligibleUserQuery(input: SemanticLookupInput): string | null {
  if (input.stream) return null;
  if (!isSemanticCacheEnabled()) return null;
  if (!cacheActive(input.cacheDirective)) return null;
  if (!isCacheableTemperature(input.temperature)) return null;

  if (Array.isArray(input.tools) && input.tools.length > 0) return null;
  if (
    input.tool_choice !== undefined &&
    input.tool_choice !== null &&
    input.tool_choice !== 'none'
  ) {
    return null;
  }

  for (const msg of input.messages) {
    if (msg.role === 'tool') return null;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return null;
  }

  const lastMsg = input.messages[input.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user' || typeof lastMsg.content !== 'string') {
    return null;
  }

  const query = lastMsg.content.trim();
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
    return null;
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(query)) return null;
  }

  return query;
}

function computePartitionHash(input: SemanticLookupInput, embeddingFamily: string): string {
  const canonical = stableStringify({
    v: 1,
    authScope: input.authScope,
    endUser: input.endUser ?? null,
    restrictionSignature: input.restrictionSignature ?? null,
    model: !input.model || input.model === 'auto' ? 'auto' : input.model,
    embeddingFamily,
    contextPrefix: input.messages.slice(0, -1),
    temperature: input.temperature,
    top_p: input.top_p,
    max_tokens: input.max_tokens,
    stop: input.stop,
    response_format: input.response_format,
    n: input.n,
    seed: input.seed,
    top_k: input.top_k,
    min_p: input.min_p,
    presence_penalty: input.presence_penalty,
    frequency_penalty: input.frequency_penalty,
    repetition_penalty: input.repetition_penalty,
    logit_bias: input.logit_bias,
    logprobs: input.logprobs,
    top_logprobs: input.top_logprobs,
    reasoning_effort: input.reasoning_effort,
    compression: input.compression,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function normalizeVector(raw: number[]): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  let normSq = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const val = raw[i];
    if (typeof val !== 'number' || !Number.isFinite(val)) return null;
    normSq += val * val;
  }
  if (normSq <= 0) return null;
  const invNorm = 1 / Math.sqrt(normSq);
  return raw.map((v) => v * invNorm);
}

function cosineDot(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

async function computeNormalizedEmbedding(
  query: string,
): Promise<{ family: string; vector: number[] } | null> {
  if (customEmbedderForTests) {
    try {
      const res = await customEmbedderForTests(query);
      if (!res) return null;
      const normalized = normalizeVector(res.vector);
      return normalized ? { family: res.family, vector: normalized } : null;
    } catch {
      return null;
    }
  }

  try {
    const db = getDb();
    const defaultFamily = getDefaultFamily();
    const enabledRow = db
      .prepare('SELECT 1 FROM embedding_models WHERE family = ? AND enabled = 1 LIMIT 1')
      .get(defaultFamily);
    if (!enabledRow) return null;
  } catch {
    return null;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const res = await Promise.race([
      runEmbeddings('auto', [query]),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), EMBEDDING_TIMEOUT_MS);
      }),
    ]);
    if (!res || !Array.isArray(res.vectors) || !res.vectors[0]) return null;
    const normalized = normalizeVector(res.vectors[0]);
    if (!normalized) return null;
    return { family: res.family, vector: normalized };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function evictEntry(entry: StoredSemanticEntry): void {
  memEntries.delete(entry.memKey);
  if (entry.dbId !== null && hasSemanticTable()) {
    try {
      getDb()
        .prepare('DELETE FROM custom_semantic_cache_entries WHERE id = ?')
        .run(entry.dbId);
    } catch {
      // ignore cleanup failure
    }
  }
}

export async function lookupSemanticCache(
  input: SemanticLookupInput,
): Promise<{ hit: SemanticCacheHit | null; pending: PendingSemanticEntry | null }> {
  hydrateFromDbOnce();
  const queryText = extractEligibleUserQuery(input);
  if (!queryText) return { hit: null, pending: null };

  const emb = await computeNormalizedEmbedding(queryText);
  if (!emb) return { hit: null, pending: null };

  const partitionHash = computePartitionHash(input, emb.family);
  const threshold = getSemanticCacheThreshold();
  const now = Date.now();

  const matching: StoredSemanticEntry[] = [];
  for (const entry of memEntries.values()) {
    if (entry.expiresAt <= now) {
      evictEntry(entry);
      continue;
    }
    if (
      entry.partitionHash === partitionHash &&
      entry.embeddingFamily === emb.family
    ) {
      matching.push(entry);
    }
  }

  // Scan up to newest MAX_SCAN_PER_PARTITION entries in this partition
  const startIdx = Math.max(0, matching.length - MAX_SCAN_PER_PARTITION);
  let best: StoredSemanticEntry | null = null;
  let bestScore = -1;
  for (let i = matching.length - 1; i >= startIdx; i -= 1) {
    const candidate = matching[i]!;
    const score = cosineDot(emb.vector, candidate.vector);
    if (score >= threshold && score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  if (best) {
    best.hitCount += 1;
    semanticHits += 1;
    semanticSavedTokens += best.promptTokens + best.completionTokens;
    // Promote to MRU end
    memEntries.delete(best.memKey);
    memEntries.set(best.memKey, best);
    if (best.dbId !== null && cachePersistencePreference() && hasSemanticTable()) {
      try {
        getDb()
          .prepare('UPDATE custom_semantic_cache_entries SET hit_count = ? WHERE id = ?')
          .run(best.hitCount, best.dbId);
      } catch {
        // non-fatal stats update
      }
    }
    return {
      hit: {
        body: best.body,
        similarity: bestScore,
        platform: best.platform,
        modelId: best.modelId,
        promptTokens: best.promptTokens,
        completionTokens: best.completionTokens,
      },
      pending: null,
    };
  }

  semanticMisses += 1;
  return {
    hit: null,
    pending: {
      partitionHash,
      embeddingFamily: emb.family,
      vector: emb.vector,
      queryPreview: queryText.slice(0, 120),
    },
  };
}

export function storeSemanticCacheEntry(
  pending: PendingSemanticEntry,
  data: SemanticStoreInput,
): void {
  hydrateFromDbOnce();
  const maxEntries = Math.min(Math.max(1, cacheMaxEntries()), MAX_MEM_ENTRIES);
  const now = Date.now();
  const expiresAt = now + cacheTtlMs();

  let dbId: number | null = null;
  if (cachePersistencePreference() && hasSemanticTable()) {
    try {
      const db = getDb();
      const info = db
        .prepare(
          `INSERT INTO custom_semantic_cache_entries
             (partition_hash, embedding_family, vector_json, query_preview, response_json, platform, model_id, key_id, prompt_tokens, completion_tokens, hit_count, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          pending.partitionHash,
          pending.embeddingFamily,
          JSON.stringify(pending.vector),
          pending.queryPreview,
          JSON.stringify(data.body),
          data.platform,
          data.modelId,
          data.keyId,
          data.promptTokens,
          data.completionTokens,
          now,
          expiresAt,
        );
      dbId = Number(info.lastInsertRowid);
    } catch {
      dbId = null;
    }
  }

  const memKey = dbId !== null ? `db:${dbId}` : `mem:${nextMemId++}`;
  const entry: StoredSemanticEntry = {
    memKey,
    dbId,
    partitionHash: pending.partitionHash,
    embeddingFamily: pending.embeddingFamily,
    vector: pending.vector,
    queryPreview: pending.queryPreview,
    body: data.body,
    platform: data.platform,
    modelId: data.modelId,
    keyId: data.keyId,
    promptTokens: data.promptTokens,
    completionTokens: data.completionTokens,
    hitCount: 0,
    createdAt: now,
    expiresAt,
  };
  memEntries.set(memKey, entry);

  while (memEntries.size > maxEntries) {
    const oldestKey = memEntries.keys().next().value;
    if (!oldestKey) break;
    const oldest = memEntries.get(oldestKey);
    if (oldest) evictEntry(oldest);
    else memEntries.delete(oldestKey);
  }
}

export function getSemanticCacheStats(): SemanticCacheStats {
  hydrateFromDbOnce();
  const now = Date.now();
  for (const entry of memEntries.values()) {
    if (entry.expiresAt <= now) {
      evictEntry(entry);
    }
  }
  return {
    semanticEnabled: isSemanticCacheEnabled(),
    semanticThreshold: getSemanticCacheThreshold(),
    semanticEntries: memEntries.size,
    semanticHits,
    semanticMisses,
    semanticSavedTokens,
  };
}

export function clearSemanticCache(): number {
  syncDbLifecycle();
  const memCount = memEntries.size;
  memEntries.clear();
  semanticHits = 0;
  semanticMisses = 0;
  semanticSavedTokens = 0;
  hydrated = true;

  let dbRemoved = 0;
  if (hasSemanticTable()) {
    try {
      const res = getDb().prepare('DELETE FROM custom_semantic_cache_entries').run();
      dbRemoved = res.changes ?? 0;
    } catch {
      dbRemoved = 0;
    }
  }
  return Math.max(memCount, dbRemoved);
}
