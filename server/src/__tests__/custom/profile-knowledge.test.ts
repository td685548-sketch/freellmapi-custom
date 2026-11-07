import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { chunkText, resetKnowledgeIndexes, tokenize } from '../../services/profile-knowledge.js';

// A client key's knowledge base: passages that match the user's question are added to the request as
// reference material, on every chat wire, only when switched on.

const SHIPPING = 'Giao hàng\n\nChúng tôi giao hàng toàn quốc trong 2-4 ngày làm việc. Phí giao hàng 30.000đ, miễn phí cho đơn từ 500.000đ.';
const RETURNS = 'Đổi trả\n\nKhách hàng được đổi trả trong 7 ngày nếu sản phẩm còn nguyên tem mác. Hoàn tiền qua chuyển khoản trong 3 ngày.';
const HOURS = 'Opening hours\n\nThe store is open Monday to Saturday, 9am to 9pm. Closed on Sundays.';

describe('knowledge base helpers', () => {
  it('splits text into passages of a bounded size and keeps short paragraphs together', () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} talks about something useful.`).join(' ');
    const chunks = chunkText(`Title\n\n${long}\n\nShort tail.`);
    expect(chunks.every(c => c.length <= 800)).toBe(true);
    expect(chunks.join(' ')).toContain('Sentence number 29');
    expect(chunkText('a\n\nb\n\nc')).toEqual(['a\n\nb\n\nc']);
    expect(chunkText('x'.repeat(2000)).length).toBe(3);
  });
  it('tokenizes Vietnamese and other scripts', () => {
    expect(tokenize('Phí GIAO hàng, 30.000đ?')).toEqual(['phí', 'giao', 'hàng', '30', '000đ']);
  });
});

describe('client key knowledge base', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const sent: any[] = [];
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const kb = (path = '', method = 'GET', body?: unknown, token = ownerToken) => call(`/api/client-profiles/${profileId}/knowledge${path}`, token, method, body);
  const settings = (body: unknown) => call(`/api/client-profiles/${profileId}/knowledge-settings`, ownerToken, 'PUT', body);
  const ask = async (question: string, extra: Record<string, unknown> = {}) => {
    sent.length = 0;
    const r = await call('/v1/chat/completions', profileKey, 'POST', { model: 'auto', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: question }], ...extra });
    return { status: r.status, upstream: sent[0] };
  };
  const systemText = (upstream: any) => (upstream?.messages ?? []).filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_kb');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','k',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    memberToken = createSession(createUser('member@example.com', 'MemberPass123!', 'member').userId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'shop', systemPrompt: 'You are the shop assistant.' });
    profileId = made.body.id;
    profileKey = made.body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      sent.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    for (const [title, content] of [['Giao hàng', SHIPPING], ['Đổi trả', RETURNS], ['Opening hours', HOURS]]) {
      expect((await kb('', 'POST', { title, content })).status).toBe(201);
    }
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => { await settings({ enabled: false, maxChars: 3000 }); });

  it('adds nothing while switched off', async () => {
    const r = await ask('Phí giao hàng bao nhiêu?');
    expect(r.status).toBe(200);
    expect(systemText(r.upstream)).not.toContain('Reference material');
  });

  it('adds the passages that match the question, after the other system messages', async () => {
    await settings({ enabled: true });
    const r = await ask('Phí giao hàng là bao nhiêu vậy?');
    const sys = systemText(r.upstream);
    expect(sys).toContain('Reference material from this website');
    expect(sys).toContain('30.000đ');
    expect(sys).not.toContain('Closed on Sundays');
    const roles = r.upstream.messages.map((m: any) => m.role);
    expect(roles.at(-1)).toBe('user');
    expect(r.upstream.messages.findIndex((m: any) => typeof m.content === 'string' && m.content.includes('Reference material')))
      .toBeGreaterThan(r.upstream.messages.findIndex((m: any) => m.content === 'Be brief.'));
    expect(sys).toContain('You are the shop assistant.'); // the key's own prompt is still there

    const hours = systemText((await ask('When are you open on Sunday?')).upstream);
    expect(hours).toContain('Closed on Sundays');
    expect(hours).not.toContain('30.000đ');
  });

  it('adds nothing when no passage matches', async () => {
    await settings({ enabled: true });
    expect(systemText((await ask('xyzzy qwerty')).upstream)).not.toContain('Reference material');
  });

  it('respects the character budget', async () => {
    await settings({ enabled: true, maxChars: 500 });
    const block = (await kb('/search?q=giao hàng đổi trả hoàn tiền')).body.block as string;
    const passages = block.split('### ').slice(1).join('');
    expect(passages.length).toBeLessThanOrEqual(500 + 40);
  });

  it('works on the Messages, Responses and Gemini wires too', async () => {
    await settings({ enabled: true });
    sent.length = 0;
    await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, system: 'Be brief.', messages: [{ role: 'user', content: 'Đổi trả trong mấy ngày?' }] }, { 'anthropic-version': '2023-06-01' });
    expect(JSON.stringify(sent[0])).toContain('nguyên tem mác');
    sent.length = 0;
    await call('/v1/responses', profileKey, 'POST', { model: 'llama-3.1-8b-instant', input: 'Đổi trả trong mấy ngày?' });
    expect(JSON.stringify(sent[0])).toContain('nguyên tem mác');
    sent.length = 0;
    await call(`/v1beta/models/llama-3.1-8b-instant:generateContent?key=${profileKey}`, undefined, 'POST', { contents: [{ role: 'user', parts: [{ text: 'Đổi trả trong mấy ngày?' }] }] });
    expect(JSON.stringify(sent[0] ?? {})).toContain('nguyên tem mác');
  });

  it('picks up edits and deletions at once', async () => {
    await settings({ enabled: true });
    const docs = (await kb()).body.docs as Array<{ id: number; title: string }>;
    const hours = docs.find(d => d.title === 'Opening hours')!;
    await kb(`/${hours.id}`, 'PUT', { title: 'Opening hours', content: 'We are now open every day including Sundays, 8am to 10pm.' });
    expect(systemText((await ask('Are you open on Sunday?')).upstream)).toContain('open every day');
    await kb(`/${hours.id}`, 'DELETE');
    expect(systemText((await ask('Are you open on Sunday?')).upstream)).not.toContain('open every day');
    expect((await kb()).body.docs).toHaveLength(2);
    resetKnowledgeIndexes(); // a restart rebuilds it from the database
    expect(systemText((await ask('Phí giao hàng?')).upstream)).toContain('30.000đ');
  });

  it('manages documents and settings behind the profile permissions, with limits', async () => {
    const list = await kb();
    expect(list.body.settings).toEqual({ enabled: false, maxChars: 3000 });
    expect(list.body.docs[0]).toMatchObject({ title: 'Giao hàng', chunks: 1 });
    expect((await kb('', 'GET', undefined, memberToken)).status).toBe(403);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await kb('', 'GET', undefined, delegateToken)).status).toBe(200);
    expect((await kb('/search?q=giao', 'GET', undefined, delegateToken)).status).toBe(200);
    expect((await kb('', 'POST', { title: 't', content: 'c' }, delegateToken)).status).toBe(403);
    setUserPermissions(delegateId, [], ownerId);
    for (const bad of [{ title: '', content: 'x' }, { title: 't', content: '' }, { title: 't', content: 'x'.repeat(20_001) }, { title: 't', content: 'c', extra: 1 }]) {
      expect((await kb('', 'POST', bad)).status).toBe(400);
    }
    for (const bad of [{ maxChars: 100 }, { maxChars: 50_000 }, { enabled: 'yes' }]) expect((await settings(bad)).status).toBe(400);
    expect((await kb('/99999', 'PUT', { title: 't', content: 'c' })).status).toBe(404);
    expect((await kb('/99999', 'DELETE')).status).toBe(404);
    expect((await call('/api/client-profiles/99999/knowledge', ownerToken)).status).toBe(404);
  });
});
