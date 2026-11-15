import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RETRIEVAL_LIMITS, type Scope } from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb, initDb } from '../../../db/index.js';
import {
  addDoc,
  resetKnowledgeIndexes,
  searchKnowledge,
} from '../../../services/profile-knowledge.js';
import { upsertSupportKnowledgeDoc } from '../../../custom/x-gateway/support-knowledge.js';
import { createSupportTenant } from '../../../custom/x-gateway/support-store.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  retrieve,
  setQueryEmbeddingsRunnerForTests,
} from '../../../custom/ai-platform/retrieval/hybrid.js';
import {
  enqueueReindexJob,
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { setRetrievalSettings } from '../../../custom/ai-platform/retrieval/settings.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { createFakeEmbeddingsRunner } from '../../helpers/fake-embeddings.js';

function seedProfile(id = 1, name = 'hybrid-test-profile'): Scope {
  getDb()
    .prepare(
      `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, `hash-${id}-${Math.random()}`, 'enc', 'iv', 'tag');
  return { kind: 'profile', id: String(id) };
}

function makeBasisVector(dims: number, weights: Array<[number, number]>): number[] {
  const vec = new Array<number>(dims).fill(0);
  for (const [idx, val] of weights) {
    vec[idx] = val;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  return vec.map((v) => v * inv);
}

describe('ai-platform hybrid retrieval', () => {
  beforeEach(async () => {
    await initDb(':memory:');
    resetKnowledgeIndexes();
    invalidateVectorCache();
    resetFlagsCacheForTests();
  });

  afterEach(() => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetKnowledgeIndexes();
    resetFlagsCacheForTests();
    try {
      getDb()?.close?.();
    } catch {
      // ignore if already closed
    }
  });

  it('fuses keyword and semantic rankings using RRF k=60, normalized scores, and respects minScore / topK limits', async () => {
    const scope = seedProfile(1);
    // Doc 1: strongest keyword match for "alpha protocol", weak semantic vector (rank 3 semantic)
    const d1 = addDoc(
      1,
      'Alpha Protocol Reference',
      'alpha protocol specification guide with configuration details.',
    );
    // Doc 2: #2 keyword match for "alpha protocol", strongest semantic vector (rank 1 semantic)
    const d2 = addDoc(
      1,
      'Security Notes',
      'alpha protocol handshake and zero-trust validation details.',
    );
    // Doc 3: zero keyword match for "alpha protocol", #2 semantic vector
    const d3 = addDoc(1, 'Identity Guide', 'federated single sign-on certificate exchange.');

    setRetrievalSettings(scope, { mode: 'hybrid', dimensions: 64, topK: 5, minScore: 0.25 });

    // Craft exact orthogonal-ish 64D vectors so semantic ranking is strictly d2 (#1), d3 (#2), d1 (#3)
    const unit = makeBasisVector(64, [[0, 1]]);
    const second = makeBasisVector(64, [
      [0, 0.8],
      [1, 0.6],
    ]);
    const third = makeBasisVector(64, [
      [0, 0.4],
      [2, 0.9165],
    ]);

    setEmbeddingsRunnerForTests(async (_model, inputs) => ({
      family: 'test-model',
      platform: 'fake',
      vectors: inputs.map((text) => {
        if (text.includes('Security Notes')) return unit;
        if (text.includes('Identity Guide')) return second;
        if (text.includes('Alpha Protocol Reference')) return third;
        return unit;
      }),
      modelId: 'test-model',
      dimensions: 64,
      inputTokens: inputs.length * 5,
    }));

    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();

    const res = await retrieve(scope, 'alpha protocol');
    expect(res.modeRequested).toBe('hybrid');
    expect(res.modeUsed).toBe('hybrid');
    expect(res.degraded).toBe(false);
    expect(res.hits).toHaveLength(3);

    // d2 is kwRank=2, semRank=1 => (1/62 + 1/61) / (2/61) = ~0.9919
    // d1 is kwRank=1, semRank=3 => (1/61 + 1/63) / (2/61) = ~0.9839
    // d3 is kwRank=undefined, semRank=2 => (1/62) / (2/61) = ~0.4919
    expect(res.hits.map((h) => Number(h.docId))).toEqual([d2, d1, d3]);
    expect(res.hits[0]).toMatchObject({
      docId: String(d2),
      keywordRank: 2,
      semanticRank: 1,
      sources: ['keyword', 'semantic'],
    });
    const expectedTopRrf = Math.round(((1 / 62 + 1 / 61) / (2 / 61)) * 10_000) / 10_000;
    expect(res.hits[0]!.score).toBeCloseTo(expectedTopRrf, 4);

    expect(res.hits[2]).toMatchObject({
      docId: String(d3),
      semanticRank: 2,
      sources: ['semantic'],
    });
    expect(res.hits[2]!.keywordRank).toBeUndefined();
    expect(res.hits[2]!.score).toBeCloseTo((1 / 62) / (2 / 61), 4);

    // High minScore filters out single-source d3 (~0.49)
    const highThreshold = await retrieve(scope, 'alpha protocol', { minScore: 0.8 });
    expect(highThreshold.hits.map((h) => Number(h.docId))).toEqual([d2, d1]);

    // Citations mirror returned hits
    expect(res.citations.map((c) => c.docId)).toEqual(res.hits.map((h) => h.docId));

    // Verify topK capped at RETRIEVAL_LIMITS.maxTopK (20)
    const scope2 = seedProfile(2);
    for (let i = 1; i <= 25; i += 1) {
      addDoc(2, `Quota Rule ${i}`, `quota rate limit burst allowance policy section ${i}.`);
    }
    setRetrievalSettings(scope2, { mode: 'hybrid', dimensions: 64, topK: 5, minScore: 0.25 });
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 64 }));
    enqueueReindexJob(scope2, 'reindex');
    await runPendingIndexJobsUntilIdle();

    const capped = await retrieve(scope2, 'quota rate limit', { topK: 99 });
    expect(capped.hits.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.maxTopK);
    expect(capped.hits.length).toBe(20);
  });

  it('returns exact searchKnowledge parity when mode is keyword', async () => {
    const scope = seedProfile(3);
    addDoc(3, 'Refund Timeline', 'Refunds take 5 to 7 business days back to your card.');
    addDoc(3, 'Damaged Delivery', 'Damaged items qualify for an instant refund or replacement.');
    addDoc(3, 'Shipping Zones', 'International courier shipping reaches 40 countries.');

    setRetrievalSettings(scope, { mode: 'keyword', topK: 5, minScore: 0.25 });

    const baseline = searchKnowledge(3, 'refund days', 100_000);
    const res = await retrieve(scope, 'refund days', { topK: 5 });

    expect(res.modeRequested).toBe('keyword');
    expect(res.modeUsed).toBe('keyword');
    expect(res.degraded).toBe(false);
    expect(res.degradedReason).toBeUndefined();
    expect(res.hits.map((h) => ({ docId: Number(h.docId), title: h.title, text: h.text }))).toEqual(
      baseline.map((b) => ({ docId: b.docId, title: b.title, text: b.text })),
    );
    expect(res.hits.every((h) => h.sources.length === 1 && h.sources[0] === 'keyword')).toBe(true);
    expect(res.hits.every((h) => h.semanticRank === undefined)).toBe(true);
  });

  it('gracefully falls back to keyword on index_not_ready, no_model, timeout, embedding_error, and pillar_disabled', async () => {
    const scope = seedProfile(4);
    addDoc(4, 'API Keys', 'Rotate expired API credentials from the workspace security tab.');
    setRetrievalSettings(scope, { mode: 'hybrid', dimensions: 768 });

    // 1. index_not_ready: enabled model exists in DB, but 0 ready vectors indexed
    const noIdx = await retrieve(scope, 'API credentials');
    expect(noIdx.modeUsed).toBe('keyword');
    expect(noIdx.degraded).toBe(true);
    expect(noIdx.degradedReason).toBe('index_not_ready');
    expect(noIdx.hits).toHaveLength(1);

    // Index the document so vectors ARE ready for timeout / error / pillar tests
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();

    // 2. timeout (> queryTimeoutMs)
    setQueryEmbeddingsRunnerForTests(
      async () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                family: 'slow-model',
                platform: 'fake',
                vectors: [new Array<number>(768).fill(0.1)],
                modelId: 'slow-model',
                dimensions: 768,
                inputTokens: 2,
              }),
            200,
          ),
        ),
    );
    const timedOut = await retrieve(scope, 'API credentials', { queryTimeoutMs: 15 });
    expect(timedOut.modeUsed).toBe('keyword');
    expect(timedOut.degraded).toBe(true);
    expect(timedOut.degradedReason).toBe('timeout');
    expect(timedOut.hits).toHaveLength(1);

    // 3. embedding_error (provider throws)
    setQueryEmbeddingsRunnerForTests(async () => {
      throw new Error('upstream 502 bad gateway');
    });
    const errored = await retrieve(scope, 'API credentials');
    expect(errored.modeUsed).toBe('keyword');
    expect(errored.degraded).toBe(true);
    expect(errored.degradedReason).toBe('embedding_error');
    expect(errored.hits).toHaveLength(1);

    // 4. embedding_error (dimension mismatch returned)
    setQueryEmbeddingsRunnerForTests(async () => ({
      family: 'bad-dims',
      platform: 'fake',
      vectors: [new Array<number>(128).fill(0.5)],
      modelId: 'bad-dims',
      dimensions: 128,
      inputTokens: 2,
    }));
    const badDims = await retrieve(scope, 'API credentials');
    expect(badDims.modeUsed).toBe('keyword');
    expect(badDims.degraded).toBe(true);
    expect(badDims.degradedReason).toBe('embedding_error');

    // 5. pillar_disabled when respectPillarFlag is enabled and flag is false
    setQueryEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    setFlags({ retrieval: false });
    const pillarOff = await retrieve(scope, 'API credentials', { respectPillarFlag: true });
    expect(pillarOff.modeUsed).toBe('keyword');
    expect(pillarOff.degraded).toBe(true);
    expect(pillarOff.degradedReason).toBe('pillar_disabled');
    expect(pillarOff.hits).toHaveLength(1);

    // 6. no_model when embedding_models disabled/cleared and no test runner overrides
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    getDb().prepare('UPDATE embedding_models SET enabled = 0').run();

    const noModel = await retrieve(scope, 'API credentials');
    expect(noModel.modeUsed).toBe('keyword');
    expect(noModel.degraded).toBe(true);
    expect(noModel.degradedReason).toBe('no_model');
    expect(noModel.hits).toHaveLength(1);
  });

  it('enforces allowedRoles strictly in support_tenant scope across keyword, semantic, and hybrid modes', async () => {
    const { tenant } = createSupportTenant({ name: 'Acme Support', slug: 'acme-hybrid-rbac' });
    const scope: Scope = { kind: 'support_tenant', id: String(tenant.id) };

    const publicDoc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Public Password Reset',
      category: 'auth',
      content: 'Forgot password reset link instructions for any portal visitor.',
      allowedRoles: ['*'],
      enabled: true,
    });
    const customerDoc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Customer Refund Portal',
      category: 'billing',
      content: 'Signed-in customers request password reset and refund status in billing.',
      allowedRoles: ['customer'],
      enabled: true,
    });
    const adminDoc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Admin Internal Password Override Secret',
      category: 'internal',
      content: 'Internal administrator root password reset token vault secret procedure.',
      allowedRoles: ['admin'],
      enabled: true,
    });
    const disabledDoc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Disabled Old Password Guide',
      category: 'archive',
      content: 'Deprecated password reset procedure disabled.',
      allowedRoles: ['*'],
      enabled: false,
    });

    setRetrievalSettings(scope, { mode: 'hybrid', dimensions: 768, topK: 10, minScore: 0.1 });
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();

    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      // Anonymous / empty role array => ONLY public ('*') docs allowed
      const anonRes = await retrieve(scope, 'password reset procedure', { mode, roles: [] });
      const anonIds = anonRes.hits.map((h) => h.docId);
      expect(anonIds).toContain(publicDoc.id);
      expect(anonIds).not.toContain(customerDoc.id);
      expect(anonIds).not.toContain(adminDoc.id);
      expect(anonIds).not.toContain(disabledDoc.id);
      expect(anonRes.citations.every((c) => c.docId === publicDoc.id)).toBe(true);

      // Customer role => public + customer, NEVER admin or disabled
      const custRes = await retrieve(scope, 'password reset procedure', {
        mode,
        roles: ['customer'],
      });
      const custIds = custRes.hits.map((h) => h.docId);
      expect(custIds).toContain(publicDoc.id);
      expect(custIds).toContain(customerDoc.id);
      expect(custIds).not.toContain(adminDoc.id);
      expect(custIds).not.toContain(disabledDoc.id);

      // Admin role => public + admin
      const adminRes = await retrieve(scope, 'root password vault', {
        mode,
        roles: ['admin'],
      });
      expect(adminRes.hits.map((h) => h.docId)).toContain(adminDoc.id);
      expect(adminRes.hits.map((h) => h.docId)).not.toContain(customerDoc.id);
    }

    // Multi-role union ['customer', 'vip'] still never reveals admin-only docs
    const multiRes = await retrieve(scope, 'password reset refund vault', {
      mode: 'hybrid',
      roles: ['customer', 'vip'],
    });
    expect(multiRes.hits.map((h) => h.docId)).not.toContain(adminDoc.id);
  });

  it('retrieves conceptual matches in pure semantic mode and logs query token usage', async () => {
    const scope = seedProfile(5);
    const ssoDoc = addDoc(
      5,
      'Enterprise Identity',
      'Configure SAML single sign-on integration with Okta XML metadata.',
    );
    addDoc(5, 'Shipping Rates', 'Standard parcel postage fees for domestic deliveries.');

    setRetrievalSettings(scope, { mode: 'semantic', dimensions: 768, topK: 5, minScore: 0.2 });
    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    enqueueReindexJob(scope, 'reindex');
    await runPendingIndexJobsUntilIdle();

    // Query shares zero literal words with SAML doc if keywords are paraphrased
    const semRes = await retrieve(scope, 'corporate login provider federation', { mode: 'semantic' });
    expect(semRes.modeUsed).toBe('semantic');
    expect(semRes.degraded).toBe(false);
    expect(semRes.hits[0]?.docId).toBe(String(ssoDoc));
    expect(semRes.hits[0]?.sources).toEqual(['semantic']);
    expect(semRes.hits[0]?.semanticRank).toBe(1);
    expect(semRes.hits[0]?.keywordRank).toBeUndefined();

    const usage = getDb()
      .prepare(
        `SELECT SUM(input_tokens) AS tokens, SUM(requests) AS reqs
         FROM custom_ai_embedding_usage
         WHERE scope_kind = 'profile' AND scope_id = '5' AND purpose = 'query'`,
      )
      .get() as { tokens: number; reqs: number };
    expect(usage.reqs).toBe(1);
    expect(usage.tokens).toBeGreaterThan(0);
  });
});
