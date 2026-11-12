---
description: "Task list for 013-ai-support-gateway divided across 4 concurrent agents"
---

# Tasks: Multi-Tenant AI Support Gateway (`013-ai-support-gateway`)

**Input**: Design documents from `/specs/013-ai-support-gateway/` (`spec.md`, `plan.md`, `data-model.md`, `contracts.md`, `ownership.md`)

---

## Phase 1: Agent 1 — Tenant Store, Signed User Context & RBAC Schema (Priority: P1)

**Files**: `server/src/custom/x-gateway/support-store.ts`, `server/src/__tests__/custom/x-support-store.test.ts`

- [ ] T001 [P] [US1] Tạo bảng SQLite tự động (`x_support_tenants`, `x_support_tools`, `x_support_db_sources`) và xuất đầy đủ TypeScript interfaces trong `server/src/custom/x-gateway/support-store.ts`.
- [ ] T002 [US1] Triển khai CRUD cho Tenant (`listSupportTenants`, `getSupportTenant`, `getSupportTenantByPublicKey`, `createSupportTenant`, `updateSupportTenant`, `deleteSupportTenant`, `rotateSupportTenantSecret`) với mã hóa AES-256-GCM cho `signingSecret`.
- [ ] T003 [US1] Triển khai `mintSupportUserToken` và `verifySupportUserToken` (HMAC-SHA256 `sup_ctx_<payload>.<sig>`, kiểm tra hạn dùng `exp`, hợp nhất `permissions` từ `rolesConfig`, và fallback sang `guest` khi `allowGuest=true`).
- [ ] T004 [US2] [US3] Triển khai CRUD cho Webhook Tools (`listSupportTools`, `createSupportTool`, `updateSupportTool`, `deleteSupportTool`) và DB Sources (`listSupportDbSources`, `createSupportDbSource`, `updateSupportDbSource`, `deleteSupportDbSource`).
- [ ] T005 [US1] Viết unit tests đầy đủ trong `server/src/__tests__/custom/x-support-store.test.ts`.

---

## Phase 2: Agent 2 — Dual RBAC Data Connectors (Mode A Webhook & Mode B SQL Engine) (Priority: P1)

**Files**: `server/src/custom/x-gateway/support-connectors.ts`, `server/src/__tests__/custom/x-support-connectors.test.ts`

- [ ] T006 [P] [US2] [US3] Triển khai `buildAllowedToolsForContext(context, tools, dbSources)` lọc danh sách Webhook Tools và DB Sources theo `context.role`.
- [ ] T007 [US2] Triển khai `executeSupportWebhookTool` hỗ trợ kiểm tra `allowedRoles`, ép cứng tham số `lockUserIdParam = context.userId` (trừ khi role thuộc `bypassUserLockRoles`), và ký HMAC header `X-Support-Signature`.
- [ ] T008 [US3] Triển khai `DEFAULT_ECOMMERCE_SANDBOX_SQL` (gồm 3 bảng `products`, `orders`, `customers` có dữ liệu mẫu) và hàm `validateAndRewriteSupportSql` (chỉ cho phép `SELECT`, chặn từ khóa nguy hiểm, kiểm tra `allowedRoles` từng bảng, chặn `deniedColumns`, và tự động bọc subquery `WHERE <rowOwnerColumn> = $__support_user_id` cho Row-Level Security).
- [ ] T009 [US3] Triển khai `executeSupportDbQuery` cho cả 2 driver `sqlite-sandbox` và `sql-http`, đồng thời loại bỏ `deniedColumns` khỏi các dòng kết quả trả về.
- [ ] T010 [US2] [US3] Viết unit tests bảo mật & phân quyền trong `server/src/__tests__/custom/x-support-connectors.test.ts`.

---

## Phase 3: Agent 3 — Support Gateway API, Agentic Tool Loop & Embeddable Widget (Priority: P1)

**Files**: `server/src/custom/x-gateway/support-router.ts`, `server/src/custom/x-gateway/console-router.ts`, `server/src/custom/x-gateway/router.ts`, `server/src/custom/permission-actions.ts`, `server/src/__tests__/custom/x-support-gateway.test.ts`

- [ ] T011 [P] [US1] Cập nhật `server/src/custom/permission-actions.ts` ánh xạ `/api/x-gateway/support` sang `use_x_gateway` (đọc & mô phỏng) và `edit_x_settings` (ghi cấu hình).
- [ ] T012 [US1] [US2] [US3] Xây dựng `xSupportConsoleRouter` trong `server/src/custom/x-gateway/support-router.ts` cho toàn bộ endpoints quản trị (`/tenants`, `/tools`, `/db-sources`, `/query-test`, `/mint-token`, `/simulate-chat`) và gắn vào `console-router.ts`.
- [ ] T013 [US1] [US2] [US3] Xây dựng `xSupportPublicRouter` (`/x/v1/support/session`, `/x/v1/support/chat` với vòng lặp gọi công cụ tự động + fallback thông minh trên dữ liệu sandbox/webhook, và `/x/v1/support/widget.js`) và gắn vào `server/src/custom/x-gateway/router.ts`.
- [ ] T014 [US1] [US2] [US3] Viết integration tests trong `server/src/__tests__/custom/x-support-gateway.test.ts`.

---

## Phase 4: Agent 4 — Frontend Web Dashboard (`/x/support`) & Role Simulator (Priority: P2)

**Files**: `client/src/custom/x-gateway/support-strings.ts`, `client/src/custom/x-gateway/pages/SupportGateway.tsx`, `client/src/custom/x-gateway/XGatewayApp.tsx`, `client/src/custom/x-gateway/support-gateway.test.tsx`

- [ ] T015 [P] [US4] Tạo file từ điển song ngữ Anh/Việt `client/src/custom/x-gateway/support-strings.ts`.
- [ ] T016 [US4] Xây dựng trang `client/src/custom/x-gateway/pages/SupportGateway.tsx` với 5 tab: `Overview & Roles`, `Webhook Tools (Mode A)`, `Database & Table Policies (Mode B)`, `Live Role Simulator`, và `Embed Widget & Integration`, gắn route `/x/support` vào `XGatewayApp.tsx`.
- [ ] T017 [US4] Viết bài test giao diện `client/src/custom/x-gateway/support-gateway.test.tsx`.
