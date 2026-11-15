import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { purgeScope } from '../../../custom/ai-platform/scope.js';
import {
  RetrievalStoreError,
  assertScopeExists,
  bumpIndexGeneration,
  getIndexGeneration,
  getRetrievalSettings,
  getRetrievalSettingsInternal,
  getRetrievalUsage,
  listAvailableRetrievalModels,
  recordEmbeddingUsage,
  resolveEffectiveEmbeddingModel,
  resolveScopeEmbeddingConfig,
  setRetrievalSettings,
  validateScopeExists,
} from '../../../custom/ai-platform/retrieval/settings.js';
import {
  computeContentHash,
  cosineSimilarityUnit,
  decodeVectorBlob,
  deleteDocVectors,
  deleteStaleDocChunks,
  encodeVectorBlob,
  getIndexStatus,
  getScopeVectors,
  getVectorCacheStats,
  invalidateVectorCache,
  l2Normalize,
  listScopeEmbeddingMeta,
  markChunkErrorBatch,
  markChunkReadyBatch,
  searchTopVectors,
  setVectorCacheMaxBytesForTests,
  upsertPendingChunk,
} from '../../../custom/ai-platform/retrieval/vector-store.js';
import {
  addDoc,
  listProfileKnowledgeChunks,
  resetKnowledgeIndexes,
  searchKnowledge,
  searchKnowledgeRanked,
} from '../../../services/profile-knowledge.js';

function seedProfile(id: number, name = `profile-${id}`): void {
  getDb()
    .prepare(
      'INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, name, `th-${id}`, `ek-${id}`, `iv-${id}`, `tag-${id}`);
}

describe('retrieval settings, vector-store, and profile ranked search', () => {
  beforeEach(() => {
    initDb(':memory:');
    invalidateVectorCache();
    setVectorCacheMaxBytesForTests(null);
    resetKnowledgeIndexes();
  });

  afterEach(() => {
    invalidateVectorCache();
    setVectorCacheMaxBytesForTests(null);
    resetKnowledgeIndexes();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('performs L2 normalization, Float32 LE BLOB roundtrip (including zero vector), and clamped cosine similarity', () => {
    const unit = l2Normalize([3, 4, 0, 0]);
    expect(unit).toBeInstanceOf(Float32Array);
    expect(unit[0]).toBeCloseTo(0.6, 5);
    expect(unit[1]).toBeCloseTo(0.8, 5);

    const zero = l2Normalize([0, 0, 0, 0]);
    expect(Array.from(zero)).toEqual([0, 0, 0, 0]);
    expect(zero.some((x) => Number.isNaN(x))).toBe(false);

    const blob = encodeVectorBlob([3, 4, 0, 0]);
    expect(blob.byteLength).toBe(16);
    // Verify IEEE-754 little-endian encoding at byte level
    expect(blob.readFloatLE(0)).toBeCloseTo(0.6, 5);
    expect(blob.readFloatLE(4)).toBeCloseTo(0.8, 5);

    const decoded = decodeVectorBlob(blob);
    expect(decoded.length).toBe(4);
    expect(decoded[0]).toBeCloseTo(0.6, 5);
    expect(decoded[1]).toBeCloseTo(0.8, 5);

    const zeroDecoded = decodeVectorBlob(encodeVectorBlob([0, 0, 0, 0]));
    expect(Array.from(zeroDecoded)).toEqual([0, 0, 0, 0]);
    expect(() => decodeVectorBlob(Buffer.from([1, 2, 3]))).toThrow(/byte length/i);

    expect(cosineSimilarityUnit(decoded, decoded)).toBe(1);
    expect(cosineSimilarityUnit(decoded, new Float32Array([-0.6, -0.8, 0, 0]))).toBe(-1);
    expect(cosineSimilarityUnit(new Float32Array([1.5, 0]), new Float32Array([1.5, 0]))).toBe(1);
    expect(cosineSimilarityUnit(new Float32Array([1.5, 0]), new Float32Array([-1.5, 0]))).toBe(-1);
    expect(() => cosineSimilarityUnit(decoded, new Float32Array([1, 0]))).toThrow(RangeError);
  });

  it('validates scopes, retrieval settings, model resolution, and bumps index_generation only when model or dims change', () => {
    seedProfile(1);
    expect(validateScopeExists({ kind: 'profile', id: '001' })).toBe(true);
    expect(validateScopeExists({ kind: 'profile', id: '999' })).toBe(false);
    expect(validateScopeExists({ kind: 'agent', id: 'default' })).toBe(false);
    expect(assertScopeExists({ kind: 'profile', id: '001' })).toEqual({ kind: 'profile', id: '1' });

    expect(() => assertScopeExists({ kind: 'profile', id: '999' })).toThrowError(
      expect.objectContaining({ status: 404, code: 'scope_not_found' }),
    );
    expect(() => assertScopeExists({ kind: 'agent', id: 'triage' })).toThrowError(
      expect.objectContaining({ status: 409, code: 'scope_unavailable' }),
    );
    expect(() => assertScopeExists({ kind: 'profile', id: 'abc' })).toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid_scope' }),
    );

    const initial = getRetrievalSettings({ kind: 'profile', id: '1' });
    expect(initial).toMatchObject({
      scopeKind: 'profile',
      scopeId: '1',
      mode: 'hybrid',
      embeddingModel: null,
      dimensions: 768,
      topK: 5,
      minScore: 0.25,
      citationsEnabled: true,
      updatedAt: null,
    });
    expect(getIndexGeneration({ kind: 'profile', id: '1' })).toBe(1);

    const models = listAvailableRetrievalModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.family === 'gemini-embedding-001')).toBe(true);
    expect(models.some((m) => m.family === 'embed-v4.0')).toBe(false); // disabled by default

    expect(resolveScopeEmbeddingConfig({ kind: 'profile', id: '1' })).toEqual({
      model: 'gemini-embedding-001',
      dimensions: 768,
      modelConfigured: true,
    });
    expect(resolveEffectiveEmbeddingModel({ kind: 'profile', id: '1' })).toEqual({
      model: 'gemini-embedding-001',
      dimensions: 768,
      hasConfiguredProvider: true,
    });

    // Reject unknown model and out-of-range inputs
    expect(() =>
      setRetrievalSettings({ kind: 'profile', id: '1' }, { embeddingModel: 'does-not-exist' }),
    ).toThrowError(RetrievalStoreError);
    expect(() =>
      setRetrievalSettings({ kind: 'profile', id: '1' }, { topK: 21 }),
    ).toThrowError(RetrievalStoreError);
    expect(() =>
      setRetrievalSettings({ kind: 'profile', id: '1' }, { minScore: 1.5 }),
    ).toThrowError(RetrievalStoreError);
    expect(() =>
      setRetrievalSettings(
        { kind: 'profile', id: '1' },
        { embeddingModel: 'bge-m3', dimensions: 2048 },
      ),
    ).toThrowError(expect.objectContaining({ status: 400, code: 'invalid_dimensions' }));

    // Updating non-space fields does NOT bump index_generation
    const nonSpaceUpdate = setRetrievalSettings(
      { kind: 'profile', id: '1' },
      { mode: 'semantic', topK: 8, minScore: 0.4, citationsEnabled: false },
    );
    expect(nonSpaceUpdate.modelOrDimsChanged).toBe(false);
    expect(nonSpaceUpdate.indexGeneration).toBe(1);
    expect(nonSpaceUpdate.settings.topK).toBe(8);

    // Changing model bumps index_generation
    const modelUpdate = setRetrievalSettings(
      { kind: 'profile', id: '1' },
      { embeddingModel: 'bge-m3', dimensions: 1024 },
    );
    expect(modelUpdate.modelOrDimsChanged).toBe(true);
    expect(modelUpdate.indexGeneration).toBe(2);
    expect(modelUpdate.previousSettings.dimensions).toBe(768);
    expect(getRetrievalSettingsInternal({ kind: 'profile', id: '1' }).indexGeneration).toBe(2);

    // Changing dimensions bumps index_generation again
    const dimsUpdate = setRetrievalSettings(
      { kind: 'profile', id: '1' },
      { dimensions: 512 },
    );
    expect(dimsUpdate.modelOrDimsChanged).toBe(true);
    expect(dimsUpdate.indexGeneration).toBe(3);

    // Explicit bumpIndexGeneration works even on a fresh scope without prior settings row
    seedProfile(2);
    expect(getIndexGeneration({ kind: 'profile', id: '2' })).toBe(1);
    expect(bumpIndexGeneration({ kind: 'profile', id: '2' })).toBe(2);
    expect(bumpIndexGeneration({ kind: 'profile', id: '2' })).toBe(3);

    // Disabling embedding models makes modelConfigured / hasConfiguredProvider false for auto
    getDb().prepare('UPDATE embedding_models SET enabled = 0').run();
    expect(listAvailableRetrievalModels()).toEqual([]);
    expect(resolveScopeEmbeddingConfig({ kind: 'profile', id: '2' })).toEqual({
      model: null,
      dimensions: 768,
      modelConfigured: false,
    });
    expect(resolveEffectiveEmbeddingModel({ kind: 'profile', id: '2' })).toEqual({
      model: null,
      dimensions: 768,
      hasConfiguredProvider: false,
    });
  });

  it('filters by (model, dims, content_hash), deletes doc vectors synchronously, and cleans stale chunks', () => {
    seedProfile(1);
    const scope = { kind: 'profile' as const, id: '1' };
    const hash1 = computeContentHash('Shipping', 'Ships in 2 days.');
    const hash2 = computeContentHash('Returns', 'Returns within 7 days.');
    const hash3 = computeContentHash('Other', 'Another model vector.');

    upsertPendingChunk(scope, {
      docId: 'doc-1',
      chunkId: 10,
      ord: 0,
      contentHash: hash1,
      model: 'm1',
      dims: 4,
    });
    expect(listScopeEmbeddingMeta(scope)).toHaveLength(1);
    expect(listScopeEmbeddingMeta(scope)[0]?.status).toBe('pending');

    markChunkReadyBatch(scope, [
      {
        docId: 'doc-1',
        chunkId: 10,
        ord: 0,
        contentHash: hash1,
        model: 'm1',
        dims: 4,
        vector: [1, 0, 0, 0],
      },
      {
        docId: 'doc-2',
        chunkId: 20,
        ord: 0,
        contentHash: hash2,
        model: 'm1',
        dims: 4,
        vector: [0.8, 0.6, 0, 0],
      },
      {
        docId: 'doc-3',
        chunkId: 30,
        ord: 0,
        contentHash: hash3,
        model: 'other-model',
        dims: 4,
        vector: [1, 0, 0, 0],
      },
    ]);

    const gen1 = getIndexGeneration(scope);
    const loaded = getScopeVectors(scope, gen1);
    expect(loaded.entries).toHaveLength(3);
    expect(getVectorCacheStats().keys).toEqual(['profile:1']);

    // Filters by model, dims, allowedDocIds, contentHashesByChunkKey, and minScore
    const hits = searchTopVectors(scope, [1, 0, 0, 0], {
      expectedGeneration: gen1,
      model: 'm1',
      dims: 4,
      topK: 5,
      minScore: 0.5,
      contentHashesByChunkKey: new Map([
        ['doc-1:10', hash1],
        ['doc-2:20', 'stale-hash'], // mismatched hash must be excluded
        ['doc-3:30', hash3],
      ]),
    });
    expect(hits).toEqual([{ docId: 'doc-1', chunkId: 10, ord: 0, score: 1 }]);

    // Changing index_generation invalidates RAM cache automatically on next read
    const gen2 = bumpIndexGeneration(scope);
    expect(gen2).toBe(gen1 + 1);
    expect(getVectorCacheStats().entries).toBe(0);

    // Populate cache at gen2, then synchronously delete doc-1
    getScopeVectors(scope, gen2);
    expect(getVectorCacheStats().keys).toEqual(['profile:1']);

    const delRes = deleteDocVectors(scope, 'doc-1');
    expect(delRes.deleted).toBe(1);
    expect(delRes.newGeneration).toBe(gen2 + 1);
    expect(getVectorCacheStats().entries).toBe(0);

    const hitsAfterDelete = searchTopVectors(scope, [1, 0, 0, 0], {
      expectedGeneration: delRes.newGeneration,
      model: 'm1',
      dims: 4,
      topK: 5,
    });
    expect(hitsAfterDelete.map((h) => h.docId)).toEqual(['doc-2']);

    // Stale chunk cleanup and error status + getIndexStatus
    markChunkErrorBatch(scope, [
      {
        docId: 'doc-4',
        chunkId: 40,
        ord: 0,
        contentHash: 'h4',
        model: 'm1',
        dims: 4,
        errorText: 'rate limited',
      },
    ]);

    const status = getIndexStatus(
      scope,
      [
        { docId: 'doc-2', chunkId: 20, contentHash: hash2 },
        { docId: 'doc-4', chunkId: 40, contentHash: 'h4' },
        { docId: 'doc-5', chunkId: 50, contentHash: 'h5' }, // missing in DB -> pending
      ],
      'm1',
      4,
    );
    expect(status).toMatchObject({
      generation: delRes.newGeneration,
      totalChunks: 3,
      readyChunks: 1,
      pendingChunks: 1,
      errorChunks: 1,
      staleChunks: 1, // doc-3:30 is an orphan not in source chunks
      ready: false,
      percentComplete: 33,
      indexedModel: 'm1',
      indexedDimensions: 4,
    });

    // No-op when all existing rows are valid
    const noopClean = deleteStaleDocChunks(
      scope,
      new Set(['doc-2:20', 'doc-3:30', 'doc-4:40']),
    );
    expect(noopClean).toEqual({ deleted: 0, newGeneration: null });

    // Removes doc-3:30 and bumps generation
    const cleaned = deleteStaleDocChunks(scope, new Set(['doc-2:20', 'doc-4:40']));
    expect(cleaned.deleted).toBe(1);
    expect(cleaned.newGeneration).toBe(delRes.newGeneration + 1);
  });

  it('evicts least-recently-used scope vectors when cache budget is exceeded', () => {
    seedProfile(1);
    seedProfile(2);
    seedProfile(3);
    const s1 = { kind: 'profile' as const, id: '1' };
    const s2 = { kind: 'profile' as const, id: '2' };
    const s3 = { kind: 'profile' as const, id: '3' };

    // Each 64-dim vector is 64 * 4 = 256 bytes; budget 520 bytes holds 2 scopes max.
    setVectorCacheMaxBytesForTests(520);
    const vec = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

    for (const scope of [s1, s2, s3]) {
      markChunkReadyBatch(scope, [
        {
          docId: 'd1',
          chunkId: 1,
          ord: 0,
          contentHash: 'h',
          model: 'm',
          dims: 64,
          vector: vec,
        },
      ]);
    }

    getScopeVectors(s1, 1);
    getScopeVectors(s2, 1);
    expect(getVectorCacheStats()).toEqual({
      entries: 2,
      bytes: 512,
      maxBytes: 520,
      keys: ['profile:1', 'profile:2'],
    });

    // Access s1 again so s2 becomes least-recently-used
    getScopeVectors(s1, 1);
    expect(getVectorCacheStats().keys).toEqual(['profile:2', 'profile:1']);

    // Loading s3 must evict s2, keeping s1 and s3
    getScopeVectors(s3, 1);
    expect(getVectorCacheStats()).toEqual({
      entries: 2,
      bytes: 512,
      maxBytes: 520,
      keys: ['profile:1', 'profile:3'],
    });
  });

  it('records embedding usage and aggregates usage summaries by day and scope', () => {
    seedProfile(1);
    seedProfile(2);
    recordEmbeddingUsage({ kind: 'profile', id: '1' }, 'gemini-embedding-001', 'index', 120);
    recordEmbeddingUsage({ kind: 'profile', id: '1' }, 'gemini-embedding-001', 'index', 80);
    recordEmbeddingUsage({ kind: 'profile', id: '1' }, 'gemini-embedding-001', 'query', 15);
    recordEmbeddingUsage({ kind: 'profile', id: '2' }, 'bge-m3', 'query', 25);

    const allUsage = getRetrievalUsage({ days: 7 });
    expect(allUsage.days).toBe(7);
    expect(allUsage.totals).toEqual({
      inputTokens: 240,
      requests: 4,
      indexTokens: 200,
      queryTokens: 40,
    });
    expect(allUsage.rows).toHaveLength(3);

    const p1Usage = getRetrievalUsage({ days: 1, scope: { kind: 'profile', id: '1' } });
    expect(p1Usage.totals).toEqual({
      inputTokens: 215,
      requests: 3,
      indexTokens: 200,
      queryTokens: 15,
    });
    expect(p1Usage.rows.map((r) => [r.purpose, r.inputTokens, r.requests])).toEqual([
      ['index', 200, 2],
      ['query', 15, 1],
    ]);

    // purgeScope cleans retrieval tables for target scope only
    setRetrievalSettings({ kind: 'profile', id: '1' }, { mode: 'keyword' });
    setRetrievalSettings({ kind: 'profile', id: '2' }, { mode: 'keyword' });
    expect(purgeScope('profile', '1')).toBeGreaterThanOrEqual(3);
    expect(getRetrievalUsage({ scope: { kind: 'profile', id: '1' } }).rows).toEqual([]);
    expect(getRetrievalUsage({ scope: { kind: 'profile', id: '2' } }).rows).toHaveLength(1);
  });

  it('provides searchKnowledgeRanked and listProfileKnowledgeChunks while preserving searchKnowledge', () => {
    seedProfile(1);
    const shippingId = addDoc(
      1,
      'Giao hàng',
      'Chúng tôi giao hàng toàn quốc trong 2-4 ngày làm việc. Phí giao hàng 30.000đ.',
    );
    const returnsId = addDoc(
      1,
      'Đổi trả',
      'Khách hàng được đổi trả trong 7 ngày nếu sản phẩm còn nguyên tem mác.',
    );

    const chunks = listProfileKnowledgeChunks(1);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      docId: shippingId,
      ord: 0,
      title: 'Giao hàng',
    });
    expect(typeof chunks[0]?.chunkId).toBe('number');

    expect(listProfileKnowledgeChunks(1, returnsId)).toHaveLength(1);

    const legacyHits = searchKnowledge(1, 'Phí giao hàng bao nhiêu?', 3000);
    const rankedHits = searchKnowledgeRanked(1, 'Phí giao hàng bao nhiêu?', 3);
    expect(legacyHits.map((h) => h.docId)).toEqual([shippingId]);
    expect(rankedHits).toHaveLength(1);
    expect(rankedHits[0]).toMatchObject({
      docId: shippingId,
      chunkId: chunks[0]!.chunkId,
      ord: 0,
      title: 'Giao hàng',
      score: legacyHits[0]!.score,
    });
  });
});
