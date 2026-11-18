/**
 * Spec 034 — Versioned Prompt Eval Harness, Weighted Canary Traffic Split &
 * Real-Time SSE Credential Scrubber UI strings.
 *
 * English is the canonical key; Vietnamese translations live in
 * client/src/custom/i18n/vi.ts.
 */

// ─── Golden Eval Dataset & Harness ────────────────────────────────────────────
export const EVAL_SECTION_HEADING = 'Golden evaluation harness';
export const EVAL_SECTION_SUBTITLE =
  'Maintain up to 30 golden test cases per scope and compare draft or candidate versions against the published baseline before rollout.';
export const EVAL_CASES_COUNT = 'Golden cases ({count}/{max})';
export const EVAL_CASES_EMPTY = 'No golden eval cases yet. Add one below to test prompt changes against regressions.';
export const EVAL_LOADING = 'Loading evaluation & canary state…';
export const EVAL_LOAD_ERROR = 'Failed to load evaluation data';

export const EVAL_ADD_CASE_HEADING = 'Add golden eval case';
export const EVAL_CASE_TITLE_LABEL = 'Case title';
export const EVAL_CASE_TITLE_PLACEHOLDER = 'e.g. Refund policy concise JSON response';
export const EVAL_CASE_MESSAGE_LABEL = 'User message';
export const EVAL_CASE_MESSAGE_PLACEHOLDER = 'Enter the test prompt input sent as the user turn…';
export const EVAL_CASE_VARS_LABEL = 'Variables JSON (optional)';
export const EVAL_CASE_VARS_PLACEHOLDER = '{"company_name": "Acme"}';
export const EVAL_CASE_VARS_INVALID = 'Variables must be a valid JSON object of string/number/boolean values.';

export const EVAL_ASSERTION_TYPE_LABEL = 'Assertion type';
export const EVAL_ASSERTION_CONTAINS = 'Contains substring';
export const EVAL_ASSERTION_NOT_CONTAINS = 'Does not contain';
export const EVAL_ASSERTION_REGEX = 'Matches regex (ReDoS-safe)';
export const EVAL_ASSERTION_JSON_SCHEMA = 'Validates JSON schema';
export const EVAL_ASSERTION_MAX_CHARS = 'Max character length';
export const EVAL_ASSERTION_VALUE_LABEL = 'Assertion target';
export const EVAL_ASSERTION_VALUE_PLACEHOLDER = 'Expected text, regex pattern, max length, or JSON schema…';
export const EVAL_ASSERTION_SCHEMA_INVALID = 'JSON schema assertion requires a valid JSON object.';
export const EVAL_ADD_CASE_BTN = 'Add eval case';
export const EVAL_ADDING_CASE_BTN = 'Adding…';
export const EVAL_DELETE_CASE_BTN = 'Delete';
export const EVAL_CASE_SAVED = 'Golden eval case saved';
export const EVAL_CASE_DELETED = 'Golden eval case deleted';
export const EVAL_CASE_ERROR = 'Failed to save eval case';

export const EVAL_RUN_HEADING = 'Run comparative evaluation';
export const EVAL_CANDIDATE_LABEL = 'Candidate version';
export const EVAL_CANDIDATE_DRAFT_OPT = 'Current draft (v{version})';
export const EVAL_CANDIDATE_VER_OPT = 'Version v{version} ({status})';
export const EVAL_MODEL_LABEL = 'Eval model (optional)';
export const EVAL_MODEL_PLACEHOLDER = 'auto';
export const EVAL_RUN_BTN = 'Run eval suite';
export const EVAL_RUNNING_BTN = 'Running evaluation…';
export const EVAL_RUN_ERROR = 'Failed to run prompt evaluation';
export const EVAL_NO_DRAFT_NOTICE = 'Save a draft or select a saved version to run an evaluation.';

export const EVAL_LATEST_RUN_HEADING = 'Latest evaluation comparison';
export const EVAL_SUMMARY_BASELINE =
  'Baseline (published v{version}): {passed}/{total} passed ({rate}%) · avg {latency} ms · {tokens} tokens';
export const EVAL_SUMMARY_CANDIDATE =
  'Candidate (v{version}): {passed}/{total} passed ({rate}%) · avg {latency} ms · {tokens} tokens';
export const EVAL_REGRESSIONS_BADGE = '{count} regression(s)';
export const EVAL_IMPROVEMENTS_BADGE = '{count} improvement(s)';
export const EVAL_NO_REGRESSIONS_BADGE = '0 regressions';
export const EVAL_CASE_PASS_BADGE = 'PASS';
export const EVAL_CASE_FAIL_BADGE = 'FAIL';
export const EVAL_CASE_REGRESSED_TAG = 'Regressed';
export const EVAL_CASE_IMPROVED_TAG = 'Improved';

// ─── Weighted Canary Traffic Split ────────────────────────────────────────────
export const CANARY_SECTION_HEADING = 'Weighted canary rollout';
export const CANARY_SECTION_SUBTITLE =
  'Route 1–99% of live traffic to a candidate prompt version with sticky session hashing on X-Conversation-Id / endUser.';
export const CANARY_ENABLE_LABEL = 'Enable weighted canary traffic split';
export const CANARY_CANDIDATE_LABEL = 'Canary candidate version';
export const CANARY_SELECT_VERSION_PLACEHOLDER = 'Select candidate version';
export const CANARY_TRAFFIC_PERCENT_LABEL = 'Canary traffic (%)';
export const CANARY_SAVE_BTN = 'Save canary split';
export const CANARY_SAVING_BTN = 'Saving…';
export const CANARY_PROMOTE_BTN = 'Promote canary to published';
export const CANARY_PROMOTING_BTN = 'Promoting…';
export const CANARY_ABORT_BTN = 'Instant rollback (0%)';
export const CANARY_ABORTING_BTN = 'Rolling back…';
export const CANARY_SAVED_MSG = 'Canary rollout configuration updated';
export const CANARY_PROMOTED_MSG = 'Canary candidate promoted to 100% published';
export const CANARY_ABORTED_MSG = 'Canary aborted — 100% of traffic reverted to published';
export const CANARY_ERROR_MSG = 'Canary operation failed';
export const CANARY_METRICS_PUBLISHED =
  'Published: {impressions} reqs · {errors} errors · avg {latency} ms';
export const CANARY_METRICS_CANDIDATE =
  'Canary: {impressions} reqs · {errors} errors · avg {latency} ms';
export const CANARY_HEADER_HINT =
  'Responses include X-FreeLLM-Prompt-Variant: published | canary(vN).';

// ─── Real-Time SSE Credential Scrubber ────────────────────────────────────────
export const SCRUB_SECTION_HEADING = 'Real-time SSE credential scrubber';
export const SCRUB_SECTION_SUBTITLE =
  'Zero-leak chunk-boundary redaction for API keys (sk-*, AIza*, ghp_*, AKIA*, xoxb-*, npm_*), PEM private keys, JWTs, and DB connection URIs across streaming SSE and JSON responses without exposing raw secrets in guard event logs.';
export const SCRUB_ENABLE_TOGGLE_LABEL = 'Scrub leaked credentials in streaming & non-streaming responses';
export const SCRUB_SAVING_LABEL = 'Updating…';
export const SCRUB_SAVED_MSG = 'Credential stream scrubber updated';
export const SCRUB_ERROR_MSG = 'Failed to update credential stream scrubber';
