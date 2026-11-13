---
description: "Task list for AI Platform Upgrade"
---

# Tasks: Nâng cấp toàn diện nền tảng AI (AI Platform Upgrade)

**Input**: Design documents from `/specs/018-ai-platform-upgrade/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (admin-api.md, inference-surface.md, internal-interfaces.md), quickstart.md

**Tests**: Bắt buộc theo constitution IV. Trong mỗi giai đoạn, task test đứng trước task cài đặt và phải thất bại trước khi cài đặt.

**Organization**: Theo user story. Giai đoạn 2 (nền móng kỹ thuật) chặn mọi story; sau US1, các story US2–US6 độc lập với nhau; US7 cần US2, US3, US4, US6.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: chạy song song được (khác tệp, không phụ thuộc task chưa xong)
- **[Story]**: user story trong spec.md
- Viết tắt đường dẫn: `S/` = `server/src/custom/ai-platform/`, `T/` = `server/src/__tests__/custom/ai-platform/`, `C/` = `client/src/custom/ai-platform/`, `M/` = `server/src/db/migrations/`

## Quy tắc áp dụng cho mọi task

- Không sửa migration cũ và không sửa `routes/proxy.ts`, `routes/anthropic.ts`, `routes/gemini.ts`, `routes/responses.ts`, `routes/mcp.ts`. Điểm chạm vào tệp có sẵn chỉ gồm bảng "Điểm móc" trong plan.md; cần chạm thêm thì dừng và hỏi chủ repo.
- Hàm trên đường nóng tuân theo bất biến trong `contracts/internal-interfaces.md` (trụ cột tắt thì trả đúng tham chiếu đầu vào).
- Không thêm dependency vào bất kỳ `package.json` nào.
- Mỗi giai đoạn kết thúc bằng `npm run test`, `npm run lint`, `npm run build`, `npm run test:migrations` đều đạt.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Khung thư mục, kiểu dùng chung, công cụ test giả lập, và mốc hồi quy chụp trước khi có bất kỳ điểm móc nào.

- [ ] T001 Tạo `shared/ai-platform.ts` với các kiểu `Pillar`, `Scope`, `ScopeKind`, `Wire`, hằng `AI_PLATFORM_LIMITS` (mọi giới hạn số trong data-model.md) và 21 tên quyền; tạo khung thư mục `S/`, `T/`, `C/` kèm `S/router.ts` rỗng
- [ ] T002 [P] Tạo nhà cung cấp chat giả lập ghi lại thân yêu cầu và phát được luồng theo kịch bản cho cả 4 giao thức trong `server/src/__tests__/helpers/ai-platform-fake-provider.ts`
- [ ] T003 [P] Tạo máy chủ MCP giả lập trong tiến trình (công cụ `lookup_order` đọc, `refund_order` ghi; có chế độ treo, trả 1 MB, chuyển hướng, đổi mô tả) trong `server/src/__tests__/helpers/fake-mcp-server.ts`
- [ ] T004 [P] Tạo embedding giả lập xác định và bộ đánh giá `server/src/__tests__/fixtures/retrieval-eval.json` (tối thiểu 30 đoạn, 40 câu hỏi diễn đạt lại kèm đoạn đúng) trong `server/src/__tests__/helpers/fake-embeddings.ts`
- [ ] T005 Chụp mốc hồi quy TRƯỚC mọi điểm móc: với bộ yêu cầu mẫu trên 4 giao thức (luồng và một lần, có và không có chỉ dẫn hệ thống/tri thức/`cache_control`), lưu thân gửi nhà cung cấp và thân/headers trả lời vào `server/src/__tests__/fixtures/ai-platform-baseline/` và viết `T/regression.test.ts` so sánh với mốc

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Lớp giao thức, bộ chặn câu trả lời, loopback, che dữ liệu. Mọi story phụ thuộc phần này.

**⚠️ CRITICAL**: Chưa xong giai đoạn này thì chưa bắt đầu story nào.

- [ ] T006 [P] Viết test cho nhận diện giao thức và các hàm `lastUserText`, `requestedModel`, `setRequestedModel`, `addSystemBlock`, `addTools` trên 4 giao thức trong `T/wire-extract.test.ts`
- [ ] T007 Cài `S/wire/detect.ts` và `S/wire/extract.ts` theo internal-interfaces.md, dùng lại bảng đường dẫn của `server/src/custom/knowledge-inject.ts`
- [ ] T008 [P] Viết test vàng cho `sendText` (một lần và SSE, `finish` = `stop` và `content_filter`) trên 4 giao thức trong `T/wire-respond.test.ts`, đối chiếu lược đồ với câu trả lời thật trong mốc T005
- [ ] T009 Cài `S/wire/respond.ts`
- [ ] T010 [P] Viết test cho bộ chặn: không filter thì không bọc `res`; filter `onDelta` thấy văn bản liền mạch dù SSE bị cắt giữa sự kiện; `stop` phát thay thế và sự kiện kết thúc hợp lệ; `buffering` giữ toàn bộ; lỗi phân tích thì cho qua nguyên vẹn; `onUsage` nhận usage của từng giao thức; trong `T/wire-interceptor.test.ts`
- [ ] T011 Cài `S/wire/interceptor.ts` (bọc `res.write`/`res.end`/`res.json`, bộ tách SSE theo giao thức, chuỗi `OutputFilter`)
- [ ] T012 [P] Viết test cho loopback: mang khóa người gọi; HMAC sai hoặc nguồn không phải loopback bị bỏ qua; độ sâu > 1 bị từ chối; tín hiệu hủy dừng lời gọi; usage được trả về; trong `T/loopback.test.ts`
- [ ] T013 Cài `S/loopback.ts` theo mẫu `loopbackChatCompletionsUrl` của `server/src/routes/mcp.ts` với header `x-ai-platform-internal` ký bằng khóa sinh lúc khởi động
- [ ] T014 Xác minh `server/src/custom/preparse-guard.ts` thấy được header trước cổng; thêm bước loại `x-ai-platform-internal` khỏi yêu cầu không đến từ loopback (trong tệp custom đó) và test trong `server/src/__tests__/custom/preparse-guard.test.ts`
- [ ] T015 [P] Cài `S/masking.ts` (`maskText`, `maskData`) ủy quyền cho `maskSupportSensitiveText`/`maskSupportSensitiveData` của `server/src/custom/x-gateway/support-knowledge.ts`; với phạm vi `profile` dùng chính sách che mặc định dựng sẵn; test trong `T/masking.test.ts`
- [ ] T016 Xác minh và ghi vào research.md mục R1: yêu cầu dưới `/thruline/v1` có đi qua `server/src/middleware/profile-gate.ts` hay không; nếu không, ghi rõ phạm vi áp dụng trong `contracts/inference-surface.md`

**Checkpoint**: Lớp giao thức sẵn sàng; `T/regression.test.ts` vẫn đạt (chưa có điểm móc).

---

## Phase 3: User Story 1 - Nền tảng chung: tắt mặc định, phân quyền, nhật ký (Priority: P1) 🎯 MVP

**Goal**: Công tắc từng trụ cột, 21 quyền, audit, khung dashboard, điểm móc pipeline; hành vi không đổi khi tắt.

**Independent Test**: quickstart.md, mục "Giai đoạn 1".

### Tests for User Story 1 ⚠️

- [ ] T017 [P] [US1] Viết test roundtrip `up`/`down`/`up` cho migration nền trong `server/src/__tests__/db/migrate/ai-platform-base.test.ts`
- [ ] T018 [P] [US1] Viết test công tắc: thiếu khóa hoặc JSON lỗi là tất cả `false`; `setFlags` chỉ đổi khóa được gửi; lỗi DB trả `false`; trong `T/flags.test.ts`
- [ ] T019 [P] [US1] Viết test ma trận quyền: mỗi dòng của `contracts/admin-api.md` ánh xạ đúng quyền; đường dẫn lạ và chữ hoa/thường trả `manage_ai_platform`; thành viên chỉ có quyền xem bị 403 khi ghi; triển khai single-user có đủ quyền; trong `T/permissions.test.ts`
- [ ] T020 [P] [US1] Viết test audit: bật/tắt công tắc tạo mục vùng `ai-platform`; các trường `secret`, `authorization`, `headers`, `args` không có trong tóm tắt; trong `T/audit.test.ts`
- [ ] T021 [P] [US1] Viết test `runPreRequest`: mọi công tắc tắt thì trả `continue` và `req.body`, `res` không đổi tham chiếu lẫn nội dung; lời gọi nội bộ hợp lệ bỏ qua các bước; trong `T/pipeline.test.ts`

### Implementation for User Story 1

- [ ] T022 [US1] Tạo `M/20261113_100000_custom_ai_platform_base.ts` (không tạo hàng công tắc; `down` xóa các khóa `ai_platform_*` trong `settings`)
- [ ] T023 [US1] Cài `S/flags.ts` (khóa `ai_platform_flags_v1`, cache 5 giây, `isPillarEnabled`, `getFlags`, `setFlags`)
- [ ] T024 [US1] Thêm nhóm `manage_ai_platform` cùng 21 quyền con (tên và mô tả theo data-model.md mục 1) vào `shared/permissions.ts`; xác minh `client/src/custom/PermissionsDialog.tsx` tự hiển thị nhóm mới, chỉ sửa nếu không
- [ ] T025 [US1] Cài `S/permissions.ts` (`aiPlatformPermission`) theo bảng trong `contracts/admin-api.md` và thêm một nhánh ủy quyền trong `server/src/custom/permission-actions.ts`
- [ ] T026 [US1] Cài `S/router.ts` với `GET /overview`, `PUT /flags`, `GET/PUT /retention` (khóa `ai_platform_retention_v1`: vết chạy 30 ngày, lời gọi công cụ 30 ngày, trích đoạn 7 ngày)
- [ ] T027 [US1] Đăng ký trong `server/src/custom/register.ts`: một mục `PERMISSION_GATES` (`/api/ai-platform` → `manage_ai_platform`), `app.use('/api/ai-platform', …)`; cập nhật bản sao đóng băng trong `server/src/__tests__/custom/surface.test.ts`
- [ ] T028 [US1] Thêm vùng `ai-platform` vào `describeRoute` và bổ sung danh sách trường bị che của `summarize` trong `server/src/services/audit-log.ts`
- [ ] T029 [US1] Cài `S/pipeline.ts` (`runPreRequest`, thứ tự cố định theo `contracts/inference-surface.md`, các bước là điểm cắm rỗng) và thêm một lời gọi trong `server/src/middleware/profile-gate.ts` sau bước chèn tri thức
- [ ] T030 [US1] Cài `purgeScope(kind, id)` trong `S/scope.ts`; xác minh có thể gọi nó bằng trigger SQL `AFTER DELETE ON client_profiles` trong migration nền thay vì sửa `server/src/routes/client-profiles.ts`; ghi quyết định vào research.md mục R11
- [ ] T031 [P] [US1] Viết test giao diện: tab chỉ hiện theo quyền; công tắc bị khóa khi thiếu `edit_ai_flags`; trong `C/ai-platform.test.tsx`
- [ ] T032 [US1] Cài `C/AiPlatformApp.tsx`, `C/api.ts`, `C/strings.ts`, `C/pages/Overview.tsx`; thêm một mục điều hướng và route `/ai-platform/*` trong `client/src/App.tsx`; thêm khóa tiếng Việt vào `client/src/custom/i18n/vi.ts`
- [ ] T033 [US1] Chạy `T/regression.test.ts` với các điểm móc đã cài; thêm ca "khôi phục bản sao lưu trước nâng cấp" vào `T/backup-restore.test.ts`

**Checkpoint**: US1 đạt; có thể phát hành mà không đổi hành vi.

---

## Phase 4: User Story 2 - Kết nối công cụ bên ngoài qua MCP (Priority: P1)

**Goal**: Đăng ký máy chủ MCP, duyệt công cụ, gán theo phạm vi, vòng lặp công cụ phía server, duyệt công cụ ghi.

**Independent Test**: quickstart.md, mục "Giai đoạn 2".

### Tests for User Story 2 ⚠️

- [ ] T034 [US2] Đối chiếu bắt tay, header (`Mcp-Session-Id`, `MCP-Protocol-Version`), phân trang `tools/list` và dạng trả lời SSE với bản đặc tả MCP hiện hành (đọc tài liệu chính thức, không dựa trí nhớ); cập nhật research.md mục R6 nếu khác
- [ ] T035 [P] [US2] Viết test roundtrip migration trong `server/src/__tests__/db/migrate/ai-platform-mcp.test.ts`
- [ ] T036 [P] [US2] Viết test transport: bắt tay; thân JSON và SSE; phân trang; khởi tạo lại một lần khi 404 phiên; hạn 20 giây; kết quả > 262144 byte bị cắt có đánh dấu; chặn IP riêng, loopback, siêu dữ liệu, chuyển hướng tới nội bộ, tối đa 3 bước nhảy; trong `T/mcp-transport.test.ts`
- [ ] T037 [P] [US2] Viết test registry: bí mật mã hóa và không bao giờ có trong trả lời; `schema_hash` đổi thì về `pending`; công cụ mới là `pending` và `effect = write`; `exposed_name` duy nhất và ≤ 64 ký tự; ngắt mạch sau 5 lỗi; xóa máy chủ đang dùng trả 409 `in_use`; trong `T/mcp-registry.test.ts`
- [ ] T038 [P] [US2] Viết test `executeTool`: tham số và kết quả được che; bọc `<tool_result trust="untrusted">`; công cụ ghi tạo yêu cầu duyệt và không gọi máy chủ; mỗi lời gọi ghi một dòng `custom_ai_tool_calls`; trong `T/mcp-tools.test.ts`
- [ ] T039 [P] [US2] Viết test duyệt: hai lần duyệt đồng thời chỉ một lần thực thi; từ chối không thực thi; hết hạn 24 giờ; trạng thái `unknown` không tự chạy lại; trong `T/approvals.test.ts`
- [ ] T040 [P] [US2] Viết test vòng lặp: dừng khi không còn lời gọi công cụ; tối đa 8 vòng; công cụ của người gọi được trả về và vòng lặp dừng; usage là tổng; model không hỗ trợ công cụ thì bỏ công cụ kèm header; `x-freellm-tools: off`; trong `T/mcp-tool-loop.test.ts`
- [ ] T041 [P] [US2] Viết test HTTP đầu-cuối trên 4 giao thức (luồng và một lần) với T002 và T003 trong `T/mcp-e2e.test.ts`

### Implementation for User Story 2

- [ ] T042 [US2] Tạo `M/20261113_110000_custom_ai_mcp_client.ts` với các bảng `custom_ai_mcp_servers`, `custom_ai_mcp_tools`, `custom_ai_tool_bindings`, `custom_ai_tool_calls`, `custom_ai_approvals` và cột `client_profiles.ai_tools_enabled INTEGER NOT NULL DEFAULT 0`, `ai_tool_max_rounds INTEGER` đúng data-model.md mục 2
- [ ] T043 [US2] Cài `S/mcp-client/transport.ts` trên `safeFetch`/`validateSafeHttpUrl` của `server/src/custom/x-gateway/support-safe-http.ts`, phiên bản giao thức `2025-06-18`
- [ ] T044 [US2] Cài `S/mcp-client/registry.ts` (CRUD máy chủ, mã hóa bằng `server/src/lib/crypto.ts`, `slug` khớp `^[a-z0-9-]{1,32}$`, `auth_kind` thuộc `none|bearer|header`, kiểm tra, đồng bộ, ngắt mạch 60 giây nhân đôi tới 15 phút, danh sách host nội bộ ngoại lệ)
- [ ] T045 [US2] Cài `S/mcp-client/bindings.ts` và `S/mcp-client/tools.ts` (`toolsForScope` chỉ trả công cụ `allowed` của máy chủ `enabled` chưa `paused`; `executeTool`)
- [ ] T046 [US2] Cài `S/mcp-client/calls.ts` (ghi và liệt kê lời gọi, cắt 8 KB, dọn theo thời hạn lưu)
- [ ] T047 [US2] Cài `S/orchestrator/approvals.ts` (bảng `custom_ai_approvals`, `execution_key` duy nhất, chuyển trạng thái trong giao dịch theo mẫu `server/src/custom/x-gateway/support-action-executor.ts`, tác vụ hết hạn)
- [ ] T048 [US2] Cài `S/mcp-client/tool-loop.ts` (`runToolLoop`) dùng `callGateway` và `executeTool`
- [ ] T049 [US2] Nối bước 7 trong `S/pipeline.ts`: client key có `ai_tools_enabled` và có công cụ thì tiếp quản yêu cầu, chạy `runToolLoop`, trả lời bằng `sendText`, đặt header theo `contracts/inference-surface.md`
- [ ] T050 [US2] Cài `S/mcp-client/router.ts` (mọi tuyến `/mcp/*` và `/approvals*` trong admin-api.md) và gắn vào `S/router.ts`
- [ ] T051 [P] [US2] Viết test giao diện cho bảng duyệt công cụ, hộp thoại đăng ký (bí mật không hiển thị lại), hàng chờ duyệt trong `C/mcp.test.tsx`
- [ ] T052 [US2] Cài `C/pages/McpServers.tsx`, `C/components/ToolReviewTable.tsx`, `C/components/ApprovalQueue.tsx`, chuỗi tiếng Việt trong `client/src/custom/i18n/vi.ts`
- [ ] T053 [US2] Thêm ca rò rỉ bí mật (log, nhật ký lời gọi, audit, bản sao lưu dạng rõ) vào `T/secret-leak.test.ts`; chạy `T/regression.test.ts`

**Checkpoint**: US2 đạt và tự kiểm chứng được.

---

## Phase 5: User Story 3 - Kiểm soát nội dung đầu ra (Priority: P1)

**Goal**: Chính sách đầu ra theo client key và support tenant, ba chế độ, chặn được luồng trên 4 giao thức.

**Independent Test**: quickstart.md, mục "Giai đoạn 3".

### Tests for User Story 3 ⚠️

- [ ] T054 [P] [US3] Viết test roundtrip migration trong `server/src/__tests__/db/migrate/ai-platform-output-guard.test.ts`
- [ ] T055 [P] [US3] Viết test bộ kiểm tra cục bộ: từ khóa chuẩn hóa NFC và chữ thường; mẫu tùy chỉnh; từ chối mẫu chạy quá 5 ms trên chuỗi 10.000 ký tự; `promptLeak` với 2 đoạn 12 từ trùng; PII hành động `mask`; `maxLength`; trong `T/guard-detectors.test.ts`
- [ ] T056 [P] [US3] Viết test bộ lọc luồng: từ cấm vắt qua hai mảnh không lọt; giữ `hold_chars` = 200; nhả sau `max_delay_ms` = 300; chế độ `log` không đổi văn bản; trong `T/guard-stream.test.ts`
- [ ] T057 [P] [US3] Viết test bộ kiểm tra ngoài: kiểm duyệt và mô hình đánh giá; lỗi/quá hạn với `fail_mode` `allow` và `block`; mô hình đánh giá trả JSON sai được coi là lỗi kiểm tra; trong `T/guard-external.test.ts`
- [ ] T058 [P] [US3] Viết test sự kiện: trích đoạn mã hóa, tối đa 500 ký tự, hết hạn 7 ngày trả 410; cần `view_guard_excerpts`; vai trò miễn tạo sự kiện `bypassed`; giới hạn tần suất ghi; trong `T/guard-events.test.ts`
- [ ] T059 [P] [US3] Viết test HTTP đầu-cuối trên 4 giao thức: `log`, `block` một lần, `block` luồng, câu trả lời từ cache khớp chính xác, câu trả lời sau vòng lặp công cụ; trong `T/guard-e2e.test.ts`

### Implementation for User Story 3

- [ ] T060 [US3] Tạo `M/20261113_120000_custom_ai_output_guard.ts` với `custom_ai_output_policies` (`mode` thuộc `off|log|block`, `fail_mode` thuộc `allow|block`, `hold_chars` mặc định 200 trần 2000, `max_delay_ms` mặc định 300 trần 2000, `replacement_text` tối đa 1000 ký tự) và `custom_ai_guard_events`
- [ ] T061 [US3] Cài `S/output-guard/detectors.ts` (giới hạn: 200 từ khóa × 80 ký tự; 20 mẫu × 200 ký tự)
- [ ] T062 [US3] Cài `S/output-guard/stream-guard.ts` (cửa sổ giữ lại, nhả theo thời gian)
- [ ] T063 [US3] Cài `S/output-guard/external.ts` (gọi `server/src/services/moderation.ts`; mô hình đánh giá qua `callGateway` với đầu ra JSON `{ violation, reason }`)
- [ ] T064 [US3] Cài `S/output-guard/events.ts` (ghi, liệt kê, giải mã trích đoạn, dọn)
- [ ] T065 [US3] Cài `S/output-guard/policy.ts` (`outputFilterFor`, `evaluateOutput`, CRUD chính sách có `revision`)
- [ ] T066 [US3] Nối bước 10 trong `S/pipeline.ts`: cài bộ chặn với `outputFilterFor` khi `mode` khác `off`; đặt header `x-freellm-guard`
- [ ] T067 [US3] Gọi `evaluateOutput` cho phạm vi `support_tenant` trong `server/src/custom/x-gateway/support-runtime.ts` ngay trước bước che câu trả lời; thêm ca test vào `server/src/__tests__/custom/x-support-runtime.test.ts`
- [ ] T068 [US3] Cài `S/output-guard/router.ts` (mọi tuyến `/output-guard/*`, kể cả `/test`) và gắn vào `S/router.ts`
- [ ] T069 [P] [US3] Viết test giao diện cho trình sửa chính sách, công cụ thử, danh sách sự kiện trong `C/output-guard.test.tsx`
- [ ] T070 [US3] Cài `C/pages/OutputGuard.tsx`, `C/components/PolicyTester.tsx` (nêu rõ độ trễ thêm và việc bộ kiểm tra ngoài làm mất trả lời tăng dần), chuỗi tiếng Việt
- [ ] T071 [US3] Viết bộ đo độ trễ tới ký tự đầu tiên (ngưỡng 300 ms) và tỷ lệ chặn nhầm trên bộ câu trả lời hợp lệ (ngưỡng 2%) trong `T/guard-bench.test.ts`; chạy `T/regression.test.ts`

**Checkpoint**: US3 đạt và tự kiểm chứng được.

---

## Phase 6: User Story 4 - Tri thức tìm theo ngữ nghĩa, có trích dẫn (Priority: P1)

**Goal**: Chỉ mục ngữ nghĩa lập ở nền, tìm kết hợp, tự lùi về từ khóa, trích dẫn, công cụ thử truy vấn, cho cả hai kho tri thức.

**Independent Test**: quickstart.md, mục "Giai đoạn 4".

### Tests for User Story 4 ⚠️

- [ ] T072 [P] [US4] Viết test roundtrip migration trong `server/src/__tests__/db/migrate/ai-platform-retrieval.test.ts`
- [ ] T073 [P] [US4] Viết test kho vector: mã hóa/giải mã BLOB Float32; chuẩn hóa độ dài; chỉ dùng hàng `ready` khớp `model`, `dims`, `content_hash`; làm mới theo `index_generation`; LRU 256 MB; trong `T/retrieval-vector-store.test.ts`
- [ ] T074 [P] [US4] Viết test indexer: lô 64; lùi theo `embeddingsRetryAfterSec`; tiếp tục sau khởi động lại không lập lại đoạn xong; sửa/xóa tài liệu xóa vector đồng bộ; tối đa một job mỗi phạm vi; trong `T/retrieval-indexer.test.ts`
- [ ] T075 [P] [US4] Viết test tìm kết hợp: RRF k = 60; `min_score` 0.25; `top_k` 5 tối đa 20; lùi về từ khóa khi embedding lỗi, quá 1.500 ms, chưa có chỉ mục; lọc `allowedRoles`; chế độ `keyword` trả đúng kết quả `searchKnowledge`; trong `T/retrieval-hybrid.test.ts`
- [ ] T076 [P] [US4] Viết test đánh giá chất lượng trên `retrieval-eval.json`: `hybrid` hơn `keyword` ít nhất 25 điểm phần trăm ở recall@5; trong `T/retrieval-eval.test.ts`
- [ ] T077 [P] [US4] Viết test trích dẫn: header base64url ≤ 4 KB; trường `citations` chỉ ở trả lời một lần của OpenAI và Responses; `x-freellm-citations: off`; tài liệu không đủ quyền không xuất hiện; trong `T/retrieval-citations.test.ts`

### Implementation for User Story 4

- [ ] T078 [US4] Tạo `M/20261113_130000_custom_ai_retrieval.ts` với `custom_ai_retrieval_settings` (`mode` thuộc `keyword|semantic|hybrid` mặc định `keyword`, `dimensions` mặc định 768), `custom_ai_embeddings`, `custom_ai_index_jobs`, `custom_ai_embedding_usage_daily`
- [ ] T079 [US4] Mở rộng `server/src/services/profile-knowledge.ts` bằng một hàm xuất mới `searchKnowledgeRanked` trả thứ hạng và điểm BM25 (không đổi `searchKnowledge`); làm tương tự cho `server/src/custom/x-gateway/support-knowledge.ts`
- [ ] T080 [US4] Cài `S/retrieval/settings.ts` và `S/retrieval/vector-store.ts`
- [ ] T081 [US4] Cài `S/retrieval/indexer.ts` (`onDocumentChanged`, `onDocumentDeleted`, `startIndexWorker` dùng `runEmbeddings` của `server/src/services/embeddings.ts`) và gọi `startIndexWorker` từ `server/src/custom/register.ts`
- [ ] T082 [US4] Cài `S/retrieval/hybrid.ts` (`retrieve`) và `S/retrieval/citations.ts` (`citationFilter`)
- [ ] T083 [US4] Trong `server/src/custom/knowledge-inject.ts`: khi trụ cột bật, dùng `retrieve` thay `searchKnowledge`, đánh dấu khối là tài liệu tham khảo, đăng ký `citationFilter` và header `x-freellm-retrieval`; gọi `onDocumentChanged`/`onDocumentDeleted` từ `server/src/routes/profile-knowledge.ts`
- [ ] T084 [US4] Trong `server/src/custom/x-gateway/support-runtime.ts`: dùng `retrieve` cho phạm vi `support_tenant` khi trụ cột bật; gọi `onDocumentChanged`/`onDocumentDeleted` từ `upsertSupportKnowledgeDoc`/`deleteSupportKnowledgeDoc`
- [ ] T085 [US4] Cài `S/retrieval/router.ts` (mọi tuyến `/retrieval/*`) và gắn vào `S/router.ts`
- [ ] T086 [P] [US4] Viết test giao diện cho cấu hình, thanh tiến độ, công cụ thử truy vấn trong `C/knowledge.test.tsx`
- [ ] T087 [US4] Cài `C/pages/Knowledge.tsx` (hiển thị điểm, thứ hạng BM25/vector, trạng thái suy giảm), chuỗi tiếng Việt
- [ ] T088 [US4] Viết bộ đo: 50 trang lập chỉ mục dưới 2 phút với embedding giả lập có độ trễ thực tế; độ trễ chat tăng không quá 10% trong lúc lập; tìm trên 50.000 đoạn dưới 150 ms; trong `T/retrieval-bench.test.ts`; chạy `T/regression.test.ts`

**Checkpoint**: US4 đạt và tự kiểm chứng được.

---

## Phase 7: User Story 5 - Tận dụng cache prompt của nhà cung cấp (Priority: P2)

**Goal**: Chuyển tiếp và tự đặt điểm đánh dấu theo khả năng của đích ở từng lần thử; thống kê tiết kiệm.

**Independent Test**: quickstart.md, mục "Giai đoạn 5".

### Tests for User Story 5 ⚠️

- [ ] T089 [US5] Khảo sát đường gửi tới nhà cung cấp (`server/src/lib/fallback-loop.ts`, `server/src/providers/base.ts`, `server/src/custom/provider-accounts/execution.ts`) để tìm MỘT điểm nơi nền tảng và model đích đã biết cho mỗi lần thử, và xác minh bằng test rằng khối nội dung có `cache_control` còn nguyên tới điểm đó; ghi kết quả vào research.md mục R4. Nếu cần hơn một điểm móc: DỪNG và trình bày lựa chọn cho chủ repo
- [ ] T090 [US5] Lập danh mục khả năng dựng sẵn từ tài liệu hiện hành của từng nhà cung cấp đang có trong `server/src/providers/` và `server/src/custom/provider-accounts/` (kiểu `explicit|implicit|none`, số điểm tối đa, ngưỡng token tối thiểu, thời hạn); ghi nguồn và ngày tra cứu vào research.md mục R4
- [ ] T091 [P] [US5] Viết test roundtrip migration trong `server/src/__tests__/db/migrate/ai-platform-prompt-cache.test.ts`
- [ ] T092 [P] [US5] Viết test khả năng: ghi đè thắng dựng sẵn; mẫu dài nhất thắng; không khớp là `none`; trong `T/cache-capabilities.test.ts`
- [ ] T093 [P] [US5] Viết test điểm đánh dấu: đích `explicit` giữ nguyên vị trí; đích `none`/`implicit` không còn trường `cache_control` nào; tự đặt theo thứ tự công cụ → chỉ dẫn → tri thức cố định, không vượt `max_breakpoints` trừ số của người gọi; khối dưới `min_tokens` bị bỏ qua; đầu vào không bị sửa tại chỗ; trụ cột tắt trả đúng tham chiếu; trong `T/cache-breakpoints.test.ts`
- [ ] T094 [P] [US5] Viết test ổn định phần đầu: hai yêu cầu chỉ khác câu hỏi cuối có phần trước điểm đánh dấu cuối trùng từng byte khi bật đồng thời chỉ dẫn, tri thức, công cụ, nén; trong `T/cache-prefix-stability.test.ts`
- [ ] T095 [P] [US5] Viết test thống kê: đọc usage của 4 giao thức; cộng theo ngày, client key, nền tảng, model; ước tính tiết kiệm theo `server/src/custom/x-gateway/pricing.ts`; trong `T/cache-stats.test.ts`

### Implementation for User Story 5

- [ ] T096 [US5] Tạo `M/20261113_140000_custom_ai_prompt_cache.ts` với `custom_ai_cache_capabilities` (nạp hàng `builtin` từ T090) và `custom_ai_cache_usage_daily`
- [ ] T097 [US5] Cài `S/prompt-cache/capabilities.ts` và `S/prompt-cache/breakpoints.ts` (`applyCacheBreakpoints`)
- [ ] T098 [US5] Thêm lời gọi `applyCacheBreakpoints` tại điểm đã chọn ở T089 (một dòng); thêm ca chuỗi dự phòng đổi loại đích vào `T/cache-e2e.test.ts`
- [ ] T099 [US5] Sửa `addSystemBlock` trong `S/wire/extract.ts` và nơi gọi nó để khối `stable` luôn đứng trước khối `volatile`; khối tri thức theo câu hỏi là `volatile`
- [ ] T100 [US5] Cài `S/prompt-cache/stats.ts` (`cacheUsageFilter`) và nối vào bước 10 của `S/pipeline.ts`
- [ ] T101 [US5] Cài `S/prompt-cache/router.ts` (mọi tuyến `/prompt-cache/*`) và gắn vào `S/router.ts`
- [ ] T102 [P] [US5] Viết test giao diện cho bảng khả năng và biểu đồ tiết kiệm trong `C/prompt-cache.test.tsx`
- [ ] T103 [US5] Cài `C/pages/PromptCache.tsx`, chuỗi tiếng Việt; chạy `T/regression.test.ts`

**Checkpoint**: US5 đạt và tự kiểm chứng được. Ưu tiên giữ tuyến (FR-041, mức SHOULD) hoãn tới khi có số liệu từ `custom_ai_cache_usage_daily`.

---

## Phase 8: User Story 6 - Quản lý chỉ dẫn hệ thống có phiên bản (Priority: P2)

**Goal**: Nháp, phát hành, so sánh, khôi phục, biến, xem trước; chỉ dẫn cũ thành phiên bản 1.

**Independent Test**: quickstart.md, mục "Giai đoạn 6".

### Tests for User Story 6 ⚠️

- [ ] T104 [P] [US6] Viết test migration: mỗi `client_profiles.system_prompt` khác rỗng và mỗi tenant có `systemPrompt` thành phiên bản 1 `published`; `down` giữ nguyên cột hiện có; trong `server/src/__tests__/db/migrate/ai-platform-prompts.test.ts`
- [ ] T105 [P] [US6] Viết test mẫu: `{{tên}}` và `{{tên|mặc định}}`; tên khớp `^[a-z][a-z0-9_]{0,31}$`; lỗi kèm dòng và cột; thay một lượt, giá trị chứa `{{date}}` không bị thay tiếp; giá trị người gọi cắt 200 ký tự và loại ký tự điều khiển; chuỗi không có `{{` trả đúng tham chiếu; trong `T/prompt-template.test.ts`
- [ ] T106 [P] [US6] Viết test kho: phiên bản bất biến; nhiều nhất một `published` và một `draft`; phát hành ghi `body` vào cột hiện có trong cùng giao dịch; khôi phục tạo phiên bản mới có `restored_from`; 409 khi `revision` sai; giữ 50 phiên bản, không dọn bản `published`; trong `T/prompt-store.test.ts`
- [ ] T107 [P] [US6] Viết test HTTP đầu-cuối: nháp không ảnh hưởng chat; phát hành có hiệu lực ở yêu cầu kế tiếp; `x-freellm-vars` sai định dạng bị bỏ qua không lỗi; `try` không ghi vào sử dụng của client key; trong `T/prompt-e2e.test.ts`

### Implementation for User Story 6

- [ ] T108 [US6] Tạo `M/20261113_150000_custom_ai_prompt_versions.ts` với `custom_ai_prompt_versions` (`status` thuộc `draft|published|archived`, `note` tối đa 500) và `custom_ai_prompt_heads`, kèm di trú phiên bản 1
- [ ] T109 [US6] Cài `S/prompts/template.ts` (`validateTemplate`, `renderWith`) và `S/prompts/store.ts` (`saveDraft`, `publish`, `restore`, `getPublishedPrompt`, diff theo dòng)
- [ ] T110 [US6] Cài `S/prompts/render.ts` (`renderPrompt` lấy ngữ cảnh từ `server/src/lib/client-context.ts` và `x-freellm-vars`) và thêm một dòng gọi nó trong `prependSystemPrompt` của `server/src/lib/system-prompt.ts`
- [ ] T111 [US6] Áp dụng `renderWith` cho `systemPrompt` của tenant tại nơi dựng chỉ dẫn trong `server/src/custom/x-gateway/support-router.ts`
- [ ] T112 [US6] Cài `S/prompts/router.ts` (mọi tuyến `/prompts/*`) và gắn vào `S/router.ts`
- [ ] T113 [P] [US6] Viết test giao diện cho lịch sử, so sánh, trình sửa biến, xem trước, cảnh báo biến làm mất ổn định cache trong `C/prompts.test.tsx`
- [ ] T114 [US6] Cài `C/pages/Prompts.tsx`, `C/components/DiffView.tsx`, `C/components/VariableEditor.tsx`, chuỗi tiếng Việt; chạy `T/regression.test.ts`

**Checkpoint**: US6 đạt và tự kiểm chứng được.

---

## Phase 9: User Story 7 - Điều phối đa bước, đa agent (Priority: P3)

**Goal**: Agent, quy trình, chuyển giao, giới hạn cứng, vết chạy, tạm dừng chờ duyệt, gọi như một model.

**Independent Test**: quickstart.md, mục "Giai đoạn 7". Cần US2, US3, US4, US6 đã xong.

### Tests for User Story 7 ⚠️

- [ ] T115 [P] [US7] Viết test roundtrip migration trong `server/src/__tests__/db/migrate/ai-platform-orchestrator.test.ts`
- [ ] T116 [P] [US7] Viết test định nghĩa: kiểm tra `entryAgent`, `handoffs`, agent `enabled`; trần cứng 50 bước, 100 lời gọi công cụ, 10 chuyển giao, 500.000 token, 600 giây; phát hành chụp phiên bản chỉ dẫn của từng agent; `slug` khớp `^[a-z0-9-]{1,48}$`; trong `T/flow-definitions.test.ts`
- [ ] T117 [P] [US7] Viết test giới hạn và phát hiện lặp: mỗi `stop_reason`; vượt token tối đa một bước; cùng (công cụ, tham số) lần thứ 3 bị cắt; A→B→A→B bị cắt; trong `T/flow-limits.test.ts`
- [ ] T118 [P] [US7] Viết test engine: `single` và `handoff`; công cụ ảo `transfer_to_<agent>` chỉ cho đích được phép; agent sau chuyển giao không thấy công cụ và tri thức của agent trước; mọi chuyển trạng thái trong data-model.md mục 7; trong `T/flow-engine.test.ts`
- [ ] T119 [P] [US7] Viết test duyệt và gián đoạn: tạm dừng, duyệt thì tiếp tục đúng bước, từ chối thì kết thúc có giải thích, hết hạn thì `stopped`; khởi động lại chuyển `running` thành `interrupted` và không lặp lời gọi công cụ; trong `T/flow-approvals.test.ts`
- [ ] T120 [P] [US7] Viết test HTTP đầu-cuối: `flow:<slug>` trên 4 giao thức; 403 `flow_not_granted`; 400 `flow_requires_client_key`; 404 khi trụ cột tắt; tiến độ là dòng chú thích SSE; ngắt kết nối và hủy; tổng token khớp phân tích của client key; hết hạn mức giữa chừng dừng `quota_exhausted`; câu trả lời cuối qua kiểm soát đầu ra; `GET /v1/ai/runs/{id}` chỉ cho key khởi tạo; trong `T/flow-e2e.test.ts`

### Implementation for User Story 7

- [ ] T121 [US7] Tạo `M/20261113_160000_custom_ai_orchestrator.ts` với `custom_ai_agents`, `custom_ai_flows`, `custom_ai_flow_grants`, `custom_ai_runs`, `custom_ai_run_steps` đúng data-model.md mục 7
- [ ] T122 [US7] Thêm `flow:` vào `RESERVED_PREFIXES` trong `server/src/custom/x-gateway/combos.ts` và ca test tương ứng
- [ ] T123 [US7] Cài `S/orchestrator/definitions.ts` (CRUD agent và quy trình, kiểm tra, phát hành, cấp cho client key)
- [ ] T124 [US7] Cài `S/orchestrator/limits.ts` (bộ đếm, mặc định 12 bước / 20 lời gọi công cụ / 4 chuyển giao / 60.000 token / 120 giây, phát hiện lặp)
- [ ] T125 [US7] Cài `S/orchestrator/trace.ts` (ghi bước ngay khi xong, che và cắt 8 KB, dọn theo thời hạn lưu)
- [ ] T126 [US7] Cài `S/orchestrator/engine.ts` (`isFlowModel`, `startRun`, `resumeRun`, `cancelRun`, `markInterruptedRuns`) dùng `runToolLoop`, `retrieve`, `getPublishedPrompt`, `evaluateOutput`
- [ ] T127 [US7] Nối bước 4 trong `S/pipeline.ts` (nhận diện `flow:<slug>` trước các bước khác); gọi `markInterruptedRuns` lúc khởi động từ `server/src/custom/register.ts`; nối `resumeRun` vào quyết định duyệt trong `S/orchestrator/approvals.ts`
- [ ] T128 [US7] Cài `S/orchestrator/runs-public.ts` (`GET /v1/ai/runs/:id`) và gắn `app.use('/v1/ai', …)` trong `server/src/custom/register.ts`
- [ ] T129 [US7] Cài `S/orchestrator/router.ts` (mọi tuyến `/agents*`, `/flows*`, `/runs*`) và gắn vào `S/router.ts`
- [ ] T130 [P] [US7] Viết test giao diện cho trình sửa quy trình, chạy thử, vết chạy trực tiếp, hủy trong `C/flows.test.tsx`
- [ ] T131 [US7] Cài `C/pages/Flows.tsx`, `C/pages/Runs.tsx`, `C/components/RunTrace.tsx`, chuỗi tiếng Việt; chạy `T/regression.test.ts`

**Checkpoint**: Cả bảy story hoạt động.

---

## Phase 10: Polish & Cross-Cutting Concerns

- [ ] T132 [P] Viết kịch bản tổng hợp bật cả 6 trụ cột cho một client key và khẳng định thứ tự xử lý theo `contracts/inference-surface.md` trong `T/all-pillars.test.ts`
- [ ] T133 [P] Hoàn thiện `T/backup-restore.test.ts`: sao lưu và khôi phục toàn bộ bảng `custom_ai_*`; khôi phục thiếu `custom_ai_embeddings` thì chỉ mục tự lập lại; bí mật MCP vẫn ở dạng mã hóa trong bản sao lưu
- [ ] T134 [P] Hoàn thiện `T/secret-leak.test.ts` cho mọi trụ cột (log, vết chạy, audit, bản xuất, thông báo lỗi)
- [ ] T135 Đo thời gian xử lý thêm với mọi công tắc tắt so với mốc T005 (ngưỡng 5%) trong `T/overhead-bench.test.ts`
- [ ] T136 [P] Viết `docs/ai-platform.md` (thứ tự pipeline, từng trụ cột, giới hạn mặc định, cách tắt) bằng ngôn ngữ kỹ thuật trung tính theo AGENTS.md mục 6, và thêm liên kết từ `docs/README.md`
- [ ] T137 [P] Chạy `client/src/custom/i18n/translations.test.ts`; bổ sung mọi khóa tiếng Việt còn thiếu trong `client/src/custom/i18n/vi.ts`
- [ ] T138 Chạy toàn bộ quickstart.md trên bản chạy thật, gồm single-user trong Docker; ghi kết quả vào `specs/018-ai-platform-upgrade/acceptance.md`
- [ ] T139 Cập nhật `docs/CHANGELOG.md` và rà lại bảng "Điểm móc" trong plan.md so với `git diff --stat` thực tế

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 → Phase 2 → Phase 3 (US1)**: tuần tự; T005 phải xong trước mọi điểm móc.
- **Phase 4 (US2), 5 (US3), 6 (US4), 7 (US5), 8 (US6)**: mỗi phase chỉ cần Phase 3; độc lập với nhau.
- **Phase 9 (US7)**: cần Phase 4, 5, 6, 8.
- **Phase 10**: sau các story muốn phát hành.

### Phụ thuộc chéo cần lưu ý

- T047 (`approvals.ts`) thuộc US2 nhưng US7 dùng lại (T127).
- T067 và T084 cùng sửa `server/src/custom/x-gateway/support-runtime.ts`: làm tuần tự.
- T083 và T099 cùng liên quan vị trí khối tri thức: nếu US5 làm trước US4 thì T099 chỉ xử lý khối chỉ dẫn, và T083 phải dùng `position: 'volatile'`.
- T089 là cổng dừng: kết quả có thể đổi phạm vi của T098.
- `S/pipeline.ts`, `S/router.ts`, `client/src/custom/i18n/vi.ts`, `server/src/custom/register.ts` bị nhiều story chạm vào: khi làm song song, mỗi story chỉ thêm dòng ở vùng của mình.

### Within Each User Story

Test (phải thất bại) → migration → store/logic → nối pipeline → router → giao diện → hồi quy.

## Parallel Example: User Story 2

```text
# Sau T034, viết đồng thời các test:
T035 ai-platform-mcp.test.ts (migration)
T036 mcp-transport.test.ts
T037 mcp-registry.test.ts
T038 mcp-tools.test.ts
T039 approvals.test.ts
T040 mcp-tool-loop.test.ts
T041 mcp-e2e.test.ts

# Sau T042 (migration): T043 transport và T047 approvals song song; T051 (test giao diện) song song với T044–T050.
```

Sau Phase 3, năm nhóm có thể làm song song: US2, US3, US4, US5, US6.

## Implementation Strategy

### MVP First

1. Phase 1 → 2 → 3 (US1): phát hành được, không đổi hành vi, có khung quyền và dashboard.
2. Thêm một trụ cột P1 mang giá trị rõ nhất. Đề xuất US2 (MCP client) vì nó mở công cụ cho cả client key lẫn điều phối sau này.

### Incremental Delivery

US1 → US2 → US3 → US4 (hết nhóm P1) → US5 → US6 (P2) → US7 (P3) → Polish. Mỗi story là một nhóm commit tách PR được; dừng sau bất kỳ story nào hệ thống vẫn nhất quán vì mọi trụ cột tắt mặc định.

### Số lượng

| Phase | Story | Task |
|---|---|---|
| 1 Setup | — | 5 (T001–T005) |
| 2 Foundational | — | 11 (T006–T016) |
| 3 | US1 | 17 (T017–T033) |
| 4 | US2 | 20 (T034–T053) |
| 5 | US3 | 18 (T054–T071) |
| 6 | US4 | 17 (T072–T088) |
| 7 | US5 | 15 (T089–T103) |
| 8 | US6 | 11 (T104–T114) |
| 9 | US7 | 17 (T115–T131) |
| 10 Polish | — | 8 (T132–T139) |
| **Tổng** | | **139** |

## Notes

- Các task T016, T030, T034, T089, T090 là task xác minh: kết quả của chúng được ghi lại vào research.md trước khi viết mã phụ thuộc.
- Commit sau mỗi task hoặc nhóm task liền mạch; không commit tệp nhị phân; tài liệu công khai dùng ngôn ngữ trung tính (AGENTS.md mục 6).
- Mọi checkbox ở trạng thái chưa làm: tài liệu này là kế hoạch, chưa có dòng mã nào của tính năng được viết.
