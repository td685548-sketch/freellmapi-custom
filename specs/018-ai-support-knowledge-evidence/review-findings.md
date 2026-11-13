# Review vòng 1 — BLOCKED

Ngày: 2026-11-13. Branch: `feat/9router-integration`, HEAD khi review: `99b3ba82`.
Phạm vi: thay đổi thực tế của bốn agent cho spec018, gồm cả các file chưa được Git track.

Chưa đạt điều kiện tạo PR. Reviewer không sửa implementation, không commit/push/merge hoặc dispatch agent. Các vị trí dưới đây là vị trí tại thời điểm review; agent phải đọc lại nội dung hiện tại trước khi sửa.

## Findings

### F01 — [P1] Router mới làm hỏng bootstrap server và build

Owner: Agent3. `server/src/custom/x-gateway/support-evidence-router.ts:3`, phần import và schema; `support-evidence-runtime.ts:145`.

`requireAuth` không được export từ `services/auth.ts`; middleware thật nằm ở `middleware/requireAuth.ts`. `importSupportEvidenceRevision` nằm ở evidence store, không phải evidence import module. Các khóa `SUPPORT_EVIDENCE_LIMITS.MAX_*`/`MIN_*` không tồn tại; DTO thực tế dùng camelCase và bounds tương ứng. Root build báo lỗi TypeScript; HTTP suite chết ngay lúc collect tại `router.use(..., requireAuth)` với `argument handler must be a function`. Vì console router import module mới tĩnh, lỗi ảnh hưởng bootstrap ứng dụng, không chỉ endpoint018.

Sửa theo export/DTO thật, không thêm alias giả hoặc nới validation. Xác minh build, plain Node import bản build và actual HTTP suite có chạy assertion.

### F02 — [P1] Required-mode signed turn không lưu được provenance

Owner: Agent3. `server/src/custom/x-gateway/support-runtime.ts:400` và lời gọi lưu evidence ở nhánh generated response (khoảng dòng779).

Hai lời gọi `saveSupportAnswerEvidence` truyền `policyVersion`, `snapshotId`, `status`, `citations` ở top level, trong khi store nhận `{..., evidence: SupportAnswerEvidence}`. Store mã hóa `JSON.stringify(record.evidence)` nên nhận `undefined`. Test no-match thực tế ném TypeError trong `crypto.ts:187`, transaction rollback thay vì trả kết quả zero-model. Nhánh cited/invalid-citation cũng dùng sai shape.

Sửa cả hai nhánh với DTO có kiểu thật; giữ messages, notice, provenance, cache và quota settlement trong cùng transaction. Regression phải kiểm tra no-match, cited, discarded reply, durable history sau cache TTL và accounting; không ép kiểu để che lỗi.

### F03 — [P1] Chuyển policy off cho phép replay câu trả lời đã bị thu hồi

Owner: Agent3. `server/src/custom/x-gateway/support-evidence-runtime.ts:196`.

`assertSupportEvidenceReplay` return ngay khi policy hiện tại là off, trước khi kiểm tra response có provenance018. Đã tái hiện bằng service thật: tạo/publish nguồn customer, lấy pack, thu hồi ACL về admin, đổi policy off, replay cache có evidence cũ; helper trả nguyên `CONFIDENTIAL OLD ANSWER`. Contract yêu cầu mọi cache018 được revalidate, kể cả khi policy đổi; chỉ cache017 không có evidence mới được giữ hành vi off tương thích.

Sửa thứ tự phân nhánh, thêm regression revoke/archive/policy/masking thay đổi rồi replay cùng requestId:409, không gọi provider hoặc charge thêm, không lộ body/citation cũ.

### F04 — [P1] Policy đổi trong lúc generate vẫn chấp nhận câu trả lời theo policy cũ

Owners: Agent3 (orchestration/final transaction), Agent2 (snapshot/validation contract).
`support-evidence-runtime.ts:134`, `support-evidence-retrieval.ts:206` và `:577`.

Finalizer truyền policy chụp trước provider vào validator; snapshot hash chính policy truyền vào, không đọc policy hiện hành. Đã tái hiện: pack lấy ở version2, lưu policy version3 với minCoverage mới, finalize reply có citation cũ vẫn trả `accepted:true`. Việc snapshot có trường policyVersion không giúp nếu so sánh lại với cùng policy cũ. Runtime còn cần snapshot recheck trong transaction commit như contracts.md quy định.

Phối hợp API giữa hai owner, tải/so sánh policy hiện hành và toàn bộ snapshot trước chấp nhận/persist. Test provider deferred: đổi policy trong lúc chờ, sau đó trả valid citation cũ; raw reply không xuất hiện ở public response/history/cache, outcome và phí đúng contract. Không sửa file của owner khác.

### F05 — [P1] Widget không thay câu trả lời đang hiển thị khi history báo redacted

Owner: Agent4. `server/src/custom/x-gateway/support-runtime-widget.ts:714`, nhánh resume tương tự tại `:602`.

Dedup `renderedRequestIds` và `renderedMessageIds` chạy trước xử lý evidence redacted. Sau send thành công, request đã được đánh dấu rendered; các lần poll trả cùng message/request với `status:redacted` bị bỏ qua. Đã chạy script widget thật trong JSDOM: sau7 poll trả redacted, body trả lời cũ và title nguồn vẫn hiện; không có notice thu hồi.

Xử lý cập nhật/redaction theo request/message trước dedup append. Gỡ nội dung/citation card cũ khỏi DOM và thay bằng localized notice; xử lý send/poll/resume nhất quán. Bổ sung test chuyển trạng thái cited -> redacted trên một instance, không chỉ test reload trang mới.

### F06 — [P2] Import deadline không chặn được DNS/body đang treo

Owner: Agent1. `server/src/custom/x-gateway/support-evidence-import.ts:478` và vòng `await reader.read()`.

Timer chỉ abort fetch signal. DNS validation trong safeFetch được await trước fetch và không nhận signal; một DNS promise không settle khiến import không bao giờ trả504. Body reader tương tự chỉ kiểm tra signal trước await. Diagnostic dùng deadline20ms và DNS promise treo: sau100ms vẫn pending. Đây là seam kiểm thử của cùng đường xử lý; không phải lỗi SQLite.

Áp deadline/caller cancellation cho toàn bộ await và processing đến trước commit; kiểm soát cleanup/rejection, ngăn commit sau timeout. Không đổi safe HTTP engine ngoài ownership. Test DNS treo, headers/body treo, caller disconnect, timeout rồi network hoàn tất muộn; published source/version phải còn nguyên.

### F07 — [P2] Normal request close bị coi là client disconnect khi import URL

Owner: Agent3. `server/src/custom/x-gateway/support-evidence-router.ts:331`.

Handler gắn `req.on('close')` và abort nếu response chưa kết thúc. IncomingMessage close cũng xảy ra sau khi request body được đọc xong bình thường; đó không chứng minh client đã ngắt response. Diagnostic bằng HTTP server Node thật, POST body hoàn chỉnh và response trễ30ms, callback này đặt `signal.aborted=true` dù client vẫn nhận response. Remote import đang chờ network có thể bị hủy sai.

Theo dõi disconnect thực sự của response/socket, remove listeners đúng vòng đời. Bổ sung actual HTTP test: normal POST hoàn chỉnh + export chậm thành công, còn client thực sự disconnect không commit muộn. Không chỉ mock Request EventEmitter.

### F08 — [P1] Fixtures sai contract làm các assertion store/import/migration chưa được kiểm chứng

Owner: Agent1. `server/src/__tests__/custom/x-support-evidence-store.test.ts:61`, import test`:39`, migration test`:94` và`:206`.

`createSupportTenant` trả `{tenant, signingSecret}`, nhưng fixtures đọc `.id` trực tiếp thay vì `.tenant.id`. Sau rebuild native SQLite thành công,8/8 store tests,2 import tests và2 populated migration tests vẫn thất bại vì tenantId undefined. Không thể coi encryption, OCC/cap, cascade, alternate adapter hoặc populated rollback đã pass.

Sửa fixtures theo API thật, chạy lại cả native adapter và adapter được spec hỗ trợ, populated up/down/up và các security assertions. Không bỏ/skip test, không biến suite thành mock store.

### F09 — [P1] Runtime test và CI checks còn lỗi độc lập

Owners: Agent3 (server tests/lint), Agent4 (client test).

- Runtime test import `importSupportEvidenceRevision` từ sai module; lỗi xảy ra trước assertion của các luồng cited. Test còn import `upsertSupportMaskingPolicy` không tồn tại và dùng payload không khớp API masking thật (`updateSupportMaskingPolicy` ở support-knowledge). Cần sửa fixture theo production contract, không type cast né validation.
- `server/src/__tests__/custom/x-support-evidence-http.test.ts:35`: unused `guestTokenA` làm root lint fail.
- `client/src/custom/x-gateway/support-evidence.test.tsx:275`: `JSON.parse(init.body)` nhận string|undefined, client `tsc -b` fail dù11 Vitest tests pass. Thu hẹp/kiểm tra body thật trước parse.

Đọc lại toàn bộ test failures sau khi các owner sửa F01/F02; test pass bằng mock chưa chứng minh real HTTP integration. Root tests/build/lint là gate bắt buộc sau sửa.

### F10 — [P2] Studio thiếu workflow sửa ACL nguồn và sửa suite đã lưu

Owner: Agent4. `client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx:182` và`:1228`.

Role selector chỉ có khi tạo nguồn; update mutation không nhận/gửi allowedRoles nên editor không thể thu hồi/cập nhật ACL nguồn hiện có trên UI. Suite chỉ có POST tạo mới và run; không có load/edit/PUT suite đã lưu với expectedVersion. API backend đã có các thao tác này và ownership yêu cầu workflow quản lý đầy đủ.

Thêm ACL editor và suite editor theo contract/OCC, phản hồi409 rõ ràng, EN/VI và tenant partition. Test cập nhật nguồn/suite có sẵn, version conflict và đổi tenant; không thay bằng tạo bản sao để né update.

### F11 — [P2] Xóa rồi thêm evaluation case tạo ID trùng

Owner: Agent4. `client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx:1265`.

ID mới dựa trên length+1. Tạo case_1/2/3, xóa case_2 rồi Add -> lại case_3. Backend từ chối suite do duplicate IDs; UI không cho sửa ID nên thao tác bình thường làm form không lưu được.

Dùng ID ổn định không trùng sau delete/reorder, giữ identity khi sửa existing suite. Thêm regression remove-middle/add/save.

### F12 — [P2] Evaluation có thể báo completed sau khi case cuối vượt budget

Owner: Agent2. `server/src/custom/x-gateway/support-evidence-evaluations.ts:77` và đoạn tính completed/partial sau vòng lặp.

Deadline chỉ được kiểm tra trước case kế tiếp. Case cuối (hoặc suite một case) chạy vượt budget vẫn có thể lưu completed/allPassed=true. Snapshot stability cũng chỉ được kiểm tra khi cùng role xuất hiện lại; không có final recheck cho các role đã xử lý, và result lưu snapshot trước retrieval thay vì đối chiếu pack.snapshotId thực tế. Đây là finding đọc code; các8 test hiện có pass nhưng chưa chứng minh các biên này.

Kiểm tra deadline sau mỗi retrieval/trước lưu; dùng actual pack snapshot, fresh policy và final consistency check cho các role đã dùng. Test last/single case vượt budget và thay đổi snapshot tại case cuối/sau role cuối, phải partial/false với denominator trung thực; không thêm model/network/quota side effect.

## Verification thực tế

| Lệnh/phạm vi | Kết quả |
| --- | --- |
| Root `npm run build` | FAIL: server TypeScript errors, gồm F01/F02; không tới full client build |
| Root `npm run lint` | FAIL: unused guestTokenA trong HTTP test |
| Client `npx vitest run src/custom/x-gateway/support-evidence.test.tsx` | PASS11/11 |
| Client `npx tsc -b` | FAIL: test`:275` string|undefined |
| Scoped client ESLint: page/strings/test/nav/XGatewayApp | PASS |
| Server targeted10 files sau native rebuild |5 files fail/5 pass;20 tests fail/55 pass; HTTP file lỗi collect |
| Retrieval | PASS16/16, gồm fixture dataset |
| Evaluation | PASS8/8; F12 chưa có regression chứng minh |
| Widget existing+new tests | PASS20/20; diagnostic F05 tìm ra thiếu regression |
| Default migration roundtrip/registry-drift | PASS3/3 và2/2 |
| New populated018 migration suite |1 pass/2 fail; chưa đạt |
| `git diff --check` | PASS (tracked diff; có thông báo CRLF/LF) |
| Full root test suite, full013–017 HTTP regression, plain Node built-app import | Chưa được chứng nhận; build/bootstrap đang fail |

Lần đầu server tests bị binary better-sqlite3 không chạy được trên Windows. Reviewer chạy `npm rebuild better-sqlite3` thành công rồi chạy lại toàn bộ10 file ở trên; bảng chỉ tính lần chạy sau rebuild. Không sửa package/lockfile hay implementation để xử lý môi trường.

Logs: `%TEMP%/freellmapi-018-review-{build,lint,client,client-tsc,client-lint,server-native,native}.log`. Diagnostic scripts chỉ ở `%TEMP%/freellmapi-018-review-{repro,widget}.mts`, gọi service/widget thật; không thay production files. Kết quả: policy2->3 vẫn accepted, revoked+off cache replay được, DNS quá deadline vẫn pending, normal request close abort và widget còn text/title sau7 redacted polls.

## Bàn giao và gate tiếp theo

Đưa từng agent prompt sửa tương ứng trong `prompts/fix-agent-1.md` đến `fix-agent-4.md`. Giữ nguyên ownership; F04 cần handshake Agent2/3. Reviewer review lại diff và chạy affected tests rồi full tests/lint/build, migration gates và built app import. Chỉ khi không còn lỗi chặn mới xét đồng bộ main an toàn, review prospective diff và tạo/reuse PR; không tự merge.
