# Prompt — Agent 1: Runtime, Context & Quotas

Bạn là **Agent 1** triển khai spec017 trong checkout `freellmapi`, nhánh **feat/9router-integration**. Đường dẫn Windows: `C:\Users\dotha\Documents\Fsoft-Working\freellmapi`; WSL tương ứng `/mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi`. Dùng checkout đang có; không tạo nhánh mới.

Đọc trước `AGENTS.md`, `.specify/memory/constitution.md`, toàn bộ tài liệu trong `specs/017-ai-support-runtime-integration/` (đặc biệt spec.md, plan.md, data-model.md, contracts.md, ownership.md, tasks.md, review.md), và module013–015 liên quan. Nếu có `.codegraph/`, dùng CodeGraph trước grep/đọc mã. Không triển khai spec016.

## Chỉ được sửa/tạo các file này

1. `shared/support-runtime.ts` — CREATE
2. `server/src/custom/x-gateway/support-runtime-store.ts` — CREATE
3. `server/src/custom/x-gateway/support-runtime.ts` — CREATE
4. `server/src/db/migrations/20261112_170001_support_runtime_state.ts` — CREATE
5. `server/src/__tests__/custom/x-support-runtime.test.ts` — CREATE
6. `server/src/__tests__/db/migrate/support-runtime.test.ts` — CREATE
7. `server/src/custom/x-gateway/support-guardrails.ts` — EDIT giới hạn quota helper/atomic accounting

## Nhiệm vụ

- Thực hiện T001, T003, T005–T008 và T011; cung cấp guest issuance throttle helper cho Agent3 theo data-model.md.
- Xuất chính xác shared DTO và các hàm được đóng băng trong data-model.md. Tạo type/export thật sớm để Agent2/3/4 tích hợp; không thêm stub production trả success giả.
- `executeSupportTurn` nhận generate callback được inject. Không runtime-import support-router.ts: chỉ TYPE import nếu cần. Dùng engine tri thức/CRM/masking/guardrails có sẵn; không viết lại.
- Enforce model allowlist, firewall trước gọi ngoài, chỉ server history và own-user/role context; mask context/tool data/reply/traces trước gửi mô hình, trả về và lưu. Dữ liệu RAG không được trở thành chỉ dẫn hệ thống có quyền ghi đè.
- Durable claim theo tenant/user/requestId, fingerprint có verified role/permissions, conversation lease và replay cached masked response. Input khác cùng ID ->409; đang chạy ->409; replay không gọi provider/tool hoặc trừ quota lần nữa.
- Quota reserve/reconcile atomic, một request cho mỗi turn, không một request cho mỗi tool loop. Không giữ transaction qua await; không tin tokens từ browser; giữ window identity khi đối soát. Không hoàn lại chi phí chưa rõ sau crash.
- Persist đúng một tin khách và tối đa một phản hồi AI; history ownership; unsigned guest legacy stateless, không personal tools/CRM/actions. Signed guest unique như user thường theo role.
- Mọi POST tool mặc định chờ phê duyệt thông qua Agent2 `invokeSupportRuntimeWebhook`. Không tự gọi connector cho write nếu peer module chưa xong.
- Migration mới có up/down; memory DB gọi cùng migration functions, không copy schema lần hai. Mã hóa cached payloads; không lưu token/secret/raw provider output.
- Reject production `usedFallback=true` bằng503; không biến lỗi mô hình thành câu trả lời giả thành công.

## Kiểm thử và bàn giao

Trong server chạy:

```text
npx vitest run src/__tests__/custom/x-support-runtime.test.ts src/__tests__/db/migrate/support-runtime.test.ts src/__tests__/custom/x-support-guardrails.test.ts
```

Sau khi có đủ module peer, chạy `npm run build -w server`. Kiểm thử 20 requests cạnh tranh khi còn1quota, replay20lần, role/tenant isolation, PII không lọt vào provider/trace/history, unknown usage, lease/crash và migration đổi memory DB.

Không cài package, sửa manifest/lockfile, thay migration cũ, sửa file ngoài ownership, sửa Spec Kit pointer hoặc gỡ test. Nếu native SQLite môi trường lỗi, dùng adapter sẵn có theo DbFactory trong test và báo rõ; không sửa môi trường/dependencies tùy tiện.

Không commit/push/PR/merge hoặc tự gọi agent khác. Khi xong trả: danh sách file, export đã cung cấp, kết quả kiểm thử có exit status, giới hạn còn lại, và ghi rõ đã chạy với peer thật hay mock. Reviewer sẽ kiểm tra code sau khi cả4agent hoàn tất; nếu reviewer gửi finding, chỉ sửa phần sở hữu rồi chạy lại kiểm tra.
