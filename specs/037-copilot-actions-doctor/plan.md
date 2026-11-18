# Technical Implementation Plan: Spec 037 — Action-Taking In-App Copilot & AI Error Doctor

**Branch**: `feat/037-copilot-actions-doctor`  
**Date**: 2026-11-18  

## 1. Architecture & Zero-Conflict Boundaries

Following `AGENTS.md` and `.specify/memory/constitution.md`, all changes are isolated inside the existing Copilot vertical slice without modifying `server/src/custom/register.ts`, `client/src/App.tsx`, shared i18n bundles, or database migrations:

1. **Shared DTOs (`shared/support-setup-copilot.ts`)**:
   - Define `CopilotUserDiagnosticReport`, `CopilotDiagnosticIssue`, `CopilotPersonalKeySummary`, `CopilotQuotaUsageSummary`, `CopilotOnboardingChecklist`, `CopilotActionProposal`, `CopilotIdeConfigSnippets`, `CopilotExecuteActionRequest`, and `CopilotExecuteActionResponse`.
   - Extend `SupportSetupStatusResponse` (`memberCopilotVisible`, `onboarding`) and `SupportSetupChatResponse` (`userDiagnostic`, `actionProposal`, intents `'diagnose_errors' | 'propose_action'`) with backward-compatible optional fields.

2. **Server Self-Diagnostics Engine (`server/src/custom/support-setup-copilot/error-doctor.ts`)**:
   - `buildUserErrorDiagnosticReport(user, options)`: Queries `requests` (`WHERE user_id = ?`), `listUserApiKeys(user.userId)`, `getQuotaState('user', user.userId)`, `getUserUsage(user.userId)`, and `getStarterQuotaConfig()`.
   - Classifies recent failures into `rate_limit_429`, `bad_request_400`, `quota_guardrail_403`, `upstream_5xx_timeout`, and `other_error`, plus latency spike detection.
   - `sanitizeDiagnosticErrorSummary(raw)`: Scrubs API keys (`sk-*`, `AIza*`, `ghp_*`, JWTs, `Bearer` tokens, query-string secrets, and upstream internal URLs) so admin upstream secrets can never leak.
   - `matchErrorDoctorIntent(message)` & `buildErrorDoctorChatResponse(...)`: Detects accented/unaccented Vietnamese and English troubleshooting prompts, produces natural human-like VI/EN root-cause analysis, and attaches a 1-click remediation `actionProposal`.

3. **Server Consent-Gated User Actions (`server/src/custom/support-setup-copilot/user-actions.ts`)**:
   - `buildOnboardingChecklist(userId)`: Computes live completion state for Step 1 (active personal key), Step 2 (successful Playground / inference run), and Step 3 (external IDE/CLI traffic via personal key `last_used_at` or `client_agent`).
   - `matchUserActionIntent(message, user)` & `buildActionProposalChatResponse(...)`: Parses chat requests for `create_personal_key`, `switch_key_routing_mode`, and `open_onboarding_guide` and returns non-mutating `actionProposal` cards.
   - `executeCopilotUserAction({ user, body, serverOrigin })`: Enforces `confirmed === true`, validates ownership (`user_id = user.userId`), enforces active key cap (`MAX_ACTIVE_PERSONAL_KEYS = 20`) and RPM inheritance, delegates to `mintUserApiKey` / `updateUserKeyAiConfig`, and generates Cursor, Claude Code, and OpenCode config snippets.

4. **Router Wiring (`server/src/custom/support-setup-copilot/router.ts`)**:
   - Add `GET /diagnostics` and `POST /execute-action` behind `requireSignedInUser` and per-user rate limiters.
   - Integrate Error Doctor & User Action proposals into `POST /chat` while preserving existing 403/RBAC semantics for unauthorized Support Tenant setup attempts.
   - Include `memberCopilotVisible: true` and `onboarding` in `GET /status`.

5. **Client UI (`client/src/custom/support-setup-copilot/*`)**:
   - Enable member Copilot mode on `/assistants`, `/agents`, and `/keys` (while preserving operator/tenant-portal behavior on `/thruline/*` and `/tenant-portal/*`).
   - Render interactive Diagnostic Summary cards (health badge, quota progress, error breakdown, active keys), Human-in-the-Loop Action Confirmation cards (`[Confirm & Run]` / `[Cancel]`), one-time minted key + tabbed IDE config copier (`Cursor` / `Claude Code` / `OpenCode`), and live 3-step Onboarding Checklist cards.
   - Localize all new UI copy in `strings.ts` (VI & EN) and style cleanly in `support-setup-copilot.css`.

## 2. Verification Plan

- **Server Integration & Security Suite (`server/src/__tests__/custom/copilot-actions-doctor.test.ts`)**:
  - Strict user isolation (User A vs User B logs, keys, diagnostics, and `switch_key_routing_mode` 404 isolation) and upstream secret redaction.
  - Diagnostics accuracy across 429 rate-limit, 400 context, 403 quota/guardrail, 5xx timeout, and Starter/User Quota exhaustion.
  - Accented VI, unaccented VI, and EN detection & responses.
  - Consent enforcement (`confirmed: false` rejected; chat never mutates state) and end-to-end execution of `create_personal_key`, `switch_key_routing_mode`, and `open_onboarding_guide`.
- **Client Component Suite (`client/src/custom/support-setup-copilot/support-setup-copilot.test.tsx`)**:
  - Verify existing 7-step setup tests plus new Error Doctor card, `[Confirm & Run]` / `[Cancel]` action execution, IDE snippet tabs, and 3-step onboarding checklist rendering.
- **Full Gate**: Existing `support-setup-copilot` tests, `surface.test.ts`, `npm run lint`, and `npm run build`.
