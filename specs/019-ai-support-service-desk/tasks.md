# Tasks: Support Service Desk & Widget Studio

**Inputs**: spec.md, plan.md, research.md, data-model.md, contracts.md, ownership.md.32 tasks; implementation and reviewer corrections delivered; acceptance evidence is recorded in review.md. Tests required before/with corresponding implementation. Each named path must belong to the assigned owner; see ownership.json for full prefixes.

## Phase 1 — Shared foundation

- [x] T001 [P] Agent1: Freeze shared DTOs, camelCase bounds, SupportRuntimeChatInput.intakeReceiptId and optional metadata in shared/support-service-desk.ts and shared/support-runtime.ts.
- [x] T002 Agent1: Create all5 tables in server/src/db/migrations/20261113_180001_support_service_desk.ts; register defaults.ts and roundtrip expectation; prove populated up/down/up/lazy schema/second Db in server/src/__tests__/db/migrate/support-service-desk.test.ts.
- [x] T003 Agent1: Implement typed encrypted store/OCC/claims/lease fencing in server/src/custom/x-gateway/support-service-desk-store.ts; publish actual exports before peers integrate.
- [x] T004 [P] Agent2: Prepare >=16 deterministic EN/VI/four-role Copilot cases in server/src/__tests__/fixtures/support-service-desk/copilot-cases.json; no fake production adapters.

## Phase 2 — US1 Widget and intake (P1)

- [x] T005 [P] [US1] Agent1: Write >=16 meaningful store/profile/intake/budget tests in server/src/__tests__/custom/x-support-service-desk-store.test.ts and x-support-widget-profile.test.ts before implementation.
- [x] T006 [US1] Agent1: Implement strict default-off config, public projection, schemaHash/OCC and bounded field validation in server/src/custom/x-gateway/support-widget-profile.ts and support-service-desk-store.ts.
- [x] T007 [US1] Agent1: Implement encrypted scoped intake issuance/replay/TTL/cap/atomic binding in server/src/custom/x-gateway/support-service-desk-store.ts; do not mutate CRM/identity.
- [x] T008 [US1] Agent3: Implement real config/intake routes, editor/public/signed-origin gates and safe snippet in server/src/custom/x-gateway/support-service-desk-router.ts; minimal mounts in console-router.ts/router.ts.
- [x] T009 [US1] Agent3: Integrate server intake gate/fingerprint in support-service-desk-runtime.ts, support-runtime.ts, support-runtime-store.ts and support-router.ts; both commit branches and internal workflow metadata required.
- [x] T010 [US1] Agent3: Add >=12 runtime intake/replay/race/default-off regressions in server/src/__tests__/custom/x-support-service-desk-runtime.test.ts; preserve existing017/018 tests.
- [x] T011 [US1] Agent4: Extend actual server/src/custom/x-gateway/support-runtime-widget.ts with opt-in profile load, safe branding, signed intake/receipt lifecycle and explicit continue; no bypass or raw browser storage.
- [x] T012 [P] [US1] Agent4: Add >=8 executed-script regressions in server/src/__tests__/custom/x-support-runtime-widget.test.ts for real profile/intake/defaults/prefix/auth/epoch/preview and keep every017/018 case.

## Phase 3 — US2 Operator Copilot (P1)

- [x] T013 [P] [US2] Agent2: Write >=14 tests in server/src/__tests__/custom/x-support-agent-copilot.test.ts for real context/evidence/model hooks/budget/claims/concurrency/timeout/replay/revocation; mock only external boundaries.
- [x] T014 [US2] Agent1: Complete durable per-actor request/token windows, attemptId idempotency, leaseToken fencing and retention in server/src/custom/x-gateway/support-service-desk-store.ts; no customer quota reuse.
- [x] T015 [US2] Agent2: Select original-customer canonical history and actual-policy018 packs in server/src/custom/x-gateway/support-agent-copilot.ts; no CRM/tools/arbitrary browser context.
- [x] T016 [US2] Agent2: Use real executeSupportChatPipeline hooks with before-attempt reservation, actual/conservative usage, deadline and strict cited JSON artifact validation in support-agent-copilot.ts; no fallback success/repair/auto-send.
- [x] T017 [US2] Agent2: Implement current conversation/evidence revalidation and safe encrypted job GET/replay in support-agent-copilot.ts; charge incurred work, withhold stale/raw artifacts.
- [x] T018 [US2] Agent3: Expose editor-only Copilot POST/GET via support-service-desk-router.ts, verified actor scope, abort/disconnect and exact error/usage envelopes; no second model executor.

## Phase 4 — US3 Queues and SLA (P1)

- [x] T019 [P] [US3] Agent3: Write >=16 deterministic routing/clock edge cases in server/src/__tests__/custom/x-support-sla-routing.test.ts covering4 priorities/departments and75%/100%/unobserved/reopen boundaries.
- [x] T020 [US3] Agent1: Implement encrypted SLA policy/OCC and versioned ticket-cycle persistence in support-service-desk-store.ts; no raw019 SQL in peer modules.
- [x] T021 [US3] Agent3: Implement pure select/calculate/initialize/transition in server/src/custom/x-gateway/support-sla-routing.ts with snapshot targets, explicit now and stable first-match routing.
- [x] T022 [US3] Agent3: Implement no-cycle support-service-desk-lifecycle.ts and atomic canonical workflow hooks in support-workflows.ts; direct/public/console create, human reply, resolveConversation, status, reopen and priority paths.
- [x] T023 [US3] Agent3: Expose bounded masked queue and versioned manual department change in support-service-desk-router.ts; no read backfill/AI, preserve untracked/not_observed distinctions.
- [x] T024 [US3] Agent3: Add >=10 lifecycle/rollback regressions in server/src/__tests__/custom/x-support-service-desk-lifecycle.test.ts and owned existing workflow tests; verify persisted clocks against actual canonical writes.

## Phase 5 — US4 Service Desk Studio (P2)

- [x] T025 [P] [US4] Agent4: Write >=12 native createRoot/act tests in client/src/custom/x-gateway/support-service-desk.test.tsx; no Testing Library; include four tabs/permissions/ENVI/OCC/late-tenant and explicit send.
- [x] T026 [US4] Agent4: Create complete EN/VI support-service-desk-strings.ts and minimal /thruline/support-desk import/route/nav in XGatewayApp.tsx and shell/nav.ts.
- [x] T027 [US4] Agent4: Implement four-tab pages/SupportServiceDesk.tsx and components/SupportWidgetPreview.tsx with same served preview renderer, zero preview transport and identity-safe state.
- [x] T028 [US4] Agent4: Wire real profile/intake/copilot/queue/snippet envelopes, manual draft copy/edit and existing human reply; verify client tsc/scoped lint and no secrets in snippet/browser storage.
- [x] T029 [US4] Agent3: Prove >=12 actual HTTP scenarios in server/src/__tests__/custom/x-support-service-desk-http.test.ts using createApp/auth/peer services; external provider/owned network fixtures only.

## Phase 6 — Reviewer gates

- [x] T030 Reviewer: Review actual four-owner diffs/exports against ownership.md/contracts.md/review.md; return fixes to owners, preserve016/Kiro and check current-main integration.
- [x] T031 Reviewer: Run quickstart.md full workspace/native UI/widget/migration/built import gates; inventory every server file and document real failures/retries/skips.
- [x] T032 Reviewer: Record evidence and scoped publication in review.md; only after acceptance publish the dedicated codex/support-service-desk branch and its PR to main, report CI and leave unmerged.

## Dependencies and parallel work

T001–T003 expose the frozen real store/schema/DTOs; T004/T005/T013/T019/T025 can prepare independent owned tests concurrently. US1 requires T006/T007 before T008/T009 and real widget intake acceptance. US2 needs claims T014 and018/store before generation T015–T017, then T018. US3 needs T020 plus pure T021 before canonical lifecycle T022/T024 and queue T023. UI skeleton/strings can run in parallel; T027/T028 require Agent3 envelope handshake. T029 composes actual services, not whole-runtime mocks. T030–T032 wait for all four handoffs.

MVP sequence: default-off profile + server-enforced signed intake, then safe operator Copilot, then real SLA lifecycle, then complete Studio/served widget. All four stories remain required for019 acceptance; do not ship a mock/fake half as complete. Exact ownership is disjoint; Agent3 has more integration touchpoints, not permission to edit peer code.

Agent allocation: Agent1=8 tasks; Agent2=5; Agent3=10; Agent4=6; reviewer=3. Counts represent responsibilities, not equal effort. Every implementation agent reports unresolved peer prerequisites instead of staging/pushing or claiming skipped integration passed.
