import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Scope } from '@freellmapi/shared/ai-platform-retrieval.js';
import { getDb, initDb } from '../../../db/index.js';
import { EmbeddingsError } from '../../../services/embeddings.js';
import {
  addDoc,
  deleteDoc,
  resetKnowledgeIndexes,
  updateDoc,
} from '../../../services/profile-knowledge.js';
import {
  deleteSupportKnowledgeDoc,
  upsertSupportKnowledgeDoc,
} from '../../../custom/x-gateway/support-knowledge.js';
import { createSupportTenant } from '../../../custom/x-gateway/support-store.js';
import {
  enqueueReindexJob,
  getScopeIndexSnapshot,
  loadSourceChunks,
  onDocumentChanged,
  onDocumentDeleted,
  processNextIndexJobOnce,
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  startIndexWorker,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import {
  getRetrievalSettingsInternal,
  resolveEffectiveEmbeddingModel,
  RetrievalStoreError,
  setRetrievalSettings,
} from '../../../custom/ai-platform/retrieval/settings.js';
import {
  getScopeVectors,
  invalidateVectorCache,
  markChunkReadyBatch,
} from '../../../custom/ai-platform/retrieval/vector-store.js';
import { createFakeEmbeddingsRunner, fakeEmbed } from '../../helpers/fake-embeddings.js';

function seedProfile(id = 1, name = 'indexer-test-profile'): Scope {
  getDb()
    .prepare(
      `INSERT INTO client_profiles (id, name, token_hash, encrypted_key, iv, auth_tag)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, `hash-${id}-${Math.random()}`, 'enc', 'iv', 'tag');
  return { kind: 'profile', id: String(id) };
}

describe('ai-platform retrieval indexer', () => {
  beforeEach(async () => {
    await initDb(':memory:');
    resetKnowledgeIndexes();
    invalidateVectorCache();
  });

  afterEach(() => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetKnowledgeIndexes();
    try {
      getDb()?.close?.();
    } catch {
      // ignore if already closed
    }
  });

  it('indexes chunks in batches of 64, records usage telemetry, and populates vector store', async () => {
    const scope = seedProfile(1);
    const totalDocs = 130; // 64 + 64 + 2 = 3 batches
    for (let i = 1; i <= totalDocs; i += 1) {
      addDoc(1, `Doc ${i}`, `Unique password reset policy number ${i} for customer portal.`);
    }

    const batchSizes: number[] = [];
    const baseRunner = createFakeEmbeddingsRunner({ dims: 768, modelId: 'text-embedding-3-small' });
    setEmbeddingsRunnerForTests(async (model, inputs, dims) => {
      batchSizes.push(inputs.length);
      return baseRunner(model, inputs, dims);
    });

    const job = enqueueReindexJob(scope, 'reindex');
    expect(job.status).toBe('queued');
    expect(job.totalChunks).toBe(totalDocs);

    await runPendingIndexJobsUntilIdle();

    expect(batchSizes).toEqual([64, 64, 2]);

    const snapshot = getScopeIndexSnapshot(scope);
    expect(snapshot.activeJob).toBeNull();
    expect(snapshot.status.totalChunks).toBe(totalDocs);
    expect(snapshot.status.readyChunks).toBe(totalDocs);
    expect(snapshot.status.pendingChunks).toBe(0);
    expect(snapshot.status.errorChunks).toBe(0);
    expect(snapshot.recentJobs[0]?.status).toBe('succeeded');
    expect(snapshot.recentJobs[0]?.processedChunks).toBe(totalDocs);

    const { indexGeneration } = getRetrievalSettingsInternal(scope);
    const vecs = getScopeVectors(scope, indexGeneration);
    expect(vecs.entries).toHaveLength(totalDocs);

    const usageRows = getDb()
      .prepare(
        `SELECT purpose, SUM(input_tokens) AS tokens, SUM(requests) AS reqs
         FROM custom_ai_embedding_usage
         WHERE scope_kind = 'profile' AND scope_id = '1'
         GROUP BY purpose`,
      )
      .all() as Array<{ purpose: string; tokens: number; reqs: number }>;
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]?.purpose).toBe('index');
    expect(usageRows[0]?.reqs).toBe(3);
    expect(usageRows[0]?.tokens).toBeGreaterThan(0);
  });

  it('enforces embeddingsRetryAfterSec backoff on 429 and resumes without re-embedding finished chunks', async () => {
    const scope = seedProfile(2);
    for (let i = 1; i <= 70; i += 1) {
      addDoc(2, `Guide ${i}`, `Billing invoice troubleshooting step ${i} for enterprise accounts.`);
    }

    const embeddedInputsHistory: string[][] = [];
    let callCount = 0;
    const baseRunner = createFakeEmbeddingsRunner({ dims: 768 });

    setEmbeddingsRunnerForTests(async (model, inputs, dims) => {
      callCount += 1;
      embeddedInputsHistory.push([...inputs]);
      // Batch 1 (64) succeeds; batch 2 (6) hits 429 with Retry-After 5s on first attempt, succeeds on retry.
      if (callCount === 2) {
        throw new EmbeddingsError('Rate limit exceeded', 429, 'rate_limited', 5_000);
      }
      return baseRunner(model, inputs, dims);
    });

    enqueueReindexJob(scope, 'reindex');
    const ran = await processNextIndexJobOnce();
    expect(ran).toBe(true);

    // 64 ready chunks saved, remaining 6 still pending, job back in queued with retry_after in future
    const midSnapshot = getScopeIndexSnapshot(scope);
    expect(midSnapshot.status.readyChunks).toBe(64);
    expect(midSnapshot.status.pendingChunks).toBe(6);
    expect(midSnapshot.activeJob).not.toBeNull();
    expect(midSnapshot.activeJob?.status).toBe('queued');
    expect(midSnapshot.activeJob?.lastError).toContain('Rate limit exceeded');
    expect(midSnapshot.activeJob?.retryAfter).toBeTruthy();
    expect(Date.parse(midSnapshot.activeJob!.retryAfter!)).toBeGreaterThan(Date.now());

    // Respecting retry_after: calling immediately should NOT invoke embedder again
    const skippedWhileBackedOff = await processNextIndexJobOnce({ respectRetryAfter: true });
    expect(skippedWhileBackedOff).toBe(false);
    expect(callCount).toBe(2);

    // Once retry window passes (bypass backoff check in test), ONLY the remaining 6 chunks get embedded
    await runPendingIndexJobsUntilIdle({ respectRetryAfter: false });

    expect(callCount).toBe(3);
    expect(embeddedInputsHistory.map((b) => b.length)).toEqual([64, 6, 6]);

    const finalSnapshot = getScopeIndexSnapshot(scope);
    expect(finalSnapshot.activeJob).toBeNull();
    expect(finalSnapshot.status.readyChunks).toBe(70);
    expect(finalSnapshot.recentJobs[0]?.status).toBe('succeeded');
  });

  it('recovers interrupted running jobs on startIndexWorker without re-embedding ready chunks', async () => {
    const scope = seedProfile(3);
    for (let i = 1; i <= 70; i += 1) {
      addDoc(3, `SSO Doc ${i}`, `SAML identity provider setup step ${i} with Okta metadata.`);
    }

    const sourceChunks = loadSourceChunks(scope);
    expect(sourceChunks).toHaveLength(70);

    setRetrievalSettings(scope, { mode: 'hybrid', dimensions: 768 });
    const targetModel = resolveEffectiveEmbeddingModel(scope).model!;
    expect(targetModel).toBeTruthy();

    // Simulate 64 chunks already finished before a process restart/crash
    const firstBatch = sourceChunks.slice(0, 64);
    markChunkReadyBatch(
      scope,
      firstBatch.map((c) => ({
        docId: c.docId,
        chunkId: c.chunkId,
        ord: c.ord,
        contentHash: c.contentHash,
        model: targetModel,
        dims: 768,
        vector: fakeEmbed(`${c.title}\n\n${c.text}`, 768),
      })),
    );

    const seededJob = enqueueReindexJob(scope, 'reindex');
    getDb()
      .prepare(
        `UPDATE custom_ai_index_jobs
         SET status = 'running', processed_chunks = 64
         WHERE id = ?`,
      )
      .run(seededJob.id);

    // Before recovery, processNextIndexJobOnce ignores 'running' rows
    expect(await processNextIndexJobOnce()).toBe(false);

    const embeddedSizes: number[] = [];
    const baseRunner = createFakeEmbeddingsRunner({ dims: 768 });
    setEmbeddingsRunnerForTests(async (model, inputs, dims) => {
      embeddedSizes.push(inputs.length);
      return baseRunner(model, inputs, dims);
    });

    // startIndexWorker resets crashed 'running' jobs back to 'queued'
    startIndexWorker(60_000);
    stopIndexWorker();

    await runPendingIndexJobsUntilIdle();

    // Only the 6 unfinished chunks were embedded!
    expect(embeddedSizes).toEqual([6]);
    expect(getScopeIndexSnapshot(scope).status.readyChunks).toBe(70);
  });

  it('synchronously removes vectors on onDocumentChanged / onDocumentDeleted and incrementally re-indexes', async () => {
    const scope = seedProfile(4);
    const d1 = addDoc(4, 'Shipping Policy', 'Express courier delivery takes two business days.');
    const d2 = addDoc(4, 'Warranty Policy', 'Hardware warranty lasts twenty four months.');

    const embeddedTexts: string[] = [];
    const baseRunner = createFakeEmbeddingsRunner({ dims: 768 });
    setEmbeddingsRunnerForTests(async (model, inputs, dims) => {
      embeddedTexts.push(...inputs);
      return baseRunner(model, inputs, dims);
    });

    enqueueReindexJob(scope, 'doc_add');
    await runPendingIndexJobsUntilIdle();

    const genBefore = getRetrievalSettingsInternal(scope).indexGeneration;
    expect(getScopeVectors(scope, genBefore).entries).toHaveLength(2);

    embeddedTexts.length = 0;
    updateDoc(4, d1, 'Shipping Policy', 'Overnight air freight arrives next morning.');

    await onDocumentChanged(scope, String(d1));

    const genAfterEdit = getRetrievalSettingsInternal(scope).indexGeneration;
    expect(genAfterEdit).toBeGreaterThan(genBefore);

    // Stale doc1 vector MUST be gone immediately, while doc2 remains intact
    const vectorsAfterEdit = getScopeVectors(scope, genAfterEdit);
    expect(vectorsAfterEdit.entries.map((e) => e.docId)).toEqual([String(d2)]);
    expect(getScopeIndexSnapshot(scope).activeJob?.reason).toBe('doc_edit');

    // Finish background job: only doc1 should be re-embedded (doc2 is skipped)
    await runPendingIndexJobsUntilIdle();
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain('Overnight air freight');

    const genReady = getRetrievalSettingsInternal(scope).indexGeneration;
    expect(getScopeVectors(scope, genReady).entries).toHaveLength(2);

    // Delete doc1 synchronously
    deleteDoc(4, d1);
    await onDocumentDeleted(scope, String(d1));

    const genAfterDelete = getRetrievalSettingsInternal(scope).indexGeneration;
    expect(genAfterDelete).toBeGreaterThan(genReady);
    expect(getScopeVectors(scope, genAfterDelete).entries.map((e) => e.docId)).toEqual([
      String(d2),
    ]);
  });

  it('enforces at most one active job per scope (throws 409 when requested or coalesces)', () => {
    const scope = seedProfile(5);
    addDoc(5, 'FAQ', 'How to export workspace audit logs in CSV format.');

    const job1 = enqueueReindexJob(scope, 'reindex', { throwOnActive: true });
    expect(job1.status).toBe('queued');

    expect(() => enqueueReindexJob(scope, 'reindex', { throwOnActive: true })).toThrowError(
      RetrievalStoreError,
    );
    try {
      enqueueReindexJob(scope, 'reindex', { throwOnActive: true });
    } catch (err) {
      expect(err).toBeInstanceOf(RetrievalStoreError);
      expect((err as RetrievalStoreError).code).toBe('job_already_running');
      expect((err as RetrievalStoreError).status).toBe(409);
    }

    // Coalescing mode (default throwOnActive: false) reuses existing active row
    const job2 = enqueueReindexJob(scope, 'doc_edit');
    expect(job2.id).toBe(job1.id);

    const activeCount = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS cnt FROM custom_ai_index_jobs
           WHERE scope_kind = 'profile' AND scope_id = '5' AND status IN ('queued', 'running')`,
        )
        .get() as { cnt: number }
    ).cnt;
    expect(activeCount).toBe(1);
  });

  it('marks job failed and chunks error on non-retryable embedding failure, and supports support_tenant/agent scopes', async () => {
    const scope = seedProfile(6);
    addDoc(6, 'Billing', 'Invoice PDF download instructions for admins.');

    setEmbeddingsRunnerForTests(async () => {
      throw new EmbeddingsError('Unknown embedding model', 400, 'invalid_model');
    });

    enqueueReindexJob(scope, 'reindex');
    await processNextIndexJobOnce();

    const failSnap = getScopeIndexSnapshot(scope);
    expect(failSnap.activeJob).toBeNull();
    expect(failSnap.recentJobs[0]?.status).toBe('failed');
    expect(failSnap.recentJobs[0]?.lastError).toContain('Unknown embedding model');
    expect(failSnap.status.errorChunks).toBe(1);

    // Support tenant scope indexing
    const { tenant } = createSupportTenant({ name: 'Support Co', slug: 'support-co-idx' });
    const supportScope: Scope = { kind: 'support_tenant', id: String(tenant.id) };
    const doc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'TLS Mutual Auth',
      category: 'security',
      content: 'Upload a client certificate bundle for mTLS API access.',
      allowedRoles: ['admin'],
      enabled: true,
    });

    setEmbeddingsRunnerForTests(createFakeEmbeddingsRunner({ dims: 768 }));
    enqueueReindexJob(supportScope, 'doc_add');
    await runPendingIndexJobsUntilIdle();

    const supportSnap = getScopeIndexSnapshot(supportScope);
    expect(supportSnap.status.totalChunks).toBe(1);
    expect(supportSnap.status.readyChunks).toBe(1);

    await onDocumentDeleted(supportScope, String(doc.id));
    deleteSupportKnowledgeDoc(String(tenant.id), doc.id);

    // Agent scope gracefully succeeds with 0 chunks
    const agentScope: Scope = { kind: 'agent', id: 'triage-agent' };
    enqueueReindexJob(agentScope, 'reindex');
    await runPendingIndexJobsUntilIdle();
    const agentSnap = getScopeIndexSnapshot(agentScope);
    expect(agentSnap.status.totalChunks).toBe(0);
    expect(agentSnap.recentJobs[0]?.status).toBe('succeeded');
  });
});
