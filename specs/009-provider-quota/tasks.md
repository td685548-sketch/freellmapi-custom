# Tasks
## Setup
- [x] T001 Read 9Router references and specify/plan in specs/009-provider-quota/.
## Foundation
- [x] T002 Add DTOs shared/x-quota.ts and quota migration/defaults registration.
## US1 — real quota
- [x] T003 [US1] Write provider/parser and HTTP tests in server/src/__tests__/custom/x-quota.test.ts.
- [x] T004 [US1] Implement quota adapters/store/router/tracking under server/src/custom/x-gateway/quota/.
## US2 — countdown
- [x] T005 [US2] Implement client quota-api.ts, quota-strings.ts, pages/Quota.tsx and quota.css.
- [x] T006 [US2] Test countdown, stale/unknown and refresh failures in client/src/custom/x-gateway/quota.test.tsx.
## US3 — fallback
- [x] T007 [US3] Integrate quota sorting/filtering in gateway router and scoped header tracking in protocol dispatch.
- [x] T008 [US3] Verify tier override, quota skip, stale/reset recovery and combo ordering in server/src/__tests__/custom/x-quota.test.ts.
## Polish
- [x] T009 Add minimal console/nav/permission hooks and migration roundtrip coverage.
- [x] T010 Run full checks, review changes and record results in specs/009-provider-quota/quickstart.md.
## Dependencies and strategy
T001→T002→T003→T004. T005/T006 follow DTOs; T007/T008 follow store. T009/T010 validate all stories. Independent parsing/UI tests may run concurrently; execute sequentially here. MVP is real quota, all stories delivered together.
