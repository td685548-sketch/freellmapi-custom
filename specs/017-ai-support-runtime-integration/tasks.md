# Tasks: AI Support Runtime Integration

**Input**: spec.md, plan.md, research.md, data-model.md, contracts.md, ownership.md.
**Tests**: Required by this feature and repository constitution. IDs are stable; ownership.md is authoritative.

## Phase 1 — Contract/Foundation

- [x] T001 [P] Agent1 create exact external DTOs in `shared/support-runtime.ts` and publish server exports from `server/src/custom/x-gateway/support-runtime.ts` / `support-runtime-store.ts` according to data-model.md.
- [x] T002 [P] Agent2 establish execution/outbox/safe transport interfaces in `server/src/custom/x-gateway/support-action-executor.ts`, `support-event-outbox.ts`, `support-safe-http.ts` without importing routers/runtime.
- [x] T003 Agent1 create reversible durable turn/lease/reservation/guest-throttle schema in `server/src/db/migrations/20261112_170001_support_runtime_state.ts` and roundtrip/second-memory-Db tests in `server/src/__tests__/db/migrate/support-runtime.test.ts`.
- [x] T004 Agent2 create reversible execution/event/delivery schema in `server/src/db/migrations/20261112_170002_support_execution_outbox.ts` and roundtrip tests in `server/src/__tests__/db/migrate/support-execution-outbox.test.ts`.

## Phase 2 — US1: Real Chat Orchestration (P1 / MVP)

**Independent test**: Stub only provider boundary; call actual runtime and HTTP /chat and observe denial/context/masking/accounting behavior.

- [x] T005 [US1] Agent1 implement policy, atomic claim/lease, encrypted masked response cache, 24-hour dedup and 120-second lease expiry in `server/src/custom/x-gateway/support-runtime-store.ts`.
- [x] T006 [US1] Agent1 add canonical finite-integer transactional quota deltas in `server/src/custom/x-gateway/support-guardrails.ts`; reserve/reconcile same-window budgets in `server/src/custom/x-gateway/support-runtime-store.ts`, counting one request per turn and no client-supplied usage.
- [x] T007 [US1] Agent1 implement firewall -> bounded role RAG/own CRM/history -> reserve -> injected generate -> masked persist/settle in `server/src/custom/x-gateway/support-runtime.ts`; reject usedFallback production success and unknown cost refunds.
- [x] T008 [P] [US1] Agent1 cover twenty-way quota contention, replay, changed fingerprint, masked tool/response/history, forbidden role docs and estimated usage in `server/src/__tests__/custom/x-support-runtime.test.ts`.
- [x] T009 [US1] Agent3 wire shared token/origin/model/schema validation and generation hooks into chat and simulator in `server/src/custom/x-gateway/support-router.ts`; no public path can bypass runtime, including fallback/tool branches.
- [x] T010 [US1] Agent3 prove zero provider/tool calls on blocked/invalid/exhausted input through actual HTTP handlers in `server/src/__tests__/custom/x-support-runtime-gateway.test.ts`, preserving existing successful response fields.

## Phase 3 — US2: Persistent Sessions & Handoff (P1)

**Independent test**: Unique guest or signed user resumes own conversation, reloads widget, escalates and sees human reply; cross-user reads/writes denied.

- [x] T011 [US2] Agent1 implement signed ownership-checked history and persistent single-turn message appends in `server/src/custom/x-gateway/support-runtime.ts`; unsigned guests remain stateless with no personal tools/actions.
- [x] T012 [US2] Agent3 add guest-session TTL900 and durable 20-per-minute tenant/IP issuance limit in `server/src/custom/x-gateway/support-router.ts` with throttle storage from Agent1, reject role/user claims.
- [x] T013 [US2] Agent3 verify conversation ownership before escalation/CSAT and mask history through shared boundary helpers in `server/src/custom/x-gateway/support-enterprise-router.ts` and `support-governance-router.ts`.
- [x] T014 [P] [US2] Agent4 implement safe cross-origin widget script, request dedup IDs, authorized resume, escalation, CSAT, visible-only staff polling, token updates and destroy cancellation in `server/src/custom/x-gateway/support-runtime-widget.ts`.
- [x] T015 [P] [US2] Agent4 test script execution in jsdom for cross-domain base, reload, expired-token no-downgrade, malicious text, identity change and retry IDs in `server/src/__tests__/custom/x-support-runtime-widget.test.ts`.
- [x] T016 [US2] Agent3 delegate GET widget.js to the Agent4 script factory and add ownership/handoff/replay integration cases in `server/src/__tests__/custom/x-support-runtime-gateway.test.ts`.

## Phase 4 — US3: Guarded Actions & Durable Events (P1)

**Independent test**: Zero write HTTP before approval; concurrent reviews cannot duplicate execution; outbox survives restart and retry.

- [x] T017 [US3] Agent2 implement public-DNS-bound safe HTTP, reject redirects/private destinations/credential URLs and require actual signing secret in `server/src/custom/x-gateway/support-safe-http.ts`, `support-connectors.ts`, `support-crm-webhooks.ts`; console test opt-in is server-owned only.
- [x] T018 [US3] Agent2 implement POST-default approval, locked argument/snapshot validation, atomic action claim and terminal/unknown execution outcomes in `server/src/custom/x-gateway/support-action-executor.ts`; missing tool returns422, no simulated success.
- [x] T019 [US3] Agent2 implement atomic enqueue, stable event identity, per-recipient claims, five attempts (1/5/30/120-second backoff), 5-second timeouts and bounded Retry-After in `server/src/custom/x-gateway/support-event-outbox.ts`.
- [x] T020 [P] [US3] Agent2 cover concurrent approval, response-loss unknown outcome, restart, duplicate enqueue, safe DNS/redirect cases and retries in `server/src/__tests__/custom/x-support-action-executor.test.ts`, `x-support-event-outbox.test.ts`, `x-support-safe-http.test.ts` and owned legacy connector/CRM tests.
- [x] T021 [US3] Agent3 replace direct approve execution with Agent2 service and authenticated reviewer identity in `server/src/custom/x-gateway/support-enterprise-router.ts`; wire ticket/approval/CSAT/blocked events atomically in enterprise/governance routers, removing public localhost override.
- [x] T022 [US3] Agent3 start/stop the worker around DB lifecycle using minimal changes in `server/src/index.ts`, and prove real route events/duplicate review behavior in `server/src/__tests__/custom/x-support-runtime-gateway.test.ts`.

## Phase 5 — US4: Integration Studio (P2)

**Independent test**: Admin configures runtime and reads readiness/outbox/embed in EN/VI with no provider/network probe; tenant changes clear prior state.

- [x] T023 [US4] Agent3 implement runtime GET/PUT, readiness and outbox GET/retry in `server/src/custom/x-gateway/support-runtime-router.ts`, mount minimally in `server/src/custom/x-gateway/console-router.ts`; validate DTO integer bounds and wrong-tenant tool references.
- [x] T024 [P] [US4] Agent4 create full EN/VI strings and readiness/runtime/deliveries/embed page in `client/src/custom/x-gateway/support-integration-strings.ts` and `pages/SupportIntegration.tsx`; add isolated localized nav/route in `XGatewayApp.tsx`.
- [x] T025 [P] [US4] Agent4 write native createRoot/act tests covering each panel, policy save validation, dead delivery retry, safe snippet, readonly state and tenant/session isolation in `client/src/custom/x-gateway/support-integration.test.tsx`; no Testing Library/dependency changes.

## Phase 6 — Reviewer Acceptance (after all four handoffs)

- [x] T026 Reviewer inspect ownership and every actual changed path against `specs/017-ai-support-runtime-integration/ownership.md`; review call graph for unguarded alternatives, circular imports, unsanitized traces and false success.
- [x] T027 Reviewer execute `specs/017-ai-support-runtime-integration/quickstart.md` and all test/build/lint/migration checks; resolve the reported failures under the user’s explicit remediation authorization and rerun after fixes.
- [x] T028 Reviewer record evidence and scoped commit inventory using `specs/017-ai-support-runtime-integration/review.md`; reuse existing open integration PR or create the next PR only when accepted. Do not merge.

## Dependencies & Parallel Execution

T001/T002 publish the frozen contracts; T003/T004 can then proceed independently. A1 implements runtime while A2 implements execution/outbox. A3/A4 can prepare route/UI tests using mocks immediately, but final acceptance requires actual peer implementations. T009 depends on T007; T018 reads runtime policy from T005; T021 depends on T018/T019; T016 depends on T014. T023 may be mocked by A4 until real routes are available. T026–T028 wait for all owners.

Story counts: US1=6, US2=6, US3=6, US4=3; foundation=4; reviewer=3; total28 tasks. Agent workloads cross stories intentionally but file ownership is disjoint. MVP is US1 with the required US3 approval gate; no partial release of unguarded tool execution.
