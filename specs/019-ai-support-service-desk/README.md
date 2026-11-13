# 019 — Support Service Desk & Widget Studio

**Ngày**:2026-11-13 · **Nhánh**: codex/support-service-desk · **Trạng thái**: đã triển khai và qua kiểm tra cục bộ; xuất bản bằng PR riêng.

PR25 của018 đã merge và các CI job kiểm tra đã qua. Bước tiếp theo hoàn thiện trải nghiệm vận hành sau lớp tri thức: widget theo thương hiệu + khảo sát trước chat, Copilot có nguồn cho nhân viên và hàng đợi/phòng ban/SLA từ vòng đời ticket thật.

019 thay thế thiết kế016 chưa triển khai cho đợt này;016 giữ nguyên làm tham khảo, không chạy song song. V1 không tự gửi phản hồi, không đọc/ghi CRM từ khảo sát/Copilot, không giả độ tự tin, không dùng endpoint /x cũ. Lịch giờ làm việc, macro, thông báo nền và drag/drop là đợt sau.

## Bàn giao bốn agent (lịch sử)

Người dùng đã thay quy định ngày2026-11-13: mỗi tính năng/bản sửa có nhánh và PR riêng; áp dụng [AGENTS.md](../../AGENTS.md). Đợt này xuất bản từ `codex/support-service-desk`, không ghép vào PR Kiro. Bốn prompt bên dưới lưu lại bàn giao đã hoàn thành, không dùng để dispatch lại.

Gửi TOÀN BỘ mỗi file cho một agent riêng:

1. [Agent1 — DTO, storage, widget/intake](prompts/agent-1.md)
2. [Agent2 — Copilot thật, evidence và ngân sách](prompts/agent-2.md)
3. [Agent3 — SLA/lifecycle, runtime và HTTP](prompts/agent-3.md)
4. [Agent4 — Studio EN/VI và widget thật](prompts/agent-4.md)

Tất cả đọc [spec](spec.md), [plan](plan.md), [contracts](contracts.md), [data-model](data-model.md), [ownership](ownership.md), [tasks](tasks.md) và [quickstart](quickstart.md). Agent1 chốt DTO/exports trước; Agent2/3/4 có thể chuẩn bị phần độc lập, chỉ báo tích hợp đạt sau khi chạy peer code thật.

Người dùng tự dispatch; reviewer chỉ kiểm code sau khi bốn agent bàn giao, trả findings, chạy kiểm tra và tạo PR nếu đạt. Không tự spawn, implement, commit/PR trong bước viết spec; không tự merge PR sau này.

Prompt017–018 đã dọn vì các đợt đó hoàn thành; spec/contracts/review cũ vẫn giữ để truy vết. Xem [cleanup record](prompt-cleanup.md). Thay đổi Kiro và tài liệu016 không bị chạm.
