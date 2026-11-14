# Research: AI Platform Upgrade

Mọi mục dưới đây dựa trên việc đọc mã ngày 2026-11-13. Chỗ nào chưa xác minh bằng cách chạy được ghi rõ là "cần xác minh" kèm task tương ứng.

## R1. Nơi đặt biến đổi phía yêu cầu

- **Decision**: Một lời gọi `runPreRequest(req, res, profile, endUser)` trong `server/src/middleware/profile-gate.ts`, ngay sau bước chèn tri thức hiện có.
- **Rationale**: Cổng này đã là nơi chạy lọc nội dung (`screenContent`), hội thoại (`applyConversation`), trả lời nhanh (`answerQuickly`), chèn tri thức (`injectKnowledge`) và hạn mức người dùng cuối, trước khi handler upstream đọc `req.body`. Nó đã có `profile` và `endUser`.
- **Alternatives considered**: Sửa từng handler `routes/*.ts` (bốn điểm chạm vào mã upstream, vi phạm nguyên tắc VI). Middleware riêng ở `app.ts` (phải tự phân giải lại client key).
- **Giới hạn**: Yêu cầu dùng khóa hợp nhất hoặc khóa cá nhân (không phải `sk-cp-…`) không đi qua nhánh profile. Ngoài ra, đã xác minh tại `server/src/custom/register.ts` (T016) rằng `profileInferenceGate` chỉ gắn trên `['/v1', '/v1beta']`; các đường dẫn `/thruline/v1` KHÔNG đi qua `profileInferenceGate` và được giữ nguyên không mở rộng auth/scope. Các trụ cột theo client key vì thế chỉ áp dụng cho `/v1/*` và `/v1beta/*` dùng client key (và support tenant), đúng phạm vi spec.

## R2. Nơi đặt biến đổi phía câu trả lời

- **Decision**: `wire/interceptor.ts` bọc `res.write`, `res.end`, `res.json` cho yêu cầu đã được cổng đánh dấu. Bộ chặn nhận diện giao thức từ đường dẫn (cùng bảng mà `knowledge-inject.ts` dùng) và chạy một chuỗi bộ lọc: thống kê cache → trích dẫn → kiểm soát đầu ra.
- **Rationale**: Không sửa handler nào. Câu trả lời từ cache khớp chính xác và từ trả lời nhanh cũng đi qua `res`, nên FR-068 được thỏa mà không cần xử lý riêng.
- **Alternatives considered**: Gọi hàm kiểm tra trong từng handler (bốn điểm chạm, dễ sót khi upstream thêm giao thức). Chỉ hỗ trợ trả lời một lần (không đạt FR-064).
- **Chi tiết SSE**: Mỗi giao thức có một bộ tách sự kiện và một hàm "lấy phần văn bản tăng thêm / thay phần văn bản". Bộ lọc đầu ra giữ lại `hold_chars` ký tự cuối (mặc định 200) hoặc tối đa `max_delay_ms` (mặc định 300 ms) trước khi nhả, để mẫu vi phạm nằm vắt qua hai mảnh vẫn bị bắt. Khi chặn giữa chừng: nhả thông báo thay thế, rồi phát sự kiện kết thúc hợp lệ của giao thức đó.
- **An toàn**: Không nhận diện được giao thức hoặc lỗi phân tích thì cho qua nguyên vẹn (hoặc chặn, nếu chính sách đặt `fail_mode = block`) và ghi cảnh báo.

## R3. Gọi model từ bên trong (vòng lặp công cụ, điều phối, mô hình đánh giá)

- **Decision**: `loopback.ts` gửi HTTP tới `/v1/chat/completions` của chính tiến trình, theo cách `routes/mcp.ts` (`loopbackChatCompletionsUrl`) đang làm cho `ask_freellmapi`. Luôn không phát trực tiếp. Mang nguyên khóa của người gọi và một header nội bộ `x-ai-platform-internal` là HMAC của (run id, độ sâu, thời điểm) bằng khóa sinh ngẫu nhiên lúc khởi động.
- **Rationale**: Thừa hưởng toàn bộ định tuyến, chuỗi dự phòng, Fusion, Combos, hạn mức, ghi nhận sử dụng theo đúng client key và người dùng cuối (FR-086, FR-090) mà không cần gọi vào hàm nội bộ của upstream.
- **Alternatives considered**: Gọi thẳng `routeRequest` trong `services/router.ts` (gắn chặt vào API nội bộ hay đổi của upstream, và bỏ qua hạn mức). Gọi nhà cung cấp trực tiếp (bỏ mất dự phòng).
- **Quy tắc header nội bộ**: chỉ chấp nhận khi kết nối đến từ loopback và HMAC đúng; khi hợp lệ, cổng bỏ qua vòng lặp công cụ, điều phối, kiểm soát đầu ra và hạn mức "một yêu cầu" (token vẫn được tính), và độ sâu vượt 1 thì từ chối. `preparse-guard.ts` phải loại header này khỏi yêu cầu từ ngoài (cần xác minh, T014).
- **Phát trực tiếp cho người gọi**: Câu trả lời cuối được `wire/respond.ts` phát lại thành SSE đúng giao thức. Tiến độ gửi bằng dòng chú thích SSE (`: progress …`) mà client theo chuẩn bỏ qua (FR-087).

## R4. Chuyển tiếp điểm đánh dấu cache

- **Hiện trạng**: `routes/proxy.ts`, `anthropic.ts`, `responses.ts` chỉ đếm vị trí khối có `cache_control` để bộ nén không đụng vào phần đầu. Không tệp nào trong `server/src/providers/` hay `custom/provider-accounts/` tham chiếu `cache_control` khi dựng thân yêu cầu (chỉ `providers/aclide.ts`, `sail.ts` và `provider-accounts/codex.ts` nhắc tới token cache trong phần usage). Chưa xác minh bằng cách chạy rằng khối nội dung dạng mảng có giữ được trường này tới adapter hay không.
- **Decision**: `prompt-cache/breakpoints.ts` xuất `applyCacheBreakpoints(messages, tools, target)` trả về bản sao messages đã chuẩn hóa cho đích: giữ và bổ sung điểm đánh dấu nếu đích hỗ trợ kiểu tường minh, bỏ sạch nếu không. Gọi một lần cho mỗi lần thử, tại điểm trong đường gửi nơi nhà cung cấp và model đã biết.
- **Cần xác minh (T089)**: xác định điểm đó (ứng viên: `lib/fallback-loop.ts`, lớp cơ sở `providers/base.ts`). Nếu không có một điểm chung duy nhất thì dừng và trình bày lựa chọn cho chủ repo trước khi sửa.
- **Danh mục khả năng**: bảng `custom_ai_cache_capabilities` với hàng dựng sẵn và hàng ghi đè. Dựng sẵn ban đầu: họ model Claude qua tài khoản Anthropic và qua cổng tương thích có chuyển tiếp trường này → `explicit`, tối đa 4 điểm; nhà cung cấp tự cache theo tiền tố → `implicit` (không gửi trường, chỉ ghi số liệu); còn lại → `none`. Danh sách cụ thể phải lấy từ tài liệu hiện hành của từng nhà cung cấp tại thời điểm cài đặt (T090), không lấy từ trí nhớ.
- **Tự đặt điểm**: theo thứ tự ưu tiên định nghĩa công cụ → chỉ dẫn hệ thống phía server → khối tri thức cố định; không vượt số điểm tối đa trừ đi số điểm người gọi đã đặt; bỏ qua khối ngắn hơn ngưỡng tối thiểu của nhà cung cấp.
- **Ổn định phần đầu (FR-038)**: mọi khối do server thêm phải có nội dung xác định (không dấu thời gian, không thứ tự ngẫu nhiên) và nằm trước nội dung thay đổi theo yêu cầu. Khối tri thức theo câu hỏi thay đổi mỗi yêu cầu nên luôn đặt sau điểm đánh dấu cuối. `output-savers/apply.ts` đã theo đúng nguyên tắc này và là mẫu tham khảo.
- **Số liệu**: bộ chặn câu trả lời đọc trường usage của từng giao thức (`prompt_tokens_details.cached_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `cachedContentTokenCount`) và cộng vào `custom_ai_cache_usage_daily`. Ước tính tiết kiệm dùng bảng giá `custom/x-gateway/pricing.ts` (đã có cột `cached`, `cache_creation`).

## R5. Chỉ mục ngữ nghĩa

- **Decision**: Vector lưu BLOB Float32 đã chuẩn hóa độ dài trong `custom_ai_embeddings`; mỗi bộ tri thức được nạp vào một `Float32Array` liền khối trong bộ nhớ khi dùng lần đầu, làm mới khi số hiệu phiên bản của bộ đổi. Tìm bằng tích vô hướng vét cạn.
- **Rationale**: 50.000 đoạn × 1.024 chiều là 205 MB nếu nạp hết, nên giới hạn mặc định là 768 chiều (yêu cầu `dimensions` khi model hỗ trợ) và nạp theo bộ, có LRU tổng 256 MB. Vét cạn 50.000 × 768 là khoảng 38 triệu phép nhân, vài chục mili giây trong V8. Không cần phần mở rộng SQLite, không dependency mới, chạy được với Turso vì đường nóng không truy vấn DB.
- **Alternatives considered**: `sqlite-vec` (phần mở rộng native, rủi ro với bản đóng gói desktop và Turso). Dịch vụ vector ngoài (trái giả định "không cần dịch vụ ngoài"). ANN tự viết (không cần ở quy mô này).
- **Embedding**: dùng `runEmbeddings(model, inputs, dimensions)` trong `services/embeddings.ts`, đi qua định tuyến và hạn mức embedding hiện có. Lô 64 đoạn, có lùi khi gặp `EmbeddingsError` kèm `embeddingsRetryAfterSec`.
- **Kết hợp**: Reciprocal Rank Fusion giữa thứ hạng BM25 hiện có (`searchKnowledge` được mở rộng để trả điểm) và thứ hạng vector, k = 60; ngưỡng tối thiểu áp trên độ tương đồng cosine của kết quả tốt nhất.
- **Lùi về từ khóa**: truy vấn embedding có hạn 1.500 ms; quá hạn, lỗi, chưa có chỉ mục hoặc khác model thì dùng nguyên `searchKnowledge` hiện tại.
- **Công việc nền**: bảng `custom_ai_index_jobs`; một vòng lặp trong tiến trình xử lý tuần tự, nhường CPU giữa các lô; khởi động lại thì tiếp tục từ các đoạn còn `pending` (so `content_hash`).
- **Kho tri thức support**: hiện lưu JSON trong `settings` (`x_gateway_support_knowledge_v1`) và chia đoạn lúc truy vấn. Không đổi cách lưu; chỉ mục tham chiếu đoạn bằng `docId#thứ_tự` và `content_hash`, lọc `allowedRoles` sau khi xếp hạng.
- **Trích dẫn (FR-026)**: header `x-freellm-citations` (JSON mã hóa base64url, giới hạn 4 KB) cho mọi kiểu trả lời vì header gửi trước thân; thêm trường `citations` ở gốc JSON với trả lời một lần của giao thức OpenAI và Responses. Client cũ bỏ qua cả hai.

## R6. MCP client

- **Decision**: Viết tay JSON-RPC 2.0 qua Streamable HTTP, phiên bản giao thức `2025-06-18` (cùng phiên bản MCP server hiện có công bố): `initialize` → `notifications/initialized` → `tools/list` (có phân trang `cursor`) → `tools/call`. Chấp nhận thân trả lời `application/json` hoặc `text/event-stream` và lấy thông điệp có `id` khớp. Gửi lại `Mcp-Session-Id` nếu máy chủ cấp; gặp 404 kèm phiên thì khởi tạo lại một lần.
- **Rationale**: Nhất quán với lý do đã ghi trong `routes/mcp.ts` (tránh SDK nặng cho bản desktop và ma trận CI Node 20). `services/search.ts` đã gọi một máy chủ MCP theo đúng cách này.
- **Alternatives considered**: `@modelcontextprotocol/sdk` (dependency mới, kéo theo nhiều gói). Truyền stdio (chạy mã tùy ý trên máy chủ; ngoài phạm vi).
- **Cần xác minh (T034 — đã đối chiếu 2026-11-14)**:
  - **Nguồn chính thức đã đọc**: `https://modelcontextprotocol.io/specification/2025-06-18/basic/transports`, `https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle`, `https://modelcontextprotocol.io/specification/2025-06-18/server/tools`, và bản hiện hành `https://modelcontextprotocol.io/specification`.
  - **Khác biệt giữa bản pin `2025-06-18` và hiện hành**: `2025-06-18` (và `2025-11-25`, thêm chi tiết `stderr`/OIDC/Icons/experimental Tasks) thuộc era **stateful** với Streamable HTTP đơn endpoint, bắt tay `initialize` → `notifications/initialized` (trả `202` không body), `Mcp-Session-Id` và `MCP-Protocol-Version`, `tools/list` (`cursor`/`nextCursor`), `tools/call` (`content[]`, `structuredContent`, `isError`). Bản hiện hành từ `2026-07-28` trở đi chuyển sang lõi **stateless**, bỏ bắt tay `initialize` và session cấp giao thức.
  - **Lựa chọn hỗ trợ**: Pin explicit `MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18']`; fail-closed (`McpTransportError('protocol')`) nếu server negotiate phiên bản khác hoặc wire era khác; không tự thử fallback sang phiên bản/era chưa cài/test. Ghi nhận 404 session chỉ reinitialize một lần ở thao tác read-only/retry-safe, không auto-retry với write `tools/call` đã gửi.
- **SSRF**: mọi lời gọi đi qua `safeFetch` / `validateSafeHttpUrl` / `getSafeUndiciDispatcher` của `custom/x-gateway/support-safe-http.ts` (đã chặn IP riêng, siêu dữ liệu, kiểm tra sau phân giải tên). Chuyển hướng: không tự theo; mỗi bước nhảy được kiểm tra lại, tối đa 3. Ngoại lệ nội bộ là danh sách host do chủ hệ thống đặt.
- **Giới hạn mặc định**: hạn mỗi lời gọi 20 giây, kết quả 256 KB (cắt bớt có đánh dấu), 4 lời gọi đồng thời mỗi máy chủ, 8 vòng công cụ mỗi lượt chat.
- **Chống đổi lén công cụ (FR-047)**: lưu `schema_hash` = SHA-256 của (tên, mô tả, input schema chuẩn hóa). Đồng bộ thấy hash khác hoặc công cụ mới thì trạng thái về `pending`.
- **Tên công cụ**: `mcp__<slug máy chủ>__<tên>`, cắt còn 64 ký tự và thêm hậu tố hash khi trùng. Công cụ người gọi tự khai báo giữ nguyên tên; nếu model gọi công cụ của người gọi thì vòng lặp dừng và trả `tool_calls` đó về cho người gọi như hiện nay (FR-053).
- **Ngắt mạch**: 5 lỗi liên tiếp thì tạm ngưng 60 giây, nhân đôi tới 15 phút.
- **Model không hỗ trợ công cụ**: `custom_model_tool_support` và `agent_compatibility` đã có; nếu không còn model hỗ trợ công cụ thì trả lời không kèm công cụ và gắn header cảnh báo.

## R7. Duyệt hành động và chống thực thi trùng

- **Decision**: Bảng riêng `custom_ai_approvals` với `execution_key` duy nhất, theo đúng mẫu `x_support_action_executions` trong `custom/x-gateway/support-action-executor.ts` (chuyển trạng thái `pending → executing → succeeded | failed | unknown` trong một giao dịch; `unknown` không tự chạy lại).
- **Rationale**: Dùng lại ngữ nghĩa đã được kiểm thử ở spec 017, nhưng không ghi vào bảng của support để hai tính năng không ràng buộc vòng đời của nhau.
- **Alternatives considered**: Ghi thẳng vào bảng support (ràng buộc tenant và khóa ngoại không phù hợp với client key).
- **Trải nghiệm người gọi**: lượt chat kết thúc ngay với thông báo "đang chờ duyệt" cấu hình được và header `x-freellm-run-id`. Sau khi duyệt, lần chạy tiếp tục ở nền tới khi xong. Người gọi lấy kết quả qua `GET /v1/ai/runs/{id}` bằng chính client key đó. Yêu cầu chờ duyệt hết hạn sau 24 giờ (cấu hình được).

## R8. Kiểm soát đầu ra

- **Bộ kiểm tra cục bộ**: từ khóa và chủ đề (chuẩn hóa như `normalizeKeywords` của `services/content-filter.ts`), biểu thức tùy chỉnh (kiểm tra độ dài và thời gian chạy khi lưu để tránh ReDoS), độ dài, PII qua `maskSupportSensitiveText`, rò rỉ chỉ dẫn hệ thống.
- **Rò rỉ chỉ dẫn**: so khớp các đoạn 12 từ liên tiếp (shingle) của chỉ dẫn đang phát hành với câu trả lời sau khi chuẩn hóa khoảng trắng và chữ hoa; ngưỡng mặc định 2 đoạn trùng. Không cần model, chạy được trên luồng.
- **Bộ kiểm tra ngoài**: `services/moderation.ts` (đã có) hoặc mô hình đánh giá gọi qua loopback với tiêu chí bằng lời và câu trả lời bắt buộc dạng JSON `{ "violation": boolean, "reason": string }`. Với luồng, bộ kiểm tra ngoài chạy trên toàn bộ câu trả lời đã đệm, nên bật nó đồng nghĩa trả lời không còn tăng dần; giao diện nói rõ điều này.
- **Sự kiện**: `custom_ai_guard_events`; trích đoạn mã hóa AES-GCM, hết hạn sau 7 ngày, chỉ quyền `view_guard_excerpts` giải mã được. Giới hạn tần suất ghi theo (client key, người dùng cuối, bộ kiểm tra) như lọc đầu vào hiện có.

## R9. Chỉ dẫn có phiên bản

- **Decision**: Bảng `custom_ai_prompt_versions` (bất biến) và `custom_ai_prompt_heads` (con trỏ nháp/phát hành, số hiệu sửa đổi để khóa lạc quan). Khi phát hành, văn bản mẫu của bản phát hành được ghi vào cột hiện có (`client_profiles.system_prompt`, `tenant.systemPrompt`).
- **Rationale**: Đường đọc nóng không đổi và không thêm truy vấn; tắt trụ cột hay gỡ migration thì hệ thống vẫn chạy với chỉ dẫn hiện hành; bản sao lưu cũ vẫn hợp lệ (FR-006, FR-017).
- **Alternatives considered**: Đọc bản phát hành từ bảng mới ở mỗi yêu cầu (thêm truy vấn, và tắt trụ cột làm đổi hành vi).
- **Biến**: cú pháp `{{tên}}` và `{{tên|mặc định}}`; chỉ thay một lượt, giá trị không được quét lại (FR-015); giá trị từ người gọi bị cắt còn 200 ký tự và loại ký tự điều khiển. Chỉ dẫn không chứa `{{` đi qua nguyên vẹn từng ký tự. Biến thay đổi theo yêu cầu (ngày giờ) làm mất ổn định phần đầu cho cache; giao diện cảnh báo, và biến `{{date}}` chỉ chính xác tới ngày.
- **Điểm móc**: một dòng trong `prependSystemPrompt` (`lib/system-prompt.ts`), lấy ngữ cảnh yêu cầu từ `AsyncLocalStorage` của `lib/client-context.ts`.
- **Nguồn giá trị từ người gọi**: header `x-freellm-vars` (JSON, tối đa 2 KB, chỉ nhận các tên đã khai báo trong phiên bản).
- **Di trú**: migration tạo phiên bản 1 trạng thái phát hành cho mọi chỉ dẫn khác rỗng.

## R10. Điều phối

- **Decision**: Engine là máy trạng thái tuần tự trong tiến trình. Hai kiểu: `single` (một agent, vòng lặp công cụ của giai đoạn 2) và `handoff` (agent hiện hành có thêm một công cụ ảo `transfer_to_<agent>` cho mỗi agent được phép chuyển tới; gọi công cụ đó là chuyển giao).
- **Rationale**: Chuyển giao bằng công cụ là mô hình đơn giản nhất mà mọi model hỗ trợ gọi công cụ đều dùng được; không cần bước lập kế hoạch riêng, nhưng agent khởi đầu có thể được viết chỉ dẫn như một planner.
- **Alternatives considered**: Đồ thị tùy ý với nhánh song song (phức tạp, khó giới hạn, ngoài nhu cầu hiện tại). Planner sinh kế hoạch JSON rồi thực thi (thêm một chế độ lỗi; để sau).
- **Cách gọi**: model `flow:<slug>` trên các giao thức chat. Cổng nhận diện tiền tố trước các bước khác; client key phải có trong `custom_ai_flow_grants`. Tiền tố `flow:` chưa bị dùng (`auto:` và `combo:` đã được giữ chỗ trong `combos.ts`); cần thêm `flow:` vào danh sách giữ chỗ khi kiểm tra tên combo (T122, nằm trong tệp custom).
- **Giới hạn mặc định**: 12 bước, 20 lời gọi công cụ, 4 lần chuyển giao, 60.000 token, 120 giây; trần cứng toàn hệ thống 50 bước. Kiểm tra trước mỗi bước, nên vượt token tối đa một bước (SC-013).
- **Phát hiện lặp**: cùng (công cụ, tham số chuẩn hóa) lần thứ 3 thì cắt; chuỗi chuyển giao A→B→A→B thì cắt.
- **Cô lập quyền (FR-081)**: mỗi bước dựng lại danh sách công cụ và nguồn tri thức từ định nghĩa của agent hiện hành; lịch sử chuyển sang agent mới là văn bản đã che, không kèm định nghĩa công cụ của agent trước.
- **Vết chạy**: `custom_ai_runs` và `custom_ai_run_steps`, ghi từng bước ngay khi xong để xem được lúc đang chạy; đầu vào/đầu ra đã che và cắt 8 KB mỗi bước; dọn sau 30 ngày.
- **Gián đoạn**: lúc khởi động, mọi lần chạy còn `running` chuyển `interrupted`; lần chạy `awaiting_approval` giữ nguyên.
- **Hủy**: `AbortController` cho mỗi lần chạy; sự kiện `close` của kết nối người gọi và lệnh hủy từ dashboard cùng kích hoạt; lời gọi loopback và MCP nhận tín hiệu.

## R11. Quyền, audit, sao lưu

- **Xóa scope (T030, quyết định foundation)**: `purgeScope()` là helper lớp ứng dụng, xóa đúng prefix settings bằng so sánh literal; foundation không đăng ký SQL UDF và không tạo trigger gọi hàm JavaScript này. Không tạo trigger tham chiếu các bảng pillar chưa tồn tại. Migration từng pillar sau này phải sở hữu SQL cleanup/trigger cho các bảng của chính nó khi profile bị xóa, hoặc bổ sung hook ứng dụng trong đợt được cấp ownership tương ứng. Không coi việc tự động dọn dữ liệu pillar khi xóa profile là đã triển khai trong foundation.

- **Quyền**: nhóm cha `manage_ai_platform` trong `shared/permissions.ts`; `custom/permission-actions.ts` ủy quyền cho `aiPlatformPermission()` trong module mới để tệp custom cũ chỉ thêm một nhánh. Đường dẫn chưa ánh xạ trả về quyền cha (FR-003), theo đúng quy ước đã ghi ở đầu `permissionForAction`.
- **Audit**: `auditMiddleware` đã ghi mọi thao tác ghi thành công dưới `/api`; chỉ cần `describeRoute` nhận diện vùng `ai-platform`, và `summarize` phải che các trường `authorization`, `headers`, `token`, `secret` (cần xác minh danh sách che hiện có, T028).
- **Sao lưu**: `services/backups.ts` sao lưu mọi bảng trừ danh sách loại trừ, nên bảng `custom_ai_*` tự được bao gồm. Vector có thể rất lớn: thêm `custom_ai_embeddings` vào nhóm "tái tạo được" nếu cơ chế sao lưu cho phép bỏ chọn theo bảng (đã có tham số `tables`); khôi phục thiếu bảng này thì chỉ mục tự lập lại. Bí mật MCP nằm trong bản sao lưu ở dạng đã mã hóa, giống khóa nhà cung cấp hiện nay.
- **Single-user**: khi không có tài khoản thành viên, đường kiểm tra quyền hiện có đã coi chủ hệ thống có mọi quyền; quyền mới không cần xử lý riêng (xác minh bằng test, T019).

## R12. Giao diện

- **Decision**: Ứng dụng con `/ai-platform/*` trong `client/src/custom/ai-platform/`, một mục điều hướng trong `App.tsx` hiện khi có `view_ai_platform`. Chuỗi tiếng Anh ở `strings.ts`, tiếng Việt ở `custom/i18n/vi.ts`; `translations.test.ts` hiện có sẽ bắt khóa thiếu (SC-017).
- **Rationale**: Theo đúng cách Thruline (`XGatewayApp.tsx`) gắn vào dashboard, một điểm chạm.
- **Alternatives considered**: Thêm thẻ vào trang client profile hiện có (rải rác, nhiều điểm chạm hơn). Đặt trong Thruline (trộn hai mô hình quyền).
