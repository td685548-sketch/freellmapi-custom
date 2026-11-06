import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';

// A client profile's model allowlist and max_tokens cap, end to end on the Turso-style path: the key
// can only use the listed models (named, or reached through automatic routing), a request's output
// budget is lowered to the cap, and neither touches a profile without restrictions.

describe('client profile restrictions', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const upstream: Array<{ model: string; maxTokens: number | undefined }> = [];
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;
  let openKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const restrict = (body: unknown, id = profileId) => call(`/api/client-profiles/${id}/restrictions`, ownerToken, 'PUT', body);
  const chat = async (key: string, extra: Record<string, unknown> = {}) => {
    upstream.length = 0;
    const r = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...extra });
    await new Promise(res => setTimeout(res, 20));
    return r;
  };
  const rows = () => (getDb().prepare('SELECT DISTINCT model_id AS m FROM requests WHERE profile_id = ?').all(profileId) as Array<{ m: string }>).map(r => r.m);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_restrict');
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
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'restricted', systemPrompt: null });
    profileId = made.body.id;
    profileKey = made.body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });
    openKey = (await call('/api/client-profiles', ownerToken, 'POST', { name: 'open', systemPrompt: null })).body.key;
    await call(`/api/client-profiles/${(await call('/api/client-profiles', ownerToken)).body.find((p: any) => p.name === 'open').id}/quota`, ownerToken, 'PUT', { rpmLimit: null });

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const sent = JSON.parse(String(init?.body ?? '{}'));
      upstream.push({ model: sent.model, maxTokens: sent.max_tokens ?? sent.max_completion_tokens });
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: sent.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => { await restrict({ allowedModels: [], maxTokens: null }); getDb().prepare('DELETE FROM rate_limit_cooldowns').run(); });

  describe('model allowlist', () => {
    it('routes automatic requests only to the allowed models', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      for (let i = 0; i < 4; i++) {
        const r = await chat(profileKey);
        expect(r.status).toBe(200);
        expect(upstream.map(u => u.model)).toEqual(['llama-3.1-8b-instant']);
      }
      expect(rows()).toEqual(['llama-3.1-8b-instant']);
    });

    it('lets the key name an allowed model and refuses any other', async () => {
      await restrict({ allowedModels: ['Llama-3.1-8B-Instant', 'openai/gpt-oss-20b'] }); // stored lowercase
      expect((await chat(profileKey, { model: 'llama-3.1-8b-instant' })).status).toBe(200);
      expect((await chat(profileKey, { model: 'openai/gpt-oss-20b' })).status).toBe(200);
      const refused = await chat(profileKey, { model: 'llama-3.3-70b-versatile' });
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatchObject({ type: 'permission_error', code: 'model_not_allowed', allowed_models: ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'] });
      expect(refused.body.error.message).toContain("'llama-3.3-70b-versatile'");
      expect(upstream).toHaveLength(0);
    });

    it('applies to the other chat surfaces too', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      const msg = (model: string) => call('/v1/messages', profileKey, 'POST', { model, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-version': '2023-06-01' });
      expect((await msg('llama-3.3-70b-versatile')).status).toBe(403);
      expect((await msg('llama-3.1-8b-instant')).status).toBe(200);
      expect((await call('/v1/responses', profileKey, 'POST', { model: 'openai/gpt-oss-120b', input: 'hi' })).status).toBe(403);
      expect((await call('/v1/responses', profileKey, 'POST', { model: 'llama-3.1-8b-instant', input: 'hi' })).status).toBe(200);
      expect((await call('/v1/completions', profileKey, 'POST', { model: 'openai/gpt-oss-120b', prompt: 'hi' })).status).toBe(403);
    });

    it('asks for an explicit model where automatic routing is not narrowed', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      const embed = await call('/v1/embeddings', profileKey, 'POST', { model: 'auto', input: 'hi' });
      expect(embed.status).toBe(403);
      expect(embed.body.error.code).toBe('model_required');
      expect((await call('/v1/embeddings', profileKey, 'POST', { input: 'hi' })).body.error.code).toBe('model_required');
      expect((await call('/v1/embeddings', profileKey, 'POST', { model: 'text-embedding-3-small', input: 'hi' })).body.error.code).toBe('model_not_allowed');
      const gemini = (model: string, q = '') => call(`/v1beta/models/${model}:generateContent${q}`, profileKey, 'POST', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
      expect((await gemini('auto')).body.error.code).toBe('model_required');
      expect((await gemini('gemini-2.0-flash')).body.error.code).toBe('model_not_allowed');
      expect((await gemini('gemini-2.0-flash', `?key=${profileKey}`)).body.error.code).toBe('model_not_allowed');
    });

    it('leaves listings alone, and answers a clear 400 when no allowed model is enabled', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      expect((await call('/v1/models', profileKey)).status).toBe(200);
      await restrict({ allowedModels: ['a-model-that-does-not-exist'] });
      const none = await chat(profileKey);
      expect(none.status).toBe(400);
      expect(JSON.stringify(none.body)).toContain('may use');
    });

    it('does not touch a key without restrictions', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      expect((await chat(openKey, { model: 'llama-3.3-70b-versatile' })).status).toBe(200);
      expect(upstream[0]!.model).toBe('llama-3.3-70b-versatile');
      expect((await call('/v1/embeddings', openKey, 'POST', { model: 'auto', input: 'hi' })).status).not.toBe(403);
    });

    it('takes effect at once and lifts at once', async () => {
      expect((await chat(profileKey, { model: 'llama-3.3-70b-versatile' })).status).toBe(200);
      await restrict({ allowedModels: ['llama-3.1-8b-instant'] });
      expect((await chat(profileKey, { model: 'llama-3.3-70b-versatile' })).status).toBe(403);
      await restrict({ allowedModels: [] });
      expect((await chat(profileKey, { model: 'llama-3.3-70b-versatile' })).status).toBe(200);
    });
  });

  describe('max_tokens cap', () => {
    it('lowers a larger request to the cap and gives a request without one the cap', async () => {
      await restrict({ maxTokens: 100 });
      await chat(profileKey);
      expect(upstream[0]!.maxTokens).toBe(100);
      await chat(profileKey, { max_tokens: 5000 });
      expect(upstream[0]!.maxTokens).toBe(100);
      await chat(profileKey, { max_tokens: 40 });
      expect(upstream[0]!.maxTokens).toBe(40);
      await chat(profileKey, { max_completion_tokens: 9000 });
      expect(upstream[0]!.maxTokens).toBe(100);
      await chat(profileKey, { max_tokens: 'lots' });
      expect(upstream[0]!.maxTokens).toBe(100);
    });

    it('caps the other surfaces', async () => {
      await restrict({ maxTokens: 64 });
      upstream.length = 0;
      await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }, { 'anthropic-version': '2023-06-01' });
      expect(upstream[0]!.maxTokens).toBe(64);
      upstream.length = 0;
      await call('/v1/responses', profileKey, 'POST', { model: 'llama-3.1-8b-instant', input: 'hi', max_output_tokens: 8000 });
      expect(upstream[0]!.maxTokens).toBe(64);
      upstream.length = 0;
      await call('/v1/responses', profileKey, 'POST', { model: 'llama-3.1-8b-instant', input: 'hi' });
      expect(upstream[0]!.maxTokens).toBe(64);
    });

    it('leaves a request untouched when there is no cap', async () => {
      await chat(profileKey);
      expect(upstream[0]!.maxTokens).toBeUndefined();
      await chat(profileKey, { max_tokens: 7777 });
      expect(upstream[0]!.maxTokens).toBe(7777);
    });

    it('combines with the allowlist', async () => {
      await restrict({ allowedModels: ['llama-3.1-8b-instant'], maxTokens: 30 });
      expect((await chat(profileKey, { max_tokens: 999 })).status).toBe(200);
      expect(upstream[0]).toEqual({ model: 'llama-3.1-8b-instant', maxTokens: 30 });
    });
  });

  describe('management', () => {
    it('reads, normalizes, merges and clears', async () => {
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, ownerToken)).body.restrictions).toEqual({ allowedModels: [], maxTokens: null });
      const set = await restrict({ allowedModels: ['  GPT-4o ', 'gpt-4o', 'Llama-3.1-8b-instant'], maxTokens: 256 });
      expect(set.body.restrictions).toEqual({ allowedModels: ['gpt-4o', 'llama-3.1-8b-instant'], maxTokens: 256 });
      expect((await restrict({ maxTokens: null })).body.restrictions).toEqual({ allowedModels: ['gpt-4o', 'llama-3.1-8b-instant'], maxTokens: null });
      expect((await restrict({ allowedModels: [] })).body.restrictions.allowedModels).toEqual([]);
      expect(getDb().prepare('SELECT allowed_models AS a FROM client_profiles WHERE id = ?').get(profileId)).toEqual({ a: null });
    });

    it('guards the routes with the profile permissions and validates input', async () => {
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, memberToken)).status).toBe(403);
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, undefined)).status).toBe(401);
      setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, delegateToken)).status).toBe(200);
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, delegateToken, 'PUT', { maxTokens: 5 })).status).toBe(403);
      setUserPermissions(delegateId, ['edit_client_profiles'], ownerId);
      expect((await call(`/api/client-profiles/${profileId}/restrictions`, delegateToken, 'PUT', { maxTokens: 5 })).status).toBe(200);
      setUserPermissions(delegateId, [], ownerId);

      expect((await call('/api/client-profiles/99999/restrictions', ownerToken)).status).toBe(404);
      expect((await restrict({ maxTokens: 5 }, 99999)).status).toBe(404);
      expect((await call('/api/client-profiles/abc/restrictions', ownerToken)).status).toBe(400);
      for (const bad of [{ maxTokens: 0 }, { maxTokens: -1 }, { maxTokens: 1.5 }, { maxTokens: 2_000_000 }, { maxTokens: '5' }, { allowedModels: 'gpt' }, { allowedModels: [1] }, { allowedModels: [''] }, { allowedModels: Array(101).fill('m') }, { nope: 1 }]) {
        expect((await restrict(bad)).status, JSON.stringify(bad)).toBe(400);
      }
    });
  });
});
