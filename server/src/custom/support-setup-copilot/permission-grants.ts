/**
 * Permission grant / revoke via the Setup Copilot (Phase 3).
 *
 * Deterministic, server-enforced grant/revoke for OTHER users — never by
 * prompt wording alone. The flow is:
 *
 *   1. `matchPermissionGrantIntent` parses the request (pure, no DB).
 *   2. `authorizePermissionGrant` re-reads caller + target LIVE from the DB
 *      and enforces: gating permission, subset (no broader than the caller
 *      holds), broader-authority (cannot alter a broader target), self and
 *      primary guards, and the last-admin / last-delegator guard.
 *   3. The authorized grant is staged as a `permission_grant` proposal
 *      (Consent Card). Nothing changes until Approve.
 *   4. `applySupportSetupProposal` (executor.ts) re-runs this same
 *      authorization live and only then calls `setUserPermissions` /
 *      `upsertTenantMemberByTenantAdmin` / `removeTenantMember`.
 *
 * The same authorization is used by the Copilot tool handlers (tools.ts),
 * so the LLM path and the deterministic chat path cannot diverge.
 */
import crypto from 'node:crypto';
import {
  SYSTEM_PERMISSIONS,
  parseStoredPermissions,
  type Permission,
} from '@freellmapi/shared/permissions.js';
import {
  TENANT_PERMISSIONS,
  TENANT_ROLE_PRESETS,
  inferTenantRolePreset,
  isTenantPermissionSubset,
  parseStoredTenantPermissions,
  tenantPermissionGranted,
  type TenantPermission,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';
import {
  SUPPORT_SETUP_PROPOSAL_TTL_SECONDS,
  type CopilotPermissionGrant,
  type SupportSetupChatResponse,
  type SupportSetupProposal,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getDb } from '../../db/index.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import {
  getUserPermissions,
  hasOtherWildcardAdmin,
  noBroaderThan,
  readPermissionRow,
} from '../../services/users.js';
import {
  getUserByEmail,
  hasOtherTenantMemberManager,
  isPlatformTenantOperator,
  resolveEffectiveTenantAccess,
} from '../tenant-portal/store.js';
import { getSupportTenant, listSupportTenants } from '../x-gateway/support-store.js';
import type { CopilotUserScope } from './diagnostics.js';
import { createSetupProposal } from './store.js';

export function foldVietnameseAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Live session user re-read from the DB (same shape as the private copies
 * in tools.ts / system-settings.ts — the gate never trusts a stale session
 * snapshot for global permissions).
 */
export function resolveLiveSessionUser(userId: number): SessionUser | null {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT id, email, role, is_primary, permissions FROM users WHERE id = ?')
      .get(userId) as
      | {
          id: number;
          email: string;
          role: string;
          is_primary?: number;
          permissions?: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      userId: row.id,
      email: row.email,
      role: row.role === 'admin' ? 'admin' : 'member',
      isPrimary: Boolean(row.is_primary),
      permissions: parseStoredPermissions(
        row.permissions ?? null,
        row.role,
        Boolean(row.is_primary),
      ),
    };
  } catch {
    return null;
  }
}

export interface ParsedPermissionGrantIntent {
  action: 'grant' | 'revoke';
  scope: 'global' | 'tenant';
  targetEmail: string;
  /** Requested permission ids (empty when a tenant rolePreset is given). */
  permissions: string[];
  rolePreset?: TenantRolePresetId;
  /** Tenant slug named in the message, when any. */
  tenantSlug?: string | null;
  /** Tenant id carried by a tool call (chat parsing leaves this unset). */
  tenantId?: number | null;
  /** Tenant revoke with no permissions listed = remove the member entirely. */
  removeMember?: boolean;
  /** A permission-like token the parser could not recognize (denied, not guessed). */
  unknownPermission?: string;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;

const GRANT_VERB_RE =
  /\b(?:cap\s+quyen|gan\s+quyen|phan\s+quyen|nang\s+quyen|them\s+quyen|grant|assign)\b/;
const REVOKE_VERB_RE =
  /\b(?:thu\s+hoi|go\s+quyen|xoa\s+quyen|ha\s+quyen|revoke|remove)\b/;
const REMOVE_MEMBER_RE =
  /\b(?:go|loai|xoa|remove)\b[^.!?\n]{0,40}?\b(?:khoi|ra\s+khoi|from)\b[^.!?\n]{0,20}?\btenant\b/;
const TENANT_REF_RE = /\btenant\s+([a-z0-9][a-z0-9_-]*)/;
const PRESET_RE = /\b(tenant_owner|ai_configurator|support_operator|viewer)\b/;

const GLOBAL_PERMISSION_SET = new Set<string>([...SYSTEM_PERMISSIONS, '*']);
const TENANT_PERMISSION_SET = new Set<string>([...TENANT_PERMISSIONS, '*']);
const PRESET_IDS = new Set<string>(Object.keys(TENANT_ROLE_PRESETS));

function extractTenantSlug(folded: string): string | null {
  const match = TENANT_REF_RE.exec(folded);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Pure deterministic parser for grant/revoke requests. Returns null when
 * the message is not a grant/revoke request (informational questions,
 * "what are my permissions", key/invite/backup requests, ...). Never
 * guesses: an unrecognized permission-like token is reported via
 * `unknownPermission` instead of being silently dropped.
 */
export function matchPermissionGrantIntent(
  rawMessage: string,
): ParsedPermissionGrantIntent | null {
  const folded = foldVietnameseAscii(rawMessage.trim());
  if (!folded) return null;
  const emailMatch = EMAIL_RE.exec(folded);
  if (!emailMatch) return null;
  const targetEmail = emailMatch[0];
  // Strip the email FIRST: preset/verb words can appear inside an address
  // (e.g. "viewer" in grant-viewer@example.com) and must never be parsed
  // as the request itself.
  const text = folded.replace(EMAIL_RE, ' ');

  const isRevoke = REVOKE_VERB_RE.test(text);
  const isGrant = GRANT_VERB_RE.test(text);
  const isRemoveMember = REMOVE_MEMBER_RE.test(text);
  const presetMatch = PRESET_RE.exec(text);
  // "cho X lam ai_configurator" / "make X an ai_configurator" — a preset
  // assignment with no explicit grant verb.
  const isPresetAssign =
    presetMatch !== null && /\b(?:lam|make|set)\b/.test(text);
  if (!isGrant && !isRevoke && !isRemoveMember && !isPresetAssign) return null;
  const action: 'grant' | 'revoke' =
    isRevoke || isRemoveMember ? 'revoke' : 'grant';

  const tenantSlug = extractTenantSlug(text);
  const rolePreset = presetMatch?.[1] as TenantRolePresetId | undefined;

  // Scan every token for known permission ids. Filler words (va/and/quyen/
  // permission/cho/to/from/...) never match an id, so they are ignored.
  const withoutTenant = tenantSlug
    ? text.replace(new RegExp(`\\btenant\\s+${tenantSlug.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`), ' ')
    : text;
  const tokens = withoutTenant
    .split(/[^a-z0-9_*]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const globalPermissions: string[] = [];
  const tenantPermissions: string[] = [];
  let unknownPermission: string | undefined;
  for (const token of tokens) {
    if (token === '*') {
      // Bare '*' is the global wildcard unless a tenant context pins it.
      globalPermissions.push('*');
      continue;
    }
    if (GLOBAL_PERMISSION_SET.has(token)) globalPermissions.push(token);
    else if (TENANT_PERMISSION_SET.has(token)) tenantPermissions.push(token);
    else if (token.includes('_') && !PRESET_IDS.has(token)) {
      unknownPermission ??= token;
    }
  }

  const hasGlobal = globalPermissions.length > 0;
  const hasTenant = tenantPermissions.length > 0;
  // A bare '*' is the wildcard for whichever scope the request pins; it
  // only makes the request ambiguous when real ids from both scopes appear.
  const hasRealGlobal =
    hasGlobal && !(globalPermissions.length === 1 && globalPermissions[0] === '*');
  if (hasRealGlobal && hasTenant) return null; // genuinely ambiguous — never guess
  if (isRemoveMember) {
    return {
      action: 'revoke',
      scope: 'tenant',
      targetEmail,
      permissions: [],
      tenantSlug,
      removeMember: true,
      unknownPermission,
    };
  }
  if (tenantSlug || rolePreset || hasTenant) {
    return {
      action,
      scope: 'tenant',
      targetEmail,
      permissions:
        tenantPermissions.length > 0
          ? [...new Set(tenantPermissions)]
          : globalPermissions.length === 1 && globalPermissions[0] === '*'
            ? ['*']
            : [],
      rolePreset,
      tenantSlug,
      unknownPermission,
    };
  }
  if (hasGlobal) {
    return {
      action,
      scope: 'global',
      targetEmail,
      permissions: [...new Set(globalPermissions)],
      unknownPermission,
    };
  }
  if (unknownPermission) {
    // A permission-like token nobody recognizes: report it (denied, not
    // guessed) instead of falling through as "not a grant request".
    return {
      action,
      scope: tenantSlug || rolePreset || hasTenant ? 'tenant' : 'global',
      targetEmail,
      permissions: [...new Set(tenantPermissions)],
      rolePreset,
      tenantSlug,
      unknownPermission,
    };
  }
  // Grant/revoke verb + email but no permission and no preset: not a
  // parseable grant — let the normal flow (LLM / clarification) handle it.
  return null;
}

export type PermissionGrantDenialCode =
  | 'missing_permission:edit_user_permissions'
  | 'missing_permission:manage_tenant_members'
  | 'account_not_found'
  | 'tenant_not_found'
  | 'member_not_found'
  | 'tenant_required'
  | 'tenant_ambiguous'
  | 'self_permission_change'
  | 'self_membership_change'
  | 'primary_admin_protected'
  | 'insufficient_privileges'
  | 'last_admin_protected'
  | 'unknown_permission'
  | 'invalid_input';

export type PermissionGrantAuthorization =
  | { ok: true; grant: CopilotPermissionGrant }
  | {
      ok: false;
      code: PermissionGrantDenialCode;
      messageVi: string;
      messageEn: string;
    };

function denial(
  code: PermissionGrantDenialCode,
  messageVi: string,
  messageEn: string,
): PermissionGrantAuthorization {
  return { ok: false, code, messageVi, messageEn };
}

/** HTTP status for a denial code (used by the apply branch). */
export function grantDenialStatus(code: string): number {
  if (
    code === 'account_not_found' ||
    code === 'tenant_not_found' ||
    code === 'member_not_found' ||
    code === 'user_not_found'
  ) {
    return 404;
  }
  if (
    code === 'self_permission_change' ||
    code === 'self_membership_change' ||
    code === 'last_admin_protected'
  ) {
    return 409;
  }
  if (
    code === 'unknown_permission' ||
    code === 'tenant_required' ||
    code === 'tenant_ambiguous' ||
    code === 'invalid_input'
  ) {
    return 400;
  }
  return 403;
}

function unionPermissions(previous: string[], added: string[]): string[] {
  const out = [...previous];
  for (const p of added) if (!out.includes(p)) out.push(p);
  return out;
}

/**
 * Live authorization for one grant/revoke. Reads caller + target from the
 * DB on every call and enforces every guard the store functions enforce —
 * so a staged grant can never be applied after the caller lost the
 * permission, the target gained broader authority, or the last admin
 * changed. Reads only; never writes.
 */
export function authorizePermissionGrant(params: {
  user: SessionUser;
  intent: ParsedPermissionGrantIntent;
  /** Turn-scoped tenant (router/playbook context) when the message names none. */
  tenantId?: number | null;
}): PermissionGrantAuthorization {
  const { user, intent, tenantId: contextTenantId } = params;

  if (intent.unknownPermission) {
    return denial(
      'unknown_permission',
      `Mình không nhận ra quyền \`${intent.unknownPermission}\` — bạn kiểm tra lại tên quyền (ví dụ: \`view_users\`, \`edit_settings\`) rồi gửi lại nhé. Mình chưa tạo đề xuất nào.`,
      `I don't recognize the permission \`${intent.unknownPermission}\` — please check the permission name (e.g. \`view_users\`, \`edit_settings\`) and try again. No proposal was created.`,
    );
  }

  const liveUser = resolveLiveSessionUser(user.userId);
  if (!liveUser) {
    return denial(
      'account_not_found',
      'Không tìm thấy tài khoản của bạn nữa nên mình không thể xử lý yêu cầu này.',
      'Your account no longer exists, so I cannot process this request.',
    );
  }

  const target = getUserByEmail(intent.targetEmail);
  if (!target) {
    return denial(
      'account_not_found',
      `Mình không tìm thấy tài khoản nào với email \`${intent.targetEmail}\`. Bạn kiểm tra lại email rồi gửi lại nhé — mình chưa tạo đề xuất nào.`,
      `I couldn't find any account with the email \`${intent.targetEmail}\`. Please check the email and try again — no proposal was created.`,
    );
  }

  if (target.id === user.userId) {
    return intent.scope === 'global'
      ? denial(
          'self_permission_change',
          'Bạn không thể tự cấp hay thu hồi quyền của chính mình — nhờ Quản trị viên chính thực hiện giúp nhé.',
          'You cannot grant or revoke your own permissions — please ask the primary admin to do it.',
        )
      : denial(
          'self_membership_change',
          'Bạn không thể tự thay đổi quyền của chính mình trên tenant — nhờ Quản trị viên chính thực hiện giúp nhé.',
          'You cannot change your own permissions on this tenant — please ask the primary admin to do it.',
        );
  }
  if (target.isPrimary) {
    return denial(
      'primary_admin_protected',
      'Tài khoản Quản trị viên chính được bảo vệ và không thể thay đổi quyền qua chat.',
      'The primary admin account is protected and its permissions cannot be changed via chat.',
    );
  }

  if (intent.scope === 'global') {
    if (!hasPermission(liveUser, 'edit_user_permissions')) {
      return denial(
        'missing_permission:edit_user_permissions',
        'Tài khoản của bạn chưa có quyền `edit_user_permissions` nên mình không thể cấp hay thu hồi quyền toàn cục. Nhờ Quản trị viên chính cấp quyền này tại trang **Người dùng & Phân quyền (`/users`)** nhé!',
        'Your account does not hold `edit_user_permissions`, so I cannot grant or revoke global permissions. Please ask the primary admin to grant it under **Users & Roles (`/users`)**.',
      );
    }
    const callerRow = readPermissionRow(user.userId);
    const previous = getUserPermissions(target.id) ?? [];
    const requested = intent.permissions as Permission[];
    if (requested.length === 0) {
      return denial(
        'invalid_input',
        'Bạn chưa nêu rõ quyền nào cần cấp hay thu hồi (ví dụ: `view_users`).',
        'You did not specify which permission to grant or revoke (e.g. `view_users`).',
      );
    }
    if (callerRow && !noBroaderThan(callerRow, requested)) {
      return denial(
        'insufficient_privileges',
        'Bạn chỉ được cấp những quyền mà chính bạn đang nắm giữ — mình không thể cấp quyền bạn không có.',
        'You can only grant permissions you hold yourself — I cannot grant a permission you do not have.',
      );
    }
    if (callerRow && !noBroaderThan(callerRow, previous)) {
      return denial(
        'insufficient_privileges',
        'Tài khoản đích đang nắm quyền rộng hơn phạm vi của bạn nên mình không thể thay đổi quyền của tài khoản đó.',
        'The target account holds broader authority than you, so I cannot change its permissions.',
      );
    }
    const newPermissions =
      intent.action === 'grant'
        ? unionPermissions(previous, requested)
        : previous.filter((p) => !requested.includes(p));
    if (
      intent.action === 'revoke' &&
      previous.includes('*') &&
      !newPermissions.includes('*') &&
      !hasOtherWildcardAdmin(getDb(), target.id)
    ) {
      return denial(
        'last_admin_protected',
        'Không thể thu hồi quyền toàn quyền (`*`) của tài khoản này vì đây là quản trị viên đầy đủ cuối cùng (không tính Quản trị viên chính). Hãy cấp `*` cho một quản trị viên khác trước.',
        'Cannot revoke full access (`*`) from this account — it is the last delegated full administrator (excluding the primary admin). Grant `*` to another admin first.',
      );
    }
    return {
      ok: true,
      grant: {
        scope: 'global',
        tenantId: null,
        targetUserId: target.id,
        targetEmail: target.email,
        action: intent.action,
        permissions: requested,
        previousPermissions: previous,
        newPermissions,
      },
    };
  }

  // ---- tenant scope ----
  let tenant: { id: number; name: string; slug: string } | null = null;
  if (intent.tenantSlug) {
    const found = listSupportTenants().find(
      (t) => t.slug.toLowerCase() === intent.tenantSlug!.toLowerCase(),
    );
    if (!found) {
      return denial(
        'tenant_not_found',
        `Mình không tìm thấy tenant nào có slug \`${intent.tenantSlug}\`. Bạn kiểm tra lại tên tenant rồi gửi lại nhé.`,
        `I couldn't find a tenant with the slug \`${intent.tenantSlug}\`. Please check the tenant name and try again.`,
      );
    }
    tenant = found;
  } else if (intent.tenantId != null || contextTenantId != null) {
    const id = intent.tenantId ?? contextTenantId!;
    try {
      tenant = getSupportTenant(id);
    } catch {
      return denial(
        'tenant_not_found',
        'Mình không tìm thấy tenant được chọn nữa.',
        'The selected tenant no longer exists.',
      );
    }
  } else {
    return denial(
      'tenant_required',
      'Bạn chưa nêu rõ tenant nào (ví dụ: `tren tenant acme`). Bạn gửi lại kèm tên tenant nhé.',
      'You did not specify which tenant (e.g. `on tenant acme`). Please send the request again with the tenant name.',
    );
  }

  const isOperator = isPlatformTenantOperator(liveUser);
  let actorTenantPermissions: TenantPermission[] = [];
  if (!isOperator) {
    try {
      const access = resolveEffectiveTenantAccess(liveUser, tenant.id);
      if (!tenantPermissionGranted(access.permissions, 'manage_tenant_members')) {
        return denial(
          'missing_permission:manage_tenant_members',
          `Tài khoản của bạn chưa có quyền \`manage_tenant_members\` trên tenant **${tenant.name}** nên mình không thể cấp hay thu hồi quyền thành viên ở đây.`,
          `Your account does not hold \`manage_tenant_members\` on tenant **${tenant.name}**, so I cannot grant or revoke member permissions there.`,
        );
      }
      actorTenantPermissions = access.permissions;
    } catch {
      return denial(
        'missing_permission:manage_tenant_members',
        `Tài khoản của bạn chưa có quyền \`manage_tenant_members\` trên tenant **${tenant.name}** nên mình không thể cấp hay thu hồi quyền thành viên ở đây.`,
        `Your account does not hold \`manage_tenant_members\` on tenant **${tenant.name}**, so I cannot grant or revoke member permissions there.`,
      );
    }
  }

  const db = getDb();
  const memberRow = db
    .prepare(
      'SELECT permissions_json FROM custom_tenant_memberships WHERE tenant_id = ? AND user_id = ?',
    )
    .get(tenant.id, target.id) as { permissions_json: string } | undefined;
  const previous: TenantPermission[] = memberRow
    ? parseStoredTenantPermissions(memberRow.permissions_json)
    : [];

  if (intent.action === 'revoke' && previous.length === 0) {
    return denial(
      'member_not_found',
      `Tài khoản \`${target.email}\` chưa phải thành viên của tenant **${tenant.name}** nên không có quyền nào để thu hồi.`,
      `Account \`${target.email}\` is not a member of tenant **${tenant.name}**, so there is nothing to revoke.`,
    );
  }

  let requested: TenantPermission[];
  if (intent.rolePreset) {
    if (intent.rolePreset === 'custom') {
      return denial(
        'invalid_input',
        'Vai trò `custom` cần liệt kê rõ từng quyền tenant — bạn gửi lại kèm danh sách quyền nhé.',
        'The `custom` role needs an explicit list of tenant permissions — please send the request again with the permission list.',
      );
    }
    requested = [...TENANT_ROLE_PRESETS[intent.rolePreset]];
  } else if (intent.removeMember) {
    requested = [...previous];
  } else {
    requested = [...new Set(intent.permissions)] as TenantPermission[];
  }
  if (requested.length === 0 && !intent.removeMember) {
    return denial(
      'invalid_input',
      'Bạn chưa nêu rõ quyền tenant nào cần cấp hay thu hồi (ví dụ: `view_tenant_ai`) hoặc vai trò (`viewer`, `support_operator`, `ai_configurator`).',
      'You did not specify which tenant permission to grant or revoke (e.g. `view_tenant_ai`) or role (`viewer`, `support_operator`, `ai_configurator`).',
    );
  }

  if (!isOperator) {
    if (!isTenantPermissionSubset(actorTenantPermissions, requested)) {
      return denial(
        'insufficient_privileges',
        'Bạn chỉ được cấp những quyền tenant mà chính bạn đang nắm giữ trên tenant này — mình không thể cấp quyền bạn không có.',
        'You can only grant tenant permissions you hold yourself on this tenant — I cannot grant a permission you do not have.',
      );
    }
    if (
      previous.length > 0 &&
      !isTenantPermissionSubset(actorTenantPermissions, previous)
    ) {
      return denial(
        'insufficient_privileges',
        'Tài khoản đích đang nắm quyền tenant rộng hơn phạm vi của bạn nên mình không thể thay đổi quyền của tài khoản đó.',
        'The target account holds broader tenant authority than you, so I cannot change its permissions.',
      );
    }
  }

  let newPermissions: TenantPermission[];
  if (intent.removeMember) {
    newPermissions = [];
  } else if (intent.action === 'grant') {
    newPermissions = intent.rolePreset
      ? [...requested]
      : unionPermissions(previous, requested) as TenantPermission[];
  } else {
    newPermissions = previous.filter((p) => !requested.includes(p));
  }

  if (
    tenantPermissionGranted(previous, 'manage_tenant_members') &&
    !tenantPermissionGranted(newPermissions, 'manage_tenant_members') &&
    !hasOtherTenantMemberManager(tenant.id, target.id)
  ) {
    return denial(
      'last_admin_protected',
      `Không thể gỡ quyền quản lý thành viên (\`manage_tenant_members\`) của tài khoản này vì đây là người quản lý thành viên cuối cùng trên tenant **${tenant.name}**. Hãy cấp quyền này cho một thành viên khác trước.`,
      `Cannot remove \`manage_tenant_members\` from this account — it is the last member manager on tenant **${tenant.name}**. Grant it to another member first.`,
    );
  }

  return {
    ok: true,
    grant: {
      scope: 'tenant',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantName: tenant.name,
      targetUserId: target.id,
      targetEmail: target.email,
      action: intent.action,
      permissions: requested,
      rolePreset: intent.rolePreset,
      removeMember: intent.removeMember ?? false,
      previousPermissions: previous,
      newPermissions,
    },
  };
}

/** One-line summary of a staged grant, for replies and the Consent Card. */
export function describePermissionGrant(grant: CopilotPermissionGrant, locale: 'vi' | 'en'): string {
  const scopeLabel =
    grant.scope === 'global'
      ? locale === 'vi'
        ? 'quyền toàn cục'
        : 'global permissions'
      : locale === 'vi'
        ? `quyền trên tenant **${grant.tenantName ?? grant.tenantSlug ?? grant.tenantId}**`
        : `permissions on tenant **${grant.tenantName ?? grant.tenantSlug ?? grant.tenantId}**`;
  const verb =
    grant.action === 'grant'
      ? locale === 'vi'
        ? 'Cấp'
        : 'Grant'
      : locale === 'vi'
        ? 'Thu hồi'
        : 'Revoke';
  const perms =
    grant.permissions.length > 0
      ? grant.permissions.map((p) => `\`${p}\``).join(', ')
      : grant.rolePreset
        ? locale === 'vi'
          ? `vai trò \`${grant.rolePreset}\``
          : `role \`${grant.rolePreset}\``
        : locale === 'vi'
          ? 'toàn bộ quyền thành viên'
          : 'all membership permissions';
  const previous = grant.previousPermissions.length > 0 ? grant.previousPermissions.join(', ') : '—';
  const next =
    grant.newPermissions.length > 0 ? grant.newPermissions.join(', ') : '—';
  return locale === 'vi'
    ? `• **${grant.targetEmail}** — ${verb} ${perms} (${scopeLabel}); hiện tại: ${previous} → sau khi duyệt: ${next}.`
    : `• **${grant.targetEmail}** — ${verb} ${perms} (${scopeLabel}); current: ${previous} → after approval: ${next}.`;
}

export function buildPermissionGrantSummary(
  grants: CopilotPermissionGrant[],
  locale: 'vi' | 'en',
): string {
  if (grants.length === 1) {
    return locale === 'vi'
      ? `Đề xuất thay đổi quyền cho ${grants[0]!.targetEmail}`
      : `Proposed permission change for ${grants[0]!.targetEmail}`;
  }
  return locale === 'vi'
    ? `Đề xuất thay đổi quyền cho ${grants.length} tài khoản`
    : `Proposed permission changes for ${grants.length} accounts`;
}

/** Persist a staged grant as a pending_consent proposal (no mutation). */
export function buildPermissionGrantProposal(params: {
  userId: number;
  grants: CopilotPermissionGrant[];
  locale: 'vi' | 'en';
}): SupportSetupProposal {
  const { userId, grants, locale } = params;
  const first = grants[0]!;
  const now = Date.now();
  return createSetupProposal({
    id: `prop_${crypto.randomUUID()}`,
    userId,
    targetMode: 'permission_grant',
    tenantId: first.scope === 'tenant' ? first.tenantId : null,
    tenantName:
      first.scope === 'tenant'
        ? (first.tenantName ?? first.tenantSlug ?? 'Tenant')
        : 'System Permissions',
    tenantSlug:
      first.scope === 'tenant' ? (first.tenantSlug ?? 'tenant') : 'system',
    status: 'pending_consent',
    summary: buildPermissionGrantSummary(grants, locale),
    requirements: {},
    steps: [],
    permissionGrants: grants,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SUPPORT_SETUP_PROPOSAL_TTL_SECONDS * 1000).toISOString(),
  });
}

function grantSuggestedQuickReplies(locale: 'vi' | 'en'): string[] {
  return locale === 'en'
    ? ['What are my permissions?', 'Guide me on configuring AI Support']
    : ['Tôi có quyền gì?', 'Hướng dẫn mình cấu hình AI Support'];
}

/**
 * Deterministic chat-turn handler for grant/revoke requests. Returns null
 * when the message is not a grant/revoke request (caller falls through to
 * the existing flow, including the sensitive-mutation refusal). Runs BEFORE
 * the system-settings pre-eval, so an authorized grant is never refused by
 * `detectSensitiveMutationCategory` — and an unauthorized one gets a
 * permission_denied reply instead of a staged proposal.
 */
export function handlePermissionGrantChatTurn(params: {
  user: SessionUser;
  scope: CopilotUserScope;
  messages: ReadonlyArray<{ role: string; content: string }>;
  tenantId?: number | null;
  locale: 'vi' | 'en';
}): SupportSetupChatResponse | null {
  const { user, scope, messages, tenantId, locale } = params;
  const latestRaw =
    [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!latestRaw.trim()) return null;
  const intent = matchPermissionGrantIntent(latestRaw);
  if (!intent) return null;

  const deniedReply = (auth: Extract<PermissionGrantAuthorization, { ok: false }>): SupportSetupChatResponse => ({
    ok: true,
    replyLocale: locale,
    reply: locale === 'vi' ? auth.messageVi : auth.messageEn,
    intent: 'guide',
    missingQuestions: [],
    suggestedQuickReplies: grantSuggestedQuickReplies(locale),
    proposal: null,
    modelUsed: null,
    usedFallback: true,
  });

  // Tenant not named: a single tenant the caller can manage is unambiguous;
  // zero or several candidates must ask — never guess.
  let resolvedTenantId = tenantId ?? null;
  if (intent.scope === 'tenant' && !intent.tenantSlug && resolvedTenantId == null) {
    const candidates = scope.tenants.filter(
      (t) =>
        isPlatformTenantOperator(user) ||
        tenantPermissionGranted(t.permissions, 'manage_tenant_members'),
    );
    if (candidates.length === 1) {
      resolvedTenantId = candidates[0]!.tenant.id;
    } else if (candidates.length === 0) {
      return deniedReply({
        ok: false,
        code: 'missing_permission:manage_tenant_members',
        messageVi:
          'Tài khoản của bạn chưa có quyền `manage_tenant_members` trên tenant nào nên mình không thể cấp hay thu hồi quyền thành viên.',
        messageEn:
          'Your account does not hold `manage_tenant_members` on any tenant, so I cannot grant or revoke member permissions.',
      });
    } else {
      const names = candidates.map((t) => `\`${t.tenant.slug}\``).join(', ');
      return {
        ok: true,
        replyLocale: locale,
        reply:
          locale === 'vi'
            ? `Bạn muốn cấp/thu hồi quyền trên tenant nào? Bạn đang quản lý ${candidates.length} tenant: ${names}. Bạn gửi lại kèm tên tenant nhé (ví dụ: \`tren tenant acme\`).`
            : `Which tenant do you mean? You manage ${candidates.length} tenants: ${names}. Please send the request again with the tenant name (e.g. \`on tenant acme\`).`,
        intent: 'guide',
        missingQuestions: [],
        suggestedQuickReplies: grantSuggestedQuickReplies(locale),
        proposal: null,
        modelUsed: null,
        usedFallback: true,
      };
    }
  }

  const auth = authorizePermissionGrant({
    user,
    intent,
    tenantId: resolvedTenantId,
  });
  if (!auth.ok) return deniedReply(auth);

  const saved = buildPermissionGrantProposal({
    userId: user.userId,
    grants: [auth.grant],
    locale,
  });
  const lines = [describePermissionGrant(auth.grant, locale)].join('\n');
  const reply =
    locale === 'vi'
      ? `Mình đã chuẩn bị sẵn đề xuất thay đổi quyền theo đúng yêu cầu của bạn:\n${lines}\n\nMình **chưa thay đổi gì cả** — bạn kiểm tra lại rồi bấm **Xác nhận áp dụng** khi đã sẵn sàng nhé!`
      : `I've prepared the permission change proposal based on your request:\n${lines}\n\nNothing has been changed yet — please review it and click **Approve & Apply** whenever you're ready!`;
  return {
    ok: true,
    replyLocale: locale,
    reply,
    intent: 'propose_setup',
    missingQuestions: [],
    suggestedQuickReplies: grantSuggestedQuickReplies(locale),
    proposal: saved,
    modelUsed: null,
    usedFallback: true,
  };
}

/**
 * Collect staged grants from an agent-loop run: only tool calls the gate
 * authorized and the handler staged (server-grounded) — never raw LLM text.
 */
export function collectStagedPermissionGrants(
  toolCalls: ReadonlyArray<{
    toolId: string;
    result: { status: string; result?: unknown };
  }>,
): CopilotPermissionGrant[] {
  const grants: CopilotPermissionGrant[] = [];
  for (const call of toolCalls) {
    if (!call.toolId.startsWith('permission.')) continue;
    if (call.result.status !== 'executed') continue;
    const payload = call.result.result;
    if (payload && typeof payload === 'object' && 'grant' in payload) {
      const grant = (payload as { grant: unknown }).grant;
      if (grant && typeof grant === 'object' && 'targetUserId' in grant) {
        grants.push(grant as CopilotPermissionGrant);
      }
    }
  }
  return grants;
}

/** Preset inferred for a tenant member's current grants (Consent Card display). */
export function inferGrantRolePreset(permissions: readonly string[]): TenantRolePresetId {
  return inferTenantRolePreset(permissions as TenantPermission[]);
}
