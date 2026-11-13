# API Contracts: AI Support Governance, Customer Memory CRM & Outbound Partner Webhooks (`015-ai-support-governance-and-automation`)

## 1. Admin Console API (`/api/thruline/support/*` — Mounted via `xSupportGovernanceConsoleRouter`)

All Console endpoints require standard X-Gateway admin authentication (`requireAuth` / `x_gateway.support`).

### 1.1 Prompt Firewall, Topic Guardrails & Per-Role Quotas
- **`GET /api/thruline/support/tenants/:tenantId/guardrails`**
  - Returns `{ ok: true, policy: SupportGuardrailPolicy }`
- **`PUT /api/thruline/support/tenants/:tenantId/guardrails`**
  - Body: `Partial<SupportGuardrailPolicy>`
  - Returns `{ ok: true, policy: SupportGuardrailPolicy }`
- **`POST /api/thruline/support/tenants/:tenantId/guardrails/evaluate`**
  - Body: `{ text: string, role: string, userId?: string }`
  - Runs `evaluateSupportInputGuardrails` and returns `{ ok: true, evaluation: SupportGuardrailEvaluation }`
- **`GET /api/thruline/support/tenants/:tenantId/quotas/:userId`**
  - Query: `?role=customer`
  - Returns `{ ok: true, quota: SupportQuotaStatus }`
- **`POST /api/thruline/support/tenants/:tenantId/quotas/reset`**
  - Body: `{ userId?: string }`
  - Resets user or tenant quota counters and returns `{ ok: true }`

### 1.2 Customer CRM Profiles & Long-Term Memory
- **`GET /api/thruline/support/tenants/:tenantId/customers`**
  - Query: `?role=...&tier=...&query=...`
  - Returns `{ ok: true, customers: SupportCustomerProfile[] }`
- **`POST /api/thruline/support/tenants/:tenantId/customers`**
  - Body: `{ userId: string, name?: string, email?: string, role?: string, tier?: string, tags?: string[], customAttributes?: Record<string, string | number | boolean>, memoryFacts?: string[] }`
  - Returns `{ ok: true, customer: SupportCustomerProfile }` (HTTP 201)
- **`GET /api/thruline/support/tenants/:tenantId/customers/:userId`**
  - Returns `{ ok: true, customer: SupportCustomerProfile | null, memoryPrompt: string }`
- **`POST /api/thruline/support/tenants/:tenantId/customers/:userId/facts`**
  - Body: `{ fact: string }`
  - Appends fact via `appendCustomerMemoryFact` and returns `{ ok: true, customer: SupportCustomerProfile, memoryPrompt: string }`

### 1.3 CSAT Ratings & Summary
- **`GET /api/thruline/support/tenants/:tenantId/csat`**
  - Query: `?userId=...&minScore=...`
  - Returns `{ ok: true, ratings: SupportCsatRating[], summary: SupportCsatSummary }`

### 1.4 Outbound Partner Event Webhooks & Delivery Logs
- **`GET /api/thruline/support/tenants/:tenantId/webhooks`**
  - Returns `{ ok: true, webhooks: SupportWebhookSubscription[], deliveries: SupportWebhookDelivery[] }`
- **`POST /api/thruline/support/tenants/:tenantId/webhooks`**
  - Body: `{ id?: string, name: string, targetUrl: string, events: SupportPartnerEventType[], enabled?: boolean }`
  - Returns `{ ok: true, webhook: SupportWebhookSubscription }` (HTTP 201)
- **`DELETE /api/thruline/support/tenants/:tenantId/webhooks/:webhookId`**
  - Returns `{ ok: true }`
- **`POST /api/thruline/support/tenants/:tenantId/webhooks/test`**
  - Body: `{ event?: SupportPartnerEventType, payload?: Record<string, unknown> }`
  - Calls `dispatchSupportPartnerEvent` with `allowLocalhost: true` (for admin testing) and tenant's `signingSecret`, returning `{ ok: true, deliveries: SupportWebhookDelivery[] }`.

---

## 2. Public Partner API (`/thruline/v1/support/*` — Mounted via `xSupportGovernancePublicRouter`)

All Public Partner endpoints authenticate the tenant via `X-Support-Tenant-Key` (or `body.tenantKey`) and verify the signed user token via `X-Support-User-Token` (or `body.userToken`) using `verifySupportUserToken`.

- **`POST /thruline/v1/support/guardrails/check`**
  - Body: `{ text: string, tokens?: number }`
  - Step 1: Evaluates `evaluateSupportInputGuardrails(String(tenant.id), { text, userId: userContext.userId, userRole: userContext.role })`. If `!evaluation.allowed`, dispatches `'guardrail.blocked'` partner webhook event and returns HTTP `403` with `{ ok: false, blocked: true, evaluation }`.
  - Step 2: Checks & consumes quota via `checkAndConsumeSupportUserQuota(String(tenant.id), { userId: userContext.userId, userRole: userContext.role, tokens: req.body?.tokens })`. If `!quota.allowed`, returns HTTP `429` with `{ ok: false, quotaExceeded: true, quota }`.
  - Otherwise returns HTTP `200` with `{ ok: true, evaluation, quota }`.
- **`GET /thruline/v1/support/profile`**
  - Query: `?userId=...` (optional; if omitted defaults to `userContext.userId`).
  - Calls `getSupportCustomerProfileForRequester(String(tenant.id), targetUserId, { userId: userContext.userId, role: userContext.role })` (returns `403` if a customer requests another user's `userId`).
  - Returns `{ ok: true, profile: profile ?? null, memoryPrompt: buildCustomerMemoryPrompt(String(tenant.id), targetUserId, userContext.role) }`.
- **`PATCH /thruline/v1/support/profile`**
  - Body: `{ tags?: string[], memoryFacts?: string[], customAttributes?: Record<string, string | number | boolean> }`
  - Updates the caller's own profile (`userId: userContext.userId`, `name: userContext.name`, `email: userContext.email`, `role: userContext.role`) and returns `{ ok: true, profile }`.
- **`POST /thruline/v1/support/csat`**
  - Body: `{ conversationId?: string, score: number, category?: string, comment?: string }`
  - Submits CSAT rating locked to `userContext.userId` & `userContext.role`, dispatches `'csat.submitted'` partner webhook event, and returns `{ ok: true, rating: SupportCsatRating, summary: SupportCsatSummary }` (HTTP 201).
