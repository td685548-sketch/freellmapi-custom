import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { mintXGatewayClientKey, revokeXGatewayClientKey, updateXGatewayClientKeyAccess } from '../../custom/x-gateway/client-keys.js';
import { invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { gatewayDiagnostics, recordToolProbe } from '../../custom/x-gateway/diagnostics.js';
import { probeTool } from '../../custom/x-gateway/tool-probe.js';

describe('X Gateway CLI operations over real HTTP', () => {
  let server: Server;
  let upstream: Server;
  let base: string;
  let session: string;
  let userId: number;
  let key: ReturnType<typeof mintXGatewayClientKey>;
  let upstreamStatus = 200;
  let calls: Array<{ model: string; authorization?: string }> = [];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    const fixture = express();
    fixture.use(express.json());
    fixture.post('/chat/completions', (req, res) => {
      calls.push({ model: req.body.model, authorization: req.get('Authorization') });
      if (upstreamStatus !== 200) { res.status(upstreamStatus).json({ error: { message: 'secret-provider-token' } }); return; }
      res.json({ id: 'fixture', object: 'chat.completion', model: req.body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } });
    });
    upstream = await new Promise<Server>(resolve => { const s = fixture.listen(0, '127.0.0.1', () => resolve(s)); });
    server = await new Promise<Server>(resolve => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    initDb(':memory:');
    invalidateConfigCache(); invalidateXGatewayKeyCache();
    setEnabled(true);
    const user = createUser('ops@example.com', 'AdminPass123!');
    userId = user.userId;
    session = createSession(userId);
    key = mintXGatewayClientKey(userId);
    const enc = encrypt('fixture-provider-key');
    const port = (upstream.address() as { port: number }).port;
    getDb().prepare(`INSERT INTO x_gateway_keys
      (provider,label,auth_method,encrypted_key,iv,auth_tag,base_url,models_json,status,enabled)
      VALUES ('groq','fixture','api_key',?,?,?,?,?,'healthy',1)`)
      .run(enc.encrypted, enc.iv, enc.authTag, `http://127.0.0.1:${port}`, JSON.stringify([{ id: 'fixture-model', name: 'Fixture' }]));
    calls = []; upstreamStatus = 200;
  });
  afterAll(async () => {
    await Promise.all([server, upstream].map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); })));
  });
  const test = async (toolId = 'cursor', extra: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}/api/x-gateway/tools/test`, { method: 'POST',
      headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId, key: key.key, model: 'groq/fixture-model', ...extra }) });
    return { status: response.status, data: await response.json() };
  };

  it.each(['cursor', 'claude', 'codex', 'gemini'])('verifies %s through its real protocol and selected model/key', async tool => {
    const { data } = await test(tool, { keyId: key.id });
    expect(data.ok).toBe(true);
    expect(data.status).toBe(200);
    expect(calls).toEqual([{ model: 'fixture-model', authorization: 'Bearer fixture-provider-key' }]);
    expect(JSON.stringify(data)).not.toContain(key.key);
  });
  it('does not infer with invalid, revoked or model-restricted keys', async () => {
    expect((await test('cursor', { key: 'sk-xgw-invalid' })).data).toMatchObject({ ok: false, status: 401 });
    updateXGatewayClientKeyAccess(userId, key.id, { restricted: true, allow: ['other/model'] });
    expect((await test()).data).toMatchObject({ ok: false, status: 403 });
    revokeXGatewayClientKey(userId, key.id);
    expect((await test()).data).toMatchObject({ ok: false, status: 401 });
    expect(calls).toHaveLength(0);
  });
  it('rejects a mismatch with the selected key', async () => {
    expect((await test('cursor', { keyId: key.id + 1 })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('honors the disabled gateway and sanitizes upstream failure', async () => {
    setEnabled(false);
    expect((await test()).data).toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(0);
    setEnabled(true); upstreamStatus = 500;
    const result = await test();
    expect(result.data.ok).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain('secret-provider-token');
  });
  it('runs the public ingress smoke command without printing credentials', async () => {
    const script = fileURLToPath(new URL('../../../../scripts/x-gateway-smoke.mjs', import.meta.url));
    const result = await promisify(execFile)(process.execPath, [script], {
      env: { ...process.env, GATEWAY_URL: base, X_GATEWAY_API_KEY: key.key, X_GATEWAY_MODEL: 'groq/fixture-model' }, timeout: 15_000,
    });
    expect(result.stdout).toContain('PASS:');
    expect(result.stdout).toContain('/livez: 200');
    expect(result.stdout + result.stderr).not.toContain(key.key);
    expect(calls).toHaveLength(1);
  });
  it('requires console authentication and rejects missing key/model or unknown tools', async () => {
    expect((await fetch(`${base}/api/x-gateway/tools/diagnostics`)).status).toBe(401);
    expect((await test('unknown')).status).toBe(400);
    expect((await test('cursor', { model: '' })).status).toBe(400);
    expect((await test('cursor', { key: '' })).status).toBe(400);
    const member = createUser('member-ops@example.com', 'MemberPass123!');
    expect((await fetch(`${base}/api/x-gateway/tools/diagnostics`, {
      headers: { Authorization: `Bearer ${createSession(member.userId)}` },
    })).status).toBe(403);
  });
  it('only records dated protocol evidence for the current console session', async () => {
    const diagnostics = async (token: string) => (await fetch(`${base}/api/x-gateway/tools/diagnostics`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json();
    expect((await diagnostics(session)).capabilities.find((c: { id: string }) => c.id === 'openai-chat').state).toBe('unverified');
    await test();
    const own = await diagnostics(session);
    expect(own.capabilities.find((c: { id: string }) => c.id === 'openai-chat')).toMatchObject({ state: 'ready', model: 'groq/fixture-model' });
    expect((await diagnostics(createSession(userId))).capabilities.find((c: { id: string }) => c.id === 'openai-chat').state).toBe('unverified');
    expect(JSON.stringify(own)).not.toContain(key.key);
    expect(own.capabilities.find((c: { id: string }) => c.id === 'media').state).toBe('unverified');
  });
  it('expires readiness and never upgrades saver/media based on text inference', () => {
    recordToolProbe('expiry', { ok: true, toolId: 'cursor', protocol: 'openai-chat', model: 'fixture-model',
      endpoint: '/thruline/v1/chat/completions', latencyMs: 1, checkedAt: new Date().toISOString() });
    expect(gatewayDiagnostics('expiry', Date.now() + 301_000).capabilities.find(c => c.id === 'openai-chat')?.state).toBe('unverified');
  });
  it('bounds and cancels malformed or stalled probe responses', async () => {
    const malformed = express();
    malformed.use(express.json());
    malformed.post('/thruline/v1/chat/completions', (req, res) => res.json(req.body.model === 'oversized'
      ? { choices: [{ message: { content: 'x'.repeat(100_000) } }] } : { choices: 'wrong' }));
    const s = await new Promise<Server>(resolve => { const listener = malformed.listen(0, '127.0.0.1', () => resolve(listener)); });
    try {
      const input = { toolId: 'cursor', key: key.key, model: 'auto' };
      expect((await probeTool((s.address() as { port: number }).port, input)).ok).toBe(false);
      expect((await probeTool((s.address() as { port: number }).port, { ...input, model: 'oversized' })).ok).toBe(false);
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      }));
      try { expect((await probeTool(1234, input, undefined, 10)).error).toContain('timed out'); }
      finally { spy.mockRestore(); }
    } finally { await new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }); }
  });
});
