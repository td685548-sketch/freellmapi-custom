/**
 * AI Platform Output Guard UI strings (US3 / T070).
 *
 * English is the canonical key; Vietnamese translations are appended to
 * client/src/custom/i18n/vi.ts. Every literal passed to tc() lives here.
 */

// ─── Page & Tabs ──────────────────────────────────────────────────────────────
export const GUARD_PAGE_TITLE = 'Output guard';
export const GUARD_PAGE_SUBTITLE = 'Configure response policies, dry-run checks, and review guard events';
export const GUARD_TAB_POLICY = 'Policy & tester';
export const GUARD_TAB_EVENTS = 'Guard events';

// ─── Permissions & Notices ────────────────────────────────────────────────────
export const GUARD_NO_PERMISSION = 'You do not have permission to view output guard settings';
export const GUARD_VIEW_REQUIRED_FOR_POLICY = 'Requires view_output_guard permission to load saved policies';
export const GUARD_EDIT_REQUIRED = 'View only — requires edit_output_guard permission to save changes';
export const GUARD_EXCERPT_PERMISSION_REQUIRED = 'Requires view_guard_excerpts permission to decrypt excerpts';
export const GUARD_EXCERPT_ONLY_NOTICE = 'Excerpt-only access: enter an event ID to inspect its decrypted excerpt without listing policies or events.';

// ─── Scope Selection ──────────────────────────────────────────────────────────
export const GUARD_SCOPE_KIND = 'Scope type';
export const GUARD_SCOPE_PROFILE = 'Client key profile';
export const GUARD_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const GUARD_SCOPE_AGENT = 'Orchestrator agent';
export const GUARD_SCOPE_TARGET = 'Target';
export const GUARD_SCOPE_ID_PLACEHOLDER = 'Enter scope ID';
export const GUARD_AGENT_UNAVAILABLE = 'Agent scopes are unavailable until Orchestrator (US7) is installed.';
export const GUARD_LOADING_POLICY = 'Loading output guard policy…';
export const GUARD_LOAD_POLICY_ERROR = 'Failed to load output guard policy';
export const GUARD_REVISION_LABEL = 'Revision';

// ─── Policy Editor ────────────────────────────────────────────────────────────
export const GUARD_MODE_LABEL = 'Guard mode';
export const GUARD_MODE_OFF = 'Off';
export const GUARD_MODE_LOG = 'Log only';
export const GUARD_MODE_BLOCK = 'Block / mask';
export const GUARD_FAIL_MODE_LABEL = 'External check fail mode';
export const GUARD_FAIL_ALLOW = 'Allow on failure';
export const GUARD_FAIL_BLOCK = 'Block on failure';
export const GUARD_HOLD_CHARS_LABEL = 'Hold window (chars)';
export const GUARD_MAX_DELAY_MS_LABEL = 'Max hold delay (ms)';
export const GUARD_LATENCY_NOTICE = 'Hold window and max delay add buffering latency before emitting tokens. External checks disable incremental streaming (full buffer) and may incur additional model calls, cost, and quota.';
export const GUARD_BUFFERING_FULL_PATTERNS = 'Full buffering active: custom regex patterns cannot be bounded to the streaming hold window.';
export const GUARD_BUFFERING_FULL_EXTERNAL = 'Full buffering active: external moderation or judge checks require the complete response before emission.';
export const GUARD_JUDGE_IDENTITY_WARNING = 'Judge capability warning: this scope may lack an authorized inference key context; external judge checks will report check_failed according to fail mode.';
export const GUARD_REPLACEMENT_LABEL = 'Replacement message';
export const GUARD_BYPASS_ROLES_LABEL = 'Bypass roles (comma-separated)';
export const GUARD_BYPASS_ROLES_WARNING = 'Only server-verified or signed roles can bypass the guard. Client-supplied headers or input fields are never trusted for runtime bypass.';

// ─── Detectors ────────────────────────────────────────────────────────────────
export const GUARD_DETECTORS_HEADING = 'Detectors';
export const GUARD_DETECTOR_KEYWORDS = 'Keywords';
export const GUARD_KEYWORDS_TERMS_LABEL = 'Blocked terms (one per line, max 200 × 80 chars)';
export const GUARD_DETECTOR_PATTERNS = 'Custom regex patterns';
export const GUARD_ADD_PATTERN = 'Add pattern';
export const GUARD_REMOVE_PATTERN = 'Remove';
export const GUARD_PATTERN_NAME = 'Name';
export const GUARD_PATTERN_REGEX = 'Pattern';
export const GUARD_PATTERN_FLAGS = 'Flags';
export const GUARD_DETECTOR_PROMPT_LEAK = 'System prompt leak';
export const GUARD_PROMPT_LEAK_SHINGLES = 'Min matching shingles';
export const GUARD_DETECTOR_PII = 'PII detection';
export const GUARD_PII_ACTION_LABEL = 'PII action';
export const GUARD_PII_MASK = 'Mask in place';
export const GUARD_PII_BLOCK = 'Block response';
export const GUARD_PII_LOG = 'Log only';
export const GUARD_DETECTOR_MAX_LENGTH = 'Max response length';
export const GUARD_MAX_LENGTH_CHARS = 'Max characters';
export const GUARD_DETECTOR_MODERATION = 'External moderation';
export const GUARD_DETECTOR_JUDGE = 'Model judge';
export const GUARD_JUDGE_MODEL = 'Judge model';
export const GUARD_JUDGE_CRITERIA = 'Judge criteria';

// ─── Save & Errors ────────────────────────────────────────────────────────────
export const GUARD_SAVE_POLICY = 'Save policy';
export const GUARD_SAVING_POLICY = 'Saving…';
export const GUARD_POLICY_SAVED = 'Output guard policy saved';
export const GUARD_CONFLICT_409 = 'Policy was modified by another session — refreshed latest revision';
export const GUARD_VALIDATION_422 = 'Policy validation failed';
export const GUARD_SAVE_ERROR = 'Failed to save output guard policy';

// ─── Policy Tester ────────────────────────────────────────────────────────────
export const GUARD_TESTER_HEADING = 'Policy tester (dry-run)';
export const GUARD_TESTER_DRY_RUN_NOTICE = 'Local dry-runs do not record production guard events or excerpts. Simulated roles apply only to this test request.';
export const GUARD_TESTER_TEXT_LABEL = 'Sample assistant output';
export const GUARD_TESTER_TEXT_PLACEHOLDER = 'Paste sample model output to test against the current policy…';
export const GUARD_TESTER_ROLE_LABEL = 'Simulated role (optional)';
export const GUARD_TESTER_ROLE_PLACEHOLDER = 'e.g. support_supervisor';
export const GUARD_TESTER_INCLUDE_EXTERNAL = 'Include external checks (moderation / judge)';
export const GUARD_TESTER_EXTERNAL_WARNING = 'Running external checks disables incremental streaming simulation and may consume model calls, cost, and quota.';
export const GUARD_TESTER_RUN = 'Run test';
export const GUARD_TESTER_RUNNING = 'Testing…';
export const GUARD_TESTER_RESULT_ACTION = 'Result action';
export const GUARD_TESTER_MASKED_TEXT = 'Resulting text';
export const GUARD_TESTER_TRIGGERED = 'Triggered detectors';
export const GUARD_TESTER_NO_TRIGGERS = 'No detectors triggered.';
export const GUARD_TESTER_PILLAR_DISABLED = 'Output guard pillar is disabled — external checks are unavailable (409).';
export const GUARD_TESTER_ERROR = 'Failed to run policy test';

// ─── Guard Events & Excerpts ──────────────────────────────────────────────────
export const GUARD_EVENTS_HEADING = 'Guard events';
export const GUARD_EVENTS_METADATA_NOTICE = 'Event list shows metadata only. Encrypted excerpts expire after 7 days and require view_guard_excerpts to decrypt.';
export const GUARD_EVENTS_FILTER_DETECTOR = 'Detector';
export const GUARD_EVENTS_FILTER_ACTION = 'Action';
export const GUARD_EVENTS_ALL_ACTIONS = 'All actions';
export const GUARD_EVENTS_APPLY_FILTERS = 'Apply filters';
export const GUARD_EVENTS_LOAD_MORE = 'Load older events';
export const GUARD_EVENTS_LOADING = 'Loading guard events…';
export const GUARD_EVENTS_ERROR = 'Failed to load guard events';
export const GUARD_EVENTS_EMPTY = 'No guard events recorded.';
export const GUARD_COL_TIME = 'Time';
export const GUARD_COL_SCOPE = 'Scope';
export const GUARD_COL_DETECTOR = 'Detector';
export const GUARD_COL_ACTION = 'Action';
export const GUARD_COL_WIRE = 'Wire';
export const GUARD_COL_EXCERPT = 'Excerpt';
export const GUARD_VIEW_EXCERPT = 'View excerpt';
export const GUARD_HIDE_EXCERPT = 'Hide';
export const GUARD_EXCERPT_LOADING = 'Decrypting excerpt…';
export const GUARD_EXCERPT_EXPIRED = 'Excerpt expired (410) — retained for 7 days only.';
export const GUARD_EXCERPT_NOT_FOUND = 'Excerpt not found (404).';
export const GUARD_EXCERPT_ERROR = 'Failed to load excerpt';
export const GUARD_EXCERPT_LOOKUP_ID = 'Event ID';
export const GUARD_EXCERPT_LOOKUP_PLACEHOLDER = 'Enter event ID';
