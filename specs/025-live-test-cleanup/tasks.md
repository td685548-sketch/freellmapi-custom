# Tasks: Live Test Sandbox Tagging & Cleanup (Spec 025)

**Directory**: `specs/025-live-test-cleanup` | **Plan**: [plan.md](./plan.md)

- [x] **T001** Bổ sung `SupportLiveTestSandboxStats` và `SupportLiveTestSandboxCleanupResponse` vào `shared/support-service-desk-live-test.ts` và build `@freellmapi/shared`.
- [x] **T002** Tạo module độc lập `server/src/custom/x-gateway/support-live-test-sandbox.ts` (`AsyncLocalStorage` context, thống kê sandbox, dọn sạch giao dịch sandbox theo tenant).
- [x] **T003** Gắn gắn cờ `isLiveTest` và tách số liệu production trong `support-workflows.ts`, `support-crm-webhooks.ts` và gắn `GET`/`DELETE /sandbox` + context bridge trong `support-service-desk-live-test-router.ts`.
- [x] **T004** Cập nhật chuỗi song ngữ `support-service-desk-live-test-strings.ts` và UI `live-test-sandbox-panel` trong `SupportWidgetLiveTest.tsx`.
- [x] **T005** Tạo bộ kiểm thử tích hợp `server/src/__tests__/custom/x-support-live-test-sandbox.test.ts` và cập nhật `client/src/custom/x-gateway/support-service-desk-live-test.test.tsx`.
- [x] **T006** Cập nhật `spec.md`, `specs/README.md` và chạy xanh toàn bộ `lint`, `lint:support-ai`, tests và `build`.
