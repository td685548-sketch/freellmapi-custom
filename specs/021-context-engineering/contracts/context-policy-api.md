# Contract: API quản trị chính sách ngữ cảnh

Tất cả endpoint nằm dưới phiên dashboard (cookie phiên), trả JSON. Lỗi dùng dạng hiện có của dashboard: `{ "error": "<message>", "code": "<code>" }`. Mọi request ghi được `auditMiddleware` ghi lại (FR-033). Router mới: `server/src/routes/context-policy.ts`, gắn trong `server/src/custom/register.ts`.

Kiểu dữ liệu nằm ở `shared/context-budget.ts`.

## 1. Chính sách của một client key

### `GET /api/client-profiles/:id/context-policy`

Quyền: `view_client_profiles`.

**200**

```json
{
  "policy": {
    "enabled": true,
    "inherited": false,
    "preset": "balanced",
    "maxInputTokens": 16000,
    "outputReserveTokens": 1024,
    "safetyMarginPct": 10,
    "summarySharePct": 15,
    "knowledgeSharePct": 25,
    "dropBlockTurns": 4,
    "summarize": true,
    "clientHistoryMode": "passthrough",
    "knowledgeMinScore": null,
    "updatedAt": "2026-11-17T08:00:00.000Z"
  },
  "suggested": null,
  "presets": { "saver": { "...": "..." }, "balanced": { "...": "..." }, "max_context": { "...": "..." } },
  "limits": { "minMaxInputTokens": 2000, "maxMaxInputTokens": 1000000, "...": "..." }
}
```

- `inherited: true` khi key chưa có dòng riêng; `policy` khi đó là mặc định hệ thống đã giải quyết.
- `suggested`: chỉ khác null khi `inherited: true` và key đang bật hội thoại phía server. Chứa giá trị quy đổi từ `conv_max_chars`/`conv_summarize` ([data-model.md](../data-model.md) mục 1).

**404** `profile_not_found`.

### `PUT /api/client-profiles/:id/context-policy`

Quyền: `edit_client_profiles`.

Body (mọi trường tùy chọn; `preset` khác `custom` sẽ ghi đè các trường số bằng giá trị của mức đặt sẵn):

```json
{
  "enabled": true,
  "preset": "custom",
  "maxInputTokens": 12000,
  "outputReserveTokens": 1024,
  "safetyMarginPct": 10,
  "summarySharePct": 15,
  "knowledgeSharePct": 25,
  "dropBlockTurns": 4,
  "summarize": true,
  "clientHistoryMode": "trim_on_overflow",
  "knowledgeMinScore": null
}
```

**200**: như `GET`.

**400**:
- `context_policy_invalid`: sai kiểu, ngoài giới hạn, có trường lạ.
- `context_policy_budget_too_small`: `maxInputTokens` < 2.000.
- `context_policy_shares_too_large`: `summarySharePct + knowledgeSharePct` > 80.
- `context_policy_preset_mismatch`: gửi trường số khác giá trị của `preset` không phải `custom`.

### `DELETE /api/client-profiles/:id/context-policy`

Quyền: `edit_client_profiles`. Xóa dòng riêng, key quay về kế thừa mặc định. **204**.

## 2. Thống kê theo key (FR-032)

### `GET /api/client-profiles/:id/context-stats?days=7`

Quyền: `view_client_profiles`. `days` ∈ [1, 90], mặc định 7.

**200**

```json
{
  "days": 7,
  "requests": 1240,
  "avgInputTokens": 6120,
  "avgBudgetTokens": 14400,
  "trimmedRate": 0.37,
  "avgHistoryDropped": 11.2,
  "savedTokens": 4180000,
  "summaryUsedRate": 0.52,
  "estimateError": { "samples": 980, "p50Pct": 4.1, "p95Pct": 12.7, "within15PctRate": 0.96 },
  "byDay": [{ "day": "2026-11-17", "requests": 180, "avgInputTokens": 6050, "trimmedRate": 0.35 }]
}
```

- `savedTokens` = tổng (token của các phần đã bỏ), tức số token lẽ ra gửi đi nếu gửi toàn bộ lịch sử ứng viên.
- `estimateError` chỉ tính các dòng có usage thật của nhà cung cấp ([research.md R4](../research.md#r4-ước-lượng-token)).

## 3. Xem trước ngữ cảnh (FR-031)

### `GET /api/client-profiles/:id/conversations/:conversationId/context-preview?model=<platform:model>&endUser=<id>`

Quyền: `edit_client_profiles`, vì kết quả chứa nội dung hội thoại (`server/src/custom/permission-actions.ts`, quy tắc đọc nội dung). Không gọi nhà cung cấp, không ghi gì.

- `model` tùy chọn. Không có thì dùng cửa sổ lớn nhất trong các model key được phép dùng hiện đang khả dụng.
- Lượt "kế tiếp" được giả lập bằng một tin người dùng rỗng; phần bắt buộc chỉ gồm prompt ép của key (nếu có).

**200**

```json
{
  "model": { "key": "google:gemini-2.5-flash", "contextWindow": 1048576 },
  "budget": { "effective": 14400, "mandatory": 310, "summaryCap": 2113, "knowledgeCap": 0, "historyCap": 11977 },
  "segments": [
    { "kind": "mandatory", "role": "system", "tokens": 310, "preview": "Bạn là trợ lý…", "sent": true },
    { "kind": "summary", "role": "system", "tokens": 402, "preview": "Khách tên An, đơn #A123…", "sent": true },
    { "kind": "history", "role": "user", "tokens": 120, "messageId": 9812, "preview": "…", "sent": false, "reason": "budget" },
    { "kind": "history", "role": "assistant", "tokens": 260, "messageId": 9813, "preview": "…", "sent": true }
  ],
  "summary": { "coversThroughMessageId": 9790, "pendingFoldMessages": 22 },
  "knowledgeNote": "Tri thức phụ thuộc câu hỏi thật nên không được giả lập trong xem trước."
}
```

- `preview`: tối đa 200 ký tự đầu của mỗi phần.
- `reason` ∈ `budget` | `block_alignment` | `leading_assistant` | `max_messages`.

**404** `conversation_not_found`; **409** `context_policy_disabled` (key không bật chính sách).

## 4. Mặc định hệ thống

### `GET /api/settings/context-policy` · `PUT /api/settings/context-policy`

Quyền: `view_settings` / `edit_settings` (thêm `'context-policy'` vào danh sách tên cài đặt trong `permission-actions.ts`).

Body/Response:

```json
{ "enabled": false, "preset": "balanced", "fallbackWindowTokens": 8192, "imageTokens": 765 }
```

**400** `context_policy_invalid`.
