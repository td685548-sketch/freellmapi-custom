# Implementation tasks

Implementation integrated; reviewer has explicit user authorization to fix review findings and create a PR. Final gates/publication evidence is recorded in review.md.

## Foundation / US1
- [x] T001 A1 Prepare required Spec Kit020 artifacts and freeze contracts/baseline; report accepted SHA/prerequisites.
- [x] T002 A1 Add shared DTO/defaults/constants and optional017 metadata.
- [x] T003 A1 Add new migration/bootstrap/registry and roundtrip/second-memory-Db tests.
- [x] T004 A1 Implement encrypted policy OCC and metadata-only deduplicated bounded event storage; test corrupt storage, tenant isolation, pagination/retention.

## US2 / pure engine
- [x] T005 A2 Establish evaluator contract and deterministic EN/VI/adversarial fixtures.
- [x] T006 A2 Implement bounded Unicode literal matching, credential patterns, length limits, off/log/enforce.
- [x] T007 A2 Prove no raw block result/errors, stable IDs, no regex injection, exact boundaries, no unintended Unicode/display mutation.

## US2 / runtime
- [x] T008 A3 Trace all generation/commit/replay/read paths with CodeGraph; publish adapter signatures without circular imports.
- [x] T009 A3 Integrate final-policy reload, safe aliases/traces/citations and atomic safe persistence/audit/usage in chat and simulator.
- [x] T010 A3 Prove policy changes in flight, blocked output, actual/conservative charge, errors/abort/leases, existing approvals/side-effect honesty.

## US3 / reads and Copilot
- [x] T011 A3 Apply current policy to legacy/020 cache and canonical AI history/provider context without writes or role upgrade.
- [x] T012 A3 Integrate019 Copilot artifacts/job read/replay and cost/fencing if baseline dependency accepted; otherwise explicitly report incomplete dependency.
- [x] T013 A3 Test stricter/looser policy, revoked citations, cross-user/tenant, no raw sentinel in returned/persisted paths and no duplicate effects on replay.

## US4
- [x] T014 A4 Add authenticated exact-route policy/events/preview API and permission mapping; test all real HTTP gates/OCC/bounds/tenant rules.
- [x] T015 A4 Add EN/VI policy/preview/events Studio, route/nav and permission-aware states.
- [x] T016 A4 Test tenant/session switches, stale request cancellation, readonly403, errors/OCC and safe output rendering with native React tests.

## Reviewer acceptance
- [x] T017 Reviewer integrate exact accepted commits; review all paths/no raw data/no missing peer implementations.
- [x] T018 Reviewer run full test/build/lint/migration gates from quickstart.md; account for every failure/skip without relabeling.
- [ ] T019 Reviewer document evidence/scope/limitations and open one PR targeting main after green checks; report CI, no automatic merge.

Dependencies: T001/T002 before peer implementation; T003/T004 store before T009/T014; T005..T007 engine before T009/preview composed proof; T009..T013 require accepted017/018 and019 for Copilot; T017..T019 wait for four handoffs. Preparation/tests may run independently; integration claims require actual peer code.


Final local evidence: review.md and verification-inventory.json. T019 publication/CI is tracked in GitHub; no merge authorized.
