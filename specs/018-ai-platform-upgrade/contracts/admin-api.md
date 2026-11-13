# Contract: Dashboard API `/api/ai-platform/*`

Quy ước: cần phiên đăng nhập dashboard (`requireAuth`). Thân và trả lời là JSON. Lỗi theo dạng hiện có: `{ "error": { "message": string, "type": string, "code"?: string } }`. Thiếu quyền trả 403 kèm `code: "missing_permission"` và tên quyền. Cập nhật có khóa lạc quan gửi `revision`; sai trả 409 `code: "revision_conflict"` kèm bản hiện hành. Trụ cột đang tắt: các đường ghi vẫn hoạt động (để cấu hình trước khi bật), các đường "thử" trả 409 `code: "pillar_disabled"`. Không trả lời nào chứa bí mật dạng rõ. `:scope` là `profile/<id>`, `support-tenant/<id>` hoặc `agent/<id>`.

Cột "Quyền" cũng là bảng ánh xạ mà `aiPlatformPermission()` phải cài đúng; đường dẫn không có trong bảng yêu cầu `manage_ai_platform`.

## Nền tảng

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/overview` | `view_ai_platform` | Công tắc, số liệu tóm tắt từng trụ cột, cảnh báo |
| PUT | `/flags` | `edit_ai_flags` | `{ prompts?, retrieval?, promptCache?, mcpClient?, outputGuard?, orchestrator? }` |
| GET/PUT | `/retention` | `view_ai_platform` / `edit_ai_flags` | Thời hạn lưu vết chạy, lời gọi công cụ, trích đoạn |

## Chỉ dẫn có phiên bản

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/prompts/:scope` | `view_prompts` | Head, bản phát hành, bản nháp, danh sách phiên bản (không kèm body) |
| GET | `/prompts/:scope/versions/:version` | `view_prompts` | Một phiên bản đầy đủ |
| GET | `/prompts/:scope/diff?from=&to=` | `view_prompts` | Khác biệt theo dòng |
| PUT | `/prompts/:scope/draft` | `edit_prompts` | `{ body, variables, note, revision }`; 422 kèm `{ line, column, reason }` khi sai cú pháp/biến |
| DELETE | `/prompts/:scope/draft` | `edit_prompts` | Bỏ nháp |
| POST | `/prompts/:scope/preview` | `edit_prompts` | `{ version \| body+variables, values }` → `{ rendered, missing: [] }` |
| POST | `/prompts/:scope/try` | `edit_prompts` | `{ version, values, message, model? }` → câu trả lời thử; không ghi vào lưu lượng của client key |
| POST | `/prompts/:scope/publish` | `publish_prompts` | `{ revision }` → head mới |
| POST | `/prompts/:scope/restore` | `publish_prompts` | `{ version, revision }` → phiên bản mới đã phát hành |
| GET | `/prompts/variables` | `view_prompts` | Danh mục biến hệ thống |

## Tri thức ngữ nghĩa

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/retrieval/:scope` | `view_retrieval` | Cấu hình, trạng thái chỉ mục `{ total, ready, pending, error }`, job hiện tại, model embedding khả dụng |
| PUT | `/retrieval/:scope` | `edit_retrieval` | Cấu hình; đổi model hoặc dimensions tạo job lập lại |
| POST | `/retrieval/:scope/reindex` | `edit_retrieval` | Lập lại toàn bộ; 409 nếu đang có job |
| POST | `/retrieval/:scope/query` | `view_retrieval` | `{ query, role? }` → `{ modeUsed, degraded, hits: [{ docTitle, chunkOrd, text, score, bm25Rank, vectorRank }] }` |
| GET | `/retrieval/usage?days=` | `view_retrieval` | Sử dụng embedding theo ngày và mục đích |

Quản lý tài liệu vẫn ở các API hiện có (`/api/profiles/:id/knowledge`, API tri thức support).

## Cache prompt

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET/PUT | `/prompt-cache/settings` | `view_prompt_cache` / `edit_prompt_cache` | `{ forward, autoBreakpoints, preferStickyRoute }` |
| GET | `/prompt-cache/capabilities` | `view_prompt_cache` | Hàng dựng sẵn và ghi đè |
| PUT | `/prompt-cache/capabilities` | `edit_prompt_cache` | Thêm/sửa một hàng ghi đè |
| DELETE | `/prompt-cache/capabilities` | `edit_prompt_cache` | `{ platform, modelPattern }` xóa ghi đè |
| GET | `/prompt-cache/stats?days=&groupBy=day\|profile\|model` | `view_prompt_cache` | `{ rows: [{ key, requests, hitRate, inputTokens, cacheReadTokens, cacheWriteTokens, estSavedUsd }] }` |

## MCP client

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/mcp/servers` | `view_mcp_servers` | Danh sách kèm tình trạng; thông tin xác thực chỉ ở dạng `{ authKind, hasSecret }` |
| POST | `/mcp/servers` | `edit_mcp_servers` | `{ slug, name, url, authKind, authHeaderName?, secret?, timeoutMs?, maxResultBytes? }`; 422 `code: "unsafe_url"` nếu bị chặn SSRF |
| PATCH | `/mcp/servers/:id` | `edit_mcp_servers` | Như trên; bỏ `secret` là giữ nguyên, `secret: null` là xóa |
| DELETE | `/mcp/servers/:id` | `edit_mcp_servers` | 409 `code: "in_use"` kèm danh sách quy trình/agent/client key đang dùng, trừ khi `?force=1` |
| POST | `/mcp/servers/:id/test` | `edit_mcp_servers` | Bắt tay, trả `{ ok, protocolVersion, serverInfo, toolCount, error? }` |
| POST | `/mcp/servers/:id/sync` | `edit_mcp_servers` | Đồng bộ công cụ → `{ added, changed, missing, unchanged }` |
| GET | `/mcp/servers/:id/tools` | `view_mcp_servers` | Công cụ kèm `state`, `effect`, schema |
| PATCH | `/mcp/tools/:id` | `review_mcp_tools` | `{ state?: "allowed"\|"blocked", effect?: "read"\|"write" }` |
| GET | `/mcp/bindings/:scope` | `view_mcp_servers` | Công cụ đang gán cho phạm vi và công tắc `aiToolsEnabled` |
| PUT | `/mcp/bindings/:scope` | `review_mcp_tools` | `{ toolIds: number[], enabled, maxRounds? }` |
| GET | `/mcp/calls?scope=&server=&status=&before=` | `view_mcp_servers` | Nhật ký lời gọi (đã che) |
| GET/PUT | `/mcp/allowed-internal-hosts` | chỉ chủ hệ thống | Danh sách ngoại lệ SSRF |

## Kiểm soát đầu ra

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET | `/output-guard/:scope` | `view_output_guard` | Chính sách |
| PUT | `/output-guard/:scope` | `edit_output_guard` | Chính sách; 422 nếu mẫu không hợp lệ hoặc quá chậm |
| POST | `/output-guard/:scope/test` | `view_output_guard` | `{ text, role?, policy? }` → `{ action, triggered: [{ detector, match }], maskedText }`; bộ kiểm tra ngoài chỉ chạy khi `includeExternal: true` |
| GET | `/output-guard/events?scope=&detector=&action=&before=` | `view_output_guard` | Sự kiện, không kèm trích đoạn |
| GET | `/output-guard/events/:id/excerpt` | `view_guard_excerpts` | Trích đoạn; 410 nếu hết hạn; ghi audit mỗi lần xem |

## Điều phối

| Phương thức | Đường dẫn | Quyền | Mô tả |
|---|---|---|---|
| GET/POST | `/agents` | `view_flows` / `edit_flows` | Danh sách / tạo |
| GET/PATCH/DELETE | `/agents/:id` | `view_flows` / `edit_flows` | DELETE trả 409 `in_use` nếu thuộc quy trình |
| GET/POST | `/flows` | `view_flows` / `edit_flows` | Danh sách / tạo |
| GET | `/flows/:id` | `view_flows` | Nháp, bản phát hành, client key được cấp |
| PUT | `/flows/:id/draft` | `edit_flows` | Định nghĩa; 422 kèm danh sách lỗi kiểm tra |
| POST | `/flows/:id/try` | `edit_flows` | Chạy thử bản nháp với `{ message }`; lần chạy gắn nhãn thử, không tính cho client key nào |
| POST | `/flows/:id/publish` | `publish_flows` | `{ revision }` |
| PUT | `/flows/:id/grants` | `publish_flows` | `{ profileIds: number[] }` |
| DELETE | `/flows/:id` | `edit_flows` | |
| GET | `/runs?flow=&profile=&status=&before=` | `view_flow_runs` | Danh sách |
| GET | `/runs/:id` | `view_flow_runs` | Lần chạy và các bước; `?after=<seq>` để lấy bước mới khi đang chạy |
| POST | `/runs/:id/cancel` | `cancel_flow_runs` | 409 nếu đã kết thúc |
| GET | `/approvals?status=pending` | `approve_ai_actions` | Hàng chờ (tham số đã che) |
| POST | `/approvals/:id/approve` | `approve_ai_actions` | `{ note? }`; 409 `code: "already_decided"` cho lần thứ hai |
| POST | `/approvals/:id/reject` | `approve_ai_actions` | `{ note? }` |

## Audit

Mọi yêu cầu ghi thành công ở trên tạo một mục audit với vùng `ai-platform` và tên tuyến đọc được. Các trường `secret`, `authorization`, `headers`, `args` không xuất hiện trong tóm tắt.
