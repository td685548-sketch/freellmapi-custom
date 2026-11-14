/**
 * AI Platform MCP UI strings (US2 / T052).
 *
 * English is the canonical key; Vietnamese translations are appended to
 * client/src/custom/i18n/vi.ts. Every literal passed to tc() lives here.
 */

// ─── Page & Tabs ──────────────────────────────────────────────────────────────
export const MCP_PAGE_TITLE = 'MCP servers & tools';
export const MCP_PAGE_SUBTITLE = 'Register external MCP servers, review tools, bind scopes, and approve sensitive calls';
export const MCP_TAB_SERVERS = 'Servers & tools';
export const MCP_TAB_BINDINGS = 'Scope bindings';
export const MCP_TAB_APPROVALS = 'Approvals';
export const MCP_TAB_CALLS = 'Call log';
export const MCP_TAB_ORIGINS = 'Internal origins';

// ─── Servers list & actions ───────────────────────────────────────────────────
export const MCP_ADD_SERVER = 'Add MCP server';
export const MCP_EDIT_SERVER = 'Edit server';
export const MCP_DELETE_SERVER = 'Delete server';
export const MCP_FORCE_DELETE = 'Force delete';
export const MCP_ENABLE_SERVER = 'Enable';
export const MCP_DISABLE_SERVER = 'Disable';
export const MCP_TEST_SERVER = 'Test';
export const MCP_SYNC_SERVER = 'Sync tools';
export const MCP_TESTING_SERVER = 'Testing…';
export const MCP_SYNCING_SERVER = 'Syncing…';
export const MCP_NO_SERVERS = 'No MCP servers registered yet.';
export const MCP_LOADING_SERVERS = 'Loading MCP servers…';
export const MCP_LOAD_SERVERS_ERROR = 'Failed to load MCP servers';
export const MCP_SECRET_SET = 'Secret configured';
export const MCP_SECRET_NONE = 'No secret';
export const MCP_STATUS_OK = 'Connected';
export const MCP_STATUS_ERROR = 'Error';
export const MCP_STATUS_PAUSED = 'Paused (circuit breaker)';
export const MCP_STATUS_UNKNOWN = 'Not tested';
export const MCP_TEST_OK = 'Connection succeeded ({count} tools, protocol {version})';
export const MCP_TEST_FAILED = 'Connection failed: {error}';
export const MCP_SYNC_DONE = 'Synced: {added} added, {changed} changed, {missing} missing, {unchanged} unchanged';
export const MCP_PILLAR_DISABLED = 'MCP client pillar is disabled — outbound test/sync/approval execution is blocked';
export const MCP_IN_USE_TITLE = 'Server is currently bound to scopes';
export const MCP_IN_USE_DESC = 'This server has active tool bindings. Confirm force delete to remove the server and its bindings.';
export const MCP_CONFIRM_DELETE = 'Confirm delete server?';
export const MCP_REVISION_CONFLICT = 'Server was modified by another session — refreshed latest state';
export const MCP_UNSAFE_URL = 'URL rejected by SSRF policy';

// ─── Server dialog form ───────────────────────────────────────────────────────
export const MCP_FIELD_SLUG = 'Slug';
export const MCP_FIELD_SLUG_HINT = 'Lowercase letters, numbers, and hyphens (1–32 chars)';
export const MCP_FIELD_NAME = 'Display name';
export const MCP_FIELD_URL = 'Server URL';
export const MCP_FIELD_AUTH_KIND = 'Authentication';
export const MCP_AUTH_NONE = 'None';
export const MCP_AUTH_BEARER = 'Bearer token';
export const MCP_AUTH_HEADER = 'Custom header';
export const MCP_FIELD_HEADER_NAME = 'Header name';
export const MCP_FIELD_SECRET = 'Secret';
export const MCP_SECRET_WRITE_ONLY_CREATE = 'Write-only: stored encrypted and never displayed again';
export const MCP_SECRET_WRITE_ONLY_EDIT = 'Leave blank to keep existing secret, or check clear to remove it';
export const MCP_SECRET_CLEAR = 'Clear stored secret';
export const MCP_FIELD_TIMEOUT_MS = 'Timeout (ms)';
export const MCP_FIELD_MAX_RESULT_BYTES = 'Max result bytes';
export const MCP_FIELD_MAX_CONCURRENCY = 'Max concurrency';
export const MCP_SAVE_SERVER = 'Save server';
export const MCP_SAVING = 'Saving…';
export const MCP_CANCEL = 'Cancel';

// ─── Tool Review Table ────────────────────────────────────────────────────────
export const MCP_TOOLS_HEADING = 'Discovered tools';
export const MCP_SELECT_SERVER_HINT = 'Select a server to inspect and review its tools.';
export const MCP_NO_TOOLS = 'No tools discovered yet. Run Sync tools to fetch tools from this server.';
export const MCP_LOADING_TOOLS = 'Loading tools…';
export const MCP_TOOL_NAME = 'Tool name';
export const MCP_TOOL_EXPOSED = 'Exposed alias';
export const MCP_TOOL_HASH = 'Schema hash';
export const MCP_TOOL_EFFECT = 'Effect';
export const MCP_TOOL_STATE = 'State';
export const MCP_TOOL_SCHEMA = 'Input schema';
export const MCP_EFFECT_READ = 'Read';
export const MCP_EFFECT_WRITE = 'Write';
export const MCP_STATE_PENDING = 'Pending review';
export const MCP_STATE_ALLOWED = 'Allowed';
export const MCP_STATE_BLOCKED = 'Blocked';
export const MCP_STATE_MISSING = 'Missing';
export const MCP_TOOL_ALLOW = 'Approve';
export const MCP_TOOL_BLOCK = 'Block';
export const MCP_TOOL_REQUIRES_REVIEW_PERM = 'Requires review_mcp_tools permission';
export const MCP_TOOL_READONLY_NOTICE = 'New or changed tools default to pending and write; remote annotations are never auto-trusted.';

// ─── Scope Tool Bindings ──────────────────────────────────────────────────────
export const MCP_BINDINGS_HEADING = 'Scope tool bindings';
export const MCP_SCOPE_KIND = 'Scope type';
export const MCP_SCOPE_PROFILE = 'Client key profile';
export const MCP_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const MCP_SCOPE_AGENT = 'Orchestrator agent';
export const MCP_SCOPE_TARGET = 'Target';
export const MCP_SCOPE_ID_PLACEHOLDER = 'Enter scope ID';
export const MCP_AI_TOOLS_ENABLED = 'Enable MCP tools for this scope';
export const MCP_MAX_ROUNDS = 'Max tool rounds';
export const MCP_SAVE_BINDINGS = 'Save bindings';
export const MCP_BINDINGS_SAVED = 'Bindings saved';
export const MCP_SCOPE_UNAVAILABLE = 'Agent scopes are unavailable until Orchestrator (US7) is installed.';
export const MCP_SUPPORT_RUNTIME_NOTE = 'Bindings can be configured here; MCP execution in support runtime is not enabled in this release.';
export const MCP_NO_ALLOWED_TOOLS = 'No allowed tools available from enabled servers.';

// ─── Approval Queue ───────────────────────────────────────────────────────────
export const MCP_APPROVALS_HEADING = 'Tool execution approvals';
export const MCP_APPROVALS_US2_NOTE = 'US2 executes the approved tool once and records the masked result. Automatic chat resume belongs to US7.';
export const MCP_FILTER_STATUS = 'Status filter';
export const MCP_STATUS_ALL = 'All';
export const MCP_APPROVAL_PENDING = 'Pending';
export const MCP_APPROVAL_APPROVED = 'Approved';
export const MCP_APPROVAL_EXECUTING = 'Executing';
export const MCP_APPROVAL_SUCCEEDED = 'Succeeded';
export const MCP_APPROVAL_FAILED = 'Failed';
export const MCP_APPROVAL_UNKNOWN = 'Unknown (uncertain)';
export const MCP_APPROVAL_REJECTED = 'Rejected';
export const MCP_APPROVAL_EXPIRED = 'Expired';
export const MCP_APPROVE = 'Approve';
export const MCP_REJECT = 'Reject';
export const MCP_DECISION_NOTE = 'Decision note (optional)';
export const MCP_APPROVAL_CONFLICT = 'Approval was already decided by another operator — refreshed queue';
export const MCP_APPROVAL_UNKNOWN_NOTICE = 'Outcome uncertain — never auto-retried';
export const MCP_APPROVAL_EXECUTING_NOTICE = 'Execution in progress — no retry available';
export const MCP_NO_APPROVALS = 'No approval requests found.';
export const MCP_EXPIRES_AT = 'Expires';
export const MCP_MASKED_ARGS = 'Masked arguments';

// ─── Call Log ─────────────────────────────────────────────────────────────────
export const MCP_CALLS_HEADING = 'MCP tool call log';
export const MCP_CALL_FILTER_SERVER = 'Server';
export const MCP_CALL_FILTER_STATUS = 'Status';
export const MCP_CALL_ALL_SERVERS = 'All servers';
export const MCP_CALL_LOAD_MORE = 'Load older calls';
export const MCP_NO_CALLS = 'No tool calls recorded.';
export const MCP_CALL_TIME = 'Time';
export const MCP_CALL_SCOPE = 'Scope';
export const MCP_CALL_DURATION = 'Duration';
export const MCP_CALL_BYTES = 'Bytes';
export const MCP_CALL_MASKED_RESULT = 'Masked result / error';

// ─── Internal Origins Editor (Primary Only) ───────────────────────────────────
export const MCP_ORIGINS_HEADING = 'Allowed internal origins (SSRF exception)';
export const MCP_ORIGINS_DESC = 'Exact URL origins (scheme + host + port) permitted for internal/loopback MCP servers. Primary owner only.';
export const MCP_ORIGINS_PRIMARY_ONLY = 'Only the primary owner can view or edit allowed internal origins.';
export const MCP_ORIGINS_ADD = 'Add origin';
export const MCP_ORIGINS_REMOVE = 'Remove';
export const MCP_ORIGINS_SAVE = 'Save origins';
export const MCP_ORIGINS_SAVED = 'Allowed internal origins saved';
export const MCP_ORIGINS_INVALID = 'Enter an exact origin (scheme://host[:port]) without wildcards, paths, queries, or credentials';
export const MCP_NO_ORIGINS = 'No internal origins allowlisted.';

// ─── Generic MCP errors & permissions ─────────────────────────────────────────
export const MCP_NO_PERMISSION = 'You do not have permission to view MCP management';
export const MCP_ACTION_FORBIDDEN = 'Access denied — missing required permission';
export const MCP_REFRESH = 'Refresh';
