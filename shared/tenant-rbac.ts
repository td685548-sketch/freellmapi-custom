/** Single source of truth for per-Support-Tenant RBAC permissions, presets, and UI descriptions. */

export const TENANT_PERMISSION_GROUPS = [
  {
    key: 'tenant_ai_config',
    title: 'AI Behavior & Model',
    description: 'Configure default model, system prompt, guest access, end-user roles, and test chat.',
    children: [
      {
        key: 'view_tenant_ai',
        title: 'View AI configuration',
        description: 'View tenant display settings, default model, system prompt, and end-user role rules.',
      },
      {
        key: 'edit_tenant_ai',
        title: 'Edit AI configuration',
        description: 'Change display name, default model, system prompt, guest flag, enabled status, and role rules.',
      },
      {
        key: 'test_tenant_ai',
        title: 'Test AI sandbox',
        description: 'Simulate chat turns and mint test context tokens in the tenant sandbox.',
      },
    ],
  },
  {
    key: 'tenant_knowledge',
    title: 'Knowledge Base & Masking',
    description: 'Manage RAG documents and PII masking policies for this tenant.',
    children: [
      {
        key: 'view_tenant_knowledge',
        title: 'View knowledge & masking',
        description: 'Read tenant knowledge articles, masking rules, and run retrieval search tests.',
      },
      {
        key: 'edit_tenant_knowledge',
        title: 'Edit knowledge & masking',
        description: 'Create, update, seed, and delete knowledge articles and change PII masking rules.',
      },
    ],
  },
  {
    key: 'tenant_tools',
    title: 'Webhook Tools & Data Sources',
    description: 'Connect and test external webhooks and read-only SQL data sources.',
    children: [
      {
        key: 'view_tenant_tools',
        title: 'View tools & DB sources',
        description: 'View webhook tools and database sources with credentials masked.',
      },
      {
        key: 'edit_tenant_tools',
        title: 'Edit tools & DB sources',
        description: 'Create, edit, and delete webhook tools, database sources, and table access policies.',
      },
      {
        key: 'test_tenant_tools',
        title: 'Test tools & DB queries',
        description: 'Invoke webhook tool tests and execute read-only SQL query tests.',
      },
    ],
  },
  {
    key: 'tenant_guardrails',
    title: 'Guardrails & Output Controls',
    description: 'Enforce prompt-injection firewalls, topic filters, role quotas, and output redaction.',
    children: [
      {
        key: 'view_tenant_guardrails',
        title: 'View guardrails & output rules',
        description: 'View input firewall rules, role quotas, output control rules, events, and previews.',
      },
      {
        key: 'edit_tenant_guardrails',
        title: 'Edit guardrails & output rules',
        description: 'Update firewall rules, role quotas, output control policies, and reset user quotas.',
      },
    ],
  },
  {
    key: 'tenant_desk',
    title: 'Widget & Service Desk',
    description: 'Operate customer support threads, tickets, action approvals, widget UI, and SLA rules.',
    children: [
      {
        key: 'view_tenant_desk',
        title: 'View service desk & widget',
        description: 'Read customer conversations, escalation tickets, pending actions, widget config, and SLA rules.',
      },
      {
        key: 'reply_tenant_desk',
        title: 'Reply & approve actions',
        description: 'Send human replies, update ticket status/priority, and approve or reject AI actions.',
      },
      {
        key: 'edit_tenant_widget',
        title: 'Customize widget & SLA',
        description: 'Edit embeddable widget appearance, intake fields, SLA targets, and routing rules.',
      },
    ],
  },
  {
    key: 'tenant_integration',
    title: 'Integration, Domains & Secrets',
    description: 'Manage embed snippets, CORS origins, runtime limits, partner webhooks, and signing secret.',
    children: [
      {
        key: 'view_tenant_integration',
        title: 'View integration & domains',
        description: 'View public key, embed snippet, allowed origins, runtime bounds, and outbound webhooks.',
      },
      {
        key: 'edit_tenant_integration',
        title: 'Edit integration & webhooks',
        description: 'Update allowed CORS origins, runtime policy bounds, and outbound partner webhooks.',
      },
      {
        key: 'rotate_tenant_secret',
        title: 'Rotate signing secret',
        description: 'Rotate the tenant sk_sup_… HMAC signing secret used by partner backends.',
      },
    ],
  },
  {
    key: 'tenant_members',
    title: 'Team & Delegated Permissions',
    description: 'Manage team members and sub-admin grants within this tenant.',
    children: [
      {
        key: 'view_tenant_members',
        title: 'View tenant team',
        description: 'List accounts assigned to this tenant and see their effective permissions.',
      },
      {
        key: 'manage_tenant_members',
        title: 'Manage tenant team',
        description: 'Add, update, or remove members within your own permission scope on this tenant.',
      },
    ],
  },
  {
    key: 'tenant_analytics',
    title: 'Analytics, CSAT & History',
    description: 'Inspect support performance, customer satisfaction ratings, and change audit log.',
    children: [
      {
        key: 'view_tenant_analytics',
        title: 'View analytics & audit log',
        description: 'Read deflection metrics, CSAT scores, and per-tenant configuration change logs.',
      },
    ],
  },
] as const;

export type TenantParentPermission = (typeof TENANT_PERMISSION_GROUPS)[number]['key'];
export type TenantChildPermission = (typeof TENANT_PERMISSION_GROUPS)[number]['children'][number]['key'];
export type TenantPermission = TenantParentPermission | TenantChildPermission | '*';

export const TENANT_PERMISSIONS = TENANT_PERMISSION_GROUPS.flatMap((g) => [
  g.key,
  ...g.children.map((c) => c.key),
]) as [Exclude<TenantPermission, '*'>, ...Exclude<TenantPermission, '*'>[]];

const KNOWN_TENANT_PERMISSIONS = new Set<string>([...TENANT_PERMISSIONS, '*']);
const GROUP_BY_PARENT = new Map<string, (typeof TENANT_PERMISSION_GROUPS)[number]>(
  TENANT_PERMISSION_GROUPS.map((g) => [g.key, g]),
);
const PARENT_BY_CHILD = new Map<string, TenantParentPermission>();
for (const group of TENANT_PERMISSION_GROUPS) {
  for (const child of group.children) {
    PARENT_BY_CHILD.set(child.key, group.key);
  }
}

export type TenantRolePresetId =
  | 'tenant_owner'
  | 'ai_configurator'
  | 'support_operator'
  | 'viewer'
  | 'custom';

export const TENANT_ROLE_PRESETS: Record<
  Exclude<TenantRolePresetId, 'custom'>,
  readonly TenantPermission[]
> = {
  tenant_owner: ['*'],
  ai_configurator: [
    'tenant_ai_config',
    'tenant_knowledge',
    'tenant_tools',
    'tenant_guardrails',
    'edit_tenant_widget',
    'view_tenant_desk',
    'view_tenant_integration',
    'view_tenant_analytics',
  ],
  support_operator: [
    'view_tenant_ai',
    'test_tenant_ai',
    'view_tenant_knowledge',
    'tenant_desk',
    'view_tenant_analytics',
  ],
  viewer: [
    'view_tenant_ai',
    'view_tenant_knowledge',
    'view_tenant_tools',
    'view_tenant_guardrails',
    'view_tenant_desk',
    'view_tenant_integration',
    'view_tenant_members',
    'view_tenant_analytics',
  ],
};

export const TENANT_ROLE_PRESET_META: ReadonlyArray<{
  id: Exclude<TenantRolePresetId, 'custom'>;
  title: string;
  description: string;
}> = [
  {
    id: 'tenant_owner',
    title: 'Tenant Owner',
    description: 'Full control over this tenant, including secret rotation and team delegation.',
  },
  {
    id: 'ai_configurator',
    title: 'AI Configurator',
    description: 'Edit AI model, system prompt, knowledge base, tools, guardrails, and widget.',
  },
  {
    id: 'support_operator',
    title: 'Support Operator',
    description: 'Handle customer conversations, escalation tickets, and AI action approvals.',
  },
  {
    id: 'viewer',
    title: 'Viewer (Read-Only)',
    description: 'Inspect AI settings, knowledge, tools, guardrails, desk, and analytics without editing.',
  },
];

export function isKnownTenantPermission(value: unknown): value is TenantPermission {
  return typeof value === 'string' && KNOWN_TENANT_PERMISSIONS.has(value);
}

export function normalizeTenantPermissions(raw: readonly string[]): TenantPermission[] {
  const valid = raw.filter((p): p is TenantPermission => KNOWN_TENANT_PERMISSIONS.has(p));
  if (valid.includes('*')) return ['*'];
  return [...new Set(valid)];
}

export function parseStoredTenantPermissions(raw: string | null | undefined): TenantPermission[] {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeTenantPermissions(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return [];
  }
}

export function tenantPermissionGranted(
  grants: readonly string[] | undefined,
  permission: TenantPermission,
): boolean {
  if (!grants || grants.length === 0) return false;
  if (grants.includes('*')) return true;
  if (permission === '*') return false;
  if (grants.includes(permission)) return true;

  const group = GROUP_BY_PARENT.get(permission);
  if (group) {
    return group.children.every((child) => grants.includes(child.key));
  }

  const parent = PARENT_BY_CHILD.get(permission);
  return parent ? grants.includes(parent) : false;
}

export function tenantPermissionGroupVisible(
  grants: readonly string[] | undefined,
  parent: TenantParentPermission,
): boolean {
  if (tenantPermissionGranted(grants, parent)) return true;
  const group = GROUP_BY_PARENT.get(parent);
  return Boolean(group?.children.some((child) => tenantPermissionGranted(grants, child.key)));
}

export function isTenantPermissionSubset(
  actorGrants: readonly string[] | undefined,
  targetGrants: readonly TenantPermission[],
): boolean {
  return targetGrants.every((p) => tenantPermissionGranted(actorGrants, p));
}

export function expandTenantChildPermissions(
  grants: readonly string[] | undefined,
): Set<TenantChildPermission> {
  const result = new Set<TenantChildPermission>();
  if (!grants || grants.length === 0) return result;
  for (const group of TENANT_PERMISSION_GROUPS) {
    for (const child of group.children) {
      if (tenantPermissionGranted(grants, child.key)) {
        result.add(child.key);
      }
    }
  }
  return result;
}

export function inferTenantRolePreset(grants: readonly TenantPermission[]): TenantRolePresetId {
  if (grants.includes('*')) return 'tenant_owner';
  const actual = expandTenantChildPermissions(grants);
  if (actual.size === 0) return 'custom';

  for (const presetId of ['ai_configurator', 'support_operator', 'viewer'] as const) {
    const presetExpanded = expandTenantChildPermissions(TENANT_ROLE_PRESETS[presetId]);
    if (
      presetExpanded.size === actual.size &&
      [...presetExpanded].every((p) => actual.has(p))
    ) {
      return presetId;
    }
  }
  return 'custom';
}

export function toggleTenantPermissionSelection(
  selected: ReadonlySet<TenantPermission>,
  key: TenantPermission,
): Set<TenantPermission> {
  const parents = TENANT_PERMISSION_GROUPS.map((g) => g.key);
  if (key === '*') {
    return selected.has('*') ? new Set<TenantPermission>(parents) : new Set<TenantPermission>(['*']);
  }
  const next = selected.has('*')
    ? new Set<TenantPermission>(parents)
    : new Set<TenantPermission>(selected);
  const group = TENANT_PERMISSION_GROUPS.find(
    (g) => g.key === key || g.children.some((c) => c.key === key),
  );
  if (!group) return next;
  if (key === group.key) {
    const all = next.has(group.key) || group.children.every((c) => next.has(c.key));
    next.delete(group.key);
    for (const child of group.children) next.delete(child.key);
    if (!all) next.add(group.key);
  } else if (next.has(group.key)) {
    next.delete(group.key);
    for (const child of group.children) next.add(child.key);
    next.delete(key);
  } else if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export interface TenantMembershipSummary {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  tenantEnabled: boolean;
  rolePreset: TenantRolePresetId;
  permissions: TenantPermission[];
  updatedAt: string;
}

export interface TenantMemberRecord {
  id: number;
  tenantId: number;
  userId: number;
  email: string;
  accountRole: 'admin' | 'member';
  isPrimary: boolean;
  rolePreset: TenantRolePresetId;
  permissions: TenantPermission[];
  assignedBy: number | null;
  createdAt: string;
  updatedAt: string;
  isSelf: boolean;
}

export interface TenantPortalSummary {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  defaultModel: string;
  enabled: boolean;
  allowGuest: boolean;
  rolePreset: TenantRolePresetId;
  permissions: TenantPermission[];
  isPlatformOperator: boolean;
}

export interface TenantModelOption {
  id: string;
  label: string;
  description: string;
  strategy?: string;
}
