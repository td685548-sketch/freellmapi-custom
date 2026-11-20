import { getDb, type Db } from '../../db/index.js';
import { up as upTenantRbac } from '../../db/migrations/20261118_043000_custom_tenant_rbac.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { normalizeEmail, type SessionUser } from '../../services/auth.js';
import { listCombos } from '../x-gateway/config.js';
import {
  ensureSupportTables,
  getSupportTenant,
  listSupportTenants,
  type SupportTenant,
} from '../x-gateway/support-store.js';
import {
  inferTenantRolePreset,
  isTenantPermissionSubset,
  normalizeTenantPermissions,
  parseStoredTenantPermissions,
  tenantPermissionGranted,
  TENANT_ROLE_PRESETS,
  type TenantMemberRecord,
  type TenantMembershipSummary,
  type TenantModelOption,
  type TenantPermission,
  type TenantPortalSummary,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';

export class TenantRbacError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantRbacError';
  }
}

const initializedDbs = new WeakSet<Db>();

export function ensureTenantRbacTables(targetDb?: Db): Db {
  const db = targetDb ?? getDb();
  if (initializedDbs.has(db)) return db;
  upTenantRbac(db);
  initializedDbs.add(db);
  return db;
}

export function isPlatformTenantOperator(user: SessionUser | undefined): boolean {
  if (!user) return false;
  return (
    hasPermission(user, '*') ||
    hasPermission(user, 'manage_x_gateway') ||
    (hasPermission(user, 'use_x_gateway') && hasPermission(user, 'edit_x_settings'))
  );
}

export function canPlatformManageTenantUsers(
  user: SessionUser | undefined,
  mode: 'read' | 'write',
): boolean {
  if (!user) return false;
  if (isPlatformTenantOperator(user)) return true;
  return mode === 'read'
    ? hasPermission(user, 'view_users')
    : hasPermission(user, 'edit_user_permissions');
}

export function getTenantPortalAccessForSession(
  user: SessionUser | undefined,
): { tenantCount: number; isPlatformOperator: boolean } {
  if (!user) return { tenantCount: 0, isPlatformOperator: false };
  const isOperator = isPlatformTenantOperator(user);
  try {
    const db = ensureTenantRbacTables();
    ensureSupportTables();
    if (isOperator) {
      const row = db.prepare('SELECT COUNT(*) AS c FROM x_support_tenants').get() as { c: number };
      return { tenantCount: Number(row?.c ?? 0), isPlatformOperator: true };
    }
    const rows = db
      .prepare(
        `SELECT m.permissions_json
           FROM custom_tenant_memberships m
           INNER JOIN x_support_tenants t ON t.id = m.tenant_id
          WHERE m.user_id = ?`,
      )
      .all(user.userId) as Array<{ permissions_json: string }>;
    const count = rows.filter((r) => parseStoredTenantPermissions(r.permissions_json).length > 0).length;
    return { tenantCount: count, isPlatformOperator: false };
  } catch {
    return { tenantCount: 0, isPlatformOperator: isOperator };
  }
}

export interface EffectiveTenantAccess {
  tenant: SupportTenant;
  permissions: TenantPermission[];
  rolePreset: TenantRolePresetId;
  isPlatformOperator: boolean;
}

export function resolveEffectiveTenantAccess(
  user: SessionUser | undefined,
  tenantId: number,
): EffectiveTenantAccess {
  if (!user) {
    throw new TenantRbacError(401, 'unauthorized', 'Authentication required.');
  }
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new TenantRbacError(400, 'invalid_input', 'Tenant ID must be a positive integer.');
  }

  const db = ensureTenantRbacTables();
  ensureSupportTables();

  let tenant: SupportTenant;
  try {
    tenant = getSupportTenant(tenantId);
  } catch {
    throw new TenantRbacError(404, 'tenant_not_found', 'Support tenant not found.');
  }

  if (isPlatformTenantOperator(user)) {
    return {
      tenant,
      permissions: ['*'],
      rolePreset: 'tenant_owner',
      isPlatformOperator: true,
    };
  }

  const row = db
    .prepare(
      `SELECT role_preset, permissions_json
         FROM custom_tenant_memberships
        WHERE tenant_id = ? AND user_id = ?`,
    )
    .get(tenantId, user.userId) as
    | { role_preset: string; permissions_json: string }
    | undefined;

  if (!row) {
    throw new TenantRbacError(404, 'tenant_not_found', 'Support tenant not found.');
  }

  const permissions = parseStoredTenantPermissions(row.permissions_json);
  if (permissions.length === 0) {
    throw new TenantRbacError(404, 'tenant_not_found', 'Support tenant not found.');
  }

  const rolePreset = inferTenantRolePreset(permissions);
  return {
    tenant,
    permissions,
    rolePreset,
    isPlatformOperator: false,
  };
}

export function assertTenantPermission(
  user: SessionUser | undefined,
  tenantId: number,
  required: TenantPermission,
): EffectiveTenantAccess {
  const access = resolveEffectiveTenantAccess(user, tenantId);
  if (!tenantPermissionGranted(access.permissions, required)) {
    throw new TenantRbacError(
      403,
      'forbidden',
      `Permission denied: '${required}' access required on this tenant.`,
    );
  }
  return access;
}

export function listAccessibleTenantsForUser(user: SessionUser | undefined): TenantPortalSummary[] {
  if (!user) return [];
  const db = ensureTenantRbacTables();
  ensureSupportTables();

  if (isPlatformTenantOperator(user)) {
    return listSupportTenants().map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      publicKey: t.publicKey,
      defaultModel: t.defaultModel,
      enabled: t.enabled,
      allowGuest: t.allowGuest,
      rolePreset: 'tenant_owner',
      permissions: ['*'],
      isPlatformOperator: true,
    }));
  }

  const rows = db
    .prepare(
      `SELECT m.tenant_id, m.permissions_json
         FROM custom_tenant_memberships m
        WHERE m.user_id = ?
        ORDER BY m.tenant_id ASC`,
    )
    .all(user.userId) as Array<{ tenant_id: number; permissions_json: string }>;

  const byId = new Map(listSupportTenants().map((t) => [t.id, t]));
  const result: TenantPortalSummary[] = [];
  for (const row of rows) {
    const tenant = byId.get(row.tenant_id);
    if (!tenant) continue;
    const permissions = parseStoredTenantPermissions(row.permissions_json);
    if (permissions.length === 0) continue;
    result.push({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      publicKey: tenant.publicKey,
      defaultModel: tenant.defaultModel,
      enabled: tenant.enabled,
      allowGuest: tenant.allowGuest,
      rolePreset: inferTenantRolePreset(permissions),
      permissions,
      isPlatformOperator: false,
    });
  }
  return result;
}

interface UserLookupRow {
  id: number;
  email: string;
  role: string;
  is_primary: number;
}

function findUserById(db: Db, userId: number): UserLookupRow | undefined {
  return db
    .prepare('SELECT id, email, role, is_primary FROM users WHERE id = ?')
    .get(userId) as UserLookupRow | undefined;
}

function findUserByEmail(db: Db, email: string): UserLookupRow | undefined {
  return db
    .prepare('SELECT id, email, role, is_primary FROM users WHERE email = ?')
    .get(normalizeEmail(email)) as UserLookupRow | undefined;
}

/** Email → account lookup shared by the Copilot grant path (no duplicate query). */
export function getUserByEmail(email: string): {
  id: number;
  email: string;
  role: string;
  isPrimary: boolean;
} | undefined {
  const db = ensureTenantRbacTables();
  const row = findUserByEmail(db, email);
  return row
    ? { id: row.id, email: row.email, role: row.role, isPrimary: Boolean(row.is_primary) }
    : undefined;
}

/**
 * Last-delegator guard (Phase 3, shared by the admin UI and the Copilot):
 * at least one membership row on the tenant must keep
 * `manage_tenant_members`, so tenant delegation can never silently collapse.
 * Platform operators can still manage the tenant, but they are not counted
 * here — this guard protects the delegated manager set, mirroring the
 * global last-admin rule in services/users.ts.
 */
export function hasOtherTenantMemberManager(
  tenantId: number,
  excludeUserId: number,
): boolean {
  const db = ensureTenantRbacTables();
  const rows = db
    .prepare(
      'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id != ?',
    )
    .all(tenantId, excludeUserId) as Array<{ permissions_json: string }>;
  return rows.some((r) =>
    tenantPermissionGranted(
      parseStoredTenantPermissions(r.permissions_json),
      'manage_tenant_members',
    ),
  );
}

function assertNotLastTenantMemberManager(
  tenantId: number,
  targetUserId: number,
  nextPermissions: TenantPermission[],
): void {
  const db = ensureTenantRbacTables();
  const existingRow = db
    .prepare(
      'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
    )
    .get(tenantId, targetUserId) as { permissions_json: string } | undefined;
  if (!existingRow) return;
  const existingPerms = parseStoredTenantPermissions(existingRow.permissions_json);
  if (!tenantPermissionGranted(existingPerms, 'manage_tenant_members')) return;
  if (tenantPermissionGranted(nextPermissions, 'manage_tenant_members')) return;
  if (!hasOtherTenantMemberManager(tenantId, targetUserId)) {
    throw new TenantRbacError(
      409,
      'last_admin_protected',
      'Cannot remove the last member manager of this tenant. Assign manage_tenant_members to another member first.',
    );
  }
}

function resolveMembershipPayload(input: {
  rolePreset?: TenantRolePresetId;
  permissions?: readonly string[];
}): { rolePreset: TenantRolePresetId; permissions: TenantPermission[] } {
  let rawPermissions: readonly string[];
  if (input.permissions && input.permissions.length > 0) {
    rawPermissions = input.permissions;
  } else if (input.rolePreset && input.rolePreset !== 'custom') {
    rawPermissions = TENANT_ROLE_PRESETS[input.rolePreset];
  } else {
    throw new TenantRbacError(
      400,
      'invalid_permissions',
      'Provide a rolePreset or at least one valid tenant permission.',
    );
  }

  const permissions = normalizeTenantPermissions(rawPermissions);
  if (permissions.length === 0) {
    throw new TenantRbacError(
      400,
      'invalid_permissions',
      'At least one valid tenant permission is required.',
    );
  }

  const inferred = inferTenantRolePreset(permissions);
  const rolePreset: TenantRolePresetId =
    input.rolePreset === 'custom' ? 'custom' : inferred;
  return { rolePreset, permissions };
}

function readMemberRecord(
  db: Db,
  tenantId: number,
  userId: number,
  actorUserId: number,
): TenantMemberRecord {
  const row = db
    .prepare(
      `SELECT m.id, m.tenant_id, m.user_id, m.role_preset, m.permissions_json,
              m.assigned_by, m.created_at, m.updated_at,
              u.email, u.role, u.is_primary
         FROM custom_tenant_memberships m
         INNER JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ? AND m.user_id = ?`,
    )
    .get(tenantId, userId) as
    | {
        id: number;
        tenant_id: number;
        user_id: number;
        role_preset: string;
        permissions_json: string;
        assigned_by: number | null;
        created_at: string;
        updated_at: string;
        email: string;
        role: string;
        is_primary: number;
      }
    | undefined;

  if (!row) {
    throw new TenantRbacError(404, 'member_not_found', 'Tenant member not found.');
  }

  const permissions = parseStoredTenantPermissions(row.permissions_json);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    email: row.email,
    accountRole: row.role === 'admin' ? 'admin' : 'member',
    isPrimary: Boolean(row.is_primary),
    rolePreset: inferTenantRolePreset(permissions),
    permissions,
    assignedBy: row.assigned_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isSelf: row.user_id === actorUserId,
  };
}

export function listTenantMembers(tenantId: number, actorUserId: number): TenantMemberRecord[] {
  const db = ensureTenantRbacTables();
  ensureSupportTables();
  getSupportTenant(tenantId);

  const rows = db
    .prepare(
      `SELECT m.id, m.tenant_id, m.user_id, m.role_preset, m.permissions_json,
              m.assigned_by, m.created_at, m.updated_at,
              u.email, u.role, u.is_primary
         FROM custom_tenant_memberships m
         INNER JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = ?
        ORDER BY u.email ASC`,
    )
    .all(tenantId) as Array<{
    id: number;
    tenant_id: number;
    user_id: number;
    role_preset: string;
    permissions_json: string;
    assigned_by: number | null;
    created_at: string;
    updated_at: string;
    email: string;
    role: string;
    is_primary: number;
  }>;

  return rows.map((row) => {
    const permissions = parseStoredTenantPermissions(row.permissions_json);
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      email: row.email,
      accountRole: row.role === 'admin' ? 'admin' : 'member',
      isPrimary: Boolean(row.is_primary),
      rolePreset: inferTenantRolePreset(permissions),
      permissions,
      assignedBy: row.assigned_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isSelf: row.user_id === actorUserId,
    };
  });
}

export function listUserTenantMembershipsForAdmin(targetUserId: number): {
  user: { id: number; email: string; role: 'admin' | 'member'; isPrimary: boolean };
  tenants: Array<{ id: number; name: string; slug: string; enabled: boolean }>;
  memberships: TenantMembershipSummary[];
} {
  const db = ensureTenantRbacTables();
  ensureSupportTables();

  const target = findUserById(db, targetUserId);
  if (!target) {
    throw new TenantRbacError(404, 'user_not_found', 'No such account.');
  }

  const allTenants = listSupportTenants();
  const byId = new Map(allTenants.map((t) => [t.id, t]));

  const rows = db
    .prepare(
      `SELECT tenant_id, permissions_json, updated_at
         FROM custom_tenant_memberships
        WHERE user_id = ?
        ORDER BY tenant_id ASC`,
    )
    .all(targetUserId) as Array<{
    tenant_id: number;
    permissions_json: string;
    updated_at: string;
  }>;

  const memberships: TenantMembershipSummary[] = [];
  for (const row of rows) {
    const t = byId.get(row.tenant_id);
    if (!t) continue;
    const permissions = parseStoredTenantPermissions(row.permissions_json);
    memberships.push({
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      tenantEnabled: t.enabled,
      rolePreset: inferTenantRolePreset(permissions),
      permissions,
      updatedAt: row.updated_at,
    });
  }

  return {
    user: {
      id: target.id,
      email: target.email,
      role: target.role === 'admin' ? 'admin' : 'member',
      isPrimary: Boolean(target.is_primary),
    },
    tenants: allTenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      enabled: t.enabled,
    })),
    memberships,
  };
}

function writeMembershipRow(
  db: Db,
  params: {
    tenantId: number;
    userId: number;
    rolePreset: TenantRolePresetId;
    permissions: TenantPermission[];
    assignedBy: number;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO custom_tenant_memberships
       (tenant_id, user_id, role_preset, permissions_json, assigned_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, user_id) DO UPDATE SET
       role_preset = excluded.role_preset,
       permissions_json = excluded.permissions_json,
       assigned_by = excluded.assigned_by,
       updated_at = excluded.updated_at`,
  ).run(
    params.tenantId,
    params.userId,
    params.rolePreset,
    JSON.stringify(params.permissions),
    params.assignedBy,
    now,
    now,
  );
}

export function upsertTenantMembershipByPlatformAdmin(params: {
  tenantId: number;
  targetUserId: number;
  rolePreset?: TenantRolePresetId;
  permissions?: readonly string[];
  actor: SessionUser;
}): TenantMemberRecord {
  const db = ensureTenantRbacTables();
  ensureSupportTables();

  if (!canPlatformManageTenantUsers(params.actor, 'write')) {
    throw new TenantRbacError(
      403,
      'forbidden',
      'Administrative permission required to assign tenant access.',
    );
  }

  try {
    getSupportTenant(params.tenantId);
  } catch {
    throw new TenantRbacError(404, 'tenant_not_found', 'Support tenant not found.');
  }

  const target = findUserById(db, params.targetUserId);
  if (!target) {
    throw new TenantRbacError(404, 'user_not_found', 'No such account.');
  }
  if (target.is_primary) {
    throw new TenantRbacError(
      403,
      'primary_admin_protected',
      'The primary admin account already holds full access and cannot be modified.',
    );
  }
  if (target.id === params.actor.userId) {
    throw new TenantRbacError(
      409,
      'self_membership_change',
      'You cannot modify your own tenant membership.',
    );
  }

  const { rolePreset, permissions } = resolveMembershipPayload({
    rolePreset: params.rolePreset,
    permissions: params.permissions,
  });

  if (!isPlatformTenantOperator(params.actor)) {
    const actorAccess = resolveEffectiveTenantAccess(params.actor, params.tenantId);
    if (!isTenantPermissionSubset(actorAccess.permissions, permissions)) {
      throw new TenantRbacError(
        403,
        'insufficient_privileges',
        'Cannot grant tenant permissions you do not hold.',
      );
    }
    const existingRow = db
      .prepare(
        'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
      )
      .get(params.tenantId, target.id) as { permissions_json: string } | undefined;
    if (existingRow) {
      const existingPerms = parseStoredTenantPermissions(existingRow.permissions_json);
      if (!isTenantPermissionSubset(actorAccess.permissions, existingPerms)) {
        throw new TenantRbacError(
          403,
          'insufficient_privileges',
          'Cannot alter a tenant member with broader authority.',
        );
      }
    }
  }

  assertNotLastTenantMemberManager(params.tenantId, target.id, permissions);

  writeMembershipRow(db, {
    tenantId: params.tenantId,
    userId: target.id,
    rolePreset,
    permissions,
    assignedBy: params.actor.userId,
  });

  return readMemberRecord(db, params.tenantId, target.id, params.actor.userId);
}

export function upsertTenantMemberByTenantAdmin(params: {
  tenantId: number;
  userId?: number;
  email?: string;
  rolePreset?: TenantRolePresetId;
  permissions?: readonly string[];
  actor: SessionUser;
}): TenantMemberRecord {
  const access = assertTenantPermission(params.actor, params.tenantId, 'manage_tenant_members');
  const db = ensureTenantRbacTables();

  let target: UserLookupRow | undefined;
  if (params.userId !== undefined) {
    target = findUserById(db, params.userId);
  } else if (params.email && params.email.trim()) {
    target = findUserByEmail(db, params.email);
  }

  if (!target) {
    throw new TenantRbacError(
      404,
      'account_not_found',
      'No existing FreeLLMAPI account found for that email or user ID.',
    );
  }
  if (target.is_primary) {
    throw new TenantRbacError(
      403,
      'primary_admin_protected',
      'The primary admin account cannot be modified.',
    );
  }
  if (target.id === params.actor.userId) {
    throw new TenantRbacError(
      409,
      'self_membership_change',
      'You cannot change your own permissions on this tenant.',
    );
  }

  const { rolePreset, permissions } = resolveMembershipPayload({
    rolePreset: params.rolePreset,
    permissions: params.permissions,
  });

  if (!access.isPlatformOperator) {
    if (!isTenantPermissionSubset(access.permissions, permissions)) {
      throw new TenantRbacError(
        403,
        'insufficient_privileges',
        'Cannot grant tenant permissions you do not hold.',
      );
    }

    const existingRow = db
      .prepare(
        'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
      )
      .get(params.tenantId, target.id) as { permissions_json: string } | undefined;

    if (existingRow) {
      const existingPerms = parseStoredTenantPermissions(existingRow.permissions_json);
      if (!isTenantPermissionSubset(access.permissions, existingPerms)) {
        throw new TenantRbacError(
          403,
          'insufficient_privileges',
          'Cannot alter a tenant member with broader authority.',
        );
      }
    }
  }

  assertNotLastTenantMemberManager(params.tenantId, target.id, permissions);

  writeMembershipRow(db, {
    tenantId: params.tenantId,
    userId: target.id,
    rolePreset,
    permissions,
    assignedBy: params.actor.userId,
  });

  return readMemberRecord(db, params.tenantId, target.id, params.actor.userId);
}

export function removeTenantMember(params: {
  tenantId: number;
  targetUserId: number;
  actor: SessionUser;
  viaPlatformAdmin?: boolean;
}): boolean {
  const db = ensureTenantRbacTables();
  ensureSupportTables();

  let actorIsPlatformOperator = false;
  let actorPermissions: TenantPermission[] = [];

  if (params.viaPlatformAdmin) {
    if (!canPlatformManageTenantUsers(params.actor, 'write')) {
      throw new TenantRbacError(
        403,
        'forbidden',
        'Administrative permission required to revoke tenant access.',
      );
    }
    try {
      getSupportTenant(params.tenantId);
    } catch {
      throw new TenantRbacError(404, 'tenant_not_found', 'Support tenant not found.');
    }
    actorIsPlatformOperator = isPlatformTenantOperator(params.actor);
    if (!actorIsPlatformOperator) {
      actorPermissions = resolveEffectiveTenantAccess(params.actor, params.tenantId).permissions;
    }
  } else {
    const access = assertTenantPermission(params.actor, params.tenantId, 'manage_tenant_members');
    actorIsPlatformOperator = access.isPlatformOperator;
    actorPermissions = access.permissions;
  }

  const target = findUserById(db, params.targetUserId);
  if (!target) {
    throw new TenantRbacError(404, 'user_not_found', 'No such account.');
  }
  if (target.is_primary) {
    throw new TenantRbacError(
      403,
      'primary_admin_protected',
      'The primary admin account cannot be modified.',
    );
  }
  if (target.id === params.actor.userId) {
    throw new TenantRbacError(
      409,
      'self_membership_change',
      'You cannot remove your own tenant membership.',
    );
  }

  const existingRow = db
    .prepare(
      'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
    )
    .get(params.tenantId, params.targetUserId) as { permissions_json: string } | undefined;

  if (!existingRow) {
    throw new TenantRbacError(404, 'member_not_found', 'Tenant member not found.');
  }

  if (!actorIsPlatformOperator) {
    const existingPerms = parseStoredTenantPermissions(existingRow.permissions_json);
    if (!isTenantPermissionSubset(actorPermissions, existingPerms)) {
      throw new TenantRbacError(
        403,
        'insufficient_privileges',
        'Cannot remove a tenant member with broader authority.',
      );
    }
  }

  assertNotLastTenantMemberManager(params.tenantId, params.targetUserId, []);

  return (
    db
      .prepare('DELETE FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?')
      .run(params.tenantId, params.targetUserId).changes > 0
  );
}

export function listSafeTenantModelOptions(): TenantModelOption[] {
  const options: TenantModelOption[] = [
    {
      id: 'auto',
      label: 'Auto (Recommended)',
      description: 'Automatic gateway routing with failover across available healthy routes.',
      strategy: 'auto',
    },
  ];

  try {
    const combos = listCombos();
    for (const combo of combos) {
      if (combo.kind && combo.kind !== 'chat') continue;
      options.push({
        id: combo.name,
        label: combo.name,
        description: combo.description || `Gateway combo (${combo.strategy ?? 'fallback'})`,
        strategy: combo.strategy ?? 'fallback',
      });
    }
  } catch {
    // Ignore when gateway tables are not yet initialized
  }

  return options;
}
