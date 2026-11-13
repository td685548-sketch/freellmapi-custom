# Tasks: Knowledge Evidence & Answer Quality

**Inputs**: spec.md, plan.md, research.md, data-model.md, contracts.md, ownership.md. Tests are required. Exact file lists remain authoritative; Agent1/2/3/4 are independent owners, not sub-agents launched by the reviewer.

## Phase 1 — Setup / Frozen contracts

- [x] T001 [P] Agent1 freeze SupportEvidence DTOs and exact limits in shared/support-evidence.ts; make only additive017 metadata changes in shared/support-runtime.ts per data-model.md.
- [x] T002 Agent1 create all seven018 tables in server/src/db/migrations/20261113_090001_support_evidence.ts; register once/in order in server/src/db/migrate/defaults.ts and append default expectation in server/src/__tests__/db/migrate/roundtrip.test.ts.
- [x] T003 Agent1 prove up/down/up, tenant/revision integrity, encryption and a second independent memory Db in server/src/__tests__/db/migrate/support-evidence.test.ts; run existing registry-drift test.
- [x] T004 [P] Agent2 establish deterministic fixture shape and typed read-only peer API harness in server/src/__tests__/custom/x-support-evidence-retrieval.test.ts and server/src/__tests__/fixtures/support-evidence/evaluation-cases.json; no production fallback or schema edits.

## Phase 2 — US1: Import and publish knowledge (P1)

**Independent test**: draft ->publish ->new draft leaves live intact ->atomic switch; invalid import/stale OCC leaves prior data untouched.

- [x] T005 [P] [US1] Agent1 add >=14 meaningful store/import tests in server/src/__tests__/custom/x-support-evidence-store.test.ts and server/src/__tests__/custom/x-support-evidence-import.test.ts for ACL/draft/encryption/dedup/OCC/abort/size/redirect/unsupported input and unchanged live source.
- [x] T006 [US1] Agent1 implement tenant-scoped source/policy CRUD with default admin-only ACL, expectedVersion, max50 sources and no corrupt-policy fallback in server/src/custom/x-gateway/support-evidence-store.ts.
- [x] T007 [US1] Agent1 implement UTF-8 text/Markdown/FAQ JSON import in server/src/custom/x-gateway/support-evidence-import.ts: <=1MiB raw, <=64,000 normalized code units, <=128 chunks/revision,5-second total deadline, existing safeFetch, allowed export types only and no late commit.
- [x] T008 [US1] Agent1 implement encrypted immutable revisions, canonical hash dedup, max20 revisions/source, OCC publish/rollback/archive and max4000 live chunks in server/src/custom/x-gateway/support-evidence-store.ts; network outside transaction, pointer/limits atomic.
- [x] T009 [US1] Agent3 implement editor-only source/revision/policy endpoints in server/src/custom/x-gateway/support-evidence-router.ts and minimal mount in server/src/custom/x-gateway/console-router.ts; verify real HTTP authentication/403/404/input and OCC responses.

## Phase 3 — US2: Evidence-based answers (P1)

**Independent test**: actual chat runtime sees authorized provided text only, validates citations, abstains honestly, charges correct usage and invalidates stale replay/history.

- [x] T010 [P] [US2] Agent2 add >=12 retrieval/citation regressions in server/src/__tests__/custom/x-support-evidence-retrieval.test.ts: EN/VI, role/tenant, draft, over-budget, spoofed IDs, legacy edit/delete, source/masking/ACL change and no semantic-confidence claim.
- [x] T011 [US2] Agent2 implement accent-normalized bounded lexical retrieval and role-first new/legacy filtering in server/src/custom/x-gateway/support-evidence-retrieval.ts; <=100 visible legacy docs, explicit over-capacity, stable documented score/coverage (not confidence).
- [x] T012 [US2] Agent2 implement active snapshot and exact EvidencePack in server/src/custom/x-gateway/support-evidence-retrieval.ts; drafts excluded, policy/masking/legacy changes covered, context fits both policy/runtime budgets, only actually provided candidates are eligible.
- [x] T013 [US2] Agent2 validate1..5 citations/current snapshot and durable stored references in server/src/custom/x-gateway/support-evidence-retrieval.ts; canonical numeric markers, reject unknown/malformed/stale IDs, mask public excerpts<=240 chars and do not claim entailment.
- [x] T014 [P] [US2] Agent3 add >=12 composed/runtime HTTP cases in server/src/__tests__/custom/x-support-evidence-runtime.test.ts and server/src/__tests__/custom/x-support-evidence-http.test.ts, mocking only external provider/export boundaries; preserve owned017 regressions and test20-way quota/replay, no fake AI on abstention, rejected answer absent from all persisted/returned aliases.
- [x] T015 [US2] Agent3 implement prepare/finalize helpers in server/src/custom/x-gateway/support-evidence-runtime.ts and generation hooks in server/src/custom/x-gateway/support-router.ts: required disables all business tools/CRM, off preserves017; no matches !=provider failure and no citation-repair call.
- [x] T016 [US2] Agent3 integrate honest modelUsed/replySource, one-request/zero-model accounting, current snapshot check and atomic provenance/history/cache/settlement in server/src/custom/x-gateway/support-runtime.ts and server/src/custom/x-gateway/support-runtime-store.ts; cached018 snapshot change409 with no automatic regeneration.
- [x] T017 [US2] Agent3 persist optional evidence/responseNotice and guard canonical history getters in server/src/custom/x-gateway/support-workflows.ts using server/src/custom/x-gateway/support-evidence-runtime.ts; no read-side mutation, no workflow runtime import cycle, provenance survives turn TTL, required provider context excludes unprovenanced AI history.

## Phase 4 — US3: Retrieval evaluation workflow (P2)

**Independent test**: >=24 ground-truth cases yield deterministic role-safe reports; changed sources, timeout and incomplete evaluation never report a full pass.

- [x] T018 [P] [US3] Agent2 add >=8 evaluation cases in server/src/__tests__/custom/x-support-evidence-evaluations.test.ts including source removal, forbidden result, no expected-ID denominator, deadline/partial, snapshot change and zero external calls/operational mutation.
- [x] T019 [US3] Agent1 persist suites(cases1..50, query<=500 chars, expected/forbidden disjoint/in-tenant), OCC updates, encrypted run results and durable answer references in server/src/custom/x-gateway/support-evidence-store.ts; no answer FK deletion on runtime-turn expiry.
- [x] T020 [US3] Agent2 implement zero-provider/network/quota evaluation with2-second CPU budget and honest partial/snapshot/denominator reporting in server/src/custom/x-gateway/support-evidence-evaluations.ts; author >=24 EN/VI/four-role/no-match/cross-tenant fixtures in server/src/__tests__/fixtures/support-evidence/evaluation-cases.json.
- [x] T021 [US3] Agent3 expose preview/suite/run endpoints and safe tenant validation in server/src/custom/x-gateway/support-evidence-router.ts; actual report cannot leak hidden-role titles/snippets or execute live source refresh.

## Phase 5 — US4: Management and website experience (P2)

**Independent test**: editor manages published sources and quality; non-editor cannot fetch content; widget safely shows sources/notices across reload/identity change.

- [x] T022 [P] [US4] Agent4 add >=10 native createRoot/act tests in client/src/custom/x-gateway/support-evidence.test.tsx for four tabs, CRUD/publication, conflict, preview/policy/eval, permission, EN/VI and late tenant/session changes; NEVER import Testing Library.
- [x] T023 [P] [US4] Agent4 add >=6 executed-script regressions to server/src/__tests__/custom/x-support-runtime-widget.test.ts for citations/XSS/abstention/reload/dedup/stale retry/identity cancellation; retain every017 regression.
- [x] T024 [US4] Agent4 create complete EN/VI in client/src/custom/x-gateway/support-evidence-strings.ts, grouped navigation in client/src/custom/x-gateway/shell/nav.ts and minimal /x/support-knowledge import/route in client/src/custom/x-gateway/XGatewayApp.tsx; preserve current branding/theme.
- [x] T025 [US4] Agent4 implement four tabs, source/import/revision/publish/archive/OCC, preview, explicit knowledge-only policy and suite/run workflow in client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx; permissions and tenant/session cancellation/isolation are mandatory.
- [x] T026 [US4] Agent4 extend the actually served script in server/src/custom/x-gateway/support-runtime-widget.ts for numbered citation text cards, EN/VI non-AI/redaction notices, reload/poll dedup by requestId and explicit new-request retry after stale-context409; preserve017 identity/deadline/base URL/escalation/CSAT behavior.
- [x] T027 [US4] Agent3 prove the UI wire contract and source->publish->chat->history->escalation/replay flow with real peer services in server/src/__tests__/custom/x-support-evidence-http.test.ts; no setTurnExecutor shortcut, fake source store or fabricated citation in production.

## Phase 6 — Reviewer acceptance / publication

- [x] T028 Reviewer inspect all actual code paths, owner handoffs and prospective scope against specs/018-ai-support-knowledge-evidence/ownership.md and specs/018-ai-support-knowledge-evidence/review.md; return findings to owner, do not silently implement for them.
- [x] T029 Reviewer execute all required gates in specs/018-ai-support-knowledge-evidence/quickstart.md, including migration registry, full workspace checks, actual HTTP proof and supported memory Db tests; rerun after corrections and account for every file if sharding.
- [ ] T030 Reviewer record command evidence and scoped commit inventory in specs/018-ai-support-knowledge-evidence/review.md; safely sync main, preserve016, reuse/open integration PR only if accepted, report link/CI and do not merge.

## Dependencies / parallel work

T001 freezes shared contracts; T002/T003 provide all schema/store prerequisites. T004 prepares Agent2 fixtures in parallel. Write US1 tests T005 first, implement T006–T008, then verify real HTTP T009. Write retrieval tests T010 before T011–T013; write runtime tests T014 before T015–T017. Eval tests T018 precede real persistence T019, engine T020 and API T021; fixtures may be prepared earlier. Agent4 writes native tests T022/T023 against the documented contract, then T024–T026 implementation, with actual composed wire proof T027 after real peers exist. Existing exports/schemas are required before a test can be considered passing; missing imports are not a green result. T028–T030 wait for all owners.

MVP: US1 plus US2 with source management/visible status needed to operate it; default mode stays off until complete tests and UI are accepted. US3/US4 remain required for the final018 PR, not fake-complete placeholders. Different-owner files can be worked in parallel; shared checkout entrypoints each have one owner.

Counts: setup/foundation4; US1=5; US2=8; US3=4; US4=6; reviewer3; total30. Agent workload: A1=8 tasks, A2=7, A3=7, A4=5, reviewer=3 (task counts are not a promise of equal duration). Every task has a stable ID, exact path and testable outcome.
