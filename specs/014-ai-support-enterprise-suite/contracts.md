# API Contracts: AI Support Enterprise Suite (`014-ai-support-enterprise-suite`)

## 1. Admin Console API (`/api/x-gateway/support/*` — Mounted via `xSupportEnterpriseConsoleRouter`)

All Console endpoints require standard X-Gateway admin authentication (`requireAuth` / `requirePermission('x_gateway.support')`).

### 1.1 Knowledge Base & Role RAG
- **`GET /api/x-gateway/support/tenants/:tenantId/knowledge`**
  - Returns `{ ok: true, docs: SupportKnowledgeDoc[] }`
- **`POST /api/x-gateway/support/tenants/:tenantId/knowledge`**
  - Body: `{ id?: string, title: string, category?: string, content: string, tags?: string[], allowedRoles?: string[], enabled?: boolean }`
  - Returns `{ ok: true, doc: SupportKnowledgeDoc }` (HTTP 201)
- **`POST /api/x-gateway/support/tenants/:tenantId/knowledge/seed`**
  - Seeds 4 default role-scoped knowledge documents (Public Shipping FAQ for `['*']`, Customer Loyalty Guide for `['customer', 'staff', 'admin']`, Internal Refund SOP for `['staff', 'admin']`, Executive SLA & Financial Playbook for `['admin']`).
  - Returns `{ ok: true, docs: SupportKnowledgeDoc[] }`
- **`DELETE /api/x-gateway/support/tenants/:tenantId/knowledge/:docId`**
  - Returns `{ ok: true }`
- **`POST /api/x-gateway/support/tenants/:tenantId/knowledge/search`**
  - Body: `{ query: string, role: string, topK?: number, category?: string }`
  - Runs `searchSupportKnowledge` and applies `maskSupportSensitiveData` for `role`.
  - Returns `{ ok: true, matches: SupportKnowledgeChunkMatch[], contextPrompt: string }`

### 1.2 PII & Data Masking Policy
- **`GET /api/x-gateway/support/tenants/:tenantId/masking`**
  - Returns `{ ok: true, policy: SupportMaskingPolicy }`
- **`PUT /api/x-gateway/support/tenants/:tenantId/masking`**
  - Body: `Partial<SupportMaskingPolicy>`
  - Returns `{ ok: true, policy: SupportMaskingPolicy }`
- **`POST /api/x-gateway/support/tenants/:tenantId/masking/test`**
  - Body: `{ text: string, role: string }`
  - Returns `{ ok: true, result: SupportMaskResult<string> }`

### 1.3 Conversations, Escalation Tickets & Action Approvals
- **`GET /api/x-gateway/support/tenants/:tenantId/conversations`**
  - Query: `?status=active|escalated|resolved|closed&userId=...`
  - Returns `{ ok: true, conversations: SupportConversation[] }`
- **`POST /api/x-gateway/support/tenants/:tenantId/conversations/:conversationId/reply`**
  - Body: `{ agentName?: string, content: string, resolveConversation?: boolean }`
  - Appends human agent reply and returns `{ ok: true, conversation: SupportConversation }`
- **`GET /api/x-gateway/support/tenants/:tenantId/tickets`**
  - Query: `?status=...&priority=...`
  - Returns `{ ok: true, tickets: SupportEscalationTicket[] }`
- **`PATCH /api/x-gateway/support/tenants/:tenantId/tickets/:ticketId`**
  - Body: `{ status?: SupportTicketStatus, priority?: SupportTicketPriority, assignedTo?: string, resolutionNotes?: string }`
  - Returns `{ ok: true, ticket: SupportEscalationTicket }`
- **`GET /api/x-gateway/support/tenants/:tenantId/actions`**
  - Query: `?status=pending|approved|rejected|failed`
  - Returns `{ ok: true, actions: SupportPendingAction[] }`
- **`POST /api/x-gateway/support/tenants/:tenantId/actions/:actionId/approve`**
  - Body: `{ reviewedBy?: string, reviewNote?: string }`
  - Reviews action as `'approved'`. If matching webhook tool exists on the tenant, executes it (or records simulated execution result) and returns `{ ok: true, action: SupportPendingAction }`.
- **`POST /api/x-gateway/support/tenants/:tenantId/actions/:actionId/reject`**
  - Body: `{ reviewedBy?: string, reviewNote?: string }`
  - Reviews action as `'rejected'` and returns `{ ok: true, action: SupportPendingAction }`.
- **`GET /api/x-gateway/support/tenants/:tenantId/analytics`**
  - Returns `{ ok: true, analytics: SupportAnalyticsSummary }`

---

## 2. Public Partner API (`/thruline/v1/support/*` — Mounted via `xSupportEnterprisePublicRouter`)

All Public Partner endpoints authenticate the tenant via `X-Support-Tenant-Key` (or `body.tenantKey`) and verify the signed user token via `X-Support-User-Token` (or `body.userToken`) using `verifySupportUserToken`.

- **`POST /thruline/v1/support/knowledge/query`**
  - Body: `{ query: string, topK?: number, category?: string }`
  - Searches knowledge docs allowed for `userContext.role` and masks sensitive text according to tenant's `SupportMaskingPolicy`.
  - Returns `{ ok: true, role: string, matches: SupportKnowledgeChunkMatch[], redactionCount: number }`
- **`GET /thruline/v1/support/conversations`**
  - Returns conversations belonging strictly to `userContext.userId` (or all if `userContext.role` is `'admin'` or `'staff'`).
  - Returns `{ ok: true, conversations: SupportConversation[] }`
- **`POST /thruline/v1/support/conversations/messages`**
  - Body: `{ conversationId?: string, subject?: string, content: string }`
  - Appends customer message to thread (locked to `userContext.userId`) and returns `{ ok: true, conversation: SupportConversation }`.
- **`GET /thruline/v1/support/conversations/:conversationId`**
  - Enforces User-ID ownership check (`getSupportConversationForUser` -> 403 if another customer tries to read it).
  - Returns `{ ok: true, conversation: SupportConversation }`
- **`POST /thruline/v1/support/escalate`**
  - Body: `{ conversationId?: string, subject: string, reason: string, priority?: SupportTicketPriority }`
  - Creates a `SupportEscalationTicket` locked to `userContext.userId` & `userContext.role`.
  - Returns `{ ok: true, ticket: SupportEscalationTicket }` (HTTP 201)
- **`POST /thruline/v1/support/actions/propose`**
  - Body: `{ conversationId?: string, toolName: string, actionSummary: string, payload?: Record<string, unknown> }`
  - Creates a `SupportPendingAction` locked to `userContext.userId` & `userContext.role`.
  - Returns `{ ok: true, action: SupportPendingAction }` (HTTP 201)
- **`GET /thruline/v1/support/actions`**
  - Lists pending/reviewed actions for `userContext.userId` (or all if `admin`/`staff`).
  - Returns `{ ok: true, actions: SupportPendingAction[] }`
