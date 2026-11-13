# Review vòng 3 — sửa vòng2 đạt, integration gate BLOCKED

Ngày2026-11-13. Local branch `feat/9router-integration`, HEAD `99b3ba82`. Không sửa implementation, không stage/commit/push/PR/merge. Các thay đổi Kiro ngoài018 và spec016 được giữ nguyên.

## Kết quả đối chiếu vòng2

Cả bốn findings R2-01..R2-04 đã được sửa và regression thực tế pass:

- HTTP dùng createUser/createSession/member và Authorization Bearer; cleanup trong finally. Toàn bộ5 HTTP tests chạy assertion và pass, gồm normal/disconnected remote import.
- Store fixture chạy base migrations trước support tables;8/8 store tests pass, bao gồm suite/run/provenance.
- Positive runtime query đạt coverage, provider được assert gọi. History test inspect raw settings độc lập, public staff/customer vẫn redacted, callback provider được buộc chạy và không nuốt lỗi assertion. Runtime12/12 pass.
- Fresh/stored citation validators không còn catch policy read để fallback. Real-store corrupt/unavailable policy test pass; retrieval18/18.

| Gate chạy trên HEAD hiện tại + pending018 | Kết quả |
| --- | --- |
| Server bounded15 files018 +017 liên quan | PASS189/189,15/15 files;78.82s |
| Trong đó HTTP / runtime / store |5/5,12/12,8/8 pass |
| Retrieval / eval / widget |18/18,12/12,21/21 pass |
| Populated018 migration / default roundtrip / registry |3/3,3/3,2/2 pass |
| Client native evidence UI | PASS15/15 |
| Root build (shared/server/CLI/client) | PASS |
| Root lint (server/CLI) | PASS |
| Plain Node built app + console import | PASS |
| Tracked git diff --check | PASS, chỉ có thông báo CRLF/LF |
| Full root npm run test | Đã khởi chạy sau rebuild native; dừng khi phát hiện main integration blocker bên dưới. Không chứng nhận full suite pass |

Binary SQLite lại không tương thích Windows ở đầu turn; `npm rebuild better-sqlite3` thành công trước khi chạy các tests trên. Không sửa manifests/lockfiles. Logs `%TEMP%/freellmapi-018-r3-{native,regression,client,build,lint,full-test}.log`.

## Phát hiện mới khi kiểm tra prospective PR base

`git fetch origin` cập nhật main tới **769e41454ec16ed347fa883b14a458143e5c81f9** (PR24). `git rev-list --left-right --count HEAD...origin/main` trả **0 /10**: local HEAD là ancestor và thiếu10 commits. Main thay đổi166 files, có PR22/23 chuyển dashboard/API sang Thruline. Đây là thay đổi sau baseline mà các agent đã dùng; không phải bốn fixes vòng2 bị thất bại.

### R3-01 — [P1] Knowledge Studio chưa tương thích console/API canonical trên main mới

Owner: Agent4 (Studio/nav/native test), Agent3 (new actual HTTP tests); reviewer/coordinator owns safe main synchronization.

Vị trí local: `client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx:1923`,`:1998`, `shell/nav.ts:62`; HTTP fixture `server/src/__tests__/custom/x-support-evidence-http.test.ts:129` và các direct requests.

Studio gọi `/api/x-gateway/support/...`; main hiện chỉ mount console ở `/api/thruline`, không giữ alias API cũ. Khi dùng main mới, tenant query đã404 nên cả bốn tab không hoạt động. Nav item mới vẫn `/x/support-knowledge` trong khi main nav/shell chạy `/thruline/*`; phải dùng canonical link/active-match mới. Existing client legacy redirect không phải alias cho console API.

Sửa trên baseline main đã đồng bộ: route UI canonical `/thruline/support-knowledge`, tenant/library API `/api/thruline/support/...`, HTTP integration assertions qua canonical mount. Không thêm mount/API cũ để làm tests trên baseline cũ xanh; giữ permission gates mới và legacy redirect của main. Tên filesystem/internal permission keys `x-gateway`, `use_x_gateway`, `edit_x_settings` không tự đổi theo URL.

### R3-02 — [P1] Merge widget018 phải giữ endpoint/base-path migration của main

Owner: Agent4, phối hợp Agent3 cho HTTP tests.

Vị trí local: `server/src/custom/x-gateway/support-runtime-widget.ts:16`,`:135`,`:486`,`:522`,`:640`,`:725`,`:1002`.

Widget018 hiện mặc định chat/guest/history/escalate/CSAT dưới `/x/v1/support`. Main `server/src/custom/register.ts` đã chỉ mount public gateway tại `/thruline/v1`. Main cũng đã sửa widget sang canonical public URLs và parser script suffix nhận cả `/thruline/v1/support/widget.js` và legacy suffix để giữ deployment base path. Code018 phải được compose với các thay đổi này; giữ nguyên phiên bản018 mà bỏ main hunk sẽ làm widget gọi404 hoặc mất prefix reverse proxy.

Sửa/merge phải giữ đồng thời citation/redaction/dedup/fresh-retry của018 và canonical URL/parser behavior của main. Regression thực thi widget từ canonical script URL có deployment prefix, kiểm tra mọi default fetch, signed guest renewal, poll/escalation/CSAT và revoked-source transition. Actual HTTP spec018 phải chạy trên app mount mới.

## Vì sao chưa tạo PR

Các tests xanh hiện tại chứng minh code trên baseline cũ, không chứng minh tree sau tích hợp main mới. Không mở PR đang biết có incompatibility với base; không đánh dấu full checks/acceptance khi chưa sync và rerun.

Không merge trực tiếp trên dirty checkout đang có thay đổi018, hai file Kiro và untracked016; không stash/reset/restore các phần đó để ép merge. Coordinator cần giữ backup/inventory và đồng bộ an toàn shared branch; agents không tự làm Git integration. Sau sync, Agent3/4 xử lý đúng ownership theo các prompts round3; reviewer chạy lại actual HTTP/widget/UI/build/lint/migration và full workspace gates rồi mới commit/push/create PR. Không merge PR tự động.
