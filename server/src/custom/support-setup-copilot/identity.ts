/**
 * Permission-aware identity for the Setup Copilot (Phase 0 + Phase 1).
 *
 * The Copilot must KNOW who is logged in — their account role, global
 * permissions, and per-tenant rolePreset + permissions as granted by the
 * main ADMIN — and must answer identity questions ONLY from this
 * server-provided record, never from the LLM's own knowledge.
 *
 * Identity comes from the session user + the already-resolved
 * CopilotUserScope (users + custom_tenant_memberships). No new migration,
 * no new grants: this module only surfaces what apply-time enforcement
 * already checks. It never grants, revokes, or widens anything.
 */
import type { SupportSetupStepId } from '@freellmapi/shared/support-setup-copilot.js';
import { permissionGranted, type Permission } from '@freellmapi/shared/permissions.js';
import {
  TENANT_ROLE_PRESET_META,
  type TenantPermission,
  type TenantRolePresetId,
} from '@freellmapi/shared/tenant-rbac.js';
import type { SessionUser } from '../../services/auth.js';
import {
  mapTenantPermissionsToEditSteps,
  mapTenantPermissionsToViewSteps,
  type CopilotUserScope,
} from './diagnostics.js';

/**
 * GET /api/support-setup-copilot/whoami response — the caller's OWN data only.
 * NOTE: intentionally defined here instead of imported from
 * `@freellmapi/shared/support-setup-copilot.js`: in this worktree the server
 * resolves `@freellmapi/shared` through symlinked node_modules into the
 * sibling unified-key-hash worktree, so a new shared export is invisible to
 * the server toolchain until the PR branch is checked out fresh. Keep this
 * structurally identical to `CopilotWhoAmIResponse` in
 * shared/support-setup-copilot.ts (the client contract); CI on the PR branch
 * typechecks both against the same shared file.
 */
export interface CopilotWhoAmIResponse {
  ok: true;
  email: string;
  accountRole: 'admin' | 'member';
  isPrimary: boolean;
  isPlatformOperator: boolean;
  canCreateTenant: boolean;
  globalPermissions: string[];
  tenants: Array<{
    id: number;
    name: string;
    slug: string;
    rolePreset: string;
    permissions: string[];
    canViewSteps: SupportSetupStepId[];
    canEditSteps: SupportSetupStepId[];
  }>;
}
export interface CopilotTenantIdentity {
  id: number;
  name: string;
  slug: string;
  rolePreset: TenantRolePresetId;
  permissions: TenantPermission[];
  canViewSteps: SupportSetupStepId[];
  canEditSteps: SupportSetupStepId[];
}

export interface CopilotAgentContext {
  email: string;
  accountRole: 'admin' | 'member';
  isPrimary: boolean;
  /** Effective global permissions: ['*'] for primary admins / wildcard grants, else the stored list. */
  globalPermissions: Permission[];
  isPlatformOperator: boolean;
  canCreateTenant: boolean;
  /** ONLY tenants the caller can access (mirrors CopilotUserScope — never other users' tenants). */
  tenants: CopilotTenantIdentity[];
}

/**
 * Build the caller's identity from their session + resolved scope.
 * Returns null for anonymous/guest callers (no identity to report).
 */
export function buildCallerIdentity(
  user: SessionUser | undefined,
  scope: CopilotUserScope,
): CopilotAgentContext | null {
  if (!user || !user.userId) return null;
  return {
    email: user.email,
    accountRole: user.role,
    isPrimary: Boolean(user.isPrimary),
    globalPermissions: permissionGranted(user, '*') ? ['*'] : [...(user.permissions ?? [])],
    isPlatformOperator: scope.isPlatformOperator,
    canCreateTenant: scope.canCreateTenant,
    tenants: scope.tenants.map((entry) => ({
      id: entry.tenant.id,
      name: entry.tenant.name,
      slug: entry.tenant.slug,
      rolePreset: entry.rolePreset,
      permissions: [...entry.permissions],
      canViewSteps: [...entry.canViewSteps],
      canEditSteps: [...entry.canEditSteps],
    })),
  };
}

/** Identity for a tenant entry built directly from raw grants (used by unit tests / fallbacks). */
export function buildTenantIdentity(
  tenant: { id: number; name: string; slug: string },
  rolePreset: TenantRolePresetId,
  permissions: readonly TenantPermission[],
): CopilotTenantIdentity {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    rolePreset,
    permissions: [...permissions],
    canViewSteps: [...mapTenantPermissionsToViewSteps(permissions)],
    canEditSteps: [...mapTenantPermissionsToEditSteps(permissions)],
  };
}

export function tenantRolePresetTitle(rolePreset: TenantRolePresetId): string {
  if (rolePreset === 'custom') return 'Custom';
  return (
    TENANT_ROLE_PRESET_META.find((m) => m.id === rolePreset)?.title ?? rolePreset
  );
}

function formatPermissionList(permissions: readonly string[]): string {
  return permissions.length === 0 ? 'none' : permissions.join(', ');
}

function formatStepList(steps: readonly SupportSetupStepId[]): string {
  return steps.length === 0 ? 'none' : steps.join(', ');
}

/**
 * Trusted identity block injected into the LLM coach system prompt.
 * The model must only repeat this identity — never infer or extend it.
 */
export function buildIdentityPromptBlock(context: CopilotAgentContext): string {
  const lines: string[] = [
    'SERVER-PROVIDED CALLER IDENTITY — TRUSTED, DO NOT INFER OR EXTEND:',
    `- Caller: ${context.email} (account role: ${context.accountRole}; primary account: ${context.isPrimary ? 'yes' : 'no'}).`,
    `- Platform operator: ${context.isPlatformOperator ? 'yes' : 'no'}. Can create Support Tenants: ${context.canCreateTenant ? 'yes' : 'no'}.`,
    `- Global permissions: ${context.globalPermissions.includes('*') ? '* (full access)' : formatPermissionList(context.globalPermissions)}.`,
  ];
  if (context.tenants.length === 0) {
    lines.push('- Support Tenants: none — this caller has no Support Tenant access.');
  } else {
    lines.push(`- Support Tenants (${context.tenants.length}):`);
    for (const tenant of context.tenants) {
      lines.push(
        `  - "${tenant.name}" (${tenant.slug}): role ${tenantRolePresetTitle(tenant.rolePreset)} (${tenant.rolePreset}); ` +
          `permissions: ${formatPermissionList(tenant.permissions)}; ` +
          `can view steps: ${formatStepList(tenant.canViewSteps)}; ` +
          `can edit steps: ${formatStepList(tenant.canEditSteps)}.`,
      );
    }
  }
  lines.push(
    '- RULES: Only repeat the identity above. Never invent permissions, roles, or tenant access that is not listed here. ' +
      'If the user asks about a permission they do not have, say so plainly and tell them only the main ADMIN can grant it. ' +
      'Never claim the user is an admin, owner, or platform operator unless listed above.',
  );
  return lines.join('\n');
}

/**
 * Account-only identity block for LLM prompts built without a tenant scope
 * (e.g. direct buildHumanCoachSystemPrompt callers). Deliberately states
 * that per-tenant roles were NOT provided, so the model cannot infer them.
 */
export function buildAccountOnlyIdentityBlock(user: SessionUser): string {
  const globalPermissions = permissionGranted(user, '*')
    ? '* (full access)'
    : formatPermissionList(user.permissions ?? []);
  return [
    'SERVER-PROVIDED CALLER IDENTITY — TRUSTED, DO NOT INFER OR EXTEND:',
    `- Caller: ${user.email} (account role: ${user.role}; primary account: ${user.isPrimary ? 'yes' : 'no'}).`,
    `- Global permissions: ${globalPermissions}.`,
    '- Per-tenant roles: not provided to this prompt — do not infer tenant permissions or tenant access.',
    '- RULES: Only repeat the identity above. Never invent permissions, roles, or tenant access that is not listed here.',
  ].join('\n');
}

/** Deterministic, DB-grounded answer to "what is my role / what are my permissions". */
export function buildIdentityReply(
  context: CopilotAgentContext,
  locale: 'vi' | 'en',
): string {
  const accountRoleVi =
    context.accountRole === 'admin'
      ? context.isPrimary
        ? 'Quản trị viên chính (Primary Admin)'
        : 'Quản trị viên (Admin)'
      : 'Thành viên (Member)';
  const accountRoleEn =
    context.accountRole === 'admin'
      ? context.isPrimary
        ? 'Primary Admin'
        : 'Admin'
      : 'Member';

  if (locale === 'vi') {
    const lines: string[] = [
      `Bạn đang đăng nhập với **${context.email}**.`,
      `- Vai trò tài khoản: **${accountRoleVi}**`,
      `- Vận hành nền tảng (Platform Operator): **${context.isPlatformOperator ? 'Có' : 'Không'}**`,
      `- Tạo Support Tenant mới: **${context.canCreateTenant ? 'Được' : 'Không'}**`,
      `- Quyền toàn cục: ${context.globalPermissions.includes('*') ? '**Toàn quyền (*)**' : formatPermissionList(context.globalPermissions)}`,
    ];
    if (context.tenants.length === 0) {
      lines.push(
        '- Tenant: bạn hiện **chưa được phân quyền trên tenant nào**, nên Copilot chỉ hỗ trợ các thao tác cá nhân (chẩn đoán lỗi, Personal API Key). Muốn được cấp quyền trên tenant nào, bạn liên hệ ADMIN chính nhé.',
      );
    } else {
      lines.push(`- Tenant được phân quyền (${context.tenants.length}):`);
      for (const tenant of context.tenants) {
        lines.push(
          `  • **${tenant.name}** (\`${tenant.slug}\`) — vai trò **${tenantRolePresetTitle(tenant.rolePreset)}**; quyền: ${formatPermissionList(tenant.permissions)}; xem được: ${formatStepList(tenant.canViewSteps)}; sửa được: ${formatStepList(tenant.canEditSteps)}.`,
        );
      }
      lines.push(
        'Mình chỉ thực thi đúng trong phạm vi quyền trên — mục nào bạn chưa có quyền thì mình sẽ từ chối và không tự ý thay đổi.',
      );
    }
    return lines.join('\n');
  }

  const lines: string[] = [
    `You are signed in as **${context.email}**.`,
    `- Account role: **${accountRoleEn}**`,
    `- Platform operator: **${context.isPlatformOperator ? 'Yes' : 'No'}**`,
    `- Can create new Support Tenants: **${context.canCreateTenant ? 'Yes' : 'No'}**`,
    `- Global permissions: ${context.globalPermissions.includes('*') ? '**Full access (*)**' : formatPermissionList(context.globalPermissions)}`,
  ];
  if (context.tenants.length === 0) {
    lines.push(
      '- Tenants: you currently **have no role on any tenant**, so the Copilot can only help with personal actions (error diagnostics, Personal API Keys). To get tenant access, please ask the main ADMIN.',
    );
  } else {
    lines.push(`- Assigned tenants (${context.tenants.length}):`);
    for (const tenant of context.tenants) {
      lines.push(
        `  • **${tenant.name}** (\`${tenant.slug}\`) — role **${tenantRolePresetTitle(tenant.rolePreset)}**; permissions: ${formatPermissionList(tenant.permissions)}; can view: ${formatStepList(tenant.canViewSteps)}; can edit: ${formatStepList(tenant.canEditSteps)}.`,
      );
    }
    lines.push(
      'I only act within the permissions above — anything outside that scope I will refuse rather than change on my own.',
    );
  }
  return lines.join('\n');
}

export function identitySuggestedQuickReplies(locale: 'vi' | 'en'): string[] {
  return locale === 'vi'
    ? ['Hướng dẫn tôi chi tiết từng bước để có 1 con AI Support hoàn chỉnh']
    : ['How do I set up a complete AI Support assistant step by step?'];
}

/** whoami payload: the caller's own data only, derived from their scope. */
export function buildWhoAmIResponse(context: CopilotAgentContext): CopilotWhoAmIResponse {
  return {
    ok: true,
    email: context.email,
    accountRole: context.accountRole,
    isPrimary: context.isPrimary,
    isPlatformOperator: context.isPlatformOperator,
    canCreateTenant: context.canCreateTenant,
    globalPermissions: [...context.globalPermissions],
    tenants: context.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      rolePreset: t.rolePreset,
      permissions: [...t.permissions],
      canViewSteps: [...t.canViewSteps],
      canEditSteps: [...t.canEditSteps],
    })),
  };
}
