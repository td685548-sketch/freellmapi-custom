# Tasks: Model list pagination

**Input**: spec.md, plan.md, research.md, data-model.md and contracts/dashboard.md

## Phase 1: Setup
- [X] T001 Document specification and design in specs/010-model-list-pagination/.

## Phase 2: Foundational
- [X] T002 Add paging metadata contract in shared/model-list-page.ts and export it from shared/types.ts.
- [X] T003 Permit a supplied scoring index in server/src/services/router.ts without changing legacy callers.

## Phase 3: User Story 1 - Browse in batches
**Independent test**: 45 groups produce 20/40/45 rows; scrolling does not fetch; complete provider membership is retained.
- [X] T004 [US1] Add route/budget regression tests in server/src/__tests__/custom/model-list-page.test.ts.
- [X] T005 [US1] Implement cached indexing, selected-group detail SQL and cached usage in server/src/services/model-list-page.ts.
- [X] T006 [US1] Mount the validated router from server/src/routes/model-list-page.ts in server/src/routes/fallback.ts.
- [X] T007 [US1] Add explicit pagination hook/controls in client/src/custom/model-list/ and connect client/src/pages/FallbackPage.tsx.
- [X] T008 [US1] Test explicit loading, retries and resets in client/src/custom/model-list/use-model-list.test.tsx.

## Phase 4: User Story 2 - Find and manage safely
**Independent test**: Global search finds a later model; partial edits preserve hidden rows and other profiles.
- [X] T009 [US2] Test and implement global search/filter/sort, snapshot expiry and profile-pinned writes in server/src/routes/model-list-page.ts and server/src/services/model-list-page.ts.
- [X] T010 [US2] Preserve staged edits on append and guard partial-chain ordering in client/src/pages/FallbackPage.tsx.
- [X] T011 [US2] Keep global budget totals with an explicitly loaded legend in client/src/custom/model-list/PagedTokenUsage.tsx.

## Phase 5: Validation
- [X] T012 Run focused regressions, full tests, build and lint; record results and the Windows full-suite limitation in specs/010-model-list-pagination/quickstart.md. Require full green Linux CI before merge.
- [ ] T013 Push codex/model-list-pagination, create a focused PR and merge only after green CI.

## Dependencies and strategy
T001 -> T002/T003 -> T004/T005/T006 -> T007/T008 -> T009/T010/T011 -> T012/T013. Build the batch endpoint first, then integrate the existing table and safe editing. No parallel writes are planned. The research phase was independently delegated; implementation remains sequential.
