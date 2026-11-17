# Feature Specification: Duyệt hành động chờ trực tiếp trong Live Test & đồng bộ Widget (Spec 027)

**Feature Branch**: `feat/027-live-test-inline-approvals`

**Feature Directory**: `specs/027-live-test-inline-approvals`

**Created**: 2026-11-18

**Status**: Hoàn thành — xem [specs/README.md](../README.md)

## Tổng quan

Mở rộng Live End-User Widget Testing trong Service Desk Studio (Spec 023 & Spec 025) để người vận hành có thể **xem và phê duyệt (`Approve & Execute`) hoặc từ chối (`Reject`)** các hành động webhook yêu cầu phê duyệt (`approval_required`) phát sinh từ phiên thử nghiệm trực tiếp ngay trong bảng điều khiển bên ngoài Widget, tự động ghi nhận kết quả phê duyệt/từ chối vào lịch sử hội thoại và đồng bộ tức thì lên khung chat Widget người dùng cuối mà không cần chờ chu kỳ polling.

## Yêu cầu chức năng

- **FR-001**: Gắn kết các pending action tạo ở lượt chat đầu tiên với `conversationId` vừa khởi tạo (và giữ nguyên cờ `isLiveTest`) trong `support-runtime.ts` / `support-workflows.ts` để danh sách hành động chờ theo hội thoại luôn đầy đủ.
- **FR-002**: Khi `reviewAndExecuteSupportAction` xử lý duyệt hoặc từ chối lần đầu cho một action có gắn `conversationId` tồn tại trong `x_gateway_support_conversations_v1`, tự động chèn một tin nhắn kết quả (`senderType: 'human_agent'`) vào hội thoại đó mà không ảnh hưởng các lời gọi replay hoặc bài test đơn vị không có hội thoại.
- **FR-003**: Cung cấp endpoint trên cầu nối live test (`/api/thruline/support/tenants/:id/service-desk/live-test`):
  - `GET /pending-actions` (hỗ trợ `?conversationId=...`): chỉ trả về các pending action thuộc phạm vi live-test của đúng tenant.
  - `POST /pending-actions/:actionId/approve` và `POST /pending-actions/:actionId/reject`: xác thực quyền editor (`use_x_gateway` + `edit_x_settings`), kiểm tra action thuộc live-test của tenant (trả `404` nếu không thuộc live-test), và ủy quyền cho `dispatchActionReview`.
- **FR-004**: Khi dọn dữ liệu sandbox (`purgeLiveTestSandboxData`), xóa luôn các bản ghi `x_support_action_executions` tương ứng với các pending action `isLiveTest` đã xóa.
- **FR-005**: Widget canonical (`support-runtime-widget.ts`) cung cấp phương thức `syncConversation()` trên instance để kích hoạt đồng bộ hội thoại ngay lập tức sau khi duyệt/từ chối.
- **FR-006**: Giao diện `SupportWidgetLiveTest` hiển thị khu vực `Pending Action Approvals` (hỗ trợ EN + VI) với thông tin tool, tóm tắt, payload, ô nhập ghi chú duyệt và nút `Approve` / `Reject`; khi thành công sẽ gọi `syncConversation()` và làm mới thống kê sandbox/bảng điều khiển tenant.
