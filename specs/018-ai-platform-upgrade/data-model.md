# Data Model: AI Platform Upgrade

Quy ước chung: bảng mới có tiền tố `custom_ai_`; khóa chính `id INTEGER PRIMARY KEY AUTOINCREMENT` trừ khi ghi khác; thời gian là `TEXT` UTC `datetime('now')`; cột `revision INTEGER NOT NULL DEFAULT 1` dùng cho khóa lạc quan (cập nhật phải gửi `revision` hiện tại, sai thì trả 409). Mọi migration có `up` idempotent và `down` đảo ngược được. Không sửa bảng upstream ngoài `ALTER TABLE … ADD COLUMN` có kiểm tra tồn tại, theo mẫu `20261107_000003_custom_profile_knowledge.ts`.

Phạm vi (`scope_kind`, `scope_id`): `'profile'` + id của `client_profiles`, `'support_tenant'` + id tenant, `'agent'` + id agent. `scope_id` là `TEXT`.

## 1. Nền tảng — `20261113_100000_custom_ai_platform_base.ts`

**Công tắc** — bảng `settings`, khóa `ai_platform_flags_v1`:

```json
{ "prompts": false, "retrieval": false, "promptCache": false, "mcpClient": false, "outputGuard": false, "orchestrator": false }
```

Thiếu khóa hoặc JSON lỗi được hiểu là tất cả `false`. Migration không tạo hàng này.

**Quyền** (trong `shared/permissions.ts`, nhóm `manage_ai_platform`):

| Quyền | Mở |
|---|---|
| `view_ai_platform` | Trang tổng quan và trạng thái công tắc |
| `edit_ai_flags` | Bật/tắt trụ cột |
| `view_prompts`, `edit_prompts`, `publish_prompts` | Xem; tạo nháp và xem trước; phát hành và khôi phục |
| `view_retrieval`, `edit_retrieval` | Cấu hình truy hồi, thử truy vấn; sửa và lập chỉ mục lại |
| `view_prompt_cache`, `edit_prompt_cache` | Thống kê; cấu hình và ghi đè khả năng |
| `view_mcp_servers`, `edit_mcp_servers`, `review_mcp_tools` | Xem; đăng ký/sửa/xóa máy chủ; duyệt công cụ và gán |
| `view_output_guard`, `edit_output_guard`, `view_guard_excerpts` | Chính sách và sự kiện; sửa; xem trích đoạn vi phạm |
| `view_flows`, `edit_flows`, `publish_flows` | Agent và quy trình; sửa nháp; phát hành và cấp cho client key |
| `view_flow_runs`, `cancel_flow_runs` | Vết chạy; hủy |
| `approve_ai_actions` | Duyệt/từ chối hành động nhạy cảm |

## 2. MCP client — `20261113_110000_custom_ai_mcp_client.ts`

**`custom_ai_mcp_servers`**

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `slug` | TEXT UNIQUE | `^[a-z0-9-]{1,32}$`, dùng trong tên công cụ |
| `name`, `url` | TEXT | `url` phải là https, trừ host trong danh sách ngoại lệ |
| `auth_kind` | TEXT | `none` \| `bearer` \| `header` |
| `auth_header_name` | TEXT NULL | khi `header` |
| `auth_ciphertext`, `auth_iv`, `auth_tag` | TEXT NULL | AES-GCM qua `lib/crypto.ts` |
| `enabled` | INTEGER | mặc định 1 |
| `timeout_ms`, `max_result_bytes`, `max_concurrency` | INTEGER | mặc định 20000, 262144, 4 |
| `status` | TEXT | `unknown` \| `ok` \| `error` \| `paused` |
| `last_error`, `last_connected_at`, `fail_count`, `paused_until` | | ngắt mạch |
| `protocol_version`, `server_info_json` | TEXT NULL | từ `initialize` |
| `created_by`, `created_at`, `updated_at`, `revision` | | |

**`custom_ai_mcp_tools`** — UNIQUE(`server_id`, `name`)

| Cột | Ghi chú |
|---|---|
| `server_id` | FK, xóa máy chủ thì xóa công cụ |
| `name`, `description`, `input_schema_json` | bản chụp từ `tools/list` |
| `schema_hash` | SHA-256 của (name, description, schema chuẩn hóa) |
| `exposed_name` | `mcp__<slug>__<name>`, UNIQUE, tối đa 64 ký tự |
| `state` | `pending` → `allowed` \| `blocked`; hash đổi thì về `pending` |
| `effect` | `write` (mặc định) \| `read` |
| `reviewed_by`, `reviewed_at`, `missing_since` | `missing_since` đặt khi máy chủ không còn công bố công cụ |

**`custom_ai_tool_bindings`** — PRIMARY KEY(`tool_id`, `scope_kind`, `scope_id`). Chỉ công cụ `allowed` của máy chủ `enabled` mới có hiệu lực lúc chạy.

**`custom_ai_tool_calls`**

`id`, `run_id` NULL, `scope_kind`, `scope_id`, `end_user` NULL, `server_id`, `tool_name`, `args_masked` (JSON đã che, cắt 8 KB), `result_masked` (cắt 8 KB), `status` (`ok` \| `tool_error` \| `timeout` \| `too_large` \| `blocked` \| `transport_error` \| `awaiting_approval` \| `rejected`), `duration_ms`, `result_bytes`, `created_at`. Chỉ mục (`scope_kind`, `scope_id`, `created_at`). Dọn sau 30 ngày.

**`custom_ai_approvals`**

| Cột | Ghi chú |
|---|---|
| `execution_key` | TEXT UNIQUE — hash của (run hoặc turn id, thứ tự bước, exposed_name, tham số chuẩn hóa) |
| `run_id`, `step_seq`, `scope_kind`, `scope_id`, `end_user` | |
| `tool_id`, `args_ciphertext`/`iv`/`tag`, `args_masked` | tham số thật mã hóa để thực thi sau; bản che để hiển thị |
| `status` | `pending` → `approved` → `executing` → `succeeded` \| `failed` \| `unknown`; hoặc `pending` → `rejected` \| `expired` |
| `decided_by`, `decided_at`, `decision_note`, `expires_at` | |

Chuyển `pending → approved → executing` trong một giao dịch có điều kiện trên `status`; yêu cầu duyệt thứ hai nhận 409. `unknown` (mất kết nối giữa lúc thực thi) không tự chạy lại.

**Cột thêm**: `client_profiles.ai_tools_enabled INTEGER NOT NULL DEFAULT 0`, `client_profiles.ai_tool_max_rounds INTEGER`.

## 3. Kiểm soát đầu ra — `20261113_120000_custom_ai_output_guard.ts`

**`custom_ai_output_policies`** — PRIMARY KEY(`scope_kind`, `scope_id`)

| Cột | Ghi chú |
|---|---|
| `mode` | `off` (mặc định) \| `log` \| `block` |
| `detectors_json` | xem dưới |
| `replacement_text` | tối đa 1.000 ký tự |
| `fail_mode` | `allow` (mặc định) \| `block` khi bộ kiểm tra ngoài lỗi |
| `bypass_roles_json` | danh sách role |
| `hold_chars`, `max_delay_ms` | mặc định 200, 300; trần 2.000 và 2.000 |
| `revision`, `updated_by`, `updated_at` | |

```json
{
  "keywords": { "enabled": true, "terms": ["…"] },
  "patterns": { "enabled": false, "rules": [{ "id": "r1", "name": "…", "pattern": "…", "flags": "i" }] },
  "promptLeak": { "enabled": true, "minShingles": 2 },
  "pii": { "enabled": true, "action": "mask" },
  "maxLength": { "enabled": false, "chars": 20000 },
  "moderation": { "enabled": false },
  "judge": { "enabled": false, "model": "auto", "criteria": "…" }
}
```

Giới hạn: 200 từ khóa, mỗi từ 80 ký tự; 20 mẫu, mỗi mẫu 200 ký tự và phải chạy dưới 5 ms trên chuỗi thử 10.000 ký tự khi lưu.

**`custom_ai_guard_events`**

`id`, `scope_kind`, `scope_id`, `end_user` NULL, `detector`, `action` (`logged` \| `blocked` \| `masked` \| `bypassed` \| `check_failed`), `wire`, `streamed`, `run_id` NULL, `excerpt_ciphertext`/`iv`/`tag` NULL, `excerpt_expires_at`, `created_at`. Trích đoạn tối đa 500 ký tự quanh vị trí khớp. Tác vụ dọn xóa trích đoạn hết hạn (7 ngày) và sự kiện quá 90 ngày.

## 4. Tri thức ngữ nghĩa — `20261113_130000_custom_ai_retrieval.ts`

**`custom_ai_retrieval_settings`** — PRIMARY KEY(`scope_kind`, `scope_id`)

`mode` (`keyword` mặc định \| `semantic` \| `hybrid`), `embedding_model` NULL (rỗng là mặc định của gateway), `dimensions` (mặc định 768), `top_k` (mặc định 5, tối đa 20), `min_score` (0–1, mặc định 0.25), `max_chars` NULL (rỗng thì dùng `kb_max_chars` hiện có), `citations` INTEGER 0/1, `index_generation` INTEGER (tăng mỗi khi chỉ mục đổi, dùng để làm mới bộ nhớ), `revision`.

**`custom_ai_embeddings`** — PRIMARY KEY(`scope_kind`, `scope_id`, `chunk_ref`)

| Cột | Ghi chú |
|---|---|
| `chunk_ref` | profile: id của `custom_knowledge_chunks`; support: `<docId>#<ord>` |
| `doc_ref` | id tài liệu, để xóa theo tài liệu |
| `content_hash` | SHA-256 của văn bản đoạn |
| `model`, `dims` | model đã dùng |
| `vector` | BLOB Float32 little-endian, đã chuẩn hóa độ dài; NULL khi chưa xong |
| `status` | `pending` \| `ready` \| `error` |
| `error`, `updated_at` | |

Đoạn chỉ được dùng cho tìm ngữ nghĩa khi `status = 'ready'`, `model` và `dims` khớp cấu hình, và `content_hash` khớp văn bản hiện tại. Xóa/sửa tài liệu xóa hàng tương ứng trong cùng giao dịch với thay đổi tài liệu (profile) hoặc ngay trong lời gọi lưu (support), rồi tăng `index_generation` (FR-023).

**`custom_ai_index_jobs`**: `id`, `scope_kind`, `scope_id`, `reason` (`doc_changed` \| `model_changed` \| `manual`), `status` (`queued` \| `running` \| `done` \| `error`), `total`, `done`, `error`, `created_at`, `finished_at`. Tối đa một job `queued|running` cho mỗi phạm vi.

**`custom_ai_embedding_usage_daily`**: PRIMARY KEY(`day`, `scope_kind`, `scope_id`, `purpose`) với `purpose` = `index` \| `query`; `requests`, `inputs`, `tokens`.

## 5. Cache prompt — `20261113_140000_custom_ai_prompt_cache.ts`

**Cấu hình** — `settings`, khóa `ai_platform_prompt_cache_v1`: `{ "forward": true, "autoBreakpoints": false, "preferStickyRoute": false }`.

**`custom_ai_cache_capabilities`** — PRIMARY KEY(`platform`, `model_pattern`, `source`)

`mode` (`explicit` \| `implicit` \| `none`), `max_breakpoints` (mặc định 4), `min_tokens`, `ttl_seconds`, `source` (`builtin` \| `override`), `updated_at`. Tra cứu: hàng `override` thắng `builtin`; trong cùng nguồn, mẫu dài nhất khớp thắng; không khớp là `none`.

**`custom_ai_cache_usage_daily`** — PRIMARY KEY(`day`, `profile_id`, `platform`, `model`)

`requests`, `requests_with_hit`, `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `est_saved_micro_usd`. `profile_id = 0` cho lưu lượng không qua client key.

## 6. Chỉ dẫn có phiên bản — `20261113_150000_custom_ai_prompt_versions.ts`

**`custom_ai_prompt_versions`** — UNIQUE(`scope_kind`, `scope_id`, `version`); hàng không bao giờ được cập nhật ngoài `status`.

`version` INTEGER tăng dần theo phạm vi, `body` TEXT (tối đa như `MAX_PROMPT_LEN` hiện có), `variables_json` (`[{ "name", "source": "system"|"caller"|"custom", "default" }]`), `note` (tối đa 500), `status` (`draft` \| `published` \| `archived`), `restored_from` NULL, `author_id`, `created_at`.

**`custom_ai_prompt_heads`** — PRIMARY KEY(`scope_kind`, `scope_id`): `published_version` NULL, `draft_version` NULL, `revision`.

Bất biến: mỗi phạm vi có nhiều nhất một `published` và một `draft`. Phát hành: trong một giao dịch, bản `published` cũ → `archived`, nháp → `published`, cập nhật head, ghi `body` vào cột hiện có (`client_profiles.system_prompt` hoặc `systemPrompt` của tenant). Khôi phục bản N: tạo phiên bản mới sao chép `body` của N với `restored_from = N`, rồi phát hành. Giữ 50 phiên bản gần nhất mỗi phạm vi; bản `published` không bao giờ bị dọn.

Di trú `up`: với mỗi `client_profiles.system_prompt` khác rỗng và mỗi tenant có `systemPrompt`, tạo phiên bản 1 `published` và head. `down`: xóa hai bảng; cột hiện có vẫn giữ văn bản đang phát hành.

Biến hệ thống: `date` (YYYY-MM-DD, UTC), `profile_name`, `end_user_id`, `end_user_name`, `language`. Tên biến: `^[a-z][a-z0-9_]{0,31}$`.

## 7. Điều phối — `20261113_160000_custom_ai_orchestrator.ts`

**`custom_ai_agents`**: `slug` UNIQUE, `name`, `description`, `model` (id model, `auto`, `fusion`, hoặc tên combo), `knowledge_scope_kind`/`knowledge_scope_id` NULL (dùng bộ tri thức của một client key hoặc tenant), `output_policy_scope` NULL, `max_output_tokens` NULL, `enabled`, `revision`. Chỉ dẫn của agent là phạm vi `('agent', id)` trong bảng phiên bản chỉ dẫn; công cụ là `custom_ai_tool_bindings` với phạm vi `agent`.

**`custom_ai_flows`**: `slug` UNIQUE (`^[a-z0-9-]{1,48}$`, gọi bằng `flow:<slug>`), `name`, `description`, `draft_json`, `published_json` NULL, `published_version` INTEGER, `enabled`, `revision`.

Định nghĩa (`draft_json` / `published_json`):

```json
{
  "kind": "single" | "handoff",
  "entryAgent": "triage",
  "agents": ["triage", "billing", "tech"],
  "handoffs": { "triage": ["billing", "tech"], "billing": ["triage"], "tech": [] },
  "limits": { "maxSteps": 12, "maxToolCalls": 20, "maxHandoffs": 4, "maxTokens": 60000, "maxSeconds": 120 },
  "awaitingApprovalText": "…",
  "approvalTtlHours": 24
}
```

Kiểm tra khi lưu: mọi agent tồn tại và `enabled`; `entryAgent` thuộc `agents`; `handoffs` chỉ trỏ tới agent trong `agents`; giới hạn trong trần cứng (50 bước, 100 lời gọi công cụ, 10 chuyển giao, 500.000 token, 600 giây). Phát hành chụp lại định nghĩa cùng số phiên bản chỉ dẫn đang phát hành của từng agent, để lần chạy tái lập được.

**`custom_ai_flow_grants`**: PRIMARY KEY(`flow_id`, `profile_id`).

**`custom_ai_runs`**: `id` TEXT (`run_<uuid>`), `flow_id`, `flow_version`, `profile_id`, `end_user` NULL, `wire`, `status`, `stop_reason` NULL, `steps`, `tool_calls`, `handoffs`, `prompt_tokens`, `completion_tokens`, `final_text_masked` NULL, `error` NULL, `started_at`, `finished_at` NULL. Chỉ mục (`profile_id`, `started_at`), (`status`).

Trạng thái:

```text
running ──► completed
   │  ├──► stopped   (stop_reason: max_steps | max_tool_calls | max_handoffs | max_tokens | max_seconds | loop_detected | quota_exhausted)
   │  ├──► cancelled (người gọi ngắt hoặc quản trị viên hủy)
   │  ├──► failed
   │  └──► awaiting_approval ──► running (duyệt) | completed (từ chối, có giải thích) | stopped (expired)
   └──► interrupted (khởi động lại khi đang running)
```

**`custom_ai_run_steps`** — PRIMARY KEY(`run_id`, `seq`): `kind` (`model` \| `tool` \| `handoff` \| `approval` \| `guard` \| `stop`), `agent_slug`, `model` NULL, `tool_name` NULL, `input_masked`, `output_masked` (mỗi cột cắt 8 KB), `prompt_tokens`, `completion_tokens`, `duration_ms`, `status` (`ok` \| `error` \| `skipped`), `error` NULL, `created_at`. Dọn cùng lần chạy sau 30 ngày (cấu hình ở `settings`, khóa `ai_platform_retention_v1`).

## Quan hệ

```text
client_profiles ─┬─ custom_ai_prompt_heads ── custom_ai_prompt_versions
                 ├─ custom_ai_retrieval_settings ── custom_ai_embeddings ── custom_knowledge_chunks
                 ├─ custom_ai_output_policies ── custom_ai_guard_events
                 ├─ custom_ai_tool_bindings ── custom_ai_mcp_tools ── custom_ai_mcp_servers
                 └─ custom_ai_flow_grants ── custom_ai_flows ··(json)·· custom_ai_agents
custom_ai_runs ── custom_ai_run_steps
      └────────── custom_ai_approvals ── custom_ai_tool_calls
```

Xóa client key hoặc tenant phải xóa các hàng theo phạm vi tương ứng (thực hiện trong module, gọi từ router xóa hiện có qua một hàm `purgeScope(kind, id)`; với client profile, cần xác minh có thể móc bằng trigger SQL thay vì sửa `routes/client-profiles.ts` — T030).
