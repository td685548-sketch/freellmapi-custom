import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { PERMISSION_GATES } from '../../custom/register.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { createInviteCode } from '../../services/invites.js';
import { setStarterQuotaConfig } from '../../services/starter-quota.js';
import {
  admitQuota,
  getQuotaState,
  resetQuotaCaches,
  setQuotaClock,
} from '../../services/usage-quotas.js';
import { setUserPermissions } from '../../services/users.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
let server: Server;
let base: string;
let adminId: number;
let adminToken: string;
let memberAId: number;
let memberAToken: string;
let memberBId: number;
let memberBCookie: string;
let memberBCsrf: string;

async function hit(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  cookie?: string,
  csrf?: string,
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { ...dashboardSessionHeaders(token) } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
    cookies: res.headers.getSetCookie(),
  };
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  return found?.split(';')[0]!.slice(name.length + 1);
}

describe('Self-Service Quota Redeem Vouchers & 1-Click Top-Up Requests (Spec 040)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');
    resetQuotaCaches();

    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('voucher-admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    // Uncapped member (no row in custom_usage_quotas initially)
    const memberA = createUser('voucher-member-a@example.com', 'MemberPass123!', 'member');
    memberAId = memberA.userId;
    memberAToken = createSession(memberAId);

    // Starter-quota member registered via invite flow
    setStarterQuotaConfig({
      enabled: true,
      dailyRequests: 2,
      dailyTokens: 100_000,
      monthlyRequests: null,
      monthlyTokens: 1_000_000,
      rpmLimit: 60,
    });
    const invite = createInviteCode(adminId, { maxUses: 2 });
    const reg = await hit('/api/auth/register', 'POST', {
      email: 'voucher-member-b@example.com',
      password: 'MemberPass123!',
      inviteCode: invite.code,
    });
    expect(reg.status).toBe(201);
    // Phase 2: register no longer returns a token in the body — the session
    // arrives as the httpOnly flm_session cookie (plus flm_csrf for mutations).
    const sessionValue = cookieValue(reg.cookies, 'flm_session');
    const csrfValue = cookieValue(reg.cookies, 'flm_csrf');
    expect(sessionValue).toBeTruthy();
    expect(csrfValue).toBeTruthy();
    memberBCookie = `flm_session=${sessionValue}; flm_csrf=${csrfValue}`;
    memberBCsrf = csrfValue!;
    const sessionRes = await hit('/api/user/session', 'GET', undefined, undefined, memberBCookie);
    memberBId = sessionRes.body?.userId as number;
  });

  beforeEach(() => {
    setQuotaClock(null);
  });

  afterAll(async () => {
    setQuotaClock(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    getDb().close();
  });

  it('keeps PERMISSION_GATES untouched and enforces 401/403 RBAC on admin voucher & top-up endpoints', async () => {
    expect(PERMISSION_GATES.some((g) => String(g.path).includes('quota-vouchers'))).toBe(false);

    // Unauthenticated callers get 401
    expect((await hit('/api/quota-vouchers/redeem', 'POST', { code: 'TEST' })).status).toBe(401);
    expect((await hit('/api/quota-vouchers/vouchers', 'GET')).status).toBe(401);
    expect((await hit('/api/quota-vouchers/topup-requests', 'GET')).status).toBe(401);

    // Regular member gets 403 on all admin endpoints
    const memberGetVouchers = await hit('/api/quota-vouchers/vouchers', 'GET', undefined, memberAToken);
    expect(memberGetVouchers.status).toBe(403);
    expect(memberGetVouchers.body?.error?.type).toBe('forbidden');

    expect(
      (
        await hit(
          '/api/quota-vouchers/vouchers',
          'POST',
          { bonusRequestsDaily: 10 },
          memberAToken,
        )
      ).status,
    ).toBe(403);
    expect((await hit('/api/quota-vouchers/vouchers/1', 'PATCH', { active: false }, memberAToken)).status).toBe(403);
    expect((await hit('/api/quota-vouchers/vouchers/1', 'DELETE', undefined, memberAToken)).status).toBe(403);
    expect((await hit('/api/quota-vouchers/topup-requests', 'GET', undefined, memberAToken)).status).toBe(403);
    expect((await hit('/api/quota-vouchers/topup-requests/1/approve', 'POST', {}, memberAToken)).status).toBe(403);
    expect((await hit('/api/quota-vouchers/topup-requests/1/reject', 'POST', {}, memberAToken)).status).toBe(403);

    // Delegated operators with manage_invites OR manage_users are allowed
    const inviteOp = createUser('invite-op@example.com', 'OpPass123!', 'member');
    setUserPermissions(inviteOp.userId, ['manage_invites'], adminId);
    const inviteOpToken = createSession(inviteOp.userId);

    const userOp = createUser('user-op@example.com', 'OpPass123!', 'member');
    setUserPermissions(userOp.userId, ['manage_users'], adminId);
    const userOpToken = createSession(userOp.userId);

    expect((await hit('/api/quota-vouchers/vouchers', 'GET', undefined, inviteOpToken)).status).toBe(200);
    expect((await hit('/api/quota-vouchers/vouchers', 'GET', undefined, userOpToken)).status).toBe(200);
    expect((await hit('/api/quota-vouchers/topup-requests', 'GET', undefined, inviteOpToken)).status).toBe(200);
    expect((await hit('/api/quota-vouchers/topup-requests', 'GET', undefined, userOpToken)).status).toBe(200);
  });

  it('creates vouchers, normalizes codes, validates inputs, and stacks bonuses cleanly onto Starter Quota while unblocking exhausted daily caps', async () => {
    // Reject zero-bonus voucher
    const badVoucher = await hit(
      '/api/quota-vouchers/vouchers',
      'POST',
      { code: 'EMPTY-001', bonusRequestsDaily: 0, bonusTokensDaily: 0 },
      adminToken,
    );
    expect(badVoucher.status).toBe(400);

    // Create voucher with lowercase/padded code -> stored normalized uppercase
    const created = await hit(
      '/api/quota-vouchers/vouchers',
      'POST',
      {
        code: '  sprint-boost-2026  ',
        label: 'Sprint Boost',
        bonusRequestsDaily: 3,
        bonusTokensDaily: 150_000,
        bonusRequestsMonthly: 500,
        bonusTokensMonthly: 250_000,
        maxRedemptions: 2,
        expiresInDays: 7,
      },
      adminToken,
    );
    expect(created.status).toBe(201);
    expect(created.body?.voucher).toMatchObject({
      code: 'SPRINT-BOOST-2026',
      label: 'Sprint Boost',
      bonusRequestsDaily: 3,
      bonusTokensDaily: 150_000,
      bonusRequestsMonthly: 500,
      bonusTokensMonthly: 250_000,
      maxRedemptions: 2,
      redeemedCount: 0,
      active: true,
      status: 'active',
    });

    // Duplicate code rejected with 409
    const dup = await hit(
      '/api/quota-vouchers/vouchers',
      'POST',
      { code: 'sprint-boost-2026', bonusRequestsDaily: 10 },
      adminToken,
    );
    expect(dup.status).toBe(409);

    // Exhaust Member B's initial Starter Quota (2 daily requests)
    const adm1 = admitQuota('user', memberBId);
    expect(adm1.ok).toBe(true);
    if (adm1.ok) adm1.settle(true, 1_000);
    const adm2 = admitQuota('user', memberBId);
    expect(adm2.ok).toBe(true);
    if (adm2.ok) adm2.settle(true, 1_000);
    expect(admitQuota('user', memberBId).ok).toBe(false);

    // Member B redeems voucher (using lowercase/whitespace) -> stacks onto Starter Quota & preserves unlimited monthlyRequests: null
    const redeemedB = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: '  sprint-boost-2026 ' },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(redeemedB.status).toBe(200);
    expect(redeemedB.body?.voucher?.redeemedCount).toBe(1);
    expect(redeemedB.body?.quotaState?.tracked).toBe(true);
    expect(redeemedB.body?.quotaState?.quota).toEqual({
      dailyRequests: 5, // 2 starter + 3 bonus
      dailyTokens: 250_000, // 100k starter + 150k bonus
      monthlyRequests: null, // Starter monthlyRequests was unlimited (null), stays unlimited!
      monthlyTokens: 1_250_000, // 1M starter + 250k bonus
    });

    // Member B is immediately unblocked without waiting for quotaCache TTL
    const adm3 = admitQuota('user', memberBId);
    expect(adm3.ok).toBe(true);
    if (adm3.ok) adm3.settle(true, 1_000);

    // Duplicate redemption by Member B is blocked with 409
    const doubleRedeem = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: 'SPRINT-BOOST-2026' },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(doubleRedeem.status).toBe(409);
    expect(doubleRedeem.body?.error?.code).toBe('voucher_already_redeemed');
    expect(getQuotaState('user', memberBId).quota.dailyRequests).toBe(5);
  });

  it('creates a clean quota row for previously uncapped members and enforces max_redemptions, active toggle, and expiry', async () => {
    expect(getQuotaState('user', memberAId).tracked).toBe(false);

    // Member A redeems the 2nd (final) slot of SPRINT-BOOST-2026 -> creates row cleanly
    const redeemedA = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: 'SPRINT-BOOST-2026' },
      memberAToken,
    );
    expect(redeemedA.status).toBe(200);
    expect(redeemedA.body?.voucher?.redeemedCount).toBe(2);
    expect(redeemedA.body?.voucher?.status).toBe('exhausted');
    expect(redeemedA.body?.quotaState?.tracked).toBe(true);
    expect(redeemedA.body?.quotaState?.quota).toEqual({
      dailyRequests: 3,
      dailyTokens: 150_000,
      monthlyRequests: 500,
      monthlyTokens: 250_000,
    });

    // A 3rd member attempting to redeem the exhausted voucher gets 409 voucher_exhausted
    const memberC = createUser('voucher-member-c@example.com', 'MemberPass123!', 'member');
    const memberCToken = createSession(memberC.userId);
    const exhaustedAttempt = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: 'SPRINT-BOOST-2026' },
      memberCToken,
    );
    expect(exhaustedAttempt.status).toBe(409);
    expect(exhaustedAttempt.body?.error?.code).toBe('voucher_exhausted');

    // Member redemption history is strictly isolated per user
    const mineA = await hit('/api/quota-vouchers/redemptions/mine', 'GET', undefined, memberAToken);
    expect(mineA.status).toBe(200);
    expect(mineA.body?.redemptions).toHaveLength(1);
    expect(mineA.body?.redemptions?.[0]?.userId).toBe(memberAId);

    const mineC = await hit('/api/quota-vouchers/redemptions/mine', 'GET', undefined, memberCToken);
    expect(mineC.body?.redemptions).toHaveLength(0);

    // Auto-generated code + pause/activate/revoke + expiry enforcement
    const now = Date.now();
    setQuotaClock(() => now);
    const autoVoucherRes = await hit(
      '/api/quota-vouchers/vouchers',
      'POST',
      {
        bonusTokensDaily: 50_000,
        maxRedemptions: 5,
        expiresInDays: 1,
      },
      adminToken,
    );
    expect(autoVoucherRes.status).toBe(201);
    const autoVoucher = autoVoucherRes.body?.voucher;
    expect(autoVoucher.code).toMatch(/^GIFT-[A-F0-9]{4}-[A-F0-9]{4}$/);

    // Deactivate (PATCH active=false) -> rejected
    const paused = await hit(
      `/api/quota-vouchers/vouchers/${autoVoucher.id}`,
      'PATCH',
      { active: false },
      adminToken,
    );
    expect(paused.status).toBe(200);
    expect(paused.body?.voucher?.active).toBe(false);

    const inactiveTry = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: autoVoucher.code },
      memberCToken,
    );
    expect(inactiveTry.status).toBe(400);
    expect(inactiveTry.body?.error?.code).toBe('voucher_inactive');

    // Re-activate -> advance clock past 1 day -> rejected as expired
    await hit(
      `/api/quota-vouchers/vouchers/${autoVoucher.id}`,
      'PATCH',
      { active: true },
      adminToken,
    );
    setQuotaClock(() => now + 2 * 86_400_000);

    const expiredTry = await hit(
      '/api/quota-vouchers/redeem',
      'POST',
      { code: autoVoucher.code },
      memberCToken,
    );
    expect(expiredTry.status).toBe(400);
    expect(expiredTry.body?.error?.code).toBe('voucher_expired');

    // DELETE revokes cleanly
    const revoked = await hit(
      `/api/quota-vouchers/vouchers/${autoVoucher.id}`,
      'DELETE',
      undefined,
      adminToken,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body?.voucher?.active).toBe(false);
  });

  it('prevents over-redemption under parallel requests against a single-use voucher', async () => {
    const singleUse = await hit(
      '/api/quota-vouchers/vouchers',
      'POST',
      {
        code: 'ONE-WINNER-ONLY',
        bonusRequestsDaily: 25,
        maxRedemptions: 1,
      },
      adminToken,
    );
    expect(singleUse.status).toBe(201);

    const r1 = createUser('race-1@example.com', 'MemberPass123!', 'member');
    const r2 = createUser('race-2@example.com', 'MemberPass123!', 'member');
    const r3 = createUser('race-3@example.com', 'MemberPass123!', 'member');
    const t1 = createSession(r1.userId);
    const t2 = createSession(r2.userId);
    const t3 = createSession(r3.userId);

    const outcomes = await Promise.all([
      hit('/api/quota-vouchers/redeem', 'POST', { code: 'ONE-WINNER-ONLY' }, t1),
      hit('/api/quota-vouchers/redeem', 'POST', { code: 'ONE-WINNER-ONLY' }, t2),
      hit('/api/quota-vouchers/redeem', 'POST', { code: 'ONE-WINNER-ONLY' }, t3),
    ]);

    const winners = outcomes.filter((o) => o.status === 200);
    const losers = outcomes.filter((o) => o.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);

    const listRes = await hit('/api/quota-vouchers/vouchers', 'GET', undefined, adminToken);
    const target = (listRes.body?.vouchers as Array<Record<string, any>>).find(
      (v) => v.code === 'ONE-WINNER-ONLY',
    );
    expect(target?.redeemedCount).toBe(1);
  });

  it('enforces single-pending top-up spam guard, supports 1-click admin approval with editable grants + in-app notification, and supports rejection', async () => {
    const beforeQuota = getQuotaState('user', memberBId).quota;
    expect(beforeQuota).toEqual({
      dailyRequests: 5,
      dailyTokens: 250_000,
      monthlyRequests: null,
      monthlyTokens: 1_250_000,
    });

    // Reject 0-amount top-up request
    const zeroReq = await hit(
      '/api/quota-vouchers/topup-requests',
      'POST',
      { requestedRequestsDaily: 0, requestedTokensDaily: 0 },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(zeroReq.status).toBe(400);

    // Member B submits a valid top-up request
    const submitted = await hit(
      '/api/quota-vouchers/topup-requests',
      'POST',
      {
        requestedRequestsDaily: 50,
        requestedTokensDaily: 300_000,
        reason: 'Running end-to-end coding agent evaluation',
      },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(submitted.status).toBe(201);
    const requestId = submitted.body?.request?.id as number;
    expect(submitted.body?.request?.status).toBe('pending');

    // Spam guard: Member B cannot open a second pending request while the first is pending
    const spamAttempt = await hit(
      '/api/quota-vouchers/topup-requests',
      'POST',
      { requestedRequestsDaily: 100, requestedTokensDaily: 500_000 },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(spamAttempt.status).toBe(409);
    expect(spamAttempt.body?.error?.code).toBe('pending_topup_exists');

    // Member B sees own pending request; Member A sees none (strict user isolation)
    const mineB = await hit('/api/quota-vouchers/topup-requests/mine', 'GET', undefined, undefined, memberBCookie, memberBCsrf);
    expect(mineB.status).toBe(200);
    expect(mineB.body?.pendingRequest?.id).toBe(requestId);
    expect(mineB.body?.requests).toHaveLength(1);

    const mineA = await hit('/api/quota-vouchers/topup-requests/mine', 'GET', undefined, memberAToken);
    expect(mineA.body?.pendingRequest).toBeNull();
    expect(mineA.body?.requests).toHaveLength(0);

    // Admin views pending queue
    const adminQueue = await hit(
      '/api/quota-vouchers/topup-requests?status=pending',
      'GET',
      undefined,
      adminToken,
    );
    expect(adminQueue.status).toBe(200);
    expect(adminQueue.body?.pendingCount).toBe(1);
    expect(adminQueue.body?.requests?.[0]?.userEmail).toBe('voucher-member-b@example.com');

    // Admin 1-click Approves with edited grant amounts (+75 req/day, +500,000 tok/day)
    const approved = await hit(
      `/api/quota-vouchers/topup-requests/${requestId}/approve`,
      'POST',
      {
        grantedRequestsDaily: 75,
        grantedTokensDaily: 500_000,
        adminNote: 'Approved extra headroom for evaluation sprint',
      },
      adminToken,
    );
    expect(approved.status).toBe(200);
    expect(approved.body?.request?.status).toBe('approved');
    expect(approved.body?.request?.adminNote).toBe('Approved extra headroom for evaluation sprint');
    expect(approved.body?.quotaState?.quota).toEqual({
      dailyRequests: 80, // 5 + 75
      dailyTokens: 750_000, // 250k + 500k
      monthlyRequests: null,
      monthlyTokens: 1_250_000,
    });

    // Double-approving an already-reviewed request fails with 409 and does NOT double-increment quota
    const doubleApprove = await hit(
      `/api/quota-vouchers/topup-requests/${requestId}/approve`,
      'POST',
      {},
      adminToken,
    );
    expect(doubleApprove.status).toBe(409);
    expect(getQuotaState('user', memberBId).quota.dailyRequests).toBe(80);

    // Member B received an in-app notification in custom_notifications
    const bell = await hit('/api/user/notifications', 'GET', undefined, undefined, memberBCookie, memberBCsrf);
    expect(bell.status).toBe(200);
    const approvalNotif = (bell.body?.notifications as Array<Record<string, any>>).find(
      (n) => n.category === 'quota' && String(n.title).includes('approved'),
    );
    expect(approvalNotif).toBeTruthy();
    expect(String(approvalNotif?.body)).toContain('+75 daily requests');
    expect(String(approvalNotif?.body)).toContain('+500,000 daily tokens');

    // Now that no request is pending, Member B can submit a new request and Admin can Reject it
    const secondReq = await hit(
      '/api/quota-vouchers/topup-requests',
      'POST',
      { requestedRequestsDaily: 20, requestedTokensDaily: 100_000, reason: 'Follow-up run' },
      undefined, memberBCookie, memberBCsrf,
    );
    expect(secondReq.status).toBe(201);
    const secondId = secondReq.body?.request?.id as number;

    const rejected = await hit(
      `/api/quota-vouchers/topup-requests/${secondId}/reject`,
      'POST',
      { adminNote: 'Current allowance still has ample headroom' },
      adminToken,
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body?.request?.status).toBe('rejected');
    // Quota remains unchanged after rejection
    expect(getQuotaState('user', memberBId).quota.dailyRequests).toBe(80);

    // Delegated operator cannot approve a top-up targeting primary admin (privilege hierarchy check)
    const primaryReq = await hit(
      '/api/quota-vouchers/topup-requests',
      'POST',
      { requestedRequestsDaily: 10 },
      adminToken,
    );
    expect(primaryReq.status).toBe(201);

    const delegate = createUser('narrow-quota-op@example.com', 'OpPass123!', 'member');
    setUserPermissions(delegate.userId, ['edit_user_quotas'], adminId);
    const delegateToken = createSession(delegate.userId);

    const blockedEscalation = await hit(
      `/api/quota-vouchers/topup-requests/${primaryReq.body?.request?.id}/approve`,
      'POST',
      {},
      delegateToken,
    );
    expect(blockedEscalation.status).toBe(403);
  });
});
