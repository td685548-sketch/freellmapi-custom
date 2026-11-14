# Implementation Plan: Nâng cấp toàn diện nền tảng AI (AI Platform Upgrade)

**Branch**: `claude/beautiful-goldberg-6uxvyu` | **Date**: 2026-11-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/018-ai-platform-upgrade/spec.md`

## Summary

Lấp bảy khoảng trống của gateway (chỉ dẫn hệ thống có phiên bản, tri thức ngữ nghĩa có trích dẫn, quyền riêng cho tính năng mới, cache prompt phía nhà cung cấp, MCP client, kiểm soát đầu ra, điều phối đa agent) bằng một module riêng `server/src/custom/ai-platform/` và `client/src/custom/ai-platform/`. Mọi trụ cột có công tắc riêng, mặc định tắt.

Ba quyết định kiến trúc quyết định mức độ chạm vào mã upstream:

1. **Phía yêu cầu**: mọi biến đổi chạy trong cổng `middleware/profile-gate.ts` đã có (nơi hiện đang chèn tri thức, lọc nội dung, trả lời nhanh), qua một lời gọi duy nhất tới `runPreRequest()`.
2. **Phía câu trả lời**: kiểm soát đầu ra, trích dẫn và thống kê cache là một bộ chặn `res.write`/`res.end` hiểu bốn giao thức, cài từ cùng cổng đó. Không sửa các handler `routes/proxy.ts`, `anthropic.ts`, `gemini.ts`, `responses.ts`.
3. **Vòng lặp công cụ và điều phối**: cổng tiếp quản yêu cầu, gọi model qua loopback tới `/v1/chat/completions` (cách `routes/mcp.ts` đang làm cho `ask_freellmapi`), nên thừa hưởng nguyên định tuyến, dự phòng, hạn mức và ghi nhận sử dụng hiện có.

Chỉ cache prompt cần một điểm móc trong đường gửi tới nhà cung cấp (xem research R4).

## Technical Context

**Language/Version**: TypeScript, ESM (`"type": "module"`), Node.js >= 20.18.0 < 25

**Primary Dependencies**: Express, better-sqlite3 / libsql (Turso tùy chọn), zod, React + Vite + Tailwind + Lucide. Không thêm dependency mới: MCP client viết tay bằng JSON-RPC như MCP server hiện có; vector lưu BLOB và tính cosine trong tiến trình.

**Storage**: SQLite hiện có (WAL), hoặc Turso khi bật. Bảng mới có tiền tố `custom_ai_`; công tắc lưu ở bảng `settings`.

**Testing**: Vitest cho server và client; `npm run test:migrations` cho migration roundtrip; nhà cung cấp, embedding và máy chủ MCP đều giả lập ở biên HTTP.

**Target Platform**: Linux server / Docker non-root / Render; ứng dụng desktop và CLI tiếp tục chạy không đổi.

**Project Type**: Web service + dashboard trong monorepo npm (`shared`, `server`, `client`, `cli`, `desktop`).

**Performance Goals**: mọi trụ cột tắt thì thêm không quá 5% thời gian xử lý của gateway (SC-002); kiểm soát đầu ra không dùng bộ kiểm tra ngoài thêm không quá 300 ms tới ký tự đầu tiên (SC-007); tìm kiếm kết hợp trên 50.000 đoạn dưới 150 ms sau khi chỉ mục đã nạp; tài liệu 50 trang lập chỉ mục dưới 2 phút (SC-010).

**Constraints**: Zero-Conflict (constitution VI) — tệp mới, migration mới, móc tối thiểu; không đổi hành vi `/v1/*`, `/mcp`, `/livez`, `/readyz`, `/api/ping`; bí mật mã hóa AES-GCM và không vào log (constitution I); chạy được single-user; suy giảm an toàn khi thành phần tùy chọn lỗi (FR-009).

**Scale/Scope**: tới 50.000 đoạn mỗi bộ tri thức; tới 50 máy chủ MCP và 500 công cụ; tới 100 quy trình; lần chạy tối đa 50 bước; 21 quyền mới; 8 màn hình dashboard; 139 task trong 10 phase của tasks.md.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Nguyên tắc | Đánh giá trước thiết kế | Sau thiết kế |
|---|---|---|
| I. Bảo mật và bí mật | Thông tin xác thực MCP mã hóa AES-GCM bằng `lib/crypto.ts`; trích đoạn vi phạm mã hóa và có hạn; log, vết chạy, audit chỉ nhận dữ liệu đã che. Không nới bất kỳ kiểm soát truy cập nào. | PASS |
| II. Monorepo, tách bạch | DTO dùng chung ở `shared/ai-platform.ts`; server và client không import chéo. | PASS |
| III. Bền vững | Migration idempotent, có `down`; suy giảm về hành vi hiện tại khi embedding, MCP, bộ kiểm tra ngoài lỗi; công việc nền tự tiếp tục sau khởi động lại. | PASS |
| IV. Test trước | Mỗi giai đoạn có test hợp đồng và tích hợp viết trước phần cài đặt; migration có test roundtrip. | PASS |
| V. Tương thích ngược | Tắt mặc định; có test "yêu cầu gửi nhà cung cấp giống hệt" khi mọi công tắc tắt; mọi bổ sung trên giao thức là trường hoặc header tùy chọn. | PASS |
| VI. Zero-Conflict | Toàn bộ logic ở tệp mới. Danh sách điểm móc bên dưới là toàn bộ phần chạm vào tệp có sẵn. | PASS, có một ngoại lệ được ghi ở Complexity Tracking |
| VII. Nhánh và PR | Làm trên nhánh được chỉ định cho phiên này; mỗi giai đoạn là một nhóm commit có thể tách PR. PR chỉ mở khi chủ repo yêu cầu. | PASS |

### Điểm móc vào tệp có sẵn (toàn bộ)

| Tệp | Thay đổi | Giai đoạn |
|---|---|---|
| `shared/permissions.ts` | thêm một nhóm `manage_ai_platform` và các quyền con | 1 |
| `server/src/custom/permission-actions.ts` | thêm một nhánh `if (parent === 'manage_ai_platform')` gọi `aiPlatformPermission()` | 1 |
| `server/src/custom/register.ts` | một mục `PERMISSION_GATES`, một `app.use('/api/ai-platform', …)`, một `app.use('/v1/ai', …)` | 1 |
| `server/src/middleware/profile-gate.ts` | một lời gọi `runPreRequest()` sau bước chèn tri thức | 1 |
| `server/src/services/audit-log.ts` | thêm vùng `ai-platform` vào `describeRoute` | 1 |
| `server/src/db/migrate/defaults.ts` | đăng ký migration nền mới, không sửa migration đã phát hành | 1 |
| `server/src/__tests__/db/migrate/roundtrip.test.ts` | cập nhật danh sách migration kỳ vọng để kiểm roundtrip | 1 |
| `server/src/__tests__/custom/surface.test.ts` | cập nhật bản sao đóng băng của `PERMISSION_GATES` | 1 |
| `client/src/App.tsx` | một mục điều hướng và một route `/ai-platform/*` | 1 |
| `client/src/custom/PermissionsDialog.tsx` | không sửa nếu đã đọc `PERMISSION_GROUPS`; xác minh ở T024 | 1 |
| `client/src/custom/i18n/vi.ts` | thêm khóa dịch | mọi giai đoạn |
| `server/src/custom/knowledge-inject.ts` | thay `searchKnowledge` bằng `retrieve()` khi công tắc bật | 4 |
| `server/src/custom/x-gateway/support-runtime.ts` | như trên cho kho tri thức support; gọi `evaluateOutput()` trước khi che câu trả lời | 3, 4 |
| `server/src/lib/system-prompt.ts` | một dòng trong `prependSystemPrompt` gọi `renderPrompt()` | 6 |
| đường gửi tới nhà cung cấp (xác định ở T089) | một lời gọi `applyCacheBreakpoints()` cho mỗi lần thử | 5 |

Không sửa: mọi migration cũ, `routes/proxy.ts`, `routes/anthropic.ts`, `routes/gemini.ts`, `routes/responses.ts`, `routes/mcp.ts`, `services/router.ts`, `services/fusion.ts`, `custom/x-gateway/combos.ts`.

## Project Structure

### Documentation (this feature)

```text
specs/018-ai-platform-upgrade/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── admin-api.md          # /api/ai-platform/*
│   ├── inference-surface.md  # bổ sung tùy chọn trên /v1/* và /v1/ai/*
│   └── internal-interfaces.md# hàm TypeScript giữa các module
├── checklists/requirements.md
└── tasks.md                  # do /speckit-tasks tạo
```

### Source Code (repository root)

```text
shared/
└── ai-platform.ts                     # DTO, tên quyền, giới hạn dùng chung

server/src/custom/ai-platform/
├── flags.ts                           # công tắc trụ cột (settings: ai_platform_flags_v1)
├── permissions.ts                     # aiPlatformPermission(method, path)
├── router.ts                          # gắn các router con dưới /api/ai-platform
├── pipeline.ts                        # runPreRequest(): thứ tự cố định (FR-008)
├── wire/
│   ├── detect.ts                      # nhận diện 4 giao thức từ đường dẫn
│   ├── extract.ts                     # lấy/thay văn bản trong JSON và SSE của từng giao thức
│   ├── respond.ts                     # viết câu trả lời tổng hợp (một lần và SSE)
│   └── interceptor.ts                 # bọc res.write/res.end, chuỗi bộ lọc đầu ra
├── loopback.ts                        # gọi /v1/chat/completions nội bộ, giữ danh tính người gọi
├── masking.ts                         # mặt tiền dùng lại bộ che PII hiện có
├── prompts/        { store.ts, template.ts, render.ts, router.ts }
├── retrieval/      { settings.ts, vector-store.ts, indexer.ts, hybrid.ts, citations.ts, router.ts }
├── prompt-cache/   { capabilities.ts, breakpoints.ts, stats.ts, router.ts }
├── mcp-client/     { transport.ts, registry.ts, tools.ts, bindings.ts, tool-loop.ts, calls.ts, router.ts }
├── output-guard/   { policy.ts, detectors.ts, stream-guard.ts, external.ts, events.ts, router.ts }
└── orchestrator/   { definitions.ts, engine.ts, limits.ts, approvals.ts, trace.ts, runs-public.ts, router.ts }

server/src/db/migrations/
├── 20261113_100000_custom_ai_platform_base.ts
├── 20261113_110000_custom_ai_mcp_client.ts
├── 20261113_120000_custom_ai_output_guard.ts
├── 20261113_130000_custom_ai_retrieval.ts
├── 20261113_140000_custom_ai_prompt_cache.ts
├── 20261113_150000_custom_ai_prompt_versions.ts
└── 20261113_160000_custom_ai_orchestrator.ts

server/src/__tests__/custom/ai-platform/     # một tệp test cho mỗi module + regression.test.ts
server/src/__tests__/db/migrate/ai-platform-*.test.ts

client/src/custom/ai-platform/
├── AiPlatformApp.tsx                  # khung, tab, kiểm tra quyền
├── api.ts, strings.ts
├── pages/ { Overview, Prompts, Knowledge, PromptCache, McpServers, OutputGuard, Flows, Runs }.tsx
├── components/ { DiffView, VariableEditor, ToolReviewTable, PolicyTester, RunTrace, ApprovalQueue }.tsx
└── *.test.tsx

docs/ai-platform.md                    # hướng dẫn vận hành, thứ tự pipeline
```

**Structure Decision**: Web application trong monorepo hiện có. Một thư mục module cho mỗi trụ cột dưới `custom/ai-platform/`, mỗi module tự có store, logic và router; các module chỉ nói chuyện với nhau qua các hàm trong `contracts/internal-interfaces.md`. Một migration cho mỗi giai đoạn để từng giai đoạn tự triển khai và tự gỡ được.

## Giai đoạn giao hàng

Mỗi giai đoạn kết thúc bằng `npm run test`, `npm run lint`, `npm run build`, `npm run test:migrations` đạt và có thể phát hành riêng.

| # | Giai đoạn | User story | Kết quả kiểm chứng được | Phụ thuộc |
|---|---|---|---|---|
| 1 | Nền tảng | US1 | Công tắc, 21 quyền, audit, khung dashboard, bộ chặn câu trả lời rỗng, test hồi quy "giống hệt khi tắt" | — |
| 2 | MCP client | US2 | Đăng ký máy chủ, duyệt công cụ, gắn cho client key, vòng lặp công cụ phía server, hàng chờ duyệt | 1 |
| 3 | Kiểm soát đầu ra | US3 | Chính sách theo client key và tenant, ba chế độ, chặn được cả SSE trên 4 giao thức | 1 |
| 4 | Tri thức ngữ nghĩa | US4 | Chỉ mục nền, tìm kết hợp, tự lùi về từ khóa, trích dẫn, công cụ thử truy vấn | 1 |
| 5 | Cache prompt | US5 | Chuyển tiếp và tự đặt điểm đánh dấu, thống kê tiết kiệm | 1 (tốt hơn sau 4) |
| 6 | Chỉ dẫn có phiên bản | US6 | Nháp, phát hành, so sánh, khôi phục, biến, xem trước | 1 |
| 7 | Điều phối | US7 | Agent, quy trình, chuyển giao, giới hạn, vết chạy, duyệt | 2, 3, 4, 6 |
| 8 | Hoàn thiện | — | Sao lưu/khôi phục, tài liệu, đo hiệu năng, rà i18n | tất cả |

Giai đoạn 2 đến 6 độc lập với nhau và có thể làm song song sau giai đoạn 1.

## Rủi ro chính

| Rủi ro | Giảm thiểu |
|---|---|
| Bộ chặn câu trả lời phá định dạng SSE của một giao thức | Test vàng cho từng giao thức với bản ghi luồng thật; khi không nhận diện được giao thức thì cho qua nguyên vẹn và ghi cảnh báo; công tắc tắt thì không cài bộ chặn. |
| Điểm móc cache prompt nằm sâu trong mã upstream | T089 khảo sát và chọn một điểm duy nhất trước khi viết mã; nếu cần hơn một dòng móc thì dừng và hỏi chủ repo. |
| Vector trong SQLite chậm khi dùng Turso (mỗi truy vấn là một lượt mạng) | Nạp vector vào bộ nhớ theo từng bộ tri thức như chỉ mục BM25 hiện tại, làm mới theo số hiệu phiên bản; không truy vấn DB trên đường nóng. |
| Loopback làm tính trùng hạn mức hoặc lặp vô hạn | Header nội bộ ký bằng khóa sinh lúc khởi động, chỉ nhận từ địa chỉ loopback; mang theo độ sâu; cổng bỏ qua các bước đã chạy khi thấy header hợp lệ. |
| Kết quả công cụ MCP chèn chỉ dẫn | Đóng gói có nhãn dữ liệu không tin cậy, che PII, giới hạn kích thước, và câu trả lời cuối vẫn qua kiểm soát đầu ra. |
| Phạm vi lớn | Bảy giai đoạn tự đứng được; có thể dừng sau bất kỳ giai đoạn nào mà hệ thống vẫn nhất quán. |

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Một điểm móc trong đường gửi tới nhà cung cấp (mã upstream) cho cache prompt | Khả năng cache phụ thuộc nhà cung cấp được chọn ở từng lần thử của chuỗi dự phòng (FR-042); chỉ nơi đó biết đích thật. | Xử lý ở cổng trước định tuyến thì không biết nhà cung cấp, nên hoặc gửi trường lạ tới nơi không hỗ trợ, hoặc phải bỏ toàn bộ điểm đánh dấu. |
| Một dòng trong `lib/system-prompt.ts` cho biến chỉ dẫn | Cả bốn handler đều gọi `prependSystemPrompt`; đây là điểm chung duy nhất. | Sửa bốn handler là bốn điểm chạm thay vì một. |
