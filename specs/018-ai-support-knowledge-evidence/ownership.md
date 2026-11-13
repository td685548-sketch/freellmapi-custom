# Exclusive Four-Agent File Ownership

Final integration exception (2026-11-13): user explicitly requested the reviewer implement the remaining fixes. Reviewer may compose current main, fix018 canonical URLs/tests/localization and move the pure legacy URL mapper into `client/src/custom/x-gateway/legacy-gateway-target.ts` with a minimal import change in `client/src/App.tsx` to satisfy the inherited Fast Refresh lint rule. `server/src/__tests__/routes/proxy-array-content.test.ts` may mock only the external Groq boundary to remove a demonstrated live-network timeout during full validation. Preserve pending Kiro/spec016 files; do not include them in the018 commit. Original implementation-agent boundaries and historical handoffs below remain unchanged.

Use existing feat/9router-integration. Do not switch/reset/merge/rebase/stash/clean the shared checkout or create a worktree/branch. Do not stage, commit, push or create/merge PRs. Read AGENTS.md and the018 documents; spec016 and its untracked documents remain untouched. Do not run016 and018 in parallel on this checkout. Reviewer owns final integration review, safe main synchronization and publication after all four handoffs.

Only paths explicitly listed for an agent may be written. All others are read-only, including018 specs/prompts, packages/lockfiles/CI and peer-owned files. If a necessary edit is missing, report the exact path/reason to the reviewer; do not make a silent ownership exception or create an alternative production fallback. Report an incompatible earlier016/other-agent change rather than overwriting it.

## Agent1 — Shared DTOs, Import, Versioned Store & All New Schema

CREATE:
- shared/support-evidence.ts
- server/src/custom/x-gateway/support-evidence-store.ts
- server/src/custom/x-gateway/support-evidence-import.ts
- server/src/db/migrations/20261113_090001_support_evidence.ts
- server/src/__tests__/custom/x-support-evidence-store.test.ts
- server/src/__tests__/custom/x-support-evidence-import.test.ts
- server/src/__tests__/db/migrate/support-evidence.test.ts

EDIT ONLY:
- shared/support-runtime.ts — additive evidence field/replySource type; preserve017 defaults.
- server/src/db/migrate/defaults.ts — register the new migration exactly once/in order.
- server/src/__tests__/db/migrate/roundtrip.test.ts — append the new migration expectation, preserve tests.

Owns DTOs for all stories, all018 tables including suite/run/provenance, source/policy/suite/report/reference persistence, text/export import, OCC/publish/archive and encryption. Do not touch support-knowledge.ts, routes/runtime, safe HTTP engine, widget/client or Agent2 modules. Reuse safeFetch/crypto; do not modify existing migrations.

## Agent2 — Retrieval, Citation Verification & Retrieval Evaluations

CREATE:
- server/src/custom/x-gateway/support-evidence-retrieval.ts
- server/src/custom/x-gateway/support-evidence-evaluations.ts
- server/src/__tests__/custom/x-support-evidence-retrieval.test.ts
- server/src/__tests__/custom/x-support-evidence-evaluations.test.ts
- server/src/__tests__/fixtures/support-evidence/evaluation-cases.json

No existing file edits. Own normalized lexical ranking, read-only legacy adapter, exact bounded pack, current snapshots, fresh/stored citation validation, suite execution and >=24 fixture cases. Read Agent1 store/shared APIs and existing knowledge/masking; no DB schema, router/runtime imports, live model/network calls, runtime overrides, business tools, new packages or production seed endpoint.

## Agent3 — Actual Runtime, HTTP, Replay/History & Integration Proof

CREATE:
- server/src/custom/x-gateway/support-evidence-router.ts
- server/src/custom/x-gateway/support-evidence-runtime.ts
- server/src/__tests__/custom/x-support-evidence-runtime.test.ts
- server/src/__tests__/custom/x-support-evidence-http.test.ts

EDIT ONLY:
- server/src/custom/x-gateway/console-router.ts — minimal console mount under /support.
- server/src/custom/x-gateway/support-runtime.ts — required-mode orchestration, zero-model outcome, atomic settlement/provenance and no rejected-answer persistence.
- server/src/custom/x-gateway/support-runtime-store.ts — revalidation bridge/cached records as necessary; preserve017 scope/TTL/claim semantics.
- server/src/custom/x-gateway/support-router.ts — trusted provider hooks, modelUsed nullable for zero-model required outcome and canonical public response.
- server/src/custom/x-gateway/support-workflows.ts — additive message fields and guarded canonical history reads; no destructive migration of legacy history.
- server/src/__tests__/custom/x-support-runtime.test.ts
- server/src/__tests__/custom/x-support-runtime-http.test.ts
- server/src/__tests__/custom/x-support-runtime-gateway.test.ts
- server/src/__tests__/custom/x-support-enterprise.test.ts
- server/src/__tests__/custom/x-support-workflows.test.ts

Own all API routes and runtime/workflow bridge changes. Enforce editor permissions even for GET, public identity/origin/owner first, required-mode no CRM/business tools, no extra AI repair call, provider failure503, no-await DB transaction, current-snapshot recheck, cache409 and historical redaction. Do not edit shared/store/retrieval/schema/frontend/widget. Reuse existing model/quota/action services, no secondary executor.

## Agent4 — Knowledge Studio, Navigation & Actual Embeddable Widget

CREATE:
- client/src/custom/x-gateway/support-evidence-strings.ts
- client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx
- client/src/custom/x-gateway/support-evidence.test.tsx

EDIT ONLY:
- client/src/custom/x-gateway/XGatewayApp.tsx — import/route support-knowledge only, preserve live shell.
- client/src/custom/x-gateway/shell/nav.ts — localized Customer Support item, same entries feed QuickJump.
- server/src/custom/x-gateway/support-runtime-widget.ts — extend actual served widget for evidence/non-AI statuses and explicit fresh-request retry.
- server/src/__tests__/custom/x-support-runtime-widget.test.ts — add executed-script regressions, preserve017 cases.

Own complete EN/VI, editor-only four-tab management workflow, request/conflict/tenant isolation, safe inline citation cards, responseNotice reload and current widget lifecycle. Native React createRoot/act only; NEVER import @testing-library/react. Do not edit routers/DTOs/engines, global CSS/theme, brand/logo, manifests or other tests.

## Handshake and final safety

1. Agent1 publishes DTOs and store signatures from data-model.md first, then migration/bootstrap exports. Agent2 can prepare deterministic fixtures/pure functions, Agent3 API tests, Agent4 UI against the documented wire contract.
2. Agent2 publishes retrieve/snapshot/validate/stored-validate/runSuite exports. Agent3 integrates real services. No dynamic missing-module catch, in-memory fake store, generated fake citation ID or fake provider success may remain.
3. Agent3 confirms responseNotice/evidence, envelopes/errors and actual endpoints with Agent4. Agent4 verifies native widget and page against those names; report deviations instead of editing peer files.
4. Per-owner tests use only owned files. Final full build waits until peer contracts compile; report transient missing-peer exports honestly, then rerun. No skip/ts-ignore/any cast to hide final errors.
5. All four send completion report with exact files, task IDs, test commands/results, exported interfaces, actual integration status and any unverified issue. Reports do not authorize PR acceptance by themselves.

Only the reviewer may create a final PR after actual code review and verification. Reviewer will return fixes to the owning agent; reviewer does not take over implementation unless the user explicitly requests it later. No merge authorization is implied.
