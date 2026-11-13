# Runtime Integration HTTP & Widget Contracts

Canonical DTOs: [data-model.md](data-model.md). Preserve existing route prefixes and 013–015 endpoints; no replacement public API version.

## Trust Boundary / Common Errors

- Public tenant key: X-Support-Tenant-Key or body.tenantKey. Token: X-Support-Context-Token or X-Support-User-Token or body.contextToken/body.userToken. Reject any conflicting nonempty values with 400 `conflicting_identity`; never let body override a conflicting header.
- If Origin is present, match exact normalized origin against tenant.allowedOrigins; `*` and empty list retain existing open-origin intent. For configured allowlist, denied Origin gets 403, including preflight. Unknown tenant cannot obtain a wildcard credentialed preflight. Missing Origin supports server-to-server requests; CORS does not replace authentication.
- Errors: `{ error: { code: string, message: string }, requestId?: string }`. Use 400 invalid_input, 401 invalid_context_token, 403 origin_denied / guardrail_blocked / ownership_denied, 409 request_conflict / turn_in_progress / conversation_busy / action_conflict, 422 tool_unavailable, 429 quota_exceeded / guest_session_rate_limited, 503 model_unavailable / generation_failed / atomic_storage_unavailable. Set Retry-After where known.
- Error messages, evaluation matches and retry output pass masking; never include raw user prompts/provider credentials in error text.

## Public Partner Routes

### POST /thruline/v1/support/guest-session (NEW)

Body `{ tenantKey: string }`. Requires enabled tenant with allowGuest; no signing secret. Reject body claims for userId, role, permissions. Server mints `guest_<randomUUID>` identity, role guest, configured guest permissions and TTL 900 seconds. Response `{ ok:true, contextToken, expiresIn:900, userContext }`. Rate limit 20 issuances/tenant/trusted client IP per minute in durable storage. Honor existing proxy trust; no arbitrary X-Forwarded-For parsing. Distinct sessions never share an identity. No signed privileged claims are created by this endpoint.

### POST /thruline/v1/support/chat (EXTEND EXISTING)

Input SupportRuntimeChatInput, plus accepted identity token aliases above. Limit total message content to 64000 chars, at most 100 messages, each <=16000 chars; role is user/assistant only, last nonempty message must be user. Reject system/developer/unknown role messages. For existing conversation, use only final user message from client; server loads authoritative previous history. For new conversation, ignore client assistant history for model context and accept the final user message. Never persist client-supplied assistant text.

Signed requests create/resume persistent conversation and return existing success response + runtime metadata. Client retries send same requestId and identical normalized body; replay does not reserve/charge quota again, append messages or execute tools. Same ID/different fingerprint ->409; processing ->409; completed ->200 cached response with runtime.replayed=true. Idempotency namespace includes verified tenant and user. Busy conversation ->409, no extra quota charge. An expired/interrupted turn never automatically replays unknown actions.

Unsigned guest compatibility: permitted only if allowGuest; no conversationId, no persistent CRM/history or user-specific tools/DB, no action proposals. Widget uses guest-session instead. Guest user IDs cannot be accepted from request body.

Runtime enforces policy before AI even if website never calls /guardrails/check. Existing /guardrails/check remains a legacy explicit consuming endpoint; integrations must not call it as a mandatory preflight before chat, to avoid double charging. Chat uses its own single reservation, not that endpoint.

Model override allowed only if equal to tenant.defaultModel or listed in runtime policy. Set trusted context and output caps through provider adapters; no client-set accounting or bypass fields. Return503 if no eligible provider or generation fails; old deterministic fallback is not a production success. The pipeline's internal fallback path must still honor data/approval hooks when exercised in isolated tests.

### Existing workflow routes (WIRE, DO NOT DUPLICATE)

- GET /conversations and GET /conversations/:id: verify owner; mask returned messages for viewer. Widget polls selected conversation while visible for staff replies, with cancellation/backoff.
- POST /escalate: verify conversation belongs to caller, create ticket and conversation transition + ticket.created enqueue atomically. Actual status change to resolved in console -> ticket.resolved. Repeating same already-resolved update does not emit another event.
- POST /actions/propose: creates a safe proposal with execution snapshot through Agent 2 service; never a bypass of approval or locked args. Legacy proposals lacking a snapshot require re-proposal before execution.
- POST /csat: verify referenced conversation ownership before rating; rating/profile update + csat.submitted enqueue in one transaction.
- POST /guardrails/check: guardrail.blocked event enqueue, no public allowLocalhost override. Runtime blocked chat uses same event contract, not an awaited HTTP send.
- Enterprise/CRM public endpoints continue to require signed tokens; guest-session tokens are valid guest identities, subject to normal role filters.

## Console Routes

All routes require existing console auth and use_x_gateway. Mutations require edit_x_settings. Reviewer identity for action decisions comes from req.user/session, not JSON body.

| Route | Contract |
| --- | --- |
| GET /api/x-gateway/support/tenants/:id/runtime | `{ ok:true, readiness:SupportIntegrationReadiness }`; no external AI/HTTP side effects |
| PUT /api/x-gateway/support/tenants/:id/runtime | Body Partial<SupportRuntimePolicy>; reject unknown keys, duplicate tool IDs, wrong-tenant tool IDs and invalid bounds; response `{ok:true, policy}` |
| GET /api/x-gateway/support/tenants/:id/outbox | `{ok:true, items:SupportOutboxItem[]}`; default newest100, optional validated limit 1..100 |
| POST /api/x-gateway/support/tenants/:id/outbox/:deliveryId/retry | Empty body; only own tenant dead delivery; no entity action execution; `{ok:true}` or409 |
| POST .../simulate-chat | Same runtime as public chat, synthetic identity authorized by console only. RequestId/conversationId supported. No production bypass switch, no hidden simulated success. |
| POST .../actions/:actionId/approve or /reject | Existing route/body reviewNote preserved; reviewedBy body ignored. Returns `{ok:true, action:{...existingFields, executionStatus}}`. Atomic service from Agent2 handles duplicate/opposite decisions. |

Readiness checks report actual component availability and configuration only. `model` checks locally configured eligible accounts without calling provider; cannot promise upstream availability. `knowledge` may be warning when empty. Origins must produce warning when unrestricted. Worker heartbeat absence is warning/error with honest code, never hard-coded ready. Diagnostics expose no signing secrets, tokens, endpoint credentials, raw CRM or full docs. Embed origin derives from configured public server base / validated request host under existing proxy trust, never blindly trust attacker-supplied Forwarded headers.

## Widget Contract (Agent 4 module; Agent 3 serves it)

`server/src/custom/x-gateway/support-runtime-widget.ts` exports `getSupportRuntimeWidgetScript(): string`. GET /thruline/v1/support/widget.js serves it with current content type; keep FreeLLMAPISupport.init({tenantKey,contextToken?,endpoint?,title?,primaryColor?,placeholder?}). Add optional serverBase, allowGuestSession=true, onAuthRequired callback; do not require changes to existing embed snippets.

- Capture currentScript.src at script evaluation; derive server base from its origin/base path when not configured. Never default requests to the partner website's origin. Explicit endpoint remains supported.
- Expose instance.updateContextToken(token): clears conversation/view/polling on identity change; instance.destroy(): cancels requests/polls and removes DOM. No innerHTML insertion of title, replies, customer data or errors; use safe text rendering.
- A supplied expired/rejected signed token triggers auth-required UI/callback; never silently downgrade a logged-in identity to guest. Guest-only mode can renew its own expired guest session explicitly.
- Keep ephemeral credentials/conversation/request IDs scoped by server base + tenant + token identity using sessionStorage where available. Storage failure falls back to memory. Never store signing secrets. Reusing stored conversation requires successful authorized GET; stale/forbidden storage is cleared before rendering history.
- Send one user message + conversationId + stable requestId per turn. Network retry reuses requestId. Display failed/in-progress turn state and avoid duplicate sends.
- Resume/render conversation, show pending approvals, allow escalation and CSAT (score1..5) through existing authenticated endpoints. Poll for human replies while open; stop on hide/destroy/identity change, back off on failure and prevent duplicate message rendering.
- Basic functional widget strings EN/VI; branding/intake/Copilot/SLA configuration from016 remains outside scope.

## Admin UI Contract

New `/thruline/support-integration` page, nav before generic `/thruline/support` prefix. `data-testid="support-integration-tenant"`; tab/panel IDs `readiness`, `runtime`, `deliveries`, `embed` using `tab-<id>` / `panel-<id>`.

- Readiness: safe component checks, translated reason codes, retry/loading/error and honest warnings.
- Runtime: allowed model selectors, per-tool read/approval-required selection, limits from DTO; fetch tool names via existing GET /tools. Explain POST default approval and no role bypass. Save with PUT runtime and validate bounds.
- Deliveries: eventId/state/attempts/next attempt/safe error; manual retry only dead records; same-tenant scope.
- Embed: copy safe snippet and backend session-flow instructions; no fabricated live success, signing secret input or provider calls.
- Use shared DTOs; all visible strings EN/VI; prevent late results and mutation outcomes crossing tenant/session changes. Native React test harness only; no new dependencies.
