# Frozen Data Model & Cross-Agent Interfaces

All HTTP DTOs below belong to `shared/support-runtime.ts` (Agent 1). Import shared types only; do not pull server source into the client bundle. All timestamps are ISO UTC strings. Tenant IDs in public DTOs are numbers, matching SupportTenant; existing 014/015 engines receive String(tenant.id) internally.

## Shared DTOs (exact names)

```ts
export interface SupportRuntimePolicy {
  allowedModels: string[]; // extra requested model selectors; default [] permits tenant.defaultModel only
  toolPolicies: Array<{ toolId: number; mode: 'read' | 'approval_required' }>;
  maxCompletionTokens: number; // integer 1..4096, default 512, per model call
  maxModelCalls: number; // integer 1..3, default 3
  maxToolCalls: number; // integer 0..3, default 3
  maxContextChars: number; // integer 1000..32000, default 16000
  maxToolResultChars: number; // integer 256..16000, default 8000, each result
  maxHistoryMessages: number; // integer 2..100, default 40
}
export interface SupportRuntimeChatInput {
  tenantKey: string;
  contextToken?: string;
  conversationId?: string;
  requestId?: string; // ASCII [A-Za-z0-9_-], 1..128; generate if absent, but replay needs client-supplied ID
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  model?: string;
}
export type SupportActionExecutionStatus = 'pending' | 'executing' | 'succeeded' | 'failed' | 'unknown';
export interface SupportRuntimeMetadata {
  requestId: string;
  conversationId?: string; // absent only for compatible stateless unsigned guest requests
  replayed: boolean;
  replySource: 'model';
  knowledgeDocIds: string[]; // only role-visible docs, no full snippets/raw CRM
  redactionCount: number;
  quota: { requestsUsed: number; tokensUsed: number; resetAt: string; accounting: 'actual' | 'estimated' };
  pendingActions: Array<{ id: string; toolName: string; executionStatus: SupportActionExecutionStatus }>;
}
export interface SupportIntegrationCheck {
  id: 'tenant' | 'origins' | 'model' | 'knowledge' | 'masking' | 'guardrails' | 'quota' | 'approvals' | 'worker';
  status: 'ready' | 'warning' | 'error';
  code: string; // stable machine code; UI localizes, no secret or raw configuration
}
export interface SupportIntegrationReadiness {
  tenantId: number;
  ready: boolean; // no error checks; warnings do not imply a false guarantee
  checks: SupportIntegrationCheck[];
  runtimePolicy: SupportRuntimePolicy;
  embedSnippet: string; // public key + server origin only, never a signing secret or a stored user's token
}
export interface SupportOutboxItem {
  id: string;
  eventId: string;
  event: string;
  webhookId: string;
  webhookName: string;
  status: 'pending' | 'delivering' | 'delivered' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  statusCode?: number;
  lastError?: string; // sanitized, never response body/credentials
  createdAt: string;
}
```

Keep legacy chat success fields unchanged: object, tenant, model, userContext, allowedTools, toolTrace, reply, choices, usage. Add `runtime: SupportRuntimeMetadata`. All these fields, including trace args/results/errors, pass role-specific masking before persistence or response. Preserve structurally valid JSON and unambiguous truncation markers.

## Runtime API (Agent 1)

Server-only exports in `support-runtime.ts`:

```ts
import type { SupportTenant, SupportUserContext, SupportWebhookTool } from './support-store.js';
import type { SupportChatCompletionResult } from './support-router.js'; // TYPE ONLY, no runtime import

export interface SupportGenerationContext {
  tenant: SupportTenant;
  userContext: SupportUserContext;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>; // server-selected, masked
  model: string;
  trustedContext: string; // masked RAG + own CRM, treated as reference data, not instructions
  policy: SupportRuntimePolicy;
  signal: AbortSignal; // 90-second turn deadline; adapters honor cancellation and stale completions are fenced
  maskToolData: (value: unknown) => unknown;
  invokeWebhook: (tool: SupportWebhookTool, args: Record<string, unknown>) => Promise<{
    ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown;
  }>;
}
export function executeSupportTurn(options: {
  tenant: SupportTenant;
  userContext: SupportUserContext;
  input: SupportRuntimeChatInput;
  generate: (context: SupportGenerationContext) => Promise<SupportChatCompletionResult & { usedFallback?: boolean }>;
}): Promise<SupportChatCompletionResult & { runtime: SupportRuntimeMetadata }>;
```

`usedFallback: true` is rejected with 503 by production runtime. Router converts all legacy fallback branches to explicit metadata, rather than allowing a false model-success claim.

Runtime-store exports: `getSupportRuntimePolicy(tenantId: number): SupportRuntimePolicy`, `updateSupportRuntimePolicy(tenantId: number, patch: Partial<SupportRuntimePolicy>): SupportRuntimePolicy`, `consumeSupportGuestSessionIssuance(tenantId: number, trustedClientIp: string): { allowed: boolean; retryAfterSeconds: number }`. Agent 3 passes req.ip under existing proxy trust; helper hashes the IP before persistence. Agent 1 may keep low-level turn/lease methods private. Errors expose `status`, `code`, safe `message`, optional `retryAfterSeconds`; no raw provider/tool error body.

Turn fingerprint includes normalized accepted input, verified role and effective permissions, never the raw token. A replay after privilege reduction cannot return an unmasked old higher-role response. Failed/interrupted turns cache safe error outcomes; they do not silently start a fresh generation under the same request ID. A whole turn has a90-second deadline within the120-second lease. Completion writes are fenced by the original claim token; late/cancelled tasks cannot overwrite newer state or dispatch more tools.

Quota additions in `support-guardrails.ts`: `applySupportQuotaDelta(tenantId: string, input: { userId: string; userRole: string; requestsDelta: number; tokensDelta: number; enforceLimits: boolean }): SupportQuotaStatus`. It is synchronous, validates finite integers, runs under a short transaction, clamps refunds at zero and never silently permits an unbounded negative change from HTTP input. Existing APIs retain their semantics. Runtime-store records reservation/window identity before network work and settles against the same reserved window, never subtracting from a later window. No transaction spans provider await. Actual reported usage is summed across model calls, including fallback attempts with reported usage; otherwise conservatively charge reserved budget and mark estimated. A failed attempt with known zero provider usage may release token reserve but retains its request charge. Crashed/ambiguous turns retain reservation until expiry/reconciliation; never refund an unknown cost automatically.

## Approval / Outbox API (Agent 2)

```ts
export function invokeSupportRuntimeWebhook(options: {
  tenantId: number; context: SupportUserContext; tool: SupportWebhookTool;
  args: Record<string, unknown>; requestId: string; conversationId?: string;
}): Promise<{ ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown }>;
// For approval-required tools: no outbound call; status=202, data={ pendingActionId, executionStatus:'pending' }.

export function reviewAndExecuteSupportAction(options: {
  tenantId: number; actionId: string; decision: 'approved' | 'rejected';
  reviewedBy: string; reviewNote?: string;
}): Promise<SupportPendingAction & { executionStatus: SupportActionExecutionStatus }>;

export function enqueueSupportPartnerEvent(options: {
  tenantId: number; event: SupportPartnerEventType;
  payload: Record<string, unknown>; dedupKey: string;
}): string; // synchronous; returns durable eventId, reuse if dedup key already exists
export function listSupportEventOutbox(tenantId: number): SupportOutboxItem[];
export function retrySupportEventDelivery(tenantId: number, deliveryId: string): void;
export function drainSupportEventOutbox(options?: { now?: number; limit?: number }): Promise<void>;
export function startSupportEventWorker(): () => void; // idempotent start/stop, unref timer, no overlapping drain
```

Export these from their named owned modules: action functions from `support-action-executor.ts`, event functions from `support-event-outbox.ts`. Imports for preexisting types are TYPE ONLY where possible. Reviewer identity comes from authenticated console session, never arbitrary reviewedBy in HTTP body. Restore the original requester's validated role, userId and locked effective arguments for execution; reviewer role does not replace them.

Approval policy resolves from Agent 1 runtime policy. Store toolId + canonical endpoint/method/schema fingerprint and effective argument hash with proposal. Revalidate current tool/schema/role/ownership/endpoint before execution; changed sensitive target/arguments requires re-proposal (409). Legacy proposals without execution snapshot require re-proposal, not simulated success.

Atomic action state machine: pending -> executing -> succeeded | failed | unknown; pending -> rejected decision with no execution. Public decision retains existing pending/approved/rejected/failed compatibility; additive executionStatus carries outcome. First approved decision and action.approved enqueue happen in the claim transaction. A second same decision returns final cached masked result (200) or in-progress conflict (409), never invokes HTTP again. Opposite terminal decision -> 409. Missing/disabled tool -> 422 and zero external calls. After process crash while executing, mark unknown, do not auto-resume side effect.

## Persistence / Migration Ownership

Agent 1: `server/src/db/migrations/20261112_170001_support_runtime_state.ts`:

- `x_support_runtime_turns`: id, tenant_id, user_id, request_id, conversation_id, input_hash, state (processing/completed/failed/interrupted), masked_response_encrypted/iv/auth_tag, created_at, updated_at, expires_at; UNIQUE(tenant_id,user_id,request_id).
- `x_support_runtime_leases`: tenant_id, conversation_id, turn_id, lease_until; UNIQUE(tenant_id,conversation_id).
- `x_support_runtime_reservations`: id, tenant_id, user_id, turn_id UNIQUE, window_start, window_seconds, reserved_tokens, actual_tokens nullable, state, created_at, settled_at nullable.
- Guest issuance throttle: `x_support_guest_issuance` keyed by tenant_id + trusted-client-IP hash + minute window; integer issuance count, expiration. Never store raw IP in diagnostic output.
- Runtime policy uses existing settings namespace `x_support_runtime_policy_v1` by tenant; transactional updates.

Agent 2: `server/src/db/migrations/20261112_170002_support_execution_outbox.ts`:

- `x_support_action_executions`: tenant_id, action_id, tool_id, requester identity snapshot and effective args encrypted/iv/tag, target_hash, args_hash, status, claim_token, result encrypted/iv/tag nullable, reviewer, reviewed_at, updated_at; UNIQUE(tenant_id,action_id).
- `x_support_partner_events`: id stable event UUID, tenant_id, type, dedup_key, payload encrypted/iv/tag, created_at; UNIQUE(tenant_id,type,dedup_key).
- `x_support_partner_deliveries`: id, event_id, tenant_id, webhook_id, target snapshot encrypted if credential-bearing, state, attempts, next_attempt_at, claim_until, last_status_code, sanitized_last_error, created_at, updated_at; UNIQUE(event_id,webhook_id).

Migrations provide reversible up/down and are the only new schema definitions. Memory DB bootstrap calls these same exported migration functions once per current Db instance. No edits to old migrations, no long async transactions. Do not persist raw access tokens, signing secrets, or unmasked raw AI responses in these new tables.

## Delivery Semantics

- Max 5 attempts, backoff 1/5/30/120 seconds after attempts 1..4; 5-second HTTP timeout. Retry network/408/429/5xx; terminal other 4xx; 2xx delivered. Respect bounded Retry-After up to 300 seconds.
- Capture enabled matching subscriptions when enqueueing. Deleted/disabled subscription at send time becomes dead with safe code, not a new destination. No redirect following.
- Stable event envelope `{ id: eventId, event, tenantId, timestamp, payload }`. Signature is HMAC-SHA256 over exact UTF-8 request bytes using the tenant's real secret at send time. Headers include X-Support-Event-Id, X-Support-Delivery-Id and X-Support-Attempt. Retries preserve eventId/body; recipients deduplicate by eventId.
- DNS resolution and actual connection must be bound to the checked public destination; reject private/loopback/link-local/metadata, IPv4-mapped IPv6, disallowed protocols, URL credentials and redirects. Use existing installed HTTP libraries. Server-owned `SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS=1` can enable explicit console test calls only; never public routes or normal worker delivery.
- Existing local deployments may explicitly configure `SUPPORT_TRUSTED_PARTNER_ORIGINS` as a server-owned comma-separated exact-origin allowlist for known private partner API/sql-http targets. No wildcards, no caller-controlled additions and no cloud metadata destinations even under this allowlist. Recheck DNS and pin the actual connection. Default is empty; do not require private-target access for ordinary single-user startup.
- Outbox delivery uses the same safe transport as direct webhook tools, sql-http connector and legacy event test path. There is no hard-coded default signing secret.
- A dead delivery can be manually requeued by authorized console operator; this never re-executes the original action. No automatic retry of action HTTP side effects.
