/**
 * T135 — what the AI platform costs a request when every pillar is off.
 *
 * The pre-upgrade baseline (T005) cannot be run against today's code, so the
 * added time is measured directly instead: every hook the upgrade put on the
 * inference hot path is called, in the order a request reaches it, with all
 * flags off, and that cost is compared with the median end-to-end latency of
 * a real request through the app. The hooks must add less than 5% (FR / SC
 * threshold in tasks.md T135).
 *
 * The hook loop allocates a fresh request object per iteration, as each HTTP
 * request does, so the per-request WeakMap caches are exercised, not skipped.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { getFlags, isPillarEnabled, resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';
import { captureInternalCall, isInternalCall } from '../../../custom/ai-platform/loopback.js';
import { prepareMcpTakeover } from '../../../custom/ai-platform/mcp-client/admission.js';
import { extractRequestedModel, recordServerLocalAddress } from '../../../custom/ai-platform/orchestrator/engine.js';
import { installOutputGuardIfNeeded, runPreRequest } from '../../../custom/ai-platform/pipeline.js';
import { withPromptCacheRoute } from '../../../custom/ai-platform/prompt-cache/runtime.js';
import { renderPrompt } from '../../../custom/ai-platform/prompts/render.js';
import { detectWire } from '../../../custom/ai-platform/wire/detect.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import type { RouteResult } from '../../../services/router.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

const THRESHOLD = 0.05;
const WARMUP_REQUESTS = 20;
const MEASURED_REQUESTS = 120;
const HOOK_ITERATIONS = 20_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe('AI platform overhead with every pillar off (T135)', () => {
  const realFetch = global.fetch;
  let server: Server;
  let fakeProvider: FakeProviderServer;
  let base = '';
  let fixtureDirectory = '';
  let profileId = 0;
  let clientKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-overhead-'));
    initDb(path.join(fixtureDirectory, 'bench.db'));
    resetFlagsCacheForTests();

    fakeProvider = await startFakeProviderServer({ kind: 'scripted', text: 'ok' });
    setKeyCacheTestOverride(true);
    const enc = encrypt('gsk_overhead_bench_key');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'overhead-bench', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);
    // The catalog's free-tier limits (about 30 RPM) would stop the measured run with 429s.
    getDb().prepare('UPDATE models SET rpm_limit = 1000000, rpd_limit = 1000000, tpm_limit = NULL, tpd_limit = NULL').run();

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const token = createSession(createUser('overhead-bench@example.com', 'Password123!').userId);
    const profile = await realFetch(`${base}/api/client-profiles`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'overhead-bench', systemPrompt: 'Answer briefly.' }),
    });
    expect(profile.status).toBe(201);
    const created = (await profile.json()) as { id: number; key: string };
    profileId = created.id;
    clientKey = created.key;
    // Lift the client key's own 60 RPM cap for the measured run.
    getDb().prepare('UPDATE client_profiles SET rpm_limit = NULL WHERE id = ?').run(profileId);

    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(base) || urlStr.startsWith(fakeProvider.url)) return realFetch(input, init);
      const parsed = new URL(urlStr);
      return realFetch(`${fakeProvider.url}${parsed.pathname}${parsed.search}`, init);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakeProvider.close();
    try {
      getDb().close();
    } catch { /* ignore */ }
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('keeps the hot-path hooks under 5% of a request when all pillars are off', async () => {
    expect(Object.values(getFlags()).every((on) => on === false)).toBe(true);

    const send = async (): Promise<number> => {
      const t0 = performance.now();
      const res = await realFetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: 'Hello there' }] }),
      });
      const text = await res.text();
      expect(res.status, text).toBe(200);
      return performance.now() - t0;
    };
    for (let i = 0; i < WARMUP_REQUESTS; i++) await send();
    const requestTimes: number[] = [];
    for (let i = 0; i < MEASURED_REQUESTS; i++) requestTimes.push(await send());
    const requestMs = median(requestTimes);

    const profile = { id: profileId, aiToolsEnabled: false, knowledge: { enabled: false, maxChars: 0 } } as never;
    const route = { provider: {}, platform: 'groq', modelId: 'compound' } as unknown as RouteResult;
    const res = { headersSent: false, setHeader() {}, on() {}, off() {} } as unknown as Response;
    const template = 'Hello {{profile_name}}, answer briefly.';
    const makeRequest = () => ({
      method: 'POST',
      path: '/v1/chat/completions',
      url: '/v1/chat/completions',
      originalUrl: '/v1/chat/completions',
      headers: { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' },
      query: {},
      body: { model: 'groq/compound', messages: [{ role: 'user', content: 'Hello there' }] },
      socket: { remoteAddress: '203.0.113.9', localAddress: '127.0.0.1', localPort: 3001 },
    }) as unknown as Request;

    const runHooks = async (req: Request) => {
      const bodyBefore = req.body;
      // profile-gate.ts, in request order.
      recordServerLocalAddress(req);
      captureInternalCall(req);
      const internal = isInternalCall(req) !== null;
      const wire = !internal ? detectWire(req) : null;
      if (wire) extractRequestedModel(wire.wire, req);
      prepareMcpTakeover(req, profile, null);
      installOutputGuardIfNeeded(req, res, profile, null);
      const outcome = await runPreRequest(req, res, profile, null);
      // knowledge-inject.ts, system-prompt.ts and fallback-loop.ts.
      isPillarEnabled('retrieval');
      renderPrompt(template);
      withPromptCacheRoute(route);
      if (outcome !== 'continue' || req.body !== bodyBefore) throw new Error('a pillar changed the request while off');
    };

    for (let i = 0; i < 2_000; i++) await runHooks(makeRequest());
    const t0 = performance.now();
    for (let i = 0; i < HOOK_ITERATIONS; i++) await runHooks(makeRequest());
    const hookMs = (performance.now() - t0) / HOOK_ITERATIONS;

    const ratio = hookMs / requestMs;
    const summary = `hooks ${(hookMs * 1000).toFixed(2)} µs per request, request median ${requestMs.toFixed(2)} ms, ratio ${(ratio * 100).toFixed(3)}%`;
    if (process.env.AI_PLATFORM_BENCH_REPORT === '1') process.stderr.write(`[T135] ${summary}\n`);
    expect(ratio, summary).toBeLessThan(THRESHOLD);
  }, 120_000);
});
