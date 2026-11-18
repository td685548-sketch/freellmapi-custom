import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportDbSource,
  createSupportTenant,
  createSupportTool,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import {
  DEFAULT_ECOMMERCE_SANDBOX_SQL,
  DEFAULT_ECOMMERCE_TABLE_POLICIES,
} from '../../custom/x-gateway/support-connectors.js';
import { updateSupportRuntimePolicy } from '../../custom/x-gateway/support-runtime-store.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
} from '../../custom/x-gateway/support-evidence-store.js';
import { updateSupportGuardrailPolicy } from '../../custom/x-gateway/support-guardrails.js';
import { updateSupportMaskingPolicy } from '../../custom/x-gateway/support-knowledge.js';
import { upsertSupportCustomerProfile } from '../../custom/x-gateway/support-crm-webhooks.js';
import { saveSupportOutputPolicy } from '../../custom/x-gateway/support-output-store.js';
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
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

describe('Support Service Desk Live End-User Widget Testing HTTP Integration (Spec 023)', () => {
  let server: Server;
  let base: string;
  let tenantA: SupportTenant;
  let tenantB: SupportTenant;
  let secretA: string;
  let editorToken: string;
  let readOnlyToken: string;
  let editOnlyToken: string;
  const completion = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);

    const createdA = createSupportTenant({
      name: 'Live Test Tenant A',
      slug: 'live-tenant-a',
      defaultModel: 'test-model',
      allowGuest: true,
      allowedOrigins: ['https://allowed-shop.example.com'],
    });
    tenantA = createdA.tenant;
    secretA = createdA.signingSecret;

    const createdB = createSupportTenant({
      name: 'Live Test Tenant B',
      slug: 'live-tenant-b',
      defaultModel: 'test-model',
      allowGuest: false,
      allowedOrigins: ['https://tenant-b.example.com'],
    });
    tenantB = createdB.tenant;

    const editor = createUser('editor-live@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const readOnly = createUser('readonly-live@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), readOnly.userId);
    readOnlyToken = createSession(readOnly.userId);

    const editOnly = createUser('editonly-live@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['edit_x_settings']), editOnly.userId);
    editOnlyToken = createSession(editOnly.userId);

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
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const liveUrl = (subpath: string, tid: number | string = tenantA.id) =>
    `${base}/api/thruline/support/tenants/${tid}/service-desk/live-test${subpath}`;

  async function mintPersona(
    persona: {
      mode: 'guest' | 'authenticated';
      userId?: string;
      role?: string;
      name?: string;
      email?: string;
      permissions?: string[];
    },
    tid = tenantA.id,
  ) {
    const res = await fetch(liveUrl('/persona-session', tid), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify(persona),
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  it('1. enforces console RBAC, numeric tenant IDs, and strict allowlist without exposing signingSecret', async () => {
    // Unauthenticated -> 401
    const unauth = await fetch(liveUrl('/widget/config'));
    expect(unauth.status).toBe(401);

    // Missing edit_x_settings -> 403 on both GET and POST
    const roGet = await fetch(liveUrl('/widget/config'), {
      headers: { Authorization: `Bearer ${readOnlyToken}` },
    });
    expect(roGet.status).toBe(403);

    const roPost = await fetch(liveUrl('/persona-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readOnlyToken}` },
      body: JSON.stringify({ mode: 'guest' }),
    });
    expect(roPost.status).toBe(403);

    // Missing use_x_gateway -> 403
    const eoPost = await fetch(liveUrl('/persona-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editOnlyToken}` },
      body: JSON.stringify({ mode: 'guest' }),
    });
    expect(eoPost.status).toBe(403);

    // Non-numeric tenant ID -> 400; unknown numeric tenant -> 404
    const badId = await fetch(liveUrl('/widget/config', 'abc'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(badId.status).toBe(400);

    const missingTenant = await fetch(liveUrl('/widget/config', 99999), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(missingTenant.status).toBe(404);

    // Allowlist blocks non-widget public routes such as /session and list-all /conversations
    const blockedSession = await fetch(liveUrl('/session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ tenantKey: tenantA.publicKey }),
    });
    expect(blockedSession.status).toBe(404);

    const blockedListAll = await fetch(liveUrl('/conversations'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(blockedListAll.status).toBe(404);

    // Persona session never exposes signingSecret
    const authRes = await mintPersona({
      mode: 'authenticated',
      userId: 'cust_101',
      role: 'customer',
      name: 'Alice',
      permissions: ['custom:perm'],
    });
    expect(authRes.status).toBe(200);
    expect(authRes.body.ok).toBe(true);
    expect(typeof authRes.body.contextToken).toBe('string');
    expect(authRes.body.userContext.permissions).toContain('custom:perm');
    expect(JSON.stringify(authRes.body)).not.toContain(secretA);
    expect(JSON.stringify(authRes.body)).not.toContain('signingSecret');
  });

  it('2. enforces guest access rules (allowGuest true vs false) and blocks cross-tenant tampering', async () => {
    // Tenant A allows guest
    const gA = await mintPersona({ mode: 'guest' }, tenantA.id);
    expect(gA.status).toBe(200);
    expect(gA.body.contextToken).toBeNull();
    expect(gA.body.allowGuest).toBe(true);

    const guestSessA = await fetch(liveUrl('/guest-session', tenantA.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(guestSessA.status).toBe(200);
    const guestSessData = (await guestSessA.json()) as { contextToken: string; userContext: { role: string } };
    expect(guestSessData.userContext.role).toBe('guest');

    // Tenant B disables guest -> /guest-session and /chat reject with 403 guest_not_allowed
    const gB = await mintPersona({ mode: 'guest' }, tenantB.id);
    expect(gB.status).toBe(200);
    expect(gB.body.allowGuest).toBe(false);

    const guestSessB = await fetch(liveUrl('/guest-session', tenantB.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({}),
    });
    expect(guestSessB.status).toBe(403);
    expect(((await guestSessB.json()) as any).error.code).toBe('guest_not_allowed');

    const guestChatB = await fetch(liveUrl('/chat', tenantB.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    });
    expect(guestChatB.status).toBe(403);
    expect(((await guestChatB.json()) as any).error.code).toBe('guest_not_allowed');

    // Cross-tenant key mismatch in live-test bridge -> 403 tenant_mismatch
    const mismatchRes = await fetch(liveUrl('/chat', tenantA.id), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Tenant-Key': tenantB.publicKey,
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
    });
    expect(mismatchRes.status).toBe(403);
    expect(((await mismatchRes.json()) as any).error.code).toBe('tenant_mismatch');
  });

  it('3. enforces DB row-level ownership, denied columns, and approval-required tools per simulated persona', async () => {
    const dbSrc = createSupportDbSource(tenantA.id, {
      name: 'Store DB',
      driver: 'sqlite-sandbox',
      schemaSql: DEFAULT_ECOMMERCE_SANDBOX_SQL,
      tablePolicies: DEFAULT_ECOMMERCE_TABLE_POLICIES,
      maxRows: 50,
      enabled: true,
    });
    const refundTool = createSupportTool(tenantA.id, {
      name: 'refund_order',
      description: 'Refund a customer order',
      method: 'POST',
      endpointUrl: 'https://partner.example.com/refund',
      parametersSchema: {
        type: 'object',
        properties: { orderId: { type: 'number' } },
        required: ['orderId'],
      },
      allowedRoles: ['customer', 'admin'],
      enabled: true,
    });
    updateSupportRuntimePolicy(tenantA.id, {
      toolPolicies: [{ toolId: refundTool.id, mode: 'approval_required' }],
    });

    upsertSupportCustomerProfile(String(tenantA.id), {
      userId: 'cust_101',
      name: 'Alice Nguyen',
      role: 'customer',
      tier: 'gold',
      memoryFacts: ['Prefers email follow-up'],
    });

    const alice = await mintPersona({ mode: 'authenticated', userId: 'cust_101', role: 'customer', name: 'Alice' });

    // Customer Alice queries orders -> DB sandbox rewrites SQL with WHERE user_id = 'cust_101' and CRM memory is injected
    completion
      .mockImplementationOnce(async (_cred, msgs: Array<{ role: string; content: string }>) => {
        const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
        expect(sys).toContain('Prefers email follow-up');
        return providerReply(`<support_tool_call>{"name":"db__source_${dbSrc.id}","arguments":{"sql":"SELECT id, user_id, product_name FROM orders"}}</support_tool_call>`);
      })
      .mockResolvedValueOnce(providerReply('You have orders #1 and #2.'));

    const ordersRes = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Context-Token': alice.body.contextToken,
      },
      body: JSON.stringify({ requestId: 'live_orders_alice', messages: [{ role: 'user', content: 'List orders' }] }),
    });
    expect(ordersRes.status).toBe(200);
    const ordersBody = (await ordersRes.json()) as any;
    expect(ordersBody.toolTrace).toHaveLength(1);
    const rows = ordersBody.toolTrace[0].result as Array<{ id: number; user_id: string }>;
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.user_id === 'cust_101')).toBe(true);

    // Customer Alice tries denied columns -> error recorded in toolTrace, data not leaked
    completion
      .mockResolvedValueOnce(
        providerReply(`<support_tool_call>{"name":"db__source_${dbSrc.id}","arguments":{"sql":"SELECT password_hash, secret_note FROM customers"}}</support_tool_call>`),
      )
      .mockResolvedValueOnce(providerReply('I cannot access private fields.'));

    const deniedRes = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Context-Token': alice.body.contextToken,
      },
      body: JSON.stringify({ requestId: 'live_denied_col', messages: [{ role: 'user', content: 'Show secrets' }] }),
    });
    expect(deniedRes.status).toBe(200);
    const deniedBody = (await deniedRes.json()) as any;
    expect(deniedBody.toolTrace[0].error).toBeTruthy();

    // Admin sees all 4 orders across cust_101 & cust_102
    const admin = await mintPersona({ mode: 'authenticated', userId: 'admin_01', role: 'admin', name: 'Admin' });
    completion
      .mockResolvedValueOnce(
        providerReply(`<support_tool_call>{"name":"db__source_${dbSrc.id}","arguments":{"sql":"SELECT id, user_id FROM orders"}}</support_tool_call>`),
      )
      .mockResolvedValueOnce(providerReply('There are 4 orders in total.'));

    const adminRes = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Context-Token': admin.body.contextToken,
      },
      body: JSON.stringify({ requestId: 'live_orders_admin', messages: [{ role: 'user', content: 'All orders' }] }),
    });
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as any;
    expect(adminBody.toolTrace[0].result).toHaveLength(4);

    // Approval-required webhook tool creates real pending action
    completion
      .mockResolvedValueOnce(
        providerReply(`<support_tool_call>{"name":"webhook__${refundTool.name}","arguments":{"orderId":1}}</support_tool_call>`),
      )
      .mockResolvedValueOnce(providerReply('Your refund request is waiting for approval.'));

    const approveRes = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Context-Token': alice.body.contextToken,
      },
      body: JSON.stringify({ requestId: 'live_refund_approval', messages: [{ role: 'user', content: 'Refund order 1' }] }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as any;
    expect(approveBody.runtime.pendingActions).toHaveLength(1);
    expect(approveBody.runtime.pendingActions[0].toolName).toBe('refund_order');

    const actionsList = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/actions?status=pending`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(actionsList.status).toBe(200);
    expect(((await actionsList.json()) as any).actions.some((a: any) => a.toolName === 'refund_order')).toBe(true);
  });

  it('4. enforces pre-chat intake, RAG role isolation, source revocation, guardrails, PII, quota, CRM, output controls, and full escalation -> Copilot -> CSAT lifecycle', async () => {
    // Configure required widget intake via console API
    const cfgRes = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/widget-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        appearance: {
          primaryColor: '#2563eb',
          title: 'Live Studio Desk',
          welcomeMessage: 'Hello!',
          position: 'bottom-right',
          quickPrompts: ['Return policy'],
        },
        intake: {
          required: true,
          fields: [{ key: 'order_ref', label: 'Order Reference', type: 'text', required: true }],
        },
      }),
    });
    expect(cfgRes.status).toBe(200);

    // Configure RAG evidence (customer source + admin-only source)
    const custSource = createSupportEvidenceSource(tenantA.id, {
      name: 'Public Return Policy',
      kind: 'text',
      allowedRoles: ['customer'],
    });
    const custRev = await importSupportEvidenceRevision({
      tenantId: tenantA.id,
      sourceId: custSource.id,
      expectedVersion: custSource.version,
      title: 'Return Rules',
      format: 'text',
      content: 'Return policy allows full refunds within 30 days with receipt.',
    });
    const publishedCustSource = publishSupportEvidenceRevision(
      tenantA.id,
      custSource.id,
      custRev.revision.id,
      custRev.source.version,
    );

    const adminSource = createSupportEvidenceSource(tenantA.id, {
      name: 'Internal Escalation Secret',
      kind: 'text',
      allowedRoles: ['admin'],
    });
    const adminRev = await importSupportEvidenceRevision({
      tenantId: tenantA.id,
      sourceId: adminSource.id,
      expectedVersion: adminSource.version,
      title: 'Internal Runbook',
      format: 'text',
      content: 'Internal VIP code ZEBRA999 grants instant override.',
    });
    publishSupportEvidenceRevision(tenantA.id, adminSource.id, adminRev.revision.id, adminRev.source.version);

    updateSupportEvidencePolicy(
      tenantA.id,
      { mode: 'required', includeLegacyDocs: false, topK: 3, minCoverage: 0.25 },
      1,
    );

    // Configure Guardrails + PII + CRM + Output Controls
    updateSupportGuardrailPolicy(String(tenantA.id), {
      enabled: true,
      blockedTopics: ['forbidden_topic_xyz'],
      roleQuotas: {
        customer: { maxRequestsPerWindow: 3, maxTokensPerWindow: 50000, windowSeconds: 3600 },
      },
    });
    updateSupportMaskingPolicy(String(tenantA.id), {
      enabled: true,
      builtinDetectors: ['email', 'phone', 'api_key'],
      unmaskedRoles: ['admin'],
    });
    upsertSupportCustomerProfile(String(tenantA.id), {
      userId: 'cust_101',
      name: 'Alice Nguyen',
      role: 'customer',
      tier: 'gold',
      memoryFacts: ['Prefers email follow-up'],
    });
    saveSupportOutputPolicy({
      tenantId: tenantA.id,
      expectedVersion: 0,
      policy: {
        mode: 'enforce',
        blockedTerms: [{ id: 'secret_phrase', text: 'do_not_say_this' }],
        maxOutputChars: 4000,
        redactCredentials: true,
      },
    });

    const alice = await mintPersona({ mode: 'authenticated', userId: 'cust_101', role: 'customer', name: 'Alice' });
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${editorToken}`,
      'X-Support-Context-Token': alice.body.contextToken,
    };

    // 4a. Direct chat without intake -> 428 intake_required
    const noIntake = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'live_no_intake', messages: [{ role: 'user', content: 'Return policy?' }] }),
    });
    expect(noIntake.status).toBe(428);

    // 4b. Submit intake via bridge
    const intakeRes = await fetch(liveUrl('/widget/intake'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'live_intake_1', configVersion: 2, values: { order_ref: 'ORD-555' } }),
    });
    expect(intakeRes.status).toBe(201);
    const receiptId = ((await intakeRes.json()) as any).receipt.intakeReceiptId as string;

    // 4c. Guardrail blocks forbidden topic
    const blockedInput = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'live_guardrail_block',
        intakeReceiptId: receiptId,
        messages: [{ role: 'user', content: 'Tell me about forbidden_topic_xyz' }],
      }),
    });
    expect(blockedInput.status).toBe(403);
    expect(((await blockedInput.json()) as any).error.code).toBe('guardrail_blocked');

    // 4d. Customer asks admin-only knowledge -> zero-model abstention (does not see ZEBRA999)
    const adminDocForCust = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'live_admin_doc_denied',
        intakeReceiptId: receiptId,
        messages: [{ role: 'user', content: 'What is ZEBRA999 runbook override?' }],
      }),
    });
    expect(adminDocForCust.status).toBe(200);
    const adminDocBody = (await adminDocForCust.json()) as any;
    expect(adminDocBody.runtime.replySource).toBe('knowledge_abstention');
    expect(adminDocBody.runtime.evidence.reason).toBe('no_matches');
    const convId = adminDocBody.runtime.conversationId as string;
    expect(convId).toBeTruthy();

    // 4e. Customer asks allowed return policy on the same conversation; reply includes PII + blocked output term -> masked/blocked by PII & Output Control!
    completion.mockImplementationOnce(async (_cred, msgs: Array<{ role: string; content: string }>) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(sys);
      expect(match).not.toBeNull();
      return providerReply(
        `Refunds take 30 days. Contact alice@secret.com. Avoid do_not_say_this [cite:${match![1]}].`,
      );
    });
    const ragRes = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'live_rag_cited',
        conversationId: convId,
        messages: [{ role: 'user', content: 'Explain return policy refunds' }],
      }),
    });
    expect(ragRes.status).toBe(200);
    const ragBody = (await ragRes.json()) as any;
    expect(ragBody.runtime.conversationId).toBe(convId);
    // Output control enforces block/redact and PII masking masks alice@secret.com if reply kept
    expect(ragBody.reply).not.toContain('do_not_say_this');
    expect(ragBody.reply).not.toContain('alice@secret.com');

    // Reset output policy to off so next cited message is preserved for source revocation & escalation lifecycle test
    saveSupportOutputPolicy({
      tenantId: tenantA.id,
      expectedVersion: 1,
      policy: { mode: 'off', blockedTerms: [], maxOutputChars: 4000, redactCredentials: false },
    });

    completion.mockImplementationOnce(async (_cred, msgs: Array<{ role: string; content: string }>) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(sys);
      return providerReply(`Full refunds are allowed within 30 days [cite:${match![1]}].`);
    });
    const ragCited2 = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'live_rag_cited_2',
        conversationId: convId,
        intakeReceiptId: receiptId,
        messages: [{ role: 'user', content: 'Return policy receipt refunds 30 days' }],
      }),
    });
    expect(ragCited2.status).toBe(200);
    const ragCited2Body = (await ragCited2.json()) as any;
    expect(ragCited2Body.runtime.evidence.status).toBe('cited');

    // 4f. Escalate without explicit subject (widget behavior) -> creates ticket in SLA queue -> staff replies & resolves -> CSAT
    const escRes = await fetch(liveUrl('/escalate'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: convId, reason: 'user_requested' }),
    });
    expect(escRes.status).toBe(201);
    const escBody = (await escRes.json()) as any;
    expect(escBody.conversationId).toBe(convId);

    const queueRes = await fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/service-desk/queue`, {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(queueRes.status).toBe(200);
    expect(((await queueRes.json()) as any).items.some((i: any) => i.ticket.id === escBody.ticket.id)).toBe(true);

    const replyRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenantA.id}/conversations/${convId}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ content: 'Refund approved by agent.', resolveConversation: true }),
      },
    );
    expect(replyRes.status).toBe(200);

    // Archive customer source -> GET conversation via bridge revokes cited turn while keeping staff reply & resolved status
    const latestSource = updateSupportEvidenceSource(tenantA.id, custSource.id, { status: 'archived' }, publishedCustSource.version);
    expect(latestSource.status).toBe('archived');

    const pollConv = await fetch(liveUrl(`/conversations/${encodeURIComponent(convId)}`), {
      headers: { Authorization: `Bearer ${editorToken}`, 'X-Support-Context-Token': alice.body.contextToken },
    });
    expect(pollConv.status).toBe(200);
    const polledData = (await pollConv.json()) as any;
    expect(polledData.conversation.status).toBe('resolved');
    expect(polledData.conversation.messages.some((m: any) => m.content === 'Refund approved by agent.')).toBe(true);
    expect(
      polledData.conversation.messages.some((m: any) => m.evidence && m.evidence.reason === 'source_revoked'),
    ).toBe(true);

    const csatRes = await fetch(liveUrl('/csat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId: convId, score: 5 }),
    });
    expect(csatRes.status).toBe(201);

    // 4g. Quota check: fourth request exceeds maxRequestsPerWindow (3)
    const intake2Res = await fetch(liveUrl('/widget/intake'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestId: 'live_intake_2', configVersion: 2, values: { order_ref: 'ORD-556' } }),
    });
    expect(intake2Res.status).toBe(201);
    const receipt2Id = ((await intake2Res.json()) as any).receipt.intakeReceiptId as string;

    const overQuota = await fetch(liveUrl('/chat'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'live_quota_4',
        intakeReceiptId: receipt2Id,
        messages: [{ role: 'user', content: 'Return policy refunds' }],
      }),
    });
    expect(overQuota.status).toBe(429);
    expect(((await overQuota.json()) as any).error.code).toBe('quota_exceeded');
  });

  it('5. bypasses external allowedOrigins by default for studio operators while enforcing origin-check and X-Support-Simulated-Origin', async () => {
    // Default console call with console Origin is allowed even though tenantA restricts to allowed-shop.example.com
    const studioCfg = await fetch(liveUrl('/widget/config'), {
      headers: {
        Authorization: `Bearer ${editorToken}`,
        Origin: 'https://studio-admin.example.com',
      },
    });
    expect(studioCfg.status).toBe(200);

    // Explicit origin-check helper
    const okOrigin = await fetch(liveUrl('/origin-check'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ origin: 'https://allowed-shop.example.com' }),
    });
    expect(okOrigin.status).toBe(200);
    expect(await okOrigin.json()).toMatchObject({ allowed: true, reason: 'matched' });

    const badOrigin = await fetch(liveUrl('/origin-check'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ origin: 'https://evil-site.example.com' }),
    });
    expect(badOrigin.status).toBe(200);
    expect(await badOrigin.json()).toMatchObject({ allowed: false, reason: 'not_in_allowlist' });

    // Simulated origin enforcement on runtime bridge
    const simBlocked = await fetch(liveUrl('/widget/config'), {
      headers: {
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Simulated-Origin': 'https://evil-site.example.com',
      },
    });
    expect(simBlocked.status).toBe(403);
    expect(((await simBlocked.json()) as any).error.code).toBe('origin_denied');

    const simAllowed = await fetch(liveUrl('/widget/config'), {
      headers: {
        Authorization: `Bearer ${editorToken}`,
        'X-Support-Simulated-Origin': 'https://allowed-shop.example.com',
      },
    });
    expect(simAllowed.status).toBe(200);
  });
});
