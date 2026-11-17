# Feature Specification: Tách dữ liệu Sandbox & Dọn dẹp phiên thử nghiệm trực tiếp (Spec 025)

**Feature Branch**: `feat/025-live-test-cleanup`

**Feature Directory**: `specs/025-live-test-cleanup`

**Created**: 2026-11-18

**Status**: Hoàn thành — xem [specs/README.md](../README.md)

## Tổng quan

Mở rộng Spec 023 (`023-service-desk-live-test`) để mọi hội thoại, phiếu chuyển tiếp (escalation ticket), hành động chờ phê duyệt và đánh giá CSAT phát sinh từ **Live End-User Test Bridge** đều được gắn cờ `isLiveTest: true` một cách an toàn hoàn toàn ở phía máy chủ (`AsyncLocalStorage`), tự động loại trừ khỏi báo cáo thống kê khách hàng thật (`SupportAnalyticsSummary`, `SupportCsatSummary`, danh sách CSAT mặc định, `SupportCustomerProfile.averageCsat` / `csatCount`), đồng thời cung cấp thống kê Sandbox và nút **"Xóa dữ liệu test" (`Clean Up Test Data`)** theo từng Tenant trong Service Desk Studio.

## Yêu cầu chức năng

- **FR-001**: Cầu nối thử nghiệm (`/api/thruline/support/tenants/:id/service-desk/live-test/*`) bọc toàn bộ luồng xử lý bằng `AsyncLocalStorage` context riêng trên máy chủ; các endpoint công khai thông thường (`/thruline/v1/support/*`) không bao giờ nhận hoặc cho phép client tự truyền `isLiveTest`.
- **FR-002**: Hội thoại tạo mới, phiếu escalate, pending action và đánh giá CSAT xuất phát trong live-test context hoặc gắn với hội thoại `isLiveTest` đều được đánh dấu `isLiveTest: true`.
- **FR-003**: Báo cáo `getSupportAnalyticsSummary`, `getSupportCsatSummary`, `listSupportCsatRatings` mặc định loại trừ dữ liệu `isLiveTest` (có tùy chọn `includeLiveTest?: boolean`), và đánh giá CSAT từ live test không làm sai lệch chỉ số `averageCsat`/`csatCount` trên hồ sơ khách hàng CRM.
- **FR-004**: Người vận hành vẫn thấy hội thoại và phiếu escalation live-test trong Copilot / SLA Queue trong lúc đang thử nghiệm để kiểm chứng trọn vòng đời.
- **FR-005**: Cung cấp `GET` và `DELETE /api/thruline/support/tenants/:id/service-desk/live-test/sandbox` (yêu cầu `use_x_gateway` + `edit_x_settings`) để đếm và dọn sạch giao dịch sandbox của riêng Tenant đó (gồm store conversations/tickets/actions/CSAT và các bảng `x_support_desk_ticket_state`, `x_support_desk_intakes`, `x_support_desk_copilot_jobs`, `x_support_runtime_leases`, `x_support_runtime_turns` tương ứng) mà không đụng tới dữ liệu thật hay tenant khác.
- **FR-006**: Giao diện `SupportWidgetLiveTest` hiển thị bảng `Live Test Sandbox Data` (hỗ trợ EN + VI) với bộ đếm realtime và nút `Clean Up Test Data`.
