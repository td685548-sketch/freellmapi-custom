# Prompt — Agent 3: Real HTTP Integration & Lifecycle

Bạn là **Agent 3**, làm spec017 trên **feat/9router-integration** trong checkout `freellmapi`: Windows `C:\Users\dotha\Documents\Fsoft-Working\freellmapi` hoặc WSL `/mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi`.

Đọc `AGENTS.md`, constitution và tất cả tài liệu `specs/017-ai-support-runtime-integration/`, nhất là data-model.md/contracts.md/ownership.md/review.md. Dùng CodeGraph trước đọc/tìm source. Không triển khai spec016; giữ các entry016 nếu đã được thêm bởi agent khác.

## Chỉ được tạo/sửa

CREATE:

- `server/src/custom/x-gateway/support-runtime-router.ts`
- `server/src/__tests__/custom/x-support-runtime-gateway.test.ts`

EDIT:

- `server/src/custom/x-gateway/support-router.ts`
- `server/src/custom/x-gateway/support-enterprise-router.ts`
- `server/src/custom/x-gateway/support-governance-router.ts`
- `server/src/custom/x-gateway/console-router.ts` — minimal mount only
- `server/src/index.ts` — minimal worker startup/shutdown hooks only
- `server/src/__tests__/custom/x-support-gateway.test.ts`
- `server/src/__tests__/custom/x-support-enterprise.test.ts`
- `server/src/__tests__/custom/x-support-governance.test.ts`

## Nhiệm vụ

- Thực hiện T009–T010, T012–T013, T016, T021–T023.
- Chuyển **real POST /chat và console /simulate-chat** sang Agent1 executeSupportTurn. Inject existing executeSupportChatPipeline qua callback; không duplicate runtime engines trong router.
- Thêm optional typed internal hooks cho pipeline: trusted context, model/output/tool-call caps, maskToolData và approval-aware invokeWebhook. Tất cả nhánh tool/fallback phải đi qua hooks. Production fallback hoặc provider fail ->503 trung thực; không fake AI success.
- Xác thực public identity thống nhất cho cả3router: token aliases tương thích nhưng header/body mâu thuẫn ->400; origin allowlist kiểm tra server-side kể cả preflight; ownership trước đọc/append/escalate/CSAT; không chấp nhận body.role/userId làm quyền.
- Guest-session dùng allowGuest, UUID identity, roleguest TTL900 và atomic throttle20/tenant/trusted-IP/minute từ Agent1 helper. Không cấp token privileged, không parse X-Forwarded-For thủ công.
- Validate messages/IDs/model/unknown bypass fields đúng contracts; server history thay client-supplied history. Giữ đường dẫn và fields success cũ, thêm runtime metadata; typed errors/Retry-After. Không public route nào còn đường gọi pipeline bỏ qua chính sách.
- Thay approve/reject handler bằng Agent2 service. Reviewer lấy từ phiên đăng nhập; không tin reviewedBy body; không simulated success.
- Ticket created/resolved, action approved/rejected, CSAT và guardrail.blocked phải enqueue trong cùng transaction nghiệp vụ. Không await HTTP trong transaction và không block chat bằng retries. Bỏ allowLocalhost:true trên route công khai; test console chỉ server env opt-in.
- Implement console runtime/readiness/outbox APIs từ contracts.md. Readiness chỉ kiểm tra local config, không gọi provider/webhook, không hardcode ready và không lộ secret. Mutations yêu cầu edit_x_settings.
- Serve GET widget.js bằng Agent4 `getSupportRuntimeWidgetScript()`; không tự viết lại widget trong support-router. Giữ các init options trước đây.
- Start worker Agent2 sau initDb, đúng một lần cả khi server fallbackIPv4; stop trước DB close bằng hook tối thiểu. Không reformat index hoặc refactor các service không liên quan.

## Kiểm thử

Trong server:

```text
npx vitest run src/__tests__/custom/x-support-runtime-gateway.test.ts src/__tests__/custom/x-support-gateway.test.ts src/__tests__/custom/x-support-enterprise.test.ts src/__tests__/custom/x-support-governance.test.ts
```

Test actual Express paths với engines thật và chỉ mock provider/network boundaries. Chứng minh chặn trực tiếp /chat không gọi provider/tool; RAG/CRM/masking có mặt thật; replay không gây tác động; cross-user/tenant/Origin bị từ chối; event atomic rollback; approval replay; guest isolation/rate limit; fields backward compatibility. Không chỉ test services riêng hoặc mock toàn bộ runtime để báo tích hợp thành công.

Khi đủ peer code, chạy root `npm run test`, `npm run lint`, `npm run build`, `npm run test:migrations`; không sửa lỗi ngoài ownership, báo reviewer/owner tương ứng. Không bỏ test cũ để xanh; điều chỉnh expectation thay đổi có chủ đích và ghi rõ.

Không thêm package, sửa file khác, commit/push/PR/merge hoặc gọi agent khác. Báo dependency thiếu, không tạo production stubs. Bàn giao file diff, route mappings, kết quả kiểm thử/exit status, giới hạn và phần chưa nối. Reviewer chỉ tạo PR sau cả4handoff và review đạt.
