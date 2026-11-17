# Nghiệm thu Spec 021 — Token-Budgeted Context Assembly (T060, T064)

Ngày nghiệm thu: 2026-11-18. Nhánh `feat/021-stage5-polish`, tách từ `origin/main` (`0c16a3aa`, sau PR #90, PR #92 và PR #94). Máy chạy: Windows 11, Node `v24.22.1`.

## 1. Tóm tắt kiểm tra tự động

| Hạng mục | Kết quả | Chi tiết |
|---|---|---|
| `npm run lint` (`server`, `cli`) | Đạt | 0 lỗi, 0 cảnh báo chặn |
| `npm run build` (`server`, `cli`, `client`) | Đạt | Đạt; nạp thử `./server/dist/app.js` bằng Node thuần thành công |
| `npm run test:migrations` | Đạt (3/3) | Round-trip migration lên/xuống baseline sạch sẽ |
| `npm run test:bootstrap` | Đạt (2 pass, 2 skip bash trên Windows) | Script PowerShell đạt; script bash chỉ chạy trên Linux/CI |
| `npm run test:hooks` | Đạt (9/9) | Hook kiểm tra quy tắc đóng góp |
| Toàn bộ test server (`vitest --pool=forks --fileParallelism=false`) | 664/665 file đạt (7.646/7.656 test đạt, 10 skip; trước khi thêm `web-e2e.test.ts`) | 1 file duy nhất lỗi dọn thư mục tạm trên Windows là `ai-platform/guard-secret-leak.test.ts` (bên trong 1/1 test case đều đạt; chỉ lỗi `EPERM` ở `afterAll` `fs.rmSync` trên Windows — có sẵn từ trước, CI Linux chạy bình thường); bộ Spec 021 đạt 14/14 file (89/89 test) sau khi bổ sung `web-e2e.test.ts` |
| Bộ test server Spec 021 (`server/src/__tests__/custom/context-budget/`) | 14/14 file đạt (89/89 test đạt) | Bao gồm US1–US5, hiệu chỉnh T060, hiệu năng T059 và E2E HTTP/SPA `web-e2e.test.ts` |
| Test CLI (`npm run test -w cli`) | 7/7 file đạt (181/181 test đạt) | Toàn bộ đạt |
| Test client + `check:i18n` (`npm run test -w client`) | 130/130 file đạt (992/992 test đạt) | Bao gồm `ContextPolicyCard.test.tsx` (13 test), `ContextPolicyWebFlow.test.tsx` (2 test E2E đầy đủ với `apiFetch` thật + chuyển ngữ `vi`) và kiểm tra 60 ngôn ngữ / 1.336 khóa dịch |

## 2. Kết quả từng mục Quickstart (§1–§10)

> **Lưu ý về nhà cung cấp thật**: Cơ sở dữ liệu cục bộ trên máy phát triển có `api_keys = 0` và `x_provider_accounts = 0` (không có API key thật của nhà cung cấp ngoài), tương tự điều kiện nghiệm thu Spec 018. Toàn bộ kịch bản từ §2–§9 được chạy từ đầu đến cuối qua chính HTTP server Express/SQLite thật của gateway bằng mock upstream provider có độ dài và `usage.prompt_tokens` thực tế; riêng chất lượng tóm tắt/nhớ sự kiện phụ thuộc model thật cần chạy lại bằng `node scripts/context-budget-replay.mjs --key "$KEY" ...` khi triển khai có API key thật.

| Mục | Mô tả | Kết quả | Bằng chứng & Số liệu đo được |
|---|---|---|---|
| **§1** | Bộ test tự động nền tảng & UI | Đạt | `context-budget/` 14 file / 89 test; `test:migrations` 3/3; client 130 file / 992 test |
| **§2** | Chính sách tắt không đổi payload (SC-006) | Đạt | `regression.test.ts`: mọi surface `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `:generateContent` gửi payload y hệt từng byte và không phát sinh header `X-FreeLLM-Context` |
| **§3** | Hội thoại 300 lượt giữ ngân sách 4.000 token (SC-001, SC-002, SC-003) | Đạt | `node scripts/context-budget-replay.mjs --mock --turns 300 --budget 4000 --conversation qs-budget`: 300/300 HTTP 200; 100% lượt đạt `sent ≤ 4000`; từ lượt 50–300 trung bình `3.811,3` token với độ lệch tối đa `5,47% ≤ 10%`; tiết kiệm từ lượt 51–300 đạt `81,09% ≥ 60%` |
| **§4** | Khớp lại khi fallback từ 128k xuống 8k (US1) | Đạt | `surfaces.test.ts`: khi model 131k trả 503, gateway tự khớp lại vừa model `8192` trên `/v1/chat/completions` và `/v1/messages`, ghi `refits=1` |
| **§5** | Phần bắt buộc vượt ngân sách → 400 (US1) | Đạt | `gate.test.ts`: tin nhắn bắt buộc ~30k vượt ngân sách 16k trả HTTP 400 `context_budget_exceeded` nêu rõ token ước lượng và ngân sách |
| **§6** | Tóm tắt cuốn chiếu nhớ 20 sự kiện cũ sau 120 lượt đệm (SC-004) | Đạt (mock gateway) / Ghi chú key thật | `node scripts/context-budget-replay.mjs --mock --scenario fact-recall --conversation qs-recall`: đạt **20/20 (100,0%, ngưỡng ≥ 90%)** qua vòng tóm tắt thật của gateway trên mock provider (chưa chạy trên API key model thật do môi trường local không cấu hình key ngoài) |
| **§7** | Tri thức chia sẻ ngân sách & chuyển phần dư sang lịch sử (US4) | Đạt | `knowledge.test.ts`: truy hồi tri thức tôn trọng `knowledgeSharePct`, hạ trích dẫn khi bị cắt bớt, và nhường ngân sách dư khi không có tri thức khớp |
| **§8** | Lịch sử do client gửi 200 tin + giữ nguyên cặp tool call/result (US5) | Đạt | `node scripts/context-budget-replay.mjs --mock --client-history 200`: `passthrough` (`client_dropped=0`), `trim_on_overflow` (`budget=6451, window=8192, client_dropped=38`), `enforce_budget` (`budget=4000, window=131072, client_dropped=103`), cả 3 chế độ giữ nguyên cặp tool-call (`toolPairs=intact`); kiểm tra cả 4 surface trong `client-history.test.ts` |
| **§9** | Xem trước, phân quyền RBAC 403, thống kê 7 ngày & luồng Web Dashboard (US2, SC-005, SC-008) | Đạt | `web-e2e.test.ts` (E2E Express + SQLite + CSP + 32 lượt tóm tắt + `context-preview` + `context-stats` + `requests/:id/context` + member `view_client_profiles` nhận 403 khi `PUT`/`DELETE`/`context-preview`) và `ContextPolicyWebFlow.test.tsx` (kiểm thử React đầy đủ với `apiFetch` thật và đổi ngôn ngữ tiếng Việt `vi`) |
| **§10** | Hiệu năng lắp ráp hội thoại 1.000 tin (SC-007) | Đạt | `perf.test.ts` (200 lần lặp): hội thoại server 1.000 tin `p50=4,552 ms`, `p95=8,790 ms ≤ 50 ms`; lịch sử client 1.122 tin (gồm tool calls) `p50=0,688 ms`, `p95=1,161 ms ≤ 50 ms` |

## 3. Hiệu chỉnh ước lượng token đa ngôn ngữ & đa nhà cung cấp (T060, SC-005)

- **Phát hiện và sửa lỗi vòng lặp EMA**: Trước Giai đoạn 8, `hooks.ts` chưa nhân hệ số hiệu chỉnh (`getCalibrationFactor`) lúc truyền segment vào `fitToBudget`, còn `report.ts` lại truyền tổng đã hiệu chỉnh ngược vào `recordCalibrationSample`, làm hệ số EMA tự triệt tiêu về `1.0` ở lượt kế tiếp.
- **Cách khắc phục (Phương án A)**:
  - Lưu `uncalibratedTokens` vào `SegmentRegistry` (`registry.ts`) trước khi nhân hệ số hiệu chỉnh và truyền giá trị thô đó vào `recordCalibrationSample` trong `report.ts` để EMA hội tụ đơn điệu về hệ số tokenizer thật của từng nền tảng.
  - Áp dụng `fitFactor = Math.max(1.0, calibrationFactor)` lên segment trong `hooks.ts` để hệ số > 1.0 (như BPE hoặc chuỗi nhiều dấu) siết ngân sách an toàn hơn, đồng thời không nới lỏng trần khi provider báo cache hit khiến `prompt_tokens` nhỏ bất thường; `summary.estimatedTokens` giữ nguyên tổng đã hiệu chỉnh hai chiều (`[0.75, 1.6]`) phục vụ thống kê sai số `/context-stats`.
- **Kết quả đo**:
  - `node scripts/context-budget-replay.mjs --mock --calibration-check` (Anh / Việt / Trung trên 2 nhà cung cấp mô phỏng khác nhau `groq` 1.08× BPE và `cerebras` 0.86× SentencePiece): **`Samples=89, p50Pct=1,77%, p95Pct=10,36%, within15PctRate=0,9888 ≥ 0,95`**.
  - Unit test `T060` trong `server/src/__tests__/custom/context-budget/report.test.ts` (50 mẫu Anh/Việt/Trung trên `groq` và `google`): đạt `within15PctRate ≥ 0,95` và xác nhận hệ số EMA tiến đơn điệu đúng hướng.

## 4. Kiểm thử giao diện Web & các lỗi UX đã phát hiện / khắc phục

Ngoài test server/client tự động, đã khởi chạy server biên dịch thực tế với `client/dist` (`serveStaticAssets: true`), xác minh HTTP 200 cho SPA HTML, toàn bộ 18 bundle JS/CSS băm hash, header `Content-Security-Policy` và API `401 authentication_error` khi chưa đăng nhập. Đồng thời bổ sung bộ test tương tác `client/src/custom/ContextPolicyWebFlow.test.tsx` dùng `apiFetch` + React Query + I18n `en`/`vi` thật.

> **Lưu ý kiểm thử trình duyệt trực tiếp**: Subagent trình duyệt Chrome DevTools trên máy không gắn được do Chrome đang mở trên host chưa bật cờ `chrome://inspect/#remote-debugging` (`DevToolsActivePort` không tồn tại). Đã thay bằng kiểm thử HTTP thực với `client/dist` biên dịch cộng thêm hai bộ test đầu-cuối `web-e2e.test.ts` và `ContextPolicyWebFlow.test.tsx`.

Các vấn đề UX phát hiện trong quá trình rà soát và đã sửa triệt để:
1. **Đồng bộ gợi ý giữa `ConversationsCard` và `ContextPolicyCard`**: Bật/tắt hoặc sửa cài đặt *Hội thoại được lưu* nay invalidate thêm query `['context-policy', profileId]` để khung *Gợi ý từ cài đặt hội thoại hiện có* cập nhật tức thì không cần tải lại trang.
2. **Làm mới dữ liệu `ContextPreviewDialog` sau khi đổi chính sách**: Lưu hoặc đặt lại chính sách ngữ cảnh nay invalidate thêm `['context-preview', profileId]` để mở lại *Xem trước ngữ cảnh* phản ánh ngay ngân sách mới.
3. **Bật công tắc + chọn preset trong một thao tác**: Kéo công tắc *Enable context policy* khi form đang có thay đổi hợp lệ (`dirty && valid`) sẽ lưu cả preset/thông số đang chọn lẫn trạng thái bật trong một request `PUT` duy nhất.
4. **Cuộn mượt cho bảng xem trước hội thoại dài**: Bọc `<Table>` trong `<div className="max-h-[50vh] overflow-auto rounded-xl border">` ở `ContextPreviewDialog.tsx` để giữ cố định tiêu đề và thẻ ngân sách khi danh sách tin nhắn dài.
