# Tasks: X Gateway Basic Chat

## Phase 1: Setup
- [x] T001 Record specification and 9Router reference in specs/008-basic-chat/.
## Phase 2: Foundation
- [ ] T002 Define safe shared DTOs in shared/x-playground.ts and HTTP tests in server/src/__tests__/custom/x-playground.test.ts.
## Phase 3: US1 — streaming chat (P1)
- [ ] T003 [US1] Export reusable chat handler in server/src/custom/x-gateway/router.ts and mount validated playground-router.ts in console-router.ts.
- [ ] T004 [US1] Implement session streaming transport in client/src/custom/x-gateway/playground-api.ts and pages/Playground.tsx.
- [ ] T005 [US1] Verify selection, streaming and Stop in client/src/custom/x-gateway/playground.test.tsx.
## Phase 4: US2 — history (P2)
- [ ] T006 [US2] Implement bounded user history in client/src/custom/x-gateway/playground-state.ts and test identity isolation/corrupt storage.
- [ ] T007 [US2] Add new/select/delete chats and Markdown/copy in client/src/custom/x-gateway/pages/Playground.tsx.
## Phase 5: US3 — settings and images (P2)
- [ ] T008 [US3] Add settings and bounded image attachment flow in client/src/custom/x-gateway/pages/Playground.tsx.
- [ ] T009 [US3] Validate image/settings requests in server/src/custom/x-gateway/playground-router.ts and tests.
## Phase 6: Polish
- [ ] T010 Add bilingual labels and responsive layout in client/src/custom/x-gateway/playground-strings.ts and playground.css.
- [ ] T011 Run full test/build/lint, inspect diff and record results in specs/008-basic-chat/quickstart.md.

## Dependencies and Strategy
T001 → T002 → T003 → T004 → T005. T006 then T007 build on chat. T008/T009 follow shared contract. T010/T011 complete verification. Backend and independent storage tests may run concurrently; implementation proceeds sequentially in this session. MVP is US1; all three stories ship together.
