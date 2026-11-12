# Exclusive Four-Agent Ownership

**Reviewer remediation authorization (2026-11-12)**: After all four agents completed and round 1 review identified defects, the user explicitly instructed the reviewer to fix the failing parts. Corrections across the owned modules, a new additive fencing migration and regression tests are authorized. Existing unrelated spec016 work remains excluded. The original ownership below describes the implementation handoff.

All agents reuse `feat/9router-integration` in the existing checkout. Do not switch/reset branches, stash others' work, update the global Spec Kit pointer, edit another agent's files or create PRs. Do not stage/commit/push while sharing this checkout. Reviewer owns final review, staging, commit and PR creation after validation. No agent is asked to merge.

Spec017 documents are read-only inputs to implementers. Report contract gaps to the reviewer; never silently change shared signatures or expand ownership. Spec016 is separate and may be implemented concurrently: no017 agent edits its new files or changes its intended UI/router behavior.

## Agent 1 — Runtime, Context, Persistence & Quota Accounting

CREATE:

- `shared/support-runtime.ts`
- `server/src/custom/x-gateway/support-runtime-store.ts`
- `server/src/custom/x-gateway/support-runtime.ts`
- `server/src/db/migrations/20261112_170001_support_runtime_state.ts`
- `server/src/__tests__/custom/x-support-runtime.test.ts`
- `server/src/__tests__/db/migrate/support-runtime.test.ts`

EDIT ONLY:

- `server/src/custom/x-gateway/support-guardrails.ts` — canonical quota-delta helper/atomic counter support; preserve existing exports/semantics.

Owns US1 and server-side turn/conversation guarantees of US2; shared DTO source of truth. Publish exact exports first so peers can integrate. Does not edit support-router, runtime-router, connectors, workflow/CRM engines or frontend.

## Agent 2 — Action Execution, Durable Events & Safe Partner HTTP

CREATE:

- `server/src/custom/x-gateway/support-action-executor.ts`
- `server/src/custom/x-gateway/support-event-outbox.ts`
- `server/src/custom/x-gateway/support-safe-http.ts`
- `server/src/db/migrations/20261112_170002_support_execution_outbox.ts`
- `server/src/__tests__/custom/x-support-action-executor.test.ts`
- `server/src/__tests__/custom/x-support-event-outbox.test.ts`
- `server/src/__tests__/custom/x-support-safe-http.test.ts`
- `server/src/__tests__/db/migrate/support-execution-outbox.test.ts`

EDIT ONLY:

- `server/src/custom/x-gateway/support-connectors.ts` — safe HTTP hook for webhook and sql-http, optional stable Idempotency-Key for approved write.
- `server/src/custom/x-gateway/support-crm-webhooks.ts` — harden direct legacy dispatcher with real secret/safe transport; preserve public exports.
- `server/src/__tests__/custom/x-support-connectors.test.ts` — adapt local network fixtures to explicit server-only test allowlist without weakening production defaults.
- `server/src/__tests__/custom/x-support-crm-webhooks.test.ts` — preserve/extend legacy dispatcher assertions.

Owns US3 execution/outbox modules. Does not edit any router, core runtime, workflow store, index, shared DTO or client files. Use current `SupportPendingAction` storage through its existing functions inside short transactions; keep new execution state separately. No HTTP while a transaction is open.

## Agent 3 — HTTP Boundary, Pipeline Hooks, Lifecycle & Integrated Tests

CREATE:

- `server/src/custom/x-gateway/support-runtime-router.ts`
- `server/src/__tests__/custom/x-support-runtime-gateway.test.ts`

EDIT ONLY:

- `server/src/custom/x-gateway/support-router.ts` — chat/simulate runtime wiring, injected generation hooks, guest endpoint, served widget delegation. Preserve core route names/legacy response fields.
- `server/src/custom/x-gateway/support-enterprise-router.ts` — shared auth/origin validation, masked history, transactional lifecycle events and approval service.
- `server/src/custom/x-gateway/support-governance-router.ts` — shared auth/origin validation, transactional CSAT/blocked events, no public localhost override.
- `server/src/custom/x-gateway/console-router.ts` — import and mount runtime console router at `/support`; minimal isolated hook.
- `server/src/index.ts` — start worker once after DB init; stop before DB close. Minimal hook only.
- `server/src/__tests__/custom/x-support-gateway.test.ts`
- `server/src/__tests__/custom/x-support-enterprise.test.ts`
- `server/src/__tests__/custom/x-support-governance.test.ts`

Owns actual routing and cross-module trust boundaries for US1–US3 plus readiness/outbox endpoints for US4. Existing test behavior intentionally made stricter must be updated with explicit security assertions, not skipped. Does not edit Agent1/2/4 modules; do not recreate their implementations in routers.

## Agent 4 — Partner Widget & Integration Studio

CREATE:

- `server/src/custom/x-gateway/support-runtime-widget.ts`
- `server/src/__tests__/custom/x-support-runtime-widget.test.ts`
- `client/src/custom/x-gateway/support-integration-strings.ts`
- `client/src/custom/x-gateway/pages/SupportIntegration.tsx`
- `client/src/custom/x-gateway/support-integration.test.tsx`

EDIT ONLY:

- `client/src/custom/x-gateway/XGatewayApp.tsx` — imports, localized nav `/x/support-integration`, route `support-integration`; preserve 013–016 entries.

Owns US2 browser experience and US4 onboarding UI. Does not edit support-router.ts; Agent3 serves the standalone script factory. No imports of @testing-library packages, no dependency/manifest/lockfile changes. Native React createRoot/act only. Widget tests may use jsdom already installed and mocked fetch; no real external traffic.

## Parallel Work / Ownership Collision Rule

- Agents 1 and 2 first expose documented types/functions in their owned files. Agents 3 and 4 may start tests/UI against frozen contracts immediately, then run integrated checks when peer modules exist.
- The same files `console-router.ts` and `XGatewayApp.tsx` are entry points in016 too. If016 is actively modifying them,017 Agents3/4 must coordinate the minimal additions and preserve all current changes; do not overwrite full files. No autonomous merge/rebase in a shared checkout.
- A missing peer file is a dependency to report, never a reason to add a production stub or violate ownership. Before reporting done, rerun relevant tests against actual peer code.
- Each completion report includes exact changed files, tests/commands+exit status, unresolved limitations, external effect semantics and assumptions. Reviewer must see all four reports before PR acceptance.
