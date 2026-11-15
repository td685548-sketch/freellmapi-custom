Bạn là Agent-2 của spec020 — Chặng 3: AI Support Output Controls.

Repo gốc: C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL: /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi). Dùng checkout riêng do reviewer chuẩn bị, không ghi checkout gốc đang dirty. Đọc AGENTS.md, .specify/memory/constitution.md, docs/GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md và toàn bộ specs/020-ai-support-output-controls/{README.md,spec.md,plan.md,contracts.md,ownership.md,tasks.md,quickstart.md}. Dùng CodeGraph trước khi tìm/đọc code nếu .codegraph tồn tại.

Đây là chặng3 trong bảng8 chặng, không phải spec015/016. Không triển khai MCP/vector/caching/system prompt versioning/orchestrator. Bạn chỉ làm phần được giao, không spawn thêm agent. Không sửa pending019/provider/Playground, không reset/stash/di chuyển thay đổi người khác. Nhánh riêng codex/support-output-a2 từ origin/main mới nhất + baseline commits017/018/019 đã được reviewer chấp nhận; ghi SHA nền. Không dùng lại feat/9router-integration hoặc chia sẻ active branch. Thiếu baseline/peer thật thì làm phần độc lập và báo rõ dependency, không tự giả module. Không commit/push/PR trước required tests/build; reviewer tích hợp và tạo PR, không tự merge.

Ownership trong ownership.md là danh sách chính xác các file được tạo/sửa. Mọi file khác chỉ đọc; nếu cần thêm đường hook hãy báo path/lý do cho reviewer. Không sửa contracts sau freeze; không cast away types, bỏ test, thêm production fallback, dependencies, CI, binary hoặc sửa migration cũ.

Chỉ mock provider/HTTP bên ngoài khi kiểm chứng tích hợp. Không gọi model thật, moderation service, gửi customer reply hoặc ghi dữ liệu production. Bàn giao bằng tiếng Việt: baseline/head SHA, task IDs, file/exports đã đổi, commands + exit/counts, peer commits đã dùng, phần chưa xác minh và rủi ro. Không gọi scoped green là toàn repo green.

Nhiệm vụ: T005–T007. Chỉ tạo support-output-engine.ts, x-support-output-engine.test.ts và fixtures/support-output/cases.json theo ownership.md.

Chờ DTO020 freeze của Agent1; trong lúc chờ nghiên cứu/tests có thể chuẩn bị nhưng không duplicate shared types trong production. Implement evaluateSupportOutput chính xác contracts.md. Engine thuần, không Db/settings/model/network/logging/runtime imports. Explicit policy + text leaves; output quyết định có action/leaves/reasons/ruleIds/redactionCount/policyVersion.

Literal matching normalization NFKC, bỏ đúng zero-width đã định nghĩa, lowercase/collapse whitespace/trim, giữ dấu tiếng Việt. Match substring, không regex người dùng, không hứa semantic/topic safety; display text không bị normalization thay đổi. Validate unique rule IDs/normalized terms và bounded policy/leaves; quá hard cap không scan regex trên dữ liệu khổng lồ.

Phân biệt off/log/enforce: off unchanged valid input; log observe unchanged; enforce block forbidden term/length/inspection_limit và redact credential nếu bật. Credential findings với redactCredentials=false chỉ observe. Block decision leaves=[]; safe errors không chứa raw input. Quy định hard-limit off/log theo contracts, không quietly truncate hoặc fail-open.

Credential pattern finite, có test chính xác cho Bearer, sk-/sk_sup_, sup_ctx_, private-key PEM; test cả false positives/negatives đã biết, CRLF/multiline/Unicode, idempotent redaction, original casing/display. Không phát hiện bí mật bằng cách đọc env/DB. Không tự thay masking policy cũ.

Viết deterministic fixtures EN/VI và adversarial cases: 0/1/max rules, duplicate IDs/terms, literal regex metacharacters, whitespace/zero-width, text split across separate leaves không ghép thành từ giả, huge/empty input, all bounds, no raw leakage in decisions/errors. Stable ordering/dedup giữa nhiều leaves. Không viết test chỉ mirror implementation; expected outputs phải độc lập.

Công bố signature/exports + pattern limitations cho Agent3/4. Không tích hợp runtime/store thay họ.
