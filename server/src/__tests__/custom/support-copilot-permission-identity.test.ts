import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { resolveCopilotUserScope } from '../../custom/support-setup-copilot/diagnostics.js';
import { classifyHumanConversationalAct } from '../../custom/support-setup-copilot/human-dialogue.js';
import {
  buildCallerIdentity,
  buildIdentityPromptBlock,
  buildTenantIdentity,
  buildWhoAmIResponse,
} from '../../custom/support-setup-copilot/identity.js';
import { buildHumanCoachSystemPrompt } from '../../custom/support-setup-copilot/llm-coach.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import { createSession, createUser, type SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

let server: Server;
let base: string;

let primaryAdmin: SessionUser;
let primaryToken: string;
let configurator: SessionUser;
let configuratorToken: string;
let viewer: SessionUser;
let viewerToken: string;
let outsiderToken: string;
let existingTenantId: number;
let secondTenantId: number;

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

/** Mock verified cloud lease so prompt assembly never touches the live activation token. */
function installMockCloudLease(): void {
  // ensureCloudEntitlementActive() short-circuits to null when NO token is
  // configured at all, even with a mocked lease — so set a dummy token that
  // is never sent anywhere (the unexpired mock lease means no refresh is
  // ever attempted). The live FREEAPI_AI_ACTIVATION_TOKEN is never used.
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'flm_act_test_dummy_token_never_sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-identity',
    label: 'Test License',
    instanceId: 'test-inst-identity',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4,
    packHash: 'hash-identity',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const pack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: {
      personaVi: 'Mock Persona Vi',
      personaEn: 'Mock Persona En',
      playbookReference: 'Mock Playbook',
      outputContract: 'Mock Output Contract',
    },
    supportAgentCopilotInstruction: 'Mock Copilot Instruction',
    customerAiDirective: 'ACTIVE',
    supportGatewayDirective: 'ACTIVE',
    aiPlatformCapabilityGrant: 'ACTIVE',
  };
  configureCloudEntitlementForTesting({
    activeLeaseRecord: {
      lease,
      tokenHash: 'dummy-hash',
      signature: 'dummy-sig',
      runtimePack: pack,
      verifiedAtMs: Date.now(),
    },
  });
}

describe('Setup Copilot — Permission-Aware Identity (Phase 0 + Phase 1)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    primaryAdmin = createUser('identity-admin@example.com', 'AdminPass123!');
    primaryToken = createSession(primaryAdmin.userId);

    configurator = createUser('tenant-configurator@example.com', 'UserPass123!', 'member');
    configuratorToken = createSession(configurator.userId);

    viewer = createUser('tenant-viewer@example.com', 'UserPass123!', 'member');
    viewerToken = createSession(viewer.userId);

    const outsider = createUser('identity-outsider@example.com', 'UserPass123!', 'member');
    outsiderToken = createSession(outsider.userId);

    const xgw = createUser('identity-xgw@example.com', 'UserPass123!', 'member');
    setUserPermissions(xgw.userId, ['use_x_gateway'], primaryAdmin.userId);

    existingTenantId = createSupportTenant({
      name: 'Existing Corp',
      slug: 'existing-corp',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;

    // Second tenant the configurator/viewer never get access to (scoping proof).
    secondTenantId = createSupportTenant({
      name: 'Second Corp',
      slug: 'second-corp',
      defaultModel: 'auto',
      systemPrompt: 'Second prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;

    const assignConfigurator = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${configurator.userId}`,
      'PUT',
      { rolePreset: 'ai_configurator' },
      primaryToken,
    );
    expect(assignConfigurator.status).toBe(200);

    const assignViewer = await hit(
      `/api/admin/tenant-memberships/tenants/${existingTenantId}/users/${viewer.userId}`,
      'PUT',
      { rolePreset: 'viewer' },
      primaryToken,
    );
    expect(assignViewer.status).toBe(200);
  });

  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('buildCallerIdentity', () => {
    it('platform operator (primary admin, *) gets full permissions and owns every tenant', () => {
      const scope = resolveCopilotUserScope(primaryAdmin);
      const identity = buildCallerIdentity(primaryAdmin, scope);
      expect(identity).not.toBeNull();
      expect(identity?.email).toBe('identity-admin@example.com');
      expect(identity?.accountRole).toBe('admin');
      expect(identity?.isPrimary).toBe(true);
      expect(identity?.globalPermissions).toEqual(['*']);
      expect(identity?.isPlatformOperator).toBe(true);
      expect(identity?.canCreateTenant).toBe(true);
      expect(identity?.tenants.map((t) => t.id).sort()).toEqual(
        [existingTenantId, secondTenantId].sort(),
      );
      for (const tenant of identity?.tenants ?? []) {
        expect(tenant.rolePreset).toBe('tenant_owner');
        expect(tenant.permissions).toEqual(['*']);
        expect(tenant.canEditSteps).toHaveLength(7);
      }
    });

    it('ai_configurator gets the correct step set (edits 6 of 7, never runtime_policy)', () => {
      const scope = resolveCopilotUserScope(configurator);
      const identity = buildCallerIdentity(configurator, scope);
      expect(identity?.isPlatformOperator).toBe(false);
      expect(identity?.canCreateTenant).toBe(false);
      expect(identity?.tenants).toHaveLength(1);
      const tenant = (identity?.tenants ?? [])[0]!;
      expect(tenant.id).toBe(existingTenantId);
      expect(tenant.rolePreset).toBe('ai_configurator');
      expect(tenant.canEditSteps).toEqual(
        expect.arrayContaining([
          'tenant_ai',
          'knowledge_masking',
          'guardrails_quotas',
          'output_controls',
          'widget_appearance',
          'sla_routing',
        ]),
      );
      expect(tenant.canEditSteps).not.toContain('runtime_policy');
      expect(tenant.canViewSteps).toHaveLength(7);
    });

    it('viewer is view-only on every step', () => {
      const scope = resolveCopilotUserScope(viewer);
      const identity = buildCallerIdentity(viewer, scope);
      expect(identity?.tenants).toHaveLength(1);
      const tenant = (identity?.tenants ?? [])[0]!;
      expect(tenant.rolePreset).toBe('viewer');
      expect(tenant.canEditSteps).toHaveLength(0);
      expect(tenant.canViewSteps).toHaveLength(7);
    });

    it('a user with no membership sees an empty tenant list', () => {
      // Resolve scope from a real unassigned session instead of a fake id.
      const ghost = {
        userId: 999999,
        email: 'ghost@example.com',
        role: 'member',
      } as SessionUser;
      const scope = resolveCopilotUserScope(ghost);
      expect(scope.tenants).toHaveLength(0);
      const identity = buildCallerIdentity(ghost, scope);
      expect(identity?.tenants).toHaveLength(0);
      expect(identity?.globalPermissions).toEqual([]);
    });

    it('use_x_gateway read-only access is preserved (thruline view steps, no edits)', () => {
      const db = getDb();
      const row = db
        .prepare('SELECT id, email, role, is_primary, permissions FROM users WHERE email = ?')
        .get('identity-xgw@example.com') as {
        id: number;
        email: string;
        role: 'admin' | 'member';
        is_primary: number;
        permissions: string | null;
      };
      const xgwUser: SessionUser = {
        userId: row.id,
        email: row.email,
        role: row.role,
        isPrimary: Boolean(row.is_primary),
        permissions: row.permissions ? (JSON.parse(row.permissions) as never[]) : [],
      };
      const scope = resolveCopilotUserScope(xgwUser);
      const identity = buildCallerIdentity(xgwUser, scope);
      expect(identity?.globalPermissions).toContain('use_x_gateway');
      expect(identity?.isPlatformOperator).toBe(false);
      // Read-only thruline visibility over every tenant, but nothing editable.
      expect(identity?.tenants).toHaveLength(2);
      for (const tenant of identity?.tenants ?? []) {
        expect(tenant.canEditSteps).toHaveLength(0);
        expect(tenant.canViewSteps).toEqual(
          expect.arrayContaining([
            'tenant_ai',
            'knowledge_masking',
            'guardrails_quotas',
            'widget_appearance',
            'sla_routing',
            'runtime_policy',
          ]),
        );
      }
    });

    it('returns null for anonymous callers', () => {
      expect(buildCallerIdentity(undefined, resolveCopilotUserScope(undefined))).toBeNull();
    });
  });

  describe('buildTenantIdentity (grant → step mapping)', () => {
    const tenant = { id: 7, name: 'Acme', slug: 'acme' };
    it('owner (*) can view and edit all 7 steps', () => {
      const identity = buildTenantIdentity(tenant, 'tenant_owner', ['*']);
      expect(identity.canViewSteps).toHaveLength(7);
      expect(identity.canEditSteps).toHaveLength(7);
    });
    it('viewer grants are view-only', () => {
      const identity = buildTenantIdentity(tenant, 'viewer', [
        'view_tenant_ai',
        'view_tenant_knowledge',
        'view_tenant_tools',
        'view_tenant_guardrails',
        'view_tenant_desk',
        'view_tenant_integration',
        'view_tenant_members',
        'view_tenant_analytics',
      ]);
      expect(identity.canViewSteps).toHaveLength(7);
      expect(identity.canEditSteps).toHaveLength(0);
    });
  });

  describe('identity_or_permissions intent detection', () => {
    it.each([
      'tôi có role và quyền gì',
      'tôi là admin hay member',
      'quyền của tôi là gì',
      'Tôi có quyền gì?',
      'cho tôi biết role của tôi',
      'mình được làm những gì',
      'what are my permissions',
      'what is my role',
      'am I an admin',
      'What permissions do I have?',
      'show my permissions',
    ])('classifies %p as identity_or_permissions', (text) => {
      expect(classifyHumanConversationalAct(text)).toBe('identity_or_permissions');
    });

    it.each([
      'tôi đang có web boardgame, muốn setup trợ lý tư vấn',
      'tôi muốn tạo tenant mới',
      'Bạn có thể làm gì cho web của mình?',
      'Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh',
      'Shop mình tên GlowSkin, đổi trả 7 ngày',
    ])('does NOT classify %p as identity_or_permissions', (text) => {
      expect(classifyHumanConversationalAct(text)).not.toBe('identity_or_permissions');
    });
  });

  describe('GET /api/support-setup-copilot/whoami', () => {
    it('returns only the caller’s own tenants and roles', async () => {
      const adminRes = await hit('/api/support-setup-copilot/whoami', 'GET', undefined, primaryToken);
      expect(adminRes.status).toBe(200);
      expect(adminRes.body?.email).toBe('identity-admin@example.com');
      expect(adminRes.body?.globalPermissions).toEqual(['*']);
      expect(adminRes.body?.tenants.map((t: { id: number }) => t.id).sort()).toEqual(
        [existingTenantId, secondTenantId].sort(),
      );

      const configuratorRes = await hit(
        '/api/support-setup-copilot/whoami',
        'GET',
        undefined,
        configuratorToken,
      );
      expect(configuratorRes.status).toBe(200);
      expect(configuratorRes.body?.email).toBe('tenant-configurator@example.com');
      expect(configuratorRes.body?.tenants).toHaveLength(1);
      expect(configuratorRes.body?.tenants[0].id).toBe(existingTenantId);
      expect(configuratorRes.body?.tenants[0].rolePreset).toBe('ai_configurator');
      // Second tenant is never leaked to the configurator.
      expect(JSON.stringify(configuratorRes.body)).not.toContain('second-corp');

      const outsiderRes = await hit('/api/support-setup-copilot/whoami', 'GET', undefined, outsiderToken);
      expect(outsiderRes.status).toBe(200);
      expect(outsiderRes.body?.tenants).toEqual([]);
      expect(JSON.stringify(outsiderRes.body)).not.toContain('existing-corp');
    });

    it('rejects unauthenticated callers', async () => {
      const res = await hit('/api/support-setup-copilot/whoami');
      expect(res.status).toBe(401);
    });

    it('buildWhoAmIResponse mirrors buildCallerIdentity without extra data', () => {
      const scope = resolveCopilotUserScope(viewer);
      const identity = buildCallerIdentity(viewer, scope)!;
      const payload = buildWhoAmIResponse(identity);
      expect(payload.email).toBe('tenant-viewer@example.com');
      expect(payload.tenants[0]?.rolePreset).toBe('viewer');
      expect(payload.tenants[0]?.canEditSteps).toEqual([]);
    });
  });

  describe('POST /api/support-setup-copilot/chat — deterministic identity answers', () => {
    it('answers "tôi có role và quyền gì" from the DB record, in Vietnamese', async () => {
      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        { messages: [{ role: 'user', content: 'tôi có role và quyền gì' }] },
        configuratorToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.intent).toBe('guide');
      expect(res.body?.modelUsed).toBeNull();
      expect(res.body?.reply).toContain('tenant-configurator@example.com');
      expect(res.body?.reply).toContain('AI Configurator');
      expect(res.body?.reply).toContain('existing-corp');
      expect(res.body?.reply).not.toContain('second-corp');
    });

    it('answers unassigned members too (no 403) and says plainly they have no tenant', async () => {
      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        { messages: [{ role: 'user', content: 'Tôi có quyền gì?' }] },
        outsiderToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.reply).toContain('identity-outsider@example.com');
      expect(res.body?.reply).toContain('chưa được phân quyền');
    });

    it('answers the English variant in English', async () => {
      const res = await hit(
        '/api/support-setup-copilot/chat',
        'POST',
        { messages: [{ role: 'user', content: 'What are my permissions?' }] },
        viewerToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.reply).toContain('signed in as');
      expect(res.body?.reply).toContain('tenant-viewer@example.com');
      expect(res.body?.reply).toContain('Viewer');
    });
  });

  describe('LLM coach system prompt carries the trusted identity block', () => {
    it('injects the caller’s actual role and permissions', () => {
      const scope = resolveCopilotUserScope(configurator);
      const agentContext = buildCallerIdentity(configurator, scope)!;
      const prompt = buildHumanCoachSystemPrompt({
        user: configurator,
        messages: [{ role: 'user', content: 'tôi có role và quyền gì' }],
        locale: 'vi',
        targetMode: 'update_tenant',
        diagnostic: null,
        extracted: {},
        canCreateTenant: false,
        canEditSteps: new Set(agentContext.tenants[0]?.canEditSteps ?? []),
        agentContext,
      });
      expect(prompt).toContain('SERVER-PROVIDED CALLER IDENTITY — TRUSTED, DO NOT INFER OR EXTEND');
      expect(prompt).toContain('tenant-configurator@example.com');
      expect(prompt).toContain('AI Configurator');
      expect(prompt).toContain('ai_configurator');
      expect(prompt).toContain('tenant_ai_config');
      expect(prompt).toContain('can edit steps: tenant_ai');
      expect(prompt).toContain('Never invent permissions');
      // The raw helper produces the same block the prompt embeds.
      expect(buildIdentityPromptBlock(agentContext)).toContain('existing-corp');
    });

    it('falls back to an account-only block that refuses to infer tenant roles', () => {
      const prompt = buildHumanCoachSystemPrompt({
        user: viewer,
        messages: [{ role: 'user', content: 'hello' }],
        locale: 'en',
        targetMode: 'update_tenant',
        diagnostic: null,
        extracted: {},
        canCreateTenant: false,
        canEditSteps: new Set(),
      });
      expect(prompt).toContain('SERVER-PROVIDED CALLER IDENTITY');
      expect(prompt).toContain('tenant-viewer@example.com');
      expect(prompt).toContain('not provided to this prompt — do not infer tenant permissions');
    });
  });
});
