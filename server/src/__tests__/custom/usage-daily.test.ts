import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, getSetting, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { csvCell, dailyUsage, dayOf, maybeRollUp, resetDailyRollupClock, rollUpPending, toCsv } from '../../services/usage-daily.js';

// Long-term usage: finished days of the request log are rolled up once per day into custom_usage_daily
// (accounts, client keys, end users), so the figures and CSV exports outlive the log's retention.

const DAY = 86_400_000;
const now = Date.parse('2026-11-07T12:00:00Z');
const at = (daysAgo: number, hour = 10) => new Date(Date.parse(`${dayOf(now - daysAgo * DAY)}T00:00:00Z`) + hour * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

describe('long-term daily usage', () => {
  let server: Server;
  let base: string;
  let ownerToken: string;
  let viewerId: number;
  let viewerToken: string;
  let aliceId: number;
  let shopId: number;

  const get = async (path: string, token = ownerToken) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  };
  const ins = () => getDb().prepare("INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at, user_id, profile_id, end_user) VALUES ('groq','m',NULL,?,?,?,?,NULL,?,?,?,?)");

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    aliceId = createUser('alice@example.com', 'AlicePass123!', 'member').userId;
    viewerId = createUser('viewer@example.com', 'ViewerPass123!', 'admin').userId;
    viewerToken = createSession(viewerId);
    shopId = Number(getDb().prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled) VALUES ('=Shop, \"VN\"', 'h', 'e', 'i', 't', 1)").run().lastInsertRowid);
  });
  afterAll(() => { server?.close(); });
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM requests').run();
    db.prepare('DELETE FROM custom_usage_daily').run();
    db.prepare("DELETE FROM settings WHERE key = 'custom_usage_daily_through'").run();
    resetDailyRollupClock();
    const r = ins();
    r.run('success', 10, 5, 100, at(2), aliceId, null, null);
    r.run('success', 20, 5, 300, at(2, 23), aliceId, null, null);
    r.run('error', 0, 0, 50, at(2), aliceId, null, null);
    r.run('success', 7, 3, 400, at(1), null, shopId, 'khách-1');
    r.run('success', 7, 3, 600, at(1), null, shopId, 'khách-1');
    r.run('success', 1, 1, 200, at(1), null, shopId, '=cmd');
    r.run('success', 1, 1, 100, at(1), null, shopId, null);
    r.run('success', 3, 3, 30, at(0), aliceId, null, null);      // today
    r.run('success', 99, 99, 9, at(1), null, null, null);         // unattributed
  });

  it('rolls up each finished day once per account, client key and end user', () => {
    expect(rollUpPending(now)).toBe(2); // the first day in the log through yesterday
    expect(getSetting('custom_usage_daily_through')).toBe(dayOf(now - DAY));
    const users = dailyUsage('user', dayOf(now - 3 * DAY), dayOf(now - DAY), null, now);
    expect(users).toEqual([{ day: dayOf(now - 2 * DAY), kind: 'user', id: aliceId, endUser: null, requests: 3, success: 2, errors: 1, inputTokens: 30, outputTokens: 10, avgLatencyMs: 200 }]);
    const profile = dailyUsage('profile', dayOf(now - DAY), dayOf(now - DAY), null, now);
    expect(profile).toMatchObject([{ id: shopId, requests: 4, inputTokens: 16, avgLatencyMs: 325 }]);
    const endUsers = dailyUsage('end_user', dayOf(now - DAY), dayOf(now - DAY), shopId, now);
    expect(endUsers.map(r => [r.endUser, r.requests])).toEqual([['=cmd', 1], ['khách-1', 2]]);
    expect(rollUpPending(now)).toBe(0); // nothing new
  });

  it('keeps the figures after the log rows are gone, and reads today live', () => {
    rollUpPending(now);
    getDb().prepare('DELETE FROM requests WHERE created_at < ?').run(at(0, 0));
    const rows = dailyUsage('user', dayOf(now - 2 * DAY), dayOf(now), aliceId, now);
    expect(rows.map(r => [r.day, r.requests])).toEqual([[dayOf(now - 2 * DAY), 3], [dayOf(now), 1]]);
  });

  it('rolls up from a finished request at most every 10 minutes', () => {
    maybeRollUp(now);
    expect(getSetting('custom_usage_daily_through')).toBe(dayOf(now - DAY));
    ins().run('success', 5, 5, 5, at(1, 5), aliceId, null, null); // late row for yesterday
    getDb().prepare("UPDATE settings SET value = ? WHERE key = 'custom_usage_daily_through'").run(dayOf(now - 2 * DAY));
    maybeRollUp(now + 60_000);
    expect(dailyUsage('user', dayOf(now - DAY), dayOf(now - DAY), aliceId, now + 60_000)).toHaveLength(1); // rolled up on read anyway
    expect(getSetting('custom_usage_daily_through')).toBe(dayOf(now - DAY));
  });

  it('backfills a long log 15 days per pass', () => {
    getDb().prepare('DELETE FROM requests').run();
    for (let d = 40; d >= 1; d--) ins().run('success', 1, 1, 10, at(d), aliceId, null, null);
    expect(rollUpPending(now)).toBe(15);
    expect(rollUpPending(now)).toBe(15);
    expect(rollUpPending(now)).toBe(10);
    expect(rollUpPending(now)).toBe(0);
    expect(dailyUsage('user', dayOf(now - 40 * DAY), dayOf(now - DAY), aliceId, now)).toHaveLength(40);
  });

  it('writes CSV that spreadsheets read safely', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    rollUpPending(now);
    const csv = toCsv('end_user', dailyUsage('end_user', dayOf(now - DAY), dayOf(now - DAY), null, now));
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('day,client_key_id,client_key,end_user,requests,success,errors,input_tokens,output_tokens,avg_latency_ms');
    expect(lines[1]).toBe(`${dayOf(now - DAY)},${shopId},"'=Shop, ""VN""",'=cmd,1,1,0,1,1,200`);
  });

  it('serves daily figures and CSV behind the ranking permissions', async () => {
    const today = dayOf(Date.now());
    const daily = await get(`/api/usage/daily/accounts?from=${dayOf(Date.now() - 10 * DAY)}&to=${today}`);
    expect(daily.status).toBe(200);
    expect(Array.isArray(daily.body.rows)).toBe(true);
    const csv = await get(`/api/usage/export/end-users.csv?id=${shopId}`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toMatch(/attachment; filename="usage-end-users-.*\.csv"/);
    expect(csv.text.startsWith('day,client_key_id')).toBe(true); // text() drops the BOM
    const raw = new Uint8Array(await (await fetch(`${base}/api/usage/export/end-users.csv`, { headers: { authorization: `Bearer ${ownerToken}` } })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect((await get('/api/usage/export/secrets.csv')).status).toBe(404);
    expect((await get('/api/usage/daily/accounts?from=2026-13-01')).status).toBe(400);
    expect((await get('/api/usage/daily/accounts?from=2020-01-01&to=2026-01-01')).status).toBe(400);

    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['view_usage_profiles']), viewerId);
    expect((await get('/api/usage/export/profiles.csv', viewerToken)).status).toBe(200);
    expect((await get('/api/usage/daily/end-users', viewerToken)).status).toBe(200);
    expect((await get('/api/usage/export/accounts.csv', viewerToken)).status).toBe(403);
    expect((await get('/api/usage/daily/accounts', viewerToken)).status).toBe(403);
    getDb().prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(['view_usage_accounts']), viewerId);
    expect((await get('/api/usage/export/accounts.csv', viewerToken)).status).toBe(200);
    expect((await get('/api/usage/export/end-users.csv', viewerToken)).status).toBe(403);
  });
});
