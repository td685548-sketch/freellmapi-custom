Bạn là Agent-4 của spec020 — Chặng 3: AI Support Output Controls.

Repo gốc: C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL: /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi). Dùng checkout riêng do reviewer chuẩn bị, không ghi checkout gốc đang dirty. Đọc AGENTS.md, .specify/memory/constitution.md, docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md và toàn bộ specs/020-ai-support-output-controls/{README.md,spec.md,plan.md,contracts.md,ownership.md,tasks.md,quickstart.md}. Dùng CodeGraph trước khi tìm/đọc code nếu .codegraph tồn tại.

Đây là chặng3 trong bảng8 chặng, không phải spec015/016. Không triển khai MCP/vector/caching/system prompt versioning/orchestrator. Bạn chỉ làm phần được giao, không spawn thêm agent. Không sửa pending019/provider/Playground, không reset/stash/di chuyển thay đổi người khác. Nhánh riêng codex/support-output-a4 từ origin/main mới nhất + baseline commits017/018/019 đã được reviewer chấp nhận; ghi SHA nền. Không dùng lại feat/9router-integration hoặc chia sẻ active branch. Thiếu baseline/peer thật thì làm phần độc lập và báo rõ dependency, không tự giả module. Không commit/push/PR trước required tests/build; reviewer tích hợp và tạo PR, không tự merge.

Ownership trong ownership.md là danh sách chính xác các file được tạo/sửa. Mọi file khác chỉ đọc; nếu cần thêm đường hook hãy báo path/lý do cho reviewer. Không sửa contracts sau freeze; không cast away types, bỏ test, thêm production fallback, dependencies, CI, binary hoặc sửa migration cũ.

Chỉ mock provider/HTTP bên ngoài khi kiểm chứng tích hợp. Không gọi model thật, moderation service, gửi customer reply hoặc ghi dữ liệu production. Bàn giao bằng tiếng Việt: baseline/head SHA, task IDs, file/exports đã đổi, commands + exit/counts, peer commits đã dùng, phần chưa xác minh và rủi ro. Không gọi scoped green là toàn repo green.

Nhiệm vụ: T014–T016. Console API và Studio EN/VI đúng ownership.md; không sửa engine/store/runtime/widget/global CSS.

Backend: tạo support-output-router.ts và mount nhỏ một lần trong console-router.ts. Chính xác GET/PUT output-policy, POST output-policy/preview, GET output-events dưới /api/thruline/support/tenants/:id. Dùng canonical tenant resolution/existing editor policy018, kiểm tra auth/quyền trên cả GET/HEAD/preview. Sửa permission-actions.ts chỉ exact endpoints để use_x_gateway đơn lẻ không đọc blockedTerms. Không thêm alias cũ /api/x-gateway hay public management endpoint.

Request strict schemas, bounded body<=256KiB trước JSON parser tại route, validate integer/unknown fields/rules/limits; nếu upstream parser đã parse body phải trace actual middleware và báo reviewer exact required hook thay vì tưởng route parser đủ. Same editor-only gate primary/admin/*/manage_x_gateway hoặc use_x_gateway+edit_x_settings; unauthorized401/403, unknown tenant404. Body policy không nhận tenantId/version/internal output metadata. Errors safe strings, không echo configuration/raw text.

Dùng actual Agent1 OCC store và Agent2 evaluator. Preview nhận policy unsaved + text, dùng engine thật, không persist/audit/provider/tool/quota; enforce block không trả raw text. Events chỉ metadata, keyset pagination và không raw samples. HTTP tests dùng actual mounted app/auth/store/engine, mock external boundaries only; prove permission and case/trailing slash variants không hở.

Frontend: SupportOutput.tsx và strings riêng, route /thruline/support-output + nav một mục. Chọn tenant, policy mode/rules/limit/redact credentials, preview text và action, events metadata/pagination. API envelope đúng contracts; ghi rõ literal matching/credential pattern limitations. EN/VI đầy đủ; loading/empty/error/503/OCC409/refetch và readonly states. Không overwrite unsaved draft bằng stale query.

Tenant/session changes phải cancel/ignore old requests, clear preview/rules/events/drafts; không flash tenant cũ. Render plain text an toàn, không dangerouslySetInnerHTML, không lưu preview trong localStorage/log. Dùng native React createRoot/act theo existing tests, không Testing Library/dependency.

Events không hiển thị matched text/raw response; frontend không gửi rule IDs từ detection để giả audit. Existing widget nhận safe canonical notice từ runtime, không cần tạo widget mới. Handoff có composed API/UI tests, auth matrix và peer commits đã dùng.
