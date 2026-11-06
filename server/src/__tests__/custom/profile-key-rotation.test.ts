import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt, maskKey } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';

// Rotating a client profile's key with a grace period: the new key works at once, the old one keeps
// working as the same profile until the grace period ends (or is ended), then is refused everywhere.

describe('client profile key rotation with a grace period', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let currentKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
  };
  const chat = async (key: string) => {
    const r = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(res => setTimeout(res, 15));
    return r.status;
  };
  const rotate = (graceHours: unknown, id = profileId, token = ownerToken) => call(`/api/client-profiles/${id}/rotate-with-grace`, token, 'POST', graceHours === undefined ? {} : { graceHours });
  const fresh = async (name: string) => {
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name, systemPrompt: null });
    await call(`/api/client-profiles/${made.body.id}/quota`, ownerToken, 'PUT', { rpmLimit: null });
    return made.body as { id: number; key: string };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_rotation');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','r',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    memberToken = createSession(createUser('member@example.com', 'MemberPass123!', 'member').userId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const sent = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: sent.model ?? 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  beforeEach(async () => {
    const p = await fresh(`p-${Math.random().toString(36).slice(2, 8)}`);
    profileId = p.id;
    currentKey = p.key;
  });

  it('gives a new key at once and keeps the old one working as the same profile', async () => {
    const old = currentKey;
    const r = await rotate(24);
    expect(r.status).toBe(200);
    expect(r.body.key).toMatch(/^sk-cp-/);
    expect(r.body.key).not.toBe(old);
    expect(r.body.maskedKey).toBe(maskKey(r.body.key));
    const expires = Date.parse(r.body.previousKeyExpiresAt);
    expect(expires - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    expect(expires - Date.now()).toBeLessThan(24.1 * 3_600_000);

    expect(await chat(r.body.key)).toBe(200);
    expect(await chat(old)).toBe(200);
    const rows = getDb().prepare('SELECT profile_id AS p FROM requests WHERE profile_id = ?').all(profileId);
    expect(rows).toHaveLength(2);
  });

  it('shares the limits between the old and the new key', async () => {
    const old = currentKey;
    const { body } = await rotate(1);
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: 2 });
    expect(await chat(old)).toBe(200);
    expect(await chat(body.key)).toBe(200);
    expect(await chat(old)).toBe(429);
    expect(await chat(body.key)).toBe(429);
  });

  it('accepts the old key on the other surfaces too', async () => {
    const old = currentKey;
    await rotate(2);
    const messages = await call('/v1/messages', undefined, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': old, 'anthropic-version': '2023-06-01' });
    expect(messages.status).toBe(200);
    expect((await call('/v1/models', old)).status).toBe(200);
    const gemini = await call(`/v1beta/models/llama-3.1-8b-instant:generateContent?key=${old}`, undefined, 'POST', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
    expect(gemini.status).not.toBe(401);
  });

  it('lists the keys still in their grace period without revealing them', async () => {
    const old = currentKey;
    await rotate(3);
    const list = await call(`/api/client-profiles/${profileId}/previous-keys`, ownerToken);
    expect(list.status).toBe(200);
    expect(list.body.previousKeys).toHaveLength(1);
    expect(list.body.previousKeys[0].keyHint).toBe(maskKey(old));
    expect(list.text).not.toContain(old);
    expect(list.text).not.toMatch(/[0-9a-f]{64}/); // no hash either
  });

  it('refuses the old key once its grace period is over, everywhere', async () => {
    const old = currentKey;
    const { body } = await rotate(1);
    getDb().prepare('UPDATE custom_profile_previous_keys SET expires_at_ms = ? WHERE profile_id = ?').run(Date.now() - 1, profileId);
    expect(await chat(old)).toBe(401);
    expect((await call('/v1/models', old)).status).toBe(401);
    expect(await chat(body.key)).toBe(200);
    expect((await call(`/api/client-profiles/${profileId}/previous-keys`, ownerToken)).body.previousKeys).toEqual([]);
  });

  it('can end the grace period at once', async () => {
    const old = currentKey;
    const { body } = await rotate(48);
    expect(await chat(old)).toBe(200);
    const ended = await call(`/api/client-profiles/${profileId}/previous-keys`, ownerToken, 'DELETE');
    expect(ended.body).toEqual({ revoked: 1 });
    expect(await chat(old)).toBe(401);
    expect(await chat(body.key)).toBe(200);
  });

  it('refuses both keys of a disabled or deleted profile', async () => {
    const old = currentKey;
    const { body } = await rotate(24);
    await call(`/api/client-profiles/${profileId}`, ownerToken, 'PATCH', { enabled: false });
    expect(await chat(old)).toBe(401);
    expect(await chat(body.key)).toBe(401);
    await call(`/api/client-profiles/${profileId}`, ownerToken, 'PATCH', { enabled: true });
    expect(await chat(old)).toBe(200);
    await call(`/api/client-profiles/${profileId}`, ownerToken, 'DELETE');
    expect(await chat(old)).toBe(401);
    expect(await chat(body.key)).toBe(401);
  });

  it('leaves the immediate rotation as it was', async () => {
    const first = currentKey;
    const graced = await rotate(24); // `first` is now in its grace period
    const immediate = await call(`/api/client-profiles/${profileId}/rotate`, ownerToken, 'POST');
    expect(immediate.status).toBe(200);
    expect(await chat(graced.body.key)).toBe(401); // the key the immediate rotation replaced dies at once
    expect(await chat(first)).toBe(200); // an earlier grace period runs its course
    expect(await chat(immediate.body.key)).toBe(200);
  });

  it('keeps at most five previous keys', async () => {
    const keys = [currentKey];
    for (let i = 0; i < 6; i++) keys.push((await rotate(24)).body.key);
    expect((await call(`/api/client-profiles/${profileId}/previous-keys`, ownerToken)).body.previousKeys).toHaveLength(5);
    expect(await chat(keys[0]!)).toBe(401); // the oldest one fell off
    for (const k of keys.slice(1)) expect(await chat(k)).toBe(200);
  });

  it('is guarded by the profile permissions and validates its input', async () => {
    expect((await rotate(24, profileId, memberToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/previous-keys`, memberToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/rotate-with-grace`, undefined, 'POST', { graceHours: 24 })).status).toBe(401);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/previous-keys`, delegateToken)).status).toBe(200);
    expect((await rotate(24, profileId, delegateToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/previous-keys`, delegateToken, 'DELETE')).status).toBe(403);
    setUserPermissions(delegateId, ['edit_client_profiles'], ownerId);
    expect((await rotate(24, profileId, delegateToken)).status).toBe(200);
    setUserPermissions(delegateId, [], ownerId);

    for (const bad of [0, 169, 1.5, '24', null, undefined]) expect((await rotate(bad)).status, String(bad)).toBe(400);
    expect((await rotate(24, 99999)).status).toBe(404);
    expect((await call('/api/client-profiles/99999/previous-keys', ownerToken)).status).toBe(404);
    expect((await call('/api/client-profiles/abc/previous-keys', ownerToken)).status).toBe(400);
  });
});
