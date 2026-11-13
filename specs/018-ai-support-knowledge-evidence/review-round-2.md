# Review vòng 2 — BLOCKED

Branch `feat/9router-integration`, ngày 2026-11-13. Review thực tế sau khi user báo các agent sửa xong. Không sửa implementation, không dispatch agent, không commit/push/PR/merge.

## Những phần đã sửa được xác minh

- F01: root build pass; plain Node import `server/dist/app.js` và console router pass.
- F02: runtime dùng nested evidence đúng DTO; signed no-match test pass, không còn crypto undefined.
- F03/F04: cache018 sau policy off bị409; deferred provider + đổi policy trả safe abstention. Các regression mới này pass. Runtime generated branch có fresh policy/snapshot check trong commit transaction.
- F05: chạy lại script widget thật trong JSDOM, sau5 poll redacted: body/title cũ đều không còn, revocation notice hiện. Test widget đã bổ sung chuyển trạng thái trên cùng instance.
- F06: unresolved DNS với deadline20ms nay trả import_timeout thay vì treo. Import tests pass; code có abort race và pre-commit check.
- F07: code đã dùng request aborted/response close thay request close; actual HTTP regression vẫn chưa được chứng minh vì fixture HTTP lỗi trước khi server được tạo.
- F08: tenant IDs đã đúng; populated018 migration suite3/3 pass. Store suite vẫn có một lỗi setup khác ở dưới.
- F09: root lint/build, client build và native UI15/15 pass. HTTP fixture vẫn còn nhiều giả định không đúng API/schema thật.
- F10/F11: UI đã có PATCH allowedRoles, load/edit/PUT suite với expectedVersion, lựa chọn format URL và ID case tránh trùng. Native UI15/15 pass.
- F12: có check deadline sau retrieval/trước save, result dùng pack snapshot và final consistency check theo các role; evaluation tests pass trong inventory15 file. Chưa đồng nghĩa chấp nhận toàn bộ PR.

## Findings còn phải sửa

### R2-01 — [P1] Cả5 HTTP tests lỗi fixture trước khi gọi endpoint

Owner: Agent3. `server/src/__tests__/custom/x-support-evidence-http.test.ts:6`,`:43`,`:112`,`:125`.

Lần chạy độc lập lẫn full suite đều lỗi `table users has no column named username` ở INSERT users. Không chỉ đổi tên cột: helper còn dùng role `user` trong khi console role thật là admin/member; import `createSessionToken` và `hashPassword` từ auth service không phải export hiện có; console auth nhận Authorization Bearer/X-Dashboard-Token, không nhận session Cookie. API thật là createUser/createSession (auth.ts); nếu cần hash trực tiếp thì password library là module riêng.

Teardown gọi server.close khi beforeEach chưa tạo server, ném thêm lỗi và bỏ qua restore mocks/env. Toàn bộ5 tests auth/OCC/cross-tenant/chat/replay/eval/disconnect hiện chưa chứng minh được endpoint nào.

Sửa fixture bằng console account/session/auth API thật và cleanup an toàn cả khi setup fail; không đổi production auth/schema để hợp thức hóa fixture. Rerun đến khi5 tests thực sự execute/pass; sau khi qua setup phải xử lý mọi failure tiếp theo, không dừng ở việc đổi cột.

### R2-02 — [P2] Store test chưa khởi tạo settings cho legacy reader

Owner: Agent1. `server/src/__tests__/custom/x-support-evidence-store.test.ts:40` và`:297`.

beforeEach dùng connectDb trên DB rỗng, init crypto và support/evidence tables nhưng không có upstream settings schema. saveSupportEvidenceSuite gọi legacy knowledge reader nên ném `SqliteError: no such table: settings` trước validation disjoint mà test đang mong SupportEvidenceError. Các assertion suite/run/answer encryption phía sau không chạy.

Khởi tạo đầy đủ base schema cần thiết trong fixture/adapter setup theo cơ chế repository. Bảo đảm service contract được test trên supported Db; không bỏ legacy tenant validation, không chỉ đổi expected exception sang SQLiteError hoặc skip test. Giữ populated up/down/up và second-memory-Db coverage.

### R2-03 — [P2] Hai runtime tests có fixture/kỳ vọng trái contract, làm thiếu bằng chứng positive path

Owner: Agent3. `server/src/__tests__/custom/x-support-evidence-runtime.test.ts:211`,`:246`,`:493`, đoạn provider context assertion phía sau.

1. Query `How long do refunds take?` có5 unique tokens nhưng fixture chỉ khớp `refunds`: coverage0.2 < policy minCoverage0.25. Correct outcome là no_matches; generator không được gọi, test không kiểm chứng disableTools/canonical citation/provenance như tên test. Chọn query/content fixture khớp đủ coverage theo công thức spec và assert provider thực sự được gọi; không hạ/đổi thuật toán production để ép pass.
2. Test thay source ACL rồi đọc bằng staff và mong cited. Evidence snapshot ràng buộc role lẫn ACL; staff được phép đọc nguồn hiện tại không có nghĩa câu trả lời cũ theo customer snapshot vẫn hợp lệ. Muốn chứng minh GET không sửa raw storage, inspect raw persisted record riêng, và giữ public-reader redaction theo contract. Không nới snapshot validation.
3. Provider-history assertion sau đó dùng query không match nguồn đã thu hồi và `.catch(() => {})`; callback có thể không chạy, còn assertion failure cũng bị nuốt. Tạo một nguồn hiện hành còn được phép/khớp để buộc provider path, dùng spy/assert số lần gọi và kiểm tra outcome rõ ràng. Không nuốt mọi exception.

Hai failures này lặp lại khi chạy độc lập, không phải nhiễu từ full suite/native binary.

### R2-04 — [P2] Validator mới fallback sang stale/default policy khi storage lỗi

Owner: Agent2. `server/src/custom/x-gateway/support-evidence-retrieval.ts:582` và`:745`.

Cả validateSupportEvidenceReply và validateStoredSupportEvidence catch mọi lỗi getSupportEvidencePolicy rồi dùng policy caller truyền hoặc DEFAULT_EVIDENCE_POLICY. Vi phạm yêu cầu storage corruption fail closed503, không sử dụng policy thay thế. Diagnostic service thật: tạo pack/citation hợp lệ, sửa policy_json thành JSON hỏng; fresh validator vẫn `valid:true` và stored validator vẫn `true` khi truyền policy cũ.

Runtime/sanitizer hiện còn có fresh-policy read bên ngoài nên diagnostic này không khẳng định đã bypass được toàn HTTP runtime. Tuy nhiên chính shared validation boundary không được phép biến lỗi persistence thành verified success; không thêm fallback để giữ fixture cũ pass.

Propagate SupportEvidenceError503/evidence_storage_unavailable theo contract (hoặc trả kết quả fail closed phù hợp đã thống nhất, tuyệt đối không valid:true), bổ sung real-store corrupt/unavailable policy regression cho cả fresh/stored validation. Giữ các positive retrieval tests dùng saved policy thật.

## Verification

- Root `npm run build`: PASS, gồm shared/server/CLI/client TypeScript và Vite.
- Root `npm run lint`: PASS.
- Plain Node import built app/console router: PASS.
- Client native support-evidence test: PASS15/15.
- Targeted isolated server store/runtime/HTTP:3 files failed;8 tests failed/17 passed. HTTP5 fixture failures, runtime2, store1.
- Bounded regression15 server files: **180 passed/8 failed**,12 files pass/3 fail, duration50.62s. Đã chạy toàn bộ6 evidence test files, widget,017 runtime/runtime-http/runtime-gateway/workflows/enterprise và3 migration/registry files. Chỉ3 file store/runtime/HTTP018 fail như mô tả; các file017 liên quan pass.
- Full root `npm run test` sau native rebuild: đã tái hiện8 failures trên; dừng chủ động sau khi xác nhận các blockers, không coi full suite pass hoặc báo tổng kết chưa chạy xong. CLI/client full suite trong root chain chưa được chứng nhận; client018 đã chạy riêng15/15 như trên.
- git diff --check: PASS cho tracked diff (có thông báo CRLF/LF).

Binary better-sqlite3 lại bị thay bằng bản không chạy được trên Windows trong đợt agent work. Đã dừng lần full test ban đầu, `npm rebuild better-sqlite3` PASS rồi chạy lại full root và isolated failures. Chỉ tính kết quả sau rebuild, không sửa manifest/lockfile/application. Các failures trên xảy ra với native dependency đã hoạt động.

Logs ở `%TEMP%/freellmapi-018-r2-{build,lint,test-native,focus,regression,client,native}.log`; diagnostic ở `%TEMP%/freellmapi-018-r2-diagnostic.mts` và script widget vòng1 chạy lại trên code mới. Không để diagnostic trong production.

## Bàn giao

Prompt sửa tiếp theo: `prompts/fix-round2-agent-1.md`, `fix-round2-agent-2.md`, `fix-round2-agent-3.md`. Agent4 chưa có yêu cầu sửa thêm từ vòng này. Giữ ownership. Chưa tạo PR vì test gate chưa đạt và R2-04 chưa được xử lý. Chỉ reviewer xét publication sau rerun đầy đủ; không merge tự động.
