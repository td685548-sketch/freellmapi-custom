Bạn là Agent-1 của spec020 — Chặng 3: AI Support Output Controls.

Repo gốc: C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL: /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi). Dùng checkout riêng do reviewer chuẩn bị, không ghi checkout gốc đang dirty. Đọc AGENTS.md, .specify/memory/constitution.md, docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md và toàn bộ specs/020-ai-support-output-controls/{README.md,spec.md,plan.md,contracts.md,ownership.md,tasks.md,quickstart.md}. Dùng CodeGraph trước khi tìm/đọc code nếu .codegraph tồn tại.

Đây là chặng3 trong bảng8 chặng, không phải spec015/016. Không triển khai MCP/vector/caching/system prompt versioning/orchestrator. Bạn chỉ làm phần được giao, không spawn thêm agent. Không sửa pending019/provider/Playground, không reset/stash/di chuyển thay đổi người khác. Nhánh riêng codex/support-output-a1 từ origin/main mới nhất + baseline commits017/018/019 đã được reviewer chấp nhận; ghi SHA nền. Không dùng lại feat/9router-integration hoặc chia sẻ active branch. Thiếu baseline/peer thật thì làm phần độc lập và báo rõ dependency, không tự giả module. Không commit/push/PR trước required tests/build; reviewer tích hợp và tạo PR, không tự merge.

Ownership trong ownership.md là danh sách chính xác các file được tạo/sửa. Mọi file khác chỉ đọc; nếu cần thêm đường hook hãy báo path/lý do cho reviewer. Không sửa contracts sau freeze; không cast away types, bỏ test, thêm production fallback, dependencies, CI, binary hoặc sửa migration cũ.

Chỉ mock provider/HTTP bên ngoài khi kiểm chứng tích hợp. Không gọi model thật, moderation service, gửi customer reply hoặc ghi dữ liệu production. Bàn giao bằng tiếng Việt: baseline/head SHA, task IDs, file/exports đã đổi, commands + exit/counts, peer commits đã dùng, phần chưa xác minh và rủi ro. Không gọi scoped green là toàn repo green.

Nhiệm vụ: T001–T004. Bạn sở hữu DTO, constants/notices, policy/event store và migration. Xem danh sách CREATE/EDIT chính xác trong ownership.md.

Trước coding, thực hiện chuỗi Spec Kit specify -> plan -> tasks trên feature directory020 tường minh theo workflow repo, dùng bộ tài liệu này làm đầu vào. Không tạo spec mới/đổi scope; chỉ bổ sung artifact còn thiếu và kiểm tra nhất quán. Công bố hợp đồng020 đã freeze để các agent còn lại bắt đầu; mọi thay đổi sau đó cần reviewer điều phối.

Implement đúng signatures contracts.md. Policy khỏe mạnh chưa lưu trả version0/off/epoch; policy corrupt/decrypt/schema failure503, tuyệt đối không lặng lẽ off. Strict schema/no unknown/coercion; OCC expectedVersion atomic; defaults không làm thay đổi017 masking. Rules encrypted at rest, không log plaintext. Add shared runtime.output optional và replySource output_policy_notice, không thay default017.

Migration mới20261115_120001_support_output_controls.ts, bảng x_support_output_policies và x_support_output_events. Không sửa upstream migration. Bootstrap gọi cùng up(), theo từng Db identity; explicit Db tham gia transaction của caller, không global cache nhầm DB. Không await trong transaction. Existing tenant checks, FK theo schema thực tế, up/down/up, second in-memory Db, registry tests bắt buộc.

Audit metadata-only theo đúng allowlist; rule IDs do editor cấu hình phải validate định dạng. OperationId lấy runtime turn/job ID nội bộ; không dùng free text từ request. Dedup tenant/surface/operation, retention30 ngày/cap10000 tenant, keyset ổn định; GET không cleanup. Test OCC concurrency, corrupt state, absent-vs-corrupt, encryption, rollback, page tie timestamps và cross-tenant.

Công bố ngay shared/support-output.ts và actual typed store exports cho Agent2/3/4. Không implement evaluator/router/runtime/UI thay họ. Chạy scoped tests rồi test/build/lint/migrations theo quy định trước commit; báo rõ peer chưa có khiến gate nào chưa chạy được.
