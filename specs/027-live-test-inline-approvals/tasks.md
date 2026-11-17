# Tasks: Inline Live-Test Pending Action Approvals (Spec 027)

**Directory**: `specs/027-live-test-inline-approvals` | **Plan**: [plan.md](./plan.md)

- [x] **T001** Bổ sung DTO pending actions & action review vào `shared/support-service-desk-live-test.ts` và build `@freellmapi/shared`.
- [x] **T002** Bổ sung `linkPendingActionsToConversation` và `appendSupportActionOutcomeMessage` trong `support-workflows.ts`; gắn vào `support-runtime.ts`, `support-action-executor.ts` và dọn `x_support_action_executions` trong `support-live-test-sandbox.ts`.
- [x] **T003** Thêm routes `GET /pending-actions` và `POST /pending-actions/:actionId/{approve,reject}` (chỉ trong phạm vi live-test) vào `support-service-desk-live-test-router.ts`.
- [x] **T004** Bổ sung `syncConversation()` trong `support-runtime-widget.ts` để đồng bộ widget tức thì.
- [x] **T005** Cập nhật chuỗi EN/VI trong `support-service-desk-live-test-strings.ts` và giao diện phê duyệt inline trong `SupportWidgetLiveTest.tsx`.
- [x] **T006** Thêm kiểm thử `x-support-live-test-approvals.test.ts` (server), cập nhật `support-service-desk-live-test.test.tsx` (client), cập nhật `specs/README.md`, và chạy xanh toàn bộ `lint`, `lint:support-ai`, `test`, `build`.
