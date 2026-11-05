import { getDb } from '../db/index.js';
import type { UserRole } from './auth.js';
import type { AdminUser as AdminUserRow, Permission } from '@freellmapi/shared/user-access.js';
import { parseStoredPermissions, permissionGranted } from '@freellmapi/shared/permissions.js';

// Admin-side account management. Deliberately its own service file so upstream's
// services/auth.ts stays the self-scoped authentication path it has always been.

interface PermissionRow {
  role: string;
  is_primary: number;
  permissions: string | null;
}

/**
 * The permission set a row holds. `['*']` is full administrative access, and an
 * primary account always holds it. Explicit secondary-admin lists are enforced;
 * absent legacy admin data retains full access. Corrupt JSON fails closed.
 */
function grantedPermissions(row: PermissionRow): Permission[] {
  return parseStoredPermissions(row.permissions, row.role, Boolean(row.is_primary));
}

/** Every account with the counts an operator needs to decide what to do with it. */
export function listUsers(actorUserId: number): AdminUserRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id, u.email, u.role, u.is_primary, u.permissions, u.created_at,
           (SELECT COUNT(*) FROM user_api_keys k
             WHERE k.user_id = u.id AND k.revoked = 0) AS active_keys,
           (SELECT COUNT(*) FROM sessions s
             WHERE s.user_id = u.id AND s.expires_at_ms > ?) AS sessions
    FROM users u
    ORDER BY u.id ASC
  `).all(Date.now()) as Array<{
    id: number;
    email: string;
    role: string;
    is_primary: number;
    permissions: string | null;
    created_at: string;
    active_keys: number;
    sessions: number;
  }>;

  return rows.map(r => {
    const isPrimary = Boolean(r.is_primary);
    const permissions = grantedPermissions({ role: r.role, is_primary: r.is_primary, permissions: r.permissions });

    return {
      id: r.id,
      email: r.email,
      role: r.role === 'admin' ? 'admin' as const : 'member' as const,
      isPrimary,
      permissions,
      createdAt: r.created_at,
      activeKeys: r.active_keys,
      sessions: r.sessions,
      isSelf: r.id === actorUserId,
    };
  });
}

/**
 * Promote or demote an account. Role is re-read from the row on every session
 * validation, so a demotion bites on the target's next request without having
 * to touch their sessions.
 *
 * Throws `{ code }`: 'self_role_change' | 'user_not_found' | 'primary_admin_protected'.
 */
function deny(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}
function subject(row: PermissionRow) {
  return { role: row.role, isPrimary: Boolean(row.is_primary), permissions: grantedPermissions(row) };
}
function noBroaderThan(actor: PermissionRow, permissions: Permission[]): boolean {
  return permissions.every(p => permissionGranted(subject(actor), p));
}

export function setUserRole(userId: number, role: UserRole, actorUserId: number): void {
  if (userId === actorUserId) deny('self_role_change', 'You cannot change your own role');
  const db = getDb();
  db.transaction(() => {
    const actor = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(actorUserId) as PermissionRow | undefined;
    if (!actor || (actor.role !== 'admin' && !actor.is_primary) || !permissionGranted(subject(actor), 'edit_user_roles')) deny('insufficient_privileges', 'Administrator role and role management permission required');
    const target = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(userId) as PermissionRow | undefined;
    if (!target) deny('user_not_found', 'No such account');
    if (target.is_primary) deny('primary_admin_protected', 'The primary admin account is protected');
    const full = permissionGranted(subject(actor), '*');
    const held = grantedPermissions(target);
    if (!full && !noBroaderThan(actor, held)) deny('insufficient_privileges', 'Cannot alter an account with broader authority');
    // A role label never becomes a route around the grant hierarchy. Only a
    // full-access actor can mint wildcard authority on promotion.
    const next = role === 'member' ? [] : full ? ['*'] : held;
    db.prepare('UPDATE users SET role = ?, permissions = ? WHERE id = ?').run(role, JSON.stringify(next), userId);
  })();
}

/**
 * Update granular permissions for an account.
 *
 * Two rules keep this from being the way out of the permission model:
 *
 * 1. Nobody edits their own grant. Widening it is self-escalation; narrowing it
 *    is self-lockout. Same reasoning as `setUserRole`.
 * 2. An actor can only ever write a list of permissions it holds itself. A
 *    `manage_users` holder therefore cannot hand out `manage_settings` or
 *    `manage_backups` it does not have, which is how a delegate would otherwise
 *    collect the whole admin surface one victim at a time.
 *
 * Throws `{ code }`: 'self_permission_change' | 'user_not_found' |
 * 'primary_admin_protected' | 'insufficient_privileges'.
 */
export function setUserPermissions(userId: number, permissions: Permission[], actorUserId: number): void {
  if (userId === actorUserId) deny('self_permission_change', 'You cannot change your own permissions');
  const db = getDb();
  db.transaction(() => {
    const target = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(userId) as PermissionRow | undefined;
    if (!target) deny('user_not_found', 'No such account');
    if (target.is_primary) deny('primary_admin_protected', 'The primary admin account is protected');
    const actor = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(actorUserId) as PermissionRow | undefined;
    if (!actor || !permissionGranted(subject(actor), 'edit_user_permissions')) deny('insufficient_privileges', 'Permission assignment access required');
    if (!permissionGranted(subject(actor), '*')) {
      if (!noBroaderThan(actor, grantedPermissions(target))) deny('insufficient_privileges', 'Cannot alter an account with broader authority');
      if (!noBroaderThan(actor, permissions)) deny('insufficient_privileges', 'Cannot grant permissions you do not hold');
    }
    db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(JSON.stringify(permissions), userId);
  })();
}

/**
 * A delegated operator may only act on accounts whose authority it covers, the
 * same rule setUserRole/setUserPermissions apply. Without it a holder of a
 * narrow grant (say revoke_user_sessions) could lock out, or throttle, every
 * administrator above it. Acting on yourself is always allowed.
 * Throws { code: 'insufficient_privileges' }.
 */
export function assertCanManageAccount(userId: number, actorUserId: number): void {
  if (userId === actorUserId) return;
  const db = getDb();
  const actor = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(actorUserId) as PermissionRow | undefined;
  const target = db.prepare('SELECT role, is_primary, permissions FROM users WHERE id = ?').get(userId) as PermissionRow | undefined;
  if (!actor) deny('insufficient_privileges', 'Administrative access required');
  if (!target) return;
  if (!noBroaderThan(actor, grantedPermissions(target))) deny('insufficient_privileges', 'Cannot alter an account with broader authority');
}

/** Ends every dashboard session an account holds, including other devices' tabs. */
export function revokeSessionsForUser(userId: number, actorUserId?: number): number {
  const db = getDb();
  if (actorUserId && actorUserId !== userId) {
    const target = db.prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
    if (target?.is_primary) {
      const err = new Error('Cannot revoke sessions for the primary admin') as any;
      err.code = 'primary_admin_protected';
      throw err;
    }
    assertCanManageAccount(userId, actorUserId);
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Revokes every still-valid personal key of an account. Plaintext was never stored, so nothing to un-revoke. */
export function revokeApiKeysForUser(userId: number, actorUserId?: number): number {
  const db = getDb();
  if (actorUserId && actorUserId !== userId) {
    const target = db.prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
    if (target?.is_primary) {
      const err = new Error('Cannot revoke keys for the primary admin') as any;
      err.code = 'primary_admin_protected';
      throw err;
    }
    assertCanManageAccount(userId, actorUserId);
  }
  return db.prepare('UPDATE user_api_keys SET revoked = 1 WHERE user_id = ? AND revoked = 0')
    .run(userId).changes;
}

/** Lets a revoke route answer 404 instead of a misleading `{ revoked: 0 }`. */
export function userExists(userId: number): boolean {
  return Boolean(getDb().prepare('SELECT id FROM users WHERE id = ?').get(userId));
}

export function isPrimaryAdmin(userId: number): boolean {
  const row = getDb().prepare('SELECT is_primary FROM users WHERE id = ?').get(userId) as { is_primary: number } | undefined;
  return Boolean(row?.is_primary);
}
