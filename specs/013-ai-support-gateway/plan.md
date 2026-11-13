# Implementation Plan: Multi-Tenant AI Support Gateway

**Branch**: `feat/9router-integration` | **Date**: 2026-11-12 | **Spec**: [`specs/013-ai-support-gateway/spec.md`](./spec.md)

## Summary

Xây dựng hệ thống **Multi-Tenant AI Support Gateway** bên trong X-Gateway (`server/src/custom/x-gateway/` và `client/src/custom/x-gateway/`), cho phép các website bên thứ ba tích hợp dịch vụ AI chăm sóc khách hàng có nhận thức về danh tính người dùng (`userId`, `name`, `role`, `permissions`) và truy cập dữ liệu theo phân quyền qua cả **Webhook/REST Tools (Mode A)** lẫn **Read-Only Database Connectors với Row-Level Security (Mode B)**.

## Technical Context

- **Language/Version**: TypeScript 5.8, Node.js >= 20.18, React 19
- **Primary Dependencies**: Express 5, `better-sqlite3` (in-process SQLite & isolated sandbox DB), `zod` (schema validation), `@tanstack/react-query` (Web UI state)
- **Storage**: SQLite (`getDb()`) với cơ chế lazy auto-bootstrap bảng `x_support_tenants`, `x_support_tools`, `x_support_db_sources` và mã hóa AES-256-GCM (`server/src/lib/crypto.ts`)
- **Testing**: Vitest (`server/src/__tests__/custom/x-support-*.test.ts` & `client/src/custom/x-gateway/support-gateway.test.tsx`)
- **Constraints**: Zero-Conflict Modular Design (tạo các module độc lập, chỉ chạm tối thiểu vào `console-router.ts`, `router.ts`, `permission-actions.ts`, và `XGatewayApp.tsx`).

## Project Structure

### Documentation (this feature)

```text
specs/013-ai-support-gateway/
├── spec.md              # Đặc tả yêu cầu & User Stories (/speckit-specify)
├── plan.md              # Kiến trúc kỹ thuật (/speckit-plan)
├── data-model.md        # Schema SQLite & TypeScript Interfaces dùng chung
├── contracts.md         # Hợp đồng API (/api/x-gateway/support/* & /thruline/v1/support/*)
├── ownership.md         # Ma trận phân quyền file không xung đột cho 4 Agent
├── quickstart.md        # Hướng dẫn chạy kiểm thử & tích hợp
└── tasks.md             # Danh sách tác vụ chia theo 4 Agent (/speckit-tasks)
```

### Source Code (repository root)

```text
server/src/custom/x-gateway/
├── support-store.ts         # [Agent 1] SQLite Store, Tenant CRUD, HMAC Context Token
├── support-connectors.ts    # [Agent 2] Mode A Webhook Executor & Mode B RBAC SQL Engine
├── support-router.ts        # [Agent 3] Console API, Public /thruline/v1/support/* & widget.js
├── console-router.ts        # [Agent 3] Mount xSupportConsoleRouter tại /support
└── router.ts                # [Agent 3] Mount xSupportPublicRouter tại /support

server/src/custom/
└── permission-actions.ts    # [Agent 3] Phân quyền /api/x-gateway/support

client/src/custom/x-gateway/
├── support-strings.ts       # [Agent 4] Từ điển song ngữ EN/VI cho AI Support Gateway
├── pages/SupportGateway.tsx # [Agent 4] Giao diện quản trị & Live Role Simulator
├── XGatewayApp.tsx          # [Agent 4] Thêm mục menu /thruline/support
└── support-gateway.test.tsx # [Agent 4] Kiểm thử giao diện Frontend
```
