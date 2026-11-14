/**
 * T071 — Output Guard Benchmark: False-Block Rate (<2%) & Streaming Added TTFC (<=300ms) (Agent 4).
 *
 * Corpus: server/src/__tests__/fixtures/ai-platform-output-guard/guard-eval.json
 * (220 diverse benign responses + 7 deterministic violation/masking cases).
 *
 * Scope & Methodology Disclosure:
 * - Default policy: mode='block', holdChars=200, maxDelayMs=300, non-model detectors
 *   (keywords, promptLeak, pii action='mask'). Policies requiring full buffering
 *   (unbounded custom regex patterns, external moderation, model judge) are explicitly
 *   outside the <=300ms streaming TTFC claim.
 * - Synthetic measurements against local FakeProviderServer on localhost:0 are for
 *   deterministic regression verification, not production SLA guarantees.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVAL_PATH = path.resolve(__dirname, '../../fixtures/ai-platform-output-guard/guard-eval.json');

interface GuardEvalCorpus {
  version: number;
  seed: number;
  description: string;
  defaultPolicy: {
    mode: 'block';
    failMode: 'allow';
    holdChars: number;
    maxDelayMs: number;
    keywords: string[];
    systemPrompt: string;
    piiAction: 'mask';
  };
  benign: Array<{ id: string; category: string; text: string }>;
  violations: Array<{ id: string; expectedDetector: string; expectedAction: 'blocked' | 'masked'; text: string }>;
}

const CORPUS = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8')) as GuardEvalCorpus;

function seededChunkSplit(text: string, seed: number): string[] {
  const chunks: string[] = [];
  let s = seed >>> 0;
  let pos = 0;
  while (pos < text.length) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const step = 8 + (s % 17); // 8..24 chars per chunk
    chunks.push(text.slice(pos, pos + step));
    pos += step;
  }
  return chunks;
}

async function measureStreamTtfcMs(url: string, clientKey: string, prompt: string): Promise<{ ttfcMs: number; bodyText: string }> {
  const t0 = performance.now();
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${clientKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'groq/compound',
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });
  expect(res.status).toBe(200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let ttfcMs = -1;
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    full += chunkText;
    // Measure first real content delta (exclude headers, SSE comments, empty role frames)
    if (ttfcMs < 0 && /"content"\s*:\s*"[^"]+"/.test(chunkText)) {
      ttfcMs = performance.now() - t0;
    }
  }
  return { ttfcMs, bodyText: full };
}

describe('Output Guard Benchmark: False-Block Rate & TTFC (T071)', () => {
  let appServer: http.Server;
  let baseUrl = '';
  let fakeProvider: FakeProviderServer;
  let primaryToken = '';
  const clientKey = 'flm_guard_bench_1';
  let profileId = 0;

  async function adminCall(urlPath: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        authorization: `Bearer ${primaryToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
    };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    fakeProvider = await startFakeProviderServer();

    initDb(':memory:');
    resetFlagsCacheForTests();
    setFlags({ outputGuard: true });
    setKeyCacheTestOverride(true);

    const enc = encrypt('gsk_guard_bench');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'groq-guard-bench', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    const profRes = getDb()
      .prepare(
        `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, system_prompt)
         VALUES (?, ?, 'enc', 'iv', 'tag', 1, ?)`,
      )
      .run('guard-bench-profile', hashClientProfileKey(clientKey), CORPUS.defaultPolicy.systemPrompt);
    profileId = Number(profRes.lastInsertRowid);

    appServer = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => appServer.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

    const userId = createUser('guard-bench@example.com', 'Password123!').userId;
    primaryToken = createSession(userId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => appServer.close(() => resolve()));
    await fakeProvider.close();
  });

  it('maintains <2% false-block rate across >=200 benign responses and catches violation fixtures', async () => {
    expect(CORPUS.benign.length).toBeGreaterThanOrEqual(200);

    const current = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`);
    expect(current.status).toBe(200);
    const rev = (current.body?.policy as { revision: number }).revision;

    const putRes = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`, 'PUT', {
      mode: CORPUS.defaultPolicy.mode,
      failMode: CORPUS.defaultPolicy.failMode,
      detectors: {
        keywords: { enabled: true, terms: CORPUS.defaultPolicy.keywords },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: true, minShingles: 2 },
        pii: { enabled: true, action: CORPUS.defaultPolicy.piiAction },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      replacementText: 'Blocked by guard benchmark policy.',
      bypassRoles: [],
      holdChars: CORPUS.defaultPolicy.holdChars,
      maxDelayMs: CORPUS.defaultPolicy.maxDelayMs,
      revision: rev,
    });
    expect(putRes.status).toBe(200);

    let falseBlocks = 0;
    for (const sample of CORPUS.benign) {
      const testRes = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}/test`, 'POST', {
        text: sample.text,
        includeExternal: false,
      });
      expect(testRes.status).toBe(200);
      if (testRes.body?.action === 'blocked') {
        falseBlocks += 1;
      }
    }

    const falseBlockRate = falseBlocks / CORPUS.benign.length;
    expect(falseBlockRate).toBeLessThan(0.02);

    // Verify deterministic keyword/NFC/cross-chunk/promptLeak/PII fixtures
    for (const v of CORPUS.violations) {
      if (v.expectedDetector === 'patterns' || v.expectedDetector === 'maxLength') continue;
      const testRes = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}/test`, 'POST', {
        text: v.text,
        includeExternal: false,
      });
      expect(testRes.status).toBe(200);
      expect(testRes.body?.action).toBe(v.expectedAction);
    }
  });

  it('adds <= 300ms streaming TTFC in default non-model configuration vs unguarded baseline', async () => {
    const sampleText =
      'Here is a detailed, completely safe explanation of how the streaming buffer works in practice. ' +
      'It continues with plenty of normal tokens so that the 200-character hold window is exercised naturally.';
    const chunks = seededChunkSplit(sampleText, CORPUS.seed);

    // 1. Baseline (mode = off)
    const curOff = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`);
    expect(curOff.status).toBe(200);
    const revOff = (curOff.body?.policy as { revision: number }).revision;
    await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`, 'PUT', {
      mode: 'off',
      failMode: 'allow',
      detectors: {
        keywords: { enabled: true, terms: CORPUS.defaultPolicy.keywords },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: true, minShingles: 2 },
        pii: { enabled: true, action: 'mask' },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      replacementText: 'Blocked by guard benchmark policy.',
      bypassRoles: [],
      holdChars: 200,
      maxDelayMs: 300,
      revision: revOff,
    });

    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: true,
      textChunks: chunks,
      chunkDelayMs: 10,
    });
    const baseline = await measureStreamTtfcMs(baseUrl, clientKey, 'bench-baseline');
    expect(baseline.ttfcMs).toBeGreaterThanOrEqual(0);

    // 2. Guarded default (mode = block, holdChars = 200, maxDelayMs = 300)
    const curOn = await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`);
    const revOn = (curOn.body?.policy as { revision: number }).revision;
    await adminCall(`/api/ai-platform/output-guard/profile/${profileId}`, 'PUT', {
      mode: 'block',
      failMode: 'allow',
      detectors: {
        keywords: { enabled: true, terms: CORPUS.defaultPolicy.keywords },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: true, minShingles: 2 },
        pii: { enabled: true, action: 'mask' },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      replacementText: 'Blocked by guard benchmark policy.',
      bypassRoles: [],
      holdChars: 200,
      maxDelayMs: 300,
      revision: revOn,
    });

    fakeProvider.enqueue({
      kind: 'scripted',
      wire: 'openai-chat',
      stream: true,
      textChunks: chunks,
      chunkDelayMs: 10,
    });
    const guarded = await measureStreamTtfcMs(baseUrl, clientKey, 'bench-guarded');
    expect(guarded.ttfcMs).toBeGreaterThanOrEqual(0);

    const addedTtfcMs = guarded.ttfcMs - baseline.ttfcMs;
    expect(addedTtfcMs).toBeLessThanOrEqual(300);
  });
});
