import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { defaultDbFactory, getDb, getUnifiedApiKey, initDb } from '../../../db/index.js';
import { wrapTursoDatabase } from '../../../db/turso.js';
import { encrypt } from '../../../lib/crypto.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { mintUserApiKey } from '../../../services/user-keys.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.resolve(__dirname, '../../fixtures/ai-platform-baseline');
const MANIFEST_PATH = path.join(BASELINE_DIR, 'manifest.json');
const CAPTURE = process.env.CAPTURE_BASELINE === '1';

interface BaselineCase {
  id: string;
  wire: 'openai-chat' | 'anthropic' | 'responses' | 'gemini';
  stream: boolean;
  authKind: 'profile' | 'unified' | 'user';
  withPromptAndKnowledge: boolean;
  withCacheControl: boolean;
  method: 'POST';
  path: string;
  body: Record<string, unknown>;
}

interface CapturedFixture {
  id: string;
  wire: string;
  stream: boolean;
  authKind: string;
  upstream: {
    method: string;
    path: string;
    query: Record<string, string>;
    bodyJson: unknown;
  } | null;
  response: {
    status: number;
    contentType: string;
    bodyJson?: unknown;
    bodyText?: string;
  };
}

function normalizeVolatile(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(normalizeVolatile);
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (k === 'created' || k === 'created_at' || k === 'id' || k === 'response_id' || k === 'item_id' || k === 'execution_id') {
        out[k] = typeof v === 'number' ? 0 : `<${k}>`;
      } else {
        out[k] = normalizeVolatile(v);
      }
    }
    return out;
  }
  return val;
}

function buildCases(): BaselineCase[] {
  return [
    {
      id: 'openai-chat-nonstream-enriched',
      wire: 'openai-chat',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: true,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'groq/compound',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Caller system context.', cache_control: { type: 'ephemeral' } }] },
          { role: 'user', content: 'Phí giao hàng bao nhiêu?' },
        ],
      },
    },
    {
      id: 'openai-chat-stream-enriched',
      wire: 'openai-chat',
      stream: true,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'groq/compound',
        stream: true,
        messages: [{ role: 'user', content: 'Phí giao hàng bao nhiêu?' }],
      },
    },
    {
      id: 'openai-chat-nonstream-plain',
      wire: 'openai-chat',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'Hello plain openai' }],
      },
    },
    {
      id: 'anthropic-nonstream-enriched',
      wire: 'anthropic',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: true,
      method: 'POST',
      path: '/v1/messages',
      body: {
        model: 'groq/compound',
        max_tokens: 128,
        system: [{ type: 'text', text: 'Caller anthropic system.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Phí giao hàng bao nhiêu?' }],
      },
    },
    {
      id: 'anthropic-stream-enriched',
      wire: 'anthropic',
      stream: true,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/messages',
      body: {
        model: 'groq/compound',
        max_tokens: 128,
        stream: true,
        messages: [{ role: 'user', content: 'Phí giao hàng bao nhiêu?' }],
      },
    },
    {
      id: 'anthropic-nonstream-plain',
      wire: 'anthropic',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/messages',
      body: {
        model: 'groq/compound',
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Hello plain anthropic' }],
      },
    },
    {
      id: 'responses-nonstream-enriched',
      wire: 'responses',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/responses',
      body: {
        model: 'groq/compound',
        instructions: 'Caller responses instructions.',
        input: 'Phí giao hàng bao nhiêu?',
      },
    },
    {
      id: 'responses-stream-enriched',
      wire: 'responses',
      stream: true,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/responses',
      body: {
        model: 'groq/compound',
        stream: true,
        input: 'Phí giao hàng bao nhiêu?',
      },
    },
    {
      id: 'responses-nonstream-plain',
      wire: 'responses',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/responses',
      body: {
        model: 'groq/compound',
        input: 'Hello plain responses',
      },
    },
    {
      id: 'gemini-nonstream-enriched',
      wire: 'gemini',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1beta/models/gemma-4-31b-it:generateContent',
      body: {
        systemInstruction: { parts: [{ text: 'Caller gemini system.' }] },
        contents: [{ role: 'user', parts: [{ text: 'Phí giao hàng bao nhiêu?' }] }],
      },
    },
    {
      id: 'gemini-stream-enriched',
      wire: 'gemini',
      stream: true,
      authKind: 'profile',
      withPromptAndKnowledge: true,
      withCacheControl: false,
      method: 'POST',
      path: '/v1beta/models/gemma-4-31b-it:streamGenerateContent?alt=sse',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Phí giao hàng bao nhiêu?' }] }],
      },
    },
    {
      id: 'gemini-nonstream-plain',
      wire: 'gemini',
      stream: false,
      authKind: 'profile',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1beta/models/gemma-4-31b-it:generateContent',
      body: {
        contents: [{ role: 'user', parts: [{ text: 'Hello plain gemini' }] }],
      },
    },
    {
      id: 'auth-unified-openai',
      wire: 'openai-chat',
      stream: false,
      authKind: 'unified',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'Hello unified auth' }],
      },
    },
    {
      id: 'auth-user-openai',
      wire: 'openai-chat',
      stream: false,
      authKind: 'user',
      withPromptAndKnowledge: false,
      withCacheControl: false,
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'groq/compound',
        messages: [{ role: 'user', content: 'Hello personal user auth' }],
      },
    },
  ];
}

describe('ai-platform frozen baseline regression (T005 / T033)', () => {
  let server: Server;
  let base: string;
  let fakeProvider: FakeProviderServer;
  const realFetch = global.fetch;

  let ownerToken: string;
  let enrichedProfileKey: string;
  let plainProfileKey: string;
  let unifiedKey: string;
  let userKey: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    resetKnowledgeIndexes();

    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });

    // Seed provider keys for Groq and Google so all 4 protocols route cleanly.
    for (const [platform, rawKey] of [
      ['groq', 'gsk_baseline_test'],
      ['google', 'AIzaBaselineTestKey'],
    ] as const) {
      const enc = encrypt(rawKey);
      getDb().prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, ?, ?, ?, ?, 'healthy', 1)`,
      ).run(platform, `${platform}-baseline`, enc.encrypted, enc.iv, enc.authTag);
    }

    fakeProvider = await startFakeProviderServer({
      kind: 'scripted',
      text: 'baseline-ok',
      textChunks: ['baseline-', 'ok'],
      usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 },
    });

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const ownerId = createUser('baseline-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    unifiedKey = getUnifiedApiKey();

    // Create personal user key
    userKey = mintUserApiKey(ownerId, 'baseline-user-key').key;
    expect(userKey).toMatch(/^sk-flm-/);

    // Enriched profile (system prompt + knowledge enabled)
    const enrichedRes = await realFetch(`${base}/api/client-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: 'baseline-enriched', systemPrompt: 'Enforced shop prompt.' }),
    });
    const enrichedBody = await enrichedRes.json() as { id: number; key: string };
    enrichedProfileKey = enrichedBody.key;
    await realFetch(`${base}/api/client-profiles/${enrichedBody.id}/quota`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ rpmLimit: null }),
    });
    await realFetch(`${base}/api/client-profiles/${enrichedBody.id}/knowledge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        title: 'Giao hàng',
        content: 'Phí giao hàng toàn quốc là 30.000đ, miễn phí cho đơn từ 500.000đ.',
      }),
    });
    await realFetch(`${base}/api/client-profiles/${enrichedBody.id}/knowledge-settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ enabled: true, maxChars: 1500 }),
    });

    // Plain profile (no system prompt, no knowledge)
    const plainRes = await realFetch(`${base}/api/client-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: 'baseline-plain' }),
    });
    const plainBody = await plainRes.json() as { id: number; key: string };
    plainProfileKey = plainBody.key;
    await realFetch(`${base}/api/client-profiles/${plainBody.id}/quota`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ rpmLimit: null }),
    });

    // Redirect all outbound provider fetches to our in-process fakeProvider HTTP server.
    vi.spyOn(global, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(base) || urlStr.startsWith(fakeProvider.url)) {
        return realFetch(input, init);
      }
      const parsed = new URL(urlStr);
      const targetUrl = `${fakeProvider.url}${parsed.pathname}${parsed.search}`;
      return realFetch(targetUrl, init);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fakeProvider.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    resetKnowledgeIndexes();
  });

  const cases = buildCases();

  it.each(cases)('matches frozen baseline for $id', async (c) => {
    fakeProvider.clearRequests();

    const token = c.authKind === 'unified'
      ? unifiedKey
      : c.authKind === 'user'
        ? userKey
        : c.withPromptAndKnowledge
          ? enrichedProfileKey
          : plainProfileKey;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (c.wire === 'anthropic') {
      headers['x-api-key'] = token;
      headers['anthropic-version'] = '2023-06-01';
    } else if (c.wire === 'gemini') {
      headers['x-goog-api-key'] = token;
    } else {
      headers['authorization'] = `Bearer ${token}`;
    }

    const res = await realFetch(`${base}${c.path}`, {
      method: c.method,
      headers,
      body: JSON.stringify(c.body),
    });

    const contentType = res.headers.get('content-type') ?? '';
    const rawText = await res.text();
    const recorded = fakeProvider.requests.at(-1) ?? null;

    const captured: CapturedFixture = {
      id: c.id,
      wire: c.wire,
      stream: c.stream,
      authKind: c.authKind,
      upstream: recorded
        ? {
            method: recorded.method,
            path: recorded.path,
            query: recorded.query,
            bodyJson: recorded.bodyJson,
          }
        : null,
      response: {
        status: res.status,
        contentType: contentType.split(';')[0].trim(),
        ...(contentType.includes('application/json')
          ? { bodyJson: normalizeVolatile(JSON.parse(rawText)) }
          : { bodyText: rawText }),
      },
    };

    const fixturePath = path.join(BASELINE_DIR, `${c.id}.json`);
    if (CAPTURE) {
      fs.mkdirSync(BASELINE_DIR, { recursive: true });
      fs.writeFileSync(fixturePath, JSON.stringify(captured, null, 2) + '\n', 'utf8');
      const manifest = {
        capturedAt: new Date().toISOString(),
        baseCommit: '17328a176bd02b7510c51d7a458d038e16848a0b',
        caseCount: cases.length,
        cases: cases.map(x => `${x.id}.json`),
      };
      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      expect(res.status).toBe(200);
      return;
    }

    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    expect(fs.existsSync(fixturePath)).toBe(true);
    const expected = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as CapturedFixture;
    expect(captured.response.status).toBe(expected.response.status);
    expect(captured.response.contentType).toBe(expected.response.contentType);
    expect(captured.upstream).toEqual(expected.upstream);
    if (expected.response.bodyJson !== undefined) {
      expect(captured.response.bodyJson).toEqual(expected.response.bodyJson);
    } else {
      // SSE payloads may contain volatile IDs/timestamps inside data lines; normalize JSON data lines if possible
      const normalizeSse = (txt: string) =>
        txt.split('\n').map(line => {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') return line;
          try {
            return 'data: ' + JSON.stringify(normalizeVolatile(JSON.parse(line.slice(6))));
          } catch {
            return line;
          }
        }).join('\n');
      expect(normalizeSse(captured.response.bodyText ?? '')).toBe(normalizeSse(expected.response.bodyText ?? ''));
    }
  });
});
