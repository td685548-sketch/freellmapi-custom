import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportTenant,
  mintSupportUserToken,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';

describe('AI Support Enterprise Suite (/api/x-gateway/support/* & /x/v1/support/*)', () => {
  let server: Server;
  let base: string;
  let editorToken: string;

  let tenant: SupportTenant;
  let customerAToken: string;
  let customerBToken: string;
  let staffToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Admin user (primary user seed)
    createUser('admin@enterprise.test', 'AdminPass123!');

    // Editor user (edit_x_settings + use_x_gateway)
    const editor = createUser('editor@enterprise.test', 'EditorPass123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    // Plain member (no gateway permissions)
    createUser('member@enterprise.test', 'MemberPass123!', 'member');

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    setEnabled(true);

    // Create a test partner tenant
    const created = createSupportTenant({
      name: 'Enterprise Cloud Corp',
      slug: 'enterprise-cloud',
      defaultModel: 'auto',
      allowGuest: true,
      allowedOrigins: ['http://localhost:3000'],
    });
    tenant = created.tenant;

    // Mint user tokens for Customer A, Customer B, Staff
    customerAToken = mintSupportUserToken(tenant.id, {
      userId: 'cust_alice',
      name: 'Alice Customer',
      email: 'alice@example.com',
      role: 'customer',
      permissions: [],
    });

    customerBToken = mintSupportUserToken(tenant.id, {
      userId: 'cust_bob',
      name: 'Bob Customer',
      email: 'bob@example.com',
      role: 'customer',
      permissions: [],
    });

    staffToken = mintSupportUserToken(tenant.id, {
      userId: 'staff_charlie',
      name: 'Charlie Staff',
      email: 'charlie@enterprise.test',
      role: 'staff',
      permissions: [],
    });
  });

  afterAll(() => {
    server?.close();
  });

  async function apiCall(
    path: string,
    opts: {
      method?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    let body: unknown = text;
    if (contentType.includes('application/json')) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
    }
    return { status: res.status, headers: res.headers, body, text };
  }

  // -------------------------------------------------------------------------
  // 1. Console Management Endpoints (/api/x-gateway/support/*)
  // -------------------------------------------------------------------------
  describe('Admin Console API (/api/x-gateway/support/*)', () => {
    let customDocId: string;
    let createdConvId: string;
    let createdTicketId: string;
    let createdActionId: string;

    it('1. GET /tenants/:id/knowledge returns empty docs array initially', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge`, {
        token: editorToken,
      });
      expect(res.status).toBe(200);
      const data = res.body as { ok: boolean; docs: unknown[] };
      expect(data.ok).toBe(true);
      expect(Array.isArray(data.docs)).toBe(true);
      expect(data.docs.length).toBe(0);
    });

    it('2. POST /tenants/:id/knowledge creates new role-scoped knowledge doc', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge`, {
        method: 'POST',
        token: editorToken,
        body: {
          title: 'Custom VIP Support Policy',
          category: 'policy',
          content: 'VIP customers receive immediate phone support at 1-800-555-0199 and 50% discount.',
          tags: ['vip', 'discount', 'phone'],
          allowedRoles: ['customer', 'staff', 'admin'],
        },
      });
      expect(res.status).toBe(201);
      const data = res.body as { ok: boolean; doc: { id: string; title: string; category: string } };
      expect(data.ok).toBe(true);
      expect(data.doc.title).toBe('Custom VIP Support Policy');
      expect(data.doc.category).toBe('policy');
      customDocId = data.doc.id;
    });

    it('3. POST /tenants/:id/knowledge/seed seeds default 4 role-scoped knowledge docs', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge/seed`, {
        method: 'POST',
        token: editorToken,
      });
      expect(res.status).toBe(200);
      const data = res.body as { ok: boolean; docs: Array<{ title: string; allowedRoles: string[] }> };
      expect(data.ok).toBe(true);
      expect(data.docs.length).toBe(5); // 1 custom + 4 seeded
      const titles = data.docs.map((d) => d.title);
      expect(titles).toContain('Public Shipping & Delivery FAQ');
      expect(titles).toContain('Customer Order & Loyalty Guide');
      expect(titles).toContain('Internal Refund & Escalation SOP');
      expect(titles).toContain('Executive SLA & Margin Playbook');
    });

    it('4. DELETE /tenants/:id/knowledge/:docId deletes a document', async () => {
      const res = await apiCall(
        `/api/x-gateway/support/tenants/${tenant.id}/knowledge/${customDocId}`,
        {
          method: 'DELETE',
          token: editorToken,
        },
      );
      expect(res.status).toBe(200);
      expect((res.body as { ok: boolean }).ok).toBe(true);

      const listRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge`, {
        token: editorToken,
      });
      const listData = listRes.body as { docs: Array<{ id: string }> };
      expect(listData.docs.some((d) => d.id === customDocId)).toBe(false);
    });

    it('5. POST /tenants/:id/knowledge/search performs role-filtered RAG & builds contextPrompt', async () => {
      // Role: guest (should only see Public Shipping FAQ, not Internal Refund SOP)
      const guestRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge/search`, {
        method: 'POST',
        token: editorToken,
        body: {
          query: 'refund and shipping guidelines',
          role: 'guest',
        },
      });
      expect(guestRes.status).toBe(200);
      const guestData = guestRes.body as { ok: boolean; matches: any[]; contextPrompt: string };
      expect(guestData.ok).toBe(true);
      expect(guestData.matches.every((m) => m.title !== 'Internal Refund & Escalation SOP')).toBe(true);

      // Role: admin (can see Internal Refund & Executive Margin Playbook)
      const adminRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/knowledge/search`, {
        method: 'POST',
        token: editorToken,
        body: {
          query: 'refund and margin playbook',
          role: 'admin',
        },
      });
      expect(adminRes.status).toBe(200);
      const adminData = adminRes.body as { ok: boolean; matches: any[]; contextPrompt: string };
      expect(adminData.ok).toBe(true);
      expect(adminData.contextPrompt).toContain('[ROLE-SCOPED KNOWLEDGE BASE]');
      const titles = adminData.matches.map((m) => m.title);
      expect(titles).toContain('Internal Refund & Escalation SOP');
    });

    it('6. GET & PUT /tenants/:id/masking manages PII masking policy', async () => {
      const getRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/masking`, {
        token: editorToken,
      });
      expect(getRes.status).toBe(200);
      const initialPolicy = (getRes.body as { policy: any }).policy;
      expect(initialPolicy.enabled).toBe(true);
      expect(initialPolicy.builtinDetectors).toContain('credit_card');

      const putRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/masking`, {
        method: 'PUT',
        token: editorToken,
        body: {
          builtinDetectors: ['email', 'phone', 'credit_card', 'api_key'],
          unmaskedRoles: ['admin', 'executive'],
          customRules: [
            {
              id: 'rule-badge',
              name: 'Secret Badge Detector',
              pattern: '\\bBADGE-[A-Z0-9]+\\b',
              replacement: '[BADGE_REDACTED]',
              enabled: true,
            },
          ],
        },
      });
      expect(putRes.status).toBe(200);
      const updatedPolicy = (putRes.body as { policy: any }).policy;
      expect(updatedPolicy.unmaskedRoles).toContain('executive');
      expect(updatedPolicy.customRules.length).toBe(1);
      expect(updatedPolicy.customRules[0].name).toBe('Secret Badge Detector');
    });

    it('7. POST /tenants/:id/masking/test redacts sensitive data for customer role', async () => {
      const sampleText =
        'Contact john.doe@example.com at +1-555-123-4567, card 4111 2222 3333 4444, key sk-abcdef1234567890, badge BADGE-SECRET999';

      // Customer role -> masked
      const custRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/masking/test`, {
        method: 'POST',
        token: editorToken,
        body: {
          text: sampleText,
          role: 'customer',
        },
      });
      expect(custRes.status).toBe(200);
      const custData = custRes.body as { ok: boolean; result: { masked: string; redactionCount: number; bypassedByRole: boolean } };
      expect(custData.ok).toBe(true);
      expect(custData.result.bypassedByRole).toBe(false);
      expect(custData.result.redactionCount).toBeGreaterThan(0);
      expect(custData.result.masked).toContain('[REDACTED_KEY]');
      expect(custData.result.masked).toContain('****-****-****-4444');
      expect(custData.result.masked).toContain('[BADGE_REDACTED]');

      // Admin role -> unmasked / bypassed
      const admRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/masking/test`, {
        method: 'POST',
        token: editorToken,
        body: {
          text: sampleText,
          role: 'admin',
        },
      });
      expect(admRes.status).toBe(200);
      const admData = admRes.body as { ok: boolean; result: { masked: string; bypassedByRole: boolean } };
      expect(admData.result.bypassedByRole).toBe(true);
      expect(admData.result.masked).toBe(sampleText);
    });

    it('8. GET /tenants/:id/conversations & POST .../reply appends human agent reply', async () => {
      // First, create a conversation via Public Partner endpoint to reply to
      const partnerPost = await apiCall('/x/v1/support/conversations/messages', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          subject: 'Need help with order refund',
          content: 'Hello, my item arrived broken.',
        },
      });
      expect(partnerPost.status).toBe(200);
      createdConvId = (partnerPost.body as { conversation: { id: string } }).conversation.id;

      // Console agent lists conversations
      const listRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/conversations`, {
        token: editorToken,
      });
      expect(listRes.status).toBe(200);
      const convList = (listRes.body as { conversations: any[] }).conversations;
      expect(convList.some((c) => c.id === createdConvId)).toBe(true);

      // Console agent replies
      const replyRes = await apiCall(
        `/api/x-gateway/support/tenants/${tenant.id}/conversations/${createdConvId}/reply`,
        {
          method: 'POST',
          token: editorToken,
          body: {
            agentName: 'Support Agent Dave',
            content: 'We apologize! A replacement has been dispatched.',
            resolveConversation: true,
          },
        },
      );
      expect(replyRes.status).toBe(200);
      const updatedConv = (replyRes.body as { conversation: any }).conversation;
      expect(updatedConv.status).toBe('resolved');
      expect(updatedConv.assignedAgent).toBe('Support Agent Dave');
      const lastMsg = updatedConv.messages[updatedConv.messages.length - 1];
      expect(lastMsg.senderType).toBe('human_agent');
      expect(lastMsg.content).toContain('replacement has been dispatched');
    });

    it('9. GET /tenants/:id/tickets & PATCH .../tickets/:id updates ticket status', async () => {
      // Escalate a ticket via Partner endpoint
      const escRes = await apiCall('/x/v1/support/escalate', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          conversationId: createdConvId,
          subject: 'Broken shipment claim',
          reason: 'Customer reported broken packaging on delivery',
          priority: 'high',
        },
      });
      expect(escRes.status).toBe(201);
      createdTicketId = (escRes.body as { ticket: { id: string } }).ticket.id;

      // Console lists tickets
      const tktListRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/tickets`, {
        token: editorToken,
      });
      expect(tktListRes.status).toBe(200);
      const tickets = (tktListRes.body as { tickets: any[] }).tickets;
      expect(tickets.some((t) => t.id === createdTicketId)).toBe(true);

      // Console updates ticket
      const patchRes = await apiCall(
        `/api/x-gateway/support/tenants/${tenant.id}/tickets/${createdTicketId}`,
        {
          method: 'PATCH',
          token: editorToken,
          body: {
            status: 'in_progress',
            assignedTo: 'Lead Agent Dave',
            resolutionNotes: 'Investigation opened with carrier',
          },
        },
      );
      expect(patchRes.status).toBe(200);
      const patchedTkt = (patchRes.body as { ticket: any }).ticket;
      expect(patchedTkt.status).toBe('in_progress');
      expect(patchedTkt.assignedTo).toBe('Lead Agent Dave');
    });

    it('10. GET /tenants/:id/actions, POST .../approve and POST .../reject review actions', async () => {
      // Propose action 1 via partner API
      const act1Res = await apiCall('/x/v1/support/actions/propose', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          toolName: 'process_refund',
          actionSummary: 'Refund order #1001 for 25 USD',
          payload: { orderId: 1001, amount: 25 },
        },
      });
      expect(act1Res.status).toBe(201);
      createdActionId = (act1Res.body as { action: { id: string } }).action.id;

      // Propose action 2 to reject
      const act2Res = await apiCall('/x/v1/support/actions/propose', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          toolName: 'cancel_account',
          actionSummary: 'Cancel subscription immediately',
        },
      });
      const rejectActionId = (act2Res.body as { action: { id: string } }).action.id;

      // Console lists actions
      const actionsRes = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/actions`, {
        token: editorToken,
      });
      expect(actionsRes.status).toBe(200);
      const actions = (actionsRes.body as { actions: any[] }).actions;
      expect(actions.some((a) => a.id === createdActionId)).toBe(true);

      // Approve action 1
      const appRes = await apiCall(
        `/api/x-gateway/support/tenants/${tenant.id}/actions/${createdActionId}/approve`,
        {
          method: 'POST',
          token: editorToken,
          body: { reviewedBy: 'Manager Dave', reviewNote: 'Approved under $50 goodwill policy' },
        },
      );
      expect(appRes.status).toBe(200);
      const approvedAction = (appRes.body as { action: any }).action;
      expect(approvedAction.status).toBe('approved');
      expect(approvedAction.reviewedBy).toBe('Manager Dave');
      expect(approvedAction.executionResult).toBeDefined();

      // Reject action 2
      const rejRes = await apiCall(
        `/api/x-gateway/support/tenants/${tenant.id}/actions/${rejectActionId}/reject`,
        {
          method: 'POST',
          token: editorToken,
          body: { reviewedBy: 'Manager Dave', reviewNote: 'Cannot cancel active contract' },
        },
      );
      expect(rejRes.status).toBe(200);
      const rejectedAction = (rejRes.body as { action: any }).action;
      expect(rejectedAction.status).toBe('rejected');
      expect(rejectedAction.reviewedBy).toBe('Manager Dave');
    });

    it('11. GET /tenants/:id/analytics returns deflection rate and SLA metrics', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${tenant.id}/analytics`, {
        token: editorToken,
      });
      expect(res.status).toBe(200);
      const data = res.body as { ok: boolean; analytics: any };
      expect(data.ok).toBe(true);
      expect(data.analytics.totalConversations).toBeGreaterThan(0);
      expect(data.analytics.deflectionRatePct).toBeGreaterThanOrEqual(0);
      expect(data.analytics.deflectionRatePct).toBeLessThanOrEqual(100);
      expect(data.analytics.totalTickets).toBeGreaterThanOrEqual(1);
      expect(data.analytics.approvedActions).toBeGreaterThanOrEqual(1);
      expect(data.analytics.rejectedActions).toBeGreaterThanOrEqual(1);
      expect(data.analytics.byRole.customer).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Public Partner API Endpoints (/x/v1/support/*)
  // -------------------------------------------------------------------------
  describe('Public Partner API (/x/v1/support/*)', () => {
    let aliceConvId: string;

    it('12. Rejects partner requests with 401 on missing or invalid tenant/user tokens', async () => {
      // Missing tenant key
      const noTenant = await apiCall('/x/v1/support/knowledge/query', {
        method: 'POST',
        headers: { 'X-Support-User-Token': customerAToken },
        body: { query: 'shipping' },
      });
      expect(noTenant.status).toBe(401);

      // Invalid tenant key
      const badTenant = await apiCall('/x/v1/support/knowledge/query', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': 'pk_sup_invalid_nonexistent',
          'X-Support-User-Token': customerAToken,
        },
        body: { query: 'shipping' },
      });
      expect(badTenant.status).toBe(401);

      // Missing user token
      const noUser = await apiCall('/x/v1/support/knowledge/query', {
        method: 'POST',
        headers: { 'X-Support-Tenant-Key': tenant.publicKey },
        body: { query: 'shipping' },
      });
      expect(noUser.status).toBe(401);

      // Invalid user token
      const badUser = await apiCall('/x/v1/support/knowledge/query', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': 'sup_ctx_invalid.bad_signature',
        },
        body: { query: 'shipping' },
      });
      expect(badUser.status).toBe(401);
    });

    it('13. POST /knowledge/query returns role-filtered & PII-masked results with audit logging', async () => {
      const res = await apiCall('/x/v1/support/knowledge/query', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          query: 'shipping delivery tracking',
        },
      });
      expect(res.status).toBe(200);
      const data = res.body as { ok: boolean; role: string; matches: any[]; redactionCount: number };
      expect(data.ok).toBe(true);
      expect(data.role).toBe('customer');
      expect(data.matches.length).toBeGreaterThan(0);
      expect(data.matches[0].title).toBe('Public Shipping & Delivery FAQ');
    });

    it('14. POST /conversations/messages creates customer message locked to authenticated user', async () => {
      const res = await apiCall('/x/v1/support/conversations/messages', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          subject: 'Alice Private Conversation',
          content: 'I need to check status of my confidential order #999.',
        },
      });
      expect(res.status).toBe(200);
      const data = res.body as { ok: boolean; conversation: any };
      expect(data.ok).toBe(true);
      expect(data.conversation.userId).toBe('cust_alice');
      expect(data.conversation.userName).toBe('Alice Customer');
      expect(data.conversation.messages[0].content).toContain('#999');
      aliceConvId = data.conversation.id;
    });

    it('15. GET /conversations/:id enforces cross-customer 403 isolation (Customer B cannot read Customer A)', async () => {
      // Alice can read her own conversation
      const aliceRead = await apiCall(`/x/v1/support/conversations/${aliceConvId}`, {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
      });
      expect(aliceRead.status).toBe(200);
      expect((aliceRead.body as any).conversation.id).toBe(aliceConvId);

      // Bob (different customer) tries to read Alice's conversation -> 403 Forbidden!
      const bobRead = await apiCall(`/x/v1/support/conversations/${aliceConvId}`, {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerBToken,
        },
      });
      expect(bobRead.status).toBe(403);
      expect((bobRead.body as any).error.message).toContain('Forbidden');

      // Staff member CAN read Alice's conversation for support purposes
      const staffRead = await apiCall(`/x/v1/support/conversations/${aliceConvId}`, {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': staffToken,
        },
      });
      expect(staffRead.status).toBe(200);
    });

    it('16. GET /conversations lists only conversations belonging to authenticated customer', async () => {
      // Create conversation for Bob
      await apiCall('/x/v1/support/conversations/messages', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerBToken,
        },
        body: {
          subject: 'Bob Private Conversation',
          content: 'Hello from Bob',
        },
      });

      // Alice lists conversations -> only Alice's conversations appear
      const aliceList = await apiCall('/x/v1/support/conversations', {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
      });
      expect(aliceList.status).toBe(200);
      const aliceConvs = (aliceList.body as { conversations: any[] }).conversations;
      expect(aliceConvs.every((c) => c.userId === 'cust_alice')).toBe(true);

      // Staff lists conversations -> all conversations appear
      const staffList = await apiCall('/x/v1/support/conversations', {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': staffToken,
        },
      });
      expect(staffList.status).toBe(200);
      const staffConvs = (staffList.body as { conversations: any[] }).conversations;
      const userIds = staffConvs.map((c) => c.userId);
      expect(userIds).toContain('cust_alice');
      expect(userIds).toContain('cust_bob');
    });

    it('17. POST /escalate creates escalation ticket locked to userContext', async () => {
      const res = await apiCall('/x/v1/support/escalate', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerAToken,
        },
        body: {
          conversationId: aliceConvId,
          subject: 'Warranty Claim Escalation',
          reason: 'Customer requested supervisor review',
          priority: 'urgent',
        },
      });
      expect(res.status).toBe(201);
      const data = res.body as { ok: boolean; ticket: any };
      expect(data.ok).toBe(true);
      expect(data.ticket.userId).toBe('cust_alice');
      expect(data.ticket.priority).toBe('urgent');
      expect(data.ticket.status).toBe('open');
    });

    it('18. POST /actions/propose & GET /actions creates and lists customer-scoped pending actions', async () => {
      const proposeRes = await apiCall('/x/v1/support/actions/propose', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerBToken,
        },
        body: {
          toolName: 'extend_warranty',
          actionSummary: 'Extend warranty by 1 year for Bob',
          payload: { months: 12 },
        },
      });
      expect(proposeRes.status).toBe(201);
      const action = (proposeRes.body as { action: any }).action;
      expect(action.userId).toBe('cust_bob');
      expect(action.status).toBe('pending');

      // Bob lists actions -> sees his action
      const bobActions = await apiCall('/x/v1/support/actions', {
        headers: {
          'X-Support-Tenant-Key': tenant.publicKey,
          'X-Support-User-Token': customerBToken,
        },
      });
      expect(bobActions.status).toBe(200);
      const list = (bobActions.body as { actions: any[] }).actions;
      expect(list.every((a) => a.userId === 'cust_bob')).toBe(true);
    });
  });
});
