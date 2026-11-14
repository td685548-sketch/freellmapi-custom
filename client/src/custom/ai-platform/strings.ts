/**
 * AI Platform UI strings — single source of truth for every literal that
 * reaches tc() in this module.  English is the canonical key; vi.ts holds the
 * Vietnamese translation; strings.test.ts verifies both are in sync.
 *
 * Scope: T031/T032 (US1 overview only).  Screens for US2–US7 are listed as
 * placeholders and MUST NOT link to real API calls until implemented.
 */

// ─── Navigation & Shell ───────────────────────────────────────────────────────
export const NAV_AI_PLATFORM = 'AI Platform';
export const PAGE_TITLE = 'AI Platform';
export const PAGE_SUBTITLE = 'Manage AI features and pillar settings';

// ─── Overview page ────────────────────────────────────────────────────────────
export const OVERVIEW_HEADING = 'Platform overview';
export const OVERVIEW_LOADING = 'Loading platform overview…';
export const OVERVIEW_ERROR = 'Failed to load overview';
export const OVERVIEW_RETRY = 'Retry';

// Pillar labels
export const PILLAR_PROMPTS = 'System prompts';
export const PILLAR_RETRIEVAL = 'Semantic retrieval';
export const PILLAR_PROMPT_CACHE = 'Prompt cache';
export const PILLAR_MCP_CLIENT = 'MCP tool client';
export const PILLAR_OUTPUT_GUARD = 'Output guard';
export const PILLAR_ORCHESTRATOR = 'Orchestrator';

// Pillar descriptions (shown under label)
export const PILLAR_PROMPTS_DESC = 'Versioned system prompts with variables and preview';
export const PILLAR_RETRIEVAL_DESC = 'Hybrid semantic + keyword knowledge retrieval with citations';
export const PILLAR_PROMPT_CACHE_DESC = 'Forward provider cache markers and report savings';
export const PILLAR_MCP_CLIENT_DESC = 'Connect external MCP tool servers to profiles';
export const PILLAR_OUTPUT_GUARD_DESC = 'Scan and optionally block model responses';
export const PILLAR_ORCHESTRATOR_DESC = 'Multi-step agent flows with tool approval';

// Switch states
export const SWITCH_ON = 'Enabled';
export const SWITCH_OFF = 'Disabled';
export const SWITCH_ENABLING = 'Enabling…';
export const SWITCH_DISABLING = 'Disabling…';
export const SWITCH_LOCKED = 'Requires edit_ai_flags permission';
export const SWITCH_SAVE_ERROR = 'Failed to save — check permissions';
export const SWITCH_CONFLICT = 'Settings changed by another session — please refresh';
export const SWITCH_NETWORK_ERROR = 'Network error — settings not saved';

// Flags saved feedback
export const FLAGS_SAVED = 'Settings saved';
export const FLAGS_SAVE_ERROR = 'Failed to save settings';
export const FLAGS_SAVE_FAILED = FLAGS_SAVE_ERROR;

// ─── Retention section ────────────────────────────────────────────────────────
export const RETENTION_HEADING = 'Retention';
export const RETENTION_TRACE = 'Trace retention (days)';
export const RETENTION_TOOL_CALLS = 'Tool call retention (days)';
export const RETENTION_EXCERPTS = 'Excerpt retention (days)';
export const RETENTION_SAVE = 'Save retention settings';
export const RETENTION_SAVED = 'Retention settings saved';
export const RETENTION_SAVE_ERROR = 'Failed to save retention';

// ─── Permission notices ───────────────────────────────────────────────────────
export const NO_ACCESS = 'You do not have permission to view this page';
export const NO_EDIT = 'View only — you do not have edit_ai_flags permission';
export const ACCESS_DENIED_403 = 'Access denied — settings not changed';
export const SESSION_EXPIRED_401 = 'Session expired — please sign in again';

// ─── Future screens (not yet implemented) ────────────────────────────────────
// These strings are pre-registered so strings.test.ts can account for them.
// None link to real API calls until the corresponding task (US2–US7) is built.

export const NOT_IMPLEMENTED_YET = 'Not yet implemented in this release';
export const COMING_SOON = 'Coming in a future update';
export const MCP_SERVERS_HEADING = 'MCP servers';
export const OUTPUT_GUARD_HEADING = 'Output guard';
export const KNOWLEDGE_HEADING = 'Knowledge';
export const PROMPT_CACHE_HEADING = 'Prompt cache';
export const FLOWS_HEADING = 'Flows';
export const RUNS_HEADING = 'Runs';

// ─── Type: pillar key ─────────────────────────────────────────────────────────
export type PillarKey = 'prompts' | 'retrieval' | 'promptCache' | 'mcpClient' | 'outputGuard' | 'orchestrator';

export const PILLAR_LABELS: Record<PillarKey, string> = {
  prompts: PILLAR_PROMPTS,
  retrieval: PILLAR_RETRIEVAL,
  promptCache: PILLAR_PROMPT_CACHE,
  mcpClient: PILLAR_MCP_CLIENT,
  outputGuard: PILLAR_OUTPUT_GUARD,
  orchestrator: PILLAR_ORCHESTRATOR,
};

export const PILLAR_DESCRIPTIONS: Record<PillarKey, string> = {
  prompts: PILLAR_PROMPTS_DESC,
  retrieval: PILLAR_RETRIEVAL_DESC,
  promptCache: PILLAR_PROMPT_CACHE_DESC,
  mcpClient: PILLAR_MCP_CLIENT_DESC,
  outputGuard: PILLAR_OUTPUT_GUARD_DESC,
  orchestrator: PILLAR_ORCHESTRATOR_DESC,
};
