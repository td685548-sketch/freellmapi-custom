# Tasks: Dashboard performance baseline

## Setup
- [x] T001 Resolve specification/plan/tasks templates and record design in specs/006-dashboard-performance/.

## US1 — Locate expensive dashboard reads
- [x] T002 [US1] Test request isolation, privacy, disconnects and DB behavior in server/src/__tests__/custom/performance.test.ts.
- [x] T003 [US1] Implement bounded metrics in server/src/custom/performance/metrics.ts.
- [x] T004 [US1] Add synchronous DB instrumentation in server/src/custom/performance/database.ts and minimal app/db/startup hooks.

## US2 — Reproduce safely
- [x] T005 [US2] Implement synthetic authenticated benchmark in server/src/scripts/benchmark-dashboard.ts.
- [x] T006 [US2] Run repeated baseline/overhead workloads and publish evidence in docs/performance/results/2026-11-05-p01.md (local baseline only; staging/overhead acceptance explicitly pending).

## Verification
- [x] T007 Run full tests/build/lint/i18n/runtime checks and record limitations in docs/performance/results/2026-11-05-p01.md.
- [x] T008 Push branch and create reviewable draft PR with local evidence; staging acceptance and review remain required before merge/deploy.

Dependencies: T001 → T002 → T003/T004 → T005 → T006 → T007 → T008. Documentation and allowlist research can proceed independently; implementation remains one P01 PR. MVP: US1, followed by the reproducible US2 evidence.
