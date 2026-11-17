# Implementation Plan: Per-Tenant Live End-User Widget Testing in Service Desk Studio (Spec 023)

**Branch**: `feat/023-service-desk-live-test` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)

## Summary
Tích hợp chế độ **Thử nghiệm trực tiếp như người dùng cuối** ngay tại trang Service Desk Studio (`/thruline/support-desk`) cho từng Tenant đang chọn, giữ nguyên chế độ **Xem trước thiết kế** tĩnh làm mặc định. Thay vì xây một simulator tách rời dễ lệch hành vi, giao diện Studio sẽ nhúng chính canonical widget runtime (`widget.js`) qua một router console có quyền biên tập, phát hành `persona-session` an toàn không lộ `signingSecret`, xử lý tên miền giả lập / tên miền cho phép (`allowedOrigins`), và chuyển tiếp qua đúng 4 public runtime routers thật (chat/AI, khảo sát trước chat, RAG có trích dẫn & thu hồi, guardrails, PII masking, quota, CRM, output controls, công cụ có row-lock & duyệt hành động, chuyển nhân viên, Copilot, SLA queues và CSAT).

## Architecture & Module Map (Zero-Conflict Modular Design)

### 1. Shared Contracts (`shared/support-service-desk-live-test.ts`)
- DTOs dùng chung giữa server & client:
  - `SupportLiveTestViewMode` (`'design' | 'live'`)
  - `SupportLiveTestPersonaMode` (`'guest' | 'authenticated'`)
  - `SupportLiveTestPersonaInput`, `SupportLiveTestPersonaSessionResponse`
  - `SupportLiveTestOriginCheckReason`, `SupportLiveTestOriginCheckResponse`
  - `SupportLiveTestTurnDiagnostic`
  - `SUPPORT_LIVE_TEST_PERSONA_PRESETS` (`guest`, `customer_alice`, `customer_bob`, `staff`, `admin`)

### 2. Server Bridge Router (`server/src/custom/x-gateway/support-service-desk-live-test-router.ts`)
- Mount vào `server/src/custom/x-gateway/console-router.ts` dưới `/support` (chỉ thêm 2 dòng).
- Tất cả endpoint dưới `/tenants/:id/service-desk/live-test/*` đều yêu cầu `requireAuth` và `hasEditorAccess` (`use_x_gateway` + `edit_x_settings`).
- `POST /tenants/:id/service-desk/live-test/persona-session`:
  - `guest`: trả trạng thái `allowGuest` của tenant, không cấp token quản trị.
  - `authenticated`: gộp quyền trong `tenant.rolesConfig` + `permissions` bổ sung và gọi `mintSupportUserToken` + `verifySupportUserToken` mà không bao giờ lộ `signingSecret`.
- `POST /tenants/:id/service-desk/live-test/origin-check`:
  - Kiểm tra chuẩn hóa `origin` và đối chiếu với `tenant.allowedOrigins`.
- Allowlist đúng 7 đường dẫn runtime widget (`GET /widget/config`, `POST /widget/intake`, `POST /guest-session`, `POST /chat`, `GET /conversations/:conversationId`, `POST /escalate`, `POST /csat`):
  - Chặn `tenant_mismatch` (`403`) nếu header/body/query truyền key khác tenant đang chọn.
  - Khóa `x-support-tenant-key = tenant.publicKey` và xóa `req.headers.authorization` trước khi chuyển tiếp xuống 4 public routers thật (`xSupportPublicRouter`, `xSupportServiceDeskPublicRouter`, `xSupportEnterprisePublicRouter`, `xSupportGovernancePublicRouter`).
  - Xử lý `X-Support-Simulated-Origin` nếu có, hoặc gỡ `Origin` của console khi không mô phỏng để không bị `allowedOrigins` bên ngoài chặn nhầm.

### 3. Minimal Runtime Widget & Escalate Extensions
- `server/src/custom/x-gateway/support-enterprise-router.ts` (`POST /escalate`):
  - Tự suy ra `subject` từ hội thoại liên kết hoặc fallback `'Human agent escalation request'` khi widget chỉ gửi `{ conversationId, reason }`; tự khởi tạo hội thoại thuộc `userContext` nếu chưa có `conversationId` và trả kèm `conversationId` trong phản hồi `201`.
- `server/src/custom/x-gateway/support-runtime-widget.ts`:
  - Mở rộng `init(config)` hỗ trợ `container`, `startOpen`, `storageScope`, `transport`, `instance.refreshProfile()`, `instance.getConversationId()`; giữ nguyên 100% hành vi mặc định khi nhúng trên website đối tác.
  - Hiển thị trạng thái `authRequired` ngay khi `allowGuestSession === false` và chưa có `contextToken`.
  - Làm mới guest token trước khi `escalate` nếu cần; hiển thị lỗi cấu trúc từ server trong `widget-error-box` bằng `textContent`; lưu trạng thái skip khảo sát không bắt buộc theo `schemaHash`.

### 4. Client Studio UI & Tests
- `client/src/custom/x-gateway/support-service-desk-live-test-strings.ts`: Song ngữ EN/VI đầy đủ.
- `client/src/custom/x-gateway/components/SupportWidgetLiveTest.tsx`: Bộ chuyển đổi `Design Preview` / `Live End-User Test`, cảnh báo cấu hình chưa lưu + `Save & Apply Now`, thanh chọn Persona + Presets + `Reset Session`, khung widget thật dùng `transport` qua `/service-desk/live-test`, kiểm thử `Origin Check`, ngăn `Diagnostics` tách biệt bên ngoài widget + nút `Open in Copilot`.
- `client/src/custom/x-gateway/pages/SupportServiceDesk.tsx`: Giữ state phiên thử nghiệm trong `TenantServiceDeskContent` qua các tab cùng Tenant, reset khi đổi Tenant, thêm `preferredConvId` và checkbox `copilot-resolve-on-send` tùy chọn ở Copilot.

## Verification Plan
- `server/src/__tests__/custom/x-support-runtime-widget.test.ts`: Unit tests cho widget nhúng `container`, `transport`, `storageScope`, `allowGuestSession: false`, error surfacing.
- `server/src/__tests__/custom/x-support-service-desk-live-test.test.ts`: HTTP integration tests cho phân quyền, persona-session, guest on/off, DB row lock & tool approvals, intake, RAG + source revocation, guardrails/PII/quota/CRM/output controls, escalate -> SLA -> reply/resolve -> CSAT, cross-tenant & origin check.
- `client/src/custom/x-gateway/support-service-desk-live-test.test.tsx`: UI tests end-to-end với widget script thật trong `jsdom`, bao gồm EN/VI và test hồi quy `support-service-desk.test.tsx`.
- Toàn monorepo: `npm run lint`, `npm run lint -w client`, `npm run test`, `npm run build`.
