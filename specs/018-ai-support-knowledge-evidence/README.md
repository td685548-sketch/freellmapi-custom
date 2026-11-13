# 018 — Knowledge Evidence & Answer Quality

**Ngày**: 2026-11-13 · **Nhánh dùng lại**: feat/9router-integration · **Trạng thái**: đã hoàn thành, PR #25 đã merge và CI kiểm tra đã qua. Các báo cáo review giữ nguyên bằng chứng tại thời điểm chạy.

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

- Đợt kế tiếp là spec019 (Widget Studio, Copilot và SLA) dựa trên runtime017/evidence018; nó thay thế thiết kế016 chưa triển khai. Giữ nguyên016 làm tham khảo, không chạy đồng thời.
- Sau đó ưu tiên SDK/website mẫu, kiểm thử trình duyệt xuyên domain và vận hành triển khai; streaming, nạp HTML/PDF, embeddings/hybrid search, SSO và đa kênh là các đợt riêng.

## Bàn giao đã hoàn thành

PR #25 đã merge ngày2026-11-13; các job CI kiểm tra thành công. Prompt017–018 đã được dọn theo yêu cầu người dùng; spec/contracts/review vẫn giữ làm lịch sử và bản prompt cũ còn trong Git history.

Đợt tiếp theo dùng [spec019 Service Desk](../019-ai-support-service-desk/README.md) và bốn prompt mới tại đó. Không dùng lại prompt016 chưa triển khai hoặc chạy nó song song với019.
