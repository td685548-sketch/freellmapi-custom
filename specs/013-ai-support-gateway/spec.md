# Feature Specification: Multi-Tenant AI Support Gateway (Role-Aware Webhook & Database Connectors)

**Feature Branch**: `feat/9router-integration`  
**Feature Directory**: `specs/013-ai-support-gateway`  
**Created**: 2026-11-12  
**Status**: Approved for Implementation  
**Input**: Biến hệ thống thành cổng AI Support cho phép website của đối tác gọi tới để hỗ trợ khách hàng của họ; AI nhận diện được khách hàng là ai, có quyền (role) gì, và truy cập được vào API Webhook (Cách A) lẫn Database Read-Only của đối tác (Cách B) tùy theo role của người hỏi.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Partner Tenant Registration & Signed User Context (Priority: P1)

Một quản trị viên đăng ký Website đối tác (Tenant) trên cổng X-Gateway, cấu hình danh sách Role (`guest`, `customer`, `staff`, `admin`) và nhận cặp `publicKey` (`pk_sup_...`) + `signingSecret`. Khi khách hàng trên web đối tác chat, backend đối tác ký thông tin người dùng (`userId`, `name`, `role`, `permissions`) thành `contextToken` chống giả mạo gửi kèm lên cổng AI.

**Why this priority**: Là nền tảng xác thực danh tính và quyền hạn (RBAC) bắt buộc trước khi cho phép AI truy cập bất kỳ công cụ hay cơ sở dữ liệu nào.

**Independent Test**: Tạo Tenant, ký `contextToken` bằng `mintSupportUserToken`, xác thực bằng `verifySupportUserToken` và kiểm tra giả mạo chữ ký / hết hạn bị từ chối với HTTP 401.

**Acceptance Scenarios**:
1. **Given** một Tenant hợp lệ, **When** backend đối tác gọi `POST /thruline/v1/support/session` kèm `signingSecret` và `{ userId: "cust_101", role: "customer" }`, **Then** hệ thống trả về `contextToken` đã ký HMAC-SHA256 kèm danh sách quyền của role `customer`.
2. **Given** một `contextToken` bị chỉnh sửa payload (ví dụ đổi `role` từ `customer` sang `admin`), **When** gửi tới `/thruline/v1/support/chat`, **Then** hệ thống từ chối ngay với mã `401 Unauthorized`.

---

### User Story 2 - Mode A: Role-Based Webhook Tools with User-ID Locking (Priority: P1)

Đối tác khai báo các HTTP Webhook Tools (ví dụ `get_customer_orders`, `get_revenue_summary`) với danh sách `allowedRoles` và tham số khóa định danh `lockUserIdParam` (ví dụ `user_id`).

**Why this priority**: Cho phép AI gọi ngược về API của website đối tác để tra cứu dữ liệu thời gian thực mà không cần mở port DB trực tiếp.

**Independent Test**: Thực thi `executeSupportWebhookTool` với role `customer` (bị ép cứng `args.user_id = context.userId`) và role `admin` (`bypassUserLockRoles` được phép tra cứu bất kỳ `user_id` nào).

**Acceptance Scenarios**:
1. **Given** tool `get_customer_orders` có `allowedRoles: ["customer", "admin"]` và `lockUserIdParam: "user_id"`, **When** người dùng `customer` (`userId: "u_1"`) cố tình yêu cầu AI xem đơn hàng của `"u_2"`, **Then** cổng AI tự động ghi đè `arguments.user_id = "u_1"` trước khi gửi request tới Webhook đối tác.
2. **Given** tool `get_revenue_summary` có `allowedRoles: ["admin"]`, **When** người dùng `customer` hoặc `guest` chat, **Then** tool này không xuất hiện trong danh sách công cụ của AI và mọi nỗ lực gọi trực tiếp đều bị chặn với `403 Forbidden`.

---

### User Story 3 - Mode B: Role-Scoped Read-Only Database Access & Row-Level Isolation (Priority: P1)

Đối tác kết nối cơ sở dữ liệu (`sqlite-sandbox` có sẵn dữ liệu mẫu E-Commerce hoặc `sql-http` kết nối DB từ xa) kèm chính sách phân quyền từng bảng (`SupportTablePolicy`: `allowedRoles`, `rowOwnerColumn`, `deniedColumns`).

**Why this priority**: Cho phép AI truy vấn trực tiếp DB của đối tác bằng SQL `SELECT` nhưng vẫn đảm bảo tuyệt đối người hỏi thuộc role nào chỉ đọc được bảng/cột/dòng dữ liệu của role đó.

**Independent Test**: Chạy `validateAndRewriteSupportSql` và `executeSupportDbQuery` với các role `guest`, `customer`, `admin` trên cùng câu lệnh `SELECT * FROM orders`.

**Acceptance Scenarios**:
1. **Given** bảng `orders` có `allowedRoles: ["customer", "admin"]` và `rowOwnerColumn: "user_id"`, **When** `customer` (`userId: "cust_101"`) chạy `SELECT * FROM orders`, **Then** hệ thống tự động viết lại truy vấn thành subquery lọc `WHERE user_id = 'cust_101'` và chỉ trả về đơn hàng của `cust_101`.
2. **Given** bảng `orders` không cho phép `guest`, **When** `guest` truy vấn `SELECT * FROM orders`, **Then** hệ thống trả về `403 Forbidden` (trong khi `guest` vẫn truy vấn được bảng `products`).
3. **Given** câu lệnh chứa từ khóa ghi/phá hủy (`DROP`, `DELETE`, `UPDATE`, `INSERT`, `PRAGMA`, `;`), **When** đi qua bộ kiểm tra SQL, **Then** hệ thống chặn ngay lập tức với `400/403`.

---

### User Story 4 - Web Dashboard (`/thruline/support`), Live Role Simulator & Embeddable Widget (Priority: P2)

Quản trị viên quản lý toàn bộ Tenants, Roles, Webhook Tools, Database Sources & Table Policies ngay trên giao diện Web `/thruline/support`, dùng **Live Role Simulator** để đóng vai `guest` / `customer` / `admin` test trực tiếp và copy mã nhúng `<script src=".../thruline/v1/support/widget.js">`.

**Why this priority**: Đảm bảo toàn bộ tính năng khả dụng và trực quan 100% trên bản Web.

**Independent Test**: Render trang `/thruline/support` trong Vitest, tạo Tenant có tích chọn Seed Sample DB, test SQL theo Role, chạy Simulator Chat và lấy mã nhúng Widget.

---

## Requirements *(mandatory)*

### Functional Requirements
- **FR-001**: Hệ thống PHẢI lưu trữ `signingSecret` của Tenant và `authToken` của DB Source dưới dạng mã hóa AES-256-GCM (`encrypt`/`decrypt`).
- **FR-002**: Hệ thống PHẢI xác thực chữ ký HMAC-SHA256 của `contextToken` bằng `crypto.timingSafeEqual` và kiểm tra thời hạn `exp`.
- **FR-003**: Webhook Connector PHẢI khóa tham số `lockUserIdParam = context.userId` đối với các role không nằm trong `bypassUserLockRoles` và ký request gửi đi bằng header `X-Support-Signature`.
- **FR-004**: Database Connector PHẢI chỉ cho phép câu lệnh `SELECT` đơn lẻ, kiểm tra `allowedRoles` trên mọi bảng trong `FROM`/`JOIN`, ẩn `deniedColumns`, và tự động tiêm điều kiện lọc dòng `rowOwnerColumn = context.userId` cho các role không nằm trong `bypassRowLockRoles`.
- **FR-005**: Endpoint `/thruline/v1/support/chat` PHẢI hỗ trợ vòng lặp thực thi công cụ tự động (Agentic Tool-Calling Loop) và trả về `toolTrace` minh bạch.
- **FR-006**: Tuân thủ nghiêm ngặt quy tắc **Zero-Conflict Modular Design** trong `AGENTS.md`.

## Success Criteria *(mandatory)*
- **SC-001**: 100% các bài test bảo mật phân quyền (`guest` vs `customer` vs `admin`, chống leo thang đặc quyền, chống SQL injection / ghi dữ liệu, chống xem trộm đơn hàng của `userId` khác) đều PASS.
- **SC-002**: Giao diện `/thruline/support` hoạt động đầy đủ trên Web với chức năng tạo mẫu dữ liệu E-Commerce 1-click và trình giả lập Role trực tiếp.
- **SC-003**: Toàn bộ workspace pass `npm run test`, `npm run lint`, và `npm run build`.
