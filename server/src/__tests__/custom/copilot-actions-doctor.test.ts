import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { createAssistant } from '../../custom/customer-ai/store.js';
import { MAX_ACTIVE_PERSONAL_KEYS } from '../../custom/support-setup-copilot/user-actions.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { resetQuotaCaches, setQuota } from '../../services/usage-quotas.js';
import { listUserApiKeys, mintUserApiKey, validateUserApiKey } from '../../services/user-keys.js';
import { setUserRpmLimit } from '../../services/user-quotas.js';

let server: Server;
let base: string;

let adminId: number;
let adminToken: string;
let memberAId: number;
let memberAToken: string;
let memberBId: number;
let memberBToken: string;

let publicAssistantId: number;
let adminOnlyAssistantId: number;

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

function nowSqlUtc(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

describe('Spec 037 — Action-Taking In-App Copilot & AI Error Doctor', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const admin = createUser('doctor-admin@example.com', 'AdminPass123!');
    adminId = admin.userId;
    adminToken = createSession(adminId);

    const userA = createUser('member-a@example.com', 'MemberPass123!', 'member');
    memberAId = userA.userId;
    memberAToken = createSession(memberAId);

    const userB = createUser('member-b@example.com', 'MemberPass123!', 'member');
    memberBId = userB.userId;
    memberBToken = createSession(memberBId);

    // Seed an upstream admin provider key & x_gateway key to verify zero secret leakage in diagnostics
    const db = getDb();
    const adminSecretPlain = 'sk-admin-upstream-topsecret-987654321';
    const enc = encrypt(adminSecretPlain);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
       VALUES ('custom', 'PrivateAdminUpstreamNode', ?, ?, ?, 'healthy', 1, 'https://secret-upstream.internal.corp/v1')`,
    ).run(enc.encrypted, enc.iv, enc.authTag);

    publicAssistantId = createAssistant({
      slug: 'pair-coder-pro',
      name: 'Pair Coder Pro',
      category: 'coding',
      systemPrompt: 'You are a concise pair programmer.',
      recommendedRoutingMode: 'balanced',
      audience: 'all_members',
    }).id;

    adminOnlyAssistantId = createAssistant({
      slug: 'ops-root-auditor',
      name: 'Ops Root Auditor',
      category: 'general',
      systemPrompt: 'Internal admin-only assistant.',
      recommendedRoutingMode: 'max',
      audience: 'admin_only',
    }).id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM auth_request_limits').run();
    resetQuotaCaches();
  });

  it('rejects unauthenticated requests across diagnostics, execute-action, and chat', async () => {
    const unauthDiag = await hit('/api/support-setup-copilot/diagnostics');
    expect(unauthDiag.status).toBe(401);

    const unauthExec = await hit('/api/support-setup-copilot/execute-action', 'POST', {
      actionType: 'open_onboarding_guide',
      confirmed: true,
    });
    expect(unauthExec.status).toBe(401);

    const unauthChat = await hit('/api/support-setup-copilot/chat', 'POST', {
      messages: [{ role: 'user', content: 'diagnose my errors' }],
    });
    expect(unauthChat.status).toBe(401);
  });

  it('diagnoses 429/400/403/5xx errors & quota usage strictly per user while scrubbing upstream secrets', async () => {
    const db = getDb();
    db.prepare('DELETE FROM requests WHERE user_id IN (?, ?)').run(memberAId, memberBId);
    db.prepare('DELETE FROM user_api_keys WHERE user_id IN (?, ?)').run(memberAId, memberBId);

    // Mint keys for Member A (in 'max' mode) and Member B (in 'eco' mode)
    const keyA = mintUserApiKey(memberAId, 'MemberA Cursor Key', {
      routingMode: 'max',
      assistantId: publicAssistantId,
      callerRole: 'member',
    });
    const keyB = mintUserApiKey(memberBId, 'MemberB Private Key', {
      routingMode: 'eco',
      callerRole: 'member',
    });

    // Set quota on Member A: 10 daily requests, 90% used via 9 successful requests + error burst
    setQuota('user', memberAId, {
      dailyRequests: 10,
      dailyTokens: 100_000,
      monthlyRequests: null,
      monthlyTokens: 1_000_000,
    });

    const insertReq = db.prepare(
      `INSERT INTO requests (
         platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at, user_id, client_agent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // 9 successful calls for Member A -> 9/10 = 90% daily request quota!
    for (let i = 0; i < 9; i += 1) {
      insertReq.run('openai', 'gpt-4o', 'success', 500, 300, 1200, null, nowSqlUtc(-10), memberAId, 'cursor');
    }

    // Inject 429, 400, 403, and 504 errors for Member A (including simulated secret tokens & internal URLs in error text)
    insertReq.run(
      'openai',
      'gpt-4o',
      'error',
      0,
      0,
      450,
      'HTTP 429 rate_limit_exceeded with Authorization: Bearer sk-admin-upstream-topsecret-987654321 at https://secret-upstream.internal.corp/v1/chat/completions?api_key=AIzaSySecretKey999999999',
      nowSqlUtc(-5),
      memberAId,
      'cursor',
    );
    insertReq.run(
      'openai',
      'gpt-4o',
      'error',
      0,
      0,
      320,
      'HTTP 429 Too Many Requests: user_rate_limit_exceeded',
      nowSqlUtc(-4),
      memberAId,
      'cursor',
    );
    insertReq.run(
      'anthropic',
      'claude-sonnet',
      'error',
      0,
      0,
      210,
      'HTTP 400 invalid_request_error: context_length_exceeded (prompt exceeds maximum context window)',
      nowSqlUtc(-3),
      memberAId,
      'claude-code',
    );
    insertReq.run(
      'openai',
      'gpt-4o',
      'error',
      0,
      0,
      180,
      'HTTP 403 forbidden: blocked by prompt_injection guardrail policy',
      nowSqlUtc(-2),
      memberAId,
      'cursor',
    );
    insertReq.run(
      'google',
      'gemini-pro',
      'error',
      0,
      0,
      12_500,
      'HTTP 504 Gateway Timeout: upstream timed out',
      nowSqlUtc(-1),
      memberAId,
      'opencode',
    );

    // 1. Member A calls GET /api/support-setup-copilot/diagnostics
    const diagA = await hit('/api/support-setup-copilot/diagnostics', 'GET', undefined, memberAToken);
    expect(diagA.status).toBe(200);
    const reportA = diagA.body?.diagnostic;
    expect(reportA).toBeTruthy();
    expect(reportA.errorBreakdown).toEqual({
      rate_limit_429: 2,
      bad_request_400: 1,
      quota_guardrail_403: 1,
      upstream_5xx_timeout: 1,
      other_error: 0,
    });
    expect(reportA.quota.tracked).toBe(true);
    expect(reportA.quota.dailyRequests.pct).toBe(90);
    expect(reportA.quota.isNearExhaustion).toBe(true);
    expect(reportA.activeKeys).toHaveLength(1);
    expect(reportA.activeKeys[0]?.id).toBe(keyA.id);
    expect(reportA.activeKeys[0]?.routingMode).toBe('max');
    expect(reportA.activeKeys[0]?.assistantName).toBe('Pair Coder Pro');
    expect(reportA.recommendedAction?.actionType).toBe('switch_key_routing_mode');
    expect(reportA.recommendedAction?.params?.routingMode).toBe('eco');

    // CRITICAL SECURITY CHECK: Zero secrets, raw keys, admin labels, or Member B keys leaked!
    const serializedA = JSON.stringify(diagA.body);
    expect(serializedA).not.toContain('sk-admin-upstream-topsecret-987654321');
    expect(serializedA).not.toContain('AIzaSySecretKey999999999');
    expect(serializedA).not.toContain('secret-upstream.internal.corp');
    expect(serializedA).not.toContain('PrivateAdminUpstreamNode');
    expect(serializedA).not.toContain(keyA.key); // only masked keyPrefix is returned in diagnostics
    expect(serializedA).not.toContain('MemberB Private Key');
    expect(serializedA).not.toContain(keyB.keyPrefix);

    // 2. Member B calls GET /api/support-setup-copilot/diagnostics (even passing ?userId=memberAId query param!)
    const diagB = await hit(
      `/api/support-setup-copilot/diagnostics?userId=${memberAId}`,
      'GET',
      undefined,
      memberBToken,
    );
    expect(diagB.status).toBe(200);
    const reportB = diagB.body?.diagnostic;
    expect(reportB.recentRequests.total).toBe(0);
    expect(reportB.recentRequests.failed).toBe(0);
    expect(reportB.issues).toHaveLength(0);
    expect(reportB.activeKeys).toHaveLength(1);
    expect(reportB.activeKeys[0]?.id).toBe(keyB.id);
    expect(JSON.stringify(diagB.body)).not.toContain('MemberA Cursor Key');
  });

  it('answers Error Doctor prompts in accented VI, unaccented VI, and EN with root-cause analysis + 1-click remediation card', async () => {
    // 1. Unaccented Vietnamese under English UI locale ("sao goi api bi loi 429")
    const viUnaccented = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        locale: 'en',
        messages: [{ role: 'user', content: 'sao goi api bi loi 429' }],
      },
      memberAToken,
    );
    expect(viUnaccented.status).toBe(200);
    expect(viUnaccented.body?.replyLocale).toBe('vi');
    expect(viUnaccented.body?.intent).toBe('diagnose_errors');
    expect(String(viUnaccented.body?.reply)).toContain('429');
    expect(String(viUnaccented.body?.reply)).toContain('90%');
    expect(viUnaccented.body?.userDiagnostic?.errorBreakdown?.rate_limit_429).toBe(2);
    expect(viUnaccented.body?.actionProposal?.actionType).toBe('switch_key_routing_mode');
    expect(viUnaccented.body?.actionProposal?.requiresConfirmation).toBe(true);

    // 2. Unaccented account health check ("kiem tra tai khoan giup minh")
    const viCheck = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        locale: 'en',
        messages: [{ role: 'user', content: 'kiem tra tai khoan giup minh' }],
      },
      memberAToken,
    );
    expect(viCheck.status).toBe(200);
    expect(viCheck.body?.replyLocale).toBe('vi');
    expect(viCheck.body?.intent).toBe('diagnose_errors');
    expect(viCheck.body?.userDiagnostic).toBeTruthy();

    // 3. English prompt under Vietnamese UI locale ("diagnose my errors")
    const enDiag = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        locale: 'vi',
        messages: [{ role: 'user', content: 'diagnose my errors' }],
      },
      memberAToken,
    );
    expect(enDiag.status).toBe(200);
    expect(enDiag.body?.replyLocale).toBe('en');
    expect(enDiag.body?.intent).toBe('diagnose_errors');
    expect(String(enDiag.body?.reply)).toContain('HTTP 429');
    expect(String(enDiag.body?.reply)).toContain('90%');
    expect(enDiag.body?.userDiagnostic?.activeKeys?.[0]?.name).toBe('MemberA Cursor Key');
  });

  it('enforces Human-in-the-Loop confirmation, cross-user key isolation, assistant RBAC, RPM inheritance, and key caps on execute-action', async () => {
    const freshUser = createUser('onboarding-member@example.com', 'MemberPass123!', 'member');
    const freshToken = createSession(freshUser.userId);

    // Step 0: Brand-new member has 0/3 onboarding steps complete
    const status0 = await hit('/api/support-setup-copilot/status', 'GET', undefined, freshToken);
    expect(status0.status).toBe(200);
    expect(status0.body?.visible).toBe(false);
    expect(status0.body?.memberCopilotVisible).toBe(true);
    expect(status0.body?.onboarding?.completedCount).toBe(0);

    // 1. Proposing create_personal_key via chat NEVER mutates DB prior to user confirmation
    const proposeCreate = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        locale: 'vi',
        messages: [{ role: 'user', content: 'tao personal api key che do eco cho Cursor giup minh' }],
      },
      freshToken,
    );
    expect(proposeCreate.status).toBe(200);
    expect(proposeCreate.body?.intent).toBe('propose_action');
    expect(proposeCreate.body?.actionProposal?.actionType).toBe('create_personal_key');
    expect(proposeCreate.body?.actionProposal?.params?.routingMode).toBe('eco');
    expect(listUserApiKeys(freshUser.userId)).toHaveLength(0);

    // 2. Calling execute-action with confirmed: false MUST fail with 400 confirmation_required
    const unconfirmed = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: false,
        params: { name: 'Cursor Key', routingMode: 'eco' },
      },
      freshToken,
    );
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body?.error?.code).toBe('confirmation_required');
    expect(listUserApiKeys(freshUser.userId)).toHaveLength(0);

    // 3. Attempting to inject userId in body or bind an admin_only assistant as a member MUST fail
    const spoofedBody = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        userId: adminId,
        params: { name: 'Spoof' },
      },
      freshToken,
    );
    expect(spoofedBody.status).toBe(400);

    const restrictedAssistant = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        params: { name: 'Forbidden Assistant Key', routingMode: 'eco', assistantId: adminOnlyAssistantId },
      },
      freshToken,
    );
    expect(restrictedAssistant.status).toBe(400);
    expect(restrictedAssistant.body?.error?.code).toBe('invalid_assistant');

    // Admin CAN bind admin_only assistant on their own personal key
    const adminAllowedAssistant = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        params: { name: 'Admin Ops Key', routingMode: 'max', assistantId: adminOnlyAssistantId },
      },
      adminToken,
    );
    expect(adminAllowedAssistant.status).toBe(200);
    expect(adminAllowedAssistant.body?.createdKey?.assistantId).toBe(adminOnlyAssistantId);

    // 4. Confirmed create_personal_key mints key with routingMode + assistantId and returns IDE snippets
    const execCreate = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        params: {
          name: 'Cursor Eco Key',
          routingMode: 'eco',
          assistantId: publicAssistantId,
        },
      },
      freshToken,
    );
    expect(execCreate.status).toBe(200);
    const createdKey = execCreate.body?.createdKey;
    expect(createdKey?.rawKey).toMatch(/^sk-flm-[a-f0-9]{48}$/);
    expect(createdKey?.routingMode).toBe('eco');
    expect(createdKey?.assistantId).toBe(publicAssistantId);
    expect(createdKey?.assistantName).toBe('Pair Coder Pro');
    expect(String(createdKey?.snippets?.cursor)).toContain('/v1');
    expect(String(createdKey?.snippets?.cursor)).toContain(createdKey.rawKey);
    expect(String(createdKey?.snippets?.claudeCode)).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(String(createdKey?.snippets?.claudeCode)).toContain(createdKey.rawKey);
    expect(String(createdKey?.snippets?.openCode)).toContain('https://opencode.ai/config.json');
    expect(String(createdKey?.snippets?.openCode)).toContain(createdKey.rawKey);

    // Verify minted key authenticates properly in user-keys service
    const validated = validateUserApiKey(createdKey.rawKey);
    expect(validated?.userId).toBe(freshUser.userId);
    expect(validated?.routingMode).toBe('eco');
    expect(validated?.assistantId).toBe(publicAssistantId);

    // Admin sets custom RPM cap (25 RPM) on freshUser -> subsequent minted keys inherit 25 RPM!
    setUserRpmLimit(freshUser.userId, 25);
    const secondCreate = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        params: { name: 'Second Key', routingMode: 'balanced' },
      },
      freshToken,
    );
    expect(secondCreate.status).toBe(200);
    const keysAfterSecond = listUserApiKeys(freshUser.userId);
    expect(keysAfterSecond.find((k) => k.id === secondCreate.body?.createdKey?.id)?.rpmLimit).toBe(25);

    // 5. switch_key_routing_mode: Cross-user isolation & valid owner execution
    const memberAKeyId = listUserApiKeys(memberAId)[0]!.id;
    const crossSwitchAttempt = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'switch_key_routing_mode',
        confirmed: true,
        params: { keyId: memberAKeyId, routingMode: 'eco' },
      },
      freshToken,
    );
    expect(crossSwitchAttempt.status).toBe(404);
    expect(listUserApiKeys(memberAId)[0]!.routingMode).toBe('max'); // untouched!

    // Owner switches their own key from 'eco' -> 'max'
    const ownSwitch = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'switch_key_routing_mode',
        confirmed: true,
        params: { keyId: createdKey.id, routingMode: 'max' },
      },
      freshToken,
    );
    expect(ownSwitch.status).toBe(200);
    expect(ownSwitch.body?.updatedKey?.previousRoutingMode).toBe('eco');
    expect(ownSwitch.body?.updatedKey?.routingMode).toBe('max');
    expect(listUserApiKeys(freshUser.userId).find((k) => k.id === createdKey.id)?.routingMode).toBe('max');

    // 6. open_onboarding_guide tracks live 3-step completion accurately
    // Note: validateUserApiKey above touched last_used_at (Step 1 = true, Step 3 = true; Step 2 = false until a successful request row exists)
    const db = getDb();
    db.prepare('UPDATE user_api_keys SET last_used_at = NULL WHERE user_id = ?').run(freshUser.userId);

    const onbStep1Only = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      { actionType: 'open_onboarding_guide', confirmed: true },
      freshToken,
    );
    expect(onbStep1Only.status).toBe(200);
    expect(onbStep1Only.body?.onboarding?.completedCount).toBe(1);
    expect(onbStep1Only.body?.onboarding?.steps?.map((s: any) => s.completed)).toEqual([
      true,
      false,
      false,
    ]);

    // Playground test completion -> Step 2 turns true (2/3)
    db.prepare(
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, user_id, caller)
       VALUES ('openai', 'gpt-4o-mini', 'success', 40, 60, 350, ?, ?, 'playground')`,
    ).run(nowSqlUtc(0), freshUser.userId);

    const onbStep2Done = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      { actionType: 'open_onboarding_guide', confirmed: true },
      freshToken,
    );
    expect(onbStep2Done.body?.onboarding?.completedCount).toBe(2);
    expect(onbStep2Done.body?.onboarding?.steps?.map((s: any) => s.completed)).toEqual([
      true,
      true,
      false,
    ]);

    // External IDE call -> Step 3 turns true (3/3)
    db.prepare(
      `INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at, user_id, client_agent)
       VALUES ('anthropic', 'claude-sonnet', 'success', 120, 200, 600, ?, ?, 'claude-code')`,
    ).run(nowSqlUtc(0), freshUser.userId);

    const onbAllDone = await hit(
      '/api/support-setup-copilot/chat',
      'POST',
      {
        locale: 'en',
        messages: [{ role: 'user', content: 'Open 3-step member onboarding checklist' }],
      },
      freshToken,
    );
    expect(onbAllDone.status).toBe(200);
    expect(onbAllDone.body?.intent).toBe('propose_action');
    expect(onbAllDone.body?.actionProposal?.actionType).toBe('open_onboarding_guide');
    expect(onbAllDone.body?.actionProposal?.onboardingPreview?.completedCount).toBe(3);

    // 7. Enforce active Personal API Key cap (MAX_ACTIVE_PERSONAL_KEYS)
    const currentCount = listUserApiKeys(freshUser.userId).filter((k) => !k.revoked).length;
    for (let i = currentCount; i < MAX_ACTIVE_PERSONAL_KEYS; i += 1) {
      mintUserApiKey(freshUser.userId, `Cap Key ${i + 1}`);
    }
    db.prepare('DELETE FROM auth_request_limits').run();
    const overCap = await hit(
      '/api/support-setup-copilot/execute-action',
      'POST',
      {
        actionType: 'create_personal_key',
        confirmed: true,
        params: { name: 'One Too Many' },
      },
      freshToken,
    );
    expect(overCap.status).toBe(400);
    expect(overCap.body?.error?.code).toBe('key_limit_reached');
  });
});
