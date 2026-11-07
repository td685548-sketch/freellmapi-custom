import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

// Visitor feedback: the web app's backend reports thumbs up / down on replies with its client key; the
// dashboard shows how satisfied visitors are, per model, and their comments.

describe('reply feedback', () => {
  let server: Server;
  let base: string;
  let ownerId: number;
  let ownerToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;
  let otherId: number;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const vote = (body: unknown, headers: Record<string, string> = {}, key = profileKey) => call('/v1/feedback', key, 'POST', body, headers);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
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
    otherId = (await call('/api/client-profiles', ownerToken, 'POST', { name: 'blog' })).body.id;
  });
  afterAll(() => { server?.close(); });

  it('takes votes from the web app with its client key, without using its allowance', async () => {
    const requestsBefore = (getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n;
    expect((await vote({ rating: 'up', model: 'qwen3', reference: 'chatcmpl-1' })).status).toBe(201);
    expect((await vote({ rating: 'down', model: 'llama', comment: 'Sai giá ship', conversation_id: 'c-1' }, { 'x-end-user': 'khách-1' })).status).toBe(201);
    expect((await vote({ rating: 'down', model: 'llama' })).status).toBe(201);
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM requests').get() as { n: number }).n).toBe(requestsBefore);
    expect((await vote({ rating: 'meh' })).status).toBe(400);
    expect((await vote({ rating: 'up', comment: 'x'.repeat(1001) })).status).toBe(400);
    expect((await vote({ rating: 'up' }, {}, 'sk-cp-wrong')).status).toBe(401);
    expect((await vote({ rating: 'up' }, {}, '')).status).toBe(401);
  });

  it('lets a visitor change a vote on the same reply', async () => {
    await vote({ rating: 'down', reference: 'chatcmpl-1', comment: 'changed my mind' });
    const rows = getDb().prepare("SELECT rating, model, comment FROM custom_feedback WHERE reference = 'chatcmpl-1'").all();
    expect(rows).toEqual([{ rating: -1, model: 'qwen3', comment: 'changed my mind' }]); // the model from the first vote is kept
  });

  it('sums votes per model and per day for the dashboard', async () => {
    const s = (await call(`/api/client-profiles/${profileId}/feedback?days=30`, ownerToken)).body.summary;
    expect(s).toMatchObject({ days: 30, up: 0, down: 3 });
    expect(s.byModel).toEqual([{ model: 'llama', up: 0, down: 2 }, { model: 'qwen3', up: 0, down: 1 }]);
    expect(s.byDay).toHaveLength(1);
    expect((await call(`/api/client-profiles/${otherId}/feedback`, ownerToken)).body.summary).toMatchObject({ up: 0, down: 0, byModel: [] });
  });

  it('shows comments with who and where, behind the edit permission', async () => {
    const comments = (await call(`/api/client-profiles/${profileId}/feedback/comments`, ownerToken)).body.comments;
    expect(comments.map((c: any) => [c.rating, c.comment, c.endUser, c.conversationId])).toEqual([
      ['down', 'Sai giá ship', 'khách-1', 'c-1'],
      ['down', 'changed my mind', null, null],
    ]);
    expect((await call(`/api/client-profiles/${profileId}/feedback/comments?rating=up`, ownerToken)).body.comments).toEqual([]);
    setUserPermissions(delegateId, ['view_client_profiles'], ownerId);
    expect((await call(`/api/client-profiles/${profileId}/feedback`, delegateToken)).status).toBe(200);
    expect((await call(`/api/client-profiles/${profileId}/feedback/comments`, delegateToken)).status).toBe(403);
    setUserPermissions(delegateId, [], ownerId);
  });
});
