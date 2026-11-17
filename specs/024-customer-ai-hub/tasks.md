# Tasks: Spec 024 — Customer AI Hub, Smart Personal-Key Routing & Dual-Persona Intelligence

- [x] **T001** Create isolated worktree `feat/024-customer-ai-hub` and install dependencies.
- [x] **T002** Add `shared/customer-ai.ts`, extend `shared/user-access.ts`, and add `view_assistants` to `shared/guest-access.ts`.
- [x] **T003** Create `server/src/db/migrations/20261118_030000_custom_customer_ai_hub.ts` and register in `server/src/db/migrate/defaults.ts`.
- [x] **T004** Implement `server/src/custom/customer-ai/{store,runtime,coach,router}.ts`.
- [x] **T005** Wire minimal server hook points (`client-context.ts`, `router.ts`, `user-keys.ts`, `routes/user-keys.ts`, `user-rate-limit.ts`, `system-prompt.ts`, `guest-access.ts`, `ai-platform/permissions.ts`, `ai-platform/router.ts`, `custom/register.ts`).
- [x] **T006** Implement `client/src/custom/customer-ai/{api.ts,QuotaCoachCard.tsx,AssistantChatDrawer.tsx,AdminCustomerAiPanel.tsx,CustomerAiHubPage.tsx}`.
- [x] **T007** Wire minimal client hook points (`MemberKeysView.tsx`, `GuestShell.tsx`, `AiPlatformApp.tsx`, `lazy-pages.ts`, `App.tsx`, `i18n/vi.ts`).
- [x] **T008** Add backend & frontend tests (`customer-ai-hub.test.ts`, `guest-access.test.ts` update, `customer-ai-hub.test.tsx`).
- [x] **T009** Run targeted tests, `npm run test:migrations`, `npm run lint`, `npm run test`, and `npm run build`.
