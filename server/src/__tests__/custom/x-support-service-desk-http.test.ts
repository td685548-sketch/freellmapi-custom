import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportTenant,
  mintSupportUserToken,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import type { BaseProvider } from '../../providers/base.js';
import {
  createSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  createOrAppendSupportConversation,
  createSupportEscalationTicket,
} from '../../custom/x-gateway/support-workflows.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>()),
  withQuotaTracking: async (_account: unknown, _model: unknown, _proxy: unknown, call: () => Promise<unknown>) =>
    call(),
}));

describe('Support Service Desk & Widget Studio HTTP Integration (Spec 019)', () => {
  let server: Server;
  let base: string;
  let tenant: SupportTenant;
  let signingSecret: string;
  let customerToken: string;
  let editorToken: string;
  let otherEditorToken: string;
  let readOnlyMemberToken: string;
  const completion = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    vi.stubEnv('SUPPORT_PUBLIC_BASE_URL', 'https://support.example.com/app');
    initDb(':memory:');
    setEnabled(true);

    const createdTenant = createSupportTenant({
      name: 'HTTP Service Desk Tenant',
      defaultModel: 'test-model',
      allowGuest: true,
      allowedOrigins: ['https://partner.example.com'],
    });
    tenant = createdTenant.tenant;
    signingSecret = createdTenant.signingSecret;
    customerToken = mintSupportUserToken(tenant.id, {
      userId: 'cust_http_1',
      role: 'customer',
      name: 'Alice',
      permissions: [],
    });

    const editor = createUser('editor1@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    const otherEditor = createUser('editor2@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), otherEditor.userId);
    otherEditorToken = createSession(otherEditor.userId);

    const readOnly = createUser('readonly@example.com', 'Password123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), readOnly.userId);
    readOnlyMemberToken = createSession(readOnly.userId);

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

  const consoleUrl = (subpath: string, tid = tenant.id) =>
    `${base}/api/thruline/support/tenants/${tid}/service-desk${subpath}`;

  it('1. enforces use_x_gateway AND edit_x_settings on all console 019 endpoints including GET', async () => {
    const unauth = await fetch(consoleUrl('/widget-config'));
    expect(unauth.status).toBe(401);

    for (const path of ['/widget-config', '/sla-policy', '/queue']) {
      const denied = await fetch(consoleUrl(path), {
        headers: { Authorization: `Bearer ${readOnlyMemberToken}` },
      });
      expect(denied.status).toBe(403);
    }

    const allowed = await fetch(consoleUrl('/widget-config'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('2. updates widget config with OCC and generates safe SUPPORT_PUBLIC_BASE_URL embed snippet without secrets', async () => {
    const getRes = await fetch(consoleUrl('/widget-config'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.config.enabled).toBe(false);
    expect(getBody.embedSnippet).toContain('https://support.example.com/app/thruline/v1/support/widget.js');
    expect(getBody.embedSnippet).toContain('"loadTenantProfile":true');
    expect(getBody.embedSnippet).not.toContain(signingSecret);
    expect(getBody.embedSnippet).not.toContain(editorToken);

    const putRes = await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        intake: {
          required: true,
          fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
        },
      }),
    });
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.config.version).toBe(2);
    expect(putBody.publicConfig.intake.schemaHash).toMatch(/^[a-f0-9]{64}$/);

    // Stale expectedVersion -> 409 version_conflict
    const conflictRes = await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ expectedVersion: 1, enabled: false }),
    });
    expect(conflictRes.status).toBe(409);
    expect((await conflictRes.json()).error.code).toBe('version_conflict');
  });

  it('3. serves public widget config with origin/CORS gating and rejects disallowed origins', async () => {
    const okRes = await fetch(`${base}/thruline/v1/support/widget/config`, {
      headers: {
        'X-Support-Tenant-Key': tenant.publicKey,
        Origin: 'https://partner.example.com',
      },
    });
    expect(okRes.status).toBe(200);
    const body = await okRes.json();
    expect(body.ok).toBe(true);
    expect(body.config.enabled).toBe(false);

    const badOrigin = await fetch(`${base}/thruline/v1/support/widget/config`, {
      headers: {
        'X-Support-Tenant-Key': tenant.publicKey,
        Origin: 'https://evil.example.com',
      },
    });
    expect(badOrigin.status).toBe(403);
    expect((await badOrigin.json()).error.code).toBe('origin_denied');
  });

  it('4. enforces signed session, configVersion, field validation, and replay on POST /widget/intake', async () => {
    await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        intake: {
          required: true,
          fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
        },
      }),
    });

    // Unsigned guest -> 401 signed_session_required
    const unsignedRes = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        Origin: 'https://partner.example.com',
      },
      body: JSON.stringify({ requestId: 'i1', configVersion: 2, values: { topic: 'Billing' } }),
    });
    expect(unsignedRes.status).toBe(401);
    expect((await unsignedRes.json()).error.code).toBe('signed_session_required');

    // Invalid fields -> 400 invalid_intake with fields map
    const invalidRes = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
        Origin: 'https://partner.example.com',
      },
      body: JSON.stringify({ requestId: 'i2', configVersion: 2, values: {} }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidBody = await invalidRes.json();
    expect(invalidBody.error.code).toBe('invalid_intake');
    expect(invalidBody.error.fields.topic).toBeDefined();

    // Valid submit -> 201; replay -> 200; conflict -> 409
    const first = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
        Origin: 'https://partner.example.com',
      },
      body: JSON.stringify({ requestId: 'i3', configVersion: 2, values: { topic: 'Billing' } }),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.receipt.replayed).toBe(false);

    const replay = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
        Origin: 'https://partner.example.com',
      },
      body: JSON.stringify({ requestId: 'i3', configVersion: 2, values: { topic: 'Billing' } }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).receipt.replayed).toBe(true);

    const conflict = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
        Origin: 'https://partner.example.com',
      },
      body: JSON.stringify({ requestId: 'i3', configVersion: 2, values: { topic: 'Different' } }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('request_conflict');
  });

  it('5. blocks chat bypass and spoofed intake metadata, and binds valid receipt on /chat', async () => {
    await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        intake: {
          required: true,
          fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
        },
      }),
    });

    // Spoofed internal intake metadata -> 400 invalid_input
    const spoofRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({
        requestId: 'chat_spoof',
        messages: [{ role: 'user', content: 'Hi' }],
        intake: { schemaHash: 'fake', submittedAt: '2026-01-01T00:00:00Z' },
      }),
    });
    expect(spoofRes.status).toBe(400);

    // Missing receipt -> 428 intake_required
    const bypassRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({
        requestId: 'chat_bypass',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(bypassRes.status).toBe(428);
    expect((await bypassRes.json()).error.code).toBe('intake_required');

    // Mint receipt & chat
    const intakeRes = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({ requestId: 'i_chat', configVersion: 2, values: { topic: 'Order' } }),
    });
    const { receipt } = await intakeRes.json();

    completion.mockResolvedValueOnce({
      choices: [{ message: { content: 'How can I help with your order?' } }],
      usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 },
    });

    const chatRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({
        requestId: 'chat_ok_1',
        intakeReceiptId: receipt.intakeReceiptId,
        messages: [{ role: 'user', content: 'Help with my order' }],
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatBody = await chatRes.json();
    expect(chatBody.runtime.intake).toEqual({
      schemaHash: receipt.schemaHash,
      submittedAt: expect.any(String),
    });

    // Follow-up on same conversation without repeating receipt
    completion.mockResolvedValueOnce({
      choices: [{ message: { content: 'Follow-up answer' } }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    const followUp = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({
        requestId: 'chat_ok_2',
        conversationId: chatBody.runtime.conversationId,
        messages: [{ role: 'user', content: 'Order #123' }],
      }),
    });
    expect(followUp.status).toBe(200);
  });

  it('6. handles Copilot abstention (no evidence), cited generation, actor-scoped GET, and provider failure', async () => {
    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: 'cust_http_1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'cust_http_1', content: 'How do refunds work?' },
    });

    // No evidence -> zero-model abstention
    const abstainRes = await fetch(consoleUrl('/copilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ requestId: 'cop_abstain_1', conversationId: conv.id }),
    });
    expect(abstainRes.status).toBe(200);
    const abstainBody = await abstainRes.json();
    expect(abstainBody.result.status).toBe('abstained');
    expect(abstainBody.result.reason).toBe('no_evidence');
    expect(abstainBody.result.modelUsed).toBeNull();
    expect(completion).not.toHaveBeenCalled();

    // Publish an evidence source
    updateSupportEvidencePolicy(tenant.id, { mode: 'required' }, 1);
    const src = createSupportEvidenceSource(tenant.id, {
      name: 'Refund Policy',
      kind: 'text',
      allowedRoles: ['customer', 'staff', 'admin'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenant.id,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Refund Policy',
      format: 'text',
      content: 'Refunds are processed within 5 business days for eligible orders.',
    });
    publishSupportEvidenceRevision(tenant.id, src.id, rev.revision.id, rev.source.version);

    completion.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Customer asks about refund timing [1].',
              drafts: [
                { tone: 'empathetic', text: 'I understand your concern. Refunds take 5 business days [1].' },
                { tone: 'direct', text: 'Refunds are processed within 5 business days [1].' },
                { tone: 'technical', text: 'Refund settlement completes in 5 business days per policy [1].' },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    });

    const genRes = await fetch(consoleUrl('/copilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ requestId: 'cop_gen_1', conversationId: conv.id }),
    });
    expect(genRes.status).toBe(200);
    const genBody = await genRes.json();
    expect(genBody.result.status).toBe('completed');
    expect(genBody.result.drafts).toHaveLength(3);

    // Same actor can GET job; another editor gets 404
    const jobGet = await fetch(consoleUrl(`/copilot/jobs/${genBody.result.jobId}`), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(jobGet.status).toBe(200);

    const otherGet = await fetch(consoleUrl(`/copilot/jobs/${genBody.result.jobId}`), {
      headers: { Authorization: `Bearer ${otherEditorToken}` },
    });
    expect(otherGet.status).toBe(404);
    expect((await otherGet.json()).error.code).toBe('job_not_found');

    // Provider failure -> 503 model_unavailable
    completion.mockRejectedValueOnce(new Error('upstream down'));
    const failRes = await fetch(consoleUrl('/copilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ requestId: 'cop_fail_1', conversationId: conv.id }),
    });
    expect(failRes.status).toBe(503);
    expect((await failRes.json()).error.code).toBe('model_unavailable');
  });

  it('7. manages SLA policy OCC, queue projection, manual routing, and untracked ticket 409', async () => {
    // Legacy/untracked ticket created while SLA is off
    const untrackedTkt = createSupportEscalationTicket(String(tenant.id), {
      userId: 'cust_http_1',
      userRole: 'customer',
      subject: 'Untracked alice@example.com',
      reason: 'Before SLA',
    });

    const untrackedPatch = await fetch(consoleUrl(`/tickets/${untrackedTkt.id}/routing`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ expectedVersion: 1, department: 'billing' }),
    });
    expect(untrackedPatch.status).toBe(409);
    expect((await untrackedPatch.json()).error.code).toBe('ticket_not_tracked');

    // Enable SLA policy
    const slaPut = await fetch(consoleUrl('/sla-policy'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        routingRules: [{ id: 'r1', department: 'billing', keywords: ['invoice'] }],
      }),
    });
    expect(slaPut.status).toBe(200);

    const conv = createOrAppendSupportConversation(String(tenant.id), {
      userId: 'cust_http_1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'cust_http_1', content: 'Invoice help' },
    });
    const trackedTkt = createSupportEscalationTicket(String(tenant.id), {
      conversationId: conv.id,
      userId: 'cust_http_1',
      userRole: 'customer',
      subject: 'Invoice duplicate for alice@example.com',
      reason: 'Double charge',
      priority: 'high',
    });

    // Queue pagination limit=1 returns untracked first (or deterministic order) and nextCursor
    const page1 = await fetch(consoleUrl('/queue?limit=1'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(page1.status).toBe(200);
    const p1Body = await page1.json();
    expect(p1Body.items).toHaveLength(1);
    expect(p1Body.nextCursor).toBeTruthy();

    const page2 = await fetch(consoleUrl(`/queue?limit=1&cursor=${encodeURIComponent(p1Body.nextCursor)}`), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(page2.status).toBe(200);
    const p2Body = await page2.json();
    expect(p2Body.items).toHaveLength(1);
    expect(p2Body.items[0].ticket.id).not.toBe(p1Body.items[0].ticket.id);

    // Masking on queue output
    const allIds = [...p1Body.items, ...p2Body.items];
    for (const item of allIds) {
      expect(item.ticket.subject).not.toContain('alice@example.com');
    }

    // Manual routing PATCH
    const patchRes = await fetch(consoleUrl(`/tickets/${trackedTkt.id}/routing`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ expectedVersion: 1, department: 'technical' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.state.department).toBe('technical');
    expect(patchBody.state.routingSource).toBe('manual');
    expect(patchBody.state.version).toBe(2);

    // Existing human reply stops firstResponse clock
    const replyRes = await fetch(
      `${base}/api/thruline/support/tenants/${tenant.id}/conversations/${conv.id}/reply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
        body: JSON.stringify({ content: 'Looking into your invoice now.' }),
      },
    );
    expect(replyRes.status).toBe(200);

    const queueFiltered = await fetch(consoleUrl('/queue?department=technical&status=open'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    const qfBody = await queueFiltered.json();
    expect(qfBody.items).toHaveLength(1);
    expect(qfBody.items[0].tracked).toBe(true);
    expect(qfBody.items[0].sla.firstResponse.status).toBe('met');
  });

  it('8. rejects invalid SUPPORT_PUBLIC_BASE_URL with credentials/query/hash on widget-config', async () => {
    vi.stubEnv('SUPPORT_PUBLIC_BASE_URL', 'https://user:pass@support.example.com/app?x=1');
    const res = await fetch(consoleUrl('/widget-config'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_input');
  });

  it('9. rejects stale configVersion on POST /widget/intake with 409 widget_config_changed', async () => {
    await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        intake: { required: true, fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }] },
      }),
    });
    const stale = await fetch(`${base}/thruline/v1/support/widget/intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({ requestId: 'stale_v', configVersion: 1, values: { topic: 'Billing' } }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('widget_config_changed');
  });

  it('10. rejects unknown intakeReceiptId on /chat with 404 intake_not_found', async () => {
    await fetch(consoleUrl('/widget-config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({
        expectedVersion: 1,
        enabled: true,
        intake: { required: true, fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }] },
      }),
    });
    const res = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Support-Tenant-Key': tenant.publicKey,
        'X-Support-Context-Token': customerToken,
      },
      body: JSON.stringify({
        requestId: 'unknown_rcpt_chat',
        intakeReceiptId: 'nonexistent_receipt_id',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('intake_not_found');
  });

  it('11. enforces OCC version_conflict on PUT /sla-policy and 400 on invalid queue filters', async () => {
    const getRes = await fetch(consoleUrl('/sla-policy'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(getRes.status).toBe(200);

    const conflict = await fetch(consoleUrl('/sla-policy'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ expectedVersion: 99, enabled: true }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('version_conflict');

    const badDept = await fetch(consoleUrl('/queue?department=sales'), {
      headers: { Authorization: `Bearer ${editorToken}` },
    });
    expect(badDept.status).toBe(400);
    expect((await badDept.json()).error.code).toBe('invalid_input');
  });

  it('12. returns 404 ticket_not_found on PATCH /tickets/:ticketId/routing for unknown ticket and 400 on invalid Copilot body', async () => {
    const missingTkt = await fetch(consoleUrl('/tickets/tkt_missing_123/routing'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ expectedVersion: 1, department: 'billing' }),
    });
    expect(missingTkt.status).toBe(404);
    expect((await missingTkt.json()).error.code).toBe('ticket_not_found');

    const badCopilot = await fetch(consoleUrl('/copilot'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${editorToken}` },
      body: JSON.stringify({ requestId: 'ok_req', conversationId: 'conv_1', role: 'admin' }),
    });
    expect(badCopilot.status).toBe(400);
    expect((await badCopilot.json()).error.code).toBe('invalid_input');
  });
});
