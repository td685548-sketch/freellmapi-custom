# Contract: Bổ sung trên bề mặt suy luận

Nguyên tắc: không có trường hay header bắt buộc mới. Client không biết các bổ sung này tiếp tục chạy đúng. Khi trụ cột tương ứng tắt, không header hay trường nào dưới đây xuất hiện và thân trả lời giống hệt bản trước từng byte.

Giao thức áp dụng: `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/responses`, `POST /v1beta/models/{model}:generateContent` và `:streamGenerateContent`, cùng các đường tương ứng dưới `/thruline/v1` nếu đi qua cùng cổng (xác minh ở T016).

## Thứ tự xử lý cố định (FR-008)

```text
 1. xác thực, hạn chế model, hạn mức                  (hiện có)
 2. lọc nội dung đầu vào                               (hiện có)
 3. hội thoại lưu phía server, trả lời nhanh           (hiện có)
 4. nhận diện flow:<slug>  ──► điều phối tiếp quản (bước 5–8 chạy cho từng agent)
 5. chỉ dẫn hệ thống: thay biến                        (prompts)
 6. tri thức: tìm và chèn                              (retrieval)
 7. công cụ MCP: gắn định nghĩa; vòng lặp phía server  (mcpClient)
 8. điểm đánh dấu cache theo nhà cung cấp, mỗi lần thử (promptCache)
 9. gọi model                                          (hiện có)
10. câu trả lời: thống kê cache → trích dẫn → kiểm soát đầu ra
```

## Header yêu cầu (tùy chọn)

| Header | Trụ cột | Ý nghĩa |
|---|---|---|
| `x-freellm-vars` | prompts | JSON phẳng `{ "tên": "giá trị" }`, tối đa 2 KB. Chỉ nhận tên đã khai báo với nguồn `caller`; giá trị cắt 200 ký tự. Sai định dạng thì bỏ qua, không lỗi. |
| `x-freellm-citations: off` | retrieval | Tắt trích dẫn cho yêu cầu này. |
| `x-freellm-tools: off` | mcpClient | Không gắn công cụ MCP cho yêu cầu này. |

Header `x-ai-platform-internal` là nội bộ; yêu cầu từ ngoài mang header này bị loại header trước khi xử lý.

## Header trả lời (tùy chọn)

| Header | Khi nào | Nội dung |
|---|---|---|
| `x-freellm-citations` | có dùng tri thức và bật trích dẫn | base64url của JSON `[{ "doc": string, "chunk": number, "score": number }]`, tối đa 4 KB, cắt bớt từ cuối |
| `x-freellm-retrieval` | retrieval bật | `keyword` \| `semantic` \| `hybrid`, kèm `;degraded` khi đã lùi về từ khóa |
| `x-freellm-guard` | chính sách đầu ra khác `off` | `pass` \| `logged` \| `masked` \| `blocked;reason=<detector>` (với luồng, giá trị cuối cùng nằm ở sự kiện kết thúc, header chỉ là `active`) |
| `x-freellm-tool-rounds` | vòng lặp công cụ đã chạy | số vòng |
| `x-freellm-tools-skipped` | model được chọn không hỗ trợ công cụ | `unsupported_model` |
| `x-freellm-run-id` | yêu cầu chạy quy trình | `run_<uuid>` |
| `x-freellm-run-status` | như trên | `completed` \| `stopped;reason=…` \| `awaiting_approval` |

## Thân trả lời

- **Trích dẫn**, trả lời một lần của `/v1/chat/completions` và `/v1/responses`: thêm trường gốc `"citations": [{ "doc", "chunk", "score" }]`. Hai giao thức còn lại chỉ dùng header.
- **Bị chặn, trả lời một lần**: HTTP 200, thân đúng lược đồ giao thức, nội dung là `replacement_text`, lý do kết thúc là `content_filter` (OpenAI/Responses), `stop_reason: "refusal"` (Anthropic), `finishReason: "SAFETY"` (Gemini). Trường usage giữ nguyên.
- **Bị chặn, luồng**: phần đã nhả trước đó giữ nguyên; phần đang giữ lại bị bỏ; phát một mảnh chứa `replacement_text`, rồi sự kiện kết thúc hợp lệ với lý do như trên, rồi `[DONE]` hoặc tương đương.
- **Che PII tại chỗ**: văn bản được thay bằng nhãn che hiện có; cấu trúc không đổi.
- **Vòng lặp công cụ**: người gọi chỉ thấy câu trả lời cuối. `usage` là tổng mọi vòng. Nếu model gọi công cụ do người gọi khai báo, trả lời chứa `tool_calls` đó như hiện nay và vòng lặp phía server dừng; các kết quả công cụ MCP đã có nằm trong lịch sử do server giữ cho đúng lượt này và không trả về người gọi.
- **Quy trình** (`model: "flow:<slug>"`): trả lời có `model` là `flow:<slug>`; `usage` là tổng mọi bước. Khi luồng, tiến độ gửi bằng dòng chú thích SSE `: progress {"step":3,"agent":"billing","kind":"tool"}`.
- **Chờ duyệt**: câu trả lời là `awaitingApprovalText`, kết thúc bình thường, kèm `x-freellm-run-status: awaiting_approval`.

## Lỗi mới

| HTTP | `code` | Khi nào |
|---|---|---|
| 404 | `flow_not_found` | `flow:<slug>` không tồn tại, chưa phát hành, hoặc trụ cột tắt |
| 403 | `flow_not_granted` | client key không được cấp quy trình |
| 400 | `flow_requires_client_key` | gọi quy trình bằng khóa không phải client key |

Sự cố của trụ cột tùy chọn không tạo lỗi HTTP mới: tri thức lùi về từ khóa, cache prompt bỏ điểm đánh dấu, công cụ trả lỗi có cấu trúc cho model.

## `GET /v1/ai/runs/{id}` (mới, bổ sung)

Xác thực bằng client key đã khởi tạo lần chạy; lần chạy của key khác trả 404.

```json
{
  "id": "run_…",
  "flow": "support-triage",
  "status": "running | awaiting_approval | completed | stopped | cancelled | failed | interrupted",
  "stop_reason": null,
  "output_text": "… (đã qua kiểm soát đầu ra; null khi chưa xong)",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "started_at": "…",
  "finished_at": null
}
```

Không trả các bước, tham số công cụ hay tên agent nội bộ.

## Kết quả công cụ đưa cho model

```text
<tool_result server="<slug>" tool="<name>" trust="untrusted">
…nội dung đã che và cắt…
</tool_result>
```

Lỗi công cụ: `{"error":{"type":"timeout|too_large|transport_error|tool_error|blocked|rejected","message":"…"}}`. Chờ duyệt: `{"status":"awaiting_approval","approval_id":…}` và lượt dừng.

## Bất biến tương thích (được kiểm bằng test hồi quy)

1. Mọi công tắc tắt: thân yêu cầu gửi nhà cung cấp và thân/headers trả lời giống hệt bản trước cho bộ yêu cầu mẫu trên cả bốn giao thức, cả luồng lẫn một lần.
2. `POST /mcp`, `/livez`, `/readyz`, `/api/ping`, `/v1/models`, `/v1/embeddings`, `/v1/moderations` không đổi. `/v1/models` không liệt kê `flow:*` trừ khi gọi bằng client key được cấp và trụ cột bật.
3. Khóa hợp nhất và khóa cá nhân không bị ảnh hưởng bởi các trụ cột theo client key.
