import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { queryLogs } from '../../lib/server-logs.js';
import { createSession, createUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';
import { resetQuotaCaches, setQuotaClock } from '../../services/usage-quotas.js';
import { ERROR_ALERT_COOLDOWN_MS, isFailure, noteOutcome, resetAlertState } from '../../services/usage-alerts.js';

// Usage alerts: 80% / 100% of an allowance and error spikes, to the server log and a webhook.

describe('usage alerts', () => {
  let server: Server;
  let base: string;
  let hook: Server;
  let hookUrl: string;
  const received: any[] = [];
  const realFetch = global.fetch;
  let upstreamFails = false;
  let ownerId: number;
  let ownerToken: string;
  let memberToken: string;
  let delegateId: number;
  let delegateToken: string;
  let profileId: number;
  let profileKey: string;

  const call = async (path: string, token: string | undefined, method = 'GET', body?: unknown) => {
    const res = await realFetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const chat = async (key = profileKey) => {
    const r = await call('/v1/chat/completions', key, 'POST', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    await new Promise(res => setTimeout(res, 20));
    return r.status;
  };
  const settle = () => new Promise(r => setTimeout(r, 120)); // webhook delivery is fire-and-forget
  const alerts = () => queryLogs({ event: 'usage_alert', limit: 500 }).map(e => e.message);
  const quota = (body: unknown) => call(`/api/client-profiles/${profileId}/usage-quota`, ownerToken, 'PUT', body);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const key = encrypt('gsk_alerts');
    getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq','a',?,?,?,'healthy',1)`)
      .run(key.encrypted, key.iv, key.authTag);
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    hook = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(204).end(); });
    }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => hook.once('listening', resolve));
    hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;

    ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    memberToken = createSession(createUser('member@example.com', 'MemberPass123!', 'member').userId);
    delegateId = createUser('delegate@example.com', 'DelegatePass123!', 'member').userId;
    delegateToken = createSession(delegateId);

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
      if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
      if (upstreamFails) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
  });
  afterAll(() => { server?.close(); hook?.close(); vi.restoreAllMocks(); setQuotaClock(null); });

  const freshProfile = async () => {
    const made = await call('/api/client-profiles', ownerToken, 'POST', { name: `shop-${Math.random().toString(36).slice(2, 7)}`, systemPrompt: null });
    profileId = made.body.id;
    profileKey = made.body.key;
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: null });
  };
  afterEach(() => {
    received.length = 0;
    upstreamFails = false;
    setQuotaClock(null);
    getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  });

  it('warns at 80% and at 100% of an allowance, once each, to the log and the webhook', async () => {
    await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: hookUrl });
    await freshProfile();
    await quota({ dailyRequests: 5 });
    for (let i = 0; i < 3; i++) expect(await chat()).toBe(200);
    await settle();
    expect(received).toHaveLength(0);
    expect(await chat()).toBe(200); // 4 of 5 = 80%
    await settle();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: 'freellmapi.usage_alert', alert: 'allowance', subject: { kind: 'profile', id: profileId },
      period: 'daily', metric: 'requests', threshold: 0.8, used: 4, limit: 5,
    });
    expect(received[0].text).toBe(received[0].message);
    expect(received[0].content).toBe(received[0].message);
    expect(received[0].message).toContain('80%');
    expect(await chat()).toBe(200); // 5 of 5 = 100%
    await settle();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ threshold: 1, used: 5, limit: 5 });
    expect(received[1].message).toContain('refused until');
    expect(await chat()).toBe(429);
    expect(await chat()).toBe(429);
    await settle();
    expect(received).toHaveLength(2); // refusals do not re-alert
    expect(alerts().filter(m => m.includes(`allowance`) && m.includes('daily requests'))).toHaveLength(2);
  });

  it('remembers what was sent across a restart, and re-arms in a new window', async () => {
    await freshProfile();
    await quota({ dailyRequests: 10 });
    for (let i = 0; i < 8; i++) await chat();
    await settle();
    expect(received.filter(r => r.threshold === 0.8)).toHaveLength(1);
    resetAlertState(); resetQuotaCaches(); // what a restart forgets
    expect(await chat()).toBe(200); // 9 of 10: still past 80%, already told
    await settle();
    expect(received).toHaveLength(1);

    setQuotaClock(() => Date.now() + 86_400_000 + 60_000); // tomorrow
    for (let i = 0; i < 8; i++) await chat();
    await settle();
    expect(received.filter(r => r.threshold === 0.8 && r.period === 'daily')).toHaveLength(2);
    const fired = getDb().prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE ?").get(`usage_alert_fired:profile:${profileId}:d%`) as { n: number };
    expect(fired.n).toBe(1); // yesterday's dedup row is gone
  });

  it('warns once when requests start failing', async () => {
    await freshProfile();
    upstreamFails = true;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(await chat());
      getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
    }
    await settle();
    expect(statuses.every(isFailure)).toBe(true);
    const errors = received.filter(r => r.alert === 'errors');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ subject: { kind: 'profile', id: profileId }, window_minutes: 15 });
    expect(errors[0].failures).toBeGreaterThanOrEqual(5);
    expect(errors[0].message).toContain('failed in the past 15 minutes');
  });

  it('does not count the gateway\'s own refusals as failures', async () => {
    await freshProfile();
    await call(`/api/client-profiles/${profileId}/quota`, ownerToken, 'PUT', { rpmLimit: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) statuses.push(await chat());
    await settle();
    expect(statuses.filter(s => s === 429).length).toBeGreaterThanOrEqual(13);
    expect(received.filter(r => r.alert === 'errors')).toHaveLength(0);
  });

  it('applies the error thresholds and the hourly cooldown', () => {
    resetAlertState();
    const t0 = 1_000_000;
    const count = (who: string) => alerts().filter(m => m.includes(who)).length;
    for (let i = 0; i < 9; i++) noteOutcome('user', 77, 502, t0 + i); // 9 requests: not enough yet
    expect(count('Account #77')).toBe(0);
    noteOutcome('user', 77, 200, t0 + 10); // 10 requests, 9 failed
    expect(count('Account #77')).toBe(1);
    for (let i = 0; i < 10; i++) noteOutcome('user', 77, 503, t0 + 20 + i);
    expect(count('Account #77')).toBe(1); // within the hour: no repeat
    for (let i = 0; i < 10; i++) noteOutcome('user', 77, 503, t0 + ERROR_ALERT_COOLDOWN_MS + 100 + i);
    expect(count('Account #77')).toBe(2);
    for (let i = 0; i < 20; i++) noteOutcome('user', 78, i % 4 === 0 ? 500 : 200, t0 + i); // one in four failing: under half
    expect(count('Account #78')).toBe(0);
    expect([isFailure(500), isFailure(502), isFailure(429), isFailure(403), isFailure(401), isFailure(200)]).toEqual([true, true, true, false, false, false]);
  });

  describe('settings', () => {
    it('stores the destinations and validates them', async () => {
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: '', email: '' });
      expect((await call('/api/settings/usage-alerts', ownerToken)).body).toEqual({ webhookUrl: '', email: '', emailAvailable: false });
      expect((await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: 'https://hooks.example.com/x', email: 'ops@example.com' })).body)
        .toMatchObject({ webhookUrl: 'https://hooks.example.com/x', email: 'ops@example.com' });
      expect((await call('/api/settings/usage-alerts', ownerToken, 'PUT', { email: '' })).body).toMatchObject({ webhookUrl: 'https://hooks.example.com/x', email: '' });
      for (const bad of [{ webhookUrl: 'ftp://x' }, { webhookUrl: 'not a url' }, { email: 'nope' }, { email: 'a@b.c\r\nBcc: x@y.z' }, { other: 1 }, { webhookUrl: 'https://x/' + 'a'.repeat(600) }]) {
        expect((await call('/api/settings/usage-alerts', ownerToken, 'PUT', bad)).status, JSON.stringify(bad)).toBe(400);
      }
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: '' });
    });

    it('sends a test alert to the webhook', async () => {
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: hookUrl, email: 'ops@example.com' });
      const r = await call('/api/settings/usage-alerts/test', ownerToken, 'POST', {});
      expect(r.status).toBe(200);
      expect(r.body.delivery).toEqual({ webhook: { sent: true, status: 204 }, email: null }); // no Gmail sender configured here
      expect(received.at(-1)).toMatchObject({ type: 'freellmapi.usage_alert', alert: 'test', subject: null });
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: '', email: '' });
      expect((await call('/api/settings/usage-alerts/test', ownerToken, 'POST', {})).body.delivery).toEqual({ webhook: null, email: null });
    });

    it('reports a webhook that does not answer', async () => {
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: 'http://127.0.0.1:1/never' });
      const r = await call('/api/settings/usage-alerts/test', ownerToken, 'POST', {});
      expect(r.body.delivery.webhook).toEqual({ sent: false, status: null });
      await call('/api/settings/usage-alerts', ownerToken, 'PUT', { webhookUrl: '' });
    });

    it('is guarded by the settings permissions', async () => {
      expect((await call('/api/settings/usage-alerts', memberToken)).status).toBe(403);
      expect((await call('/api/settings/usage-alerts', undefined)).status).toBe(401);
      setUserPermissions(delegateId, ['view_settings'], ownerId);
      expect((await call('/api/settings/usage-alerts', delegateToken)).status).toBe(200);
      expect((await call('/api/settings/usage-alerts', delegateToken, 'PUT', { email: '' })).status).toBe(403);
      expect((await call('/api/settings/usage-alerts/test', delegateToken, 'POST', {})).status).toBe(403);
      setUserPermissions(delegateId, ['edit_settings'], ownerId);
      expect((await call('/api/settings/usage-alerts', delegateToken, 'PUT', { email: '' })).status).toBe(200);
      setUserPermissions(delegateId, [], ownerId);
    });
  });
});
