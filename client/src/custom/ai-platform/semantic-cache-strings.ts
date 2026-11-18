/**
 * AI Platform Multi-Scope Semantic Response Cache UI strings (Spec 030).
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts. Every visible string passed to tc() lives here.
 */

// ─── Navigation & Page Header ─────────────────────────────────────────────────
export const SEMANTIC_CACHE_NAV_HEADING = 'Semantic cache';
export const SEM_CACHE_PAGE_TITLE = 'Multi-scope semantic response cache';
export const SEM_CACHE_PAGE_SUBTITLE =
  'Two-tier exact contract hash and vector cosine similarity response cache scoped per profile, support tenant, or agent';

// ─── Permissions & Notices ────────────────────────────────────────────────────
export const SEM_CACHE_NO_PERMISSION =
  'You do not have permission to view semantic cache settings';
export const SEM_CACHE_VIEW_ONLY_NOTICE =
  'View only — requires edit_prompt_cache permission to update settings or flush cached responses';
export const SEM_CACHE_EDITOR_ONLY_NOTICE =
  'Write-only access — requires view_prompt_cache permission to inspect stats and run lookup previews';
export const SEM_CACHE_FORBIDDEN_ERROR =
  'Permission denied — you lack the required prompt cache permission';
export const SEM_CACHE_SESSION_EXPIRED = 'Session expired. Please sign in again.';
export const SEM_CACHE_STATE_ON = 'On';
export const SEM_CACHE_STATE_OFF = 'Off';

// ─── Scope Selection ──────────────────────────────────────────────────────────
export const SEM_CACHE_SCOPE_KIND = 'Scope type';
export const SEM_CACHE_SCOPE_PROFILE = 'Client key profile';
export const SEM_CACHE_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const SEM_CACHE_SCOPE_AGENT = 'Orchestrator agent';
export const SEM_CACHE_SCOPE_ID = 'Scope ID';
export const SEM_CACHE_SCOPE_ID_PLACEHOLDER = 'Enter scope ID';
export const SEM_CACHE_LOAD_BTN = 'Load scope';
export const SEM_CACHE_SCOPE_REQUIRED = 'Enter a scope ID to load';

// ─── Settings Card ────────────────────────────────────────────────────────────
export const SEM_CACHE_SETTINGS_HEADING = 'Cache policy & safety controls';
export const SEM_CACHE_LOADING_SETTINGS = 'Loading semantic cache settings…';
export const SEM_CACHE_LOAD_SETTINGS_ERROR = 'Failed to load semantic cache settings';
export const SEM_CACHE_ENABLED_LABEL = 'Enable response cache for this scope';
export const SEM_CACHE_ENABLED_DESC =
  'Opt-in master switch (off by default). Serves cached responses and records X-FreeLLM-Semantic-Cache headers.';
export const SEM_CACHE_SEMANTIC_ENABLED_LABEL = 'Enable Tier-2 semantic vector matching';
export const SEM_CACHE_SEMANTIC_ENABLED_DESC =
  'Matches paraphrased queries via Float32 cosine similarity when embeddings are configured, falling back to Tier-1 exact contract hash.';
export const SEM_CACHE_PERSIST_DB_LABEL = 'Persist entries to SQLite';
export const SEM_CACHE_PERSIST_DB_DESC =
  'Retains cached completions across server restarts in addition to the Tier-1 in-memory LRU.';
export const SEM_CACHE_ISOLATE_END_USER_LABEL = 'Isolate entries per end user';
export const SEM_CACHE_ISOLATE_END_USER_DESC =
  'Partitions cache keys by endUser ID and permits personal x-freellm-vars headers without cross-user hits.';
export const SEM_CACHE_MIN_SIMILARITY_LABEL = 'Minimum cosine similarity';
export const SEM_CACHE_MAX_TEMPERATURE_LABEL = 'Max cacheable temperature';
export const SEM_CACHE_TTL_SECONDS_LABEL = 'TTL (seconds)';
export const SEM_CACHE_MAX_ENTRIES_LABEL = 'Max entries per scope';
export const SEM_CACHE_UPDATED_AT = 'Last updated: {time}';
export const SEM_CACHE_SAVE_BTN = 'Save cache settings';
export const SEM_CACHE_SAVING_BTN = 'Saving…';
export const SEM_CACHE_SAVED_MSG = 'Semantic cache settings saved';
export const SEM_CACHE_SAVE_ERROR = 'Failed to save semantic cache settings';

// ─── Stats & Flush Card ───────────────────────────────────────────────────────
export const SEM_CACHE_STATS_HEADING = 'Hit telemetry & stored entries';
export const SEM_CACHE_STATS_REFRESH_BTN = 'Refresh stats';
export const SEM_CACHE_STATS_LOADING = 'Loading cache stats…';
export const SEM_CACHE_STATS_ERROR = 'Failed to load semantic cache stats';
export const SEM_CACHE_STAT_EXACT_HITS = 'Exact hits';
export const SEM_CACHE_STAT_SEMANTIC_HITS = 'Semantic hits';
export const SEM_CACHE_STAT_MISSES = 'Misses';
export const SEM_CACHE_STAT_BYPASSED = 'Bypassed';
export const SEM_CACHE_STAT_HIT_RATE = 'Hit rate';
export const SEM_CACHE_STAT_TOKENS_SAVED = 'Est. tokens saved';
export const SEM_CACHE_STAT_ENTRIES = 'Active entries (mem / total)';
export const SEM_CACHE_FLUSH_HEADING = 'Invalidate & flush scope cache';
export const SEM_CACHE_FLUSH_MODEL_PLACEHOLDER = 'Optional model filter (leave blank for all)';
export const SEM_CACHE_FLUSH_RESET_METRICS = 'Also reset hit/miss counters';
export const SEM_CACHE_FLUSH_BTN = 'Flush cache';
export const SEM_CACHE_FLUSHING_BTN = 'Flushing…';
export const SEM_CACHE_FLUSHED_MSG = 'Flushed {count} cached entries';
export const SEM_CACHE_FLUSH_ERROR = 'Failed to flush semantic cache';

// ─── Recent Entries Table ─────────────────────────────────────────────────────
export const SEM_CACHE_ENTRIES_HEADING = 'Recent active entries ({count})';
export const SEM_CACHE_ENTRIES_EMPTY = 'No active cached responses in this scope.';
export const SEM_CACHE_COL_MODEL = 'Model';
export const SEM_CACHE_COL_WIRE = 'Wire';
export const SEM_CACHE_COL_TIER = 'Vector';
export const SEM_CACHE_COL_HITS = 'Hits';
export const SEM_CACHE_COL_TOKENS = 'Tokens saved';
export const SEM_CACHE_COL_CONTRACT = 'Contract / Prompt';
export const SEM_CACHE_COL_EXPIRES = 'Expires';
export const SEM_CACHE_VEC_READY = 'Ready ({dims}d)';
export const SEM_CACHE_VEC_EXACT_ONLY = 'Exact only';

// ─── Lookup Preview Card ──────────────────────────────────────────────────────
export const SEM_CACHE_PREVIEW_HEADING = 'Lookup preview tester';
export const SEM_CACHE_PREVIEW_SUBTITLE =
  'Simulate a read-only cache lookup for this scope without mutating hit or miss counters';
export const SEM_CACHE_PREVIEW_QUERY_LABEL = 'User query';
export const SEM_CACHE_PREVIEW_QUERY_PLACEHOLDER = 'Ask a question to check for exact or semantic cache hits…';
export const SEM_CACHE_PREVIEW_MODEL_LABEL = 'Model';
export const SEM_CACHE_PREVIEW_WIRE_LABEL = 'Wire protocol';
export const SEM_CACHE_PREVIEW_TEMP_LABEL = 'Temperature';
export const SEM_CACHE_PREVIEW_END_USER_LABEL = 'End user ID (optional)';
export const SEM_CACHE_PREVIEW_BTN = 'Run lookup preview';
export const SEM_CACHE_PREVIEW_RUNNING_BTN = 'Checking cache…';
export const SEM_CACHE_PREVIEW_ERROR = 'Failed to run lookup preview';
export const SEM_CACHE_PREVIEW_SCORE = 'Similarity score: {score}';
export const SEM_CACHE_PREVIEW_LATENCY = 'Latency: {ms} ms';
export const SEM_CACHE_PREVIEW_BYPASS_REASON = 'Bypass reason: {reason}';
export const SEM_CACHE_PREVIEW_CONTRACT = 'Contract: {hash}';
export const SEM_CACHE_PREVIEW_PROMPT_HASH = 'Prompt version: {hash}';
export const SEM_CACHE_PREVIEW_RESPONSE_LABEL = 'Cached completion preview';
export const SEM_CACHE_PREVIEW_NO_MATCH = 'No cached entry matched this request.';
export const SEM_CACHE_STATUS_EXACT_HIT = 'EXACT_HIT';
export const SEM_CACHE_STATUS_SEMANTIC_HIT = 'SEMANTIC_HIT';
export const SEM_CACHE_STATUS_MISS = 'MISS';
export const SEM_CACHE_STATUS_BYPASSED = 'BYPASSED';
