# Contract: Siêu dữ liệu và lỗi trên các endpoint `/v1`

Áp dụng cho request dùng client key (`sk-cp-…`) có chính sách ngữ cảnh **bật**, trên bốn surface: `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, và Gemini `/v1beta/models/*:generateContent` / `:streamGenerateContent` (đi qua `lib/inbound-chat.ts`). Giả lập Ollama dưới `/api` cũng đi qua `lib/inbound-chat.ts` nhưng không qua bước nhận diện client key, nên nằm ngoài phạm vi (móc là no-op). MCP takeover, Flow và câu trả lời nhanh cũng nằm ngoài phạm vi (spec Assumptions). Khi chính sách tắt, không header nào dưới đây xuất hiện và thân phản hồi không đổi (FR-002).

## 1. Header phản hồi `X-FreeLLM-Context` (FR-029)

Một dòng `khóa=giá-trị` cách nhau bằng `;`, theo kiểu `X-FreeLLM-Compress`. Được đặt trước khi gửi header (với stream: trước payload đầu tiên, vì surface giữ header tới lúc đó).

```text
X-FreeLLM-Context: budget=14400;mandatory=310;summary=402;knowledge=1180;history=8840;hist_sent=18;hist_dropped=24;kb_sent=3;kb_dropped=0;client_dropped=0;refits=1;window=32768
```

| Khóa | Kiểu | Ý nghĩa |
|---|---|---|
| `budget` | số | Ngân sách hiệu lực cho model đã phục vụ |
| `window` | số \| `unknown` | Cửa sổ ngữ cảnh của model đó |
| `mandatory`, `summary`, `knowledge`, `history` | số | Token ước lượng của từng phần đã gửi |
| `hist_sent`, `hist_dropped` | số | Tin lịch sử phía server đã gửi / đã bỏ |
| `kb_sent`, `kb_dropped` | số | Đoạn tri thức đã gửi / đã bỏ |
| `client_dropped` | số | Tin do client gửi đã bỏ (US5); 0 ở chế độ `passthrough` |
| `refits` | số | Số lần khớp lại do đổi model trong request này |

Quy tắc:
- Thứ tự khóa cố định như bảng trên; client không được phụ thuộc vào thứ tự.
- Header phản ánh **lượt dispatch cuối cùng** trước khi gửi header; với stream, một lượt fallback sau khi đã commit không cập nhật header.
- Không bao giờ chứa nội dung tin nhắn.

Header hiện có vẫn giữ nguyên: `X-Conversation-Id`, `X-Conversation-History` (từ khi bật chính sách, giá trị này là **số tin lịch sử thực sự đã gửi** chứ không phải số đã nạp), `X-Conversation-Summary`.

## 2. Lỗi `context_budget_exceeded` (FR-011)

Trả ở gate, trước khi định tuyến, khi phần bắt buộc vượt **ngân sách tạm ở gate**: ngân sách của key, hoặc ngân sách theo cửa sổ lớn nhất mà key dùng được nếu nhỏ hơn ([research.md R7](../research.md#r7-chia-ngân-sách-giữa-các-phần)). Tức là không model khả dụng nào chứa nổi phần bắt buộc trong giới hạn của key.

- HTTP **400**.
- Thân theo định dạng lỗi của từng giao thức:

Chat completions / Responses:

```json
{
  "error": {
    "message": "The required context (system instructions and the new message) is about 21000 tokens, over this key's context budget of 16000 tokens.",
    "type": "invalid_request_error",
    "code": "context_budget_exceeded",
    "param": "messages"
  }
}
```

Messages (Anthropic):

```json
{
  "type": "error",
  "error": { "type": "invalid_request_error", "message": "The required context … over this key's context budget of 16000 tokens." }
}
```

Gemini (theo dạng lỗi Google API mà `routes/gemini.ts` đang dùng):

```json
{
  "error": { "code": 400, "message": "The required context … over this key's context budget of 16000 tokens.", "status": "INVALID_ARGUMENT" }
}
```

Header kèm theo: `X-FreeLLM-Context: budget=16000;mandatory=21000`. `budget` ở đây là ngân sách tạm ở gate ([research.md R7](../research.md#r7-chia-ngân-sách-giữa-các-phần)).

Khi phần bắt buộc vừa ngân sách của key nhưng không vừa **mọi** model khả dụng, vòng fallback trả lỗi `context_too_large` hiện có (không đổi định dạng).

## 3. Header yêu cầu

Không có header yêu cầu mới. Header `X-Conversation-Id`, `X-End-User` giữ nguyên ý nghĩa. Client không thể bật/tắt chính sách qua header; chỉ quản trị viên cấu hình được (tránh để client vượt trần chi phí).

## 4. Báo cáo trong nhật ký yêu cầu (FR-030)

`GET /api/client-profiles/:id/requests/:requestId/context` (quyền `view_client_profiles`) trả dòng `custom_context_reports` của request đó dưới dạng `ContextAssemblySummary` (cùng các trường như header, thêm `estimatedTokens`, `heuristicTokens`, `modelKey`, `createdAt`). **404** `context_report_not_found` khi request không có báo cáo (chính sách tắt lúc đó, hoặc báo cáo đã bị dọn).
