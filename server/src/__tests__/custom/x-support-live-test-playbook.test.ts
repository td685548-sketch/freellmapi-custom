import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { updateSupportGuardrailPolicy } from '../../custom/x-gateway/support-guardrails.js';
import { updateSupportRuntimePolicy } from '../../custom/x-gateway/support-runtime-store.js';
import { getLiveTestSandboxStats } from '../../custom/x-gateway/support-live-test-sandbox.js';
import { getSupportAnalyticsSummary } from '../../custom/x-gateway/support-workflows.js';
import {
  createSupportTenant,
  createSupportTool,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
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
    id: 'chatcmpl-pbk',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
  };
}

describe('Support Live Test Per-Tenant Regression Playbooks (Spec 028)', () => {
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
      name: 'Playbook Tenant A',
      slug: 'playbook-a',
      defaultModel: 'test-model',
      allowGuest: false,
    }).tenant;

    tenantB = createSupportTenant({
      name: 'Playbook Tenant B',
      slug: 'playbook-b',
      defaultModel: 'test-model',
      allowGuest: true,
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
    updateSupportRuntimePolicy(tenantB.id, { allowedModels: ['test-model'] }, 1);

    updateSupportGuardrailPolicy(String(tenantA.id), {
      enabled: true,
      blockedTopics: ['forbidden_secret_topic'],
    });

    const editor = createUser('editor-pbk@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const readOnly = createUser('readonly-pbk@example.com', 'Password123!', 'member');
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

  it('enforces RBAC, validates inputs, and isolates saved playbooks per tenant', async () => {
    const unauth = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook`,
    );
    expect(unauth.status).toBe(401);

    const readOnlyGet = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook`,
      { headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyGet.status).toBe(403);

    const readOnlyRun = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook/run`,
      { method: 'POST', headers: { Authorization: `Bearer ${readOnlyToken}` } },
    );
    expect(readOnlyRun.status).toBe(403);

    const badPut = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          cases: [
            {
              id: 'bad_1',
              title: '',
              persona: { mode: 'guest' },
              message: 'Hello',
              expectation: 'any_reply',
            },
          ],
        }),
      },
    );
    expect(badPut.status).toBe(400);

    const saveA = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          cases: [
            {
              id: 'case_a_1',
              title: 'Tenant A Guest Check',
              persona: { mode: 'guest' },
              message: 'Hi there',
              expectation: 'guest_denied',
            },
          ],
        }),
      },
    );
    expect(saveA.status).toBe(200);
    const saveABody = (await saveA.json()) as {
      ok: true;
      playbook: { version: number; cases: Array<{ id: string }> };
    };
    expect(saveABody.playbook.version).toBe(1);
    expect(saveABody.playbook.cases).toHaveLength(1);

    const getB = await fetch(
      `${base}/api/thruline/support/tenants/${tenantB.id}/service-desk/live-test/playbook`,
      { headers: { Authorization: `Bearer ${editorToken}` } },
    );
    expect(getB.status).toBe(200);
    expect(((await getB.json()) as { playbook: { cases: unknown[] } }).playbook.cases).toHaveLength(0);
  });

  it('executes saved regression cases through real runtime + intake gate and cleans up only ephemeral records', async () => {
    // Enable required intake on tenantA to verify automatic intake receipt synthesis
    const putCfg = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/widget-config`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          expectedVersion: 1,
          enabled: true,
          appearance: {
            primaryColor: '#2563eb',
            title: 'Playbook Desk',
            welcomeMessage: 'Hi',
            position: 'bottom-right',
            quickPrompts: [],
          },
          intake: {
            required: true,
            fields: [
              { key: 'order_ref', label: 'Order', type: 'text', required: true },
              { key: 'contact_email', label: 'Email', type: 'email', required: true },
            ],
          },
        }),
      },
    );
    expect(putCfg.status).toBe(200);

    // Create an active interactive Live Test conversation BEFORE running playbook
    const personaRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/persona-session`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          mode: 'authenticated',
          userId: 'cust_active',
          role: 'customer',
          name: 'Active Tester',
        }),
      },
    );
    const activeToken = ((await personaRes.json()) as { contextToken: string }).contextToken;
    const activeIntakeRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/widget/intake`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${editorToken}`,
          'X-Support-Context-Token': activeToken,
        },
        body: JSON.stringify({
          requestId: 'active_intake_keep_1',
          configVersion: 2,
          values: { order_ref: 'ORD-KEEP', contact_email: 'keep@example.com' },
        }),
      },
    );
    const activeReceiptId = (
      (await activeIntakeRes.json()) as { receipt: { intakeReceiptId: string } }
    ).receipt.intakeReceiptId;

    completion.mockResolvedValueOnce(providerReply('Interactive widget conversation stays intact.'));
    const activeChatRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${editorToken}`,
          'X-Support-Context-Token': activeToken,
        },
        body: JSON.stringify({
          requestId: 'active_chat_keep_1',
          intakeReceiptId: activeReceiptId,
          messages: [{ role: 'user', content: 'Keep this widget chat' }],
        }),
      },
    );
    expect(activeChatRes.status).toBe(200);
    expect(getLiveTestSandboxStats(tenantA.id).conversationsCount).toBe(1);

    // Save 5 regression test cases
    const saveRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({
          cases: [
            {
              id: 'case_guest_denied',
              title: 'Guest denied when allowGuest is false',
              persona: { mode: 'guest' },
              message: 'Hello as guest',
              expectation: 'guest_denied',
            },
            {
              id: 'case_guardrail',
              title: 'Blocked topic rejected by input guardrail',
              persona: { mode: 'authenticated', userId: 'cust_101', role: 'customer' },
              message: 'Tell me about forbidden_secret_topic please',
              expectation: 'guardrail_blocked',
            },
            {
              id: 'case_tool',
              title: 'Customer triggers refund_order webhook proposal',
              persona: { mode: 'authenticated', userId: 'cust_101', role: 'customer' },
              message: 'Refund order ORD-77',
              expectation: 'tool_called',
              expectedTool: 'refund_order',
            },
            {
              id: 'case_text_pass',
              title: 'Reply contains 30 days',
              persona: { mode: 'authenticated', userId: 'cust_101', role: 'customer' },
              message: 'What is the refund window?',
              expectation: 'any_reply',
              expectedText: '30 days',
            },
            {
              id: 'case_text_fail',
              title: 'Intentional mismatch assertion fails cleanly',
              persona: { mode: 'authenticated', userId: 'cust_101', role: 'customer' },
              message: 'Say something else',
              expectation: 'any_reply',
              expectedText: 'NEVER_MATCH_TOKEN',
            },
          ],
        }),
      },
    );
    expect(saveRes.status).toBe(200);

    // Prepare completions for cases that reach model generation (case_tool, case_text_pass, case_text_fail)
    completion
      .mockResolvedValueOnce(
        providerReply(
          '<support_tool_call>{"name":"webhook__refund_order","arguments":{"orderId":"ORD-77"}}</support_tool_call>',
        ),
      )
      .mockResolvedValueOnce(providerReply('Refund request ORD-77 queued for approval.'))
      .mockResolvedValueOnce(providerReply('Standard refunds are accepted within 30 days.'))
      .mockResolvedValueOnce(providerReply('Here is a normal response.'));

    const runRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/live-test/playbook/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      },
    );
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      ok: true;
      tenantId: number;
      passedCount: number;
      failedCount: number;
      results: Array<{
        caseId: string;
        passed: boolean;
        actualOutcome: string;
        toolsCalled: string[];
        reason?: string;
      }>;
    };

    expect(runBody.ok).toBe(true);
    expect(runBody.passedCount).toBe(4);
    expect(runBody.failedCount).toBe(1);
    expect(runBody.results.find((r) => r.caseId === 'case_guest_denied')).toMatchObject({
      passed: true,
      actualOutcome: 'guest_denied',
    });
    expect(runBody.results.find((r) => r.caseId === 'case_guardrail')).toMatchObject({
      passed: true,
      actualOutcome: 'guardrail_blocked',
    });
    expect(runBody.results.find((r) => r.caseId === 'case_tool')).toMatchObject({
      passed: true,
      actualOutcome: 'tool_called',
    });
    expect(runBody.results.find((r) => r.caseId === 'case_text_pass')?.passed).toBe(true);
    const failCase = runBody.results.find((r) => r.caseId === 'case_text_fail');
    expect(failCase?.passed).toBe(false);
    expect(failCase?.reason).toContain('NEVER_MATCH_TOKEN');

    // Ephemeral playbook conversations & pending actions are auto-cleaned; active widget conversation stays intact; production stats remain 0
    const sandboxStats = getLiveTestSandboxStats(tenantA.id);
    expect(sandboxStats.conversationsCount).toBe(1);
    expect(sandboxStats.pendingActionsCount).toBe(0);
    expect(getSupportAnalyticsSummary(String(tenantA.id)).totalConversations).toBe(0);
  });
});
