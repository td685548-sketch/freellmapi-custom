import crypto from 'node:crypto';
import {
  RETRIEVAL_LIMITS,
  type EmbeddingChunkStatus,
  type RetrievalIndexStatus,
  type Scope,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';
import { bumpIndexGeneration, getIndexGeneration } from './settings.js';

export interface VectorEntry {
  chunkId: number;
  docId: string;
  ord: number;
  contentHash: string;
  model: string;
  dims: number;
  vector: Float32Array;
}

export interface VectorSearchHit {
  docId: string;
  chunkId: number;
  ord: number;
  score: number;
}

export interface EmbeddingMetaRecord {
  id: number;
  docId: string;
  chunkId: number;
  ord: number;
  contentHash: string;
  model: string;
  dims: number;
  status: EmbeddingChunkStatus;
  errorText: string | null;
}

interface PackedGroup {
  dims: number;
  slab: Float32Array;
  entries: VectorEntry[];
}

interface CacheBucket {
  generation: number;
  entries: VectorEntry[];
  groups: Map<string, PackedGroup>;
  bytes: number;
}

const vectorCache = new Map<string, CacheBucket>();
let totalCacheBytes = 0;
let maxCacheBytesOverride: number | null = null;

function effectiveMaxCacheBytes(): number {
  return maxCacheBytesOverride ?? RETRIEVAL_LIMITS.vectorCacheMaxBytes;
}

function groupKey(model: string, dims: number): string {
  return `${model}\0${dims}`;
}

function scopeKey(norm: Scope): string {
  return `${norm.kind}:${norm.id}`;
}

function evictOne(key: string): void {
  const existing = vectorCache.get(key);
  if (!existing) return;
  vectorCache.delete(key);
  totalCacheBytes -= existing.bytes;
}

function enforceBudget(maxBytes: number): void {
  while (totalCacheBytes > maxBytes && vectorCache.size > 0) {
    const oldestKey = vectorCache.keys().next().value;
    if (oldestKey === undefined) break;
    evictOne(oldestKey);
  }
}

export function computeContentHash(title: string, text: string): string {
  return crypto.createHash('sha256').update(title).update('\0').update(text).digest('hex');
}

export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vec.length);
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const value = Number(vec[i]);
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid vector component at index ${i}.`);
    }
    sumSq += value * value;
  }
  if (sumSq === 0) {
    return out;
  }
  const invNorm = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Number(vec[i]) * invNorm;
  }
  return out;
}

export function encodeVectorBlob(vec: ArrayLike<number>): Buffer {
  const normalized = l2Normalize(vec);
  const buf = Buffer.allocUnsafe(normalized.length * 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < normalized.length; i++) {
    view.setFloat32(i * 4, normalized[i]!, true);
  }
  return buf;
}

export function decodeVectorBlob(blob: Buffer | Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`Invalid Float32 vector BLOB byte length: ${blob.byteLength}`);
  }
  const count = blob.byteLength / 4;
  const out = new Float32Array(count);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let i = 0; i < count; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function dotUnitSlice8(slab: Float32Array, offset: number, query: Float32Array, len: number): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let s5 = 0;
  let s6 = 0;
  let s7 = 0;
  let i = 0;
  const limit = len - 7;
  for (; i < limit; i += 8) {
    const o = offset + i;
    s0 += slab[o]! * query[i]!;
    s1 += slab[o + 1]! * query[i + 1]!;
    s2 += slab[o + 2]! * query[i + 2]!;
    s3 += slab[o + 3]! * query[i + 3]!;
    s4 += slab[o + 4]! * query[i + 4]!;
    s5 += slab[o + 5]! * query[i + 5]!;
    s6 += slab[o + 6]! * query[i + 6]!;
    s7 += slab[o + 7]! * query[i + 7]!;
  }
  let dot = s0 + s1 + s2 + s3 + (s4 + s5 + s6 + s7);
  for (; i < len; i++) {
    dot += slab[offset + i]! * query[i]!;
  }
  return dot;
}

function clampCosine(dot: number): number {
  if (Number.isNaN(dot)) return 0;
  if (dot > 1) return 1;
  if (dot < -1) return -1;
  return dot === 0 ? 0 : dot;
}

export function cosineSimilarityUnit(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`Vector length mismatch (${a.length} vs ${b.length})`);
  }
  return clampCosine(dotUnitSlice8(a, 0, b, a.length));
}

export function invalidateVectorCache(scope?: Scope): void {
  if (!scope) {
    vectorCache.clear();
    totalCacheBytes = 0;
    return;
  }
  const norm = normalizeScope(scope);
  evictOne(scopeKey(norm));
}

export function setVectorCacheMaxBytesForTests(maxBytes: number | null): void {
  if (maxBytes === null) {
    maxCacheBytesOverride = null;
  } else {
    maxCacheBytesOverride = Math.max(0, Math.floor(maxBytes));
  }
  enforceBudget(effectiveMaxCacheBytes());
}

export function getVectorCacheStats(): {
  entries: number;
  bytes: number;
  maxBytes: number;
  keys: string[];
} {
  return {
    entries: vectorCache.size,
    bytes: totalCacheBytes,
    maxBytes: effectiveMaxCacheBytes(),
    keys: [...vectorCache.keys()],
  };
}

interface ReadyVectorRow {
  chunk_id: number;
  doc_id: string;
  ord: number;
  content_hash: string;
  model: string;
  dims: number;
  vector: Buffer | Uint8Array | ArrayBuffer | null;
}

function decodeIntoSlab(
  raw: Uint8Array,
  slab: Float32Array,
  offset: number,
  dims: number,
): void {
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < dims; i++) {
    slab[offset + i] = view.getFloat32(i * 4, true);
  }
}

function compareHits(a: VectorSearchHit, b: VectorSearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.docId !== b.docId) return a.docId < b.docId ? -1 : 1;
  if (a.ord !== b.ord) return a.ord - b.ord;
  return a.chunkId - b.chunkId;
}

function compareCandidateToHit(score: number, entry: VectorEntry, hit: VectorSearchHit): number {
  if (hit.score !== score) return hit.score - score;
  if (entry.docId !== hit.docId) return entry.docId < hit.docId ? -1 : 1;
  if (entry.ord !== hit.ord) return entry.ord - hit.ord;
  return entry.chunkId - hit.chunkId;
}

function insertBoundedHit(top: VectorSearchHit[], candidate: VectorSearchHit, limit: number): void {
  let pos = top.length;
  while (pos > 0 && compareHits(candidate, top[pos - 1]!) < 0) {
    pos--;
  }
  if (pos >= limit) return;
  if (top.length < limit) {
    top.splice(pos, 0, candidate);
    return;
  }
  for (let i = limit - 1; i > pos; i--) {
    top[i] = top[i - 1]!;
  }
  top[pos] = candidate;
}

function loadScopeBucket(scope: Scope, expectedGeneration: number): CacheBucket {
  const norm = normalizeScope(scope);
  const key = scopeKey(norm);

  const cached = vectorCache.get(key);
  if (cached && cached.generation === expectedGeneration) {
    // Refresh LRU position on hit.
    vectorCache.delete(key);
    vectorCache.set(key, cached);
    return cached;
  }
  if (cached) {
    evictOne(key);
  }

  const rows = getDb()
    .prepare(
      `SELECT chunk_id, doc_id, ord, content_hash, model, dims, vector
         FROM custom_ai_chunk_embeddings
        WHERE scope_kind = ?
          AND scope_id = ?
          AND status = 'ready'
          AND vector IS NOT NULL
        ORDER BY doc_id ASC, ord ASC, chunk_id ASC`,
    )
    .all(norm.kind, norm.id) as ReadyVectorRow[];

  interface ValidRow {
    row: ReadyVectorRow;
    raw: Uint8Array;
  }
  const groupedRaw = new Map<string, { dims: number; items: ValidRow[] }>();
  let totalValid = 0;
  let bytes = 0;

  for (const row of rows) {
    if (!row.vector || row.dims <= 0) continue;
    const raw =
      row.vector instanceof Uint8Array
        ? row.vector
        : row.vector instanceof ArrayBuffer
          ? new Uint8Array(row.vector)
          : null;
    if (!raw || raw.byteLength % 4 !== 0 || raw.byteLength / 4 !== row.dims) continue;

    bytes += row.dims * 4;
    totalValid++;
    const gKey = groupKey(row.model, row.dims);
    let grp = groupedRaw.get(gKey);
    if (!grp) {
      grp = { dims: row.dims, items: [] };
      groupedRaw.set(gKey, grp);
    }
    grp.items.push({ row, raw });
  }

  const entries: VectorEntry[] = new Array(totalValid);
  const groups = new Map<string, PackedGroup>();
  let entryCursor = 0;

  for (const [gKey, grp] of groupedRaw) {
    const slab = new Float32Array(grp.items.length * grp.dims);
    const groupEntries: VectorEntry[] = new Array(grp.items.length);
    for (let idx = 0; idx < grp.items.length; idx++) {
      const { row, raw } = grp.items[idx]!;
      const offset = idx * grp.dims;
      decodeIntoSlab(raw, slab, offset, grp.dims);
      const entry: VectorEntry = {
        chunkId: row.chunk_id,
        docId: row.doc_id,
        ord: row.ord,
        contentHash: row.content_hash,
        model: row.model,
        dims: row.dims,
        vector: slab.subarray(offset, offset + grp.dims),
      };
      groupEntries[idx] = entry;
      entries[entryCursor++] = entry;
    }
    groups.set(gKey, { dims: grp.dims, slab, entries: groupEntries });
  }

  const bucket: CacheBucket = {
    generation: expectedGeneration,
    entries,
    groups,
    bytes,
  };

  const maxBytes = effectiveMaxCacheBytes();
  if (bytes <= maxBytes) {
    while (totalCacheBytes + bytes > maxBytes && vectorCache.size > 0) {
      const oldestKey = vectorCache.keys().next().value;
      if (oldestKey === undefined) break;
      evictOne(oldestKey);
    }
    if (totalCacheBytes + bytes <= maxBytes) {
      vectorCache.set(key, bucket);
      totalCacheBytes += bytes;
    }
  }

  return bucket;
}

export function getScopeVectors(
  scope: Scope,
  expectedGeneration: number,
): { generation: number; entries: VectorEntry[]; bytes: number } {
  const bucket = loadScopeBucket(scope, expectedGeneration);
  return {
    generation: bucket.generation,
    entries: bucket.entries,
    bytes: bucket.bytes,
  };
}

export function searchTopVectors(
  scope: Scope,
  queryVector: ArrayLike<number>,
  opts: {
    expectedGeneration: number;
    model: string;
    dims: number;
    topK: number;
    minScore?: number;
    allowedDocIds?: Set<string>;
    contentHashesByChunkKey?: Map<string, string>;
  },
): VectorSearchHit[] {
  const limit = Math.floor(opts.topK);
  if (limit <= 0) return [];
  const qVec = l2Normalize(queryVector);
  if (qVec.length !== opts.dims) {
    throw new RangeError(
      `Query vector dimension mismatch: expected ${opts.dims}, got ${qVec.length}`,
    );
  }

  const bucket = loadScopeBucket(scope, opts.expectedGeneration);
  const group = bucket.groups.get(groupKey(opts.model, opts.dims));
  if (!group) return [];

  const { dims, slab, entries } = group;
  const count = entries.length;
  const minScore = opts.minScore ?? -1;
  const allowedDocIds = opts.allowedDocIds;
  const contentHashesByChunkKey = opts.contentHashesByChunkKey;
  const top: VectorSearchHit[] = [];

  for (let idx = 0, offset = 0; idx < count; idx++, offset += dims) {
    const entry = entries[idx]!;
    if (allowedDocIds && !allowedDocIds.has(entry.docId)) continue;
    if (contentHashesByChunkKey) {
      const expectedHash = contentHashesByChunkKey.get(`${entry.docId}:${entry.chunkId}`);
      if (!expectedHash || expectedHash !== entry.contentHash) continue;
    }

    const score = clampCosine(dotUnitSlice8(slab, offset, qVec, dims));
    if (score < minScore) continue;
    if (top.length >= limit && compareCandidateToHit(score, entry, top[top.length - 1]!) >= 0) {
      continue;
    }

    insertBoundedHit(
      top,
      {
        docId: entry.docId,
        chunkId: entry.chunkId,
        ord: entry.ord,
        score,
      },
      limit,
    );
  }

  return top;
}

export function deleteDocVectors(
  scope: Scope,
  docId: string,
): { deleted: number; newGeneration: number } {
  const norm = normalizeScope(scope);
  const db = getDb();
  const result = db.transaction(() => {
    const deleted = db
      .prepare(
        'DELETE FROM custom_ai_chunk_embeddings WHERE scope_kind = ? AND scope_id = ? AND doc_id = ?',
      )
      .run(norm.kind, norm.id, String(docId)).changes;
    const newGeneration = bumpIndexGeneration(norm);
    return { deleted, newGeneration };
  })();
  invalidateVectorCache(norm);
  return result;
}

export function deleteStaleDocChunks(
  scope: Scope,
  validDocChunkKeys: Set<string>,
): { deleted: number; newGeneration: number | null } {
  const norm = normalizeScope(scope);
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT id, doc_id, chunk_id FROM custom_ai_chunk_embeddings WHERE scope_kind = ? AND scope_id = ?',
    )
    .all(norm.kind, norm.id) as Array<{ id: number; doc_id: string; chunk_id: number }>;

  const staleIds = rows
    .filter((r) => !validDocChunkKeys.has(`${r.doc_id}:${r.chunk_id}`))
    .map((r) => r.id);

  if (staleIds.length === 0) {
    return { deleted: 0, newGeneration: null };
  }

  const result = db.transaction(() => {
    let deleted = 0;
    const batchSize = 500;
    for (let i = 0; i < staleIds.length; i += batchSize) {
      const slice = staleIds.slice(i, i + batchSize);
      const placeholders = slice.map(() => '?').join(', ');
      deleted += db
        .prepare(`DELETE FROM custom_ai_chunk_embeddings WHERE id IN (${placeholders})`)
        .run(...slice).changes;
    }
    const newGeneration = deleted > 0 ? bumpIndexGeneration(norm) : null;
    return { deleted, newGeneration };
  })();

  if (result.deleted > 0) {
    invalidateVectorCache(norm);
  }
  return result;
}

export function upsertPendingChunk(
  scope: Scope,
  chunk: {
    docId: string;
    chunkId: number;
    ord: number;
    contentHash: string;
    model: string;
    dims: number;
  },
): void {
  const norm = normalizeScope(scope);
  getDb()
    .prepare(
      `INSERT INTO custom_ai_chunk_embeddings (
        scope_kind, scope_id, doc_id, chunk_id, ord, content_hash,
        model, dims, vector, status, error_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, datetime('now'))
      ON CONFLICT(scope_kind, scope_id, doc_id, chunk_id) DO UPDATE SET
        ord = excluded.ord,
        content_hash = excluded.content_hash,
        model = excluded.model,
        dims = excluded.dims,
        vector = NULL,
        status = 'pending',
        error_text = NULL,
        updated_at = datetime('now')`,
    )
    .run(
      norm.kind,
      norm.id,
      String(chunk.docId),
      chunk.chunkId,
      chunk.ord,
      chunk.contentHash,
      chunk.model,
      chunk.dims,
    );
  invalidateVectorCache(norm);
}

export function markChunkReadyBatch(
  scope: Scope,
  items: Array<{
    docId: string;
    chunkId: number;
    ord: number;
    contentHash: string;
    model: string;
    dims: number;
    vector: ArrayLike<number>;
  }>,
): void {
  if (items.length === 0) return;
  const norm = normalizeScope(scope);
  const db = getDb();

  db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO custom_ai_chunk_embeddings (
        scope_kind, scope_id, doc_id, chunk_id, ord, content_hash,
        model, dims, vector, status, error_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, datetime('now'))
      ON CONFLICT(scope_kind, scope_id, doc_id, chunk_id) DO UPDATE SET
        ord = excluded.ord,
        content_hash = excluded.content_hash,
        model = excluded.model,
        dims = excluded.dims,
        vector = excluded.vector,
        status = 'ready',
        error_text = NULL,
        updated_at = datetime('now')`,
    );
    for (const item of items) {
      if (item.vector.length !== item.dims) {
        throw new RangeError(
          `Vector length ${item.vector.length} does not match expected dims ${item.dims}`,
        );
      }
      const blob = encodeVectorBlob(item.vector);
      stmt.run(
        norm.kind,
        norm.id,
        String(item.docId),
        item.chunkId,
        item.ord,
        item.contentHash,
        item.model,
        item.dims,
        blob,
      );
    }
  })();

  invalidateVectorCache(norm);
}

export function markChunkErrorBatch(
  scope: Scope,
  items: Array<{
    docId: string;
    chunkId: number;
    ord: number;
    contentHash: string;
    model: string;
    dims: number;
    errorText: string;
  }>,
): void {
  if (items.length === 0) return;
  const norm = normalizeScope(scope);
  const db = getDb();

  db.transaction(() => {
    const stmt = db.prepare(
      `INSERT INTO custom_ai_chunk_embeddings (
        scope_kind, scope_id, doc_id, chunk_id, ord, content_hash,
        model, dims, vector, status, error_text, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'error', ?, datetime('now'))
      ON CONFLICT(scope_kind, scope_id, doc_id, chunk_id) DO UPDATE SET
        ord = excluded.ord,
        content_hash = excluded.content_hash,
        model = excluded.model,
        dims = excluded.dims,
        vector = NULL,
        status = 'error',
        error_text = excluded.error_text,
        updated_at = datetime('now')`,
    );
    for (const item of items) {
      stmt.run(
        norm.kind,
        norm.id,
        String(item.docId),
        item.chunkId,
        item.ord,
        item.contentHash,
        item.model,
        item.dims,
        item.errorText.slice(0, 2000),
      );
    }
  })();

  invalidateVectorCache(norm);
}

export function listScopeEmbeddingMeta(scope: Scope): EmbeddingMetaRecord[] {
  const norm = normalizeScope(scope);
  return getDb()
    .prepare(
      `SELECT id,
              doc_id AS docId,
              chunk_id AS chunkId,
              ord,
              content_hash AS contentHash,
              model,
              dims,
              status,
              error_text AS errorText
         FROM custom_ai_chunk_embeddings
        WHERE scope_kind = ? AND scope_id = ?
        ORDER BY doc_id ASC, ord ASC, chunk_id ASC`,
    )
    .all(norm.kind, norm.id) as EmbeddingMetaRecord[];
}

export function getIndexStatus(
  scope: Scope,
  currentSourceChunks?: Array<{ docId: string; chunkId: number; contentHash: string }>,
  targetModel?: string | null,
  targetDims?: number,
): RetrievalIndexStatus {
  const norm = normalizeScope(scope);
  const generation = getIndexGeneration(norm);
  const meta = listScopeEmbeddingMeta(norm);

  let totalChunks = 0;
  let readyChunks = 0;
  let pendingChunks = 0;
  let errorChunks = 0;
  let staleChunks = 0;

  if (currentSourceChunks) {
    totalChunks = currentSourceChunks.length;
    const metaByKey = new Map<string, EmbeddingMetaRecord>();
    for (const row of meta) {
      metaByKey.set(`${row.docId}:${row.chunkId}`, row);
    }
    const sourceKeys = new Set<string>();
    for (const chunk of currentSourceChunks) {
      const key = `${chunk.docId}:${chunk.chunkId}`;
      sourceKeys.add(key);
      const row = metaByKey.get(key);
      if (!row) {
        pendingChunks++;
        continue;
      }
      const hashOk = row.contentHash === chunk.contentHash;
      const modelOk = targetModel == null || row.model === targetModel;
      const dimsOk = targetDims == null || row.dims === targetDims;
      if (!hashOk || !modelOk || !dimsOk) {
        staleChunks++;
        continue;
      }
      if (row.status === 'ready') readyChunks++;
      else if (row.status === 'error') errorChunks++;
      else pendingChunks++;
    }
    for (const row of meta) {
      if (!sourceKeys.has(`${row.docId}:${row.chunkId}`)) {
        staleChunks++;
      }
    }
  } else {
    totalChunks = meta.length;
    for (const row of meta) {
      const modelOk = targetModel == null || row.model === targetModel;
      const dimsOk = targetDims == null || row.dims === targetDims;
      if (!modelOk || !dimsOk) {
        staleChunks++;
        continue;
      }
      if (row.status === 'ready') readyChunks++;
      else if (row.status === 'error') errorChunks++;
      else pendingChunks++;
    }
  }

  const readyRows = meta.filter((r) => r.status === 'ready');
  let indexedModel: string | null = null;
  let indexedDimensions: number | null = null;
  if (readyRows.length > 0) {
    const exact = readyRows.find(
      (r) =>
        (targetModel == null || r.model === targetModel) &&
        (targetDims == null || r.dims === targetDims),
    );
    const chosen = exact ?? readyRows.reduce((best, cur) => (cur.id > best.id ? cur : best));
    indexedModel = chosen.model;
    indexedDimensions = chosen.dims;
  }

  const ready =
    readyChunks === totalChunks &&
    pendingChunks === 0 &&
    errorChunks === 0 &&
    staleChunks === 0;
  const percentComplete =
    totalChunks === 0
      ? staleChunks === 0
        ? 100
        : 0
      : Math.round((readyChunks / totalChunks) * 100);

  return {
    generation,
    totalChunks,
    readyChunks,
    pendingChunks,
    errorChunks,
    staleChunks,
    ready,
    percentComplete,
    indexedModel,
    indexedDimensions,
  };
}
