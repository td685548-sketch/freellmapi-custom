# Quickstart: Kiểm chứng lắp ráp ngữ cảnh có ngân sách token

Hướng dẫn chạy để chứng minh tính năng hoạt động từ đầu đến cuối. Chi tiết API ở [contracts/context-policy-api.md](contracts/context-policy-api.md), header và lỗi ở [contracts/context-metadata.md](contracts/context-metadata.md), dữ liệu ở [data-model.md](data-model.md).

## 0. Chuẩn bị

```bash
npm install
```

```bash
npm run dev
```

Cần: một tài khoản admin trên dashboard; ít nhất hai model đã bật với cửa sổ ngữ cảnh khác nhau (ví dụ một model 8k và một model 128k trở lên); một client key `sk-cp-…` (gọi là `$KEY`) bật **Lưu hội thoại** trong thẻ Conversations.

## 1. Kiểm thử tự động

```bash
npm run test -w server -- src/__tests__/custom/context-budget
```

```bash
npm run test:migrations
```

```bash
npm run test -w client -- src/custom/ContextPolicyCard.test.tsx
```

Kỳ vọng: tất cả đạt. Các bộ test bao phủ US1–US5 và hồi quy "chính sách tắt thì request gửi đi giống hệt" (SC-006).

## 2. Chính sách tắt không đổi gì (US1 kịch bản 5, SC-006)

1. Không bật chính sách cho `$KEY`.
2. Gửi một request chat có `X-Conversation-Id: qs-off`.
3. Kỳ vọng: không có header `X-FreeLLM-Context`; `X-Conversation-History` như trước nâng cấp.

## 3. Ngân sách giữ request trong giới hạn (US1, SC-001, SC-002)

1. Dashboard → client key → thẻ **Context policy** → bật, chọn **Tùy chỉnh**, ngân sách 4.000 token, tắt tóm tắt.
2. Phát lại bộ hội thoại mẫu 300 lượt qua `$KEY`:

```bash
node scripts/context-budget-replay.mjs --key "$KEY" --turns 300 --conversation qs-budget
```

3. Kỳ vọng:
   - mọi phản hồi 200, không lỗi `context_too_large`;
   - trong header `X-FreeLLM-Context`, `mandatory+summary+knowledge+history ≤ budget` ở mọi lượt;
   - từ lượt 50, tổng token mỗi lượt dao động trong ±10% (script in bảng tóm tắt);
   - `hist_dropped` tăng theo bước bằng `dropBlockTurns × 2` tin (bỏ theo khối);
   - script in tỷ lệ tiết kiệm = 1 − (tổng token đã gửi từ lượt 51) / (tổng token nếu gửi toàn bộ lịch sử từ lượt 51); kỳ vọng ≥ 60% (SC-003).

## 4. Khớp lại khi đổi sang model nhỏ hơn (US1 kịch bản 3)

1. Đặt chuỗi fallback để model 128k đứng trước model 8k.
2. Tạm vô hiệu hóa key của model 128k (hoặc đặt cooldown) rồi gửi lượt kế tiếp của `qs-budget` với ngân sách key 16.000.
3. Kỳ vọng: phản hồi do model 8k phục vụ; header có `refits=1` và `budget` ≤ 8.192 − phần câu trả lời; không có lỗi "không có model phù hợp".

## 5. Phần bắt buộc quá lớn (US1 kịch bản 4)

Gửi một tin người dùng khoảng 30.000 token với ngân sách 16.000. Kỳ vọng: HTTP 400, `code: "context_budget_exceeded"`, thông điệp nêu số token ước lượng và ngân sách.

## 6. Tóm tắt nhớ chi tiết cũ (US3, SC-004)

1. Bật tóm tắt cho `$KEY`.
2. Chạy kịch bản nhớ sự kiện (20 sự kiện ở đầu hội thoại, sau đó 120 lượt đệm, rồi 20 câu hỏi):

```bash
node scripts/context-budget-replay.mjs --key "$KEY" --scenario fact-recall --conversation qs-recall
```

3. Kỳ vọng: script báo ≥ 18/20 câu đúng. Trên dashboard, bản tóm tắt của `qs-recall` có giá trị, và mốc "tóm tắt tới tin" tăng dần.

Script này gọi model thật nên kết quả phụ thuộc model; ghi lại model đã dùng khi nghiệm thu.

## 7. Tri thức chia ngân sách (US4)

1. Thêm 6 tài liệu vào Knowledge của `$KEY` (mỗi tài liệu khoảng 500 token), bật Knowledge.
2. Hỏi một câu khớp nhiều tài liệu với tỷ lệ tri thức 10%. Kỳ vọng: `kb_sent` nhỏ hơn số đoạn khớp, `knowledge ≤ 10% × (budget − mandatory)`.
3. Hỏi một câu không liên quan. Kỳ vọng: `kb_sent=0`, phần `history` lớn hơn lượt trước (nhận phần dư).

## 8. Lịch sử do client gửi (US5)

```bash
node scripts/context-budget-replay.mjs --key "$KEY" --client-history 200
```

Lần lượt với ba chế độ `passthrough`, `trim_on_overflow`, `enforce_budget`. Kỳ vọng: chế độ đầu không có `client_dropped`; hai chế độ sau có `client_dropped > 0`, và các cặp lời gọi công cụ/kết quả không bao giờ bị tách (script kiểm tra trên bản ghi request gửi đi của mock provider khi chạy với `--mock`).

## 9. Minh bạch (US2, SC-008)

1. Dashboard → client key → Conversations → mở `qs-budget` → **Xem trước ngữ cảnh**. Kỳ vọng: thấy danh sách phần sẽ gửi, số token từng phần, lý do bỏ; con số khớp header lượt gần nhất (sai lệch chỉ do tin mới).
2. Đăng nhập bằng thành viên chỉ có `view_client_profiles`, mở xem trước. Kỳ vọng: bị từ chối (403).
3. Thẻ Context policy → **Thống kê 7 ngày**. Kỳ vọng: có token đầu vào trung bình, tỷ lệ bị thu gọn, token tiết kiệm, sai số ước lượng (`within15PctRate`, mục tiêu ≥ 0,95 theo SC-005).

## 10. Hiệu năng (SC-007)

```bash
npm run test -w server -- src/__tests__/custom/context-budget/perf.test.ts
```

Kỳ vọng: p95 thời gian khớp ngân sách cho hội thoại 1.000 tin ≤ 50 ms.
