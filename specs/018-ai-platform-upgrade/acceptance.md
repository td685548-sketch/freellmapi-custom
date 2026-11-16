# Nghiệm thu Spec 018 — AI Platform Upgrade (T138)

Ngày chạy: 2026-11-16. Nhánh `chore/ai-platform-polish`, dựa trên `main` tại PR #81 cộng PR #82 (dọn trạng thái spec). Máy chạy: container Linux, Node 22.23.4, chạy tuần tự từng file test như CI (`--pool=forks --fileParallelism=false`).

## Tóm tắt

| Hạng mục | Kết quả |
|---|---|
| `npm run lint` | Đạt |
| `npm run build` (server, cli, client) | Đạt |
| `npm run test:migrations` | Đạt (3/3) |
| Test bootstrap và hooks | Đạt |
| Test server, toàn bộ | 635/648 file đạt. 13 file lỗi đã được phân loại: 1 file do nhánh này gây ra và đã sửa; 1 file lỗi do tranh CPU, chạy lại thì đạt; 11 file lỗi giống hệt trên `main` sạch trong cùng container (xem mục "Lỗi có sẵn của môi trường") |
| Test server của AI Platform (70 file) và preparse/migration | 101 file / 597 test đạt sau mọi thay đổi |
| Test CLI | 180 đạt, 1 bỏ qua |
| Test client | 127 file / 956 test đạt |
| Docker single-user | 30/30 bước đạt |

## Giai đoạn 1–7

Các bảng kiểm tra trong `quickstart.md` của giai đoạn 1–7 được phủ bằng test tự động, chạy với nhà cung cấp giả lập và máy chủ MCP giả lập. Tất cả đều đạt trên nhánh này:

| Giai đoạn | Bộ test |
|---|---|
| 1 Nền tảng | `regression`, `foundation-regressions`, `flags`, `permissions`, `audit`, `pipeline`, `loopback`, `masking`, `scope`, `wire-*`, `backup-restore` (T033), `db/migrate/ai-platform-base` |
| 2 MCP | 18 file `mcp-*`, `approvals`, `secret-leak` |
| 3 Kiểm soát đầu ra | 15 file `guard-*` |
| 4 Tri thức ngữ nghĩa | 6 file `retrieval-*` |
| 5 Cache prompt | 5 file `cache-*` |
| 6 Chỉ dẫn có phiên bản | `prompt-e2e`, `prompt-store`, `prompt-template` |
| 7 Điều phối | 5 file `flow-*` |
| Client | 10 file test trong `client/src/custom/ai-platform/` |

Chưa chạy bằng tay với nhà cung cấp thật: môi trường này không có API key thật cho model chat, embedding hay nhà cung cấp hỗ trợ cache. Các bước cần tài khoản thật (độ trễ tới ký tự đầu tiên với model thật, tỷ lệ trúng cache thật, chất lượng embedding thật) cần chạy lại trên một deployment có key.

## Giai đoạn 8 — Nghiệm thu toàn bộ

| Bước | Kết quả | Bằng chứng |
|---|---|---|
| Bật cả 6 trụ cột cho một client key | Đạt | `all-pillars.test.ts` (T132). Test này phát hiện và đã sửa lỗi: biến `x-freellm-vars` bị mất trong vòng lặp tool MCP |
| Sao lưu, khôi phục; chỉ mục tự lập lại khi thiếu vector | Đạt | `backup-restore.test.ts` (T133). Đã thêm phần tự dựng lại chỉ mục vì trước đó tính năng này chưa có |
| `translations.test.ts` | Đạt | T137 |
| Đo hiệu năng khi mọi công tắc tắt (ngưỡng 5%) | Đạt, khoảng 0,08% | `overhead-bench.test.ts` (T135): 4,9–6,1 µs mỗi request so với trung vị 6,6–7,4 ms |
| Không lộ bí mật ở mọi trụ cột | Đạt | `secret-leak`, `guard-secret-leak`, `pillars-secret-leak` (T134). Đã sửa lỗi lưu nguyên văn thông báo lỗi embedding có chứa key |
| Single-user trong Docker | Đạt 30/30 | Mục dưới |

## Docker single-user

Image được build từ `Dockerfile` của repo, dùng một bản tạm chỉ khác phần mạng của sandbox:

- base image lấy từ `mirror.gcr.io/library/node:24.22.1-bookworm-slim` (cùng image, Docker Hub trả 429);
- bỏ hai bước `apt-get` vì `deb.debian.org` bị chính sách mạng của sandbox chặn. Không cần trình biên dịch vì `better-sqlite3` có bản dựng sẵn cho amd64; `ca-certificates` chỉ cần cho Turso;
- stage `deps` tin CA của proxy sandbox để `npm ci` tải được gói.

Bước tự kiểm tra trong Dockerfile (`node --input-type=module -e "await import('./server/dist/app.js')"`) đạt.

Script chạy container mới với volume dữ liệu trống, rồi kiểm tra:

| Bước | Kết quả |
|---|---|
| Container khởi động, `/livez` trả lời | Đạt |
| Cài mới báo `needsSetup`; setup code in trong log | Đạt |
| Tạo chủ hệ thống bằng setup code (request từ ngoài container, không phải loopback) | Đạt |
| `GET /api/ai-platform/overview`: 6 trụ cột, đều tắt | Đạt |
| Chủ hệ thống bật rồi tắt một trụ cột, không cần cấu hình quyền | Đạt |
| Hai thay đổi xuất hiện trong lịch sử thay đổi (`/api/audit?area=ai-platform`) | Đạt |
| 9 API đọc của các trụ cột (retention, MCP, retrieval, prompt cache settings và stats, agents, flows, runs, guard events) trả 200 | Đạt |
| Tạo client key; đọc lịch sử prompt; `/v1/models` bằng client key khi mọi trụ cột tắt | Đạt |
| 8 trang dashboard `/ai-platform/{overview, prompts, mcp, output-guard, knowledge, prompt-cache, flows, runs}` hiển thị trong Chromium headless, không có lỗi JavaScript | Đạt |
| Khởi động lại container: đăng nhập lại được, trụ cột vẫn tắt, client key còn | Đạt |

Quan sát giao diện, chưa sửa: nút nổi "Thruline" ở góc phải trên đè lên một phần nút ở đầu trang Flows.

## Lỗi có sẵn của môi trường

Chạy lại 13 file lỗi trong môi trường sạch (`env -i`), không có tiến trình nào khác chạy song song, trên cả `main` sạch (`eb5a496`) và nhánh này:

- 11 file lỗi giống hệt nhau ở cả hai bên, nên không do nhánh này gây ra: `codex-reset-credits`, `deepseek-web-chat`, `gemini-web-chat`, `provider-accounts`, `provider-accounts-advanced`, `provider-accounts-copilot`, `provider-accounts-qoder`, `x-gateway-combos`, `x-gateway-routing`, `x-pricing-and-backup`, `lib/proxy`. CI trên `main` đạt với cùng commit, nên đây là khác biệt của container này. Chưa điều tra thêm.
- `retrieval-bench` (SC-008, độ trễ chat dưới 10% trong lúc lập chỉ mục) lỗi khi Docker build chạy song song. Chạy lại riêng thì đạt ở cả hai bên.
- `db/turso-read-cache` lỗi chỉ trên nhánh này: migration T140 thêm trigger nhưng chưa khai báo trong `TRIGGER_SIDE_EFFECTS`. Đã sửa ở `005fc75`; sau đó đạt.

## Lưu ý cho người chạy lại

- `shared/*.js` là file build bị Git bỏ qua. Nếu còn bản cũ từ lần build trước, Node sẽ nạp nó thay cho `*.ts` mới, gây lỗi 403 về quyền rất khó hiểu trong test. Hãy xóa bằng `git clean -X -f shared/` hoặc chạy lại `npm run build`.
- Khi máy có `HTTPS_PROXY`, gateway gửi request ra ngoài qua proxy (`server/src/lib/proxy.ts`) và bỏ qua lớp fetch giả của test. Nên chạy test với biến proxy đã gỡ, như trên CI.
- `retrieval-bench.test.ts` gọi `api.groq.com` thật trong phép đo SC-008. Trên CI có mạng nên vẫn đạt, nhưng đây là lỗi vệ sinh test: nên chuyển hướng sang nhà cung cấp giả lập như các bộ test khác.
