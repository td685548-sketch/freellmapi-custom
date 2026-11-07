import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { defaultDbFactory, getDb, initDb } from '../../db/index.js';
import { wrapTursoDatabase } from '../../db/turso.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setKeyCacheTestOverride } from '../../services/key-cache.js';
import { setUserPermissions } from '../../services/users.js';
import { normalizeConversationId, pruneConversations, resetConversationPruning } from '../../services/profile-conversations.js';
import { replyText } from '../../custom/conversation-inject.js';

// Server-side conversations for client keys: the web app sends X-Conversation-Id with only the new
// message; earlier turns are added from storage, and a turn is stored once its reply has completed.

describe('conversation helpers', () => {
  it('accepts ids of safe characters only', () => {
    expect(normalizeConversationId(' chat-42:abc_1.x ')).toBe('chat-42:abc_1.x');
    for (const bad of ['', 'a b', 'a/b', 'x'.repeat(129), 'ñ', 42]) expect(normalizeConversationId(bad)).toBeNull();
  });

  it('reads the reply of complete responses only', () => {
    expect(replyText('chat', JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), false)).toBe('hi');
    expect(replyText('chat', JSON.stringify({ error: { message: 'x' } }), false)).toBeNull();
    const frames = (...f: unknown[]) => f.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n';
    expect(replyText('chat', frames({ choices: [{ index: 0, delta: { content: 'he' } }] }, { choices: [{ index: 0, delta: { content: 'y' }, finish_reason: 'stop' }] }), true)).toBe('hey');
    // cut off before finish_reason, or an in-band error frame: not stored
    expect(replyText('chat', frames({ choices: [{ index: 0, delta: { content: 'he' } }] }), true)).toBeNull();
    expect(replyText('chat', frames({ choices: [{ index: 0, delta: { content: 'he' } }] }, { error: { message: 'boom' } }), true)).toBeNull();
    const anthropic = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"xin chào"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
    expect(replyText('anthropic', anthropic, true)).toBe('xin chào');
    expect(replyText('anthropic', JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), false)).toBe('ab');
  });
});

describe('client key stored conversations', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;
  const sent: any[] = [];
  let replies = 0;
  let failUpstream = false;
  let slowStream = false;
  const summaryCalls: any[] = [];
  let ownerId: number;
  let ownerToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;
  let otherKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const settings = (body: unknown) => call(`/api/client-profiles/${profileId}/conversation-settings`, ownerToken, 'PUT', body);
  const chat = async (conversation: string | null, content: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, key = profileKey) => {
    sent.length = 0;
    const r = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content }], ...extra },
      { ...(conversation ? { 'x-conversation-id': conversation } : {}), ...headers });
    return { ...r, upstream: sent[0] };
  };
  const convoOf = (upstream: any) => (upstream?.messages ?? []).filter((m: any) => m.role !== 'system').map((m: any) => `${m.role}:${m.content}`);
  const stored = (id: string) => getDb().prepare('SELECT m.role, m.content FROM custom_conversation_messages m JOIN custom_conversations c ON c.id = m.conversation_id WHERE c.profile_id = ? AND c.conv_key = ? ORDER BY m.id').all(profileId, id) as Array<{ role: string; content: string }>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    vi.stubEnv('FREEAPI_TURSO_BATCH_WRITES', '1');
    // This suite sends many requests through one loopback IP. Conversation
    // assertions must not depend on how fast a CI runner reaches the IP cap.
    vi.stubEnv('PROXY_RATE_LIMIT_RPM', '0');
    setKeyCacheTestOverride(true);
    initDb(':memory:', { factory: () => wrapTursoDatabase(defaultDbFactory()(':memory:'), true) });
    const key = encrypt('gsk_conv');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','k',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    getDb().prepare("UPDATE models SET rpm_limit = NULL, rpd_limit = NULL WHERE platform = 'groq'").run();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: 'shop', systemPrompt: 'You are the shop assistant.' });
    profileId = made.body.id;
    profileKey = made.body.key;
    otherKey = (await call('/api/client-profiles', ownerToken, 'POST', { name: 'blog' })).body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null }); // this file sends well over 60 a minute
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith(base)) return realFetch(url, init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      sent.push(body);
      if (failUpstream) return new Response(JSON.stringify({ error: { message: 'upstream down' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      if ((body.messages ?? []).some((m: any) => typeof m.content === 'string' && m.content.includes('running summary'))) {
        summaryCalls.push(body);
        return new Response(JSON.stringify({ id: 's', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'Khách tên Lan, thích trà.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      replies += 1;
      const text = `reply ${replies}`;
      if (body.stream && slowStream) {
        // one frame now, the rest (with finish_reason) only after the caller is gone
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'part' }, finish_reason: null }] })}\n\n`));
            await new Promise(r => setTimeout(r, 250));
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: ' rest' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
              controller.close();
            } catch { /* cancelled */ }
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (body.stream) {
        const frames = [
          { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, 3) }, finish_reason: null }] },
          { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: text.slice(3) }, finish_reason: 'stop' }] },
        ];
        return new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); setKeyCacheTestOverride(null); });
  afterEach(async () => {
    failUpstream = false;
    getDb().prepare('DELETE FROM custom_conversation_messages').run();
    getDb().prepare('DELETE FROM custom_conversations').run();
    await settings({ enabled: false, ttlHours: 168, maxMessages: 20, maxChars: 12000, summarize: false });
    summaryCalls.length = 0;
  });

  it('leaves requests without X-Conversation-Id alone', async () => {
    await settings({ enabled: true });
    const r = await chat(null, 'hello');
    expect(r.status).toBe(200);
    expect(convoOf(r.upstream)).toEqual(['user:hello']);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversations').get()).toEqual({ n: 0 });
  });

  it('refuses X-Conversation-Id while the key has it switched off', async () => {
    const r = await chat('c1', 'hello');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('conversation_storage_disabled');
    expect(r.upstream).toBeUndefined();
  });

  it('adds the earlier turns in front of the new message and stores each completed turn', async () => {
    await settings({ enabled: true });
    const first = await chat('c1', 'Tên tôi là Lan');
    expect(first.status).toBe(200);
    expect(first.headers.get('x-conversation-history')).toBe('0');
    expect(convoOf(first.upstream)).toEqual(['user:Tên tôi là Lan']);
    const firstReply = first.body.choices[0].message.content;

    const second = await chat('c1', 'Tên tôi là gì?');
    expect(second.headers.get('x-conversation-id')).toBe('c1');
    expect(second.headers.get('x-conversation-history')).toBe('2');
    expect(convoOf(second.upstream)).toEqual(['user:Tên tôi là Lan', `assistant:${firstReply}`, 'user:Tên tôi là gì?']);
    // the web app's own system message and the key's prompt still lead
    expect(second.upstream.messages[0].role).toBe('system');
    expect(second.upstream.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n')).toContain('You are the shop assistant.');
    expect(stored('c1').map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // conversations are per key: the same id on another key starts empty
    await settings({ enabled: true });
    getDb().prepare('UPDATE client_profiles SET conv_enabled = 1').run();
    const other = await chat('c1', 'hi', {}, {}, otherKey);
    expect(other.headers.get('x-conversation-history')).toBe('0');
  });

  it('stores a streamed reply once the stream has finished', async () => {
    await settings({ enabled: true });
    const r = await chat('s1', 'stream please', { stream: true });
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain('data: [DONE]');
    const msgs = stored('s1');
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.content).toMatch(/^reply \d+$/);
  });

  it('stores nothing when the caller hangs up in the middle of a stream', async () => {
    await settings({ enabled: true });
    slowStream = true;
    const abort = new AbortController();
    const res = await realFetch(`${base}/v1/chat/completions`, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${profileKey}`, 'x-conversation-id': 'cut' },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'long answer please' }] }),
    });
    const reader = res.body!.getReader();
    await reader.read(); // the first frame arrived
    abort.abort();
    await reader.cancel().catch(() => {});
    await new Promise(r => setTimeout(r, 400)); // let the server notice and finish the upstream side
    slowStream = false;
    expect(stored('cut')).toEqual([]);
  });

  it('stores nothing for a failed request, so the web app can simply retry', async () => {
    await settings({ enabled: true });
    await chat('f1', 'one');
    failUpstream = true;
    const failed = await chat('f1', 'two');
    expect(failed.status).toBeGreaterThanOrEqual(400);
    failUpstream = false;
    expect(stored('f1').map(m => m.content)).toEqual(['one', expect.stringMatching(/^reply/)]);
    const retry = await chat('f1', 'two');
    expect(convoOf(retry.upstream)).toEqual(['user:one', expect.stringMatching(/^assistant:reply/), 'user:two']);
  });

  it('keeps a conversation to the end user it was started for', async () => {
    await settings({ enabled: true });
    expect((await chat('e1', 'mine', {}, { 'x-end-user': 'alice' })).status).toBe(200);
    expect((await chat('e1', 'peek', {}, { 'x-end-user': 'bob' })).body.error.code).toBe('conversation_end_user_mismatch');
    expect((await chat('e1', 'peek')).status).toBe(403);
    const again = await chat('e1', 'more', {}, { 'x-end-user': 'alice' });
    expect(again.headers.get('x-conversation-history')).toBe('2');
  });

  it('sends only the newest turns within the message and character limits, starting with a user turn', async () => {
    await settings({ enabled: true, maxMessages: 3 });
    for (const t of ['a', 'b', 'c']) await chat('t1', t);
    const r = await chat('t1', 'd');
    // the newest 3 are [assistant, user c, assistant]; a leading assistant turn is dropped
    expect(convoOf(r.upstream)).toEqual(['user:c', expect.stringMatching(/^assistant:reply/), 'user:d']);

    await settings({ maxMessages: 20, maxChars: 1000 });
    await chat('t2', 'x'.repeat(900));
    const small = await chat('t2', 'next');
    expect(convoOf(small.upstream).length).toBe(3); // 900 + "reply N" fits
    await chat('t2', 'y'.repeat(900));
    const trimmed = await chat('t2', 'last');
    // stored: x900, reply, next, reply, y900, reply → x900 no longer fits within 1000 characters
    const sentTurns = convoOf(trimmed.upstream);
    expect(sentTurns[0]).toBe('user:next');
    expect(sentTurns.some((m: string) => m.includes('x'.repeat(900)))).toBe(false);
    expect(sentTurns.at(-1)).toBe('user:last');
  });

  it('folds turns that no longer fit into a running summary, made with the key itself', async () => {
    await settings({ enabled: true, maxMessages: 2, summarize: true });
    await chat('sum', 'Tên tôi là Lan');
    await new Promise(r => setTimeout(r, 100));
    expect(summaryCalls).toHaveLength(0); // everything still fits
    await chat('sum', 'Tôi thích trà');
    for (let i = 0; i < 40 && summaryCalls.length === 0; i++) await new Promise(r => setTimeout(r, 25));
    expect(summaryCalls).toHaveLength(1);
    const prompt = summaryCalls[0].messages.at(-1).content as string;
    expect(prompt).toContain('User: Tên tôi là Lan');
    expect(prompt).not.toContain('Tôi thích trà'); // still in the window
    let row: any;
    for (let i = 0; i < 40; i++) {
      row = getDb().prepare("SELECT summary, summarized_through AS through FROM custom_conversations WHERE conv_key = 'sum'").get();
      if (row.summary) break;
      await new Promise(r => setTimeout(r, 25));
    }
    expect(row.summary).toBe('Khách tên Lan, thích trà.');
    const ids = stored('sum').length;
    expect(ids).toBe(4);
    // the summary call went through the key: attributed to it, with its own user agent
    const viaKey = getDb().prepare("SELECT COUNT(*) AS n FROM requests WHERE profile_id = ? AND client_user_agent = 'freellm-conversation-summary'").get(profileId) as { n: number };
    expect(viaKey.n).toBe(1);

    const third = await chat('sum', 'Tôi tên gì?');
    expect(third.headers.get('x-conversation-summary')).toBe('1');
    const sys = third.upstream.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    expect(sys).toContain('Summary of the earlier part of this conversation:\nKhách tên Lan, thích trà.');
    expect(convoOf(third.upstream)).toEqual(['user:Tôi thích trà', expect.stringMatching(/^assistant:reply/), 'user:Tôi tên gì?']);
    // the dashboard shows the summary too
    expect((await call(`/api/client-profiles/${profileId}/conversations/sum`, ownerToken)).body.conversation.summary).toBe('Khách tên Lan, thích trà.');
  });

  it('makes no summary call while summaries are off', async () => {
    await settings({ enabled: true, maxMessages: 2 });
    for (const t of ['a', 'b', 'c']) await chat('nosum', t);
    await new Promise(r => setTimeout(r, 150));
    expect(summaryCalls).toHaveLength(0);
  });

  it('keeps storage bounded for long conversations', async () => {
    await settings({ enabled: true, maxMessages: 2 });
    for (let i = 0; i < 25; i++) await chat('long', `m${i}`);
    const n = stored('long').length;
    expect(n).toBeLessThanOrEqual(40);
    expect(stored('long').at(-1)!.role).toBe('assistant');
    const row = getDb().prepare('SELECT message_count AS n FROM custom_conversations WHERE conv_key = ?').get('long') as { n: number };
    expect(row.n).toBe(n);
  });

  it('refuses ids, endpoints and messages it cannot keep', async () => {
    await settings({ enabled: true });
    expect((await chat('bad id', 'x')).body.error.code).toBe('invalid_conversation_id');
    const responses = await call('/v1/responses', profileKey, 'POST', { model: 'auto', input: 'x' }, { 'x-conversation-id': 'c' });
    expect(responses.body.error.code).toBe('conversation_unsupported_endpoint');
    const tool = await call('/v1/chat/completions', profileKey, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 't', content: '1' }] }, { 'x-conversation-id': 'c' });
    expect(tool.body.error.code).toBe('conversation_unsupported_message');
    const lastAssistant = await call('/v1/chat/completions', profileKey, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] }, { 'x-conversation-id': 'c' });
    expect(lastAssistant.body.error.code).toBe('conversation_unsupported_message');
  });

  it('works on the Messages wire', async () => {
    await settings({ enabled: true });
    const headers = { 'anthropic-version': '2023-06-01', 'x-conversation-id': 'a1' };
    const first = await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, system: 'Be brief.', messages: [{ role: 'user', content: [{ type: 'text', text: 'Xin chào' }] }] }, headers);
    expect(first.status).toBe(200);
    sent.length = 0;
    await call('/v1/messages', profileKey, 'POST', { model: 'llama-3.1-8b-instant', max_tokens: 20, messages: [{ role: 'user', content: 'Bạn nhớ không?' }] }, headers);
    expect(convoOf(sent[0])).toEqual(['user:Xin chào', expect.stringMatching(/^assistant:reply/), 'user:Bạn nhớ không?']);
  });

  it('forgets conversations past the time limit', async () => {
    await settings({ enabled: true, ttlHours: 1 });
    await chat('old', 'one');
    await chat('fresh', 'one');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
    getDb().prepare('UPDATE custom_conversations SET updated_at = ? WHERE conv_key = ?').run(twoHoursAgo, 'old');
    const listed = await call(`/api/client-profiles/${profileId}/conversations`, ownerToken);
    expect(listed.body.conversations.map((c: any) => c.id)).toEqual(['fresh']);
    resetConversationPruning();
    expect(pruneConversations()).toBe(1);
    expect(stored('old')).toEqual([]);
    expect(stored('fresh').length).toBe(2);
    // an expired one is also dropped when it is used again
    getDb().prepare('UPDATE custom_conversations SET updated_at = ? WHERE conv_key = ?').run(twoHoursAgo, 'fresh');
    expect((await chat('fresh', 'two')).headers.get('x-conversation-history')).toBe('0');
  });

  it('lets the dashboard list, read and erase conversations, with message text behind the edit permission', async () => {
    await settings({ enabled: true });
    await chat('d1', 'hello', {}, { 'x-end-user': 'alice' });
    await chat('d2', 'hi', {}, { 'x-end-user': 'alice' });
    await chat('d3', 'hey', {}, { 'x-end-user': 'bob' });
    const list = await call(`/api/client-profiles/${profileId}/conversations`, ownerToken);
    expect(list.body.settings.enabled).toBe(true);
    expect(list.body.conversations).toHaveLength(3);
    expect(list.body.conversations[0]).toMatchObject({ messages: 2, endUser: expect.any(String), expiresAt: expect.any(String) });
    const alice = await call(`/api/client-profiles/${profileId}/conversations?endUser=alice`, ownerToken);
    expect(alice.body.conversations.map((c: any) => c.id).sort()).toEqual(['d1', 'd2']);
    const read = await call(`/api/client-profiles/${profileId}/conversations/d1`, ownerToken);
    expect(read.body.messages.map((m: any) => m.content)[0]).toBe('hello');

    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/conversations`, delegateToken)).status).toBe(200);
    expect((await call(`/api/client-profiles/${profileId}/conversations/d1`, delegateToken)).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/conversations/d1`, delegateToken, 'DELETE')).status).toBe(403);
    expect((await call(`/api/client-profiles/${profileId}/conversation-settings`, delegateToken, 'PUT', { enabled: false })).status).toBe(403);
    setUserPermissions(delegateId, [], ownerId);

    expect((await call(`/api/client-profiles/${profileId}/conversations/d3`, ownerToken, 'DELETE')).body).toEqual({ deleted: 1 });
    expect((await call(`/api/client-profiles/${profileId}/conversations?endUser=alice`, ownerToken, 'DELETE')).body).toEqual({ deleted: 2 });
    expect((await call(`/api/client-profiles/${profileId}/conversations`, ownerToken, 'DELETE')).status).toBe(400);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM custom_conversation_messages').get()).toEqual({ n: 0 });
    expect((await settings({ maxMessages: 1 })).status).toBe(400);
  });

  it('lets the web app read and erase what is kept, with its own key and without using its allowance', async () => {
    await settings({ enabled: true });
    await chat('w1', 'hello', {}, { 'x-end-user': 'alice' });
    await chat('w2', 'hi', {}, { 'x-end-user': 'alice' });
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    const got = await call('/v1/stored-conversations/w1', profileKey);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: 'w1', end_user: 'alice' });
    expect(got.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect((await call('/v1/stored-conversations/w1', otherKey)).status).toBe(404);
    expect((await call('/v1/stored-conversations/w1', 'sk-cp-nope')).status).toBe(401);
    expect((await call('/v1/stored-conversations/w1', undefined)).status).toBe(401);
    expect((await call('/v1/stored-conversations/w1', profileKey, 'DELETE')).body).toEqual({ deleted: 1 });
    expect((await call('/v1/stored-conversations?end_user=alice', profileKey, 'DELETE')).body).toEqual({ deleted: 1 });
    expect((await call('/v1/stored-conversations', profileKey, 'DELETE')).status).toBe(400);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n).toBe(before);
  });
});
