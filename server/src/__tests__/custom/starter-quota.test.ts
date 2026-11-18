import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createInviteCode } from '../../services/invites.js';
import {
  approveRegistrationRequest,
  createRegistrationRequest,
} from '../../services/registration-requests.js';
import {
  DEFAULT_STARTER_QUOTA,
  getStarterQuotaConfig,
  setStarterQuotaConfig,
} from '../../services/starter-quota.js';
import { admitQuota, getQuotaState, resetQuotaCaches } from '../../services/usage-quotas.js';
import { setUserPermissions } from '../../services/users.js';

let server: Server;
let base: string;
let adminId: number;
let adminToken: string;
let memberToken: string;

async function hit(path: string, method = 'GET', body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

describe('Starter Quota & Member Usage Settings', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'c'.repeat(64);
    initDb(':memory:');
    resetQuotaCaches();

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('starter-admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const legacyUncapped = createUser('legacy-member@example.com', 'MemberPass123!', 'member');
    memberToken = createSession(legacyUncapped.userId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
  });

  it('defaults starter quota to 100 daily requests, 500K daily tokens, and 3M monthly tokens', () => {
    const cfg = getStarterQuotaConfig();
    expect(cfg).toEqual(DEFAULT_STARTER_QUOTA);
    expect(cfg.enabled).toBe(true);
    expect(cfg.dailyRequests).toBe(100);
    expect(cfg.dailyTokens).toBe(500_000);
    expect(cfg.monthlyTokens).toBe(3_000_000);
    expect(cfg.rpmLimit).toBe(60);
  });

  it('enforces RBAC on /api/settings/starter-quota while allowing delegated user-quota editors', async () => {
    const denied = await hit('/api/settings/starter-quota', 'GET', undefined, memberToken);
    expect(denied.status).toBe(403);

    const delegated = createUser('quota-manager@example.com', 'ManagerPass123!', 'member');
    setUserPermissions(delegated.userId, ['edit_user_quotas'], adminId);
    const delegatedToken = createSession(delegated.userId);

    const allowedGet = await hit('/api/settings/starter-quota', 'GET', undefined, delegatedToken);
    expect(allowedGet.status).toBe(200);
    expect(allowedGet.body?.config).toEqual(DEFAULT_STARTER_QUOTA);
    expect(allowedGet.body?.uncappedMembers).toBeGreaterThanOrEqual(2);

    const updated = await hit(
      '/api/settings/starter-quota',
      'PUT',
      { dailyRequests: 80, dailyTokens: 400_000, rpmLimit: 45 },
      delegatedToken,
    );
    expect(updated.status).toBe(200);
    expect(updated.body?.config).toMatchObject({
      enabled: true,
      dailyRequests: 80,
      dailyTokens: 400_000,
      monthlyTokens: 3_000_000,
      rpmLimit: 45,
    });
  });

  it('automatically caps newly registered invite members and sets custom RPM limit', async () => {
    setStarterQuotaConfig({
      enabled: true,
      dailyRequests: 2,
      dailyTokens: 100_000,
      monthlyRequests: null,
      monthlyTokens: 1_000_000,
      rpmLimit: 42,
    });

    const invite = createInviteCode(adminId, { maxUses: 1 });
    const reg = await hit('/api/auth/register', 'POST', {
      email: 'invited-newbie@example.com',
      password: 'Password123!',
      inviteCode: invite.code,
    });
    expect(reg.status).toBe(201);
    const newToken = reg.body?.token as string;
    expect(typeof newToken).toBe('string');

    const sessionRes = await hit('/api/user/session', 'GET', undefined, newToken);
    const newUserId = sessionRes.body?.userId as number;

    const state = getQuotaState('user', newUserId);
    expect(state.tracked).toBe(true);
    expect(state.quota).toEqual({
      dailyRequests: 2,
      dailyTokens: 100_000,
      monthlyRequests: null,
      monthlyTokens: 1_000_000,
    });

    // Enforce admission limit after 2 requests
    const a1 = admitQuota('user', newUserId);
    expect(a1.ok).toBe(true);
    if (a1.ok) a1.settle(true, 500);
    const a2 = admitQuota('user', newUserId);
    expect(a2.ok).toBe(true);
    if (a2.ok) a2.settle(true, 500);
    const a3 = admitQuota('user', newUserId);
    expect(a3.ok).toBe(false);

    // /api/user/usage surfaces the real RPM limit (42 instead of hardcoded 60)
    const usageRes = await hit('/api/user/usage', 'GET', undefined, newToken);
    expect(usageRes.status).toBe(200);
    expect(usageRes.body?.usage?.rpmLimit).toBe(42);
  });

  it('automatically caps members created via registration request approval and supports backfilling uncapped members', async () => {
    setStarterQuotaConfig({
      enabled: true,
      dailyRequests: 100,
      dailyTokens: 500_000,
      monthlyRequests: null,
      monthlyTokens: 3_000_000,
      rpmLimit: 60,
    });

    const createdReq = createRegistrationRequest('approved-user@example.com', 'Password123!', 'Need access');
    const approved = approveRegistrationRequest(createdReq.id, adminId);

    const state = getQuotaState('user', approved.userId);
    expect(state.tracked).toBe(true);
    expect(state.quota.dailyRequests).toBe(100);
    expect(state.quota.dailyTokens).toBe(500_000);
    expect(state.quota.monthlyTokens).toBe(3_000_000);

    // Backfill legacy uncapped members
    const before = await hit('/api/settings/starter-quota', 'GET', undefined, adminToken);
    expect(before.body?.uncappedMembers).toBeGreaterThan(0);

    const backfilled = await hit('/api/settings/starter-quota/backfill', 'POST', {}, adminToken);
    expect(backfilled.status).toBe(200);
    expect(backfilled.body?.updatedCount).toBe(before.body?.uncappedMembers);
    expect(backfilled.body?.uncappedMembers).toBe(0);
  });
});
