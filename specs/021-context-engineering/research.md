# Research: Lắp ráp ngữ cảnh có ngân sách token

**Feature**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-11-17

Mỗi mục gồm: quyết định, lý do, các phương án đã cân nhắc. Đường dẫn tính từ gốc repo.

## R1. Lắp ráp ở đâu trong luồng request

**Decision**: Chia làm hai giai đoạn.

1. **Thu thập (gate)**: chạy trong `server/src/middleware/profile-gate.ts`, nơi đã chèn hội thoại (`custom/conversation-inject.ts`) và tri thức (`custom/knowledge-inject.ts`, slot 6 của `custom/ai-platform/pipeline.ts`). Khi chính sách bật, các bước này chèn **ứng viên** rộng hơn (lịch sử tới trần ứng viên, tri thức tới phần ngân sách tri thức, tóm tắt) và ghi từng đơn vị vào một **sổ đăng ký phân đoạn** (segment registry) gắn với request.
2. **Khớp ngân sách (dispatch)**: chạy trong closure `dispatch` của từng surface, ngay trước khi gửi tới nhà cung cấp. Lúc này đã biết model được chọn (`route.contextWindow`) và danh sách `ChatMessage[]` cuối cùng (sau nén, sau prompt ép của key, sau context handoff). Hàm `fitContextForRoute()` bỏ dần các đơn vị ưu tiên thấp cho tới khi vừa ngân sách hiệu lực.

**Rationale**:
- Ngân sách phụ thuộc model, mà model chỉ biết sau `routeRequest()` và có thể đổi qua từng lượt fallback (FR-006, FR-010). Gate không biết model.
- Việc chèn ứng viên vẫn nằm ở gate, trong file custom, giữ nguyên cách mỗi giao thức đặt tóm tắt và tri thức (FR-016).
- Giai đoạn 2 làm việc trên `ChatMessage[]` thống nhất, nên một hàm phục vụ được cả 4 surface.

**Alternatives considered**:
- *Lắp xong ở gate theo cửa sổ model lớn nhất*: không đáp ứng FR-010; model dự phòng nhỏ hơn sẽ bị router loại.
- *Lắp trong `lib/fallback-loop.ts`*: vòng lặp không sở hữu `messages`, phải đổi chữ ký hook của file upstream dùng chung cho 4 surface. Rủi ro xung đột upstream cao hơn.
- *Lắp xong ở gate theo cửa sổ nhỏ nhất của chuỗi*: quá dè dặt; một model 4k trong chuỗi sẽ kéo mọi request xuống 4k.

## R2. Điểm móc vào file upstream

**Decision**: Đúng **2 dòng móc** cho mỗi surface có fallback loop: `routes/proxy.ts` (chat completions), `routes/anthropic.ts` (messages), `routes/responses.ts`, `lib/inbound-chat.ts` (Gemini và Ollama đi qua đây).

- **Móc R (route)**: trong closure `route`, bọc số token định tuyến: `contextRoutingTokens(req, routingTotal, messages)`. Khi chính sách tắt, hàm trả nguyên `routingTotal`. Khi bật, hàm trừ đi phần có thể bỏ (theo cùng đơn vị ký tự/4 mà router dùng), để router không loại model nhỏ mà lẽ ra thu gọn được.
- **Móc B (dispatch)**: dòng đầu tiên của closure `dispatch`, gán lại biến mảng mà surface gửi đi:
  - `routes/proxy.ts`: `outboundMessages = fitContextForRoute(req, res, outboundMessages, route, outputReserve)`, đặt sau khối context handoff và khôi phục reasoning.
  - `routes/anthropic.ts`, `routes/responses.ts`: `messages = fitContextForRoute(req, res, messages, route, outputReserve)`.
  - `lib/inbound-chat.ts`: `input.messages = fitContextForRoute(req, res, input.messages, route, outputReserve)`.

  Vì ba surface sau gán lại chính biến dùng chung cho mọi lượt fallback, hàm luôn khớp từ **bản gốc**: sổ đăng ký giữ `base` và `lastOutput`; nếu mảng truyền vào trùng `lastOutput` (lượt fallback sau) thì dùng lại `base`, nếu khác (proxy tạo mảng mới mỗi lượt) thì mảng đó thành `base` mới. Nhờ vậy chuyển từ model nhỏ sang model lớn hơn vẫn lấy lại được phần đã bỏ. Khi chính sách tắt, hàm trả nguyên tham chiếu.

**Rationale**: Hiến pháp nguyên tắc VI chỉ cho phép điểm móc tối thiểu. 8 dòng trên 4 file, mỗi dòng là một lời gọi thuần không đổi luồng khi tính năng tắt.

**Alternatives considered**: sửa `routeRequest()` trong `services/router.ts` để tự hiểu ngân sách. Bị loại vì router là file lõi lớn nhất của upstream và hay thay đổi.

## R3. Khi phần bắt buộc vẫn không vừa model được chọn

**Decision**: Móc R chỉ hạ số token định tuyến xuống **phần bắt buộc + phần dành cho câu trả lời**, nên router chỉ chọn model mà phần bắt buộc vừa. Nếu do sai lệch ước lượng mà phần bắt buộc vẫn không vừa ở giai đoạn 2, `fitContextForRoute()` ném lỗi với `providerRejection: 'request'` và thông điệp chứa "exceeds this model's context window". `recordRetryableFailure()` sẽ bỏ model đó cho request này, không cooldown và không "học" sai cửa sổ ngữ cảnh. Khi mọi model đều không vừa, vòng lặp trả lỗi `context_too_large` hiện có. Gate trả trước mã riêng `context_budget_exceeded` (HTTP 400) nếu phần bắt buộc đã vượt **ngân sách của key** (không phụ thuộc model).

**Rationale**: Tận dụng nhánh xử lý có sẵn trong `lib/fallback-loop.ts` (dòng 480 và nhánh `providerRejection`), không thêm loại lỗi mới vào upstream.

**Alternatives considered**: ném lỗi `status: 413`. Bị loại vì nhánh `isContextTooLargeError` gọi `learnContextWindowFromError()` và có thể hạ cửa sổ ngữ cảnh đã lưu của model theo ước lượng của ta.

## R4. Ước lượng token

**Decision**: Thêm bộ ước lượng riêng `server/src/custom/context-budget/estimate.ts`:
- Văn bản chia theo nhóm ký tự: ASCII ≈ 4 ký tự/token; chữ Latin có dấu (gồm tiếng Việt, U+00C0–U+024F, U+1E00–U+1EFF và dấu kết hợp) ≈ 2,5 ký tự/token; CJK, kana, hangul ≈ 1 ký tự/token; các chữ viết khác ≈ 3 ký tự/token.
- Mỗi tin nhắn cộng 4 token chi phí cấu trúc; mỗi khối ảnh cộng một mức cố định cấu hình được (mặc định 765); lời gọi công cụ tính theo tên + đối số; định nghĩa công cụ tính theo JSON.
- **Hệ số hiệu chỉnh theo nền tảng**: trung bình trượt (EMA, α = 0,1) của tỷ lệ token nhà cung cấp báo / token ước lượng, kẹp trong [0,75; 1,6], giữ trong bộ nhớ, khởi đầu 1,0.
- Biên an toàn của chính sách (mặc định 10%) cộng thêm phía trên.

Để đo sai số (SC-005) mà không sửa `lib/request-log.ts`: báo cáo lắp ráp lưu cả ước lượng của ta và ước lượng ký tự/4 mà surface sẽ ghi khi nhà cung cấp không trả usage. Dòng nào có `requests.input_tokens` đúng bằng ước lượng ký tự/4 được coi là "không có usage thật" và bị loại khỏi phép đo.

**Rationale**: Ký tự/4 (hàm `estimateInputTokens` hiện có) đánh giá thấp tiếng Việt khoảng 30–40%, trái với edge case về ngôn ngữ. Bộ đếm chính xác (tiktoken và tương tự) chỉ đúng cho một họ model; gateway phục vụ hàng chục nhà cung cấp, và thêm phụ thuộc nặng.

**Alternatives considered**: dùng `tiktoken`/`gpt-tokenizer`; giữ ký tự/4 và tăng biên an toàn. Phương án sau bị loại vì sẽ lãng phí ngân sách với tiếng Anh.

Hằng số cuối cùng được chốt bằng task hiệu chỉnh trên bộ mẫu hội thoại Anh/Việt/Trung trong `server/src/__tests__/custom/fixtures/context-budget/` (xem tasks).

## R5. Nhận diện phân đoạn sau khi request đã được dịch giao thức

**Decision**: Sổ đăng ký phân đoạn (`WeakMap<Request, SegmentRegistry>`, giống `pendingRetrievals` trong `knowledge-inject.ts`) lưu cho mỗi đơn vị: loại (`summary` | `knowledge` | `history`), vai trò, **dấu vân tay** (SHA-1 của văn bản đã chuẩn hóa bằng `contentToString`, cắt 16 ký tự hex), số thứ tự tuyệt đối (với lịch sử: id tin nhắn trong `custom_conversation_messages`), và số token. Ở giai đoạn 2, tin nhắn được ghép với đơn vị theo (vai trò, dấu vân tay). Tóm tắt và khối tri thức của giao thức Anthropic nằm trong trường `system`; sau khi dịch sang chat, chúng là một phần của tin nhắn system đầu tiên nên được ghép theo **chuỗi con** thay vì cả tin.

Tin nhắn không ghép được (vd. bộ nén đã viết lại nội dung) được coi là **do client gửi**: chỉ bị bỏ khi chế độ lịch sử do client gửi cho phép.

**Rationale**: `ChatMessage` không có trường phụ nào sống sót qua bước dịch giao thức và bước nén, nên không thể đánh dấu trực tiếp. Dấu vân tay nội dung không cần đổi code upstream.

**Alternatives considered**: chèn ký hiệu ẩn vào nội dung (gửi tới model, làm bẩn prompt và hỏng cache); ghép theo vị trí (vỡ khi bộ nén gộp hoặc xóa tin).

## R6. Thứ tự ưu tiên và bỏ theo khối

**Decision**: Phần bắt buộc gồm: mọi tin system/developer không phải đơn vị đã đăng ký (prompt ép của key, chỉ dẫn của ứng dụng, đoạn handoff), tin nhắn người dùng cuối cùng, và chuỗi gọi công cụ đứng sau tin người dùng cuối. Thứ tự bỏ khi thiếu ngân sách: lịch sử (cũ nhất trước) → tri thức (cả khối) → tóm tắt (cắt ở ranh giới câu, rồi bỏ hẳn).

Lịch sử được bỏ theo **khối** `dropBlockTurns` lượt (mặc định 4). Điểm bắt đầu cửa sổ được **neo** vào bội số của khối theo số thứ tự tuyệt đối của lượt, nên nó đứng yên qua nhiều lượt liên tiếp và chỉ nhảy một khối khi hết chỗ. Phần đầu ngữ cảnh vì vậy ổn định, giữ được cache prompt của nhà cung cấp (FR-015). Với lịch sử do client gửi, số thứ tự là chỉ số trong mảng tính từ đầu (client gửi lại từ đầu mỗi lần nên chỉ số ổn định).

Lời gọi công cụ và các kết quả `tool` theo sau nó luôn là một đơn vị (FR-014). Sau khi bỏ, nếu lượt đầu còn lại là của trợ lý thì bỏ tiếp tới lượt người dùng (giữ quy tắc của `loadHistory`).

**Rationale**: Đúng FR-012 đến FR-015. Neo theo khối là cách đơn giản nhất giữ tiền tố ổn định mà không cần biết trạng thái cache của nhà cung cấp.

**Alternatives considered**: bỏ từng lượt một (phá cache mỗi lượt); bỏ theo tỷ lệ phần trăm (khó dự đoán).

## R7. Chia ngân sách giữa các phần

**Decision**: `available = effectiveBudget − mandatory`. Trần tóm tắt = `summarySharePct × available`, trần tri thức = `knowledgeSharePct × available`, lịch sử nhận phần còn lại **cộng phần dư** chưa dùng của tóm tắt và tri thức (FR-013). Ngân sách hiệu lực = `min(maxInputTokens, contextWindow − outputReserve)` × (1 − safetyMarginPct). `maxInputTokens = null` nghĩa là chỉ theo cửa sổ model. Cửa sổ chưa biết (`null`) thì dùng `maxInputTokens`; nếu cả hai đều null thì dùng `fallbackWindowTokens` của mặc định hệ thống (mặc định 8.192).

Phần dành cho câu trả lời: `max_tokens` (hoặc tương đương) của client nếu có, không thì `outputReserveTokens` của chính sách, lấy theo `outputReserve` mà surface đã tính.

**Rationale**: Công thức đơn giản, kiểm thử được, khớp kịch bản 2 của US1.

## R8. Mức đặt sẵn

**Decision**:

| Thuộc tính | Tiết kiệm | Cân bằng | Tối đa ngữ cảnh |
|---|---|---|---|
| Ngân sách đầu vào tối đa | 8.000 | 16.000 | không trần (theo cửa sổ model) |
| Phần dành cho câu trả lời | 1.024 | 1.024 | 2.048 |
| Biên an toàn | 10% | 10% | 10% |
| Tỷ lệ tóm tắt | 15% | 15% | 10% |
| Tỷ lệ tri thức | 20% | 25% | 30% |
| Khối bỏ lịch sử | 4 lượt | 4 lượt | 8 lượt |
| Tóm tắt | bật | bật | bật |

Giới hạn khi tùy chỉnh: ngân sách 2.000–1.000.000 token; phần câu trả lời 128–32.768; biên an toàn 0–30%; mỗi tỷ lệ 0–60% và tổng hai tỷ lệ ≤ 80%; khối 1–16 lượt. Ngân sách nhỏ hơn 2.000 bị từ chối (edge case cuối của spec).

## R9. Tóm tắt kích hoạt theo áp lực ngân sách

**Decision**:
- Giai đoạn 2 ghi vào sổ đăng ký id của tin lịch sử cũ nhất **thực sự được gửi** (`windowStartMessageId`) ở lượt dispatch thành công.
- Khi lượt hoàn tất, `conversation-inject.ts` lưu giá trị này vào cột mới `custom_conversations.context_window_start_id` rồi gọi `scheduleSummary()`.
- Với hội thoại có chính sách bật, `foldableTurns()` dùng ranh giới này thay vì tính lại theo `maxMessages`/`maxChars`: các lượt có id nằm giữa `summarized_through` và `context_window_start_id` sẽ được gộp. Giữ giới hạn 16.000 ký tự mỗi lần gộp và cơ chế một-lần-một-hội-thoại (`inFlight`).
- Lời nhắc tóm tắt nhận độ dài mục tiêu theo trần tóm tắt (≈ 0,6 từ/token, tối thiểu 80 từ, tối đa 400 từ) thay cho "200 words" cố định. `max_tokens` của lời gọi tóm tắt = trần tóm tắt.
- Khi lắp, tóm tắt dài hơn trần bị cắt ở ranh giới câu gần nhất (US3 kịch bản 3).

**Rationale**: Đáp ứng FR-017/018/019 mà vẫn tái sử dụng toàn bộ cơ chế lời gọi loopback và thống kê theo key (FR-021). `summarized_through` đã đảm bảo không gộp hai lần.

**Alternatives considered**: tóm tắt đồng bộ trước khi gửi (tăng độ trễ, trái FR-020).

## R10. Tri thức trong ngân sách

**Decision**:
- Ở gate, khi chính sách bật, `injectKnowledge()` (BM25) và `injectRetrievedKnowledgeForSlot6()` (truy hồi lai) nhận `maxChars` = trần tri thức quy ra ký tự (theo hệ số ký tự/token của chính câu hỏi, lấy từ R4). Đoạn được chọn theo điểm giảm dần và giữ nguyên vẹn (hai hàm vốn đã làm vậy). Mỗi đoạn được ghi vào sổ đăng ký.
- Ngưỡng liên quan: giữ ngưỡng tương đối hiện có (25% so với đoạn tốt nhất) và thêm `knowledgeMinScore` tùy chọn cho chế độ ngữ nghĩa (cosine, mặc định null = tắt).
- Chống trùng (FR-025): bỏ đoạn có ≥ 80% shingle 5 từ đã xuất hiện trong lịch sử ứng viên hoặc tóm tắt. Kiểm tra ở gate vì lúc đó lịch sử ứng viên đã được nạp (hội thoại được áp dụng trước tri thức).
- Ở giai đoạn 2, khối tri thức chỉ bị bỏ **cả khối**, sau khi lịch sử đã hết đơn vị có thể bỏ.
- Trích dẫn (FR-026): header trích dẫn được ghi ở gate. Nếu giai đoạn 2 bỏ khối tri thức thì `fitContextForRoute()` gỡ header `x-freellm-citations` (khi header chưa gửi) và đánh dấu `knowledgeDropped` trong báo cáo, để interceptor citations bỏ qua phần trích dẫn trong thân phản hồi.

**Rationale**: Chọn theo từng đoạn ở gate là đủ cho FR-023/024. Bỏ cả khối ở giai đoạn 2 hiếm xảy ra (chỉ khi model dự phòng nhỏ) và tránh phải dựng lại định dạng khối của từng giao thức.

## R11. Lịch sử do client gửi

**Decision**: Chế độ `passthrough` (mặc định) | `trim_on_overflow` | `enforce_budget`. Ở hai chế độ thu gọn, giai đoạn 2 coi mọi tin không đăng ký và không bắt buộc là lịch sử có thể bỏ, áp R6. Với `trim_on_overflow`, ngân sách hiệu lực bỏ qua `maxInputTokens` (chỉ theo cửa sổ model); với `enforce_budget`, dùng đầy đủ công thức R7. Không tạo tóm tắt (FR-028).

Móc R cũng tính phần có thể bỏ này, nên với `trim_on_overflow` request sẽ không còn bị trả lỗi "không có model phù hợp" (US5 kịch bản 2).

## R12. Báo cáo lắp ráp, header và lưu trữ

**Decision**:
- **Header** `X-FreeLLM-Context` dạng `k=v;…` (giống `X-FreeLLM-Compress`), đặt ở giai đoạn 2 trước khi header được gửi. Với stream, header được giữ tới payload đầu tiên nên vẫn kịp. Đặc tả trong [contracts/context-metadata.md](contracts/context-metadata.md).
- **Lưu trữ**: bảng mới `custom_context_reports`, khóa bằng id dòng `requests`. Ở giai đoạn 2, hàm giữ tham chiếu `getRequestTrace()` (AsyncLocalStorage của fallback loop); khi `res` phát `finish`, `setImmediate` đọc `trace.lastRequestRowId` và ghi báo cáo. Không cần sửa `lib/request-log.ts`.
- **Dọn dẹp**: mỗi giờ tối đa một lần (giống `maybePruneConversations`), xóa báo cáo không còn dòng `requests` tương ứng hoặc cũ hơn thời hạn lưu request.
- **Thống kê** (FR-032): truy vấn tổng hợp trên `custom_context_reports` join `requests` theo `profile_id` và khoảng ngày.

**Alternatives considered**: thêm cột JSON vào `requests` (bảng upstream, migration upstream hay đổi); trigger `ON DELETE` (trigger mới phải khai báo thêm cho bộ đệm đọc của Turso, xem 018 T140).

## R13. Lưu chính sách và mặc định hệ thống

**Decision**:
- Bảng mới `custom_context_policies` (một dòng mỗi client key, khóa `profile_id`). Không có dòng nghĩa là **kế thừa mặc định hệ thống**.
- Mặc định hệ thống lưu trong bảng `settings` hiện có, khóa `context_policy_default` (JSON), mặc định `{ enabled: false, preset: 'balanced', fallbackWindowTokens: 8192 }`.
- Chính sách được đọc qua bộ đệm trong bộ nhớ theo `profile_id`, xóa khi ghi.
- Xóa client key thì xóa chính sách và báo cáo của key (dọn trong cùng chu kỳ dọn dẹp, giống cách xử lý hội thoại mồ côi).

**Rationale**: Hiến pháp nguyên tắc VI: bảng mới, migration mới, không thêm cột vào `client_profiles`.

## R14. Phân quyền và audit

**Decision**: Tái sử dụng quyền hiện có (spec FR-033 đã cập nhật):
- `GET /api/client-profiles/:id/context-policy` và `.../context-stats` → `view_client_profiles` (đã khớp quy tắc `startsWith('/api/client-profiles')`).
- `PUT .../context-policy` → `edit_client_profiles`.
- `GET .../conversations/:conv/context-preview` → `edit_client_profiles`: mở rộng regex đọc nội dung ở `custom/permission-actions.ts` dòng 122.
- `GET/PUT /api/settings/context-policy` (mặc định hệ thống) → `view_settings`/`edit_settings`: thêm `'context-policy'` vào danh sách tên ở dòng 128.
- Audit: `auditMiddleware` hiện có tự ghi mọi request ghi dưới `/api`.

## R15. Tương thích ngược

**Decision**: Khi chính sách tắt (mặc định), móc R trả nguyên số, móc B trả nguyên tham chiếu mảng, gate không đổi tham số gọi `loadHistory`/`injectKnowledge`, không đặt header mới. Kiểm thử hồi quy so sánh byte của thân request gửi đi trước và sau (SC-006). Cột mới `context_window_start_id` có giá trị mặc định NULL và chỉ được đọc khi chính sách bật.
