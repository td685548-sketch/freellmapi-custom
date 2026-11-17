import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { updateSupportRuntimePolicy } from '../../custom/x-gateway/support-runtime-store.js';
import { runWithLiveTestContext } from '../../custom/x-gateway/support-live-test-sandbox.js';
import {
  createSupportTenant,
  mintSupportUserToken,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import {
  getSupportCustomerProfileForRequester,
  getSupportCsatSummary,
  upsertSupportCustomerProfile,
} from '../../custom/x-gateway/support-crm-webhooks.js';
import {
  getSupportAnalyticsSummary,
  proposeSupportPendingAction,
} from '../../custom/x-gateway/support-workflows.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import type { BaseProvider } from '../../providers/base.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>()),
  withQuotaTracking: async (_account: unknown, _model: unknown, _proxy: unknown, call: () => Promise<unknown>) =>
    call(),
}));

function providerReply(content: string) {
  return {
    id: 'chatcmpl-sbx',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

describe('Support Live Test Sandbox Isolation & Cleanup (Spec 025)', () => {
  let server: Server;
  let base: string;
  let tenantA: SupportTenant;
  let tenantB: SupportTenant;
  let editorToken: string;
  let readOnlyToken: string;
  const completion = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);

    tenantA = createSupportTenant({
      name: 'Sandbox Tenant A',
      slug: 'sandbox-a',
      defaultModel: 'test-model',
      allowGuest: true,
    }).tenant;

    tenantB = createSupportTenant({
      name: 'Sandbox Tenant B',
      slug: 'sandbox-b',
      defaultModel: 'test-model',
      allowGuest: true,
    }).tenant;

    updateSupportRuntimePolicy(tenantA.id, { allowedModels: ['test-model'] }, 1);
    updateSupportRuntimePolicy(tenantB.id, { allowedModels: ['test-model'] }, 1);

    const editor = createUser('editor-sbx@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const readOnly = createUser('readonly-sbx@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), readOnly.userId);
    readOnlyToken = createSession(readOnly.userId);

    const secret = encrypt('test-only-provider-key');
    vi.spyOn(routes, 'resolveCandidateRoutes').mockReturnValue({
      candidates: [
        {
          account: {
            id: 1,
            provider: 'test',
            platform: 'test',
            encrypted_key: secret.encrypted,
            iv: secret.iv,
            auth_tag: secret.authTag,
          },
          modelId: 'test-model',
        },
      ],
    } as ReturnType<typeof routes.resolveCandidateRoutes>);
    vi.spyOn(providers, 'resolveAccountProvider').mockReturnValue({
      chatCompletion: completion,
    } as unknown as BaseProvider);
    completion.mockReset();
    completion.mockImplementation(async () => providerReply('Deterministic assistant reply.'));

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('enforces console RBAC on GET and DELETE /live-test/sandbox', async () => {
    const unauthGet = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`);
    expect(unauthGet.status).toBe(401);

    const readOnlyGet = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`,
      { headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyGet.status).toBe(403);

    const readOnlyDel = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyDel.status).toBe(403);
  });

  it('isolates live-test metrics from production analytics/CSAT/CRM and cleans up per-tenant sandbox safely', async () => {
    upsertSupportCustomerProfile(String(tenantA.id), {
      userId: 'cust_101',
      name: 'Alice',
      role: 'customer',
      tier: 'gold',
    });

    const realAliceToken = mintSupportUserToken(tenantA.id, {
      userId: 'cust_101',
      name: 'Alice',
      role: 'customer',
    });
    const publicHeaders = {
      'Content-Type': 'application/json',
      'X-Support-Tenant-Key': tenantA.publicKey,
      'X-Support-Context-Token': realAliceToken,
    };

    // 1. Create REAL production conversation + escalation + 2-star CSAT (even if spoofed with isLiveTest: true)
    const realChat = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({
        requestId: 'real_chat_1',
        isLiveTest: true,
        messages: [{ role: 'user', content: 'Real customer question' }],
      }),
    });
    expect(realChat.status).toBe(200);
    const realConvId = ((await realChat.json()) as { runtime: { conversationId: string } }).runtime.conversationId;

    const realEsc = await fetch(`${base}/thruline/v1/support/escalate`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ conversationId: realConvId, reason: 'Billing issue', isLiveTest: true }),
    });
    expect(realEsc.status).toBe(201);

    const realCsat = await fetch(`${base}/thruline/v1/support/csat`, {
      method: 'POST',
      headers: publicHeaders,
      body: JSON.stringify({ conversationId: realConvId, score: 2, isLiveTest: true }),
    });
    expect(realCsat.status).toBe(201);

    // 2. Save intake config on tenantA & run LIVE-TEST flow via console bridge
    const putCfg = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/widget-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        appearance: { primaryColor: '#2563eb', title: 'Support', welcomeMessage: 'Hi', position: 'bottom-right', quickPrompts: [] },
        intake: { required: true, fields: [{ key: 'order_ref', label: 'Order', type: 'text', required: true }] },
      }),
    });
    expect(putCfg.status).toBe(200);

    const personaRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/persona-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ mode: 'authenticated', userId: 'cust_101', role: 'customer', name: 'Alice' }),
      },
    );
    const personaToken = ((await personaRes.json()) as { contextToken: string }).contextToken;
    const liveHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${editorToken}`,
      'X-Support-Context-Token': personaToken,
    };

    const intakeRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/widget/intake`,
      {
        method: 'POST',
        headers: liveHeaders,
        body: JSON.stringify({ requestId: 'live_intake_req_1', configVersion: 2, values: { order_ref: 'ORD-99' } }),
      },
    );
    expect(intakeRes.status).toBe(201);
    const receiptId = ((await intakeRes.json()) as { receipt: { intakeReceiptId: string } }).receipt.intakeReceiptId;

    const liveChat = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/chat`, {
      method: 'POST',
      headers: liveHeaders,
      body: JSON.stringify({
        requestId: 'live_chat_req_1',
        intakeReceiptId: receiptId,
        messages: [{ role: 'user', content: 'Live test question' }],
      }),
    });
    expect(liveChat.status).toBe(200);
    const liveConvId = ((await liveChat.json()) as { runtime: { conversationId: string } }).runtime.conversationId;

    const liveEsc = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/escalate`, {
      method: 'POST',
      headers: liveHeaders,
      body: JSON.stringify({ conversationId: liveConvId, reason: 'Testing escalation' }),
    });
    expect(liveEsc.status).toBe(201);

    const liveCsat = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/csat`, {
      method: 'POST',
      headers: liveHeaders,
      body: JSON.stringify({ conversationId: liveConvId, score: 5 }),
    });
    expect(liveCsat.status).toBe(201);

    runWithLiveTestContext(tenantA.id, () => {
      proposeSupportPendingAction(String(tenantA.id), {
        conversationId: liveConvId,
        userId: 'cust_101',
        userName: 'Alice',
        userRole: 'customer',
        toolName: 'refund_order',
        actionSummary: 'Live test refund proposal',
        payload: { orderId: 'ORD-99' },
      });
    });

    // Also create a live-test chat on tenantB to prove cleanup is strictly tenant-scoped
    const personaBRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantB.id}/service-desk/live-test/persona-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ mode: 'authenticated', userId: 'cust_b', role: 'customer', name: 'Bob' }),
      },
    );
    const tokenB = ((await personaBRes.json()) as { contextToken: string }).contextToken;
    const liveBChat = await fetch(`${base}/api/thruline/support/tenants/${tenantB.id}/service-desk/live-test/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Context-Token': tokenB,
      },
      body: JSON.stringify({
        requestId: 'live_b_1',
        messages: [{ role: 'user', content: 'Tenant B live chat' }],
      }),
    });
    expect(liveBChat.status).toBe(200);

    // 3. Assert production metrics exclude live-test records
    const analytics = getSupportAnalyticsSummary(String(tenantA.id));
    expect(analytics.totalConversations).toBe(1);
    expect(analytics.totalTickets).toBe(1);
    expect(analytics.totalPendingActions).toBe(0);

    const csatSummary = getSupportCsatSummary(String(tenantA.id));
    expect(csatSummary.totalRatings).toBe(1);
    expect(csatSummary.averageScore).toBe(2);

    const csatApi = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/csat`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(csatApi.status).toBe(200);
    const csatApiBody = (await csatApi.json()) as { ratings: unknown[]; summary: { totalRatings: number; averageScore: number } };
    expect(csatApiBody.ratings.length).toBe(1);
    expect(csatApiBody.summary.totalRatings).toBe(1);
    expect(csatApiBody.summary.averageScore).toBe(2);

    const crmAlice = getSupportCustomerProfileForRequester(String(tenantA.id), 'cust_101', {
      userId: 'admin',
      role: 'admin',
    });
    expect(crmAlice?.csatCount).toBe(1);
    expect(crmAlice?.averageCsat).toBe(2);

    // Active SLA Queue & Conversations still include live-test items during active testing
    const queueRes = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/queue`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(queueRes.status).toBe(200);
    expect(((await queueRes.json()) as { items: unknown[] }).items.length).toBe(2);

    // 4. Inspect sandbox stats & purge tenantA live-test data
    const statsRes = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(statsRes.status).toBe(200);
    expect(await statsRes.json()).toEqual({
      ok: true,
      tenantId: tenantA.id,
      conversationsCount: 1,
      ticketsCount: 1,
      pendingActionsCount: 1,
      csatRatingsCount: 1,
      totalCount: 4,
    });

    const purgeRes = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(purgeRes.status).toBe(200);
    expect(await purgeRes.json()).toEqual({
      ok: true,
      tenantId: tenantA.id,
      deleted: {
        conversations: 1,
        tickets: 1,
        pendingActions: 1,
        csatRatings: 1,
      },
    });

    // TenantA sandbox is zero; SQLite rows for liveConvId purged; real records intact; tenantB sandbox intact
    const statsAfter = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(await statsAfter.json()).toMatchObject({ totalCount: 0 });

    const queueAfter = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/queue`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(((await queueAfter.json()) as { items: unknown[] }).items.length).toBe(1);

    const remainingIntakes = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM x_support_desk_intakes WHERE tenant_id = ? AND conversation_id = ?')
      .get(tenantA.id, liveConvId) as { cnt: number };
    expect(remainingIntakes.cnt).toBe(0);

    const statsB = await fetch(`${base}/api/thruline/support/tenants/${tenantB.id}/service-desk/live-test/sandbox`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(await statsB.json()).toMatchObject({ conversationsCount: 1, totalCount: 1 });
  });
});
