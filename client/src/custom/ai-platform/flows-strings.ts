/**
 * AI Platform Orchestrator (Flows & Runs) UI strings (US7 / T130, T131).
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts. Every visible string passed to tc() lives here.
 */

// ─── Shared / Permissions / Errors ────────────────────────────────────────────
export const FLOWS_PAGE_TITLE = 'Agent flows';
export const FLOWS_PAGE_SUBTITLE = 'Configure specialist agents, compose single or handoff flows, publish snapshots, and run dry tests';
export const FLOWS_NO_PERMISSION = 'You do not have permission to view or manage flows';
export const FLOWS_VIEW_ONLY_NOTICE = 'View only — requires edit_flows to modify agents/drafts or publish_flows to publish and grant access';
export const FLOWS_NO_PUBLISH_NOTICE = 'Publishing flows and assigning client profile grants require publish_flows permission';
export const FLOWS_EDITOR_ONLY_NOTICE = 'View permission missing — requires view_flows to load existing agents and flows';
export const FLOWS_FORBIDDEN_ERROR = 'Permission denied — you lack the required flow permission';
export const FLOWS_SESSION_EXPIRED = 'Session expired — please sign in again';
export const FLOWS_REVISION_CONFLICT = 'Revision conflict (409): another session updated this record. Reload latest before saving or publishing.';
export const FLOWS_RELOAD_LATEST = 'Reload latest';
export const FLOWS_PILLAR_DISABLED = 'Orchestrator pillar is currently disabled (409). Enable it in Platform overview to run live tests.';
export const FLOWS_REFRESH = 'Refresh';
export const FLOWS_CANCEL = 'Cancel';
export const FLOWS_DELETE = 'Delete';
export const FLOWS_EDIT = 'Edit';
export const FLOWS_SAVE = 'Save';
export const FLOWS_SAVING = 'Saving…';
export const FLOWS_LOADING = 'Loading…';
export const FLOWS_ENABLED = 'Enabled';
export const FLOWS_DISABLED = 'Disabled';

// ─── Agents Section ───────────────────────────────────────────────────────────
export const AGENTS_HEADING = 'Agents';
export const AGENTS_SUBTITLE = 'Specialists with dedicated model, system prompt, knowledge scope, and output policy';
export const AGENTS_ADD_BTN = 'New agent';
export const AGENTS_CREATE_HEADING = 'Create agent';
export const AGENTS_EDIT_HEADING = 'Edit agent';
export const AGENTS_EMPTY = 'No agents configured yet.';
export const AGENTS_LOAD_ERROR = 'Failed to load agents';
export const AGENTS_SAVE_ERROR = 'Failed to save agent';
export const AGENTS_DELETE_ERROR = 'Failed to delete agent';
export const AGENTS_SAVED = 'Agent saved';
export const AGENTS_DELETED = 'Agent deleted';
export const AGENTS_IN_USE_TITLE = 'Cannot delete agent — currently referenced by flows';
export const AGENTS_IN_USE_FLOWS = 'Referencing flows: {flows}';
export const AGENTS_FIELD_SLUG = 'Slug';
export const AGENTS_FIELD_SLUG_HINT = 'Lowercase letters, digits, underscores, or hyphens (1–48 chars)';
export const AGENTS_FIELD_NAME = 'Name';
export const AGENTS_FIELD_DESCRIPTION = 'Description';
export const AGENTS_FIELD_MODEL = 'Model';
export const AGENTS_FIELD_MODEL_HINT = 'Enter a model ID, auto, fusion, or combo name (e.g. combo:support)';
export const AGENTS_FIELD_PROMPT = 'System prompt';
export const AGENTS_FIELD_PROMPT_PLACEHOLDER = 'Optional system instructions published to this agent…';
export const AGENTS_FIELD_KNOWLEDGE_KIND = 'Knowledge scope';
export const AGENTS_FIELD_KNOWLEDGE_ID = 'Knowledge target ID';
export const AGENTS_SCOPE_NONE = 'None';
export const AGENTS_SCOPE_PROFILE = 'Client profile';
export const AGENTS_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const AGENTS_FIELD_OUTPUT_POLICY = 'Output policy scope';
export const AGENTS_FIELD_OUTPUT_POLICY_HINT = 'Optional (e.g. profile:1 or support_tenant:10)';
export const AGENTS_FIELD_MAX_TOKENS = 'Max output tokens';
export const AGENTS_FIELD_MAX_TOKENS_PLACEHOLDER = 'Default';
export const AGENTS_PROMPT_VERSION = 'Prompt v{version}';
export const AGENTS_NO_PROMPT_VERSION = 'No prompt published';

// ─── Flows Section ────────────────────────────────────────────────────────────
export const FLOWS_LIST_HEADING = 'Flows';
export const FLOWS_ADD_BTN = 'New flow';
export const FLOWS_CREATE_HEADING = 'Create flow';
export const FLOWS_EMPTY = 'No flows created yet.';
export const FLOWS_LOAD_ERROR = 'Failed to load flows';
export const FLOWS_SAVE_ERROR = 'Failed to save draft';
export const FLOWS_DELETE_ERROR = 'Failed to delete flow';
export const FLOWS_PUBLISH_ERROR = 'Failed to publish flow';
export const FLOWS_GRANTS_ERROR = 'Failed to update client profile grants';
export const FLOWS_DRAFT_SAVED = 'Flow draft saved';
export const FLOWS_CREATED = 'Flow created';
export const FLOWS_DELETED = 'Flow deleted';
export const FLOWS_PUBLISHED = 'Flow published';
export const FLOWS_GRANTS_SAVED = 'Profile grants updated';
export const FLOWS_FIELD_SLUG = 'Flow slug';
export const FLOWS_FIELD_SLUG_HINT = 'Lowercase letters, digits, or hyphens (1–48 chars). Invoked as flow:<slug>';
export const FLOWS_FIELD_NAME = 'Flow name';
export const FLOWS_FIELD_DESCRIPTION = 'Description';
export const FLOWS_PUBLISHED_VERSION = 'Published: v{version}';
export const FLOWS_UNPUBLISHED = 'Unpublished';
export const FLOWS_REVISION = 'Revision #{revision}';

// ─── Flow Draft Editor ────────────────────────────────────────────────────────
export const FLOW_EDITOR_HEADING = 'Flow draft editor';
export const FLOW_SELECT_HINT = 'Select a flow from the list or create a new flow to edit its draft.';
export const FLOW_KIND_LABEL = 'Flow kind';
export const FLOW_KIND_SINGLE = 'Single agent';
export const FLOW_KIND_HANDOFF = 'Multi-agent handoff';
export const FLOW_ENTRY_AGENT = 'Entry agent';
export const FLOW_PARTICIPATING_AGENTS = 'Participating agents';
export const FLOW_NO_AGENTS_HINT = 'Create at least one enabled agent first.';
export const FLOW_HANDOFFS_HEADING = 'Handoff routing matrix';
export const FLOW_HANDOFFS_SINGLE_NOTE = 'Handoffs are disabled when flow kind is set to Single agent.';
export const FLOW_HANDOFFS_FROM = 'From {agent}';
export const FLOW_LIMITS_HEADING = 'Execution limits & hard ceilings';
export const FLOW_LIMIT_STEPS = 'Max steps';
export const FLOW_LIMIT_STEPS_HINT = 'Hard ceiling: 50';
export const FLOW_LIMIT_TOOL_CALLS = 'Max tool calls';
export const FLOW_LIMIT_TOOL_CALLS_HINT = 'Hard ceiling: 100';
export const FLOW_LIMIT_HANDOFFS = 'Max handoffs';
export const FLOW_LIMIT_HANDOFFS_HINT = 'Hard ceiling: 10';
export const FLOW_LIMIT_TOKENS = 'Max total tokens';
export const FLOW_LIMIT_TOKENS_HINT = 'Hard ceiling: 500,000';
export const FLOW_LIMIT_SECONDS = 'Max duration (seconds)';
export const FLOW_LIMIT_SECONDS_HINT = 'Hard ceiling: 600s';
export const FLOW_LIMIT_CEILING_EXCEEDED = '{label} must be between 1 and {max}';
export const FLOW_APPROVAL_TEXT_LABEL = 'Awaiting approval message';
export const FLOW_APPROVAL_TTL_LABEL = 'Approval TTL (hours)';
export const FLOW_APPROVAL_TTL_HINT = 'Range: 1–168 hours';
export const FLOW_SAVE_DRAFT_BTN = 'Save draft';
export const FLOW_SAVING_DRAFT_BTN = 'Saving draft…';
export const FLOW_VALIDATION_HEADING = 'Validation errors (422)';
export const FLOW_PUBLISH_BTN = 'Publish flow';
export const FLOW_PUBLISHING_BTN = 'Publishing…';

// ─── Grants & Try Draft ───────────────────────────────────────────────────────
export const FLOW_GRANTS_HEADING = 'Client profile grants';
export const FLOW_GRANTS_SUBTITLE = 'Only granted client profiles can call flow:{slug}';
export const FLOW_GRANTS_EMPTY = 'No client profiles found.';
export const FLOW_GRANTS_SAVE_BTN = 'Save grants';
export const FLOW_GRANTS_SAVING_BTN = 'Saving grants…';
export const FLOW_TRY_HEADING = 'Dry-run test';
export const FLOW_TRY_NOTE = 'Dry-run tests execute the current draft without charging any client profile quota.';
export const FLOW_TRY_MESSAGE_LABEL = 'Test user message';
export const FLOW_TRY_MESSAGE_PLACEHOLDER = 'Enter a message to test this draft flow…';
export const FLOW_TRY_BTN = 'Run dry test';
export const FLOW_TRYING_BTN = 'Running test…';
export const FLOW_TRY_ERROR = 'Dry-run test failed';
export const FLOW_TRY_OUTPUT_LABEL = 'Final output';

// ─── Async Trigger & Scheduled Execution (Spec 035) ───────────────────────────
export const FLOW_ASYNC_SCHEDULE_HEADING = 'Background runs & schedule';
export const FLOW_ASYNC_SCHEDULE_SUBTITLE =
  'Trigger fire-and-track async executions (202 Accepted) or configure recurring interval/cron schedules';
export const FLOW_ASYNC_MESSAGE_LABEL = 'Async run message';
export const FLOW_ASYNC_MESSAGE_PLACEHOLDER = 'Enter a prompt for background execution…';
export const FLOW_ASYNC_PROFILE_LABEL = 'Target client profile (optional)';
export const FLOW_ASYNC_PROFILE_NONE = 'Operator dry-run (no profile)';
export const FLOW_ASYNC_TRIGGER_BTN = 'Trigger async run';
export const FLOW_ASYNC_TRIGGERING_BTN = 'Queueing…';
export const FLOW_ASYNC_ACCEPTED = 'Accepted background run {runId} ({statusUrl})';
export const FLOW_ASYNC_ERROR = 'Failed to queue async flow run';

export const FLOW_SCHEDULE_HEADING = 'Recurring schedule';
export const FLOW_SCHEDULE_ENABLED = 'Enable schedule';
export const FLOW_SCHEDULE_KIND_LABEL = 'Schedule mode';
export const FLOW_SCHEDULE_KIND_INTERVAL = 'Fixed interval';
export const FLOW_SCHEDULE_KIND_CRON = '5-field UTC cron';
export const FLOW_SCHEDULE_INTERVAL_LABEL = 'Interval (seconds)';
export const FLOW_SCHEDULE_CRON_LABEL = 'Cron expression (UTC)';
export const FLOW_SCHEDULE_CRON_PLACEHOLDER = '*/15 * * * *';
export const FLOW_SCHEDULE_MESSAGE_LABEL = 'Scheduled user message';
export const FLOW_SCHEDULE_MESSAGE_PLACEHOLDER = 'Run scheduled digest…';
export const FLOW_SCHEDULE_SAVE_BTN = 'Save schedule';
export const FLOW_SCHEDULE_SAVING_BTN = 'Saving schedule…';
export const FLOW_SCHEDULE_DELETE_BTN = 'Remove schedule';
export const FLOW_SCHEDULE_SAVED = 'Flow schedule saved';
export const FLOW_SCHEDULE_DELETED = 'Flow schedule removed';
export const FLOW_SCHEDULE_LOAD_ERROR = 'Failed to load flow schedule';
export const FLOW_SCHEDULE_SAVE_ERROR = 'Failed to save flow schedule';
export const FLOW_SCHEDULE_NEXT_RUN = 'Next run: {nextRunAt}';
export const FLOW_SCHEDULE_LAST_RUN = 'Last run: {lastRunId}';

// ─── Runs Page ────────────────────────────────────────────────────────────────
export const RUNS_PAGE_TITLE = 'Flow runs';
export const RUNS_PAGE_SUBTITLE = 'Inspect live execution traces, cancel active runs, and review pending tool approvals';
export const RUNS_NO_PERMISSION = 'You do not have permission to view flow runs or review approvals';
export const RUNS_VIEW_REQUIRED_NOTICE = 'View permission missing — requires view_flow_runs to list runs and inspect traces';
export const RUNS_LOAD_ERROR = 'Failed to load runs';
export const RUNS_DETAIL_ERROR = 'Failed to load run trace';
export const RUNS_CANCEL_ERROR = 'Failed to cancel run';
export const RUNS_CANCEL_BTN = 'Cancel run';
export const RUNS_CANCELLING_BTN = 'Cancelling…';
export const RUNS_CANCELLED_SUCCESS = 'Run cancelled';
export const RUNS_EMPTY = 'No flow runs match the current filters.';
export const RUNS_SELECT_HINT = 'Select a run to inspect its live step-by-step trace.';
export const RUNS_FILTER_FLOW = 'Flow';
export const RUNS_FILTER_FLOW_PLACEHOLDER = 'All flows or slug/ID';
export const RUNS_FILTER_PROFILE = 'Client profile';
export const RUNS_FILTER_PROFILE_PLACEHOLDER = 'All profiles';
export const RUNS_FILTER_STATUS = 'Status';
export const RUNS_STATUS_ALL = 'All statuses';
export const RUNS_LIVE_POLLING = 'Live polling active';
export const RUNS_DRY_RUN_BADGE = 'Dry run';
export const RUNS_TOTAL_TOKENS = '{total} tokens ({prompt} in / {completion} out)';
export const RUNS_COUNTERS = 'Steps: {steps} · Tools: {tools} · Handoffs: {handoffs}';
export const RUNS_COL_RUN = 'Run';
export const RUNS_COL_FLOW = 'Flow';
export const RUNS_COL_PROFILE = 'Profile';
export const RUNS_COL_STATUS = 'Status';
export const RUNS_COL_STEPS = 'Steps';
export const RUNS_COL_TOKENS = 'Tokens';
export const RUNS_COL_STARTED = 'Started';

// ─── Run Statuses & Stop Reasons ──────────────────────────────────────────────
export const RUN_STATUS_RUNNING = 'Running';
export const RUN_STATUS_AWAITING_APPROVAL = 'Awaiting approval';
export const RUN_STATUS_COMPLETED = 'Completed';
export const RUN_STATUS_STOPPED = 'Stopped';
export const RUN_STATUS_CANCELLED = 'Cancelled';
export const RUN_STATUS_FAILED = 'Failed';
export const RUN_STATUS_INTERRUPTED = 'Interrupted';

export const RUN_STATUS_LABELS: Record<'running' | 'awaiting_approval' | 'completed' | 'stopped' | 'cancelled' | 'failed' | 'interrupted', string> = {
  running: RUN_STATUS_RUNNING,
  awaiting_approval: RUN_STATUS_AWAITING_APPROVAL,
  completed: RUN_STATUS_COMPLETED,
  stopped: RUN_STATUS_STOPPED,
  cancelled: RUN_STATUS_CANCELLED,
  failed: RUN_STATUS_FAILED,
  interrupted: RUN_STATUS_INTERRUPTED,
};

// ─── RunTrace Component ───────────────────────────────────────────────────────
export const TRACE_HEADING = 'Execution trace';
export const TRACE_EMPTY = 'No trace steps recorded yet.';
export const TRACE_STEP_MODEL = 'Model';
export const TRACE_STEP_TOOL = 'Tool';
export const TRACE_STEP_HANDOFF = 'Handoff';
export const TRACE_STEP_APPROVAL = 'Approval';
export const TRACE_STEP_GUARD = 'Output guard';
export const TRACE_STEP_STOP = 'Stopped';
export const TRACE_STEP_STATUS_OK = 'OK';
export const TRACE_STEP_STATUS_ERROR = 'Error';
export const TRACE_STEP_STATUS_SKIPPED = 'Skipped';
export const TRACE_INPUT_LABEL = 'Input (masked)';
export const TRACE_OUTPUT_LABEL = 'Output (masked)';
export const TRACE_ERROR_LABEL = 'Error';
export const TRACE_DURATION_MS = '{ms} ms';

// ─── Pending Approvals Section ────────────────────────────────────────────────
export const RUNS_APPROVALS_HEADING = 'Pending flow approvals';
export const RUNS_APPROVALS_EMPTY = 'No pending approvals.';
export const RUNS_APPROVALS_LOAD_ERROR = 'Failed to load pending approvals';
export const RUNS_APPROVALS_ACTION_ERROR = 'Failed to submit approval decision';
export const RUNS_APPROVALS_CONFLICT = 'This approval was already decided by another administrator — refreshed queue.';
export const RUNS_APPROVALS_NOTE_PLACEHOLDER = 'Optional decision note…';
export const RUNS_APPROVALS_APPROVE = 'Approve';
export const RUNS_APPROVALS_REJECT = 'Reject';
export const RUNS_APPROVALS_EXPIRES = 'Expires';
export const RUNS_APPROVALS_ARGS = 'Arguments (masked)';
export const RUNS_APPROVALS_RUN_REF = 'Run {runId} · Step #{seq}';
