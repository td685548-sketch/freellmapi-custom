import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, getUnifiedApiKey, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';

// Playground chats use the unified key; with the dashboard session alongside, they count for that account.

describe('Playground attribution', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let ownerId: number;
  let ownerToken: string;
  let profileKey: string;

  const chat = async (key: string, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await res.text();
    return getDb().prepare('SELECT user_id AS userId, profile_id AS profileId FROM requests ORDER BY id DESC LIMIT 1').get() as { userId: number | null; profileId: number | null };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    setKeyCacheTestOverride(true);
    initDb(':memory:');
    const key = encrypt('gsk_pg');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','k',?,?,?,'healthy',1)`).run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    const made = await (await realFetch(`${base}/api/client-profiles`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ name: 'shop' }) })).json() as { key: string };
    profileKey = made.key;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); setKeyCacheTestOverride(null); });

  it('counts a unified-key chat for the signed-in account', async () => {
    expect(await chat(getUnifiedApiKey(), { 'x-freellm-session': ownerToken })).toEqual({ userId: ownerId, profileId: null });
  });

  it('leaves everything else as it was', async () => {
    expect((await chat(getUnifiedApiKey())).userId).toBeNull();
    expect((await chat(getUnifiedApiKey(), { 'x-freellm-session': 'not-a-session' })).userId).toBeNull();
    // a client key stays the client key's, whatever session is sent with it
    const viaKey = await chat(profileKey, { 'x-freellm-session': ownerToken });
    expect(viaKey.userId).toBeNull();
    expect(viaKey.profileId).toEqual(expect.any(Number));
  });
});
