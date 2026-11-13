# Feature Specification: Support Service Desk & Widget Studio

**Branch**: codex/support-service-desk
**Directory**: specs/019-ai-support-service-desk
**Created**: 2026-11-13
**Status**: Implemented; reviewer corrections and local acceptance gates passed.
**Input**: Dọn prompt cũ, viết spec và bốn prompt tiếp theo; reviewer chỉ review sau bàn giao, không tự dispatch/implement.

## User Scenarios & Testing

### US1 — Widget theo thương hiệu và khảo sát trước chat (P1)

Đối tác cấu hình màu, tiêu đề, lời chào, vị trí và câu hỏi gợi ý; khách nhập các trường bắt buộc trước khi bắt đầu hỗ trợ. Thông tin khảo sát là dữ liệu do khách cung cấp, không phải bằng chứng danh tính hay quyền truy cập.

**Independent test**: Lưu cấu hình, tải widget trên một website khác, nhập thiếu/đủ thông tin, bắt đầu chat và tải lại hội thoại.

**Acceptance**:
1. Người có quyền quản lý lưu cấu hình có phiên bản; cập nhật bằng phiên bản cũ báo xung đột.
2. Widget thật hiển thị cấu hình đã lưu; chuỗi độc hại không chạy như mã/HTML. Cấu hình mặc định tắt giữ hành vi hiện tại.
3. Bật khảo sát bắt buộc thì gọi chat trực tiếp không thể bỏ qua; chỉ phiên khách đã được server xác minh mới nộp khảo sát.
4. Khảo sát gắn đúng đối tác, người dùng, vai trò và hội thoại; không thể sửa role/quota/identity qua giá trị form.
5. Lỗi AI/quota không làm mất quyền thử lại khảo sát; lượt chat được nhận lưu metadata cùng hội thoại một lần, kể cả khi trợ lý báo thiếu nguồn.

### US2 — Copilot có nguồn cho nhân viên, không tự gửi (P1)

Nhân viên mở hội thoại thật, yêu cầu bản tóm tắt và ba bản nháp theo phong cách đồng cảm, trực tiếp và kỹ thuật. Họ xem nguồn, chọn bản nháp, sửa và chủ động gửi qua luồng trả lời của nhân viên hiện có.

**Independent test**: Hai khách/đối tác khác nhau; hội thoại có nguồn, không có nguồn, nguồn vừa thu hồi, nhà cung cấp lỗi và yêu cầu lặp lại.

**Acceptance**:
1. Chỉ người được phép quản lý mới gọi Copilot; server chọn hội thoại, role khách và tài liệu hiện hành, không tin lịch sử/role do trình duyệt gửi.
2. Không có nguồn thì trả thông báo không đủ dữ liệu, không gọi AI. Có nguồn thì mọi bản nháp/tóm tắt được trả phải dẫn đúng tài liệu đã cung cấp và còn hợp lệ.
3. Không tự gửi tin, mở ticket, gọi công cụ nghiệp vụ, đọc CRM, hoặc tiêu quota chat của khách. Có ngân sách AI riêng của nhân viên và thông tin usage/model trung thực.
4. Nhà cung cấp lỗi vẫn là lỗi; nội dung không xác minh được bị loại bỏ hoàn toàn. Không dùng câu mẫu giả làm kết quả AI.
5. Đổi nguồn/quyền/lịch sử khi đang tạo hoặc đọc lại kết quả cũ làm kết quả bị giữ lại; yêu cầu lặp không gọi AI/tính phí hai lần.
6. Không công bố phần trăm độ tin cậy, độ đúng ngữ nghĩa hoặc cam kết giảm thời gian xử lý chưa được đo.

### US3 — Định tuyến phòng ban và SLA từ vòng đời ticket thật (P1)

Người quản lý cấu hình thời hạn theo mức ưu tiên và quy tắc phòng ban; đội hỗ trợ thấy hàng đợi với hạn phản hồi/giải quyết, cảnh báo và ticket chưa có dữ liệu theo dõi.

**Independent test**: Tạo ticket, AI trả lời, nhân viên trả lời, đóng/mở lại ticket, đổi ưu tiên và dùng đồng hồ kiểm thử tại các ranh giới thời hạn.

**Acceptance**:
1. Quy tắc xác định và fallback general tạo cùng kết quả trên cùng dữ liệu; thay phòng ban không cấp quyền mới cho bất kỳ ai.
2. AI/system messages không được tính là phản hồi đầu tiên của nhân viên.
3. Đồng hồ bắt đầu từ ticket/cycle hiện hành, không từ thời điểm mở trang; cảnh báo tại75%, vi phạm từ100% thời hạn. Đóng/mở lại và đổi ưu tiên có quy tắc rõ ràng.
4. Đổi chính sách không âm thầm sửa SLA của cycle cũ; ticket trước khi bật theo dõi được ghi rõ chưa theo dõi.
5. Tất cả đường tạo/reply/update ticket hiện có cập nhật trạng thái trong cùng giao dịch; thất bại không để ticket và SLA lệch nhau. Đọc hàng đợi không tạo dữ liệu hay gọi AI.
6. Chưa có phản hồi/không có hội thoại liên kết không được hiển thị như đã đạt SLA.

### US4 — Service Desk Studio cho EN/VI (P2)

Trang /thruline/support-desk có bốn tab Widget & Intake, Copilot, Queues & SLA và Embed. Người vận hành chỉnh cấu hình, thử widget thật, chọn hội thoại/ticket thật, dùng bản nháp thủ công và lấy snippet không chứa secret.

**Independent test**: Cả hai ngôn ngữ, tài khoản không đủ quyền, đổi tenant/phiên khi request còn chờ, stale draft/config và tải lại widget.

**Acceptance**: Chưa có quyền thì không gửi sensitive queries; UI có loading/error/empty/conflict; không hiển thị dữ liệu tenant/phiên cũ; preview không tự chat/gửi khảo sát/call AI; snippet không chứa signing secret hay token người dùng; hỗ trợ deployment prefix và lifecycle017–018.

## Requirements

- FR-001: Bật từng phần là lựa chọn có chủ đích; mặc định widget profile/intake/SLA tắt và các luồng017–018 không đổi.
- FR-002: Cấu hình và intake có version/schema binding, validation có giới hạn, bảo vệ metadata không tin cậy và dữ liệu nhạy cảm được mã hóa/masking.
- FR-003: Khảo sát bắt buộc được kiểm tra ở server cho cả lượt có AI và zero-model, hỗ trợ idempotency, expiry, ownership và tiếp tục hội thoại.
- FR-004: Copilot chỉ sinh kết quả từ lịch sử/tài liệu server đã chọn, không thực thi hành động và chỉ gửi tin khi nhân viên chủ động dùng luồng gửi hiện có.
- FR-005: Ngân sách/claim/lease/cost Copilot có giới hạn, lưu bền và không bị retry/concurrency vượt qua; lỗi và abstention được phân biệt.
- FR-006: Chặn citation cũ, role/tenant sai, policy corruption và lịch sử đã đổi; không cache/lưu/log nội dung AI bị loại bỏ.
- FR-007: Định tuyến có fallback, thứ tự ổn định, manual override có version; SLA24/7 tính từ timestamp được lưu và cập nhật từ mọi write path.
- FR-008: Hàng đợi/report phân trang, không đọc-side backfill; chỉ tính các mẫu thực sự quan sát được và nêu rõ mẫu chưa theo dõi.
- FR-009: UI/served widget đáp ứng EN/VI, an toàn text, abort/epoch, credential renewal, cached-history redaction, manual escalation/CSAT.
- FR-010: Không thêm đường tắt auth, schema giả cho tests, package/lockfile/binary/CI thay đổi hoặc mount URL cũ.

## Key Entities

Widget profile; intake schema/receipt; operator-scoped Copilot job and usage; versioned SLA policy; ticket cycle/routing state. Technical DTOs, lifecycle and exact wire interfaces are frozen in data-model.md/contracts.md.

## Assumptions, scope and edge cases

- Replaces the unimplemented016 design for this work; preserve016 files as reference, do not implement016/019 concurrently.
- Human operations v1 require existing use_x_gateway AND edit_x_settings. No new RBAC permission vocabulary or implicit console-role-to-customer-role mapping.
- Four support roles remain guest/customer/staff/admin; department enum billing/technical/returns/general.
- SLA is elapsed UTC24/7; business-hour calendars, holidays, notification workers and retroactive backfill are deferred. No drag/drop dependency, avatar URL/HTML/CSS injection, CRM binding, macros, automatic sending, streaming, embeddings, SSO or omnichannel in019.
- Consider replay after schema/role changes, two tabs consuming one receipt, outage after dispatch, stale provider results, resolved-without-human-reply, conversation-less tickets, policy version changes, reopen and legacy string tenant fixtures.

## Success Criteria

- SC-001: Every listed acceptance scenario passes with real integrated services; mocks replace external provider/network boundaries only.
- SC-002: Direct chat cannot bypass required intake; cross-tenant/user receipts/drafts and revoked citations never return protected data.
- SC-003: Repeated/concurrent requests create at most one accepted effect and one intended cost; Copilot never changes customer quotas/transcripts by itself.
- SC-004: SLA fixtures cover all4 priorities,4 departments,75%/100% boundaries and create/reply/resolve/reopen/priority paths without retroactive clock resets.
- SC-005: All four UI tabs and actual served widget are verified in EN/VI; old017–018 regressions remain green.
- SC-006: Reviewer verifies builds, lint, all test inventories, migrations and scoped PR diff before conditional PR; implementation starts only in the four separately dispatched agents.
