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
    { key: "view_token_budget", title: "View token budget", description: "See the Monthly token budget card on the Models page: remaining and used tokens per model." },
    { key: "view_audit_log", title: "View change history", description: "See who changed limits, keys, permissions and settings on the dashboard, and when." },
  ] },
  { key: "view_usage", title: "Usage ranking", description: "Compare traffic and speed across accounts and client keys.", children: [
    { key: "view_usage_accounts", title: "View account ranking", description: "See every account's email with its request, token, error and latency figures." },
    { key: "view_usage_profiles", title: "View client key ranking", description: "See every client profile's name with its request, token, error and latency figures." },
  ] },
  { key: "manage_x_gateway", title: "Thruline (9Router)", description: "Admin-only gateway with combos and token savers.", children: [
    { key: "use_x_gateway", title: "Use Thruline", description: "Use Thruline and open its console." },
    { key: "edit_x_combos", title: "Manage combos", description: "Create, edit, reorder and delete combos." },
    { key: "edit_x_settings", title: "Configure gateway", description: "Switch the gateway on or off and change default savers." },
    { key: "view_x_usage", title: "View gateway usage", description: "Read the Thruline usage view." },
  ] },
  { key: "manage_ai_platform", title: "AI Platform", description: "Manage AI platform flags, prompts, semantic retrieval, prompt cache, MCP tools, output guard and agent flows.", children: [
    { key: "view_ai_platform", title: "View AI platform", description: "View AI platform overview, pillar flags and retention settings." },
    { key: "edit_ai_flags", title: "Edit AI flags", description: "Toggle AI platform pillars and update retention settings." },
    { key: "view_prompts", title: "View prompts", description: "View versioned system prompts, diffs and variable catalog." },
    { key: "edit_prompts", title: "Edit prompts", description: "Save prompt drafts and preview rendered templates." },
    { key: "publish_prompts", title: "Publish prompts", description: "Publish prompt drafts and restore previous versions." },
    { key: "view_retrieval", title: "View semantic retrieval", description: "View retrieval settings, index status and test queries." },
    { key: "edit_retrieval", title: "Edit semantic retrieval", description: "Change retrieval configuration and trigger reindexing." },
    { key: "view_prompt_cache", title: "View prompt cache", description: "View prompt cache settings, capabilities and savings stats." },
    { key: "edit_prompt_cache", title: "Edit prompt cache", description: "Configure prompt cache settings and capability overrides." },
    { key: "view_mcp_servers", title: "View MCP servers", description: "View registered MCP servers, tools, bindings and call logs." },
    { key: "edit_mcp_servers", title: "Edit MCP servers", description: "Register, update, test, sync and delete MCP servers." },
    { key: "review_mcp_tools", title: "Review MCP tools", description: "Approve or block MCP tools and manage scope bindings." },
    { key: "view_output_guard", title: "View output guard", description: "View output guard policies, events and run policy tests." },
    { key: "edit_output_guard", title: "Edit output guard", description: "Create and update output guard policies." },
    { key: "view_guard_excerpts", title: "View guard excerpts", description: "Decrypt and inspect flagged output guard excerpts." },
    { key: "view_flows", title: "View flows", description: "View agents, flows and client key grants." },
    { key: "edit_flows", title: "Edit flows", description: "Create, update and delete agents and flow drafts." },
    { key: "publish_flows", title: "Publish flows", description: "Publish flows and grant them to client keys." },
    { key: "view_flow_runs", title: "View flow runs", description: "Inspect orchestrator run traces and steps." },
    { key: "cancel_flow_runs", title: "Cancel flow runs", description: "Cancel active orchestrator runs." },
    { key: "approve_ai_actions", title: "Approve AI actions", description: "Approve or reject pending sensitive tool executions." },
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
