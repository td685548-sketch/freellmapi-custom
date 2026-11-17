# Tasks: Thử nghiệm trực tiếp Widget người dùng cuối theo Tenant trong Service Desk Studio (Spec 023)

**Directory**: `specs/023-service-desk-live-test` | **Plan**: [plan.md](./plan.md)

- [x] **T001** Tạo shared DTOs và danh sách nhân vật giả lập mẫu tại `shared/support-service-desk-live-test.ts` và build `@freellmapi/shared`.
- [x] **T002** Cập nhật `POST /escalate` trong `server/src/custom/x-gateway/support-enterprise-router.ts` để hỗ trợ widget escalate không cần truyền `subject` và tự khởi tạo hội thoại khi chưa có `conversationId`.
- [x] **T003** Mở rộng canonical widget `server/src/custom/x-gateway/support-runtime-widget.ts` (`container`, `startOpen`, `storageScope`, `transport`, `refreshProfile`, `getConversationId`, `allowGuestSession: false`, guest escalate renewal, error message display, optional intake skip persistence) và bổ sung unit tests trong `server/src/__tests__/custom/x-support-runtime-widget.test.ts`.
- [x] **T004** Tạo router console `server/src/custom/x-gateway/support-service-desk-live-test-router.ts` (`persona-session`, `origin-check`, allowlisted 7 runtime bridge paths, tenant lock & origin simulation) và gắn vào `server/src/custom/x-gateway/console-router.ts`.
- [x] **T005** Tạo bộ kiểm thử tích hợp HTTP đầy đủ tại `server/src/__tests__/custom/x-support-service-desk-live-test.test.ts` kiểm chứng RBAC, guest/authenticated persona, DB row-lock, pending approvals, intake, RAG & revocation, guardrails/PII/quota/CRM/output controls, escalate -> SLA -> reply/resolve -> CSAT, cross-tenant & origin check.
- [x] **T006** Tạo chuỗi song ngữ `client/src/custom/x-gateway/support-service-desk-live-test-strings.ts`, component `client/src/custom/x-gateway/components/SupportWidgetLiveTest.tsx` và tích hợp tối thiểu vào `client/src/custom/x-gateway/pages/SupportServiceDesk.tsx` (bao gồm đồng bộ chuyển tab trong cùng tenant, `Open in Copilot` và `copilot-resolve-on-send`).
- [x] **T007** Tạo bộ kiểm thử UI `client/src/custom/x-gateway/support-service-desk-live-test.test.tsx`, cập nhật `spec.md` & `specs/README.md`, và chạy xanh toàn bộ `npm run lint`, `npm run lint -w client`, `npm run test`, `npm run build`.
