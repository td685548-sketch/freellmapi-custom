import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import { createApp } from '../../app.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { resolveCopilotUserScope } from '../../custom/support-setup-copilot/diagnostics.js';
import {
  authorizePermissionGrant,
  handlePermissionGrantChatTurn,
  matchPermissionGrantIntent,
} from '../../custom/support-setup-copilot/permission-grants.js';
import {
  COPILOT_TOOL_REGISTRY,
  executeCopilotTool,
  filterAdmittedTools,
} from '../../custom/support-setup-copilot/tools.js';
import { buildCallerIdentity } from '../../custom/support-setup-copilot/identity.js';
import {
  removeTenantMember,
  upsertTenantMemberByTenantAdmin,
} from '../../custom/tenant-portal/store.js';
import { listSupportAuditLogs } from '../../custom/x-gateway/support-enterprise-router.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import { getDb, initDb } from '../../db/index.js';
import {
  createSession,
  createUser,
  verifyCredentials,
  type SessionUser,
} from '../../services/auth.js';
import {
  setUserPermissions,
  setUserRole,
} from '../../services/users.js';

let server: Server;
let base: string;

let primaryAdmin: SessionUser;
let primaryToken: string;
let delegateAdmin: SessionUser;
let delegateToken: string;
let narrowAdmin: SessionUser;
let narrowToken: string;
let broadTarget: SessionUser;
let lastAdminTarget: SessionUser;
let spareAdmin: SessionUser;
let memberA: SessionUser;
let memberB: SessionUser;
let tenantMgr: SessionUser;
let tenantMgrToken: string;
let tenantMgr2: SessionUser;
let tenantViewer: SessionUser;
let mgr3: SessionUser;
let mgr4: SessionUser;
let tenant1Id: number;
let tenant2Id: number;
let tenant3Id: number;

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

function liveSession(email: string, password: string): SessionUser {
  const session = verifyCredentials(email, password);
  if (!session) throw new Error(`verifyCredentials failed for ${email}`);
  return session;
}

function setPermissions(userId: number, permissions: string[]): void {
  getDb()
    .prepare('UPDATE users SET permissions = ? WHERE id = ?')
    .run(JSON.stringify(permissions), userId);
}

function readUserPermissions(userId: number): string[] {
  const row = getDb()
    .prepare('SELECT permissions FROM users WHERE id = ?')
    .get(userId) as { permissions: string | null } | undefined;
  if (!row?.permissions) return [];
  try {
    const parsed: unknown = JSON.parse(row.permissions);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

function readMemberPermissions(tenantId: number, userId: number): string[] | null {
  const row = getDb()
    .prepare(
      'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
    )
    .get(tenantId, userId) as { permissions_json: string } | undefined;
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.permissions_json);
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

function identityFor(user: SessionUser) {
  return buildCallerIdentity(user, resolveCopilotUserScope(user))!;
}

/** Mock verified cloud lease so nothing touches the live activation token. */
function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-grant',
    label: 'Test License',
    instanceId: 'test-inst-grant',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4,
    packHash: 'hash-grant',
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

function auditEntries(tenantId: string, action: string, toolId?: string) {
  return listSupportAuditLogs(tenantId).filter(
    (e) =>
      e.action === action &&
      (toolId === undefined ||
        (e.details as Record<string, unknown>)?.toolId === toolId),
  );
}

describe('Setup Copilot — Permission Grant / Revoke (Phase 3)', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;

    primaryAdmin = createUser('grant-admin@example.com', 'AdminPass123!');
    primaryToken = createSession(primaryAdmin.userId);

    delegateAdmin = createUser('grant-delegate@example.com', 'UserPass123!', 'admin');
    setPermissions(delegateAdmin.userId, ['edit_user_permissions', 'view_users']);
    delegateAdmin = liveSession('grant-delegate@example.com', 'UserPass123!');
    delegateToken = createSession(delegateAdmin.userId);

    narrowAdmin = createUser('grant-narrow@example.com', 'UserPass123!', 'admin');
    setPermissions(narrowAdmin.userId, ['view_users']);
    narrowAdmin = liveSession('grant-narrow@example.com', 'UserPass123!');
    narrowToken = createSession(narrowAdmin.userId);

    broadTarget = createUser('grant-broad@example.com', 'UserPass123!', 'admin');
    setPermissions(broadTarget.userId, ['manage_settings', 'view_users']);
    broadTarget = liveSession('grant-broad@example.com', 'UserPass123!');

    // The ONLY delegated '*' holder in this DB (besides the primary).
    lastAdminTarget = createUser('grant-lastadmin@example.com', 'UserPass123!', 'admin');
    spareAdmin = createUser('grant-spare@example.com', 'UserPass123!', 'admin');
    setPermissions(spareAdmin.userId, ['view_users']);
    spareAdmin = liveSession('grant-spare@example.com', 'UserPass123!');

    memberA = createUser('grant-member-a@example.com', 'UserPass123!', 'member');
    memberB = createUser('grant-member-b@example.com', 'UserPass123!', 'member');
    tenantMgr = createUser('grant-mgr@example.com', 'UserPass123!', 'member');
    tenantMgrToken = createSession(tenantMgr.userId);
    tenantMgr2 = createUser('grant-mgr2@example.com', 'UserPass123!', 'member');
    tenantViewer = createUser('grant-viewer@example.com', 'UserPass123!', 'member');
    mgr3 = createUser('grant-mgr3@example.com', 'UserPass123!', 'member');
    mgr4 = createUser('grant-mgr4@example.com', 'UserPass123!', 'member');

    tenant1Id = createSupportTenant({
      name: 'Grant Corp',
      slug: 'grant-corp',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;
    tenant2Id = createSupportTenant({
      name: 'Grant Corp 2',
      slug: 'grant-corp-2',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;
    tenant3Id = createSupportTenant({
      name: 'Grant Corp 3',
      slug: 'grant-corp-3',
      defaultModel: 'auto',
      systemPrompt: 'Initial prompt.',
      createdBy: primaryAdmin.userId,
    }).tenant.id;

    const assign = async (
      tenantId: number,
      userId: number,
      body: Record<string, unknown>,
    ) => {
      const res = await hit(
        `/api/admin/tenant-memberships/tenants/${tenantId}/users/${userId}`,
        'PUT',
        body,
        primaryToken,
      );
      expect(res.status).toBe(200);
    };

    await assign(tenant1Id, tenantMgr.userId, {
      permissions: ['manage_tenant_members', 'view_tenant_members', 'view_tenant_ai'],
    });
    await assign(tenant2Id, tenantMgr.userId, {
      permissions: ['manage_tenant_members', 'view_tenant_members', 'view_tenant_ai'],
    });
    await assign(tenant1Id, tenantMgr2.userId, { rolePreset: 'support_operator' });
    await assign(tenant3Id, mgr3.userId, {
      permissions: ['manage_tenant_members', 'view_tenant_members'],
    });
  });

  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('matchPermissionGrantIntent — deterministic parser (pure, no DB)', () => {
    it('parses Vietnamese global grant/revoke with one or several permissions', () => {
      const grant = matchPermissionGrantIntent(
        'Cấp quyền view_users cho grant-member-a@example.com',
      );
      expect(grant).toMatchObject({
        action: 'grant',
        scope: 'global',
        targetEmail: 'grant-member-a@example.com',
        permissions: ['view_users'],
      });
      const multi = matchPermissionGrantIntent(
        'cấp quyền view_users, edit_settings cho grant-member-a@example.com',
      );
      expect(multi?.permissions).toEqual(['view_users', 'edit_settings']);
      const revoke = matchPermissionGrantIntent(
        'thu hồi quyền view_users của grant-member-a@example.com',
      );
      expect(revoke).toMatchObject({
        action: 'revoke',
        scope: 'global',
        permissions: ['view_users'],
      });
    });

    it('parses English grant/revoke', () => {
      expect(
        matchPermissionGrantIntent('grant view_users to grant-member-a@example.com'),
      ).toMatchObject({ action: 'grant', scope: 'global' });
      expect(
        matchPermissionGrantIntent(
          'revoke view_users from grant-member-a@example.com',
        ),
      ).toMatchObject({ action: 'revoke', scope: 'global' });
    });

    it('parses tenant grants by slug, role presets, and member removal', () => {
      const bySlug = matchPermissionGrantIntent(
        'cấp quyền view_tenant_ai cho grant-viewer@example.com trên tenant grant-corp',
      );
      expect(bySlug).toMatchObject({
        action: 'grant',
        scope: 'tenant',
        tenantSlug: 'grant-corp',
        permissions: ['view_tenant_ai'],
      });
      const preset = matchPermissionGrantIntent(
        'cho grant-viewer@example.com làm ai_configurator trên tenant grant-corp',
      );
      expect(preset).toMatchObject({
        action: 'grant',
        scope: 'tenant',
        rolePreset: 'ai_configurator',
      });
      const removal = matchPermissionGrantIntent(
        'gỡ grant-viewer@example.com khỏi tenant grant-corp',
      );
      expect(removal).toMatchObject({
        action: 'revoke',
        scope: 'tenant',
        removeMember: true,
      });
    });

    it('returns null for identity questions, missing emails, and non-grant text', () => {
      expect(matchPermissionGrantIntent('tôi có quyền gì?')).toBeNull();
      expect(matchPermissionGrantIntent('cấp quyền view_users cho Lan')).toBeNull();
      expect(matchPermissionGrantIntent('xoay API key giúp mình')).toBeNull();
      expect(matchPermissionGrantIntent('cấp quyền cho Lan nhé')).toBeNull();
    });

    it('flags unknown permission-like tokens instead of guessing', () => {
      const parsed = matchPermissionGrantIntent(
        'cấp quyền quyen_la cho grant-member-a@example.com',
      );
      expect(parsed?.unknownPermission).toBe('quyen_la');
    });

    it('returns null when global and tenant permissions are mixed', () => {
      expect(
        matchPermissionGrantIntent(
          'cấp quyền view_users, view_tenant_ai cho grant-member-a@example.com',
        ),
      ).toBeNull();
    });
  });

  describe('authorizePermissionGrant — live pre-check matrix', () => {
    it('delegated edit_user_permissions holder can grant a permission they hold', () => {
      const auth = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho grant-member-b@example.com',
        )!,
      });
      expect(auth.ok).toBe(true);
      if (auth.ok) {
        expect(auth.grant.targetUserId).toBe(memberB.userId);
        expect(auth.grant.previousPermissions).toEqual([]);
        expect(auth.grant.newPermissions).toEqual(['view_users']);
      }
    });

    it('holder without edit_user_permissions → missing_permission denial', () => {
      const auth = authorizePermissionGrant({
        user: narrowAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho grant-member-b@example.com',
        )!,
      });
      expect(auth.ok).toBe(false);
      if (!auth.ok) {
        expect(auth.code).toBe('missing_permission:edit_user_permissions');
      }
    });

    it('granting a permission the caller does not hold → insufficient_privileges', () => {
      const auth = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền manage_settings cho grant-member-b@example.com',
        )!,
      });
      expect(auth.ok).toBe(false);
      if (!auth.ok) expect(auth.code).toBe('insufficient_privileges');
    });

    it('altering a broader-authority target → insufficient_privileges', () => {
      const auth = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho grant-broad@example.com',
        )!,
      });
      expect(auth.ok).toBe(false);
      if (!auth.ok) expect(auth.code).toBe('insufficient_privileges');
    });

    it('self grant → self_permission_change; primary target → primary_admin_protected', () => {
      const self = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho grant-delegate@example.com',
        )!,
      });
      expect(self.ok).toBe(false);
      if (!self.ok) expect(self.code).toBe('self_permission_change');

      const primary = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho grant-admin@example.com',
        )!,
      });
      expect(primary.ok).toBe(false);
      if (!primary.ok) expect(primary.code).toBe('primary_admin_protected');
    });

    it('unknown target email → account_not_found; unknown permission → unknown_permission', () => {
      const ghost = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_users cho ghost@example.com',
        )!,
      });
      expect(ghost.ok).toBe(false);
      if (!ghost.ok) expect(ghost.code).toBe('account_not_found');

      const unknown = authorizePermissionGrant({
        user: delegateAdmin,
        intent: matchPermissionGrantIntent(
          'cấp quyền quyen_la cho grant-member-b@example.com',
        )!,
      });
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.code).toBe('unknown_permission');
    });

    it('tenant manager can grant a tenant permission they hold; viewer cannot', () => {
      const ok = authorizePermissionGrant({
        user: tenantMgr,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_tenant_ai cho grant-viewer@example.com trên tenant grant-corp',
        )!,
        tenantId: tenant1Id,
      });
      expect(ok.ok).toBe(true);

      const denied = authorizePermissionGrant({
        user: tenantViewer,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_tenant_ai cho grant-member-b@example.com trên tenant grant-corp',
        )!,
        tenantId: tenant1Id,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) {
        expect(denied.code).toBe('missing_permission:manage_tenant_members');
      }
    });

    it('tenant grant to an unknown slug → tenant_not_found; revoke from a non-member → member_not_found', () => {
      const unknownSlug = authorizePermissionGrant({
        user: tenantMgr,
        intent: matchPermissionGrantIntent(
          'cấp quyền view_tenant_ai cho grant-viewer@example.com trên tenant no-such-tenant',
        )!,
      });
      expect(unknownSlug.ok).toBe(false);
      if (!unknownSlug.ok) expect(unknownSlug.code).toBe('tenant_not_found');

      const nonMember = authorizePermissionGrant({
        user: tenantMgr,
        intent: matchPermissionGrantIntent(
          'thu hồi quyền view_tenant_ai của grant-member-b@example.com trên tenant grant-corp',
        )!,
        tenantId: tenant1Id,
      });
      expect(nonMember.ok).toBe(false);
      if (!nonMember.ok) expect(nonMember.code).toBe('member_not_found');
    });

    it('tenant grant with no slug and several managed tenants → clarifying reply, never a guess', () => {
      const scope = resolveCopilotUserScope(tenantMgr);
      const response = handlePermissionGrantChatTurn({
        user: tenantMgr,
        scope,
        messages: [
          {
            role: 'user',
            content: 'cấp quyền view_tenant_ai cho grant-member-b@example.com',
          },
        ],
        tenantId: null,
        locale: 'vi',
      });
      expect(response).not.toBeNull();
      expect(response!.proposal).toBeNull();
      expect(response!.reply).toContain('grant-corp');
      expect(response!.reply).toContain('grant-corp-2');
    });
  });

  describe('last-admin / last-delegator guard (shared store functions)', () => {
    it('blocks removing the last delegated * holder everywhere, then allows it once a spare exists', () => {
      // Authorize-time: primary revoking '*' from the sole delegated holder.
      const denied = authorizePermissionGrant({
        user: primaryAdmin,
        intent: matchPermissionGrantIntent(
          'thu hồi quyền * của grant-lastadmin@example.com',
        )!,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe('last_admin_protected');

      // Store-time: setUserPermissions + setUserRole both refuse.
      expect(() =>
        setUserPermissions(lastAdminTarget.userId, ['view_users'], primaryAdmin.userId),
      ).toThrow(expect.objectContaining({ code: 'last_admin_protected' }));
      expect(() =>
        setUserRole(lastAdminTarget.userId, 'member', primaryAdmin.userId),
      ).toThrow(expect.objectContaining({ code: 'last_admin_protected' }));
      expect(readUserPermissions(lastAdminTarget.userId)).toEqual(['*']);

      // Once another admin holds '*', the same change is allowed.
      setUserPermissions(spareAdmin.userId, ['*'], primaryAdmin.userId);
      expect(readUserPermissions(spareAdmin.userId)).toEqual(['*']);
      const allowed = authorizePermissionGrant({
        user: primaryAdmin,
        intent: matchPermissionGrantIntent(
          'thu hồi quyền * của grant-lastadmin@example.com',
        )!,
      });
      expect(allowed.ok).toBe(true);
      setUserPermissions(lastAdminTarget.userId, ['view_users'], primaryAdmin.userId);
      expect(readUserPermissions(lastAdminTarget.userId)).toEqual(['view_users']);
    });

    it('blocks removing the last tenant member manager everywhere, then allows it once a spare exists', () => {
      const revokeIntent = matchPermissionGrantIntent(
        'thu hồi quyền manage_tenant_members của grant-mgr3@example.com trên tenant grant-corp-3',
      )!;
      const denied = authorizePermissionGrant({
        user: primaryAdmin,
        intent: revokeIntent,
        tenantId: tenant3Id,
      });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.code).toBe('last_admin_protected');

      expect(() =>
        removeTenantMember({
          tenantId: tenant3Id,
          targetUserId: mgr3.userId,
          actor: primaryAdmin,
        }),
      ).toThrow(expect.objectContaining({ code: 'last_admin_protected' }));
      expect(() =>
        upsertTenantMemberByTenantAdmin({
          tenantId: tenant3Id,
          userId: mgr3.userId,
          rolePreset: 'viewer',
          actor: primaryAdmin,
        }),
      ).toThrow(expect.objectContaining({ code: 'last_admin_protected' }));
      expect(readMemberPermissions(tenant3Id, mgr3.userId)).toContain(
        'manage_tenant_members',
      );

      upsertTenantMemberByTenantAdmin({
        tenantId: tenant3Id,
        userId: mgr4.userId,
        permissions: ['manage_tenant_members', 'view_tenant_ai', 'view_tenant_members'],
        actor: primaryAdmin,
      });
      expect(
        removeTenantMember({
          tenantId: tenant3Id,
          targetUserId: mgr3.userId,
          actor: primaryAdmin,
        }),
      ).toBe(true);
      expect(readMemberPermissions(tenant3Id, mgr3.userId)).toBeNull();
    });

    it('single managed tenant is used as the unambiguous default (never guessed)', () => {
      const scope = resolveCopilotUserScope(mgr4);
      const response = handlePermissionGrantChatTurn({
        user: mgr4,
        scope,
        messages: [
          {
            role: 'user',
            content: 'cấp quyền view_tenant_ai cho grant-member-b@example.com',
          },
        ],
        tenantId: null,
        locale: 'vi',
      });
      expect(response).not.toBeNull();
      expect(response!.proposal?.targetMode).toBe('permission_grant');
      expect(response!.proposal?.permissionGrants?.[0]?.tenantId).toBe(tenant3Id);
    });
  });

  describe('executeCopilotTool — permission tools', () => {
    it('delegated admin is admitted to global tools; tenant manager to tenant tools', () => {
      const delegateAdmitted = filterAdmittedTools({
        agentContext: identityFor(delegateAdmin),
        user: delegateAdmin,
        tenantId: null,
      });
      expect(
        delegateAdmitted.filter((t) => t.kind === 'permission_grant').map((t) => t.id),
      ).toEqual(['permission.grant_global', 'permission.revoke_global']);

      const mgrAdmitted = filterAdmittedTools({
        agentContext: identityFor(tenantMgr),
        user: tenantMgr,
        tenantId: tenant1Id,
      });
      expect(
        mgrAdmitted.filter((t) => t.kind === 'permission_grant').map((t) => t.id),
      ).toEqual(['permission.grant_tenant', 'permission.revoke_tenant']);
      expect(COPILOT_TOOL_REGISTRY).toHaveLength(26);
    });

    it('tenant grant tool stages only — membership unchanged until Approve', async () => {
      const before = readMemberPermissions(tenant1Id, tenantViewer.userId);
      expect(before).toBeNull();
      const result = await executeCopilotTool({
        user: tenantMgr,
        toolId: 'permission.grant_tenant',
        input: {
          targetEmail: 'grant-viewer@example.com',
          tenantSlug: 'grant-corp',
          permissions: ['view_tenant_ai'],
        },
        tenantId: tenant1Id,
      });
      expect(result.status).toBe('executed');
      const grant = (result.result as Record<string, any>).grant;
      expect(grant.scope).toBe('tenant');
      expect(grant.tenantId).toBe(tenant1Id);
      expect(grant.newPermissions).toEqual(['view_tenant_ai']);
      expect(readMemberPermissions(tenant1Id, tenantViewer.userId)).toBeNull();
      const executed = auditEntries(
        String(tenant1Id),
        'support.setup_copilot.tool_executed',
        'permission.grant_tenant',
      );
      expect(executed.length).toBeGreaterThanOrEqual(1);
      expect((executed[0]!.details as Record<string, unknown>).targetEmail).toBe(
        'grant-viewer@example.com',
      );
    });

    it('tenant revoke tool by a member without manage_tenant_members → denied', async () => {
      const result = await executeCopilotTool({
        user: tenantViewer,
        toolId: 'permission.revoke_tenant',
        input: {
          targetEmail: 'grant-member-b@example.com',
          tenantSlug: 'grant-corp',
          permissions: ['view_tenant_ai'],
        },
        tenantId: tenant1Id,
      });
      expect(result.status).toBe('denied');
      expect(result.reason).toBe('missing_permission:manage_tenant_members');
    });
  });

  describe('HTTP end-to-end — chat → Consent Card proposal → Approve applies', () => {
    let grantProposalId: string;
    let revokeProposalId: string;
    let tenantGrantProposalId: string;

    async function postChat(
      content: string,
      token: string,
      tenantId?: number,
    ) {
      return hit(
        '/api/support-setup-copilot/chat',
        'POST',
        {
          ...(tenantId !== undefined ? { tenantId } : {}),
          messages: [{ role: 'user', content }],
        },
        token,
      );
    }

    it('delegated admin chats a global grant → pending_consent proposal, target unchanged', async () => {
      const before = readUserPermissions(memberA.userId);
      expect(before).toEqual([]);
      const res = await postChat(
        'Cấp quyền view_users cho grant-member-a@example.com',
        delegateToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.intent).toBe('propose_setup');
      expect(res.body?.proposal?.targetMode).toBe('permission_grant');
      expect(res.body?.proposal?.status).toBe('pending_consent');
      const grants = res.body?.proposal?.permissionGrants as Array<Record<string, any>>;
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        scope: 'global',
        action: 'grant',
        targetEmail: 'grant-member-a@example.com',
        permissions: ['view_users'],
        newPermissions: ['view_users'],
      });
      grantProposalId = res.body!.proposal.id as string;
      // Proposal-only: nothing changed until Approve.
      expect(readUserPermissions(memberA.userId)).toEqual([]);
      // The proposal survives /status for a delegate with no tenant access.
      const status = await hit('/api/support-setup-copilot/status', 'GET', undefined, delegateToken);
      expect(status.status).toBe(200);
      const pending = (status.body?.pendingProposals ?? []) as Array<Record<string, any>>;
      expect(pending.some((p) => p.id === grantProposalId)).toBe(true);
    });

    it('apply with approved:false → consent_required, nothing applied', async () => {
      const res = await hit(
        `/api/support-setup-copilot/proposals/${grantProposalId}/apply`,
        'POST',
        { approved: false },
        delegateToken,
      );
      expect(res.status).toBe(400);
      expect(res.body?.error?.code).toBe('consent_required');
      expect(readUserPermissions(memberA.userId)).toEqual([]);
    });

    it('apply with approved:true → permission actually granted + apply audit', async () => {
      const res = await hit(
        `/api/support-setup-copilot/proposals/${grantProposalId}/apply`,
        'POST',
        { approved: true },
        delegateToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.proposal?.status).toBe('applied');
      expect(readUserPermissions(memberA.userId)).toEqual(['view_users']);
      const applied = auditEntries('system', 'support.setup_copilot.permission_grant_apply');
      expect(applied.length).toBeGreaterThanOrEqual(1);
      const details = applied[0]!.details as Record<string, unknown>;
      expect(details.targetEmail).toBe('grant-member-a@example.com');
      expect(details.previousPermissions).toEqual([]);
      expect(details.newPermissions).toEqual(['view_users']);
      expect(details.via).toBe('copilot');
    });

    it('applying the same proposal twice → 409 proposal_already_applied', async () => {
      const res = await hit(
        `/api/support-setup-copilot/proposals/${grantProposalId}/apply`,
        'POST',
        { approved: true },
        delegateToken,
      );
      expect(res.status).toBe(409);
      expect(res.body?.error?.code).toBe('proposal_already_applied');
    });

    it('revoke via chat + Approve removes the permission', async () => {
      const chat = await postChat(
        'thu hồi quyền view_users của grant-member-a@example.com',
        delegateToken,
      );
      expect(chat.status).toBe(200);
      expect(chat.body?.proposal?.targetMode).toBe('permission_grant');
      revokeProposalId = chat.body!.proposal.id as string;
      const applied = await hit(
        `/api/support-setup-copilot/proposals/${revokeProposalId}/apply`,
        'POST',
        { approved: true },
        delegateToken,
      );
      expect(applied.status).toBe(200);
      expect(readUserPermissions(memberA.userId)).toEqual([]);
      const audits = auditEntries('system', 'support.setup_copilot.permission_revoke_apply');
      expect(audits.length).toBeGreaterThanOrEqual(1);
    });

    it('admin without edit_user_permissions gets a denial reply and no proposal', async () => {
      const res = await postChat(
        'Cấp quyền view_users cho grant-member-a@example.com',
        narrowToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.intent).toBe('guide');
      expect(res.body?.proposal).toBeNull();
      expect(res.body?.reply).toContain('edit_user_permissions');
    });

    it('grant to an unknown email gets a not-found reply and no proposal', async () => {
      const res = await postChat(
        'Cấp quyền view_users cho ghost@example.com',
        delegateToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.proposal).toBeNull();
      expect(res.body?.reply).toContain('ghost@example.com');
    });

    it('self-grant gets a self-change denial and no proposal', async () => {
      const res = await postChat(
        'Cấp quyền view_users cho grant-delegate@example.com',
        delegateToken,
      );
      expect(res.status).toBe(200);
      expect(res.body?.proposal).toBeNull();
    });

    it('key rotation is still refused (carve-out does not weaken the guard)', async () => {
      // tenantMgr has copilot access; a no-access user would get 403 from
      // the router gate before any refusal text (pre-existing behavior).
      const res = await postChat('xóa API key giúp mình', tenantMgrToken, tenant1Id);
      expect(res.status).toBe(200);
      expect(res.body?.proposal).toBeNull();
      expect(res.body?.reply).toContain('API key');
    });

    it('tenant grant via chat + Approve creates the membership', async () => {
      expect(readMemberPermissions(tenant1Id, tenantViewer.userId)).toBeNull();
      const chat = await postChat(
        'cấp quyền view_tenant_ai cho grant-viewer@example.com trên tenant grant-corp',
        tenantMgrToken,
        tenant1Id,
      );
      expect(chat.status).toBe(200);
      expect(chat.body?.proposal?.targetMode).toBe('permission_grant');
      tenantGrantProposalId = chat.body!.proposal.id as string;
      expect(readMemberPermissions(tenant1Id, tenantViewer.userId)).toBeNull();
      const applied = await hit(
        `/api/support-setup-copilot/proposals/${tenantGrantProposalId}/apply`,
        'POST',
        { approved: true },
        tenantMgrToken,
      );
      expect(applied.status).toBe(200);
      expect(readMemberPermissions(tenant1Id, tenantViewer.userId)).toEqual([
        'view_tenant_ai',
      ]);
      const audits = auditEntries(
        String(tenant1Id),
        'support.setup_copilot.permission_grant_apply',
      );
      expect(audits.length).toBeGreaterThanOrEqual(1);
      expect(
        (audits[0]!.details as Record<string, unknown>).targetEmail,
      ).toBe('grant-viewer@example.com');
    });

    it('last member manager cannot be revoked via chat (last_admin_protected)', async () => {
      // tenantMgr is the only manage_tenant_members holder on grant-corp
      // (tenantMgr2 holds support_operator only).
      const res = await postChat(
        'thu hồi quyền manage_tenant_members của grant-mgr@example.com trên tenant grant-corp',
        primaryToken,
        tenant1Id,
      );
      expect(res.status).toBe(200);
      expect(res.body?.proposal).toBeNull();
      expect(readMemberPermissions(tenant1Id, tenantMgr.userId)).toContain(
        'manage_tenant_members',
      );
    });
  });
});
