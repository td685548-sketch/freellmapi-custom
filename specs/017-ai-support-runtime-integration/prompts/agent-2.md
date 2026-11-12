# Prompt — Agent 2: Approval Execution, Outbox & Safe HTTP

Bạn là **Agent 2** triển khai spec017 trong checkout `freellmapi`, nhánh **feat/9router-integration**, Windows `C:\Users\dotha\Documents\Fsoft-Working\freellmapi` hoặc WSL `/mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi`. Giữ nguyên nhánh và công việc agent khác.

Đọc `AGENTS.md`, constitution và toàn bộ tài liệu `specs/017-ai-support-runtime-integration/`, đặc biệt data-model.md, contracts.md, ownership.md, review.md. Dùng CodeGraph trước tìm/đọc mã nếu repo có index.

## File sở hữu độc quyền

CREATE:

- `server/src/custom/x-gateway/support-action-executor.ts`
- `server/src/custom/x-gateway/support-event-outbox.ts`
- `server/src/custom/x-gateway/support-safe-http.ts`
- `server/src/db/migrations/20261112_170002_support_execution_outbox.ts`
- `server/src/__tests__/custom/x-support-action-executor.test.ts`
- `server/src/__tests__/custom/x-support-event-outbox.test.ts`
- `server/src/__tests__/custom/x-support-safe-http.test.ts`
- `server/src/__tests__/db/migrate/support-execution-outbox.test.ts`

EDIT giới hạn:

- `server/src/custom/x-gateway/support-connectors.ts`
- `server/src/custom/x-gateway/support-crm-webhooks.ts`
- `server/src/__tests__/custom/x-support-connectors.test.ts`
- `server/src/__tests__/custom/x-support-crm-webhooks.test.ts`

## Nhiệm vụ

- Thực hiện T002, T004, T017–T020. Xuất chính xác action/outbox functions trong data-model.md; không sửa runtime hoặc routers của Agent1/3.
- GET tool mặc định read; POST mặc định approval_required. Chỉ cấu hình admin theo toolId mới phân loại POST read. Role admin của khách không tự bỏ qua phê duyệt.
- Proposal snapshot phải giữ tool target/schema/args fingerprint và original requester; khóa userId và kiểm tra role/schema. Dữ liệu execution nhạy cảm mã hóa; phần hiển thị/audit mask an toàn.
- Review có atomic claim trước HTTP, decision tách execution status. Hai approve đồng thời chỉ một HTTP. Replay terminal trả kết quả đã lưu; review trái quyết định ->409; thiếu/tắt tool ->422, không simulated success.
- Preserve original requester role/user scope lúc execute, không thay bằng reviewer. Target/argument lock đã đổi phải re-propose. Timeout/crash sau dispatch ->unknown; không auto retry thao tác ghi. Idempotency-Key ổn định nếu endpoint hỗ trợ, không hứa exactly-once qua HTTP.
- Outbox: synchronous transactional enqueue + stable eventId/dedup key + delivery per recipient. Worker claim bền vững, không chồng vòng chạy, start/stop idempotent. Dùng real signing secret, không default_secret. Năm lần thử, backoff và timeout đúng hợp đồng; payload mã hóa, log không chứa raw response/secret.
- Safe HTTP: chặn private/loopback/link-local/metadata, IP dạng lách, URL credentials và redirect; DNS kiểm tra phải gắn với kết nối thực tế. Áp dụng cho webhook tool, sql-http và legacy partner dispatch. Local integration chỉ theo server-owned exact-origin allowlist; console test localhost chỉ khi env opt-in, không lấy cờ từ public body.
- Manual delivery retry không thực thi lại hành động. Deleted/disabled subscription không bị gửi tới target mới. Không transaction qua await.
- Migration mới có up/down và bootstrap cùng migration functions cho memory tests. Không sửa migration cũ hoặc workflow store của Agent khác.

## Kiểm thử

Trong server:

```text
npx vitest run src/__tests__/custom/x-support-action-executor.test.ts src/__tests__/custom/x-support-event-outbox.test.ts src/__tests__/custom/x-support-safe-http.test.ts src/__tests__/custom/x-support-connectors.test.ts src/__tests__/custom/x-support-crm-webhooks.test.ts src/__tests__/db/migrate/support-execution-outbox.test.ts
```

Phải có concurrent approval, opposite decision, missing tool, altered snapshot, unknown network outcome, restart/multi-worker claims, retry/dead/manual requeue, stable signed bytes/event ID, SSRF DNS+redirect và rollback mutation/outbox. Mock network transport trong test; không gửi webhook thật.

Không thêm package/manifest changes, không sửa file khác, không commit/push/PR/merge, không gọi agent khác. Nếu thiếu export của Agent1, báo dependency và viết test theo contract; không thêm stub production hoặc né gate.

Bàn giao danh sách file, signatures, test commands/exit status, mô tả giới hạn tác động bên ngoài, các dependency/mocks còn tồn tại. Reviewer sẽ review sau khi cả4agent xong; trả finding về đúng owner để sửa.
