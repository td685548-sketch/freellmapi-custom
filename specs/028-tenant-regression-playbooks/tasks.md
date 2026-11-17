# Tasks: Per-Tenant Regression Playbooks (Spec 028)

**Directory**: `specs/028-tenant-regression-playbooks` | **Plan**: [plan.md](./plan.md)

- [x] **T001** Bổ sung Playbook DTOs vào `shared/support-service-desk-live-test.ts` và build `@freellmapi/shared`.
- [x] **T002** Bổ sung `purgeSpecificLiveTestRecords` vào `server/src/custom/x-gateway/support-live-test-sandbox.ts`.
- [x] **T003** Tạo module độc lập `server/src/custom/x-gateway/support-live-test-playbook.ts` và gắn endpoints `GET/PUT /playbook`, `POST /playbook/run` vào `support-service-desk-live-test-router.ts`.
- [x] **T004** Cập nhật chuỗi song ngữ EN/VI trong `support-service-desk-live-test-strings.ts` và panel Regression Playbook thu gọn trong `SupportWidgetLiveTest.tsx`.
- [x] **T005** Tạo bộ kiểm thử tích hợp `server/src/__tests__/custom/x-support-live-test-playbook.test.ts` và bổ sung test UI trong `support-service-desk-live-test.test.tsx`.
- [x] **T006** Cập nhật `specs/README.md` và chạy xanh toàn bộ `lint`, `lint:support-ai`, `test`, `build`.
