# Reviewer findings — spec020, 2026-11-15

**Trạng thái tại review ban đầu: CHƯA ĐẠT.** F1–F5 đã được reviewer sửa theo yêu cầu tiếp theo của người dùng; xem [review.md](review.md) cho trạng thái kiểm tra/PR hiện tại. Phần dưới giữ nguyên bằng chứng trước sửa.

Reviewer tìm thấy code ở bốn worktree WSL /home/dotha/wt-support-output-a1..a4. Tất cả cùng HEAD90e45f0630a0c325359a954390371509b20d524a; implementation còn uncommitted. Checkout Windows chính chưa có code020. Không thay đổi code/application worktree nào của các agent.

Bản ghép kiểm tra: /tmp/freellmapi-output-review-fbi3quam trong Ubuntu WSL. Archive từ baseline SHA trên; overlay28 implementation files đúng owner. Agent3 có bản sao shared/store/engine/migration của peers, các bản sao có SHA256 trùng bản owner; reviewer chọn bản owner một lần. Dùng dependencies Linux đã có của Agent1, không cài/sửa package/lockfile. Manifest tại review-manifest.json trong snapshot.

## F1 [P1] Agent3 — bỏ sót text công khai trong tool trace

Source: /home/dotha/wt-support-output-a3/server/src/custom/x-gateway/support-output-runtime.ts:168-212, 592-620.

buildTurnLeaves chỉ thu args/result/output/error/rewrittenSql, bỏ qua name/toolName. Với enforce+redactCredentials, reply và result sạch nhưng trace.name chứa sup_ctx_1234567890abcdef, runtime trả nguyên token và ghi action=allow. History sanitizer khi block content vẫn spread toàn bộ msg, giữ toolTrace cũ. Test qua actual executeSupportTurn và canonical getSupportConversationForUser đã tái hiện cả hai đường.

Sửa: enumerate các trường text công khai (kể cả display tool name, không sửa internal execution identity), sanitize bản presentation trước trả/lưu. Khi block history, bỏ public trace/citation text thay vì giữ trong spread. Kiểm tra cả canonical list, history, provider context và legacy replay. Không chặn/đổi backend execution args để sửa lỗi presentation.

Regression: REVIEW redacts credentials in public trace names; REVIEW strips public trace text on history blocking. Cả2 thất bại đúng tại assertion raw sentinel phải vắng mặt.

## F2 [P2] Agent3 — kiểm chứng lại canonical citation sai định dạng

Source: /home/dotha/wt-support-output-a3/server/src/custom/x-gateway/support-runtime.ts:843-853; support-output-runtime.ts:387-399. Copilot có cùng cách gọi validator tại support-agent-copilot.ts:865-906.

018 đã chuyển marker [cite:cit_...] thành [1]. Khi020 redact text, code đưa canonical text [1] vào finalizeSupportEvidenceTurn/validateSupportEvidenceReply; validator018 chỉ nhận [cite:...], nên câu trả lời hợp lệ có nguồn không đổi bị chuyển thành invalid_citations/knowledge_abstention. Test bàn giao đang assert abstention, vô tình cố định lỗi này.

Sửa: ánh xạ numeric marker về candidate ID đúng từ provenance/pack trước revalidation hoặc dùng một helper validate canonical representation rõ ràng. Giữ ordinal, ACL, snapshot và provided candidates; không bỏ validator hoặc chấp nhận citation tự tạo. Sau kiểm chứng không được phục hồi credential trong title/excerpt đã redact.

Regression: REVIEW valid cited answer survives credential redaction, lấy setup test bàn giao, đổi kỳ vọng sang giữ cited answer/citation hợp lệ sau khi token đã được che. Thực tế abstained. Cần bổ sung kiểm chứng tương tự cho từng Copilot artifact.

## F3 [P2] Agent3 — audit Copilot commit tách khỏi kết quả/job fencing

Source: /home/dotha/wt-support-output-a3/server/src/custom/x-gateway/support-agent-copilot.ts:819-847, 935-976; support-output-runtime.ts:683-690.

evaluateSupportCopilotArtifacts(recordEvent:true) tự insert/commit audit trước finishSupportDeskCopilot/failSupportDeskCopilot, không có outer transaction bao cả policy read/evaluation/audit/job finalization. Test fault injection bằng SQLite BEFORE UPDATE trigger từ chối final completed write: generation ném lỗi, job chưa complete nhưng audit observe vẫn còn. Đây không đạt hợp đồng atomic safe persistence/audit; policy update từ connection khác cũng không có một final transaction chung để serialize với quyết định020.

Sửa: đặt latest policy evaluation, final visible result và event/job finalization dưới cùng một synchronous transaction trên cùng Db, giữ lease token và actual/conservative usage. Chi phí model có thể đã được settle hợp lệ trước finalization; đừng refund lại hoặc rollback giả remote cost. Có thể cần reviewer cho phép hook nhỏ vào019 store, không tự widen ownership.

Regression: REVIEW audit rolls back when Copilot final persistence fails: kỳ vọng event[] khi final transaction fail, thực tế còn1 observe event.

## F4 [P2] Agent2 — Bearer token ngắn không được redact như hợp đồng

Source: /home/dotha/wt-support-output-a2/server/src/custom/x-gateway/support-output-engine.ts:46-49.

Regex bắt đầu từ8 ký tự; Authorization: Bearer abc123 vẫn nguyên và action allow dù enforce+redactCredentials=true. contracts.md nêu nonempty Bearer token values; không có thay đổi scope được reviewer chấp nhận cho ngưỡng8. Ghi hạn chế trong engine không tự sửa được hợp đồng đã freeze.

Sửa: finite Bearer token grammar phải bắt token không rỗng theo hợp đồng, không ăn trailing punctuation/text ngoài token. Test1..7 ký tự,8+, padding, CRLF và token redaction idempotency. Nếu muốn thu hẹp hợp đồng vì false positives phải báo reviewer, không âm thầm đánh dấu đạt.

Regression: REVIEW redacts nonempty short Bearer tokens per contract thất bại vì abc123 còn trong leaves.

## F5 [P2] Agent4 — giới hạn256KiB được áp sau global JSON parser

Source: /home/dotha/wt-support-output-a4/server/src/custom/x-gateway/support-output-router.ts:64-108; baseline server/src/app.ts:209-225.

App đã express.json(limit10mb) trước custom console router. Vì vậy route parser/re-serialization không giới hạn bytes trước parse như hợp đồng. Test HTTP app thật với300000 space + malformed JSON trả400 do parser lỗi (và log parse error), thay vì413 từ byte limit; body đã bị consume/parse trước khi router chạy. Test bàn giao chỉ gửi oversized JSON hợp lệ nên không phát hiện ordering.

Sửa: báo reviewer exact hook cần thêm ở preparse layer để áp route-specific256KiB trước global parser, gồm chunked/compressed input theo semantics byte cap đã chọn. Không thay global limit hoặc giả rằng content-length/JSON.stringify sau parse đủ. Bổ sung raw HTTP malformed/whitespace/chunked tests; giữ auth/host gates.

Regression: REVIEW enforces byte cap before attempting JSON parsing: actual400, expected413.

## Verification evidence

- Owned backend020 + new migration tests: **7 files,53 tests pass**, exit0.
- Existing migration roundtrip: **3/3 pass**, exit0.
- Full workspace build: **pass**, exit0 (server/shared, CLI, client).
- Root lint (server + CLI): **pass**, exit0.
- New Studio UI: **5/5 pass** in full client run.
- Full client test run: **121 files pass,1 file fail;902 tests pass,1 timeout** in existing granular-permissions.test.tsx. Failed test rerun in isolation: pass. This is NOT reported as a green full run.
- Review-only new failing regressions: **6 failures**, spread across5 findings. Runner -t REVIEW intentionally does not execute copied unrelated tests; displayed filtered skips are not production skips.
- Suspected tenant-switch reload race was tested; reproduction passed, so **not a finding**.
- Full npm run test across server/CLI/bootstrap/hooks has NOT been run; no final acceptance/CI/PR claim. Re-run all gates after corrections. check:i18n did not run in the failing client npm script.
- Browser visual acceptance and production rollout not performed.

The six reproduced failures have been incorporated into the owned020 test suites; the original review-only copies remain in the source chat workspace and were not committed as duplicate tests. They were executed only inside the isolated snapshot, not added to agent application code. Raw values used in tests are synthetic.

## Owner routing / next gate

Agent2: F4. Agent3: F1/F2/F3. Agent4: F5. Agent1: no blocking persistence finding found in this review; this does not waive final whole-workspace checks.

Keep current ownership and coordinate requested019-store/preparse exceptions through reviewer. Do not weaken assertions, suppress types, skip tests or change policy modes to hide failures. After fixes, reviewer rebuilds a fresh merged snapshot from exact owner revisions, re-runs six regression cases plus owned tests and full gates before PR. No auto-merge.
