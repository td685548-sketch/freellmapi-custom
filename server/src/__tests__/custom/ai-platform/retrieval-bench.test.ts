/**
 * Worker 3 — Retrieval Pillar Benchmark & End-to-End Integration Suite
 *
 * Verifies:
 * - SC-008: 50-page synthetic corpus indexes in < 2 minutes with < 10% chat latency overhead
 *           while background indexing is active.
 * - SC-010: Top-K vector search over 50,000 chunks completes in < 150ms (warm cache).
 * - Multi-filter `installInterceptor` composition (`outputGuard` + `citationFilter`) + `onResponseObject`
 * - Pipeline Slot 6 (`injectKnowledge` deferral, wire injection, citation headers & opt-out, flag-off parity)
 * - Retrieval Admin Router (`/overview`, `/retrieval/usage`, `/retrieval/:scope`, `/reindex`, `/query`, RBAC)
 * - Support Knowledge & Runtime integration (role-scoped semantic/hybrid RAG, `required` mode preserved)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CITATIONS_HEADER_NAME,
  RETRIEVAL_HEADER_NAME,
  RETRIEVAL_LIMITS,
  type RetrievalQueryResponse,
  type RetrievalScopeStatusResponse,
  type RetrievalUsageResponse,
  type Scope,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getPolicy, setPolicy } from '../../../custom/ai-platform/output-guard/policy.js';
import { setQueryEmbeddingsRunnerForTests } from '../../../custom/ai-platform/retrieval/hybrid.js';
import {
  enqueueReindexJob,
  getScopeIndexSnapshot,
  setEmbeddingsRunnerForTests,
  startIndexWorker,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { getRetrievalSettingsInternal } from '../../../custom/ai-platform/retrieval/settings.js';
import {
  computeContentHash,
  encodeVectorBlob,
  getScopeVectors,
  invalidateVectorCache,
  searchTopVectors,
} from '../../../custom/ai-platform/retrieval/vector-store.js';
import {
  listSupportKnowledgeChunks,
  searchSupportKnowledgeRanked,
  upsertSupportKnowledgeDoc,
} from '../../../custom/x-gateway/support-knowledge.js';
import { executeSupportTurn } from '../../../custom/x-gateway/support-runtime.js';
import { ensureSupportRuntimeTables } from '../../../custom/x-gateway/support-runtime-store.js';
import { createSupportTenant, ensureSupportTables } from '../../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { addDoc, resetKnowledgeIndexes, setKnowledgeSettings } from '../../../services/profile-knowledge.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';
import { createFakeEmbeddingsRunner } from '../../helpers/fake-embeddings.js';

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function makeNormalizedVector(dims: number, seed: number): Float32Array {
  const vec = new Float32Array(dims);
  let state = (seed >>> 0) || 1;
  let normSq = 0;
  for (let i = 0; i < dims; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    const val = (state / 0x100000000) * 2 - 1;
    vec[i] = val;
    normSq += val * val;
  }
  const inv = normSq > 0 ? 1 / Math.sqrt(normSq) : 1;
  for (let i = 0; i < dims; i++) {
    vec[i] = vec[i]! * inv;
  }
  return vec;
}

describe('Retrieval Pillar Benchmark & Integration (SC-008, SC-010, Slot 6, Admin, Support)', () => {
  const realFetch = global.fetch;
  let appServer: http.Server;
  let baseUrl = '';
  let fakeProvider: FakeProviderServer;
  let primaryId = 0;
  let primaryToken = '';
  let viewerToken = '';
  let editorToken = '';
  let benchProfileId = 0;
  let benchClientKey = '';
  let integrationProfileId = 0;
  let integrationClientKey = '';

  async function apiCall<T = Record<string, unknown>>(
    urlPath: string,
    opts?: {
      token?: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; headers: Headers; body: T | null }> {
    const res = await realFetch(`${baseUrl}${urlPath}`, {
      method: opts?.method ?? 'GET',
      headers: {
        ...(opts?.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts?.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(opts?.headers ?? {}),
      },
      body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, headers: res.headers, body };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';

    fakeProvider = await startFakeProviderServer();
    initDb(':memory:');
    resetKnowledgeIndexes();
    resetFlagsCacheForTests();
    setKeyCacheTestOverride(true);

    const enc = encrypt('gsk_retrieval_bench');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'groq-retrieval-bench', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    appServer = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

    primaryId = createUser('retrieval-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const viewerId = createUser('retrieval-viewer@example.com', 'Password123!', 'member').userId;
    setUserPermissions(viewerId, ['view_retrieval'], primaryId);
    viewerToken = createSession(viewerId);

    const editorId = createUser('retrieval-editor@example.com', 'Password123!', 'member').userId;
    setUserPermissions(editorId, ['view_retrieval', 'edit_retrieval'], primaryId);
    editorToken = createSession(editorId);

    const makeProfile = async (name: string) => {
      const res = await apiCall<{ id: number; key: string }>('/api/client-profiles', {
        token: primaryToken,
        method: 'POST',
        body: { name, systemPrompt: 'Answer support questions concisely.' },
      });
      expect(res.status).toBe(201);
      await apiCall(`/api/client-profiles/${res.body!.id}/quota`, {
        token: primaryToken,
        method: 'PUT',
        body: { rpmLimit: null },
      });
      setKnowledgeSettings(res.body!.id, { enabled: true, maxChars: 2000 });
      return res.body!;
    };

    const benchProf = await makeProfile('retrieval-bench-profile');
    benchProfileId = benchProf.id;
    benchClientKey = benchProf.key;

    const intProf = await makeProfile('retrieval-integration-profile');
    integrationProfileId = intProf.id;
    integrationClientKey = intProf.key;

    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });
  });

  afterAll(async () => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    invalidateVectorCache();
    resetFlagsCacheForTests();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await fakeProvider.close();
  });

  it('SC-008: indexes a 50-page corpus in < 2 min with < 10% concurrent chat latency overhead', async () => {
    resetFlagsCacheForTests();
    setFlags({ retrieval: true, outputGuard: false });

    const baseRunner = createFakeEmbeddingsRunner(768);
    // Simulate realistic multi-tick async embedding batches during background indexing,
    // while single-input query embeddings resolve immediately so baseline vs active-index
    // isolates background indexing overhead cleanly.
    setEmbeddingsRunnerForTests(async (model, inputs, dims) => {
      if (inputs.length > 1) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return baseRunner(model, inputs, dims);
    });
    setQueryEmbeddingsRunnerForTests(baseRunner);

    // Seed 50 synthetic multi-paragraph pages (~150 chunks, >450 chars per section so passages stay distinct).
    const scope: Scope = { kind: 'profile', id: String(benchProfileId) };
    const filler =
      'Standard operating procedure applies across regional distribution hubs, regional partner warehouses, automated settlement ledgers, audit trails, and enterprise service-level commitments. '.repeat(2);
    for (let i = 1; i <= 50; i++) {
      const content = [
        `Page ${i} Shipping & Billing Policy: Enterprise orders above $${i * 10} include priority tracking. ${filler}`,
        `Page ${i} Refund Window: Digital invoices for batch-${i} may be disputed within 30 calendar days. ${filler}`,
        `Page ${i} API Quotas: Client gateway tier-${i} grants burst capacity for verified billing accounts. ${filler}`,
      ].join('\n\n');
      addDoc(benchProfileId, `Policy Manual Page ${i}`, content);
    }

    fakeProvider.setDefaultReply(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { kind: 'scripted', text: 'Enterprise orders include priority tracking and 30-day invoice review.' };
    });

    const runChatProbe = async (): Promise<number> => {
      const t0 = performance.now();
      const res = await apiCall('/v1/chat/completions', {
        token: benchClientKey,
        method: 'POST',
        body: {
          model: 'groq/compound',
          messages: [{ role: 'user', content: 'What is the refund window for enterprise orders?' }],
        },
      });
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      return elapsed;
    };

    // Warmup
    await runChatProbe();
    await runChatProbe();

    // Baseline chat latency when index worker is idle
    const baselineSamples: number[] = [];
    for (let i = 0; i < 8; i++) {
      baselineSamples.push(await runChatProbe());
    }
    const baselineMedianMs = percentile(baselineSamples, 50);

    // Start 50-page full reindex and run chat requests concurrently while background indexing runs
    stopIndexWorker();
    startIndexWorker(25);
    const indexStartMs = performance.now();
    enqueueReindexJob(scope, 'reindex', { throwOnActive: false });

    const duringSamples: number[] = [];
    for (let i = 0; i < 8; i++) {
      duringSamples.push(await runChatProbe());
    }
    const duringMedianMs = percentile(duringSamples, 50);

    // Wait for full 50-page corpus indexing to complete
    let ready = false;
    while (!ready && performance.now() - indexStartMs < 15_000) {
      const snap = getScopeIndexSnapshot(scope);
      if (snap.status.ready && snap.status.totalChunks >= 150) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    const totalIndexMs = performance.now() - indexStartMs;

    expect(ready).toBe(true);
    expect(totalIndexMs).toBeLessThan(120_000);
    // Overhead budget: <= 10% over simulated 80ms upstream chat baseline
    expect(duringMedianMs).toBeLessThanOrEqual(baselineMedianMs * 1.1);

    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
    fakeProvider.setDefaultReply(null);
  }, 30_000);

  it('SC-010: searches 50,000 chunk vectors in < 150ms (p95)', () => {
    invalidateVectorCache();
    const dims = 768;
    const chunkCount = 50_000;
    const scope: Scope = { kind: 'profile', id: String(integrationProfileId) };
    const { indexGeneration } = getRetrievalSettingsInternal(scope);
    const modelName = 'bench-768';

    const db = getDb();
    // Seed 50,000 ready chunk vectors in one transaction so benchmark focuses on vector query speed.
    const baseVec = makeNormalizedVector(dims, 42);
    const baseBlob = encodeVectorBlob(baseVec);
    const altBlob = encodeVectorBlob(makeNormalizedVector(dims, 99));

    const insertStmt = db.prepare(
      `INSERT OR REPLACE INTO custom_ai_chunk_embeddings
        (scope_kind, scope_id, doc_id, chunk_id, ord, content_hash, model, dims, vector, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', datetime('now'))`,
    );

    const insertTx = db.transaction(() => {
      for (let i = 1; i <= chunkCount; i++) {
        const blob = i % 10 === 0 ? baseBlob : altBlob;
        insertStmt.run(
          scope.kind,
          scope.id,
          `doc_${Math.ceil(i / 5)}`,
          i,
          (i - 1) % 5,
          computeContentHash(`Title ${i}`, `Text ${i}`),
          modelName,
          dims,
          blob,
        );
      }
    });
    insertTx();

    // Warm the scope vector cache
    const cached = getScopeVectors(scope, indexGeneration);
    expect(cached.entries.length).toBe(chunkCount);

    const queryVec = makeNormalizedVector(dims, 42);
    const latenciesMs: number[] = [];
    for (let run = 0; run < 10; run++) {
      const t0 = performance.now();
      const hits = searchTopVectors(scope, queryVec, {
        expectedGeneration: indexGeneration,
        model: modelName,
        dims,
        topK: RETRIEVAL_LIMITS.defaultTopK,
        minScore: RETRIEVAL_LIMITS.defaultMinScore,
      });
      const elapsed = performance.now() - t0;
      latenciesMs.push(elapsed);
      expect(hits).toHaveLength(5);
      expect(hits[0]!.score).toBeGreaterThan(0.99);
    }

    const p95Ms = percentile(latenciesMs, 95);
    expect(p95Ms).toBeLessThan(150);

    db.prepare('DELETE FROM custom_ai_chunk_embeddings WHERE scope_kind = ? AND scope_id = ?').run(
      scope.kind,
      scope.id,
    );
    invalidateVectorCache(scope);
  }, 30_000);

  it('wires Slot 6, multi-filter interceptor (outputGuard + citationFilter), headers, opt-out, and admin API', async () => {
    invalidateVectorCache();
    const fakeRunner = createFakeEmbeddingsRunner(768);
    setEmbeddingsRunnerForTests(fakeRunner);
    setQueryEmbeddingsRunnerForTests(fakeRunner);

    // Overview reports retrieval pillar ready even while flag is false
    resetFlagsCacheForTests();
    setFlags({ retrieval: false, outputGuard: false });
    const overviewOff = await apiCall<{ pillars: Record<string, { enabled: boolean; ready: boolean }> }>(
      '/api/ai-platform/overview',
      { token: primaryToken },
    );
    expect(overviewOff.status).toBe(200);
    expect(overviewOff.body?.pillars.retrieval).toMatchObject({ enabled: false, ready: true });

    // Admin RBAC & static /usage route before dynamic /:scopeKind/:scopeId
    const usageBadDays = await apiCall('/api/ai-platform/retrieval/usage?days=0', { token: viewerToken });
    expect(usageBadDays.status).toBe(400);
    const usageOk = await apiCall<RetrievalUsageResponse>('/api/ai-platform/retrieval/usage?days=30', {
      token: viewerToken,
    });
    expect(usageOk.status).toBe(200);
    expect(usageOk.body?.days).toBe(30);

    // view_retrieval can GET status, cannot PUT settings or POST reindex
    const scopePath = `/api/ai-platform/retrieval/profile/${integrationProfileId}`;
    expect((await apiCall(scopePath, { token: viewerToken })).status).toBe(200);
    expect(
      (await apiCall(scopePath, { token: viewerToken, method: 'PUT', body: { mode: 'hybrid' } })).status,
    ).toBe(403);
    expect(
      (await apiCall(`${scopePath}/reindex`, { token: viewerToken, method: 'POST' })).status,
    ).toBe(403);

    // Disabled pillar returns 409 pillar_disabled on /query while writes stay enabled
    const disabledQuery = await apiCall<{ error: { code: string } }>(`${scopePath}/query`, {
      token: viewerToken,
      method: 'POST',
      body: { query: 'warranty coverage' },
    });
    expect(disabledQuery.status).toBe(409);
    expect(disabledQuery.body?.error.code).toBe('pillar_disabled');

    // Add KB doc via profile-knowledge API -> hooks onDocumentChanged
    const docCreate = await apiCall<{ doc: { id: number } }>(
      `/api/client-profiles/${integrationProfileId}/knowledge`,
      {
        token: primaryToken,
        method: 'POST',
        body: {
          title: 'Hardware Warranty Terms',
          content: 'All hardware devices ship with a two-year replacement warranty and toll-free diagnostics.',
        },
      },
    );
    expect(docCreate.status).toBe(201);

    const scope: Scope = { kind: 'profile', id: String(integrationProfileId) };
    const waitForIdle = async () => {
      for (let i = 0; i < 80; i++) {
        if (getScopeIndexSnapshot(scope).activeJob === null) return;
        await new Promise((r) => setTimeout(r, 25));
      }
    };

    // Wait so queued doc_edit completes, then check PUT settings & POST reindex conflict
    await waitForIdle();
    const putSettings = await apiCall<RetrievalScopeStatusResponse>(scopePath, {
      token: editorToken,
      method: 'PUT',
      body: { mode: 'hybrid', topK: 3, minScore: 0.1, citationsEnabled: true },
    });
    expect(putSettings.status).toBe(200);
    expect(putSettings.body?.settings.mode).toBe('hybrid');

    // Wait for keyword -> hybrid reindex job triggered by PUT before testing explicit POST /reindex conflict
    await waitForIdle();
    const reindex1 = await apiCall(`${scopePath}/reindex`, { token: editorToken, method: 'POST' });
    expect(reindex1.status).toBe(200);
    const reindex2 = await apiCall<{ error: { code: string } }>(`${scopePath}/reindex`, {
      token: editorToken,
      method: 'POST',
    });
    expect(reindex2.status).toBe(409);
    expect(reindex2.body?.error.code).toBe('job_already_running');

    // Wait for reindex job completion
    for (let i = 0; i < 40; i++) {
      if (getScopeIndexSnapshot(scope).status.ready) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(getScopeIndexSnapshot(scope).status.ready).toBe(true);

    // Enable retrieval + outputGuard together
    resetFlagsCacheForTests();
    setFlags({ retrieval: true, outputGuard: true });
    const guardRevision = getPolicy(scope).revision;
    await setPolicy(
      scope,
      {
        ...DEFAULT_GUARD_POLICY_BASE,
        revision: guardRevision,
        mode: 'block',
        failMode: 'allow',
        detectors: {
          ...DEFAULT_GUARD_DETECTORS,
          keywords: { enabled: true, terms: ['FORBIDDEN_SECRET'] },
          pii: { enabled: true, action: 'mask' },
        },
        replacementText: 'Blocked by output guard.',
      },
      primaryId,
    );

    // Admin /query works now that pillar is enabled
    const queryRes = await apiCall<RetrievalQueryResponse>(`${scopePath}/query`, {
      token: viewerToken,
      method: 'POST',
      body: { query: 'replacement warranty duration' },
    });
    expect(queryRes.status).toBe(200);
    expect(queryRes.body?.hits.length).toBeGreaterThan(0);

    // Non-stream OpenAI Chat: injects KB, emits retrieval & citation headers, AND root citations (composition with outputGuard masking!)
    fakeProvider.clearRequests();
    fakeProvider.setDefaultReply(() => ({
      kind: 'scripted',
      text: 'Hardware carries a two-year replacement warranty; contact help@acme.example for support.',
    }));
    const chatRes = await apiCall<Record<string, unknown>>('/v1/chat/completions', {
      token: integrationClientKey,
      method: 'POST',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'What warranty does hardware have?' }],
      },
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get(RETRIEVAL_HEADER_NAME)).toBe('hybrid');
    expect(chatRes.headers.get(CITATIONS_HEADER_NAME)).toBeTruthy();
    expect(Array.isArray(chatRes.body?.citations)).toBe(true);
    expect((chatRes.body?.citations as unknown[]).length).toBeGreaterThan(0);
    // Verify outputGuard STILL ran alongside citationFilter (email masked)
    const msgContent = ((chatRes.body?.choices as Array<{ message: { content: string } }>)[0]!).message.content;
    expect(msgContent).not.toContain('help@acme.example');

    // Verify x-freellm-citations: off suppresses header AND body citations while keeping retrieval injection
    const optOutRes = await apiCall<Record<string, unknown>>('/v1/chat/completions', {
      token: integrationClientKey,
      method: 'POST',
      headers: { 'x-freellm-citations': 'off' },
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'What warranty does hardware have?' }],
      },
    });
    expect(optOutRes.status).toBe(200);
    expect(optOutRes.headers.get(RETRIEVAL_HEADER_NAME)).toBe('hybrid');
    expect(optOutRes.headers.get(CITATIONS_HEADER_NAME)).toBeNull();
    expect(optOutRes.body?.citations).toBeUndefined();

    // Non-stream OpenAI Responses also gets root citations
    const respRes = await apiCall<Record<string, unknown>>('/v1/responses', {
      token: integrationClientKey,
      method: 'POST',
      body: {
        model: 'groq/compound',
        input: 'Tell me about hardware warranty.',
      },
    });
    expect(respRes.status).toBe(200);
    expect(respRes.headers.get(RETRIEVAL_HEADER_NAME)).toBe('hybrid');
    expect(respRes.headers.get(CITATIONS_HEADER_NAME)).toBeTruthy();
    expect(Array.isArray(respRes.body?.citations)).toBe(true);

    // Non-stream Anthropic gets citation header ONLY, never body citations
    const anthRes = await apiCall<Record<string, unknown>>('/v1/messages', {
      token: integrationClientKey,
      method: 'POST',
      body: {
        model: 'groq/compound',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Tell me about hardware warranty.' }],
      },
    });
    expect(anthRes.status).toBe(200);
    expect(anthRes.headers.get(RETRIEVAL_HEADER_NAME)).toBe('hybrid');
    expect(anthRes.headers.get(CITATIONS_HEADER_NAME)).toBeTruthy();
    expect(anthRes.body?.citations).toBeUndefined();

    // Blocked output MUST NOT leak root citations
    fakeProvider.setDefaultReply(() => ({
      kind: 'scripted',
      text: 'This response contains FORBIDDEN_SECRET and must be blocked.',
    }));
    const blockedRes = await apiCall<Record<string, unknown>>('/v1/chat/completions', {
      token: integrationClientKey,
      method: 'POST',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'Tell me about hardware warranty.' }],
      },
    });
    expect(blockedRes.status).toBe(200);
    expect(blockedRes.body?.citations).toBeUndefined();

    // Flag off restores zero retrieval headers / body mutations
    resetFlagsCacheForTests();
    setFlags({ retrieval: false, outputGuard: false });
    fakeProvider.setDefaultReply(() => ({
      kind: 'scripted',
      text: 'Normal response.',
    }));
    const offRes = await apiCall<Record<string, unknown>>('/v1/chat/completions', {
      token: integrationClientKey,
      method: 'POST',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'What warranty does hardware have?' }],
      },
    });
    expect(offRes.status).toBe(200);
    expect(offRes.headers.get(RETRIEVAL_HEADER_NAME)).toBeNull();
    expect(offRes.headers.get(CITATIONS_HEADER_NAME)).toBeNull();
    expect(offRes.body?.citations).toBeUndefined();

    fakeProvider.setDefaultReply(null);
    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
  }, 20_000);

  it('integrates support knowledge chunks, ranked search, and support-runtime step 10b with role enforcement', async () => {
    const db = getDb();
    ensureSupportTables();
    ensureSupportRuntimeTables(db);

    const fakeRunner = createFakeEmbeddingsRunner(768);
    setEmbeddingsRunnerForTests(fakeRunner);
    setQueryEmbeddingsRunnerForTests(fakeRunner);

    const { tenant } = createSupportTenant({
      name: 'Support Retrieval Tenant',
      allowGuest: true,
      defaultModel: 'claude-3-5-sonnet',
      systemPrompt: 'You are Support Retrieval Assistant.',
    });

    const publicDoc = upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Public Return Guarantee',
      category: 'policy',
      allowedRoles: ['*'],
      tags: ['returns', 'refund'],
      content: 'Customers can return unopened hardware within 30 days.\n\nDamaged shipments receive prepaid return labels.',
    });
    upsertSupportKnowledgeDoc(String(tenant.id), {
      title: 'Internal Fraud Escalation Playbook',
      category: 'internal',
      allowedRoles: ['admin'],
      tags: ['fraud', 'escalation'],
      content: 'Use override token FRD-991 only for verified supervisor hardware return chargebacks.',
    });

    const chunks = listSupportKnowledgeChunks(String(tenant.id));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(searchSupportKnowledgeRanked(String(tenant.id), 'hardware return labels', 'customer').map((h) => h.docId)).toContain(
      publicDoc.id,
    );
    // Security: customer role MUST NOT see admin-only fraud doc even when tokens match strongly
    const leakCheck = searchSupportKnowledgeRanked(String(tenant.id), 'FRD-991 fraud escalation override', 'customer');
    expect(leakCheck.map((h) => h.title)).not.toContain('Internal Fraud Escalation Playbook');

    // Reindex support tenant scope
    const scope: Scope = { kind: 'support_tenant', id: String(tenant.id) };
    const { getScopeIndexSnapshot: snapFn, runPendingIndexJobsUntilIdle } = await import(
      '../../../custom/ai-platform/retrieval/indexer.js'
    );
    await runPendingIndexJobsUntilIdle();
    expect(snapFn(scope).status.ready).toBe(true);

    resetFlagsCacheForTests();
    setFlags({ retrieval: true });

    let capturedTrustedContext = '';
    const turn = await executeSupportTurn({
      tenant,
      userContext: {
        tenantId: tenant.id,
        userId: 'cust-1',
        name: 'Customer One',
        email: 'cust1@example.com',
        role: 'customer',
        permissions: [],
        verified: true,
      },
      input: {
        tenantKey: tenant.publicKey,
        requestId: 'req_support_retrieval_1',
        messages: [{ role: 'user', content: 'How do damaged hardware returns and FRD-991 work?' }],
      },
      generate: async (ctx) => {
        capturedTrustedContext = ctx.trustedContext;
        return {
          reply: 'Damaged shipments receive prepaid return labels.',
          userContext: ctx.userContext,
          allowedTools: [],
          toolTrace: [],
          modelUsed: 'claude-3-5-sonnet',
          usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
        };
      },
    });

    expect(turn.runtime.knowledgeDocIds).toContain(publicDoc.id);
    expect(turn.runtime.retrieval?.modeUsed).toBe('hybrid');
    expect(Array.isArray(turn.citations)).toBe(true);
    expect(turn.citations!.length).toBeGreaterThan(0);
    expect(capturedTrustedContext).toContain('prepaid return labels');
    expect(capturedTrustedContext).not.toContain('FRD-991');

    setEmbeddingsRunnerForTests(null);
    setQueryEmbeddingsRunnerForTests(null);
  }, 15_000);
});
