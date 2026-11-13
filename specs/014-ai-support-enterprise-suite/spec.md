# Feature Specification: AI Support Enterprise Suite (Role-Scoped RAG Knowledge Base, PII Masking, Human Escalation & Approval-Gated Actions)

**Feature Branch**: `feat/9router-integration`  
**Feature Directory**: `specs/014-ai-support-enterprise-suite`  
**Created**: 2026-11-12  
**Status**: Approved for Implementation  
**Input**: Mở rộng cổng AI Support (`013-ai-support-gateway`) thành bộ giải pháp Enterprise hoàn chỉnh cho website đối tác:
1. **Role-Scoped Knowledge Base (RAG)** & **PII/Data Masking Engine**: Tài liệu tri thức (FAQ, Chính sách nội bộ, SOP) được phân quyền theo `role` của người hỏi, kết hợp bộ lọc che giấu dữ liệu nhạy cảm (số thẻ, SĐT, email, regex tùy chỉnh) theo từng `role`.
2. **Persistent Conversations, Human Hand-Off (Escalation Tickets) & Approval-Gated Actions**: Lưu lịch sử hội thoại theo từng khách hàng, chuyển tiếp cho nhân viên hỗ trợ thật (Human Agent) khi AI không giải quyết được, và cơ chế **Human-in-the-Loop Approval** đối với các hành động nhạy cảm (như hoàn tiền, hủy đơn, đổi địa chỉ).
3. **Enterprise Support API & Analytics**: Cổng API public `/thruline/v1/support/*` và Console API `/api/x-gateway/support/*` kèm thống kê SLA / tỉ lệ AI tự giải quyết (Deflection Rate).
4. **Support Operations Web Center (`/thruline/support-ops`)**: Giao diện điều hành trực quan trên Web gồm 5 tab chuyên sâu.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Role-Scoped Knowledge Base (RAG) & Dynamic PII Masking (Priority: P1)

Đối tác tải lên các tài liệu tri thức (`SupportKnowledgeDoc`: FAQ công khai, quy trình hoàn tiền nội bộ cho `staff`, báo cáo SLA cho `admin`) và cấu hình quy tắc che giấu dữ liệu nhạy cảm (`SupportMaskingPolicy`).

**Why this priority**: Giúp AI trả lời chính xác quy định của từng doanh nghiệp theo đúng quyền hạn người hỏi và ngăn chặn rò rỉ thông tin nhạy cảm (PII) trong cả dữ liệu DB/Webhook lẫn câu trả lời AI.

**Independent Test**: Thêm các tài liệu có `allowedRoles` khác nhau, chạy `searchSupportKnowledge` với từng role (`guest`, `customer`, `staff`, `admin`) và kiểm tra `maskSupportSensitiveText` / `maskSupportSensitiveData`.

**Acceptance Scenarios**:
1. **Given** tài liệu `"Internal Refund SOP"` chỉ cho phép `["staff", "admin"]`, **When** người dùng có role `"customer"` hoặc `"guest"` tìm kiếm từ khóa `"refund"`, **Then** tài liệu nội bộ không bao giờ được trả về hoặc tiêm vào prompt của AI.
2. **Given** quy tắc che số thẻ tín dụng và SĐT có `unmaskedRoles: ["admin"]`, **When** dữ liệu trả về cho `"customer"` hoặc `"staff"` chứa `"Card: 4532-1122-3344-9988, Phone: 0912345678"`, **Then** hệ thống tự động biến đổi thành `"Card: ****-****-****-9988, Phone: ******5678"`, trong khi `"admin"` vẫn nhìn thấy nguyên bản.

---

### User Story 2 - Persistent Conversations, Human Escalation Tickets & Approval-Gated Write Actions (Priority: P1)

Khách hàng trên web đối tác có thể tiếp tục cuộc trò chuyện cũ (`SupportConversation`), yêu cầu gặp nhân viên thật (`SupportEscalationTicket`), hoặc yêu cầu AI thực hiện thao tác thay đổi dữ liệu cần phê duyệt (`SupportPendingAction`, ví dụ: hoàn tiền đơn hàng).

**Why this priority**: Giải quyết bài toán thực tế quan trọng nhất khi nhúng AI vào sản phẩm: AI không được tự ý chạy lệnh nhạy cảm khi chưa được duyệt, và phải có luồng chuyển giao mượt mà cho nhân viên CSKH thật.

**Independent Test**: Tạo hội thoại, gửi tin nhắn từ khách hàng & nhân viên, tạo ticket leo thang, tạo yêu cầu hành động `issue_refund` ở trạng thái `pending`, sau đó gọi `approveSupportPendingAction` để thực thi và lưu kết quả.

**Acceptance Scenarios**:
1. **Given** khách hàng `cust_101` đang chat trong một `conversationId`, **When** khách hàng khác `cust_202` cố tình truy cập `conversationId` đó, **Then** hệ thống chặn ngay với lỗi `403 Forbidden` (chỉ chủ sở hữu hoặc `staff`/`admin` mới được xem).
2. **Given** hành động nhạy cảm `issue_refund` yêu cầu phê duyệt đối với role `"customer"`, **When** khách hàng yêu cầu hoàn tiền, **Then** hệ thống tạo bản ghi `SupportPendingAction` với `status: "pending"` thay vì gọi trực tiếp, và chỉ thực thi khi `admin`/`staff` bấm **Approve**.

---

### User Story 3 - Support Enterprise API, Public Partner Endpoints & SLA Analytics (Priority: P1)

Cung cấp đầy đủ REST endpoints cho cả Admin Console (`/api/x-gateway/support/*`) và Partner Widget/Backend (`/thruline/v1/support/*`), bao gồm báo cáo chỉ số vận hành (`SupportAnalyticsSummary`: Deflection Rate, Ticket Resolution, Pending Approvals, Role Breakdown).

**Why this priority**: Kết nối tầng lưu trữ tri thức và quy trình phê duyệt với ứng dụng đối tác và giao diện quản trị.

**Independent Test**: Dùng Supertest kiểm thử toàn bộ luồng CRUD Knowledge, Masking Test, Conversation Reply, Escalation Ticket lifecycle, Action Approval/Rejection và Analytics.

---

### User Story 4 - Support Operations Center Web UI (`/thruline/support-ops`) (Priority: P2)

Quản trị viên và đội ngũ CSKH sử dụng trang `/thruline/support-ops` với 5 tab:
1. **Knowledge Base & Role RAG**
2. **PII & Data Masking**
3. **Live Inbox & Escalation Tickets**
4. **Action Approvals (Human-in-the-Loop)**
5. **Support Analytics & SLA**

**Why this priority**: Đảm bảo 100% tính năng Enterprise đều điều khiển và kiểm thử trực tiếp được trên giao diện Web mà không gây xung đột với trang `/thruline/support` của đợt `013`.

---

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: Tìm kiếm tài liệu tri thức (`searchSupportKnowledge`) PHẢI lọc nghiêm ngặt theo `allowedRoles` của `userContext.role` trước khi chấm điểm độ liên quan (BM25/TF-IDF + khớp tag/tiêu đề).
- **FR-002**: Bộ lọc PII (`maskSupportSensitiveText` / `maskSupportSensitiveData`) PHẢI hỗ trợ các bộ nhận diện dựng sẵn (`credit_card`, `email`, `phone`, `api_key`) lẫn biểu thức chính quy tùy chỉnh (`customRules`), và miễn trừ cho các role nằm trong `unmaskedRoles`.
- **FR-003**: Hội thoại (`SupportConversation`) PHẢI khóa quyền truy cập theo `userId` đối với người dùng thường, chỉ cho phép `staff` hoặc `admin` xem toàn bộ hội thoại của Tenant và gửi phản hồi nhân viên (`senderType: "human_agent"`).
- **FR-004**: Các yêu cầu hành động nhạy cảm (`SupportPendingAction`) PHẢI lưu trạng thái `pending` -> `approved` / `rejected`, và khi được `approve` có thể thực thi thông qua Webhook Tool của Tenant hoặc đánh dấu hoàn tất kèm kết quả kiểm toán.
- **FR-005**: Tuân thủ nghiêm ngặt quy tắc **Zero-Conflict Modular Design** trong `AGENTS.md`.

## Success Criteria *(mandatory)*
- **SC-001**: 100% bài test cho cả 4 module (`x-support-knowledge.test.ts`, `x-support-workflows.test.ts`, `x-support-enterprise.test.ts`, `support-enterprise.test.tsx`) đều PASS.
- **SC-002**: Không phát sinh bất kỳ xung đột file nào giữa 4 Agent làm việc song song.
- **SC-003**: Toàn bộ workspace pass `npm run lint` và `npm run build`.
