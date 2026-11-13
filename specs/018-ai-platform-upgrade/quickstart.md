# Quickstart: kiểm chứng AI Platform Upgrade

Hướng dẫn chạy và kiểm chứng từng giai đoạn. Chi tiết API ở [contracts/](./contracts/), bảng ở [data-model.md](./data-model.md). Các kịch bản tự động nằm trong `server/src/__tests__/custom/ai-platform/` và `client/src/custom/ai-platform/*.test.tsx`; phần "bằng tay" dùng để nghiệm thu trên bản chạy thật.

## Chuẩn bị

```bash
npm install
```

```bash
npm run db:migration:up
```

```bash
npm run dev
```

Cần: một tài khoản chủ hệ thống, một client key (`sk-cp-…`) có ít nhất một nhà cung cấp chat hoạt động. Với giai đoạn 4 cần thêm một model embedding; với giai đoạn 5 cần một nhà cung cấp hỗ trợ điểm đánh dấu cache.

## Cổng chất lượng (mọi giai đoạn)

```bash
npm run test
```

```bash
npm run lint
```

```bash
npm run build
```

```bash
npm run test:migrations
```

Chỉ chạy bộ test của tính năng:

```bash
npm run test -w server -- ai-platform
```

## Giai đoạn 1 — Nền tảng (US1)

| Bước | Kết quả mong đợi |
|---|---|
| Chạy `regression.test.ts` | Với mọi công tắc tắt, thân gửi nhà cung cấp giả lập và thân/headers trả lời trùng ảnh chụp trên 4 giao thức, luồng và một lần |
| Mở `/ai-platform` bằng chủ hệ thống | Thấy 6 công tắc đều tắt |
| Cấp `view_ai_platform` cho một thành viên, đăng nhập bằng thành viên đó | Thấy trang tổng quan; `PUT /api/ai-platform/flags` trả 403 kèm `edit_ai_flags` |
| Bật rồi tắt một công tắc, mở lịch sử thay đổi | Hai mục vùng `ai-platform` với người làm và thời điểm |
| `npm run db:migration:down` rồi `up` | Không lỗi; dữ liệu cũ nguyên vẹn |
| Khôi phục một bản sao lưu tạo trước nâng cấp | Khởi động bình thường, mọi công tắc tắt |

## Giai đoạn 2 — MCP client (US2)

Test dùng máy chủ MCP giả lập trong tiến trình (`helpers/fake-mcp-server.ts`) với công cụ `lookup_order` (đọc) và `refund_order` (ghi).

| Bước | Kết quả mong đợi |
|---|---|
| Đăng ký máy chủ, bấm Kiểm tra | Trạng thái `ok`, 2 công cụ ở trạng thái chờ xem lại |
| Đăng ký `http://127.0.0.1:…`, `http://169.254.169.254/…`, và một URL chuyển hướng tới địa chỉ nội bộ | 422 `unsafe_url` cho cả ba |
| Cho phép `lookup_order` (đọc), gán cho client key, bật công cụ | `GET /mcp/bindings/profile/<id>` trả 1 công cụ |
| Hỏi qua `/v1/chat/completions` một câu cần tra đơn | Một câu trả lời cuối; `x-freellm-tool-rounds: 1`; một dòng trong nhật ký lời gọi với tham số đã che |
| Cho phép `refund_order` (ghi), yêu cầu hoàn tiền | Máy chủ giả lập chưa nhận lời gọi; có một mục trong hàng chờ duyệt |
| Duyệt hai lần đồng thời | Một lần thành công, một lần 409; máy chủ nhận đúng một lời gọi |
| Đổi mô tả công cụ ở máy chủ giả lập, đồng bộ lại | Công cụ về trạng thái chờ xem lại và không còn được gắn cho model |
| Máy chủ giả lập treo 30 giây / trả 1 MB | Lượt chat vẫn kết thúc; trạng thái lời gọi `timeout` / `too_large` |
| Tìm chuỗi bí mật thử trong log, nhật ký lời gọi, audit, bản xuất | Không thấy |

## Giai đoạn 3 — Kiểm soát đầu ra (US3)

Nhà cung cấp giả lập trả câu có từ cấm ở giữa, cắt làm nhiều mảnh sao cho từ cấm vắt qua hai mảnh.

| Bước | Kết quả mong đợi |
|---|---|
| Chế độ `log` | Người gọi nhận nguyên văn; một sự kiện `logged` |
| Chế độ `block`, một lần, trên từng giao thức | Thân đúng lược đồ, nội dung là thông báo thay thế, lý do kết thúc theo [inference-surface.md](./contracts/inference-surface.md) |
| Chế độ `block`, luồng, trên từng giao thức | Từ cấm không xuất hiện trong bất kỳ mảnh nào; luồng kết thúc hợp lệ |
| Đặt chỉ dẫn hệ thống, cho nhà cung cấp giả lập chép lại nó | Bị xử lý là `promptLeak` |
| Bật PII với hành động che | Email/số điện thoại trong câu trả lời được che, câu trả lời không bị chặn |
| Bật bộ kiểm tra ngoài và cho nó lỗi, lần lượt `fail_mode` `allow` rồi `block` | Cho qua kèm sự kiện `check_failed`; rồi bị chặn |
| Bật cache khớp chính xác, gửi lại cùng yêu cầu | Câu trả lời từ cache vẫn bị chính sách xử lý |
| Xem trích đoạn bằng tài khoản thiếu `view_guard_excerpts` | 403 |
| Chạy bộ đo độ trễ | Thêm không quá 300 ms tới ký tự đầu tiên ở cấu hình mặc định |

## Giai đoạn 4 — Tri thức ngữ nghĩa (US4)

Test dùng embedding giả lập xác định (vector suy ra từ bảng từ đồng nghĩa) và bộ `fixtures/retrieval-eval.json` gồm tài liệu và câu hỏi diễn đạt lại.

| Bước | Kết quả mong đợi |
|---|---|
| Đặt chế độ `hybrid`, thêm tài liệu | Job chạy nền; tiến độ tới 100%; chat trong lúc đó vẫn trả lời |
| Chạy bộ đánh giá | Tỷ lệ đúng trong 5 kết quả đầu của `hybrid` cao hơn `keyword` ít nhất 25 điểm phần trăm |
| Tắt nhà cung cấp embedding, hỏi lại | Trả lời bình thường; `x-freellm-retrieval: keyword;degraded` |
| Sửa rồi xóa một tài liệu, hỏi ngay | Không còn đoạn cũ trong ngữ cảnh và trích dẫn |
| Bật trích dẫn | Header `x-freellm-citations` giải mã ra đúng tài liệu; trường `citations` có ở trả lời một lần của OpenAI |
| Tài liệu support giới hạn role, hỏi bằng role khác | Không có trong ngữ cảnh lẫn trích dẫn |
| Đổi model embedding | Job lập lại; trong lúc đó `degraded`; xong thì hết |
| Khởi động lại giữa lúc lập chỉ mục | Job tiếp tục, không lập lại đoạn đã xong |

## Giai đoạn 5 — Cache prompt (US5)

| Bước | Kết quả mong đợi |
|---|---|
| Gửi yêu cầu có `cache_control` tới đích `explicit` (giả lập ghi lại thân) | Điểm đánh dấu có mặt đúng vị trí |
| Cùng yêu cầu, định tuyến tới đích `none` | Không còn trường `cache_control` nào trong thân |
| Bật tự đánh dấu, client key có chỉ dẫn hệ thống dài | Có điểm đánh dấu sau chỉ dẫn; tổng không quá giới hạn |
| Gửi hai yêu cầu chỉ khác câu hỏi cuối | Phần trước điểm đánh dấu cuối trùng từng byte |
| Lần thử đầu lỗi, chuỗi dự phòng sang đích khác loại | Thân của lần thử sau được chuẩn hóa lại cho đích mới |
| Giả lập trả usage có token cache | Trang thống kê hiện token, tỷ lệ trúng, ước tính tiết kiệm trong vòng 1 phút |
| Tắt trụ cột | Thân gửi đi trùng ảnh chụp hồi quy |

## Giai đoạn 6 — Chỉ dẫn có phiên bản (US6)

| Bước | Kết quả mong đợi |
|---|---|
| Sau migration, mở client key có chỉ dẫn cũ | Phiên bản 1, đang phát hành; chat không đổi |
| Lưu nháp, gửi chat | Vẫn dùng bản phát hành |
| Phát hành, gửi chat | Dùng bản mới |
| So sánh bản 1 và 2 | Khác biệt theo dòng, người sửa, ghi chú |
| Khôi phục bản 1 | Tạo bản 3 có nội dung bản 1; chat dùng bản 3 |
| Nháp có `{{khong_ton_tai}}` hoặc `{{` không đóng | 422 kèm dòng và cột |
| Gửi `x-freellm-vars` với giá trị chứa `{{date}}` và "bỏ qua hướng dẫn" | Giá trị xuất hiện nguyên văn như dữ liệu, không được thay tiếp, cắt 200 ký tự |
| Hai phiên cùng lưu nháp | Phiên sau nhận 409 |

## Giai đoạn 7 — Điều phối (US7)

Quy trình thử: `triage` chuyển giao cho `billing` (có `lookup_order`, `refund_order`) hoặc `tech` (có tri thức).

| Bước | Kết quả mong đợi |
|---|---|
| Phát hành, cấp cho client key, gọi `model: "flow:support-triage"` | Một câu trả lời cuối đúng giao thức; `x-freellm-run-id` |
| Gọi bằng client key chưa được cấp / bằng khóa hợp nhất | 403 `flow_not_granted` / 400 `flow_requires_client_key` |
| Mở vết chạy | Các bước model → handoff → tool → model, kèm token và thời lượng; dữ liệu đã che |
| Đặt `maxSteps: 2` | Dừng `stopped;reason=max_steps`, có câu trả lời tốt nhất hiện có |
| Giả lập model gọi lặp cùng công cụ | Dừng `loop_detected` ở lần thứ 3 |
| `tech` thử gọi `refund_order` | Công cụ không có trong danh sách của `tech`; lời gọi bị từ chối như công cụ không tồn tại |
| Yêu cầu hoàn tiền | Trả lời "đang chờ duyệt"; `GET /v1/ai/runs/{id}` trả `awaiting_approval`; duyệt xong thì `completed` kèm kết quả |
| Ngắt kết nối giữa chừng / hủy từ dashboard | Không bước mới nào bắt đầu; trạng thái `cancelled` |
| Khởi động lại khi đang chạy | Lần chạy thành `interrupted`; không lời gọi công cụ nào được lặp lại |
| So tổng token của lần chạy với phân tích của client key | Khớp |

## Giai đoạn 8 — Nghiệm thu toàn bộ

| Bước | Kết quả mong đợi |
|---|---|
| Bật cả 6 trụ cột cho một client key, chạy bộ kịch bản tổng hợp | Thứ tự xử lý đúng như [inference-surface.md](./contracts/inference-surface.md) |
| Sao lưu, khôi phục sang bản cài trống | Cấu hình trở lại; chỉ mục tự lập lại nếu thiếu vector |
| Chạy `translations.test.ts` | Không khóa dịch thiếu |
| Chạy bộ đo hiệu năng với mọi công tắc tắt | Thời gian xử lý thêm không quá 5% so với mốc trước nâng cấp |
| Chạy single-user trong Docker | Dashboard dùng được mọi trang mới, không cần cấu hình quyền |
