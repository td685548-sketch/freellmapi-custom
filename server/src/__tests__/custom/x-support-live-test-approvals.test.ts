import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { updateSupportRuntimePolicy } from '../../custom/x-gateway/support-runtime-store.js';
import {
  createSupportTenant,
  createSupportTool,
  mintSupportUserToken,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import * as connectors from '../../custom/x-gateway/support-connectors.js';
import type { BaseProvider } from '../../providers/base.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>()),
  withQuotaTracking: async (
    _account: unknown,
    _model: unknown,
    _proxy: unknown,
    call: () => Promise<unknown>,
  ) => call(),
}));

function providerReply(content: string) {
  return {
    id: 'chatcmpl-appr',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
  };
}

describe('Support Live Test Inline Pending Action Approvals (Spec 027)', () => {
  let server: Server;
  let base: string;
  let tenantA: SupportTenant;
  let editorToken: string;
  let readOnlyToken: string;
  const completion = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);

    tenantA = createSupportTenant({
      name: 'Approval Tenant',
      slug: 'approval-tenant',
      defaultModel: 'test-model',
      allowGuest: false,
    }).tenant;

    const refundTool = createSupportTool(tenantA.id, {
      name: 'refund_order',
      description: 'Refund a customer order',
      method: 'POST',
      endpointUrl: 'https://partner.example.com/refund',
      parametersSchema: {
        type: 'object',
        properties: { orderId: { type: 'string' } },
        required: ['orderId'],
      },
      allowedRoles: ['customer', 'admin'],
      enabled: true,
    });

    updateSupportRuntimePolicy(
      tenantA.id,
      {
        allowedModels: ['test-model'],
        toolPolicies: [{ toolId: refundTool.id, mode: 'approval_required' }],
      },
      1,
    );

    const editor = createUser('editor-appr@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const readOnly = createUser('readonly-appr@example.com', 'Password123!', 'member');
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

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('enforces editor RBAC and isolates production pending actions from live-test endpoints', async () => {
    const unauth = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions`,
    );
    expect(unauth.status).toBe(401);

    const readOnlyList = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions`,
      { headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyList.status).toBe(403);

    const readOnlyApprove = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions/act_fake/approve`,
      { method: 'POST', headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyApprove.status).toBe(403);

    // Create a REAL production pending action via /thruline/v1/support/chat
    completion
      .mockResolvedValueOnce(
        providerReply(
          '<support_tool_call>{"name":"webhook__refund_order","arguments":{"orderId":"ORD-PROD"}}</support_tool_call>',
        ),
      )
      .mockResolvedValueOnce(providerReply('Waiting on human approval for ORD-PROD.'));

    const prodToken = mintSupportUserToken(tenantA.id, {
      userId: 'cust_prod',
      name: 'Prod Customer',
      role: 'customer',
    });
    const prodChat = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': prodToken,
      },
      body: JSON.stringify({
        requestId: 'prod_refund_1',
        messages: [{ role: 'user', content: 'Please refund ORD-PROD' }],
      }),
    });
    expect(prodChat.status).toBe(200);
    const prodBody = (await prodChat.json()) as {
      runtime: { conversationId: string; pendingActions: Array<{ id: string }> };
    };
    const prodActionId = prodBody.runtime.pendingActions[0].id;

    // Live-test endpoint MUST NOT return or allow approving production pending actions
    const liveList = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions`,
      { headers: { Authorization: `Bearer ${editorToken}` } },
    );
    expect(liveList.status).toBe(200);
    expect(((await liveList.json()) as { actions: unknown[] }).actions).toHaveLength(0);

    const approveProdViaLive = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions/${encodeURIComponent(prodActionId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({}),
      },
    );
    expect(approveProdViaLive.status).toBe(404);
  });

  it('approves and rejects live-test pending actions inline and appends synced outcome messages into the conversation', async () => {
    const execWebhookSpy = vi.spyOn(connectors, 'executeSupportWebhookTool').mockResolvedValue({
      ok: true,
      status: 200,
      effectiveArgs: { orderId: 'ORD-LIVE-1' },
      data: { refunded: true, receipt: 'rcpt_999' },
    });

    const personaRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/persona-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          mode: 'authenticated',
          userId: 'cust_101',
          role: 'customer',
          name: 'Alice',
        }),
      },
    );
    const aliceToken = ((await personaRes.json()) as { contextToken: string }).contextToken;
    const liveHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${editorToken}`,
      'X-Support-Context-Token': aliceToken,
    };

    // Turn 1 (no prior conversationId): proposes approval_required action
    completion
      .mockResolvedValueOnce(
        providerReply(
          '<support_tool_call>{"name":"webhook__refund_order","arguments":{"orderId":"ORD-LIVE-1"}}</support_tool_call>',
        ),
      )
      .mockResolvedValueOnce(providerReply('Refund ORD-LIVE-1 is awaiting approval.'));

    const chat1 = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/chat`,
      {
        method: 'POST',
        headers: liveHeaders,
        body: JSON.stringify({
          requestId: 'live_appr_1',
          messages: [{ role: 'user', content: 'Refund ORD-LIVE-1' }],
        }),
      },
    );
    expect(chat1.status).toBe(200);
    const chat1Body = (await chat1.json()) as {
      runtime: { conversationId: string; pendingActions: Array<{ id: string }> };
    };
    const convId = chat1Body.runtime.conversationId;
    const firstActionId = chat1Body.runtime.pendingActions[0].id;
    expect(convId).toBeTruthy();

    // GET /live-test/pending-actions?conversationId=... returns linked first-turn action
    const list1 = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions?conversationId=${encodeURIComponent(convId)}`,
      { headers: { Authorization: `Bearer ${editorToken}` } },
    );
    expect(list1.status).toBe(200);
    const list1Body = (await list1.json()) as {
      actions: Array<{ id: string; conversationId?: string; toolName: string; isLiveTest?: boolean }>;
    };
    expect(list1Body.actions).toHaveLength(1);
    expect(list1Body.actions[0]).toMatchObject({
      id: firstActionId,
      conversationId: convId,
      toolName: 'refund_order',
      isLiveTest: true,
    });

    // Reject unknown field validation check
    const badApprove = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions/${encodeURIComponent(firstActionId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ extra: 'nope' }),
      },
    );
    expect(badApprove.status).toBe(400);

    // Approve first action with reviewNote
    const approveRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions/${encodeURIComponent(firstActionId)}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ reviewNote: 'Verified receipt' }),
      },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as {
      ok: true;
      action: { id: string; status: string; executionStatus: string; reviewNote?: string };
    };
    expect(approveBody.action).toMatchObject({
      id: firstActionId,
      status: 'approved',
      executionStatus: 'succeeded',
      reviewNote: 'Verified receipt',
    });
    expect(execWebhookSpy).toHaveBeenCalledTimes(1);

    // Conversation fetched via live-test widget poll contains synced approval message
    const convPoll1 = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/conversations/${encodeURIComponent(convId)}`,
      {
        headers: {
          Authorization: `Bearer ${editorToken}`,
          'X-Support-Context-Token': aliceToken,
        },
      },
    );
    expect(convPoll1.status).toBe(200);
    const convPoll1Body = (await convPoll1.json()) as {
      conversation: { messages: Array<{ senderType: string; content: string }> };
    };
    expect(
      convPoll1Body.conversation.messages.some(
        (m) =>
          m.senderType === 'human_agent' &&
          m.content.includes('Action "refund_order" was approved and executed (Verified receipt).'),
      ),
    ).toBe(true);

    // Turn 2: propose second action & reject it -> zero extra webhook calls, rejection outcome message appended
    completion
      .mockResolvedValueOnce(
        providerReply(
          '<support_tool_call>{"name":"webhook__refund_order","arguments":{"orderId":"ORD-LIVE-2"}}</support_tool_call>',
        ),
      )
      .mockResolvedValueOnce(providerReply('Refund ORD-LIVE-2 is awaiting approval.'));

    const chat2 = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/chat`,
      {
        method: 'POST',
        headers: liveHeaders,
        body: JSON.stringify({
          requestId: 'live_appr_2',
          conversationId: convId,
          messages: [{ role: 'user', content: 'Refund ORD-LIVE-2' }],
        }),
      },
    );
    expect(chat2.status).toBe(200);
    const secondActionId = (
      (await chat2.json()) as { runtime: { pendingActions: Array<{ id: string }> } }
    ).runtime.pendingActions[0].id;

    const rejectRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/pending-actions/${encodeURIComponent(secondActionId)}/reject`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ reviewNote: 'Outside return window' }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as {
      action: { id: string; status: string; executionStatus: string };
    };
    expect(rejectBody.action).toMatchObject({
      id: secondActionId,
      status: 'rejected',
      executionStatus: 'failed',
    });
    expect(execWebhookSpy).toHaveBeenCalledTimes(1);

    const convPoll2 = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/conversations/${encodeURIComponent(convId)}`,
      {
        headers: {
          Authorization: `Bearer ${editorToken}`,
          'X-Support-Context-Token': aliceToken,
        },
      },
    );
    const convPoll2Body = (await convPoll2.json()) as {
      conversation: { messages: Array<{ senderType: string; content: string }> };
    };
    expect(
      convPoll2Body.conversation.messages.some(
        (m) =>
          m.senderType === 'human_agent' &&
          m.content.includes('Action "refund_order" was rejected: Outside return window'),
      ),
    ).toBe(true);

    // Sandbox cleanup removes x_support_action_executions rows as well
    const delSandbox = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/sandbox`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${editorToken}` },
      },
    );
    expect(delSandbox.status).toBe(200);
    const execCnt = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM x_support_action_executions WHERE tenant_id = ? AND action_id IN (?, ?)')
      .get(tenantA.id, firstActionId, secondActionId) as { cnt: number };
    expect(execCnt.cnt).toBe(0);
  });
});
