/**
 * Secret-leak coverage for the pillars that had none of their own (T134):
 * semantic retrieval, prompt cache, versioned prompts and the orchestrator.
 * MCP and Output Guard keep their dedicated suites (secret-leak.test.ts,
 * guard-secret-leak.test.ts).
 *
 * Each case drives the pillar through its real HTTP surface, then searches
 * every place the pillar persists or exposes data (its tables, admin API
 * responses, the public run API, the audit log, a downloaded backup, and
 * stdout/stderr) for the provider credential and the caller's client key.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import {
  runPendingIndexJobsUntilIdle,
  setEmbeddingsRunnerForTests,
  stopIndexWorker,
} from '../../../custom/ai-platform/retrieval/indexer.js';
import { invalidateVectorCache } from '../../../custom/ai-platform/retrieval/vector-store.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

// Shaped like a real Groq key so it exercises the same redaction rules that
// protect provider errors elsewhere in the gateway.
const PROVIDER_SECRET = 'gsk_PillarLeakProbe7Q2w9E4r1T6y3U8i5O0p';
const PROMPT_SECRET_VARIABLE = 'PROMPT_ONLY_MARKER_51b7';

describe('AI platform pillars never leak credentials (T134)', () => {
  const realFetch = global.fetch;
  let server: Server;
  let fakeProvider: FakeProviderServer;
  let base: string;
  let fixtureDirectory: string;
  let primaryToken = '';
  let profileId = 0;
  let clientKey = '';
  let captured: string[] = [];

  async function call(urlPath: string, token: string, method = 'GET', body?: unknown) {
    const res = await realFetch(`${base}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return null; } })() };
  }

  function dumpTables(...tables: string[]): string {
    return tables
      .map((t) => JSON.stringify(getDb().prepare(`SELECT * FROM "${t}"`).all()))
      .join('\n');
  }

  function auditText(): string {
    return (getDb().prepare("SELECT summary FROM custom_audit_log WHERE area = 'ai-platform'").all() as Array<{ summary: string }>)
      .map((r) => r.summary)
      .join('\n');
  }

  async function backupText(): Promise<string> {
    const created = await call('/api/backups', primaryToken, 'POST', {});
    expect(created.status).toBe(201);
    const id = (created.json!.backup as { id: number }).id;
    const dl = await realFetch(`${base}/api/backups/${id}/download`, { headers: { authorization: `Bearer ${primaryToken}` } });
    expect(dl.status).toBe(200);
    const raw = Buffer.from(await dl.arrayBuffer());
    return raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  }

  function expectClean(label: string, text: string): void {
    expect(text, `${label} contains the provider credential`).not.toContain(PROVIDER_SECRET);
    expect(text, `${label} contains the client key`).not.toContain(clientKey);
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-pillar-secrets-'));
    initDb(path.join(fixtureDirectory, 'fixture.db'));
    resetFlagsCacheForTests();
    resetKnowledgeIndexes();
    invalidateVectorCache();
    setFlags({ retrieval: true, promptCache: true, prompts: true, orchestrator: true });

    fakeProvider = await startFakeProviderServer();
    setKeyCacheTestOverride(true);
    const enc = encrypt(PROVIDER_SECRET);
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'pillar-secret-groq', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const primaryId = createUser('pillar-secret-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const profile = await call('/api/client-profiles', primaryToken, 'POST', { name: 'pillar-secret-profile' });
    expect(profile.status).toBe(201);
    profileId = profile.json!.id as number;
    clientKey = profile.json!.key as string;
    expect(clientKey.length).toBeGreaterThan(10);

    // Every non-local request goes to the fake provider, so nothing leaves the machine.
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(base) || urlStr.startsWith(fakeProvider.url)) return realFetch(input, init);
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });
  });

  afterEach(() => {
    captured = [];
  });

  afterAll(async () => {
    stopIndexWorker();
    setEmbeddingsRunnerForTests(null);
    vi.restoreAllMocks();
    resetFlagsCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakeProvider.close();
    try {
      getDb().close();
    } catch { /* ignore */ }
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  async function withCapturedOutput<T>(fn: () => Promise<T>): Promise<T> {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { captured.push(String(chunk)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { captured.push(String(chunk)); return true; });
    try {
      return await fn();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  }

  it('retrieval: an embeddings error that echoes the credential is not stored, returned or logged', async () => {
    addDoc(profileId, 'Returns', 'Items can be returned within 30 days with a receipt.');
    setEmbeddingsRunnerForTests(async () => {
      throw new Error(`401 Unauthorized: invalid api key ${PROVIDER_SECRET} for embeddings`);
    });

    await withCapturedOutput(async () => {
      const queued = await call(`/api/ai-platform/retrieval/profile/${profileId}/reindex`, primaryToken, 'POST', {});
      expect(queued.status).toBeLessThan(300);
      await runPendingIndexJobsUntilIdle({ respectRetryAfter: false });
    });

    const jobs = getDb().prepare('SELECT status, last_error FROM custom_ai_index_jobs').all() as Array<{ status: string; last_error: string | null }>;
    expect(jobs.some((j) => j.last_error && j.last_error.length > 0)).toBe(true);

    const status = await call(`/api/ai-platform/retrieval/profile/${profileId}`, primaryToken);
    expect(status.status).toBe(200);
    const usage = await call('/api/ai-platform/retrieval/usage', primaryToken);

    expectClean('retrieval tables', dumpTables('custom_ai_index_jobs', 'custom_ai_chunk_embeddings', 'custom_ai_embedding_usage', 'custom_ai_retrieval_settings'));
    expectClean('retrieval status API', status.text);
    expectClean('retrieval usage API', usage.text);
    expectClean('stdout/stderr', captured.join('\n'));
    setEmbeddingsRunnerForTests(null);
  });

  it('versioned prompts and prompt cache: publishing and serving a prompt keep credentials out of history, stats and audit', async () => {
    const headRevision = async (): Promise<number> => {
      const state = await call(`/api/ai-platform/prompts/profile/${profileId}`, primaryToken);
      expect(state.status).toBe(200);
      return (state.json!.head as { revision: number }).revision;
    };
    const draft = await call(`/api/ai-platform/prompts/profile/${profileId}/draft`, primaryToken, 'PUT', {
      body: `You are a support assistant. Internal marker ${PROMPT_SECRET_VARIABLE}.`,
      note: 'leak check',
      revision: await headRevision(),
    });
    expect(draft.status, draft.text).toBe(200);
    const publish = await call(`/api/ai-platform/prompts/profile/${profileId}/publish`, primaryToken, 'POST', { revision: await headRevision() });
    expect(publish.status, publish.text).toBe(200);

    await withCapturedOutput(async () => {
      fakeProvider.enqueue({
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: 'Happy to help.',
        usage: { prompt_tokens: 1200, completion_tokens: 5, total_tokens: 1205, prompt_tokens_details: { cached_tokens: 1024 } },
      } as never);
      const chat = await realFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const chatText = await chat.text();
      expect(chat.status, chatText).toBe(200);
    });

    const sent = fakeProvider.requests.at(-1);
    expect(sent?.bodyText ?? "").toContain(PROMPT_SECRET_VARIABLE);

    const stats = await call('/api/ai-platform/prompt-cache/stats', primaryToken);
    expect(stats.status).toBe(200);
    const history = await call(`/api/ai-platform/prompts/profile/${profileId}`, primaryToken);

    expectClean('prompt and cache tables', dumpTables('custom_ai_prompt_versions', 'custom_ai_prompt_heads', 'custom_ai_cache_usage_daily'));
    expectClean('prompt history API', history.text);
    expectClean('prompt cache stats API', stats.text);
    expectClean('audit log', auditText());
    expectClean('stdout/stderr', captured.join('\n'));
  });

  it('orchestrator: a failing model step does not put the credential or client key into traces, run APIs, audit or backups', async () => {
    const agent = await call('/api/ai-platform/agents', primaryToken, 'POST', {
      slug: 'leakcheck',
      name: 'Leak Check Agent',
      model: 'llama-3.3-70b-versatile',
      systemPrompt: 'Answer briefly.',
    });
    expect(agent.status, agent.text).toBe(201);
    const flow = await call('/api/ai-platform/flows', primaryToken, 'POST', {
      slug: 'leak-check',
      name: 'Leak Check Flow',
      draft: {
        kind: 'handoff',
        entryAgent: 'leakcheck',
        agents: ['leakcheck'],
        handoffs: { leakcheck: [] },
        limits: { maxSteps: 4, maxToolCalls: 2, maxHandoffs: 1, maxTokens: 20000, maxSeconds: 60 },
        awaitingApprovalText: 'Awaiting approval.',
        approvalTtlHours: 24,
      },
    });
    expect(flow.status, flow.text).toBe(201);
    const created = flow.json!.flow as { id: number; revision: number };
    expect((await call(`/api/ai-platform/flows/${created.id}/publish`, primaryToken, 'POST', { revision: created.revision })).status).toBe(200);
    expect((await call(`/api/ai-platform/flows/${created.id}/grants`, primaryToken, 'PUT', { profileIds: [profileId] })).status).toBe(200);

    let runResponse = '';
    await withCapturedOutput(async () => {
      for (let i = 0; i < 4; i++) {
        fakeProvider.enqueue({
          kind: 'error',
          wire: 'openai-chat',
          status: 400,
          message: `Invalid request: api_key=${PROVIDER_SECRET} rejected; Authorization: Bearer ${PROVIDER_SECRET}`,
        });
      }
      const res = await realFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'flow:leak-check', messages: [{ role: 'user', content: 'Where is my order?' }] }),
      });
      runResponse = await res.text();
    });

    const runs = await call('/api/ai-platform/runs', primaryToken);
    expect(runs.status).toBe(200);
    const runRows = getDb().prepare('SELECT id FROM custom_ai_runs').all() as Array<{ id: string | number }>;
    expect(runRows.length).toBeGreaterThan(0);
    const runId = runRows[runRows.length - 1].id;
    const detail = await call(`/api/ai-platform/runs/${runId}`, primaryToken);
    expect(detail.status).toBe(200);
    const publicRun = await call(`/v1/ai/runs/${runId}`, clientKey);

    expectClean('run tables', dumpTables('custom_ai_runs', 'custom_ai_run_steps'));
    expectClean('admin runs list', runs.text);
    expectClean('admin run detail', detail.text);
    expectClean('public run API', publicRun.text);
    expectClean('flow chat response', runResponse);
    expectClean('audit log', auditText());
    expectClean('stdout/stderr', captured.join('\n'));

    const backup = await backupText();
    expect(backup).toContain('custom_ai_runs');
    const leakingTables = backup.split(/\n(?=CREATE TABLE IF NOT EXISTS )/)
      .filter((section) => section.includes(PROVIDER_SECRET))
      .map((section) => /CREATE TABLE IF NOT EXISTS "?([A-Za-z0-9_]+)/.exec(section)?.[1] ?? 'header');
    expect(leakingTables).toEqual([]);
  });
});
