/**
 * AI Platform Knowledge & Semantic Retrieval UI strings (US4 / T087).
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts. Every visible string passed to tc() lives here.
 */

// ─── Navigation & Page Header ─────────────────────────────────────────────────
export const KNOWLEDGE_NAV_HEADING = 'Knowledge';
export const KNOWLEDGE_PAGE_TITLE = 'Knowledge & semantic retrieval';
export const KNOWLEDGE_PAGE_SUBTITLE = 'Configure hybrid vector + keyword retrieval, monitor index jobs, test queries, and review embedding usage';

// ─── Permissions & Notices ────────────────────────────────────────────────────
export const KNOWLEDGE_NO_PERMISSION = 'You do not have permission to view retrieval settings';
export const KNOWLEDGE_VIEW_REQUIRED = 'Requires view_retrieval permission to load retrieval status, usage, and run test queries';
export const KNOWLEDGE_VIEW_ONLY_NOTICE = 'View only — requires edit_retrieval permission to change settings or trigger reindexing';
export const KNOWLEDGE_FORBIDDEN_ERROR = 'Permission denied — you lack the required retrieval permission';

// ─── Scope Selection ──────────────────────────────────────────────────────────
export const KNOWLEDGE_SCOPE_KIND = 'Scope type';
export const KNOWLEDGE_SCOPE_PROFILE = 'Client key profile';
export const KNOWLEDGE_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const KNOWLEDGE_SCOPE_AGENT = 'Orchestrator agent';
export const KNOWLEDGE_SCOPE_ID = 'Scope ID';
export const KNOWLEDGE_SCOPE_ID_PLACEHOLDER = 'Enter scope ID';
export const KNOWLEDGE_LOAD_SCOPE = 'Load';
export const KNOWLEDGE_LOADING_SCOPE = 'Loading retrieval configuration…';
export const KNOWLEDGE_LOAD_SCOPE_ERROR = 'Failed to load retrieval configuration';
export const KNOWLEDGE_SCOPE_ID_REQUIRED = 'Enter a scope ID to load';

// ─── Retrieval Settings Card ──────────────────────────────────────────────────
export const KNOWLEDGE_SETTINGS_HEADING = 'Retrieval settings';
export const KNOWLEDGE_MODE_LABEL = 'Retrieval mode';
export const KNOWLEDGE_MODE_KEYWORD = 'Keyword (BM25)';
export const KNOWLEDGE_MODE_SEMANTIC = 'Semantic (vector)';
export const KNOWLEDGE_MODE_HYBRID = 'Hybrid (BM25 + vector)';
export const KNOWLEDGE_MODEL_LABEL = 'Embedding model';
export const KNOWLEDGE_MODEL_AUTO = 'Auto (default embedding model)';
export const KNOWLEDGE_DIMENSIONS_LABEL = 'Embedding dimensions';
export const KNOWLEDGE_TOP_K_LABEL = 'Max results (topK)';
export const KNOWLEDGE_MIN_SCORE_LABEL = 'Minimum score';
export const KNOWLEDGE_CITATIONS_LABEL = 'Include citations in responses';
export const KNOWLEDGE_SETTINGS_UPDATED_AT = 'Last updated: {time}';
export const KNOWLEDGE_SAVE_SETTINGS = 'Save settings';
export const KNOWLEDGE_SAVING_SETTINGS = 'Saving…';
export const KNOWLEDGE_SETTINGS_SAVED = 'Retrieval settings saved';
export const KNOWLEDGE_SAVE_ERROR = 'Failed to save retrieval settings';

// ─── Vector Index Health Card ─────────────────────────────────────────────────
export const KNOWLEDGE_INDEX_HEADING = 'Vector index health';
export const KNOWLEDGE_INDEX_GENERATION = 'Index generation';
export const KNOWLEDGE_INDEX_STATUS_READY = 'Ready';
export const KNOWLEDGE_INDEX_STATUS_BUILDING = 'Building / incomplete';
export const KNOWLEDGE_INDEX_TOTAL_CHUNKS = 'Total chunks';
export const KNOWLEDGE_INDEX_READY_CHUNKS = 'Ready chunks';
export const KNOWLEDGE_INDEX_PENDING_CHUNKS = 'Pending chunks';
export const KNOWLEDGE_INDEX_ERROR_CHUNKS = 'Error chunks';
export const KNOWLEDGE_INDEX_STALE_CHUNKS = 'Stale chunks';
export const KNOWLEDGE_INDEX_PROGRESS = 'Index completion';
export const KNOWLEDGE_INDEXED_MODEL = 'Indexed model';
export const KNOWLEDGE_INDEXED_DIMS = 'Indexed dimensions';
export const KNOWLEDGE_NONE_VALUE = 'None';
export const KNOWLEDGE_ACTIVE_JOB = 'Active index job';
export const KNOWLEDGE_JOB_PROGRESS = '{processed} / {total} chunks';
export const KNOWLEDGE_JOB_RETRY_AFTER = 'Retry after: {time}';
export const KNOWLEDGE_JOB_LAST_ERROR = 'Last error: {error}';
export const KNOWLEDGE_RECENT_JOBS = 'Recent index jobs';
export const KNOWLEDGE_NO_RECENT_JOBS = 'No index jobs recorded yet.';
export const KNOWLEDGE_REINDEX_BTN = 'Reindex knowledge';
export const KNOWLEDGE_REINDEXING_BTN = 'Starting reindex…';
export const KNOWLEDGE_REINDEX_STARTED = 'Reindex job queued (#{id})';
export const KNOWLEDGE_REINDEX_CONFLICT = 'An index job is already queued or running for this scope';
export const KNOWLEDGE_REINDEX_ERROR = 'Failed to start reindex job';
export const KNOWLEDGE_JOB_STATUS_QUEUED = 'Queued';
export const KNOWLEDGE_JOB_STATUS_RUNNING = 'Running';
export const KNOWLEDGE_JOB_STATUS_SUCCEEDED = 'Succeeded';
export const KNOWLEDGE_JOB_STATUS_FAILED = 'Failed';
export const KNOWLEDGE_JOB_REASON_DOC_ADD = 'Document added';
export const KNOWLEDGE_JOB_REASON_DOC_EDIT = 'Document edited';
export const KNOWLEDGE_JOB_REASON_DOC_DELETE = 'Document deleted';
export const KNOWLEDGE_JOB_REASON_REINDEX = 'Manual reindex';
export const KNOWLEDGE_JOB_REASON_MODEL_CHANGE = 'Model changed';

// ─── Semantic Test Query Card ─────────────────────────────────────────────────
export const KNOWLEDGE_QUERY_HEADING = 'Semantic test query';
export const KNOWLEDGE_QUERY_SUBTITLE = 'Inspect ranked retrieval hits, scores, sources, and citations without affecting live client traffic';
export const KNOWLEDGE_QUERY_INPUT_LABEL = 'Test query';
export const KNOWLEDGE_QUERY_INPUT_PLACEHOLDER = 'Enter a question or search phrase…';
export const KNOWLEDGE_QUERY_MODE_OVERRIDE = 'Mode override';
export const KNOWLEDGE_QUERY_MODE_SCOPE_DEFAULT = 'Use scope default';
export const KNOWLEDGE_QUERY_TOPK_OVERRIDE = 'topK override';
export const KNOWLEDGE_QUERY_RUN_BTN = 'Run test query';
export const KNOWLEDGE_QUERY_RUNNING_BTN = 'Querying…';
export const KNOWLEDGE_QUERY_PILLAR_DISABLED = 'Retrieval pillar is currently disabled; enable it in Platform overview or enable keyword baseline.';
export const KNOWLEDGE_QUERY_ERROR = 'Failed to run retrieval test query';
export const KNOWLEDGE_QUERY_DEGRADED_BANNER = 'Degraded fallback active: served via {mode} ({reason})';
export const KNOWLEDGE_QUERY_META_MODE = 'Mode used: {mode}';
export const KNOWLEDGE_QUERY_META_LATENCY = 'Latency: {ms} ms';
export const KNOWLEDGE_QUERY_META_GEN = 'Index gen: {gen}';
export const KNOWLEDGE_QUERY_HITS_HEADING = 'Matching hits ({count})';
export const KNOWLEDGE_QUERY_NO_HITS = 'No chunks matched this query.';
export const KNOWLEDGE_QUERY_HIT_SCORE = 'Score: {score}';
export const KNOWLEDGE_QUERY_HIT_DOC = 'Doc: {docId}';
export const KNOWLEDGE_QUERY_HIT_CHUNK = 'Chunk #{ord}';
export const KNOWLEDGE_QUERY_HIT_KW_RANK = 'BM25 #{rank}';
export const KNOWLEDGE_QUERY_HIT_VEC_RANK = 'Vector #{rank}';
export const KNOWLEDGE_QUERY_SOURCE_KEYWORD = 'keyword';
export const KNOWLEDGE_QUERY_SOURCE_SEMANTIC = 'semantic';
export const KNOWLEDGE_QUERY_CITATIONS_HEADING = 'Citations preview ({count})';
export const KNOWLEDGE_QUERY_NO_CITATIONS = 'No citations returned.';
export const KNOWLEDGE_DEGRADED_PILLAR_DISABLED = 'Retrieval pillar disabled';
export const KNOWLEDGE_DEGRADED_NO_MODEL = 'No embedding model available';
export const KNOWLEDGE_DEGRADED_INDEX_NOT_READY = 'Vector index not ready';
export const KNOWLEDGE_DEGRADED_TIMEOUT = 'Embedding query timed out';
export const KNOWLEDGE_DEGRADED_EMBEDDING_ERROR = 'Embedding provider error';

// ─── Embedding Usage Card ─────────────────────────────────────────────────────
export const KNOWLEDGE_USAGE_HEADING = 'Embedding usage';
export const KNOWLEDGE_USAGE_WINDOW_LABEL = 'Window';
export const KNOWLEDGE_USAGE_DAYS_OPTION = 'Last {days} days';
export const KNOWLEDGE_USAGE_SCOPE_FILTER = 'Current scope only';
export const KNOWLEDGE_USAGE_REFRESH = 'Refresh usage';
export const KNOWLEDGE_USAGE_LOADING = 'Loading embedding usage…';
export const KNOWLEDGE_USAGE_ERROR = 'Failed to load embedding usage';
export const KNOWLEDGE_USAGE_EMPTY = 'No embedding usage recorded in this period.';
export const KNOWLEDGE_USAGE_TOTAL_TOKENS = 'Total input tokens';
export const KNOWLEDGE_USAGE_TOTAL_REQUESTS = 'Total requests';
export const KNOWLEDGE_USAGE_INDEX_TOKENS = 'Index tokens';
export const KNOWLEDGE_USAGE_QUERY_TOKENS = 'Query tokens';
export const KNOWLEDGE_USAGE_COL_DAY = 'Day';
export const KNOWLEDGE_USAGE_COL_SCOPE = 'Scope';
export const KNOWLEDGE_USAGE_COL_MODEL = 'Model';
export const KNOWLEDGE_USAGE_COL_PURPOSE = 'Purpose';
export const KNOWLEDGE_USAGE_COL_TOKENS = 'Input tokens';
export const KNOWLEDGE_USAGE_COL_REQUESTS = 'Requests';
export const KNOWLEDGE_PURPOSE_INDEX = 'Index';
export const KNOWLEDGE_PURPOSE_QUERY = 'Query';
