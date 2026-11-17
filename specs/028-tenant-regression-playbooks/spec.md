# Feature Specification: Bộ kiểm thử hồi quy theo Tenant (Spec 028)

**Feature Branch**: `feat/028-tenant-regression-playbooks`

**Feature Directory**: `specs/028-tenant-regression-playbooks`

**Created**: 2026-11-18

**Status**: Hoàn thành — xem [specs/README.md](../README.md)

## Tổng quan

Mở rộng Live End-User Widget Testing trong Service Desk Studio (Spec 023, Spec 025, Spec 027) với tính năng **Bộ kiểm thử hồi quy theo Tenant (Per-Tenant Regression Playbooks)**: cho phép người vận hành lưu danh sách các kịch bản kiểm thử (theo từng danh tính/phân quyền RBAC, câu hỏi RAG, guardrail, tool/DB/webhook và từ chối khách) cho riêng từng Tenant và bấm **Chạy toàn bộ (`Run All`)** qua một click trực tiếp qua pipeline runtime thật, tự động dọn sạch dữ liệu phát sinh của lần chạy để không làm sai lệch số liệu production lẫn hội thoại thử nghiệm đang mở trong Widget.

## Yêu cầu chức năng

- **FR-001**: Lưu trữ tối đa 20 kịch bản kiểm thử hồi quy theo từng Tenant (`GET/PUT /api/thruline/support/tenants/:id/service-desk/live-test/playbook`), cô lập hoàn toàn giữa các Tenant và bảo vệ bằng quyền editor (`use_x_gateway` + `edit_x_settings`).
- **FR-002**: Mỗi kịch bản hỗ trợ cấu hình: tiêu đề (`title`), danh tính/phân quyền (`persona`: Guest hoặc Authenticated với `role`, `userId`, `permissions`), tin nhắn thử (`message`), kết quả kỳ vọng (`expectation`: `any_reply`, `cited`, `abstained`, `guardrail_blocked`, `tool_called`, `guest_denied`), và tùy chọn chuỗi cần chứa (`expectedText`) hoặc tên tool (`expectedTool`).
- **FR-003**: `POST /api/thruline/support/tenants/:id/service-desk/live-test/playbook/run` (nhận optional `{ cases }` để chạy thử bản nháp chưa lưu hoặc chạy bản đã lưu) thực thi tuần tự từng kịch bản bên trong `runWithLiveTestContext(tenant.id, ...)` qua `dispatchRuntimeTurn` + `executeSupportChatPipeline`, tự động xử lý `allowGuest = false` (`guest_denied`) và tự động tạo phiếu intake tạm nếu tenant bật `intake.required = true`.
- **FR-004**: Tự động xóa toàn bộ bản ghi phát sinh từ lần chạy playbook (conversations, pending actions, action executions, intakes, runtime leases, runtime turns) qua `purgeSpecificLiveTestRecords` trong khối `finally` mà **không** xóa hội thoại thử nghiệm đang mở trên Widget hay chạm vào dữ liệu production.
- **FR-005**: Giao diện `SupportWidgetLiveTest` bổ sung panel thu gọn **Regression Playbook** (hỗ trợ EN + VI) với nút nạp mẫu khởi tạo (`Load Starter Cases`), thêm/xóa kịch bản, lưu (`Save Playbook`), chạy toàn bộ (`Run All`), và hiển thị bảng kết quả Passed/Failed chi tiết.
