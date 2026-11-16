/**
 * AI Platform Prompt Cache UI strings (US5 / T103).
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts. Every visible string passed to tc() lives here.
 */

// ─── Page Header & Permissions ────────────────────────────────────────────────
export const CACHE_PAGE_TITLE = 'Prompt cache';
export const CACHE_PAGE_SUBTITLE = 'Forward provider cache markers, inject automatic breakpoints, manage capability overrides, and inspect cache savings';
export const CACHE_NO_PERMISSION = 'You do not have permission to view or manage prompt cache';
export const CACHE_VIEW_ONLY_NOTICE = 'View only — requires edit_prompt_cache permission to change settings or overrides';
export const CACHE_EDITOR_ONLY_NOTICE = 'Edit only — requires view_prompt_cache permission to load current settings, capabilities, and savings stats';
export const CACHE_FORBIDDEN_ERROR = 'Permission denied — you lack the required prompt cache permission';
export const CACHE_SESSION_EXPIRED = 'Session expired — please sign in again';
export const CACHE_RETRY = 'Retry';

// ─── Settings Section ─────────────────────────────────────────────────────────
export const CACHE_SETTINGS_HEADING = 'Cache forwarding & breakpoint settings';
export const CACHE_SETTINGS_LOADING = 'Loading prompt cache settings…';
export const CACHE_SETTINGS_LOAD_ERROR = 'Failed to load prompt cache settings';
export const CACHE_FORWARD_LABEL = 'Forward caller cache markers';
export const CACHE_FORWARD_DESC = 'Preserve caller cache_control markers when forwarding requests to supported providers';
export const CACHE_AUTO_BREAKPOINTS_LABEL = 'Automatic cache breakpoints';
export const CACHE_AUTO_BREAKPOINTS_DESC = 'Automatically insert cache breakpoints on stable system prompts and tool definitions for explicit-mode models';
export const CACHE_STICKY_ROUTE_LABEL = 'Prefer sticky provider route (advisory)';
export const CACHE_STICKY_ROUTE_DESC = 'Advisory preference to reuse the same provider route to improve prefix cache hit rates; routing still falls back on errors or rate limits';
export const CACHE_STATE_ON = 'Enabled';
export const CACHE_STATE_OFF = 'Disabled';
export const CACHE_SAVE_SETTINGS_BTN = 'Save cache settings';
export const CACHE_SAVING_SETTINGS_BTN = 'Saving…';
export const CACHE_SETTINGS_SAVED = 'Prompt cache settings saved';
export const CACHE_SETTINGS_SAVE_ERROR = 'Failed to save prompt cache settings';

// ─── Savings & Usage Stats Section ────────────────────────────────────────────
export const CACHE_STATS_HEADING = 'Cache savings & usage';
export const CACHE_STATS_DAYS_LABEL = 'Window';
export const CACHE_STATS_DAYS_OPTION = 'Last {days} days';
export const CACHE_STATS_GROUP_BY_LABEL = 'Group by';
export const CACHE_STATS_GROUP_DAY = 'Day';
export const CACHE_STATS_GROUP_PROFILE = 'Client profile';
export const CACHE_STATS_GROUP_MODEL = 'Model';
export const CACHE_STATS_REFRESH_BTN = 'Refresh stats';
export const CACHE_STATS_LOADING = 'Loading cache stats…';
export const CACHE_STATS_LOAD_ERROR = 'Failed to load cache stats';
export const CACHE_STATS_EMPTY = 'No prompt cache usage recorded in this period.';
export const CACHE_STATS_TOTAL_REQUESTS = 'Total requests';
export const CACHE_STATS_HIT_RATE = 'Token cache hit rate';
export const CACHE_STATS_READ_TOKENS = 'Cache read tokens';
export const CACHE_STATS_WRITE_TOKENS = 'Cache write tokens';
export const CACHE_STATS_EST_SAVED = 'Estimated USD saved';
export const CACHE_STATS_CHART_TITLE = 'Estimated savings by {group}';
export const CACHE_STATS_CHART_ARIA = 'Prompt cache estimated savings chart';
export const CACHE_STATS_COL_KEY = 'Group';
export const CACHE_STATS_COL_REQUESTS = 'Requests';
export const CACHE_STATS_COL_HITS = 'Hits';
export const CACHE_STATS_COL_HIT_RATE = 'Hit rate';
export const CACHE_STATS_COL_INPUT_TOKENS = 'Input tokens';
export const CACHE_STATS_COL_READ_TOKENS = 'Cache read';
export const CACHE_STATS_COL_WRITE_TOKENS = 'Cache write';
export const CACHE_STATS_COL_SAVED = 'Est. saved';

// ─── Capabilities & Overrides Section ─────────────────────────────────────────
export const CACHE_CAPABILITIES_HEADING = 'Provider & model cache capabilities';
export const CACHE_CAPABILITIES_SUBTITLE = 'Built-in provider defaults and custom overrides for explicit, implicit, or disabled caching';
export const CACHE_CAPABILITIES_LOADING = 'Loading cache capabilities…';
export const CACHE_CAPABILITIES_LOAD_ERROR = 'Failed to load cache capabilities';
export const CACHE_CAPABILITIES_EMPTY = 'No cache capabilities configured.';
export const CACHE_CAP_COL_SOURCE = 'Source';
export const CACHE_CAP_COL_PLATFORM = 'Platform';
export const CACHE_CAP_COL_PATTERN = 'Model pattern';
export const CACHE_CAP_COL_MODE = 'Mode';
export const CACHE_CAP_COL_MAX_BP = 'Max breakpoints';
export const CACHE_CAP_COL_MIN_TOKENS = 'Min tokens';
export const CACHE_CAP_COL_TTL = 'TTL (s)';
export const CACHE_CAP_COL_ACTIONS = 'Actions';
export const CACHE_SOURCE_BUILTIN = 'Built-in';
export const CACHE_SOURCE_OVERRIDE = 'Override';
export const CACHE_MODE_EXPLICIT = 'Explicit';
export const CACHE_MODE_IMPLICIT = 'Implicit';
export const CACHE_MODE_NONE = 'None';
export const CACHE_OVERRIDE_FORM_HEADING = 'Add or update capability override';
export const CACHE_OVERRIDE_PLATFORM_LABEL = 'Platform';
export const CACHE_OVERRIDE_PLATFORM_PLACEHOLDER = 'e.g. anthropic, openai, openrouter';
export const CACHE_OVERRIDE_PATTERN_LABEL = 'Model pattern';
export const CACHE_OVERRIDE_PATTERN_PLACEHOLDER = 'e.g. claude-*, gpt-4o*';
export const CACHE_OVERRIDE_MODE_LABEL = 'Mode';
export const CACHE_OVERRIDE_MAX_BP_LABEL = 'Max breakpoints';
export const CACHE_OVERRIDE_MIN_TOKENS_LABEL = 'Min tokens';
export const CACHE_OVERRIDE_TTL_LABEL = 'TTL seconds';
export const CACHE_OVERRIDE_SAVE_BTN = 'Save override';
export const CACHE_OVERRIDE_SAVING_BTN = 'Saving override…';
export const CACHE_OVERRIDE_SAVED = 'Capability override saved';
export const CACHE_OVERRIDE_SAVE_ERROR = 'Failed to save capability override';
export const CACHE_OVERRIDE_VALIDATION_REQUIRED = 'Platform and model pattern are required';
export const CACHE_OVERRIDE_EDIT_BTN = 'Edit';
export const CACHE_OVERRIDE_DELETE_BTN = 'Delete';
export const CACHE_OVERRIDE_DELETING_BTN = 'Deleting…';
export const CACHE_OVERRIDE_DELETED = 'Capability override deleted';
export const CACHE_OVERRIDE_DELETE_ERROR = 'Failed to delete capability override';
