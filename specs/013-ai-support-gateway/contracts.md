# API Contracts (`013-ai-support-gateway`)

## 1. Console Management API (`/api/x-gateway/support/*`)
Yêu cầu xác thực phiên đăng nhập Console:
- `GET` và các thao tác test/mô phỏng (`/simulate-chat`, `/mint-token`, `/test`, `/query-test`) yêu cầu quyền `use_x_gateway`.
- Các thao tác ghi cấu hình (`POST`, `PATCH`, `DELETE`) yêu cầu quyền `edit_x_settings`.

| Method & Path | Request Body | Response JSON |
| :--- | :--- | :--- |
| `GET /api/x-gateway/support/tenants` | — | `{ tenants: SupportTenant[], sampleSchemaSql: string }` |
| `POST /api/x-gateway/support/tenants` | `{ name, slug?, defaultModel?, systemPrompt?, allowedOrigins?, allowGuest?, rolesConfig?, seedSampleDb?: boolean }` | `201 { tenant: SupportTenant, signingSecret: string }` |
| `PATCH /api/x-gateway/support/tenants/:id` | `Partial<SupportTenantInput>` | `{ tenant: SupportTenant }` |
| `DELETE /api/x-gateway/support/tenants/:id` | — | `{ ok: true }` |
| `POST /api/x-gateway/support/tenants/:id/rotate-secret` | `{}` | `{ tenant: SupportTenant, signingSecret: string }` |
| `GET /api/x-gateway/support/tenants/:id/tools` | — | `{ tools: SupportWebhookTool[] }` |
| `POST /api/x-gateway/support/tenants/:id/tools` | `{ name, description, method?, endpointUrl, headers?, parametersSchema?, allowedRoles, lockUserIdParam?, bypassUserLockRoles?, enabled? }` | `201 { tool: SupportWebhookTool }` |
| `PATCH /api/x-gateway/support/tenants/:id/tools/:toolId` | `Partial<SupportWebhookToolInput>` | `{ tool: SupportWebhookTool }` |
| `DELETE /api/x-gateway/support/tenants/:id/tools/:toolId` | — | `{ ok: true }` |
| `POST /api/x-gateway/support/tenants/:id/tools/:toolId/test` | `{ userId, role, name?, args?: Record<string, unknown> }` | `{ ok: boolean, status: number, effectiveArgs: Record<string, unknown>, data: unknown }` |
| `GET /api/x-gateway/support/tenants/:id/db-sources` | — | `{ dbSources: SupportDbSource[] }` |
| `POST /api/x-gateway/support/tenants/:id/db-sources` | `{ name, driver, connectionUrl?, authToken?, schemaSql?, tablePolicies, maxRows?, enabled? }` | `201 { dbSource: SupportDbSource }` |
| `PATCH /api/x-gateway/support/tenants/:id/db-sources/:sourceId` | `Partial<SupportDbSourceInput>` | `{ dbSource: SupportDbSource }` |
| `DELETE /api/x-gateway/support/tenants/:id/db-sources/:sourceId` | — | `{ ok: true }` |
| `POST /api/x-gateway/support/tenants/:id/db-sources/:sourceId/query-test` | `{ userId, role, name?, sql: string }` | `{ ok: true, rows: Record<string, unknown>[], rowCount: number, rewrittenSql: string, referencedTables: string[] }` |
| `POST /api/x-gateway/support/tenants/:id/mint-token` | `{ userId, name?, email?, role, permissions?, metadata?, ttlSeconds? }` | `{ token: string, context: SupportUserContext }` |
| `POST /api/x-gateway/support/tenants/:id/simulate-chat` | `{ userId, name?, role, permissions?, messages: Array<{role, content}>, model? }` | `{ reply: string, userContext: SupportUserContext, allowedTools: SupportAvailableToolDescriptor[], toolTrace: SupportToolTraceEntry[], modelUsed: string, usage: { prompt_tokens, completion_tokens, total_tokens } }` |

---

## 2. Public Partner Gateway API (`/x/v1/support/*`)

### `POST /x/v1/support/session`
- **Headers**: `Authorization: Bearer <signingSecret>` hoặc `X-Tenant-Secret: <signingSecret>`
- **Body**: `{ tenantKey: string, userId: string, name?: string, email?: string, role: string, permissions?: string[], metadata?: Record<string, unknown>, ttlSeconds?: number }`
- **Response (`200 OK`)**: `{ ok: true, contextToken: string, expiresIn: number, userContext: SupportUserContext }`

### `POST /x/v1/support/chat`
- **Headers**: Hỗ trợ CORS theo `tenant.allowedOrigins`. Có thể truyền `X-Support-Tenant-Key` và `X-Support-Context-Token` qua header hoặc trong JSON body.
- **Body**: `{ tenantKey: string, contextToken?: string, messages: Array<{ role: 'user' | 'assistant' | 'system', content: string }>, model?: string }`
- **Response (`200 OK`)**:
  ```json
  {
    "object": "support.chat.completion",
    "tenant": "shop-demo",
    "model": "auto",
    "userContext": {
      "tenantId": 1,
      "userId": "cust_101",
      "name": "Nguyen Van A",
      "role": "customer",
      "permissions": ["products:read", "orders:read_own"],
      "verified": true
    },
    "allowedTools": [],
    "toolTrace": [],
    "reply": "...",
    "choices": [
      {
        "index": 0,
        "message": { "role": "assistant", "content": "..." },
        "finish_reason": "stop"
      }
    ],
    "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
  }
  ```

### `GET /x/v1/support/widget.js`
- **Response (`200 OK`, `application/javascript`)**: Script nhúng giao diện chat nổi `window.FreeLLMAPISupport.init({ tenantKey, contextToken, endpoint, title })`.
