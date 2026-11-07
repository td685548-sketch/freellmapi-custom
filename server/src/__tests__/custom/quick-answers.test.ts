import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { foldWords, resetQuickAnswerCache, similarity } from '../../services/quick-answers.js';

// Ready answers: a visitor message close enough to a stored question is answered at once, in the
// requested format, without a provider call.

describe('quick answer matching', () => {
  it('ignores case, punctuation and Vietnamese accents', () => {
    expect(foldWords('Phí SHIP bao nhiêu? Đơn hàng')).toEqual(['phi', 'ship', 'bao', 'nhieu', 'don', 'hang']);
    expect(similarity(foldWords('phi ship bao nhieu'), foldWords('Phí ship bao nhiêu?'))).toBe(1);
    expect(similarity(foldWords('giờ mở cửa'), foldWords('mấy giờ cửa hàng mở cửa vậy'))).toBeLessThan(0.85);
    expect(similarity([], ['a'])).toBe(0);
  });
});

describe('client key ready answers', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  let upstreamCalls = 0;
  let ownerId: number;
  let ownerToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;
  let shippingId: number;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* stream */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const qa = (path = '', method = 'GET', body?: unknown, token = ownerToken) => call(`/api/client-profiles/${profileId}/quick-answers${path}`, token, method, body);
  const settings = (body: unknown) => call(`/api/client-profiles/${profileId}/quick-answer-settings`, ownerToken, 'PUT', body);
  const chat = (content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    call('/v1/chat/completions', profileKey, 'POST', { model: 'auto', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content }], ...extra }, headers);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_qa');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','k',?,?,?,'healthy',1)`).run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'shop' });
    profileId = made.body.id;
    profileKey = made.body.key;
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      upstreamCalls += 1;
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'from the AI' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    shippingId = (await qa('', 'POST', { questions: ['Phí ship bao nhiêu?', 'Phí giao hàng là bao nhiêu'], answer: 'Phí ship 30.000đ, miễn phí từ 500.000đ.' })).body.answer.id;
    await qa('', 'POST', { questions: ['Mấy giờ mở cửa?'], answer: 'Mở cửa 9h–21h.' });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => { await settings({ enabled: false, minSimilarity: 85 }); });

  it('does nothing while switched off', async () => {
    const before = upstreamCalls;
    const r = await chat('phi ship bao nhieu');
    expect(r.body.choices[0].message.content).toBe('from the AI');
    expect(upstreamCalls).toBe(before + 1);
  });

  it('answers a matching message at once, without a provider call, and counts the hit', async () => {
    await settings({ enabled: true });
    const before = upstreamCalls;
    const r = await chat('phi ship bao nhieu vay');  // accents left out, one extra word: 0.91
    expect(r.status).toBe(200);
    expect(r.headers.get('x-quick-answer')).toBe(String(shippingId));
    expect(r.body).toMatchObject({ object: 'chat.completion', model: 'quick-answer', choices: [{ message: { role: 'assistant', content: 'Phí ship 30.000đ, miễn phí từ 500.000đ.' }, finish_reason: 'stop' }] });
    expect(upstreamCalls).toBe(before);
    expect((await chat('Tell me about your return policy')).body.choices[0].message.content).toBe('from the AI');
    const listed = (await qa()).body.answers.find((a: any) => a.id === shippingId);
    expect(listed.hits).toBe(1);
    expect(listed.lastHitAt).toEqual(expect.any(String));
  });

  it('streams in the caller\'s format, on chat completions and Messages', async () => {
    await settings({ enabled: true });
    const streamed = await chat('Mấy giờ mở cửa?', { stream: true });
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    expect(streamed.body).toContain('"content":"Mở cửa 9h–21h."');
    expect(streamed.body).toContain('"finish_reason":"stop"');
    expect(streamed.body.trim().endsWith('data: [DONE]')).toBe(true);
    const headers = { 'anthropic-version': '2023-06-01' };
    const msg = await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, messages: [{ role: 'user', content: 'mấy giờ mở cửa' }] }, headers);
    expect(msg.body).toMatchObject({ type: 'message', role: 'assistant', model: 'quick-answer', content: [{ type: 'text', text: 'Mở cửa 9h–21h.' }], stop_reason: 'end_turn' });
    const msgStream = await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'mấy giờ mở cửa' }] }, headers);
    expect(msgStream.body).toContain('event: message_stop');
    expect(msgStream.body).toContain('"text_delta","text":"Mở cửa 9h–21h."');
  });

  it('is kept in a stored conversation like any reply', async () => {
    await settings({ enabled: true });
    getDb().prepare('UPDATE client_profiles SET conv_enabled = 1 WHERE id = ?').run(profileId);
    await chat('Mấy giờ mở cửa?', {}, { 'x-conversation-id': 'qa-1' });
    const stored = getDb().prepare("SELECT m.role, m.content FROM custom_conversation_messages m JOIN custom_conversations c ON c.id = m.conversation_id WHERE c.conv_key = 'qa-1' ORDER BY m.id").all();
    expect(stored).toEqual([{ role: 'user', content: 'Mấy giờ mở cửa?' }, { role: 'assistant', content: 'Mở cửa 9h–21h.' }]);
    getDb().prepare('UPDATE client_profiles SET conv_enabled = 0 WHERE id = ?').run(profileId);
  });

  it('respects the threshold, disabled answers and edits', async () => {
    await settings({ enabled: true, minSimilarity: 100 });
    expect((await chat('phi ship bao nhieu vay')).headers.get('x-quick-answer')).toBeNull();
    expect((await qa(`/match?message=${encodeURIComponent('Phí ship bao nhiêu')}`)).body.match).toMatchObject({ id: shippingId, similarity: 100 });
    await qa(`/${shippingId}`, 'PUT', { enabled: false });
    expect((await chat('Phí ship bao nhiêu?')).headers.get('x-quick-answer')).toBeNull();
    await qa(`/${shippingId}`, 'PUT', { enabled: true, answer: 'Ship 25.000đ.' });
    expect((await chat('Phí ship bao nhiêu?')).body.choices[0].message.content).toBe('Ship 25.000đ.');
  });

  it('validates input and keeps changes behind the edit permission', async () => {
    expect((await qa('', 'POST', { questions: [], answer: 'x' })).status).toBe(400);
    expect((await qa('', 'POST', { questions: ['q'], answer: '' })).status).toBe(400);
    expect((await settings({ minSimilarity: 20 })).status).toBe(400);
    expect((await qa('/9999', 'DELETE')).status).toBe(404);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await qa('', 'GET', undefined, delegateToken)).status).toBe(200);
    expect((await qa('/match?message=hi', 'GET', undefined, delegateToken)).status).toBe(200);
    expect((await qa('', 'POST', { questions: ['q'], answer: 'a' }, delegateToken)).status).toBe(403);
    expect((await qa(`/${shippingId}`, 'DELETE', undefined, delegateToken)).status).toBe(403);
    setUserPermissions(delegateId, [], ownerId);
    const extra = (await qa('', 'POST', { questions: ['temp'], answer: 'temp' })).body.answer.id;
    expect((await qa(`/${extra}`, 'DELETE')).body).toEqual({ deleted: 1 });
    resetQuickAnswerCache();
  });
});
