/**
 * AI Platform Versioned Prompts UI strings (US6 / T113, T114).
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts. Every visible string passed to tc() lives here.
 */

// ─── Page Header & Permissions ────────────────────────────────────────────────
export const PROMPTS_PAGE_TITLE = 'System prompts';
export const PROMPTS_PAGE_SUBTITLE = 'Author versioned system prompts, manage variables, compare diffs, and preview or test drafts safely';
export const PROMPTS_NO_PERMISSION = 'You do not have permission to view or edit system prompts';
export const PROMPTS_VIEW_ONLY_NOTICE = 'View only — requires edit_prompts permission to edit drafts, preview, or run tests';
export const PROMPTS_NO_PUBLISH_NOTICE = 'Publishing and restoring versions require publish_prompts permission';
export const PROMPTS_EDITOR_ONLY_NOTICE = 'Edit only — requires view_prompts permission to load saved prompt history and diffs';
export const PROMPTS_FORBIDDEN_ERROR = 'Permission denied — you lack the required prompt permission';
export const PROMPTS_SESSION_EXPIRED = 'Session expired — please sign in again';
export const PROMPTS_RETRY = 'Retry';

// ─── Scope Selector ───────────────────────────────────────────────────────────
export const PROMPTS_SCOPE_KIND = 'Scope type';
export const PROMPTS_SCOPE_PROFILE = 'Client profile';
export const PROMPTS_SCOPE_SUPPORT_TENANT = 'Support tenant';
export const PROMPTS_SCOPE_TARGET = 'Target';
export const PROMPTS_SCOPE_ID_PLACEHOLDER = 'Enter scope ID (e.g. 1)';
export const PROMPTS_RELOAD_BTN = 'Refresh';

// ─── Scope State & Banners ────────────────────────────────────────────────────
export const PROMPTS_LOADING = 'Loading prompt versions…';
export const PROMPTS_LOAD_ERROR = 'Failed to load prompt state';
export const PROMPTS_HEAD_PUBLISHED = 'Published: v{version}';
export const PROMPTS_HEAD_NO_PUBLISHED = 'Published: none';
export const PROMPTS_HEAD_DRAFT = 'Draft: v{version}';
export const PROMPTS_HEAD_NO_DRAFT = 'Draft: none';
export const PROMPTS_HEAD_REVISION = 'Revision #{revision}';
export const PROMPTS_PRUNED_NOTICE = '{count} older archived version(s) were pruned to retain the latest 50 versions.';
export const PROMPTS_CONFLICT_BANNER = 'Revision conflict (409): another session modified this prompt. Reload the latest state before saving or publishing.';
export const PROMPTS_CONFLICT_RELOAD_BTN = 'Reload latest';

// ─── Editor & Draft Workflow ──────────────────────────────────────────────────
export const PROMPTS_EDITOR_HEADING = 'Prompt editor';
export const PROMPTS_BODY_LABEL = 'System prompt body';
export const PROMPTS_BODY_PLACEHOLDER = 'Write system instructions here. Use {{variable_name}} placeholders…';
export const PROMPTS_BODY_CHARS = '{count} / {max} characters';
export const PROMPTS_NOTE_LABEL = 'Commit note';
export const PROMPTS_NOTE_PLACEHOLDER = 'Describe what changed in this version…';
export const PROMPTS_SAVE_DRAFT_BTN = 'Save draft';
export const PROMPTS_SAVING_DRAFT_BTN = 'Saving draft…';
export const PROMPTS_DISCARD_DRAFT_BTN = 'Discard draft';
export const PROMPTS_DISCARDING_DRAFT_BTN = 'Discarding…';
export const PROMPTS_PUBLISH_BTN = 'Publish';
export const PROMPTS_PUBLISHING_BTN = 'Publishing…';
export const PROMPTS_DRAFT_SAVED = 'Draft saved';
export const PROMPTS_DRAFT_DISCARDED = 'Draft discarded';
export const PROMPTS_PUBLISHED_SUCCESS = 'Prompt published';
export const PROMPTS_RESTORED_SUCCESS = 'Version restored and published';
export const PROMPTS_SAVE_ERROR = 'Failed to save draft';
export const PROMPTS_DISCARD_ERROR = 'Failed to discard draft';
export const PROMPTS_PUBLISH_ERROR = 'Failed to publish prompt';
export const PROMPTS_RESTORE_ERROR = 'Failed to restore version';
export const PROMPTS_VALIDATION_LOCATION = 'Template error at line {line}, column {column}: {reason}';
export const PROMPTS_VALIDATION_GENERIC = 'Template validation failed (422)';

// ─── Variable Editor & Cache-Prefix Warning ───────────────────────────────────
export const PROMPTS_VARS_HEADING = 'Prompt variables';
export const PROMPTS_VARS_SUBTITLE = 'Built-in system variables and declared caller/custom variables';
export const PROMPTS_CACHE_PREFIX_WARNING_TITLE = 'Prompt cache-prefix stability warning';
export const PROMPTS_CACHE_PREFIX_WARNING_BODY = 'Dynamic per-request variables ({vars}) appear in the prompt body. Because their values vary per request, they invalidate provider prompt cache prefixes and reduce cache hit rates.';
export const PROMPTS_SYS_VARS_HEADING = 'Built-in system variables (read-only)';
export const PROMPTS_SYS_VAR_NAME_COL = 'Variable';
export const PROMPTS_SYS_VAR_TYPE_COL = 'Stability';
export const PROMPTS_SYS_VAR_DESC_COL = 'Description';
export const PROMPTS_SYS_VAR_EXAMPLE_COL = 'Example';
export const PROMPTS_SYS_VAR_DYNAMIC = 'Dynamic per-request';
export const PROMPTS_SYS_VAR_STATIC = 'Cache-stable';
export const PROMPTS_DECLARED_VARS_HEADING = 'Declared caller & custom variables';
export const PROMPTS_DECLARED_VARS_EMPTY = 'No caller or custom variables declared.';
export const PROMPTS_VAR_NAME_LABEL = 'Name';
export const PROMPTS_VAR_NAME_PLACEHOLDER = 'e.g. company_name';
export const PROMPTS_VAR_SOURCE_LABEL = 'Source';
export const PROMPTS_VAR_SOURCE_CALLER = 'Caller (per-request)';
export const PROMPTS_VAR_SOURCE_CUSTOM = 'Custom (static default)';
export const PROMPTS_VAR_DEFAULT_LABEL = 'Default value';
export const PROMPTS_VAR_DEFAULT_PLACEHOLDER = 'Optional fallback value';
export const PROMPTS_VAR_DESC_LABEL = 'Description';
export const PROMPTS_VAR_DESC_PLACEHOLDER = 'Optional description';
export const PROMPTS_VAR_ADD_BTN = 'Add variable';
export const PROMPTS_VAR_REMOVE_BTN = 'Remove';
export const PROMPTS_VAR_ERR_REGEX = 'Variable name must match ^[a-z][a-z0-9_]{0,31}$';
export const PROMPTS_VAR_ERR_SYSTEM = '"{name}" is a built-in system variable and cannot be overridden';
export const PROMPTS_VAR_ERR_DUPLICATE = 'Variable "{name}" is already declared';

// ─── Preview & Try Draft Panel ────────────────────────────────────────────────
export const PROMPTS_PREVIEW_TRY_HEADING = 'Preview & try draft';
export const PROMPTS_SAMPLE_VALUES_HEADING = 'Sample variable values';
export const PROMPTS_SAMPLE_VALUES_EMPTY = 'No variables referenced or declared yet.';
export const PROMPTS_PREVIEW_BTN = 'Preview rendered prompt';
export const PROMPTS_PREVIEWING_BTN = 'Rendering preview…';
export const PROMPTS_PREVIEW_ERROR = 'Failed to render preview';
export const PROMPTS_PREVIEW_RENDERED_LABEL = 'Rendered prompt';
export const PROMPTS_PREVIEW_MISSING_LABEL = 'Missing variables';
export const PROMPTS_TRY_HEADING = 'Try draft with model';
export const PROMPTS_TRY_QUOTA_NOTE = 'Test runs do not charge client key quotas.';
export const PROMPTS_TRY_MESSAGE_LABEL = 'Test user message';
export const PROMPTS_TRY_MESSAGE_PLACEHOLDER = 'Enter a sample user message to test this prompt…';
export const PROMPTS_TRY_MODEL_LABEL = 'Model (optional)';
export const PROMPTS_TRY_MODEL_PLACEHOLDER = 'Auto / default scope model';
export const PROMPTS_TRY_BTN = 'Run test';
export const PROMPTS_TRYING_BTN = 'Running test…';
export const PROMPTS_TRY_PILLAR_DISABLED = 'System prompts pillar is currently disabled (409). Enable it in Platform overview to run live tests.';
export const PROMPTS_TRY_ERROR = 'Failed to run prompt test';
export const PROMPTS_TRY_REPLY_LABEL = 'Model reply';
export const PROMPTS_TRY_USAGE_LABEL = 'Model: {model} · Prompt: {prompt} · Completion: {completion} · Total: {total} tokens';

// ─── Version History ──────────────────────────────────────────────────────────
export const PROMPTS_HISTORY_HEADING = 'Version history';
export const PROMPTS_HISTORY_EMPTY = 'No prompt versions recorded for this scope yet.';
export const PROMPTS_STATUS_PUBLISHED = 'Published';
export const PROMPTS_STATUS_DRAFT = 'Draft';
export const PROMPTS_STATUS_ARCHIVED = 'Archived';
export const PROMPTS_RESTORED_FROM = 'Restored from v{version}';
export const PROMPTS_AUTHOR_LABEL = 'Author #{id}';
export const PROMPTS_AUTHOR_SYSTEM = 'System / migration';
export const PROMPTS_NO_NOTE = 'No commit note';
export const PROMPTS_VIEW_BTN = 'View';
export const PROMPTS_COMPARE_BTN = 'Compare';
export const PROMPTS_RESTORE_BTN = 'Restore';
export const PROMPTS_RESTORE_CONFIRM_TEXT = 'Restore and publish v{version} as a new published version?';
export const PROMPTS_RESTORE_CONFIRM_BTN = 'Confirm restore';
export const PROMPTS_RESTORE_CANCEL_BTN = 'Cancel';
export const PROMPTS_VERSION_DETAIL_HEADING = 'Version v{version} details';
export const PROMPTS_VERSION_DETAIL_LOADING = 'Loading version details…';
export const PROMPTS_VERSION_DETAIL_ERROR = 'Failed to load version details';
export const PROMPTS_LOAD_INTO_EDITOR_BTN = 'Copy to editor';
export const PROMPTS_CLOSE_BTN = 'Close';

// ─── Diff View ────────────────────────────────────────────────────────────────
export const PROMPTS_DIFF_HEADING = 'Compare versions';
export const PROMPTS_DIFF_FROM_LABEL = 'From version';
export const PROMPTS_DIFF_TO_LABEL = 'To version';
export const PROMPTS_DIFF_LOADING = 'Loading diff…';
export const PROMPTS_DIFF_ERROR = 'Failed to load diff';
export const PROMPTS_DIFF_NEED_VERSIONS = 'At least one saved version is required to compare diffs.';
export const PROMPTS_DIFF_STATS = '+{added} added · -{removed} removed · {unchanged} unchanged';
export const PROMPTS_DIFF_META_LINE = 'v{version} ({status}) · {note}';
export const PROMPTS_DIFF_OLD_LINE_COL = 'Old';
export const PROMPTS_DIFF_NEW_LINE_COL = 'New';
export const PROMPTS_DIFF_TEXT_COL = 'Line';

// ─── A/B Traffic Rollout ──────────────────────────────────────────────────────
export const PROMPTS_AB_HEADING = 'A/B draft traffic rollout';
export const PROMPTS_AB_SUBTITLE = 'Route a sticky percentage of live requests to the saved Draft version (X-End-User / X-Conversation-Id) and emit X-FreeLLM-Prompt-Version.';
export const PROMPTS_AB_NEED_DRAFT = 'Save a draft version above before enabling A/B draft traffic routing.';
export const PROMPTS_AB_DRAFT_SPLIT_LABEL = 'Draft traffic share';
export const PROMPTS_AB_SPLIT_SUMMARY = 'Draft: {draft}% · Published: {published}%';
export const PROMPTS_AB_APPLY_BTN = 'Apply traffic split';
export const PROMPTS_AB_APPLYING_BTN = 'Applying…';
export const PROMPTS_AB_RESET_BTN = 'Reset to 0%';
export const PROMPTS_AB_SAVED = 'A/B traffic rollout updated.';
export const PROMPTS_AB_ERROR = 'Failed to update A/B rollout';

// ─── Golden Evaluation Suite ──────────────────────────────────────────────────
export const PROMPTS_EVAL_HEADING = 'Golden evaluation suite';
export const PROMPTS_EVAL_SUBTITLE = 'Run reproducible regression tests comparing Published vs Draft side by side with substring, regex, and optional LLM judge grading.';
export const PROMPTS_EVAL_LOADING = 'Loading evaluation suite…';
export const PROMPTS_EVAL_LOAD_ERROR = 'Failed to load evaluation suite';
export const PROMPTS_EVAL_ADD_CASE_BTN = 'Add test case';
export const PROMPTS_EVAL_CANCEL_EDIT_BTN = 'Cancel edit';
export const PROMPTS_EVAL_CASE_NAME_LABEL = 'Case name';
export const PROMPTS_EVAL_CASE_NAME_PLACEHOLDER = 'e.g. Concise JSON greeting';
export const PROMPTS_EVAL_CASE_MSG_LABEL = 'Test user message';
export const PROMPTS_EVAL_CASE_MSG_PLACEHOLDER = 'Enter the user message sent during evaluation…';
export const PROMPTS_EVAL_CASE_VARS_LABEL = 'Caller variables (JSON object, optional)';
export const PROMPTS_EVAL_CASE_VARS_INVALID = 'Caller variables must be a valid JSON object of strings.';
export const PROMPTS_EVAL_CASE_MUST_CONTAIN_LABEL = 'Must contain (one phrase per line)';
export const PROMPTS_EVAL_CASE_MUST_NOT_CONTAIN_LABEL = 'Must not contain (one phrase per line)';
export const PROMPTS_EVAL_CASE_REGEX_LABEL = 'Expected regex (case-insensitive, optional)';
export const PROMPTS_EVAL_CASE_RUBRIC_LABEL = 'LLM judge rubric (optional)';
export const PROMPTS_EVAL_CASE_SAVE_BTN = 'Save test case';
export const PROMPTS_EVAL_CASE_SAVING_BTN = 'Saving case…';
export const PROMPTS_EVAL_CASE_EDIT_BTN = 'Edit';
export const PROMPTS_EVAL_CASE_DELETE_BTN = 'Delete';
export const PROMPTS_EVAL_CASE_ENABLED_LABEL = 'Enabled';
export const PROMPTS_EVAL_CASES_EMPTY = 'No golden eval cases yet. Add at least one case to run side-by-side comparisons.';
export const PROMPTS_EVAL_RUN_BTN = 'Run evaluation';
export const PROMPTS_EVAL_RUNNING_BTN = 'Running evaluation…';
export const PROMPTS_EVAL_USE_JUDGE_LABEL = 'Enable LLM judge (1–5 rubric score)';
export const PROMPTS_EVAL_USE_UNSAVED_LABEL = 'Evaluate unsaved editor buffer instead of saved draft';
export const PROMPTS_EVAL_MODEL_LABEL = 'Evaluation model (optional)';
export const PROMPTS_EVAL_LATEST_RUN_HEADING = 'Side-by-side comparison';
export const PROMPTS_EVAL_PUBLISHED_COL = 'Published baseline';
export const PROMPTS_EVAL_CANDIDATE_COL = 'Draft / candidate';
export const PROMPTS_EVAL_PASS_BADGE = 'PASS';
export const PROMPTS_EVAL_FAIL_BADGE = 'FAIL';
export const PROMPTS_EVAL_METRICS_LINE = '{passed}/{total} passed ({rate}%) · {latency}ms avg · {tokens} tok avg';
export const PROMPTS_EVAL_JUDGE_SCORE = 'Judge: {score}/5';
export const PROMPTS_EVAL_RUNS_HISTORY_HEADING = 'Recent evaluation runs';
export const PROMPTS_EVAL_NO_RUNS = 'No evaluation runs recorded yet.';
export const PROMPTS_EVAL_ERROR = 'Failed to run evaluation';
