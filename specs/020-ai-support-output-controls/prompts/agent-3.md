Bạn là Agent-3 của spec020 — Chặng 3: AI Support Output Controls.

Repo gốc: C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL: /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi). Dùng checkout riêng do reviewer chuẩn bị, không ghi checkout gốc đang dirty. Đọc AGENTS.md, .specify/memory/constitution.md, docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md và toàn bộ specs/020-ai-support-output-controls/{README.md,spec.md,plan.md,contracts.md,ownership.md,tasks.md,quickstart.md}. Dùng CodeGraph trước khi tìm/đọc code nếu .codegraph tồn tại.

Đây là chặng3 trong bảng8 chặng, không phải spec015/016. Không triển khai MCP/vector/caching/system prompt versioning/orchestrator. Bạn chỉ làm phần được giao, không spawn thêm agent. Không sửa pending019/provider/Playground, không reset/stash/di chuyển thay đổi người khác. Nhánh riêng codex/support-output-a3 từ origin/main mới nhất + baseline commits017/018/019 đã được reviewer chấp nhận; ghi SHA nền. Không dùng lại feat/9router-integration hoặc chia sẻ active branch. Thiếu baseline/peer thật thì làm phần độc lập và báo rõ dependency, không tự giả module. Không commit/push/PR trước required tests/build; reviewer tích hợp và tạo PR, không tự merge.

Ownership trong ownership.md là danh sách chính xác các file được tạo/sửa. Mọi file khác chỉ đọc; nếu cần thêm đường hook hãy báo path/lý do cho reviewer. Không sửa contracts sau freeze; không cast away types, bỏ test, thêm production fallback, dependencies, CI, binary hoặc sửa migration cũ.

Chỉ mock provider/HTTP bên ngoài khi kiểm chứng tích hợp. Không gọi model thật, moderation service, gửi customer reply hoặc ghi dữ liệu production. Bàn giao bằng tiếng Việt: baseline/head SHA, task IDs, file/exports đã đổi, commands + exit/counts, peer commits đã dùng, phần chưa xác minh và rủi ro. Không gọi scoped green là toàn repo green.

Nhiệm vụ: T008–T013. Sở hữu integration adapter và minimal runtime/cache/history/Copilot hooks đúng ownership.md. Agent1 sở hữu shared/support-runtime.ts; không sửa file đó.

Đầu tiên trace actual generation/simulator/public chat, BOTH final DB transactions, idempotency/cache, canonical workflow getters/provider history và019 Copilot generation/read/replay. Dùng CodeGraph và ghi danh sách boundary vào handoff. Không thêm executor hay history getter song song khiến đường cũ bỏ qua policy. Adapter không import runtime/workflows/Copilot/router, tránh circular imports.

Chờ actual Agent1 store và Agent2 evaluator rồi tích hợp. Có thể chuẩn bị test boundary trong lúc chờ; không fallback store/evaluator giả ở production.019 chưa có accepted baseline thì hoàn thành chat phần độc lập và báo Copilot còn dependency; không cherry-pick dirty files người khác hoặc tuyên bố toàn020 xong.

Áp dụng contracts:018 validation -> existing masking ->020 -> revalidate final citations nếu text thay đổi. Policy lookup lại synchronously trong mỗi final DB transaction; audit và safe response/history/cache commit cùng transaction. Block thay toàn bộ text aliases bằng fixed notice, strip public trace/citations, giữ honest model/usage/pending action state; replySource output_policy_notice. Không lưu raw bị reject, không log kể cả exception, không retry/repair model, không giả rollback business side effects hoặc refund unknown usage.

Public tool result chỉ kiểm tra bản hiển thị, không sửa execution args/approval snapshots. Claims/lease/intake/quota guards017/019 nguyên vẹn. Existing off behavior và masking018 không bị tắt.

Replay020 policy version changed409 trước trả cache; legacy replay evaluate current policy read-only. Không provider/message/quota/event/cache write on replay. History/list/provider context inspect AI messages với original conversation userRole sau018 revocation; staff/admin view không nâng role; human/customer text không bị020 viết lại. Đọc không mutate storage, không recover raw cũ.

Copilot kiểm tra summary+tất cả drafts cùng decision trước lưu/trả; một block -> discard whole set và422 output_blocked safe notice, settle actual/conservative cost và fence job bình thường. Policy version/context stale trên read/replay409, no regenerate/send. Bạn chỉ thêm optional output field vào019 shared result.

New tests owned phải chứng minh composed pipeline thật (mock external provider only), in-flight policy change, same request contention/charge/event, stricter legacy history/cache, source revocation, safe aliases/nested traces/citation excerpts, abort/error/lease, staff/customer isolation và Copilot all-or-nothing. Capture logs và kiểm tra raw sentinel absent. Báo thiếu hooks/exports cho reviewer, không widen ownership.
