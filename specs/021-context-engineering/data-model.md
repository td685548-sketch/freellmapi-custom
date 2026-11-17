# Data Model: Lắp ráp ngữ cảnh có ngân sách token

**Feature**: [spec.md](spec.md) · **Research**: [research.md](research.md)

Mọi thay đổi lược đồ nằm trong **một migration mới** `server/src/db/migrations/20261117_100000_custom_context_budget.ts` (đảo ngược được; đăng ký trong `server/src/db/migrate/defaults.ts`). Không sửa migration cũ, không thêm cột vào bảng upstream.

## 1. ContextPolicy (bảng mới `custom_context_policies`)

Một dòng cho mỗi client key đã có chính sách riêng. Không có dòng nghĩa là key kế thừa mặc định hệ thống (mục 2).

| Cột | Kiểu | Ràng buộc / mặc định | Ý nghĩa |
|---|---|---|---|
| `profile_id` | INTEGER | PRIMARY KEY | Id của `client_profiles` |
| `enabled` | INTEGER | NOT NULL, 0/1 | Bật chính sách (FR-001) |
| `preset` | TEXT | NOT NULL, `saver` \| `balanced` \| `max_context` \| `custom` | Mức đặt sẵn (FR-003) |
| `max_input_tokens` | INTEGER | NULL = không trần; 2.000–1.000.000 | Ngân sách đầu vào tối đa |
| `output_reserve_tokens` | INTEGER | NOT NULL, 128–32.768 | Phần dành cho câu trả lời khi client không gửi `max_tokens` |
| `safety_margin_pct` | INTEGER | NOT NULL, 0–30 | Biên an toàn |
| `summary_share_pct` | INTEGER | NOT NULL, 0–60 | Trần tóm tắt theo % phần còn lại |
| `knowledge_share_pct` | INTEGER | NOT NULL, 0–60 | Trần tri thức theo % phần còn lại |
| `drop_block_turns` | INTEGER | NOT NULL, 1–16 | Kích thước khối bỏ lịch sử |
| `summarize` | INTEGER | NOT NULL, 0/1 | Tóm tắt theo áp lực ngân sách |
| `client_history_mode` | TEXT | NOT NULL, `passthrough` \| `trim_on_overflow` \| `enforce_budget` | Chế độ lịch sử do client gửi (FR-027) |
| `knowledge_min_score` | REAL | NULL = tắt; 0–1 | Ngưỡng tuyệt đối cho truy hồi ngữ nghĩa |
| `updated_at` | TEXT | NOT NULL | Thời điểm sửa |

**Validation**:
- `summary_share_pct + knowledge_share_pct ≤ 80`.
- Với `preset ≠ custom`, các cột số được ghi đúng giá trị của mức đặt sẵn ([research.md R8](research.md#r8-mức-đặt-sẵn)); API từ chối giá trị lệch kèm `preset` khác `custom`.
- `max_input_tokens` nhỏ hơn 2.000 bị từ chối (`context_policy_budget_too_small`).

**Quan hệ**: 1–0..1 với `client_profiles`. Dòng mồ côi (key đã xóa) bị dọn trong chu kỳ dọn dẹp mỗi giờ.

**Chuyển đổi khi bật lần đầu (FR-004)**: API `GET` trả thêm `suggested` cho key chưa có dòng, tính từ cài đặt hội thoại hiện có: `max_input_tokens ≈ conv_max_chars / 3,2` (làm tròn lên bội 1.000, tối thiểu 2.000), `summarize = conv_summarize`. `conv_max_messages` vẫn là trần số tin cho tập ứng viên lịch sử.

## 2. ContextPolicyDefault (bảng `settings`, khóa `context_policy_default`)

JSON:

```json
{ "enabled": false, "preset": "balanced", "fallbackWindowTokens": 8192, "imageTokens": 765 }
```

- `enabled`, `preset`: áp cho key không có dòng `custom_context_policies`.
- `fallbackWindowTokens` (1.024–1.000.000): cửa sổ dùng khi cả cửa sổ model lẫn `max_input_tokens` đều không có.
- `imageTokens` (85–4.096): số token ước lượng cho mỗi khối ảnh.

## 3. Cột mới trên `custom_conversations`

| Cột | Kiểu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `context_window_start_id` | INTEGER | NULL | Id tin lịch sử cũ nhất đã thực sự được gửi ở lượt thành công gần nhất. NULL = chưa có lượt nào chạy với chính sách bật. Dùng làm ranh giới gộp tóm tắt (FR-017) |

`custom_conversations` là bảng custom (migration `20261107_000004_custom_profile_conversations.ts`), nên thêm cột bằng migration mới là hợp lệ.

**Chuyển trạng thái của một lượt** (đã có `summarized_through`):

```text
stored ── (rơi khỏi cửa sổ: id < context_window_start_id) ──► foldable
foldable ── (gộp tóm tắt thành công: summarized_through ≥ id) ──► summarized
summarized ── (dọn lưu trữ hiện có) ──► có thể bị xóa khỏi lưu trữ
```

Một lượt chỉ chuyển sang `summarized` một lần vì `summarized_through` chỉ tăng.

## 4. ContextAssemblyReport (bảng mới `custom_context_reports`)

| Cột | Kiểu | Ràng buộc | Ý nghĩa |
|---|---|---|---|
| `request_id` | INTEGER | PRIMARY KEY | Id dòng `requests` cuối của request (lấy từ attempt trace) |
| `profile_id` | INTEGER | NOT NULL | Client key |
| `end_user` | TEXT | NULL | End user (nếu có) |
| `conversation_key` | TEXT | NULL | `X-Conversation-Id` (nếu có) |
| `model_key` | TEXT | NOT NULL | `platform:model` đã phục vụ |
| `context_window` | INTEGER | NULL | Cửa sổ của model đó |
| `budget_tokens` | INTEGER | NOT NULL | Ngân sách hiệu lực |
| `mandatory_tokens` | INTEGER | NOT NULL | Phần bắt buộc |
| `summary_tokens` | INTEGER | NOT NULL | Tóm tắt đã gửi |
| `knowledge_tokens` | INTEGER | NOT NULL | Tri thức đã gửi |
| `history_tokens` | INTEGER | NOT NULL | Lịch sử đã gửi |
| `estimated_tokens` | INTEGER | NOT NULL | Tổng ước lượng của bộ ước lượng mới |
| `heuristic_tokens` | INTEGER | NOT NULL | Ước lượng ký tự/4 mà surface sẽ ghi khi thiếu usage (để lọc khi đo sai số, R4) |
| `history_sent` / `history_dropped` | INTEGER | NOT NULL | Số tin lịch sử đã gửi / đã bỏ |
| `knowledge_sent` / `knowledge_dropped` | INTEGER | NOT NULL | Số đoạn tri thức đã gửi / đã bỏ |
| `summary_used` | INTEGER | NOT NULL, 0/1 | Có gửi tóm tắt không |
| `client_history_dropped` | INTEGER | NOT NULL | Số tin do client gửi đã bỏ (US5) |
| `refits` | INTEGER | NOT NULL | Số lần khớp lại do đổi model trong request |
| `created_at` | TEXT | NOT NULL | Thời điểm ghi |

Index: `(profile_id, created_at)` cho thống kê theo key.

**Không lưu nội dung tin nhắn** (FR-030). Dọn: báo cáo không còn dòng `requests` tương ứng, hoặc của key đã xóa, bị xóa mỗi giờ tối đa một lần.

## 5. Thực thể trong bộ nhớ (không lưu)

### SegmentRegistry (theo request, `WeakMap<Request, …>`)

| Trường | Ý nghĩa |
|---|---|
| `policy` | ContextPolicy đã giải quyết (riêng hoặc mặc định) |
| `units[]` | Các đơn vị đã chèn ở gate: `{ kind: 'summary' \| 'knowledge' \| 'history', role, fingerprint, seq, messageId?, tokens, text? }` |
| `conversation` | `{ id, key, endUser }` khi request dùng hội thoại lưu phía server |
| `base`, `lastOutput` | Mảng gốc và mảng đã khớp gần nhất ([research.md R2](research.md#r2-điểm-móc-vào-file-upstream)) |
| `windowStartMessageId` | Id tin lịch sử cũ nhất đã gửi ở lượt gần nhất |
| `report` | ContextAssemblyReport đang dựng |

### ContextSegment (kết quả phân loại ở giai đoạn 2)

`{ kind: 'mandatory' | 'summary' | 'knowledge' | 'history' | 'client_history', indexes: number[], tokens, seq, droppable }`. Một lời gọi công cụ và các kết quả `tool` theo sau thuộc cùng một segment.

### CalibrationState (theo nền tảng, trong bộ nhớ)

`Map<platform, { factor: number; samples: number }>`, EMA α = 0,1, kẹp [0,75; 1,6]. Mất khi khởi động lại (chấp nhận được, R4).

## 6. Kiểu dùng chung (`shared/context-budget.ts`, mới)

`ContextPolicy`, `ContextPolicyInput`, `ContextPolicyDefault`, `ContextPreset`, `ClientHistoryMode`, `CONTEXT_PRESETS`, `CONTEXT_POLICY_LIMITS`, `ContextAssemblySummary` (dạng trả về cho header, xem trước và thống kê), `ContextStats`. Theo Hiến pháp nguyên tắc II, client và server dùng chung các kiểu này.
