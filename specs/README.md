# Trạng thái các spec

Cập nhật: 2026-11-18, đối chiếu với `main` sau PR #94 và nhánh `feat/021-stage5-polish`.

File này tổng hợp trạng thái mọi spec trong `specs/`. Những spec đã xong được ghi chung trong bảng dưới đây. Chỉ những việc **chưa làm** (mục 3) mới cần spec mới theo quy trình Spec Kit.

Cách xác định trạng thái: đếm checkbox trong `tasks.md`, rồi đối chiếu với code và commit/PR đã merge vào `main`. Một số spec cũ không tick từng dòng trong `tasks.md` dù code đã merge. Những spec đó được đánh dấu "không tick" ở cột ghi chú, và `tasks.md` của chúng chỉ còn giá trị lịch sử.

## 1. Spec đã hoàn thành

| Spec | Nội dung | Tasks | Bằng chứng trên `main` | Ghi chú |
| --- | --- | --- | --- | --- |
| 001-turso-database | Hỗ trợ Turso/libSQL | 11/11 | `server/src/db/turso.ts` | |
| 002-google-login-email-reset | Đăng nhập Google, đặt lại mật khẩu qua email | 12/12 | | Code xong; bật thật cần người vận hành cấp credential (mục 2) |
| 003-provider-tiers | Phân hạng provider | 8/8 | | |
| 004-provider-tier-add-key | Thêm key theo hạng provider | 5/5 | | |
| 005-cache-granular-permissions | Quyền chi tiết cho cache | 6/6 | | |
| 006-dashboard-performance | Hiệu năng dashboard | 8/8 | Sau đó bổ sung thêm ở PR #49, #50 | Nghiệm thu staging chưa ghi (mục 2) |
| 007-admin-x-gateway | Thruline console: bật/tắt, combos, savers, usage | 24/59 (không tick) | `console-router.ts`, `combos.ts`, `token-savers-pipeline.ts`, `management-router.ts` (`/usage/*`), trang `Combos`, `TokenSavers`, `AccountUsage` | Triển khai theo hướng 9Router, khác thiết kế ban đầu. Trang Test được thay bằng Playground (spec 008). Test bảo mật nằm trong `x-gateway-access`, `x-gateway-isolation` |
| 008-basic-chat | Playground chat | 1/11 (không tick) | `playground-router.ts`, `pages/Playground.tsx`, `playground-state.ts`; PR #44–#46, #57, #60, #66 | |
| 009-provider-quota | Hạn mức theo provider | 10/10 | `server/src/custom/x-gateway/quota/` | Trùng số 009 với spec dưới |
| 009-proxy-pool | Proxy pool gắn theo tài khoản | 8/8 | `proxy-pool.ts` (commit `d0dd5c1`) | |
| 010-model-list-pagination | Phân trang danh sách model | 13/13 | PR thanhdo257205/freellmapi#100 (`d552014`) | |
| 011-x-gateway-operations | CLI operations, diagnostics | 6/7 | `operations-router.ts` (commit `dea51f7`) | T007 (biên bản smoke test Linux) chưa ghi; CI chạy trên ubuntu-24.04 |
| 012-gateway-review-fixes | Sửa lỗi sau review gateway | 5/5 | `gateway-review-regressions.test.ts` | |
| 013-ai-support-gateway | AI support gateway đa tenant | 0/17 (không tick) | commit `33c5c77` (PR #11) | |
| 014-ai-support-enterprise-suite | RAG, che PII, escalation, duyệt hành động | 0/8 (không tick) | commit `06c02cd` (PR #12) | |
| 015-ai-support-governance-and-automation | Guardrails, CRM memory, CSAT, webhooks | 0/8 (không tick) | commit `4cbb7c5` (PR #13) | |
| 017-ai-support-runtime-integration | Nối support runtime vào gateway | 28/28 | `support-runtime*.ts` | |
| 018-ai-support-knowledge-evidence | Knowledge Library có phiên bản | 30/30 | commit `ba0de18` | Trùng số 018 với spec dưới |
| 019-ai-support-service-desk | Service Desk | 32/32 | PR #32 | |
| 020-ai-support-output-controls | Kiểm soát đầu ra cho support | 19/19 | PR #73, #78 | Trùng số 020 với spec dưới |
| 020-azure-document-storage | Lưu archive tài liệu tenant lên Azure Blob | 5/5 | PR #41 | Code xong; chưa bật trên production (mục 2) |
| 018-ai-platform-upgrade | 6 trụ cột AI: prompts, retrieval, prompt cache, MCP, output guard, orchestrator | 140/140 | PR #48, #52, #69, #74, #77; Phase Polish trên nhánh `chore/ai-platform-polish` | Tài liệu vận hành: [`docs/ai-platform.md`](../docs/ai-platform.md); nghiệm thu: [`acceptance.md`](018-ai-platform-upgrade/acceptance.md) |
| 021-context-engineering | Lắp ráp ngữ cảnh có ngân sách token (Context Engineering) | 64/64 | PR #90, #92, #94 và nhánh `feat/021-stage5-polish`; `server/src/custom/context-budget/`, `server/src/routes/context-policy.ts`, `ContextPolicyCard.tsx` | Tài liệu vận hành: [`docs/context-budget.md`](../docs/context-budget.md); nghiệm thu: [`acceptance.md`](021-context-engineering/acceptance.md) |
| 023-service-desk-live-test | Thử nghiệm trực tiếp Widget người dùng cuối theo Tenant trong Service Desk Studio | 7/7 | `support-service-desk-live-test-router.ts`, `SupportWidgetLiveTest.tsx`, `x-support-service-desk-live-test.test.ts`, `support-service-desk-live-test.test.tsx` | |
| 025-live-test-cleanup | Tách số liệu Sandbox & dọn dữ liệu thử nghiệm trực tiếp theo Tenant | 6/6 | `support-live-test-sandbox.ts`, `x-support-live-test-sandbox.test.ts`, `SupportWidgetLiveTest.tsx` | |
| 026-rag-office-markdown | Tự động chuyển đổi tài liệu Word & Excel sang Markdown (.md) khi tải lên RAG | 5/5 | `document-markdown.ts`, `knowledge-document-upload.ts`, `KnowledgeCard.tsx`, `SupportKnowledgeStudio.tsx`, `SupportEnterprise.tsx` | |

## 2. Việc vận hành (không cần spec)

| Việc | Thuộc spec | Cần làm |
| --- | --- | --- |
| Cấp credential Google OAuth và Gmail gửi email cho production | 002 | Người vận hành đặt biến môi trường trên hosting theo `specs/002-google-login-email-reset/quickstart.md` |
| Nghiệm thu hiệu năng trên staging | 006 | Đo theo `specs/006-dashboard-performance/quickstart.md` và ghi kết quả |
| Ghi biên bản smoke test Linux | 011 (T007) | Chạy một lượt và ghi giới hạn kiểm chứng vào `tasks.md` |
| Bật Azure archive trên production | 020-azure | Tạo service principal hoặc workload identity federation cho hosting, cấp quyền `Storage Blob Data Contributor`, đặt biến môi trường theo `docs/azure-document-storage.md` |

## 3. Việc chưa làm

### 3A. Đã có spec, chỉ cần làm tiếp

Không còn task nào mở trong các spec hiện có (ngoài việc vận hành ở mục 2). Phase Polish của 018 (T132–T140) đã xong. Trong lúc làm đã phát hiện và sửa 5 lỗi:

- Xóa client profile để lại dữ liệu MCP (T140), và trigger mới chưa được khai báo cho cache đọc của Turso.
- Chỉ mục ngữ nghĩa không tự dựng lại sau khi khôi phục bản sao lưu không có embeddings (T133).
- Lỗi từ provider embeddings có thể lưu và trả về API key (T134).
- Biến `x-freellm-vars` của caller bị mất trong vòng lặp tool MCP (T132).

Chi tiết và kết quả nghiệm thu: `specs/018-ai-platform-upgrade/acceptance.md`.

### 3B. Cần spec mới (chưa bắt đầu)

Đánh số tiếp từ **023** (`021-context-engineering` và `022-thruline-settings-routing` đã có). Thứ tự dưới đây là đề xuất, chưa chốt.

1. **Vận hành Azure archive**: thêm key id vào envelope và công cụ mã hóa lại khi xoay `ENCRYPTION_KEY`; backfill tài liệu cũ; dọn object mồ côi; lifecycle/retention và xóa prefix khi xóa tenant; nhận file PDF/DOCX gốc. Nguồn: phần "Assumptions" của `020-azure-document-storage/spec.md`.
2. **Cache câu trả lời theo ngữ nghĩa**: cache tách theo scope, không cache khi có tool call hoặc dữ liệu cá nhân, hết hiệu lực khi đổi phiên bản prompt. Spec 018 đã ghi mục này là ngoài phạm vi.
3. **MCP OAuth 2.1**: hiện chỉ hỗ trợ bearer token và header tĩnh.
4. **Đánh giá và A/B cho versioned prompts**: chấm phiên bản prompt trên bộ câu hỏi chuẩn trước khi publish.
5. **Orchestrator chạy nền và theo lịch**: hiện orchestrator chỉ chạy trong thời gian của một request.
6. **Tiếp tục chat sau khi duyệt tool ghi** ở chat thường (ngoài Flow). Hiện tool chạy sau khi được duyệt nhưng cuộc chat không tự tiếp tục.

## 4. Quy ước đánh số

- Có ba cặp trùng số: `009`, `018`, `020`. Số `016` không được dùng. Không đổi tên các thư mục này vì nhiều handoff, review và commit đã tham chiếu đường dẫn của chúng.
- Spec mới bắt đầu từ `023` và không dùng lại số đã có.
- Khi một spec xong, cập nhật dòng `**Status**` trong `spec.md` và thêm một dòng vào bảng ở mục 1.
