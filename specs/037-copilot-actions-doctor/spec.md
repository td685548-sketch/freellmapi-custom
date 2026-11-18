# Feature Specification: Action-Taking In-App Copilot & AI Error Doctor (Spec 037)

**Feature Branch**: `feat/037-copilot-actions-doctor`  
**Created**: 2026-11-18  
**Status**: Implemented  

## 1. Overview & Problem Statement

Members and operators using FreeLLMAPI often encounter self-service questions when connecting coding IDEs (Cursor, Claude Code, OpenCode) or troubleshooting API failures (`429` rate limits, `400` context/payload errors, `403` quota/guardrail blocks, `5xx` upstream timeouts, or elevated latency). Previously, the In-App Copilot focused solely on 7-step Support Tenant setup and required users to manually inspect separate pages to diagnose errors, mint personal keys, or change key routing modes.

Spec 037 upgrades the In-App Copilot into an **Action-Taking Assistant & AI Error Doctor** with strict user isolation (`req.user.userId`) and mandatory Human-in-the-Loop confirmation (`[Confirm & Run]` / `[Cancel]`) before any state-mutating action executes.

## 2. User Stories & Functional Requirements

### US1 — AI Error Doctor (Account Self-Diagnostics)
- **Endpoint**: `GET /api/support-setup-copilot/diagnostics` and conversational integration in `POST /api/support-setup-copilot/chat`.
- **Strict Tenant & User Isolation**:
  - Scoped exclusively to the authenticated session user (`req.user.userId`).
  - Never exposes another user's request logs, personal keys, or usage counters.
  - Never exposes admin upstream provider keys (`api_keys`, `x_gateway_keys`), upstream base URLs, or raw credentials; error summaries are scrubbed via secret-redaction filters before leaving the server.
- **Diagnostic Signals**:
  - Recent inference requests (`429` rate-limit/cooldown, `400` bad request/context window, `403` quota/guardrail/policy, `5xx`/timeout, and latency spikes).
  - Active Personal API Keys (`sk-flm-...` masked prefixes) and their bound `routingMode` (`default`/`eco`/`balanced`/`max`) and `assistantId`.
  - Live Starter / User Quota usage percentages (daily & monthly requests/tokens) and RPM ceiling.
- **Bilingual Conversational Root-Cause Analysis**:
  - Understands accented Vietnamese, unaccented Vietnamese (`"sao goi api bi loi 429"`, `"kiem tra tai khoan giup minh"`), and English (`"diagnose my errors"`, `"why are my API calls failing?"`).
  - Responds with warm, human-like root-cause analysis, an interactive diagnostic summary card, and a recommended 1-click remediation `actionProposal`.

### US2 — Human-in-the-Loop Action Cards (`POST /api/support-setup-copilot/execute-action`)
- Chat responses include optional `actionProposal` cards that **never** mutate database state during `POST /chat`. State changes occur only when the signed-in user clicks `[Confirm & Run]` (`confirmed: true`).
- Supported actions:
  1. **`create_personal_key`**: Mints a new Personal API Key for `req.user.userId` (enforcing active-key caps, user RPM inheritance, and assistant audience RBAC), optionally binds `routingMode` (`eco` / `balanced` / `max`) and `assistantId`, and returns the one-time plaintext key plus ready-to-copy **Cursor**, **Claude Code**, and **OpenCode** configuration snippets inside the chat card.
  2. **`switch_key_routing_mode`**: Updates an active Personal API Key owned by `req.user.userId` to `eco`, `balanced`, or `max`. Cross-user or revoked key IDs are rejected with `404`.
  3. **`open_onboarding_guide`**: Displays an interactive 3-step Member Onboarding checklist card (**1. Mint Personal Key → 2. Test in Playground/AI Hub → 3. Connect IDE**) with live completion checkmarks derived from the user's real account state.

## 3. Non-Functional & Security Requirements

- **Zero-Conflict Modular Design**: Touch only `shared/support-setup-copilot.ts`, `server/src/custom/support-setup-copilot/*`, `client/src/custom/support-setup-copilot/*`, and `server/src/__tests__/custom/copilot-actions-doctor.test.ts`. Leave `register.ts`, `App.tsx`, shared i18n, and migrations untouched.
- **Backward Compatibility**: All existing 7-step Support Tenant Setup Copilot flows, RBAC boundaries, and test suites continue passing without regression.
