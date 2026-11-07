import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http, { type Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setAlertSettings } from '../../services/usage-alerts.js';
import { buildWeeklyReport, lastFullWeek, maybeSendWeeklyReport, reportSettings, reportText, resetReportClock } from '../../services/usage-report.js';

// The weekly usage report: last full week (Mon-Sun, UTC) from the daily table, sent once per week
// through the usage-alert destinations.

const WED = Date.parse('2026-11-11T09:00:00Z'); // a Wednesday; last full week is 2026-11-02 .. 2026-11-08

describe('weekly usage report', () => {
  let app: Server;
  let base: string;
  let hook: Server;
  const posts: any[] = [];
  let ownerToken: string;
  let memberToken: string;
  let aliceId: number;
  let shopId: number;

  const call = async (path: string, token: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const day = (kind: string, id: number, d: string, requests: number, errors = 0, tokens = 10, endUser = '') =>
    getDb().prepare('INSERT INTO custom_usage_daily (day, subject_kind, subject_id, end_user, requests, success, errors, input_tokens, output_tokens, latency_ms_sum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)')
      .run(d, kind, id, endUser, requests, requests - errors, errors, tokens);

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => app.once('listening', resolve));
    base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    hook = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { posts.push(JSON.parse(b)); res.end('ok'); }); }).listen(0, '127.0.0.1');
    await new Promise<void>(resolve => hook.once('listening', resolve));
    const ownerId = createUser('owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    aliceId = createUser('alice@example.com', 'AlicePass123!', 'member').userId;
    memberToken = createSession(aliceId);
    shopId = Number(getDb().prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled) VALUES ('Shop', 'h', 'e', 'i', 't', 1)").run().lastInsertRowid);
    setAlertSettings({ webhookUrl: `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook` });
  });
  afterAll(() => { app?.close(); hook?.close(); });
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM custom_usage_daily').run();
    db.prepare("DELETE FROM settings WHERE key IN ('usage_report_weekly', 'usage_report_last_week')").run();
    setSetting('custom_usage_daily_through', '2099-01-01'); // nothing to roll up from the (empty) log
    resetReportClock();
    posts.length = 0;
    day('user', aliceId, '2026-11-03', 100, 4, 1000);
    day('user', aliceId, '2026-11-08', 50, 0, 500);
    day('profile', shopId, '2026-11-05', 30, 3, 300);
    day('end_user', shopId, '2026-11-05', 20, 1, 200, 'khách-1');
    day('end_user', shopId, '2026-11-05', 10, 2, 100, 'khách-2');
    day('user', aliceId, '2026-10-30', 90, 9, 900);  // the week before
    day('user', aliceId, '2026-11-09', 999, 0, 999); // this week: not reported yet
  });

  it('finds the last full week', () => {
    expect(lastFullWeek(WED)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(lastFullWeek(Date.parse('2026-11-09T00:00:01Z'))).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(lastFullWeek(Date.parse('2026-11-08T23:59:59Z'))).toEqual({ from: '2026-10-26', to: '2026-11-01' });
  });

  it('sums the week, compares with the week before and lists the busiest', () => {
    const r = buildWeeklyReport(WED);
    expect(r.totals).toEqual({ requests: 180, success: 173, errors: 7, tokens: 1800 });
    expect(r.previous).toEqual({ requests: 90, errors: 9, tokens: 900 });
    expect(r.topAccounts).toEqual([{ name: 'alice@example.com', requests: 150, errors: 4, tokens: 1500 }]);
    expect(r.topClientKeys[0]).toMatchObject({ name: 'Shop', requests: 30 });
    expect(r.topEndUsers.map(e => [e.name, e.clientKey, e.requests])).toEqual([['khách-1', 'Shop', 20], ['khách-2', 'Shop', 10]]);
    const text = reportText(r);
    expect(text.split('\n')[0]).toBe('Weekly usage report 2026-11-02 to 2026-11-08: 180 requests, 1,800 tokens');
    expect(text).toContain('Requests: 180 (+100% vs the week before)');
    expect(text).toContain('Errors: 7, 3.9% errors (-22% vs the week before)');
    expect(text).toContain('1. alice@example.com: 150 requests');
  });

  it('sends once per week when switched on', async () => {
    maybeSendWeeklyReport(WED);
    await new Promise(r => setTimeout(r, 50));
    expect(posts).toHaveLength(0); // off by default
    expect((await call('/api/settings/usage-report', ownerToken, 'PUT', { enabled: true })).body.enabled).toBe(true);
    maybeSendWeeklyReport(WED + 60_000);
    await new Promise(r => setTimeout(r, 50));
    expect(posts).toHaveLength(0); // checked at most every 10 minutes
    resetReportClock();
    maybeSendWeeklyReport(WED);
    await new Promise(r => setTimeout(r, 200));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: 'freellmapi.usage_alert', alert: 'weekly_report' });
    expect(posts[0].report.totals.requests).toBe(180);
    expect(posts[0].text).toContain('Weekly usage report');
    expect(reportSettings().lastSentWeek).toBe('2026-11-02');
    resetReportClock();
    maybeSendWeeklyReport(WED + 3_600_000);
    await new Promise(r => setTimeout(r, 100));
    expect(posts).toHaveLength(1); // already sent for this week
    resetReportClock();
    maybeSendWeeklyReport(WED + 7 * 86_400_000);
    await new Promise(r => setTimeout(r, 200));
    expect(posts).toHaveLength(2); // the next week
  });

  it('previews and sends on demand behind the settings permissions', async () => {
    const preview = await call('/api/settings/usage-report/preview', ownerToken);
    expect(preview.status).toBe(200);
    expect(typeof preview.body.text).toBe('string');
    const sent = await call('/api/settings/usage-report/send', ownerToken, 'POST', {});
    expect(sent.body.delivery.webhook).toEqual({ sent: true, status: 200 });
    expect((await call('/api/settings/usage-report', memberToken)).status).toBe(403);
    expect((await call('/api/settings/usage-report/send', memberToken, 'POST', {})).status).toBe(403);
    expect((await call('/api/settings/usage-report', ownerToken, 'PUT', { enabled: 'yes' })).status).toBe(400);
  });
});
