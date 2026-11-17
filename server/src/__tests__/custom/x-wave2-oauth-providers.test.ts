import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, publicEncrypt, randomBytes, constants as cryptoConstants } from 'node:crypto';
import type { Server } from 'node:http';
import * as zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { decrypt } from '../../lib/crypto.js';
import { X_GATEWAY_OAUTH_EXECUTORS, X_GATEWAY_PROVIDERS, resolveXGatewayProvider } from '../../custom/provider-accounts/catalog.js';
import { AntigravityProvider, _resetAntigravityCachesForTests } from '../../custom/provider-accounts/antigravity.js';
import {
  GrokCliProvider,
  CodeBuddyProvider,
  ZedProvider,
  CursorProvider,
  wrapConnectRPCFrame,
  _resetOAuthWireCachesForTests,
} from '../../custom/provider-accounts/oauth-wire-executors.js';
import { AnthropicWireProvider } from '../../custom/provider-accounts/web-cookie.js';
import {
  createXiaomiHandshake,
  createZedHandshake,
  decryptXiaomiCallback,
  decryptZedAccessToken,
} from '../../custom/provider-accounts/oauth-extended.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

function sseResponse(lines: string[], status = 200): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`${l}\n`));
      c.close();
    },
  }), { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function encodeVarint(val: number): Uint8Array {
  const out: number[] = [];
  let v = val >>> 0;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function encodePbLen(fieldNum: number, payload: Uint8Array | string): Uint8Array {
  const tag = encodeVarint((fieldNum << 3) | 2);
  const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const len = encodeVarint(data.length);
  const res = new Uint8Array(tag.length + len.length + data.length);
  res.set(tag, 0); res.set(len, tag.length); res.set(data, tag.length + len.length);
  return res;
}

describe('Wave 2 OAuth executors & headless Render flows', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'b'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const owner = createUser(`wave2-admin-${Date.now()}@example.test`, 'TestPass#1234');
    adminToken = createSession(owner.userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetAntigravityCachesForTests();
    _resetOAuthWireCachesForTests();
  });

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it('registers all 26 OAuth catalog providers and keeps GLM as AnthropicWireProvider', () => {
    const oauthCatalog = X_GATEWAY_PROVIDERS.filter((p) => p.category === 'oauth');
    expect(oauthCatalog.length).toBeGreaterThanOrEqual(26);
    for (const entry of oauthCatalog) {
      expect(X_GATEWAY_OAUTH_EXECUTORS.has(entry.id)).toBe(true);
      expect(resolveXGatewayProvider(entry.id)).toBeDefined();
    }
    expect(resolveXGatewayProvider('glm')).toBeInstanceOf(AnthropicWireProvider);
    expect(resolveXGatewayProvider('antigravity')).toBeInstanceOf(AntigravityProvider);
    expect(resolveXGatewayProvider('grok-cli')).toBeInstanceOf(GrokCliProvider);
    expect(resolveXGatewayProvider('codebuddy-cn')).toBeInstanceOf(CodeBuddyProvider);
    expect(resolveXGatewayProvider('zed')).toBeInstanceOf(ZedProvider);
    expect(resolveXGatewayProvider('cursor')).toBeInstanceOf(CursorProvider);
  });

  it('handles Antigravity OAuth refresh, loadCodeAssist projectId lookup, v1internal envelope, and transient retry', async () => {
    let genCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ag-fresh-1', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes(':loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: 'proj-ag-99' }), { status: 200 });
      }
      if (url.includes(':generateContent')) {
        genCount++;
        const body = JSON.parse(String(init?.body));
        expect(body.project).toBe('proj-ag-99');
        expect(body.userAgent).toBe('antigravity');
        if (genCount === 1) return new Response('transient', { status: 503 });
        return new Response(JSON.stringify({
          response: {
            candidates: [{ content: { parts: [{ text: 'AG Reply' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 },
          },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const ag = resolveXGatewayProvider('antigravity') as AntigravityProvider;
    const out = await ag.chatCompletion(
      JSON.stringify({ accessToken: 'old', refreshToken: 'ag-refresh', expiresAt: 1 }),
      [{ role: 'user', content: 'hi' }],
      'gemini-3.1-pro-preview',
    );
    expect(genCount).toBe(2);
    expect(out.choices[0].message.content).toBe('AG Reply');
  });

  it('tracks Grok CLI monotonic turn index, CodeBuddy prompt neutralization & 6004 limit, and GLM OAuth token extraction', async () => {
    const grokTurns: string[] = [];
    let codebuddySystem = '';
    let glmAuth: string | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.includes('cli-chat-proxy.grok.com')) {
        grokTurns.push(headers.get('x-grok-turn-idx') || '');
        return sseResponse([
          'data: {"type":"response.output_text.delta","delta":"Grok OK"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2}}}',
        ]);
      }
      if (url.includes('copilot.tencent.com')) {
        const body = JSON.parse(String(init?.body));
        codebuddySystem = body.messages[0].content;
        if (body.reasoning_effort) expect(body.reasoning_summary).toBe('auto');
        if (body.messages[1].content === 'limit') {
          return new Response(JSON.stringify({ code: 6004, msg: '超出频率限制' }), { status: 400 });
        }
        return sseResponse([
          'data: {"id":"cb1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"CB OK"},"finish_reason":null}]}',
          'data: {"id":"cb1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ]);
      }
      if (url.includes('api.z.ai')) {
        glmAuth = headers.get('Authorization');
        return new Response(JSON.stringify({
          id: 'glm-1',
          model: 'glm-5',
          content: [{ type: 'text', text: 'GLM OK' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const grok = resolveXGatewayProvider('grok-cli') as GrokCliProvider;
    const g1 = await grok.chatCompletion(JSON.stringify({ accessToken: 'gx-1' }), [{ role: 'user', content: 'turn 1' }], 'grok-4');
    const g2 = await grok.chatCompletion(JSON.stringify({ accessToken: 'gx-1' }), [{ role: 'user', content: 'turn 2' }], 'grok-4');
    expect(g1.choices[0].message.content).toBe('Grok OK');
    expect(g2.choices[0].message.content).toBe('Grok OK');
    expect(grokTurns).toEqual(['1', '2']);

    const cb = resolveXGatewayProvider('codebuddy-cn') as CodeBuddyProvider;
    const cbRes = await cb.chatCompletion(
      JSON.stringify({ accessToken: 'cb-tok' }),
      [{ role: 'system', content: 'You are Claude Code, Anthropic official CLI.' }, { role: 'user', content: 'hi' }],
      'deepseek-v4-pro',
      { reasoning_effort: 'high' },
    );
    expect(cbRes.choices[0].message.content).toBe('CB OK');
    expect(codebuddySystem).not.toContain('Claude Code');

    await expect(cb.chatCompletion('cb-tok', [{ role: 'system', content: 'hi' }, { role: 'user', content: 'limit' }], 'deepseek-v4-pro')).rejects.toMatchObject({ status: 429 });

    const glm = resolveXGatewayProvider('glm')!;
    const glmOut = await glm.chatCompletion(JSON.stringify({ v: 1, kind: 'glm', accessToken: 'zcode-secret-123' }), [{ role: 'user', content: 'hi' }], 'glm-5');
    expect(glmOut.choices[0].message.content).toBe('GLM OK');
    expect(glmAuth).toBe('Bearer zcode-secret-123');
  });

  it('executes Zed LLM token exchange + NDJSON and Cursor gzip ConnectRPC protobuf framing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/client/users/me')) {
        return new Response(JSON.stringify({ default_organization_id: 'org-1' }), { status: 200 });
      }
      if (url.endsWith('/client/llm_tokens')) {
        return new Response(JSON.stringify({ token: 'zed-llm-tok-9' }), { status: 200 });
      }
      if (url.endsWith('/completions')) {
        return sseResponse([
          JSON.stringify({ event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Zed OK' } } }),
          JSON.stringify({ event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } }),
        ]);
      }
      if (url.includes('StreamUnifiedChatWithTools')) {
        const inner = encodePbLen(1, 'Cursor OK');
        const outer = encodePbLen(2, inner);
        const compressedFrame = wrapConnectRPCFrame(outer, true);
        expect(compressedFrame[0]).toBe(0x01);
        return new Response(compressedFrame, { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const zed = resolveXGatewayProvider('zed') as ZedProvider;
    const zOut = await zed.chatCompletion(JSON.stringify({ userId: 'u-1', accessToken: 'tok-1' }), [{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6');
    expect(zOut.choices[0].message.content).toBe('Zed OK');

    const cursor = resolveXGatewayProvider('cursor') as CursorProvider;
    const cOut = await cursor.chatCompletion('user_1::cursor-jwt-tok', [{ role: 'user', content: 'hi' }], 'claude-4.5-sonnet');
    expect(cOut.choices[0].message.content).toBe('Cursor OK');
    expect(zlib.gunzipSync).toBeTypeOf('function');
  });

  it('verifies Zed RSA-OAEP and Xiaomi MiMo X25519+AES-GCM crypto handshakes and subscription router endpoints', async () => {
    // 1. Unit verify Zed RSA handshake round-trip
    const zedHs = createZedHandshake();
    const rsaPub = createPublicKey({
      key: Buffer.from(zedHs.publicKeyB64Url, 'base64url'),
      format: 'der',
      type: 'pkcs1',
    });
    const zedEnc = publicEncrypt({ key: rsaPub, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from('zed-secret-tok')).toString('base64url');
    expect(decryptZedAccessToken(zedEnc, zedHs.privateKeyPem)).toBe('zed-secret-tok');

    // 2. Unit verify Xiaomi X25519 + AES-GCM round-trip
    const xmHs = createXiaomiHandshake('http://127.0.0.1/cb');
    const eph = generateKeyPairSync('x25519');
    const peerPub = createPublicKey({ key: Buffer.from(xmHs.publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: peerPub });
    const aesKey = createHash('sha256').update(shared).digest();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce);
    const ct = Buffer.concat([cipher.update(JSON.stringify({ uid: 'xm-9', sk: 'sk-mimo-secret', url: 'https://api.xiaomimimo.com/v1' }), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ephRaw = Buffer.from(eph.publicKey.export({ format: 'der', type: 'spki' })).subarray(-32);
    const uB64 = Buffer.concat([nonce, ephRaw, ct, tag]).toString('base64');
    expect(decryptXiaomiCallback(xmHs.privateKeyDerB64, uB64)).toEqual({ uid: 'xm-9', sk: 'sk-mimo-secret', url: 'https://api.xiaomimimo.com/v1' });

    // 3. HTTP test /subscriptions/capabilities, /start + /poll (grok-cli), and /bulk-import
    let pollIdx = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      if (url === 'https://auth.x.ai/oauth2/device/code') {
        return new Response(JSON.stringify({ device_code: 'dc-1', user_code: 'GROK-1', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 600 }), { status: 200 });
      }
      if (url === 'https://auth.x.ai/oauth2/token') {
        pollIdx++;
        if (pollIdx === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
        return new Response(JSON.stringify({ access_token: 'grok-live-acc', refresh_token: 'grok-live-ref', expires_in: 3600 }), { status: 200 });
      }
      return REAL_FETCH(input, init);
    });

    const capsRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/capabilities`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(capsRes.status).toBe(200);
    const caps = (await capsRes.json()) as { providers: Array<{ provider: string; login: boolean }> };
    expect(caps.providers.find((p) => p.provider === 'antigravity')?.login).toBe(true);
    expect(caps.providers.find((p) => p.provider === 'zed')?.login).toBe(true);

    const startRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: 'grok-cli', label: 'My Grok Build' }),
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as { attemptId: string; flow: string; userCode: string };
    expect(startBody.flow).toBe('device_code');
    expect(startBody.userCode).toBe('GROK-1');

    // Wait 2.1s so poll throttle window (2s min) elapses cleanly
    await new Promise((r) => setTimeout(r, 2100));
    const p1 = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/${startBody.attemptId}/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect((await p1.json()).status).toBe('pending');

    await new Promise((r) => setTimeout(r, 2100));
    const p2 = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/${startBody.attemptId}/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const p2Body = (await p2.json()) as { status: string; id: number };
    expect(p2Body.status).toBe('saved');
    const savedRow = getDb().prepare('SELECT provider, encrypted_key, iv, auth_tag FROM x_gateway_keys WHERE id = ?').get(p2Body.id) as any;
    expect(savedRow.provider).toBe('grok-cli');
    expect(JSON.parse(decrypt(savedRow.encrypted_key, savedRow.iv, savedRow.auth_tag)).accessToken).toBe('grok-live-acc');

    const bulkRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/bulk-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        credentials: [
          { provider: 'groq', label: 'Bulk Groq', key: 'gsk_bulk_1' },
          { provider: 'claude', label: 'Bulk Claude', accessToken: 'oat_1', refreshToken: 'ref_1', expiresAt: 1800000000000 },
          { provider: 'nonexistent-provider', key: 'bad' },
        ],
      }),
    });
    expect(bulkRes.status).toBe(200);
    const bulkBody = (await bulkRes.json()) as { imported: number; failed: number; errors: Array<{ index: number }> };
    expect(bulkBody.imported).toBe(2);
    expect(bulkBody.failed).toBe(1);
  }, 15000);
});
