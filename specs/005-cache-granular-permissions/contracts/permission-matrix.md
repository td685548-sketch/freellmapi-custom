# Permission matrix and operator recipes

Parent grants imply all children; children do not imply the parent or siblings. The primary account always holds wildcard authority. Secondary admins obey explicit lists; existing wildcard grants stay full.

## Provider keys (`manage_keys`)

| Action | Grant | Scope |
| --- | --- | --- |
| View keys | `view_keys` | View masked API key values, stored endpoint URLs and health metadata. |
| Add keys | `add_keys` | Add new credentials. Custom model registration also requires Manage provider models. |
| Import keys and models | `import_keys` | Import files or batches; may update existing endpoint credentials and model configuration. |
| Edit keys | `edit_keys` | Change credentials, labels, scopes, quotas and enabled state. |
| Delete keys | `delete_keys` | Remove stored provider credentials. |
| Test keys | `test_keys` | Probe providers, check health and reset cooldowns. |
| Reveal keys | `reveal_keys` | Reveal a credential after existing password verification. |
| Export keys | `export_keys` | Download provider credentials after password verification. |
| Manage provider models | `manage_key_models` | Discover/register models and change modality catalogs. |

## Users and roles (`manage_users`)

| Action | Grant | Scope |
| --- | --- | --- |
| View accounts | `view_users` | List accounts, sessions and usage. |
| Change roles | `edit_user_roles` | Administrators only: change roles without granting authority beyond your own. |
| Assign permissions | `edit_user_permissions` | Assign only permissions you hold; never edit your own grants. |
| Edit user quotas | `edit_user_quotas` | Change member request limits. |
| Revoke sessions | `revoke_user_sessions` | Sign an account out of all devices. |
| Revoke personal keys | `revoke_user_keys` | Revoke an account's personal gateway tokens. |

## Invites (`manage_invites`)

| Action | Grant | Scope |
| --- | --- | --- |
| View invites | `view_invites` | List and copy invite codes. |
| Create invites | `create_invites` | Generate invitation codes. |
| Revoke invites | `revoke_invites` | Disable existing invitation codes. |

## Registration requests (`manage_requests`)

| Action | Grant | Scope |
| --- | --- | --- |
| View requests | `view_requests` | List pending registration requests. |
| Approve requests | `approve_requests` | Approve registration and create a member account. |
| Reject requests | `reject_requests` | Reject pending registration requests. |

## System settings and cache (`manage_settings`)

| Action | Grant | Scope |
| --- | --- | --- |
| View system settings | `view_settings` | Read noncredential configuration, excluding gateway and proxy credentials. |
| View proxy configuration and credentials | `reveal_proxy_credentials` | Read the full configured proxy URL, which may contain passwords or access tokens. |
| Edit system settings | `edit_settings` | Change system configuration and proxy settings. |
| Manage routing | `manage_routing` | Change routing, profiles, models and premium configuration. |
| Manage compression | `manage_compression` | Change prompt compression configuration. |
| View client profiles | `view_client_profiles` | View masked client profiles and their configured system prompts. |
| Edit client profiles | `edit_client_profiles` | Create, edit, rotate and delete client profiles. |
| Manage updates | `manage_updates` | Check for and install application updates. |
| View gateway master key | `reveal_gateway_key` | Read installation-wide inference credentials and URL tokens. |
| Rotate gateway master key | `rotate_gateway_key` | Replace the gateway credential, or issue/revoke URL tokens. |
| View response cache | `view_cache` | View cache configuration and statistics. |
| Configure response cache | `edit_cache` | Enable/disable cache and choose persistence. |
| Clear response cache | `clear_cache` | Remove cached model responses. |

## Backups (`manage_backups`)

| Action | Grant | Scope |
| --- | --- | --- |
| View backups | `view_backups` | List snapshots, tables and schedules. |
| Create backups | `create_backups` | Create database snapshots. |
| Download backups | `download_backups` | Download snapshots, which may contain sensitive data. |
| Restore backups | `restore_backups` | Restore a snapshot and replace current database data. |
| Delete backups | `delete_backups` | Delete stored snapshots. |
| Schedule backups | `schedule_backups` | Change automatic backup schedules. |

## Logs and analytics (`view_logs`)

| Action | Grant | Scope |
| --- | --- | --- |
| View server logs | `view_server_logs` | Read redacted server diagnostic messages. |
| Clear server logs | `clear_server_logs` | Delete retained server logs. |
| View analytics | `view_analytics` | Read usage statistics, routing metrics and provider tiers. |

## Recipes

- Inventory viewer: `view_keys` (masked values only).
- Standard key adder: `add_keys`; no inventory read is needed. Files/batches require `import_keys`, which can also update existing endpoint/model configuration.
- Key operator: `view_keys`, `add_keys`, `edit_keys`, `test_keys`; no delete/reveal/export.
- Analyst: `view_analytics`, `view_server_logs`; no log clearing.
- Cache operator: `view_cache`, `edit_cache`; add `clear_cache` only when flushing is intended. Cache preference metadata is readable by any of these three grants; Analytics can read aggregate cache stats.
- Backup creator: `view_backups`, `create_backups`; download, restore, delete and schedule are separate.
- System viewer: `view_settings`; gateway/URL tokens, full proxy URL and client profiles each have separate read grants.

## Composite operations and boundaries

Creating a custom model with a credential needs both Add keys and Manage provider models. Upserts of existing credentials additionally need Edit keys. Removing custom modality models that may remove their credential needs Delete keys. Choose the matching View grant to use list-based controls. Full manager screens remain available to existing full managers; delegates use capability-aware sections and original dialogs.

Role changes require the Admin role plus role-management authority. A full-access actor can create a full-access admin on promotion, retaining prior behavior; a restricted actor can only promote a target without widening its existing subset of grants. Nobody can edit their own grants, change Primary Admin authority, or grant wildcard/parents they do not hold.

Cache preferences are explicit booleans stored in settings and override env defaults. Master default remains off until an operator changes it. Per-request cache directives retain their existing behavior. Persistence contains plaintext responses; RAM-only stops future persistence/preload, while existing rows remain until cleared or expired. Preference writes are atomic. No live cache activation or live user-grant changes are part of deployment.
