# Specification — Chặng 3: kiểm soát nội dung đầu ra

## Context

Runtime017 đã có quota, idempotency, approvals, masking;018 có citation validation và lexical retrieval.019 đang có code Copilot trong checkout khảo sát nhưng chưa được xác nhận nghiệm thu. Phần mới bổ sung chính sách output theo tenant, không thay thế các module đó.

## US1 (P1) — Quản trị chính sách

Editor cấu hình mode off/log/enforce, literal blocked terms, giới hạn độ dài và credential redaction. Policy default off. Lưu encrypted, OCC; audit chỉ metadata. Tenant và quyền kiểm tra server-side. Preview chạy engine thật, không model/tool/quota/audit nội dung.

Acceptance: policy save/read/restart; stale version409; invalid400; tenant không tồn tại404; unauth401; thiếu editor403; policy hỏng503, không fallback sang off.

## US2 (P1) — Customer output được kiểm soát

Khi enforce, output bị chặn thay bằng thông báo cố định; credential được redact khi bật. Kiểm tra trước mọi persistence, cache và response alias. Không model repair/retry do output violation; chi phí model đã phát sinh vẫn tính một lần. Existing input masking, guardrails, evidence, approvals giữ hiệu lực cả khi output mode off.

Acceptance: sentinel bị chặn không có trong reply, message aliases, citations/excerpts, trace, history, cache, audit, log; response chỉ có notice an toàn, usage và metadata đã lọc. Business side effects đã xảy ra phải phản ánh đúng, không tự chạy lại/rollback giả.

## US3 (P1) — Replay/history/Copilot

Policy thay đổi giữa generation và commit được áp dụng theo policy mới trong transaction cuối. Replay đã có metadata020 nhưng version thay đổi trả409 output_policy_changed, không tự generate. Replay legacy chưa có metadata phải được kiểm tra theo policy hiện tại trước khi trả. History kiểm tra read-only, dùng role gốc của customer, không nâng quyền staff để tránh kiểm tra. Copilot kiểm tra summary và từng draft trước persistence/return; một artifact bị block thì không trả tập kết quả một phần.

Acceptance: stricter policy không làm lộ nội dung cũ; off không phục hồi raw text đã bị discard; retry không charge lại. Human-agent messages không bị chỉnh sửa bởi policy AI output.

## US4 (P2) — Vận hành

Studio EN/VI có policy, preview và events metadata; trạng thái loading/error/OCC/readonly/đổi tenant rõ. UI mô tả giới hạn literal matching và credential patterns; không hiển thị matched text hoặc raw output trong events.

## Non-goals

MCP Client/discovery/bindings; vector/semantic retrieval; prompt caching; versioned system prompts; agent orchestration; streaming; human reply moderation; raw output retention; tự gửi Copilot; dịch vụ AI moderation.

## Success criteria

All four stories pass composed tests with real peer modules. Default-off regression holds for017/018/019. New migrations reversible on independent in-memory DBs. Full repository test/build/lint and migration gates green; no type suppressions, test skips or mocks of the entire runtime presented as end-to-end proof.
