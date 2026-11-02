/** Single source of truth for permission names, hierarchy and UI descriptions. */
export const PERMISSION_GROUPS = [
  { key: "manage_keys", title: "Provider keys", description: "Manage upstream credentials and their models.", children: [
    { key: "view_keys", title: "View keys", description: "View masked API key values, stored endpoint URLs and health metadata." },
    { key: "add_keys", title: "Add keys", description: "Add new credentials. Custom model registration also requires Manage provider models." },
    { key: "import_keys", title: "Import keys and models", description: "Import files or batches; may update existing endpoint credentials and model configuration." },
    { key: "edit_keys", title: "Edit keys", description: "Change credentials, labels, scopes, quotas and enabled state." },
    { key: "delete_keys", title: "Delete keys", description: "Remove stored provider credentials." },
    { key: "test_keys", title: "Test keys", description: "Probe providers, check health and reset cooldowns." },
    { key: "reveal_keys", title: "Reveal keys", description: "Reveal a credential after existing password verification." },
    { key: "export_keys", title: "Export keys", description: "Download provider credentials after password verification." },
    { key: "manage_key_models", title: "Manage provider models", description: "Discover/register models and change modality catalogs." },
  ] },
  { key: "manage_users", title: "Users and roles", description: "Manage accounts and delegated privileges.", children: [
    { key: "view_users", title: "View accounts", description: "List accounts, sessions and usage." },
    { key: "edit_user_roles", title: "Change roles", description: "Administrators only: change roles without granting authority beyond your own." },
    { key: "edit_user_permissions", title: "Assign permissions", description: "Assign only permissions you hold; never edit your own grants." },
    { key: "edit_user_quotas", title: "Edit user quotas", description: "Change member request limits." },
    { key: "revoke_user_sessions", title: "Revoke sessions", description: "Sign an account out of all devices." },
    { key: "revoke_user_keys", title: "Revoke personal keys", description: "Revoke an account's personal gateway tokens." },
  ] },
  { key: "manage_invites", title: "Invites", description: "Manage registration invitation codes.", children: [
    { key: "view_invites", title: "View invites", description: "List and copy invite codes." },
    { key: "create_invites", title: "Create invites", description: "Generate invitation codes." },
    { key: "revoke_invites", title: "Revoke invites", description: "Disable existing invitation codes." },
  ] },
  { key: "manage_requests", title: "Registration requests", description: "Review pending registrations.", children: [
    { key: "view_requests", title: "View requests", description: "List pending registration requests." },
    { key: "approve_requests", title: "Approve requests", description: "Approve registration and create a member account." },
    { key: "reject_requests", title: "Reject requests", description: "Reject pending registration requests." },
  ] },
  { key: "manage_settings", title: "System settings and cache", description: "Configure this installation.", children: [
    { key: "view_settings", title: "View system settings", description: "Read noncredential configuration, excluding gateway and proxy credentials." },
    { key: "reveal_proxy_credentials", title: "View proxy configuration and credentials", description: "Read the full configured proxy URL, which may contain passwords or access tokens." },
    { key: "edit_settings", title: "Edit system settings", description: "Change system configuration and proxy settings." },
    { key: "manage_routing", title: "Manage routing", description: "Change routing, profiles, models and premium configuration." },
    { key: "manage_compression", title: "Manage compression", description: "Change prompt compression configuration." },
    { key: "view_client_profiles", title: "View client profiles", description: "View masked client profiles and their configured system prompts." },
    { key: "edit_client_profiles", title: "Edit client profiles", description: "Create, edit, rotate and delete client profiles." },
    { key: "manage_updates", title: "Manage updates", description: "Check for and install application updates." },
    { key: "reveal_gateway_key", title: "View gateway master key", description: "Read installation-wide inference credentials and URL tokens." },
    { key: "rotate_gateway_key", title: "Rotate gateway master key", description: "Replace the gateway credential, or issue/revoke URL tokens." },
    { key: "view_cache", title: "View response cache", description: "View cache configuration and statistics." },
    { key: "edit_cache", title: "Configure response cache", description: "Enable/disable cache and choose persistence." },
    { key: "clear_cache", title: "Clear response cache", description: "Remove cached model responses." },
  ] },
  { key: "manage_backups", title: "Backups", description: "Manage database snapshots and schedules.", children: [
    { key: "view_backups", title: "View backups", description: "List snapshots, tables and schedules." },
    { key: "create_backups", title: "Create backups", description: "Create database snapshots." },
    { key: "download_backups", title: "Download backups", description: "Download snapshots, which may contain sensitive data." },
    { key: "restore_backups", title: "Restore backups", description: "Restore a snapshot and replace current database data." },
    { key: "delete_backups", title: "Delete backups", description: "Delete stored snapshots." },
    { key: "schedule_backups", title: "Schedule backups", description: "Change automatic backup schedules." },
  ] },
  { key: "view_logs", title: "Logs and analytics", description: "Access operational diagnostics.", children: [
    { key: "view_server_logs", title: "View server logs", description: "Read redacted server diagnostic messages." },
    { key: "clear_server_logs", title: "Clear server logs", description: "Delete retained server logs." },
    { key: "view_analytics", title: "View analytics", description: "Read usage statistics, routing metrics and provider tiers." },
  ] },
 ] as const;
export type ParentPermission = typeof PERMISSION_GROUPS[number]['key'];
export type ChildPermission = typeof PERMISSION_GROUPS[number]['children'][number]['key'];
export type Permission = ParentPermission | ChildPermission | '*';
export const SYSTEM_PERMISSIONS = PERMISSION_GROUPS.flatMap(g => [g.key, ...g.children.map(c => c.key)]) as [Exclude<Permission, '*'>, ...Exclude<Permission, '*'>[]];
const known = new Set<string>([...SYSTEM_PERMISSIONS, '*']);
export interface PermissionSubject { role?: string; isPrimary?: boolean; permissions?: readonly string[] }

export function permissionGranted(user: PermissionSubject | null | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.isPrimary || (user.role === 'admin' && user.permissions === undefined) || user.permissions?.includes('*')) return true;
  if (user.permissions?.includes(permission)) return true;
  return PERMISSION_GROUPS.some(g => g.children.some(c => c.key === permission) && user.permissions?.includes(g.key));
}
/** Navigation only: a child opens a section, never authorizes the parent's API. */
export function permissionGroupVisible(user: PermissionSubject | null | undefined, parent: ParentPermission): boolean {
  return permissionGranted(user, parent) || !!PERMISSION_GROUPS.find(g => g.key === parent)?.children.some(c => permissionGranted(user, c.key));
}
export function parseStoredPermissions(raw: string | null | undefined, role: string, primary: boolean): Permission[] {
  if (primary || (role === 'admin' && (raw === null || raw === undefined || raw.trim() === ''))) return ['*'];
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter((p): p is Permission => typeof p === 'string' && known.has(p)) : [];
  } catch { return []; }
}
