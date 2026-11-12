# Prompt — Agent 4: Working Partner Widget & Integration Studio

Bạn là **Agent 4**, triển khai spec017 trên **feat/9router-integration** tại checkout `freellmapi`, Windows `C:\Users\dotha\Documents\Fsoft-Working\freellmapi` hoặc WSL `/mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi`. Không đổi/tạo nhánh.

Đọc `AGENTS.md`, constitution và toàn bộ `specs/017-ai-support-runtime-integration/`, đặc biệt contracts.md/data-model.md/ownership.md/review.md. Dùng CodeGraph trước đọc source. Không sửa trang support013–015 hoặc file016.

## File sở hữu độc quyền

CREATE:

1. `server/src/custom/x-gateway/support-runtime-widget.ts`
2. `server/src/__tests__/custom/x-support-runtime-widget.test.ts`
3. `client/src/custom/x-gateway/support-integration-strings.ts`
4. `client/src/custom/x-gateway/pages/SupportIntegration.tsx`
5. `client/src/custom/x-gateway/support-integration.test.tsx`

EDIT ONLY:

6. `client/src/custom/x-gateway/XGatewayApp.tsx` — minimal localized nav `/x/support-integration` and `<Route path="support-integration" element={<SupportIntegration />} />`; đặt trước prefix `/x/support` trong menu để breadcrumb đúng, giữ mọi route khác.

## Widget — T014–T015

- Export đúng `getSupportRuntimeWidgetScript(): string`; Agent3 sẽ serve script qua endpoint cũ, bạn không sửa support-router.ts.
- Giữ `FreeLLMAPISupport.init` options cũ. Xác định server base bằng script.src hoặc explicit serverBase/endpoint, không gọi nhầm origin của website nhúng.
- Không có signingSecret trong browser, snippet, storage hoặc test fixtures công khai. Backend đối tác cấp signed token; guest-only dùng guest-session API mới TTL900 với IDriêng.
- Một user message + conversationId + requestId cho mỗi turn; retry cùng requestId. Khôi phục conversation qua authorized GET trước render; không tin nội dung lịch sử local.
- Session storage scope theo serverbase+tenant+identity, fallback memory khi storage bị chặn. Token hết hạn đã đăng nhập -> authrequired UI/callback, không tự hạ thành guest.
- `updateContextToken()` xóa state/request/poll của identity cũ; `destroy()` cleanup DOM, abort request/timer/listener. Thay tenant/identity không lộ dữ liệu cũ, kể cả response muộn.
- Resume chat, hiển thị pending approvals, gửi escalation và CSAT1..5 qua APIs có sẵn; poll human replies chỉ khi widget mở, có backoff/cancel/dedup. AI không chen reply khi handoff chưa được tiếp tục.
- Safe text rendering; không innerHTML với title/error/reply/data. EN/VI cho widget chức năng cơ bản. Không làm branding/intake/Copilot/SLA của spec016.

## Integration Studio — T024–T025

- Fetch tenant list, select `data-testid="support-integration-tenant"`.
- Bốn tab `readiness`, `runtime`, `deliveries`, `embed`, có `data-testid="tab-<name>"` và `panel-<name>`, keyboard/accessibility phù hợp.
- Readiness: GET .../runtime, hiển thị checks với machine-code localization, warning/error trung thực, loading/retry. Không tạo test AI/webhook thật từ thao tác xem.
- Runtime: shared DTO policy, extra model selectors, named tool classification từ existing GET /tools và bounds. POST mặc định chờ duyệt; explicit admin configuration cho read-only POST. PUT runtime; không client-set bypass.
- Deliveries: GET outbox, eventId/status/attempts/nextAttemptAt/sanitized errors; retry dead delivery bằng POST .../outbox/:id/retry, không rerun action.
- Embed: copy snippet chỉ có publickey+serverorigin; hướng dẫn backend gọi session, token update và guest option. Không hiển thị secret trong UI. Preserve EN/VI đầy đủ.
- Use session revision + tenant-scoped query keys và keyed state để tránh stale draft/result crossing. Config/retry mutations disabled nếu thiếu edit_x_settings. Error/success/empty/pending states rõ ràng.

## CRITICAL CI RULE

**Không import bất kỳ @testing-library package nào.** Không thêm dependency hoặc sửa package.json/package-lock. UI tests chỉ dùng `createRoot` từ react-dom/client và `act` từ react theo support-enterprise.test.tsx/support-gateway.test.tsx. Shared wire DTOs lấy từ Agent1, không import server source vào client.

## Kiểm thử và bàn giao

Trong server:

```text
npx vitest run src/__tests__/custom/x-support-runtime-widget.test.ts
```

Trong client:

```text
npx vitest run src/custom/x-gateway/support-integration.test.tsx
npx tsc -b
```

Widget tests phải thực thi script trong jsdom + mocked fetch: cross-domain base, reload, token expiration, identity switch, malicious display text, handoff replies, CSAT, stable retry ID và destroy. UI tests bao phủ4tab, readiness warnings, policy validation/save, delivery retry, safe snippet, readonly và tenant/session isolation.

Không sửa file ngoài danh sách, không commit/push/PR/merge hoặc gọi agent khác. Báo API/export thiếu cho reviewer, dùng mock contract trong test nhưng không tạo fake success production. Bàn giao file diff, test/tsc exit status và giới hạn thực tế. Reviewer review sau khi cả4agent hoàn tất; bạn sửa finding thuộc phạm vi mình.
