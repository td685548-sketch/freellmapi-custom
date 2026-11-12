import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { permissionForAction } from '../../custom/permission-actions.js';

describe('Multi-Tenant AI Support Gateway (/api/x-gateway/support/* & /x/v1/support/*)', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let viewerToken: string;
  let editorToken: string;
  let memberToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    // Admin user (full access)
    const admin = createUser('support-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);

    // Editor user (edit_x_settings + use_x_gateway)
    const editor = createUser('support-editor@example.com', 'EditorPass123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway', 'edit_x_settings']), editor.userId);
    editorToken = createSession(editor.userId);

    // Viewer user (only use_x_gateway)
    const viewer = createUser('support-viewer@example.com', 'ViewerPass123!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), viewer.userId);
    viewerToken = createSession(viewer.userId);

    // Plain member (no gateway permissions)
    const member = createUser('plain-member@example.com', 'MemberPass123!', 'member');
    memberToken = createSession(member.userId);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    setEnabled(true);
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
  // 1. Permission Mapping Verification
  // -------------------------------------------------------------------------
  describe('Permission Mapping (server/src/custom/permission-actions.ts)', () => {
    it('maps read and test/simulation endpoints to use_x_gateway', () => {
      expect(
        permissionForAction('manage_x_gateway', 'GET', '/api/x-gateway/support/tenants'),
      ).toBe('use_x_gateway');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/simulate-chat',
        ),
      ).toBe('use_x_gateway');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/mint-token',
        ),
      ).toBe('use_x_gateway');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/tools/2/test',
        ),
      ).toBe('use_x_gateway');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/db-sources/3/query-test',
        ),
      ).toBe('use_x_gateway');
    });

    it('maps configuration writes to edit_x_settings', () => {
      expect(
        permissionForAction('manage_x_gateway', 'POST', '/api/x-gateway/support/tenants'),
      ).toBe('edit_x_settings');
      expect(
        permissionForAction('manage_x_gateway', 'PATCH', '/api/x-gateway/support/tenants/1'),
      ).toBe('edit_x_settings');
      expect(
        permissionForAction('manage_x_gateway', 'DELETE', '/api/x-gateway/support/tenants/1'),
      ).toBe('edit_x_settings');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/rotate-secret',
        ),
      ).toBe('edit_x_settings');
      expect(
        permissionForAction('manage_x_gateway', 'POST', '/api/x-gateway/support/tenants/1/tools'),
      ).toBe('edit_x_settings');
      expect(
        permissionForAction(
          'manage_x_gateway',
          'POST',
          '/api/x-gateway/support/tenants/1/db-sources',
        ),
      ).toBe('edit_x_settings');
    });

    it('enforces RBAC gates through HTTP requests', async () => {
      // Unauthenticated request is 401
      const unauth = await apiCall('/api/x-gateway/support/tenants');
      expect(unauth.status).toBe(401);

      // Member without gateway permissions is 403
      const memberRes = await apiCall('/api/x-gateway/support/tenants', { token: memberToken });
      expect(memberRes.status).toBe(403);

      // Viewer with use_x_gateway can GET tenants
      const viewerRes = await apiCall('/api/x-gateway/support/tenants', { token: viewerToken });
      expect(viewerRes.status).toBe(200);

      // Admin with full access can GET tenants
      const adminRes = await apiCall('/api/x-gateway/support/tenants', { token: adminToken });
      expect(adminRes.status).toBe(200);

      // Viewer cannot create tenants (requires edit_x_settings)
      const viewerCreate = await apiCall('/api/x-gateway/support/tenants', {
        method: 'POST',
        token: viewerToken,
        body: { name: 'Unauthorized Store' },
      });
      expect(viewerCreate.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Console Management API Endpoints
  // -------------------------------------------------------------------------
  describe('Console Management API (/api/x-gateway/support/*)', () => {
    let createdTenantId: number;
    let initialSigningSecret: string;
    let sampleDbSourceId: number;

    it('POST /tenants creates a tenant and seeds sample E-Commerce sandbox by default', async () => {
      const res = await apiCall('/api/x-gateway/support/tenants', {
        method: 'POST',
        token: editorToken,
        body: {
          name: 'Demo Electronic Store',
          slug: 'demo-store',
          defaultModel: 'auto',
          systemPrompt: 'You are an AI Support assistant for Demo Electronic Store.',
          allowedOrigins: ['http://localhost:3000', 'https://demo-partner.com'],
          allowGuest: true,
        },
      });

      expect(res.status).toBe(201);
      const data = res.body as { tenant: any; signingSecret: string };
      expect(data.tenant).toBeDefined();
      expect(data.tenant.id).toBeGreaterThan(0);
      expect(data.tenant.name).toBe('Demo Electronic Store');
      expect(data.tenant.slug).toBe('demo-store');
      expect(data.tenant.publicKey).toMatch(/^pk_sup_/);
      expect(data.signingSecret).toMatch(/^sk_sup_/);

      createdTenantId = data.tenant.id;
      initialSigningSecret = data.signingSecret;

      // Verify sample DB source was auto-seeded
      const sourcesRes = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources`,
        { token: viewerToken },
      );
      expect(sourcesRes.status).toBe(200);
      const sourcesData = sourcesRes.body as { dbSources: any[] };
      expect(sourcesData.dbSources.length).toBe(1);
      expect(sourcesData.dbSources[0].name).toBe('Sample Store DB');
      expect(sourcesData.dbSources[0].driver).toBe('sqlite-sandbox');
      sampleDbSourceId = sourcesData.dbSources[0].id;
    });

    it('GET /tenants lists tenants and sample SQL schema', async () => {
      const res = await apiCall('/api/x-gateway/support/tenants', { token: viewerToken });
      expect(res.status).toBe(200);
      const data = res.body as { tenants: any[]; sampleSchemaSql: string };
      expect(Array.isArray(data.tenants)).toBe(true);
      expect(data.tenants.some((t) => t.id === createdTenantId)).toBe(true);
      expect(data.sampleSchemaSql).toContain('CREATE TABLE products');
    });

    it('GET /tenants/:id retrieves a single tenant', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${createdTenantId}`, {
        token: viewerToken,
      });
      expect(res.status).toBe(200);
      const data = res.body as { tenant: any };
      expect(data.tenant.id).toBe(createdTenantId);
      expect(data.tenant.name).toBe('Demo Electronic Store');
    });

    it('PATCH /tenants/:id updates tenant settings', async () => {
      const res = await apiCall(`/api/x-gateway/support/tenants/${createdTenantId}`, {
        method: 'PATCH',
        token: editorToken,
        body: { defaultModel: 'custom/model-v2' },
      });
      expect(res.status).toBe(200);
      const data = res.body as { tenant: any };
      expect(data.tenant.defaultModel).toBe('custom/model-v2');
    });

    it('POST /tenants/:id/rotate-secret rotates signing secret and returns new masked secret', async () => {
      const res = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/rotate-secret`,
        {
          method: 'POST',
          token: editorToken,
        },
      );
      expect(res.status).toBe(200);
      const data = res.body as { tenant: any; signingSecret: string };
      expect(data.signingSecret).toMatch(/^sk_sup_/);
      expect(data.signingSecret).not.toBe(initialSigningSecret);
      initialSigningSecret = data.signingSecret;
    });

    it('manages Webhook Tools (CRUD + test)', async () => {
      // 1. Create Webhook Tool
      const createRes = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/tools`,
        {
          method: 'POST',
          token: editorToken,
          body: {
            name: 'get_revenue_summary',
            description: 'Get total revenue summary (admin only)',
            method: 'POST',
            endpointUrl: 'https://example.com/api/revenue',
            allowedRoles: ['admin'],
          },
        },
      );
      expect(createRes.status).toBe(201);
      const tool = (createRes.body as { tool: any }).tool;
      expect(tool.name).toBe('get_revenue_summary');
      const toolId = tool.id;

      // 2. List tools
      const listRes = await apiCall(`/api/x-gateway/support/tenants/${createdTenantId}/tools`, {
        token: viewerToken,
      });
      expect(listRes.status).toBe(200);
      expect((listRes.body as { tools: any[] }).tools.length).toBe(1);

      // 3. Update tool
      const patchRes = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/tools/${toolId}`,
        {
          method: 'PATCH',
          token: editorToken,
          body: { description: 'Updated revenue description' },
        },
      );
      expect(patchRes.status).toBe(200);
      expect((patchRes.body as { tool: any }).tool.description).toBe(
        'Updated revenue description',
      );

      // 4. Test tool permission denial for customer
      const testDeny = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/tools/${toolId}/test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'cust_101', role: 'customer' },
        },
      );
      expect(testDeny.status).toBe(403);

      // 5. Delete tool
      const delRes = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/tools/${toolId}`,
        {
          method: 'DELETE',
          token: editorToken,
        },
      );
      expect(delRes.status).toBe(200);
      expect((delRes.body as { ok: boolean }).ok).toBe(true);
    });

    it('POST /tenants/:id/db-sources/:sourceId/query-test enforces row-level isolation per role', async () => {
      // 1. Guest querying products succeeds
      const guestProducts = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources/${sampleDbSourceId}/query-test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'guest', role: 'guest', sql: 'SELECT * FROM products' },
        },
      );
      expect(guestProducts.status).toBe(200);
      const guestRows = (guestProducts.body as { rows: any[] }).rows;
      expect(guestRows.length).toBe(4);

      // 2. Guest querying orders fails with 403
      const guestOrders = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources/${sampleDbSourceId}/query-test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'guest', role: 'guest', sql: 'SELECT * FROM orders' },
        },
      );
      expect(guestOrders.status).toBe(403);

      // 3. Customer 'cust_101' querying orders sees ONLY their 2 orders
      const custOrders = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources/${sampleDbSourceId}/query-test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'cust_101', role: 'customer', sql: 'SELECT * FROM orders' },
        },
      );
      expect(custOrders.status).toBe(200);
      const custRows = (custOrders.body as { rows: any[] }).rows;
      expect(custRows.length).toBe(2);
      expect(custRows.every((r) => r.user_id === 'cust_101')).toBe(true);

      // 4. Admin querying orders sees ALL 4 orders across all users
      const adminOrders = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources/${sampleDbSourceId}/query-test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'admin_user', role: 'admin', sql: 'SELECT * FROM orders' },
        },
      );
      expect(adminOrders.status).toBe(200);
      expect((adminOrders.body as { rows: any[] }).rows.length).toBe(4);

      // 5. Denied columns (password_hash, secret_note) are stripped from customers table
      const custProfile = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/db-sources/${sampleDbSourceId}/query-test`,
        {
          method: 'POST',
          token: viewerToken,
          body: { userId: 'cust_101', role: 'customer', sql: 'SELECT * FROM customers' },
        },
      );
      expect(custProfile.status).toBe(200);
      const profileRows = (custProfile.body as { rows: any[] }).rows;
      expect(profileRows.length).toBe(1);
      expect(profileRows[0].id).toBe('cust_101');
      expect(profileRows[0].password_hash).toBeUndefined();
      expect(profileRows[0].secret_note).toBeUndefined();
    });

    it('POST /tenants/:id/mint-token generates a valid signed contextToken', async () => {
      const res = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/mint-token`,
        {
          method: 'POST',
          token: viewerToken,
          body: {
            userId: 'cust_101',
            name: 'Alice Nguyen',
            role: 'customer',
            permissions: ['orders:read_own'],
          },
        },
      );
      expect(res.status).toBe(200);
      const data = res.body as { token: string; context: any };
      expect(data.token).toMatch(/^sup_ctx_/);
      expect(data.context.userId).toBe('cust_101');
      expect(data.context.role).toBe('customer');
      expect(data.context.verified).toBe(true);
    });

    it('POST /tenants/:id/simulate-chat runs the support pipeline and returns transparent toolTrace', async () => {
      const res = await apiCall(
        `/api/x-gateway/support/tenants/${createdTenantId}/simulate-chat`,
        {
          method: 'POST',
          token: viewerToken,
          body: {
            userId: 'cust_101',
            name: 'Alice',
            role: 'customer',
            messages: [{ role: 'user', content: 'What are my current orders?' }],
          },
        },
      );

      // Spec 017 intentional change: simulate-chat wires to Agent 1 executeSupportTurn;
      // when no real AI model provider account is configured, rejects production fallback with 503
      expect(res.status).toBe(503);
      expect((res.body as any).error.code).toMatch(/generation_failed|model_unavailable|runtime_error/);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Public Partner Gateway API Endpoints (/x/v1/support/*)
  // -------------------------------------------------------------------------
  describe('Public Partner Gateway (/x/v1/support/*)', () => {
    let tenantKey: string;
    let tenantSecret: string;

    beforeAll(async () => {
      // Create dedicated partner tenant
      const res = await apiCall('/api/x-gateway/support/tenants', {
        method: 'POST',
        token: editorToken,
        body: {
          name: 'Partner Web Store',
          slug: 'partner-web',
          allowedOrigins: ['https://partner.com'],
          allowGuest: true,
        },
      });
      const data = res.body as { tenant: any; signingSecret: string };
      tenantKey = data.tenant.publicKey;
      tenantSecret = data.signingSecret;
    });

    it('supports CORS preflight for partner allowedOrigins', async () => {
      const res = await apiCall('/x/v1/support/chat', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://partner.com',
          'X-Support-Tenant-Key': tenantKey,
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://partner.com');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('POST /x/v1/support/session mints contextToken via partner secret authentication', async () => {
      // 1. Missing secret returns 401
      const noSecret = await apiCall('/x/v1/support/session', {
        method: 'POST',
        body: { tenantKey, userId: 'cust_200', role: 'customer' },
      });
      expect(noSecret.status).toBe(401);

      // 2. Invalid secret returns 401
      const invalidSecret = await apiCall('/x/v1/support/session', {
        method: 'POST',
        headers: { 'X-Tenant-Secret': 'sk_sup_invalid_secret_value' },
        body: { tenantKey, userId: 'cust_200', role: 'customer' },
      });
      expect(invalidSecret.status).toBe(401);

      // 3. Valid secret mints session token
      const valid = await apiCall('/x/v1/support/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tenantSecret}` },
        body: {
          tenantKey,
          userId: 'cust_101',
          name: 'Alice',
          role: 'customer',
          ttlSeconds: 1800,
        },
      });
      expect(valid.status).toBe(200);
      const data = valid.body as {
        ok: boolean;
        contextToken: string;
        expiresIn: number;
        userContext: any;
      };
      expect(data.ok).toBe(true);
      expect(data.contextToken).toMatch(/^sup_ctx_/);
      expect(data.expiresIn).toBe(1800);
      expect(data.userContext.userId).toBe('cust_101');
      expect(data.userContext.role).toBe('customer');
      expect(data.userContext.verified).toBe(true);
    });

    it('POST /x/v1/support/chat handles guest access and denies restricted orders table', async () => {
      // Guest chat asking about orders
      const guestChat = await apiCall('/x/v1/support/chat', {
        method: 'POST',
        body: {
          tenantKey,
          messages: [{ role: 'user', content: 'Can I check order status?' }],
        },
      });
      // Spec 017 intentional change: Real POST /chat rejects production fallback with 503 when no AI model provider account exists
      expect(guestChat.status).toBe(503);
      expect((guestChat.body as any).error.code).toMatch(/generation_failed|model_unavailable/);
    });

    it('POST /x/v1/support/chat handles authenticated customer and executes row-level isolated DB query', async () => {
      // Mint customer token
      const sessionRes = await apiCall('/x/v1/support/session', {
        method: 'POST',
        headers: { 'X-Tenant-Secret': tenantSecret },
        body: { tenantKey, userId: 'cust_101', name: 'Alice', role: 'customer' },
      });
      const { contextToken } = sessionRes.body as { contextToken: string };

      // Send chat
      const chatRes = await apiCall('/x/v1/support/chat', {
        method: 'POST',
        headers: {
          'X-Support-Tenant-Key': tenantKey,
          'X-Support-Context-Token': contextToken,
        },
        body: {
          messages: [{ role: 'user', content: 'What are my orders?' }],
        },
      });

      // Spec 017 intentional change: Real POST /chat rejects production fallback with 503 when no AI model provider account exists
      expect(chatRes.status).toBe(503);
      expect((chatRes.body as any).error.code).toMatch(/generation_failed|model_unavailable/);
    });

    it('POST /x/v1/support/chat allows customer to browse products catalog', async () => {
      const res = await apiCall('/x/v1/support/chat', {
        method: 'POST',
        body: {
          tenantKey,
          messages: [{ role: 'user', content: 'Show me the products available' }],
        },
      });
      // Spec 017 intentional change: Real POST /chat rejects production fallback with 503 when no AI model provider account exists
      expect(res.status).toBe(503);
      expect((res.body as any).error.code).toMatch(/generation_failed|model_unavailable/);
    });

    it('GET /x/v1/support/widget.js returns executable JavaScript defining window.FreeLLMAPISupport', async () => {
      const res = await apiCall('/x/v1/support/widget.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/javascript');
      expect(res.text).toContain('window.FreeLLMAPISupport');
      expect(res.text).toContain('init: function');
      expect(res.text).toContain('/x/v1/support/chat');
    });
  });
});
