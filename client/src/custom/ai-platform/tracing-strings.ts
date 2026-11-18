/**
 * AI Platform Request Span Tracing UI strings (Spec 035).
 *
 * Every literal passed to tc() in TraceTimelinePage lives here and has a
 * matching Vietnamese translation in client/src/custom/i18n/vi.ts.
 */

export const TRACES_NAV_HEADING = 'Traces';
export const TRACES_PAGE_TITLE = 'Request span traces';
export const TRACES_PAGE_SUBTITLE =
  'Inspect hierarchical request waterfall timelines across prompts, RAG retrieval, context budgets, MCP tools, orchestrator steps, upstream failover hops, and output guards';

export const TRACES_FILTER_SCOPE_KIND = 'Scope type';
export const TRACES_FILTER_ALL_SCOPES = 'All scopes';
export const TRACES_FILTER_PROFILE = 'Client profile';
export const TRACES_FILTER_SUPPORT_TENANT = 'Support tenant';
export const TRACES_FILTER_AGENT = 'Orchestrator agent';
export const TRACES_FILTER_SCOPE_ID_PLACEHOLDER = 'Scope ID (e.g. 1)';
export const TRACES_FILTER_STATUS = 'Trace status';
export const TRACES_FILTER_ALL_STATUSES = 'All statuses';
export const TRACES_FILTER_SEARCH_PLACEHOLDER = 'Search trace ID or model…';

export const TRACES_STATUS_OK = 'OK';
export const TRACES_STATUS_ERROR = 'Error';
export const TRACES_STATUS_AWAITING_APPROVAL = 'Awaiting approval';
export const TRACES_STATUS_CANCELLED = 'Cancelled';
export const TRACES_STATUS_SKIPPED = 'Skipped';

export const TRACES_REFRESH = 'Refresh traces';
export const TRACES_PURGE = 'Clear traces';
export const TRACES_PURGING = 'Clearing…';
export const TRACES_PURGED = 'Cleared {count} trace(s)';
export const TRACES_LOADING = 'Loading traces…';
export const TRACES_EMPTY = 'No request traces recorded yet.';
export const TRACES_LOAD_ERROR = 'Failed to load request traces';
export const TRACES_LOAD_MORE = 'Load older traces';
export const TRACES_SELECT_HINT = 'Select a trace on the left to inspect its waterfall timeline.';
export const TRACES_LOADING_DETAIL = 'Loading trace timeline…';

export const TRACES_TIMELINE_HEADING = 'Waterfall timeline';
export const TRACES_SPANS_COUNT = '{count} spans';
export const TRACES_TOKENS_SUMMARY = '{total} tokens';
export const TRACES_CACHED_SUMMARY = '({cached} cached)';
export const TRACES_SOURCE_LABEL = 'Source: {source}';
export const TRACES_THREAD_LABEL = 'Thread: {thread}';
export const TRACES_EXPAND_SPAN = 'Expand child spans';
export const TRACES_COLLAPSE_SPAN = 'Collapse child spans';

export const TRACES_KIND_REQUEST = 'Request';
export const TRACES_KIND_PROMPT_RENDER = 'Prompt render';
export const TRACES_KIND_RETRIEVAL = 'RAG retrieval';
export const TRACES_KIND_CONTEXT_BUDGET = 'Context budget';
export const TRACES_KIND_MCP_TOOL = 'MCP tool call';
export const TRACES_KIND_ORCHESTRATOR_STEP = 'Orchestrator step';
export const TRACES_KIND_UPSTREAM_ATTEMPT = 'Upstream attempt';
export const TRACES_KIND_OUTPUT_GUARD = 'Output guard';

export const TRACES_INSPECTOR_HEADING = 'Span details';
export const TRACES_INSPECTOR_CLOSE = 'Close inspector';
export const TRACES_INSPECTOR_SPAN_ID = 'Span ID';
export const TRACES_INSPECTOR_KIND = 'Stage kind';
export const TRACES_INSPECTOR_STATUS = 'Status';
export const TRACES_INSPECTOR_OFFSET = 'Start offset';
export const TRACES_INSPECTOR_DURATION = 'Duration';
export const TRACES_INSPECTOR_MODEL = 'Model';
export const TRACES_INSPECTOR_TOKENS = 'Tokens (prompt / completion / cached)';
export const TRACES_INSPECTOR_ERROR = 'Redacted error summary';
export const TRACES_INSPECTOR_ATTRIBUTES = 'Redacted attributes';
export const TRACES_INSPECTOR_NO_ATTRIBUTES = 'No span attributes recorded.';
export const TRACES_NO_PERMISSION = 'You do not have permission to view request traces';
