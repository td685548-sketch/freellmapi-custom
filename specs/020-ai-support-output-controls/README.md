# 020 — AI Support Output Controls (chặng 3)

Ngày: 2026-11-16. Trạng thái: đã hoàn tất và merge PR #73 (`T001`–`T019`, F1–F5) vào `main`, đồng thời hoàn thành đợt bổ sung sau merge (kiểm soát `retrievalCitations` của Stage 4 và masking/revalidation lịch sử theo `userRole` gốc). Xem review.md cho bằng chứng đầy đủ.

Đây là chặng 3 trong bảng 8 chặng của người dùng: kiểm soát nội dung đầu ra. Không phải chặng 3/4 của lộ trình Support cũ trong spec015/016. Không đánh dấu MCP Client hoàn tất, không triển khai embeddings, prompt caching hoặc đa agent trong đợt này.

## Giao việc

Gửi toàn bộ một file prompt cho mỗi agent:
1. [Agent 1 — DTO, policy store, audit, migration](prompts/agent-1.md)
2. [Agent 2 — Bộ đánh giá đầu ra thuần, deterministic](prompts/agent-2.md)
3. [Agent 3 — Runtime, cache, history và Copilot](prompts/agent-3.md)
4. [Agent 4 — Console API và Studio EN/VI](prompts/agent-4.md)

Spec/plan/tasks/contracts đã được chuẩn bị và frozen cho bốn agent. Code hiện được reviewer tích hợp trên nhánh riêng codex/support-output-controls từ origin/main 1dbf92f5. Các prompt bên trên giữ làm hồ sơ bàn giao ban đầu; xem review-findings.md cho review trước sửa và review.md cho bằng chứng cuối.

## Baseline và lịch sử bàn giao

Checkout khảo sát ban đầu ở feat/9router-integration và có nhiều pending changes. Bốn agent làm ở các worktree riêng từ SHA90e45f06; reviewer giữ nguyên toàn bộ các worktree đó và dùng managed worktree riêng cho PR020.

Reviewer chuẩn bị một baseline commit đã chấp nhận, chứa017/018 và019 nếu nhận tích hợp Copilot, giữ nguyên mọi pending work của người khác. Mỗi agent dùng checkout/worktree riêng, nhánh codex/support-output-a1..a4 từ origin/main mới nhất cộng cùng các baseline commit đã chấp nhận. Dùng create_worktree nếu công cụ có sẵn; không tự chạy git worktree add thay thế khi công cụ được yêu cầu. Ghi SHA nền vào bàn giao. Nếu019 chỉ tồn tại dưới dạng untracked/dirty, các phần độc lập vẫn làm được; Agent3 báo dependency chưa tích hợp và không tạo Copilot giả.

Agent1 công bố DTO và store exports; Agent2 công bố evaluator. Agent3/4 chỉ báo tích hợp sau khi dùng peer code thật. Reviewer tích hợp các commit đã review lên nhánh codex/support-output-controls và chạy toàn bộ gates trước PR. Không tự merge.

## Phạm vi bảo đảm

Kiểm tra deterministic theo quy tắc có giới hạn: literal terms, giới hạn độ dài, mẫu credential phổ biến; tận dụng masking hiện có và kiểm chứng citations018. Không tuyên bố hiểu ngữ nghĩa, chặn mọi nội dung xấu hoặc phát hiện mọi bí mật. Không gửi prompt tới dịch vụ moderation/AI mới. Preview không gọi model.
