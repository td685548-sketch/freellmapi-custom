# 018 — Knowledge Evidence & Answer Quality

**Ngày**: 2026-11-13 · **Nhánh dùng lại**: feat/9router-integration · **Trạng thái**: đã triển khai, sửa sau review và hoàn tất local validation. Tình trạng PR/CI hiện hành ở [review.md](review.md).

Console hiện ở `/thruline/support-knowledge`; API dùng `/api/thruline/support` và widget dùng `/thruline/v1/support`. Xem [integration-main.md](integration-main.md) cho việc đồng bộ với main sau đổi tên URL.

## Vì sao làm tiếp phần này

PR #16 của spec017 đã merge; các job lint/build/server/client/CLI trên CI đã thành công. Kiểm tra checkout cho thấy tri thức hiện lưu qua support-knowledge.ts, nhập thủ công và xếp hạng theo từ khóa; runtime có knowledgeDocIds nhưng chưa có vòng kiểm chứng citation, xuất bản phiên bản và bộ đánh giá truy xuất. Đây là khoảng trống về chất lượng câu trả lời sau khi đã nối an toàn luồng chat.

Đợt018 bổ sung:
1. Nhập text/Markdown/FAQ JSON, bản nháp, xem trước và xuất bản phiên bản.
2. Chế độ tùy chọn chỉ trả lời từ tài liệu được cấp quyền, có trích dẫn hợp lệ; thiếu nguồn thì từ chối trả lời có giải thích.
3. Thử truy xuất theo role, bộ câu hỏi kiểm thử và báo cáo phát hiện mất nguồn/rò quyền.
4. Knowledge Studio và nguồn tham khảo trong widget.

Đây là xác thực nguồn/citation, không phải chứng minh mọi câu trả lời đúng về ngữ nghĩa. Truy xuất v1 vẫn lexical có chuẩn hóa tiếng Việt; không gọi là vector search, semantic confidence hoặc factual accuracy.

## Thứ tự hoàn thiện sau018

- Hoàn thiện spec016 (Widget Studio, Copilot và SLA) sau khi cập nhật nó để dùng runtime017 thật. Hiện thư mục016 là tài liệu chưa được track; các đường dẫn implementation theo ownership016 chưa có trong checkout. Không ghi đè016 hoặc chạy016/018 đồng thời trong cùng checkout vì cùng chạm widget/nav/router.
- Sau đó ưu tiên SDK/website mẫu, kiểm thử trình duyệt xuyên domain và vận hành triển khai; streaming, nạp HTML/PDF, embeddings/hybrid search, SSO và đa kênh là các đợt riêng.

## Gửi cho bốn agent

Gửi **toàn bộ nội dung** từng file, mỗi file cho một agent riêng:
- [Agent1 — Storage, Import & Revisions](prompts/agent-1.md)
- [Agent2 — Retrieval, Citations & Evaluations](prompts/agent-2.md)
- [Agent3 — Runtime & HTTP Integration](prompts/agent-3.md)
- [Agent4 — Knowledge Studio & Widget](prompts/agent-4.md)

Tất cả đọc spec.md, plan.md, data-model.md, contracts.md và ownership.md. Bắt đầu hợp đồng từ Agent1; Agent2/3/4 có thể chuẩn bị phần việc bằng fixture theo contract, nhưng không được coi mock là tích hợp xong. Xem tasks.md cho30 việc và dependency.

Các prompt trên lưu lại bàn giao ban đầu. Sau ba vòng review, người dùng đã yêu cầu reviewer sửa trực tiếp phần tích hợp còn thiếu; reviewer đồng bộ main, giữ các sửa lỗi của bốn agent và chạy lại các gate. Chỉ tạo PR nếu đạt; không tự merge. Các báo cáo review vòng trước là lịch sử, không thay thế trạng thái hiện hành trong review.md.
