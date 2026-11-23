import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import {
  applyLocalTunnelDirectOutbound,
  resetBypassedFetchRelayForTests,
} from '../../custom/local-tunnel-direct-outbound.js';
import {
  pollTelegramUpdatesOnce,
  resetTelegramStateForTests,
  setTelegramFetchForTests,
} from '../../custom/notifications/telegram-bot.js';
import { recordRefreshCircuitFailure } from '../../custom/provider-accounts/refresh-circuit.js';
import { createApiKeyAccount, setAccountStatus } from '../../custom/provider-accounts/store.js';
import { getDb, getSetting, initDb } from '../../db/index.js';
import { listAudit } from '../../services/audit-log.js';
import { createSession, createUser } from '../../services/auth.js';
import { createRegistrationRequest } from '../../services/registration-requests.js';
import { resetAlertState } from '../../services/usage-alerts.js';
import { admitQuota, getQuotaState, resetQuotaCaches, setQuota } from '../../services/usage-quotas.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
interface RecordedTelegramCall {
  method: string;
  body: Record<string, any>;
}

let server: Server;
let base: string;
let adminId: number;
let adminToken: string;
let memberId: number;
let memberToken: string;

const telegramCalls: RecordedTelegramCall[] = [];
let queuedTelegramUpdates: Array<Record<string, any>> = [];
let nextMessageId = 100;

async function hit(path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { ...dashboardSessionHeaders(token) } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

describe('Two-Way Telegram Ops Bot & In-App Notification Center', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    initDb(':memory:');
    resetQuotaCaches();
    resetAlertState();

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('ops-admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const member = createUser('ops-member@example.com', 'MemberPass123!', 'member');
    memberId = member.userId;
    memberToken = createSession(memberId);
  });

  beforeEach(() => {
    telegramCalls.length = 0;
    queuedTelegramUpdates = [];
    resetBypassedFetchRelayForTests();
    resetTelegramStateForTests();
    setTelegramFetchForTests(async (url, init) => {
      const method = url.split('/').pop() || '';
      const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
      telegramCalls.push({ method, body: parsedBody });

      if (method === 'getUpdates') {
        const batch = queuedTelegramUpdates;
        queuedTelegramUpdates = [];
        return new Response(JSON.stringify({ ok: true, result: batch }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'sendMessage') {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: ++nextMessageId } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  });

  afterAll(async () => {
    resetTelegramStateForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
  });

  it('encrypts Telegram bot token at rest, enforces RBAC, and delivers live test alerts', async () => {
    const denied = await hit('/api/settings/telegram-alerts', 'GET', undefined, memberToken);
    expect(denied.status).toBe(403);

    const saved = await hit(
      '/api/settings/telegram-alerts',
      'PUT',
      {
        enabled: true,
        botToken: '99887766:AAHSecretTelegramToken123456',
        chatId: '-100987654321',
        notifyProviderErrors: true,
        notifyRegistrationRequests: true,
        notifyQuotaAlerts: true,
        interactiveApprovalEnabled: true,
      },
      adminToken,
    );

    expect(saved.status).toBe(200);
    expect(saved.body?.enabled).toBe(true);
    expect(saved.body?.hasBotToken).toBe(true);
    expect(saved.body?.maskedBotToken).toContain('99887766:AAH');
    expect(saved.body?.maskedBotToken).not.toContain('SecretTelegramToken');

    const rawStored = getSetting('telegram_ops_bot_config_v1') || '';
    expect(rawStored).not.toContain('AAHSecretTelegramToken123456');

    const tested = await hit('/api/settings/telegram-alerts/test', 'POST', {}, adminToken);
    expect(tested.status).toBe(200);
    expect(tested.body?.delivery?.sent).toBe(true);
    expect(telegramCalls.some((c) => c.method === 'sendMessage' && c.body.chat_id === '-100987654321')).toBe(
      true,
    );

    const bell = await hit('/api/user/notifications', 'GET', undefined, adminToken);
    expect(bell.status).toBe(200);
    expect(bell.body?.unreadCount).toBeGreaterThanOrEqual(1);
    expect(bell.body?.notifications?.[0]?.title).toBe('Test alert delivered');
  });

  it('fires deduplicated Telegram and critical in-app alerts when OAuth/cookie provider accounts fail', async () => {
    const accountId = createApiKeyAccount({
      provider: 'claude',
      label: 'Claude Pro Team #1',
      authMethod: 'oauth_pkce',
      key: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-valid',
          refreshToken: 'sk-ant-ort01-valid',
          expiresAt: Date.now() + 3600_000,
        },
      }),
    });

    setAccountStatus(accountId, 'error');
    // Repeated error status should be deduplicated until recovery
    setAccountStatus(accountId, 'error');

    await new Promise((r) => setTimeout(r, 30));

    const sendCalls = telegramCalls.filter((c) => c.method === 'sendMessage');
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.body.text).toContain('claude');
    expect(sendCalls[0]?.body.text).toContain('Claude Pro Team #1');

    // Refresh circuit backoff also triggers its own alert category
    recordRefreshCircuitFailure(accountId, new Error('OAuth 401 invalid_grant'));
    await new Promise((r) => setTimeout(r, 30));
    expect(telegramCalls.filter((c) => c.method === 'sendMessage').length).toBe(2);

    // Recovery resets deduplication so a future outage alerts again
    setAccountStatus(accountId, 'healthy');
    setAccountStatus(accountId, 'error');
    await new Promise((r) => setTimeout(r, 30));
    expect(telegramCalls.filter((c) => c.method === 'sendMessage').length).toBe(3);

    const bell = await hit('/api/user/notifications', 'GET', undefined, adminToken);
    const providerNotif = (bell.body?.notifications as Array<Record<string, any>>).find(
      (n) => n.category === 'provider_health' && String(n.title).includes('Claude Pro Team #1'),
    );
    expect(providerNotif).toBeTruthy();
    expect(providerNotif?.severity).toBe('critical');
    expect(providerNotif?.actionUrl).toBe('/thruline/providers/claude');
  });

  it('supports 1-tap Telegram registration approval/rejection, blocks unauthorized chats, and notifies on resubmission', async () => {
    const req1 = createRegistrationRequest('applicant-one@example.com', 'Password123!', 'Team dev');
    await new Promise((r) => setTimeout(r, 30));

    const regMsg = telegramCalls.find(
      (c) => c.method === 'sendMessage' && String(c.body.text).includes('applicant-one@example.com'),
    );
    expect(regMsg).toBeTruthy();
    expect(regMsg?.body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
      `flm_reg:approve:${req1.id}`,
    );

    // 1. Unauthorized chat click must be rejected
    queuedTelegramUpdates = [
      {
        update_id: 5001,
        callback_query: {
          id: 'cb-evil',
          from: { username: 'intruder' },
          message: { message_id: 201, chat: { id: -9999999 }, text: 'Spoofed' },
          data: `flm_reg:approve:${req1.id}`,
        },
      },
    ];
    const processedEvil = await pollTelegramUpdatesOnce();
    expect(processedEvil).toBe(0);
    expect(
      getDb().prepare('SELECT status FROM registration_requests WHERE id = ?').get(req1.id),
    ).toEqual({ status: 'pending' });

    // 2. Authorized chat click approves account, applies Starter Quota, edits Telegram message & writes audit log
    queuedTelegramUpdates = [
      {
        update_id: 5002,
        callback_query: {
          id: 'cb-ok',
          from: { username: 'ops_lead' },
          message: {
            message_id: 202,
            chat: { id: '-100987654321' },
            text: `Đơn #${req1.id} — applicant-one@example.com`,
          },
          data: `flm_reg:approve:${req1.id}`,
        },
      },
    ];
    const processedOk = await pollTelegramUpdatesOnce();
    expect(processedOk).toBe(1);

    const createdUser = getDb()
      .prepare('SELECT id, role FROM users WHERE email = ?')
      .get('applicant-one@example.com') as { id: number; role: string } | undefined;
    expect(createdUser?.role).toBe('member');
    expect(getQuotaState('user', createdUser!.id).tracked).toBe(true);

    expect(telegramCalls.some((c) => c.method === 'editMessageText')).toBe(true);
    const audit = listAudit({ area: 'admin/registration-requests' });
    expect(audit.entries.some((e) => e.targetId === req1.id)).toBe(true);

    // 3. Rejecting and resubmitting a request sends a fresh notification (fixes resubmission silent bug)
    const req2 = createRegistrationRequest('resubmit-user@example.com', 'Password123!', 'First try');
    queuedTelegramUpdates = [
      {
        update_id: 5003,
        callback_query: {
          id: 'cb-reject',
          from: { username: 'ops_lead' },
          message: { message_id: 203, chat: { id: '-100987654321' }, text: `Đơn #${req2.id}` },
          data: `flm_reg:reject:${req2.id}`,
        },
      },
    ];
    expect(await pollTelegramUpdatesOnce()).toBe(1);
    expect(
      getDb().prepare('SELECT status FROM registration_requests WHERE id = ?').get(req2.id),
    ).toEqual({ status: 'rejected' });

    telegramCalls.length = 0;
    createRegistrationRequest('resubmit-user@example.com', 'Password123!', 'Second try with context');
    await new Promise((r) => setTimeout(r, 30));
    expect(
      telegramCalls.some(
        (c) => c.method === 'sendMessage' && String(c.body.text).includes('Gửi lại'),
      ),
    ).toBe(true);
  });

  it('notifies members in-app at 80% and 100% of their usage quota and supports read/clear actions', async () => {
    setQuota('user', memberId, {
      dailyRequests: 5,
      dailyTokens: null,
      monthlyRequests: null,
      monthlyTokens: null,
    });

    for (let i = 0; i < 5; i++) {
      const adm = admitQuota('user', memberId);
      expect(adm.ok).toBe(true);
      if (adm.ok) adm.settle(true, 100);
    }
    await new Promise((r) => setTimeout(r, 40));

    const memberBell = await hit('/api/user/notifications', 'GET', undefined, memberToken);
    expect(memberBell.status).toBe(200);
    const quotaNotifs = (memberBell.body?.notifications as Array<Record<string, any>>).filter(
      (n) => n.category === 'quota',
    );
    expect(quotaNotifs.length).toBe(2);
    expect(quotaNotifs.some((n) => n.severity === 'warning')).toBe(true);
    expect(quotaNotifs.some((n) => n.severity === 'critical')).toBe(true);

    // Mark one read, mark all read, clear read
    const firstId = quotaNotifs[0]!.id as number;
    const readOne = await hit(`/api/user/notifications/${firstId}/read`, 'POST', {}, memberToken);
    expect(readOne.status).toBe(200);
    expect(readOne.body?.updated).toBe(true);

    const readAll = await hit('/api/user/notifications/read-all', 'POST', {}, memberToken);
    expect(readAll.status).toBe(200);
    expect(readAll.body?.unreadCount).toBe(0);

    const cleared = await hit('/api/user/notifications/read', 'DELETE', undefined, memberToken);
    expect(cleared.status).toBe(200);
    expect(cleared.body?.deletedCount).toBeGreaterThanOrEqual(2);
  });

  it('falls back to bypassed Fetch Relay when direct api.telegram.org is ISP-blocked and acknowledges /start', async () => {
    applyLocalTunnelDirectOutbound(
      {
        NODE_ENV: 'production',
        FREEAPI_DB_DRIVER: 'sqlite',
        PUBLIC_APP_URL: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
        TRUST_PROXY: 'loopback',
        PROXY_MODE: 'fetch-relay',
        PROXY_URL: 'https://relay.example.workers.dev',
        FETCH_RELAY_TOKEN: 'relay-secret-999',
      },
      () => {},
    );

    let directAttempts = 0;
    const relayAttempts: Array<{ target: string | null; auth: string | null; body: Record<string, any> }> = [];

    setTelegramFetchForTests(async (url, init) => {
      if (url.startsWith('https://api.telegram.org/')) {
        directAttempts++;
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      if (url.startsWith('https://relay.example.workers.dev')) {
        const hdrs = new Headers(init?.headers);
        const target = hdrs.get('fetch-relay-target');
        const auth = hdrs.get('fetch-relay-authorization');
        const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {};
        relayAttempts.push({ target, auth, body: parsedBody });

        if (target?.endsWith('/getUpdates')) {
          const batch = queuedTelegramUpdates;
          queuedTelegramUpdates = [];
          return new Response(JSON.stringify({ ok: true, result: batch }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: ++nextMessageId } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    // 1. First request tries direct once, catches timeout, and succeeds via Fetch Relay
    const tested1 = await hit('/api/settings/telegram-alerts/test', 'POST', {}, adminToken);
    expect(tested1.status).toBe(200);
    expect(tested1.body?.delivery?.sent).toBe(true);
    expect(directAttempts).toBe(1);
    expect(relayAttempts.length).toBe(1);
    expect(relayAttempts[0]?.auth).toBe('Bearer relay-secret-999');
    expect(relayAttempts[0]?.target).toContain('/sendMessage');

    // 2. Subsequent poll + /start ack ride straight over the latched Fetch Relay without re-timing-out direct
    queuedTelegramUpdates = [
      {
        update_id: 9001,
        message: {
          message_id: 301,
          from: { username: 'stranger' },
          chat: { id: 123456 },
          text: '/start',
        },
      },
      {
        update_id: 9002,
        message: {
          message_id: 302,
          from: { username: 'ops_lead' },
          chat: { id: '-100987654321' },
          text: '/start',
        },
      },
    ];

    const acked = await pollTelegramUpdatesOnce();
    expect(acked).toBe(1);
    // Direct attempts remained 1 because preferBypassedRelay latched
    expect(directAttempts).toBe(1);
    expect(
      relayAttempts.some(
        (r) =>
          r.target?.endsWith('/sendMessage') &&
          r.body.chat_id === '-100987654321' &&
          String(r.body.text).includes('FreeLLMAPI Ops Bot đã kết nối thành công'),
      ),
    ).toBe(true);
  });
});
