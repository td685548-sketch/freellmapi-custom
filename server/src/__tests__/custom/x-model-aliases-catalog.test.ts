import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getModelAliases,
  setModelAlias,
  deleteModelAlias,
  resolveXGatewayModelAlias,
  setProviderModelConfig,
  invalidateXGatewayKeyCache,
} from '../../custom/provider-accounts/store.js';

describe('X model aliases, custom model caps and catalog sync', () => {
  let server: Server;
  let base: string;
  let admin: string;
  let reader: string;
  let modelManager: string;
  let outsider: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    admin = createSession(createUser('alias-admin@example.test', 'AdminPass123!').userId);
    const member = (email: string, permissions: string[]) => {
      const user = createUser(email, 'MemberPass123!', 'member');
      getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), user.userId);
      return createSession(user.userId);
    };
    reader = member('alias-reader@example.test', ['use_x_gateway']);
    modelManager = member('alias-manager@example.test', ['use_x_gateway', 'manage_key_models']);
    outsider = createSession(createUser('alias-outsider@example.test', 'MemberPass123!', 'member').userId);
    const secret = encrypt('gsk_alias_secret');
    getDb().prepare(`INSERT INTO x_gateway_keys
      (provider,label,auth_method,encrypted_key,iv,auth_tag,status,enabled) VALUES ('groq','Alias account','api_key',?,?,?,'healthy',1)`)
      .run(secret.encrypted, secret.iv, secret.authTag);
    invalidateXGatewayKeyCache();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server?.close(); });

  const call = (path: string, token = admin, method = 'GET', body?: unknown) => fetch(`${base}/api/x-accounts${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  describe('store helpers', () => {
    it('validates, stores and deletes aliases', () => {
      expect(getModelAliases()).toEqual({});
      expect(setModelAlias('coding-fast', 'groq/llama-3.3-70b-versatile')).toEqual({ 'coding-fast': 'groq/llama-3.3-70b-versatile' });
      expect(() => setModelAlias('', 'groq/x')).toThrow();
      expect(() => setModelAlias('has space', 'groq/x')).toThrow();
      expect(() => setModelAlias('a'.repeat(65), 'groq/x')).toThrow();
      expect(() => setModelAlias('__proto__', 'groq/x')).toThrow();
      expect(() => setModelAlias('ok', '   ')).toThrow();
      expect(setModelAlias('A_b.c-1', 'openai/gpt-4o')).toMatchObject({ 'A_b.c-1': 'openai/gpt-4o' });
      expect(deleteModelAlias('A_b.c-1')).toEqual({ 'coding-fast': 'groq/llama-3.3-70b-versatile' });
      expect(deleteModelAlias('missing')).toEqual({ 'coding-fast': 'groq/llama-3.3-70b-versatile' });
    });

    it('resolves aliases, the alias: prefix and passes unknown models through', () => {
      expect(resolveXGatewayModelAlias('coding-fast')).toBe('groq/llama-3.3-70b-versatile');
      expect(resolveXGatewayModelAlias('alias:coding-fast')).toBe('groq/llama-3.3-70b-versatile');
      expect(resolveXGatewayModelAlias('groq/other')).toBe('groq/other');
      expect(resolveXGatewayModelAlias('alias:missing')).toBe('alias:missing');
      expect(resolveXGatewayModelAlias('constructor')).toBe('constructor');
      expect(resolveXGatewayModelAlias('toString')).toBe('toString');
    });
  });

  describe('/model-aliases', () => {
    it('enforces authentication and permissions', async () => {
      expect((await call('/model-aliases', '')).status).toBe(401);
      expect((await call('/model-aliases', outsider)).status).toBe(403);
      expect((await call('/model-aliases', reader)).status).toBe(200);
      expect((await call('/model-aliases', reader, 'PUT', { alias: 'x', model: 'groq/y' })).status).toBe(403);
      expect((await call('/model-aliases?alias=coding-fast', reader, 'DELETE')).status).toBe(403);
      expect((await call('/model-aliases', modelManager, 'PUT', { alias: 'mgr', model: 'groq/y' })).status).toBe(200);
    });

    it('supports PUT, GET and DELETE via query and body', async () => {
      const put = await call('/model-aliases', admin, 'PUT', { alias: 'fast-coder', model: 'groq/llama-3.1-8b-instant' });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true, alias: 'fast-coder', model: 'groq/llama-3.1-8b-instant',
        aliases: { 'fast-coder': 'groq/llama-3.1-8b-instant', 'coding-fast': 'groq/llama-3.3-70b-versatile' },
      });
      expect((await (await call('/model-aliases')).json()).aliases['fast-coder']).toBe('groq/llama-3.1-8b-instant');

      const byQuery = await (await call('/model-aliases?alias=fast-coder', admin, 'DELETE')).json();
      expect(byQuery.ok).toBe(true);
      expect(byQuery.aliases['fast-coder']).toBeUndefined();

      await call('/model-aliases', admin, 'PUT', { alias: 'body-del', model: 'groq/z' });
      const byBody = await (await call('/model-aliases', admin, 'DELETE', { alias: 'body-del' })).json();
      expect(byBody.aliases['body-del']).toBeUndefined();
    });

    it('rejects invalid input', async () => {
      expect((await call('/model-aliases', admin, 'PUT', { alias: 'bad alias', model: 'groq/y' })).status).toBe(400);
      expect((await call('/model-aliases', admin, 'PUT', { alias: 'ok', model: '' })).status).toBe(400);
      expect((await call('/model-aliases', admin, 'PUT', { alias: 'ok', model: 'groq/y', extra: 1 })).status).toBe(400);
      expect((await call('/model-aliases', admin, 'DELETE')).status).toBe(400);
    });
  });

  describe('/custom-models/caps', () => {
    it('stores caps under provider/modelId and deletes them', async () => {
      expect((await (await call('/custom-models/caps')).json()).caps).toEqual({});
      const put = await call('/custom-models/caps', admin, 'PUT', {
        provider: 'groq', modelId: 'my-vision-model', caps: { vision: true, toolCall: false },
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, key: 'groq/my-vision-model', caps: { vision: true, toolCall: false } });
      expect((await (await call('/custom-models/caps')).json()).caps['groq/my-vision-model']).toEqual({ vision: true, toolCall: false });

      const del = await call('/custom-models/caps?provider=groq&modelId=my-vision-model', admin, 'DELETE');
      expect(del.status).toBe(200);
      expect((await del.json()).caps).toEqual({});
    });

    it('validates input and permissions', async () => {
      const put = (body: unknown, token = admin) => call('/custom-models/caps', token, 'PUT', body);
      expect((await put({ provider: 'groq', modelId: 'm', caps: {} })).status).toBe(400);
      expect((await put({ provider: 'groq', modelId: 'm', caps: { vision: 'yes' } })).status).toBe(400);
      expect((await put({ provider: 'groq', modelId: 'm', caps: { unknown: true } })).status).toBe(400);
      expect((await put({ provider: '', modelId: 'm', caps: { vision: true } })).status).toBe(400);
      expect((await put({ provider: 'groq', modelId: 'm', caps: { vision: true } }, reader)).status).toBe(403);
      expect((await call('/custom-models/caps?provider=groq', admin, 'DELETE')).status).toBe(400);
      expect((await call('/custom-models/caps', outsider)).status).toBe(403);
    });
  });

  describe('/catalog-sync', () => {
    it('reports an empty state before the first sync', async () => {
      expect(await (await call('/catalog-sync')).json()).toEqual({
        syncedAt: null, totalProviders: 0, totalModels: 0, customModelsCount: 0, aliasesCount: 0,
      });
    });

    it('syncs enabled providers with custom models and aliases', async () => {
      setProviderModelConfig('groq', { customModels: [{ id: 'sync-custom-model', name: 'Sync custom' }] });
      expect((await call('/catalog-sync', reader, 'POST')).status).toBe(403);

      const before = Date.now();
      const res = await call('/catalog-sync', admin, 'POST');
      expect(res.status).toBe(200);
      const synced = await res.json();
      expect(synced.totalProviders).toBe(1);
      expect(synced.customModelsCount).toBe(1);
      expect(synced.aliasesCount).toBe(Object.keys(getModelAliases()).length);
      expect(synced.totalModels).toBeGreaterThanOrEqual(1);
      expect(Date.parse(synced.syncedAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(synced.providers).toEqual([expect.objectContaining({ id: 'groq', models: synced.totalModels })]);

      const state = await (await call('/catalog-sync', reader)).json();
      expect(state).toEqual({
        syncedAt: synced.syncedAt, totalProviders: 1, totalModels: synced.totalModels,
        customModelsCount: 1, aliasesCount: synced.aliasesCount,
      });
      expect(JSON.stringify(synced)).not.toContain('gsk_alias_secret');
    });

    it('skips providers whose accounts are all disabled', async () => {
      getDb().prepare('UPDATE x_gateway_keys SET enabled = 0').run();
      invalidateXGatewayKeyCache();
      const synced = await (await call('/catalog-sync', admin, 'POST')).json();
      expect(synced.totalProviders).toBe(0);
      expect(synced.totalModels).toBe(0);
    });
  });
});
