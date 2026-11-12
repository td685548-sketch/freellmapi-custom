# Concurrent Integration Ownership (`013-ai-support-gateway`)

Để 4 Agent làm việc song song mà không xảy ra bất kỳ xung đột Git nào, mỗi Agent chỉ được phép tạo/sửa đúng các file trong phạm vi của mình:

| Agent | Phạm vi trách nhiệm | Danh sách File sở hữu độc quyền |
| :--- | :--- | :--- |
| **Agent 1** | **Support Tenant Store, HMAC Context Token & RBAC Schema** | - `server/src/custom/x-gateway/support-store.ts` *(Tạo mới)*<br>- `server/src/__tests__/custom/x-support-store.test.ts` *(Tạo mới)* |
| **Agent 2** | **Dual RBAC Data Connectors (Mode A Webhook + Mode B Read-Only SQL Engine)** | - `server/src/custom/x-gateway/support-connectors.ts` *(Tạo mới)*<br>- `server/src/__tests__/custom/x-support-connectors.test.ts` *(Tạo mới)* |
| **Agent 3** | **Support Gateway Routers (`/api/x-gateway/support/*`, `/x/v1/support/*`), Tool Loop & Widget JS** | - `server/src/custom/x-gateway/support-router.ts` *(Tạo mới)*<br>- `server/src/custom/x-gateway/console-router.ts` *(Mount `xSupportConsoleRouter`)*<br>- `server/src/custom/x-gateway/router.ts` *(Mount `xSupportPublicRouter`)*<br>- `server/src/custom/permission-actions.ts` *(Thêm rule `/api/x-gateway/support`)*<br>- `server/src/__tests__/custom/x-support-gateway.test.ts` *(Tạo mới)* |
| **Agent 4** | **Frontend Web Dashboard (`/x/support`), Role Simulator & Embed Snippets** | - `client/src/custom/x-gateway/support-strings.ts` *(Tạo mới)*<br>- `client/src/custom/x-gateway/pages/SupportGateway.tsx` *(Tạo mới)*<br>- `client/src/custom/x-gateway/XGatewayApp.tsx` *(Mount route `/x/support`)*<br>- `client/src/custom/x-gateway/support-gateway.test.tsx` *(Tạo mới)* |

## Quy tắc bắt buộc cho cả 4 Agent
1. **Không cài đặt thêm package mới** vào `package.json` hay `package-lock.json` (dùng các thư viện đã có sẵn: `better-sqlite3`, `node:crypto`, `zod`, `express`, `@tanstack/react-query`, `lucide-react`).
2. **Không sửa đổi file của Agent khác**.
3. Tuân thủ đúng các tên hàm và kiểu dữ liệu đã định nghĩa trong [`data-model.md`](./data-model.md) và [`contracts.md`](./contracts.md).
