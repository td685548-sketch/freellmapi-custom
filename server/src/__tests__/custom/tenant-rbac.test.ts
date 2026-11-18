import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { initDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { DEFAULT_MIGRATIONS } from '../../db/migrate/defaults.js';
import { createSession, createUser } from '../../services/auth.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import {
  createOrAppendSupportConversation,
  createSupportEscalationTicket,
} from '../../custom/x-gateway/support-workflows.js';
import { TENANT_ROLE_PRESETS } from '@freellmapi/shared/tenant-rbac.js';

let server: Server;
let base: string;

let primaryAdminId: number;
let primaryToken: string;

let ownerUserId: number;
let ownerToken: string;

let configuratorUserId: number;
let configuratorToken: string;

let operatorUserId: number;
let operatorToken: string;

let viewerUserId: number;
let viewerToken: string;

let delegatedSubAdminId: number;
let delegatedSubAdminToken: string;

let narrowTargetUserId: number;
let narrowTargetToken: string;

let unassignedUserToken: string;

let tenantAId: number;
let tenantBId: number;
let tenantAConvId: string;
let tenantATicketId: string;

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

describe('Tenant Admin Portal & Granular Multi-Tenant RBAC', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    const primary = createUser('primary-owner@example.com', 'OwnerPass123!');
    primaryAdminId = primary.userId;
    primaryToken = createSession(primaryAdminId);

    const owner = createUser('tenant-a-owner@example.com', 'UserPass123!', 'member');
    ownerUserId = owner.userId;
    ownerToken = createSession(ownerUserId);

    const configurator = createUser('tenant-a-config@example.com', 'UserPass123!', 'member');
    configuratorUserId = configurator.userId;
    configuratorToken = createSession(configuratorUserId);

    const operator = createUser('tenant-a-ops@example.com', 'UserPass123!', 'member');
    operatorUserId = operator.userId;
    operatorToken = createSession(operatorUserId);

    const viewer = createUser('tenant-a-viewer@example.com', 'UserPass123!', 'member');
    viewerUserId = viewer.userId;
    viewerToken = createSession(viewerUserId);

    const delegated = createUser('tenant-a-subadmin@example.com', 'UserPass123!', 'member');
    delegatedSubAdminId = delegated.userId;
    delegatedSubAdminToken = createSession(delegatedSubAdminId);

    const narrow = createUser('tenant-a-narrow@example.com', 'UserPass123!', 'member');
    narrowTargetUserId = narrow.userId;
    narrowTargetToken = createSession(narrowTargetUserId);

    const unassigned = createUser('outsider@example.com', 'UserPass123!', 'member');
    unassignedUserToken = createSession(unassigned.userId);

    tenantAId = createSupportTenant({
      name: 'Acme Support',
      slug: 'acme-support',
      defaultModel: 'auto',
      systemPrompt: 'You help Acme customers.',
      createdBy: primaryAdminId,
    }).tenant.id;

    tenantBId = createSupportTenant({
      name: 'Beta Support',
      slug: 'beta-support',
      defaultModel: 'auto',
      systemPrompt: 'You help Beta customers.',
      createdBy: primaryAdminId,
    }).tenant.id;

    const conv = createOrAppendSupportConversation(String(tenantAId), {
      userId: 'cust-1',
      userName: 'Alice',
      userRole: 'customer',
      subject: 'Order delay',
      message: {
        senderType: 'customer',
        senderId: 'cust-1',
        senderName: 'Alice',
        senderRole: 'customer',
        content: 'Where is my package?',
      },
    });
    tenantAConvId = conv.id;

    const ticket = createSupportEscalationTicket(String(tenantAId), {
      conversationId: conv.id,
      userId: 'cust-1',
      userName: 'Alice',
      userRole: 'customer',
      subject: 'Order delay escalation',
      reason: 'Customer requested human agent',
      priority: 'high',
    });
    tenantATicketId = ticket.id;
  });

  afterAll(() => {
    server?.close();
  });

  it('registers the custom tenant RBAC migration in DEFAULT_MIGRATIONS', () => {
    const entry = DEFAULT_MIGRATIONS.find(
      (m) => m.filename === '20261118_043000_custom_tenant_rbac.ts',
    );
    expect(entry).toBeDefined();
    expect(typeof entry?.module.up).toBe('function');
    expect(typeof entry?.module.down).toBe('function');
  });

  it('allows Platform Admin to assign and read tenant memberships while rejecting regular members', async () => {
    const memberDenied = await hit(
      `/api/admin/tenant-memberships/users/${ownerUserId}`,
      'GET',
      undefined,
      unassignedUserToken,
    );
    expect(memberDenied.status).toBe(403);

    const assignments: Array<[number, string, readonly string[]]> = [
      [ownerUserId, 'tenant_owner', TENANT_ROLE_PRESETS.tenant_owner],
      [configuratorUserId, 'ai_configurator', TENANT_ROLE_PRESETS.ai_configurator],
      [operatorUserId, 'support_operator', TENANT_ROLE_PRESETS.support_operator],
      [viewerUserId, 'viewer', TENANT_ROLE_PRESETS.viewer],
      [delegatedSubAdminId, 'custom', ['tenant_ai_config', 'tenant_members']],
    ];

    for (const [uid, preset, perms] of assignments) {
      const res = await hit(
        `/api/admin/tenant-memberships/tenants/${tenantAId}/users/${uid}`,
        'PUT',
        { rolePreset: preset, permissions: perms },
        primaryToken,
      );
      expect(res.status, `assign ${preset}`).toBe(200);
      expect(res.body?.member?.userId).toBe(uid);
    }

    // Cannot modify Primary Admin or self membership
    const primaryProtected = await hit(
      `/api/admin/tenant-memberships/tenants/${tenantAId}/users/${primaryAdminId}`,
      'PUT',
      { rolePreset: 'viewer', permissions: ['view_tenant_ai'] },
      ownerToken,
    );
    expect(primaryProtected.status).toBe(403);

    const fetched = await hit(
      `/api/admin/tenant-memberships/users/${ownerUserId}`,
      'GET',
      undefined,
      primaryToken,
    );
    expect(fetched.status).toBe(200);
    expect(fetched.body?.memberships).toHaveLength(1);
    expect(fetched.body?.memberships[0].tenantId).toBe(tenantAId);
  });

  it('reports accurate tenantPortalAccess in /api/user/session', async () => {
    const primarySession = await hit('/api/user/session', 'GET', undefined, primaryToken);
    expect(primarySession.status).toBe(200);
    expect(primarySession.body?.tenantPortalAccess).toEqual({
      tenantCount: 2,
      isPlatformOperator: true,
    });

    const ownerSession = await hit('/api/user/session', 'GET', undefined, ownerToken);
    expect(ownerSession.status).toBe(200);
    expect(ownerSession.body?.tenantPortalAccess).toEqual({
      tenantCount: 1,
      isPlatformOperator: false,
    });

    const outsiderSession = await hit('/api/user/session', 'GET', undefined, unassignedUserToken);
    expect(outsiderSession.status).toBe(200);
    expect(outsiderSession.body?.tenantPortalAccess).toEqual({
      tenantCount: 0,
      isPlatformOperator: false,
    });
  });

  it('enforces strict cross-tenant isolation and hides secrets', async () => {
    const ownerList = await hit('/api/tenant-portal/tenants', 'GET', undefined, ownerToken);
    expect(ownerList.status).toBe(200);
    expect(ownerList.body?.tenants).toHaveLength(1);
    expect(ownerList.body?.tenants[0].id).toBe(tenantAId);
    expect(JSON.stringify(ownerList.body)).not.toContain('sk_sup_');

    // Tenant A owner accessing Tenant B fails closed with 404 (prevents enumeration)
    const crossReads = [
      `/api/tenant-portal/tenants/${tenantBId}`,
      `/api/tenant-portal/tenants/${tenantBId}/knowledge`,
      `/api/tenant-portal/tenants/${tenantBId}/tools`,
      `/api/tenant-portal/tenants/${tenantBId}/guardrails`,
      `/api/tenant-portal/tenants/${tenantBId}/desk`,
      `/api/tenant-portal/tenants/${tenantBId}/integration`,
      `/api/tenant-portal/tenants/${tenantBId}/members`,
      `/api/tenant-portal/tenants/${tenantBId}/analytics`,
    ];
    for (const url of crossReads) {
      const res = await hit(url, 'GET', undefined, ownerToken);
      expect(res.status, `${url} cross-tenant GET must 404`).toBe(404);
      expect(res.body?.error?.code).toBe('tenant_not_found');
    }

    const crossWrite = await hit(
      `/api/tenant-portal/tenants/${tenantBId}`,
      'PATCH',
      { systemPrompt: 'Hacked' },
      ownerToken,
    );
    expect(crossWrite.status).toBe(404);

    // Unassigned user sees 0 tenants and gets 404 on Tenant A
    const outsiderList = await hit('/api/tenant-portal/tenants', 'GET', undefined, unassignedUserToken);
    expect(outsiderList.status).toBe(200);
    expect(outsiderList.body?.tenants).toEqual([]);
    const outsiderHit = await hit(`/api/tenant-portal/tenants/${tenantAId}`, 'GET', undefined, unassignedUserToken);
    expect(outsiderHit.status).toBe(404);
  });

  it('enforces read-only permissions for Viewer role across all sections', async () => {
    const reads = [
      `/api/tenant-portal/tenants/${tenantAId}`,
      `/api/tenant-portal/tenants/${tenantAId}/knowledge`,
      `/api/tenant-portal/tenants/${tenantAId}/tools`,
      `/api/tenant-portal/tenants/${tenantAId}/guardrails`,
      `/api/tenant-portal/tenants/${tenantAId}/desk`,
      `/api/tenant-portal/tenants/${tenantAId}/integration`,
      `/api/tenant-portal/tenants/${tenantAId}/members`,
      `/api/tenant-portal/tenants/${tenantAId}/analytics`,
    ];
    for (const url of reads) {
      const res = await hit(url, 'GET', undefined, viewerToken);
      expect(res.status, `viewer GET ${url}`).toBe(200);
    }

    const forbiddenWrites: Array<[string, 'POST' | 'PUT' | 'PATCH', unknown, string]> = [
      [`/api/tenant-portal/tenants/${tenantAId}`, 'PATCH', { systemPrompt: 'x' }, 'edit_tenant_ai'],
      [`/api/tenant-portal/tenants/${tenantAId}/knowledge`, 'POST', { title: 't', content: 'c' }, 'edit_tenant_knowledge'],
      [`/api/tenant-portal/tenants/${tenantAId}/tools`, 'POST', { name: 't', endpointUrl: 'https://example.com' }, 'edit_tenant_tools'],
      [`/api/tenant-portal/tenants/${tenantAId}/guardrails`, 'PUT', { enabled: false }, 'edit_tenant_guardrails'],
      [
        `/api/tenant-portal/tenants/${tenantAId}/output-policy`,
        'PUT',
        { expectedVersion: 0, policy: { mode: 'enforce', blockedTerms: [], maxOutputChars: 4000, redactCredentials: true } },
        'edit_tenant_guardrails',
      ],
      [`/api/tenant-portal/tenants/${tenantAId}/conversations/${tenantAConvId}/reply`, 'POST', { content: 'hi' }, 'reply_tenant_desk'],
      [`/api/tenant-portal/tenants/${tenantAId}/widget-config`, 'PUT', { expectedVersion: 1, enabled: true }, 'edit_tenant_widget'],
      [`/api/tenant-portal/tenants/${tenantAId}/integration`, 'PUT', { allowedOrigins: ['https://a.com'] }, 'edit_tenant_integration'],
      [`/api/tenant-portal/tenants/${tenantAId}/rotate-secret`, 'POST', {}, 'rotate_tenant_secret'],
      [`/api/tenant-portal/tenants/${tenantAId}/mint-token`, 'POST', { userId: 'u1', role: 'customer' }, 'test_tenant_ai'],
      [`/api/tenant-portal/tenants/${tenantAId}/members`, 'POST', { email: 'outsider@example.com', permissions: ['view_tenant_ai'] }, 'manage_tenant_members'],
    ];

    for (const [url, method, body, perm] of forbiddenWrites) {
      const res = await hit(url, method, body, viewerToken);
      expect(res.status, `viewer ${method} ${url}`).toBe(403);
      expect(res.body?.error?.code).toBe('forbidden');
      expect(res.body?.error?.message).toContain(perm);
    }
  });

  it('allows AI Configurator to tune AI/Knowledge/Guardrails/Widget while blocking secrets & members', async () => {
    const patchAi = await hit(
      `/api/tenant-portal/tenants/${tenantAId}`,
      'PATCH',
      {
        defaultModel: 'auto',
        systemPrompt: 'Be concise, accurate, and friendly.',
        allowGuest: false,
      },
      configuratorToken,
    );
    expect(patchAi.status).toBe(200);
    expect(patchAi.body?.tenant?.systemPrompt).toBe('Be concise, accurate, and friendly.');
    expect(patchAi.body?.tenant?.allowGuest).toBe(false);

    // Rejects allowedOrigins smuggling through PATCH /tenants/:id
    const sneakOrigins = await hit(
      `/api/tenant-portal/tenants/${tenantAId}`,
      'PATCH',
      { allowedOrigins: ['https://evil.example'] },
      configuratorToken,
    );
    expect(sneakOrigins.status).toBe(400);

    const addDoc = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/knowledge`,
      'POST',
      { title: 'Warranty Policy', content: '24-month hardware warranty.', allowedRoles: ['customer'] },
      configuratorToken,
    );
    expect(addDoc.status).toBe(201);

    const saveOutput = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/output-policy`,
      'PUT',
      {
        expectedVersion: 0,
        policy: {
          mode: 'enforce',
          blockedTerms: [{ id: 'rule_1', text: 'internal-only' }],
          maxOutputChars: 8000,
          redactCredentials: true,
        },
      },
      configuratorToken,
    );
    expect(saveOutput.status).toBe(200);
    expect(saveOutput.body?.policy?.version).toBe(1);

    const saveWidget = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/widget-config`,
      'PUT',
      { expectedVersion: 1, enabled: true },
      configuratorToken,
    );
    expect(saveWidget.status).toBe(200);
    expect(saveWidget.body?.config?.enabled).toBe(true);

    // Blocked from secret rotation and member management
    const rotateDenied = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/rotate-secret`,
      'POST',
      {},
      configuratorToken,
    );
    expect(rotateDenied.status).toBe(403);

    const memberDenied = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members`,
      'POST',
      { email: 'outsider@example.com', permissions: ['view_tenant_ai'] },
      configuratorToken,
    );
    expect(memberDenied.status).toBe(403);
  });

  it('allows Support Operator to operate service desk while blocking AI config & tools edits', async () => {
    const mint = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/mint-token`,
      'POST',
      { userId: 'cust-1', role: 'customer' },
      operatorToken,
    );
    expect(mint.status).toBe(200);
    expect(mint.body?.token).toMatch(/^sup_ctx_/);

    // Without a real LLM provider configured, runtime turns reject fallback with 503 model_unavailable (not 403)
    const sim = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/simulate-chat`,
      'POST',
      { role: 'customer', userId: 'cust-1', messages: [{ role: 'user', content: 'Hello!' }] },
      operatorToken,
    );
    expect(sim.status).toBe(503);
    expect(sim.body?.error?.code).toMatch(/generation_failed|model_unavailable/);

    const desk = await hit(`/api/tenant-portal/tenants/${tenantAId}/desk`, 'GET', undefined, operatorToken);
    expect(desk.status).toBe(200);
    expect(desk.body?.conversations?.length).toBeGreaterThanOrEqual(1);

    const reply = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/conversations/${tenantAConvId}/reply`,
      'POST',
      { content: 'Checking your order now!', resolveConversation: false },
      operatorToken,
    );
    expect(reply.status).toBe(200);

    const updateTicket = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/tickets/${tenantATicketId}`,
      'PATCH',
      { status: 'in_progress' },
      operatorToken,
    );
    expect(updateTicket.status).toBe(200);
    expect(updateTicket.body?.ticket?.status).toBe('in_progress');

    const aiEditDenied = await hit(
      `/api/tenant-portal/tenants/${tenantAId}`,
      'PATCH',
      { systemPrompt: 'Override' },
      operatorToken,
    );
    expect(aiEditDenied.status).toBe(403);
  });

  it('allows Tenant Owner to rotate signing secret and configure CORS integration', async () => {
    const integrationPut = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/integration`,
      'PUT',
      { allowedOrigins: ['https://app.acme.example'] },
      ownerToken,
    );
    expect(integrationPut.status).toBe(200);
    expect(integrationPut.body?.allowedOrigins).toEqual(['https://app.acme.example']);

    const rotated = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/rotate-secret`,
      'POST',
      {},
      ownerToken,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body?.signingSecret).toMatch(/^sk_sup_/);
  });

  it('enforces anti-escalation rules for delegated tenant admins (manage_tenant_members)', async () => {
    // Delegated sub-admin holds ['tenant_ai_config', 'tenant_members'] -> CAN grant ['view_tenant_ai', 'edit_tenant_ai']
    const addNarrow = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members`,
      'POST',
      { email: 'tenant-a-narrow@example.com', permissions: ['view_tenant_ai', 'edit_tenant_ai'] },
      delegatedSubAdminToken,
    );
    expect(addNarrow.status).toBe(201);
    expect(addNarrow.body?.member?.userId).toBe(narrowTargetUserId);

    // Newly delegated user can immediately read Tenant A AI config
    const narrowRead = await hit(
      `/api/tenant-portal/tenants/${tenantAId}`,
      'GET',
      undefined,
      narrowTargetToken,
    );
    expect(narrowRead.status).toBe(200);

    // Delegated sub-admin CANNOT escalate anyone to '*' or rotate_tenant_secret
    const escalateWildcard = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members`,
      'POST',
      { email: 'outsider@example.com', permissions: ['*'] },
      delegatedSubAdminToken,
    );
    expect(escalateWildcard.status).toBe(403);
    expect(escalateWildcard.body?.error?.code).toBe('insufficient_privileges');

    const escalateSecret = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${narrowTargetUserId}`,
      'PUT',
      { permissions: ['view_tenant_ai', 'rotate_tenant_secret'] },
      delegatedSubAdminToken,
    );
    expect(escalateSecret.status).toBe(403);
    expect(escalateSecret.body?.error?.code).toBe('insufficient_privileges');

    // Delegated sub-admin CANNOT modify or remove Tenant Owner (broader authority)
    const alterOwner = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${ownerUserId}`,
      'PUT',
      { permissions: ['view_tenant_ai'] },
      delegatedSubAdminToken,
    );
    expect(alterOwner.status).toBe(403);
    expect(alterOwner.body?.error?.code).toBe('insufficient_privileges');

    const removeOwner = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${ownerUserId}`,
      'DELETE',
      undefined,
      delegatedSubAdminToken,
    );
    expect(removeOwner.status).toBe(403);
    expect(removeOwner.body?.error?.code).toBe('insufficient_privileges');

    // Self-modification and self-removal are forbidden (409)
    const selfUpdate = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${delegatedSubAdminId}`,
      'PUT',
      { permissions: ['view_tenant_ai'] },
      delegatedSubAdminToken,
    );
    expect(selfUpdate.status).toBe(409);
    expect(selfUpdate.body?.error?.code).toBe('self_membership_change');

    const selfDelete = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${delegatedSubAdminId}`,
      'DELETE',
      undefined,
      delegatedSubAdminToken,
    );
    expect(selfDelete.status).toBe(409);

    // Primary Admin is protected even if targeted
    const touchPrimary = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members`,
      'POST',
      { email: 'primary-owner@example.com', permissions: ['view_tenant_ai'] },
      ownerToken,
    );
    expect(touchPrimary.status).toBe(403);
    expect(touchPrimary.body?.error?.code).toBe('primary_admin_protected');

    // Delegated sub-admin CAN remove the narrower sub-member it granted
    const removeNarrow = await hit(
      `/api/tenant-portal/tenants/${tenantAId}/members/${narrowTargetUserId}`,
      'DELETE',
      undefined,
      delegatedSubAdminToken,
    );
    expect(removeNarrow.status).toBe(200);
  });
});
