# HTTP, lifecycle and trust contracts

Canonical console prefix /api/thruline/support; public /thruline/v1/support; page /thruline/support-desk. Preserve018/017 APIs, internal names and existing auth. All new body schemas strict; tenant path IDs positive integers, requestId nonempty safe ASCII<=100, opaque IDs<=128, input bodies bounded. Standard error {error:{code,message,fields?},requestId?}; fields contains bounded field-key -> machine code only, never submitted values/remote/model text.

## Authorization

Console: actual requireAuth from middleware, use_x_gateway AND edit_x_settings for every019 read/write/AI operation. Use existing permission expansion for admin/primary; no invented x_gateway.support permission, cookie auth or role=user. Operators are numeric SessionUser.userId. Tenant-scoped IDs; cross-tenant/actor job/receipt resource lookup404. No browser-selected customer role/history/actor/budget.

Public config is a safe projection gated by enabled tenant/public key + existing exact Origin/CORS rules and normal rate controls. It grants no chat/profile permissions. Intake/chat need017 verified signed session (including signed guest), current tenant/origin/owner; never trust body userId/userRole. Existing unsigned guest remains compatible when intake is disabled; required intake returns401 signed_session_required for unsigned users. No tokens in URLs/snippets/logs.

## Console endpoints

All relative to /api/thruline/support/tenants/:id/service-desk:

| Endpoint | Body / response |
| --- | --- |
| GET /widget-config | {ok:true,config,publicConfig,embedSnippet} |
| PUT /widget-config | {expectedVersion,enabled?,appearance?,intake?}; nested object full replacement if supplied, strict keys; {ok:true,config,publicConfig,embedSnippet} |
| POST /copilot | {requestId,conversationId};200 {ok:true,result:SupportDeskCopilotResult} |
| GET /copilot/jobs/:jobId | Own operator only;200 {ok:true,result}, running409 + Retry-After |
| GET /sla-policy | {ok:true,policy} |
| PUT /sla-policy | {expectedVersion,enabled?,targets?,routingRules?}; targets complete4-priority object when supplied; {ok:true,policy} |
| GET /queue | ?department=&status=&cursor=&limit=1..100; {ok:true,items,nextCursor}; deterministic opened/createdAt then ticketId ordering; no nextCursor ambiguity at ties |
| PATCH /tickets/:ticketId/routing | {expectedVersion,department}; update tracked state's version/manual department only; {ok:true,state}; untracked409 ticket_not_tracked |

Conversation list and human reply continue existing /api/thruline/support/tenants/:id/conversations and /conversations/:conversationId/reply. UI must explicitly ask user to send; copying/editing Copilot draft has no server mutation. No new send-as-AI endpoint. UI uses current real response envelopes from existing routers, not invented server DTOs.

## Public config, intake and runtime

GET /thruline/v1/support/widget/config: normal tenant-key header and Origin, optional context token;200 {ok:true,config:SupportDeskPublicWidgetConfig}. It exposes no stored values, private policy, budget or credentials. Off/default returns enabled:false projection, not a fake storage failure fallback.

POST /thruline/v1/support/widget/intake: verified session headers + SupportDeskIntakeInput ->201 first/200 replay {ok:true,receipt}. configVersion must be current; stale409 widget_config_changed. Invalid field keys/types/length/options/missing required fields400 invalid_intake with safe fields map. Values never create/update CRM or identity. Same tenant/user/role/requestId with same canonical validated payload returns same encrypted-cached receipt; different payload409 request_conflict. No customer request/token quota charge merely for intake; bounded issuance in019 store.

Existing POST /thruline/v1/support/chat accepts optional intakeReceiptId only (not values/role/internal metadata). An accepted existing conversation with a valid current-schema bound receipt needs no repeated receipt; new/schema-changed/current-role-changed conversations need a new receipt. When required, absent receipt428 intake_required, wrong ownership404 intake_not_found, expired410 intake_expired, stale schema409 intake_schema_changed. Chat body cannot supply trusted intake metadata. Config disable means no intake enforcement and unchanged017 turn identity for calls without receipt; unexpected receipt when profile.enabled=false or fields=[]400 invalid_input. When configured fields are optional (intake.required=false), a supplied valid receipt may attach metadata; an omitted receipt does not gate chat and the widget offers an explicit skip. required=false is not the same as profile disabled.

Replay of an already accepted turn retains017 semantics and018 revalidation: no second intake/message/charge. New active-mode turn fingerprint includes receipt reference where present; changing it under the same requestId conflicts. Validate ownership before reading conversation metadata. Recheck current schema, identity/expiry and binding in BOTH runtime commit transactions (zero-model and generated), same synchronous transaction as receipt bind, conversation metadata, messages, quota reconciliation and cache. No awaits. If schema changes in-flight, discard model result, reconcile actual/conservative incurred cost and return409 intake_schema_changed without persisting that result. Provider/quota failure does not consume receipt. Two different new conversations cannot bind one receipt; failure rolls back all effects. Same conversation may reuse bound intake until schema/role changes; receipt issuance TTL applies to initial binding, not an already accepted persisted binding.

Agent3 support-service-desk-runtime.ts exports prepareSupportDeskIntake({tenant,context,input,conversation?}) returning trusted gate state and commitSupportDeskIntake({gate,conversationId}) called within final transaction. Do not refactor017 orchestration into a second executor. runtime-store fingerprint change is additive only when receipt is present/active. Workflow has separate internalIntake input and sanitized public intake metadata, never a spread of untrusted body.

## Copilot execution and costs

Only existing tenant-scoped conversation ID. Select original customer's userId/role through existing canonical list/get boundaries; unsupported role403 unsupported_evidence_role. Exclude unprovenanced/redacted AI history, bound/mask history and ignore intake as instructions. No arbitrary customerContext, CRM memory, caller model/tool arguments, incoming raw history or role override.

Always use real018 role retrieval as a mode-agnostic simulation with the ACTUALLY SAVED evidence policy (including mode off), not a fabricated required toggle. No source ->abstained/no_evidence, modelUsed:null, zero model tokens and no model call. Reserve one operator request; no customer quota/turn/transcript mutation. Prompt includes bounded exact evidence, masked history, untrusted-reference boundaries and strict JSON output request.

Agent2 uses existing executeSupportChatPipeline with hooks.disableTools=true, trustedContext and actual beforeModelCall/recordModelUsage/signal hooks; NEVER executeSupportTurn for drafts. Model attempts<=2 before first successful completion, output<=1024 tokens, whole15s deadline, assembled prompt<=16000 chars. Reject usedFallback/no provider as503 model_unavailable; no citation-repair call. Use existing provider selection; no parallel/secondary production executor.

Expected model JSON exactly {summary:string,drafts:[{tone,text} x3]}; summary<=2000 chars, each text<=2000, completed summary and each draft independently contain1..5 valid018 citations. Parse/reject unknown keys, duplicate/missing tones, malformed JSON/tool markup/invalid citations. Any invalid part rejects the entire generated artifact as safe abstained/invalid_result; discard raw output from all aliases/storage/logs. Do not silently keep a partial set or synthesize drafts. Public output uses canonical [1] citations per artifact and bounded masked DTOs.

Before return/store/replay/GET recheck current conversation snapshot (tenant, userId, role, status, updatedAt, ordered message IDs/content/evidence notice hashes), evidence policy/source/ACL/masking snapshot and actor scope. Stale ->409 copilot_context_changed, no regeneration under same ID. In-flight stale ->safe sources_changed abstention with current snapshot if context can still be read safely; otherwise409. Incurred model cost is retained. Never return rejected text.

Copilot budget: per tenant/operator UTC hour10 accepted requests, UTC day250000 conservative model tokens, durable claims/reservations. Count accepted zero-model request but0 tokens. Before EACH provider attempt reserve full server-estimated prompt/output cost; reconcile observed usage, otherwise conservative. Failed/timeout/invalid output calls still count spent/reserved cost. Same request/fingerprint repeats return cached result after revalidation, no duplicate charge; conflicting fingerprint409 request_conflict; running409 copilot_in_progress with Retry-After. Expired lease with dispatch recorded must fail/settle conservatively, never invisibly dispatch again. Late callbacks fenced. Cache TTL24h does not erase current-window usage; expired job GET/replay returns410 job_expired, never auto-generates. Keep request identity tombstones for at least24h beyond cache expiry. Reserve returns a unique attemptId; usage settlement is idempotent and every write fences leaseToken. No raw SQL outside Agent1 store, no caller-defined test bypasses in public routes.

## SLA/routing lifecycle

Agent3 support-sla-routing.ts exports selectSupportDeskDepartment(ticket,policy), calculateSupportDeskSla(state,now), initializeSupportDeskTicketState(ticket,policy,now), transitionSupportDeskTicketState(beforeTicket,afterTicket,state,now,{statusExplicitlySet:boolean}). Pure input/output, no DB/network/model/global mutable registry. Bridge support-service-desk-lifecycle.ts imports workflow types only and invokes Agent1 persistence; no runtime workflow import cycle.

SLA default off. Create tracking state only for NEW ticket while enabled, snapshot all4 priority targets/policyVersion, cycle1 opened at ticket.createdAt. Old tickets show tracked:false; GET never backfills. Nonnumeric legacy tenant fixtures no-op; real tenant storage/policy corruption fails closed and rolls back canonical mutation.

All calls to createSupportEscalationTicket/addHumanAgentReply/updateSupportEscalationTicket (existing console/public routes and direct service uses) participate. Wrap existing settings writes + SLA state in one synchronous getDb transaction. AI/system messages don't stop response clock. First human message at/after cycleOpenedAt stops first-response clock for every active linked ticket once; repeated handler calls are idempotent. resolveConversation reply finishes linked active SLA cycles at the same timestamp without inventing ticket status updates. Explicit terminal ticket statuses resolved/closed stop resolution and never overwrite first resolution time on repeated updates.

Reopen is an EXPLICIT status=open/in_progress patch while the tracked state is terminal, including after resolveConversation left the old ticket status active. A priority-only patch does not reopen a finished cycle. Reopen increments cycle, new openedAt at transition, clears response/resolution, captures current policy if enabled; if disabled, still increment cycle/openedAt and clear current clocks, set tracking='paused', retain the previous completed cycle in encrypted metadata as historical context. Paused current cycles have tracked:false/not_observed clocks, not reused met/healthy clocks. Re-enabling policy does not retroactively activate that cycle. Priority changes on active tracked cycle recompute deadlines from SAME cycleOpenedAt using captured policy targets; no clock reset. Policy edits alone do not rewrite existing cycle targets. Manual routing changes state.version and department only, doesn't change SLA origin or grant access.

Time: UTC elapsed24/7; before75% healthy, >=75% and <100% warning, >=100% breached. A qualifying stopped clock before deadline is met, at/after deadline breached. A terminal cycle without human reply or a ticket without conversation is firstResponse not_observed, never met/0ms; keep enough data to show whether deadline elapsed, and don't include such rows in achieved-first-response denominator. No claims of business-hours compliance, push notifications or autonomous reassignment. Queue output masks ticket text using original customer role, limit100 and stable cursor; report only explicit tracked/observed denominators, no read writes or AI.

## Widget/Studio lifecycle

Existing init remains synchronous and compatible unless generated snippet opts in with loadTenantProfile:true. It then fetches public projection through canonical deployment-prefixed URL, applies only safe scalar appearance, obtains/renews017 guest session before intake, renders/validates form, stores only receipt reference per identity and sends it with chat. Do not persist raw intake values in browser storage. Server required intake cannot be disabled by browser flags. On428 load/show current form; submit/continue is explicit user action and starts a fresh request when needed, never silent AI retry. Profile loading failure in opt-in mode shows retry/error rather than inventing defaults to bypass required fields.

Appearance uses HEX colors, safe text, known positions/prompts. No remote avatar/HTML/CSS/iframe injection. Preserve abort/epoch checks, token/tenant reset, destroy, late response fencing, base-path inference, CSAT/escalation,018 notices/citations/revocation and stable network retry IDs.

Actual served factory exposes FreeLLMAPISupport.preview(container,publicConfig):{destroy()} backed by the SAME appearance renderer, transport disabled and no global._instance/session/customer effect. Studio preview loads the actual canonical script, doesn't evaluate arbitrary user JS, doesn't replace/destroy an existing live instance and never calls chat/intake/Copilot. No second production widget implementation.

UI route /thruline/support-desk; selector data-testid support-desk-tenant; tabs/panels widget,copilot,queues,embed => tab-ID/panel-ID. New shared session/tenant query keys, AbortSignal and epoch/unmount guards for mutations too. Editor-only queries. UI uses profile OCC, real conversation selector, summary+3 drafts with sources, explicit copy/edit/send using existing human reply route, queue department filter/routing and SLA policy editor, current-source errors and safe snippet. Source revocation/stale results hide drafts; no auto-send. Complete EN/VI and accessible labels/statuses; native createRoot/act only.

## Error codes

400 invalid_input/invalid_intake;401 signed_session_required;403 permission_denied/unsupported_evidence_role;404 tenant_not_found/intake_not_found/conversation_not_found/job_not_found/ticket_not_found;409 version_conflict/widget_config_changed/intake_schema_changed/request_conflict/intake_already_bound/copilot_in_progress/copilot_context_changed/ticket_not_tracked;410 intake_expired/job_expired;428 intake_required;429 intake_rate_limited/copilot_quota_exceeded (Retry-After);503 service_desk_storage_unavailable/model_unavailable;504 copilot_timeout. Existing017/018 errors preserve their codes/envelopes. No raw exceptions/credentials/output reflected.

## Failure boundaries

Never use req.close alone as a disconnect signal: use request aborted/response close with writableEnded checks and cleanup. Public API cannot override test clocks, limits, roles, schema/lease or provider hooks. Accepted runtime metadata may add intake={schemaHash,submittedAt}; it exposes no receipt secret/raw values. Copilot masks the complete assembled provider messages/system prompt using existing masking helpers, not only visible history; enforce prompt bounds before reserving/dispatching each attempt.

Embed generation (Agent3 router): use existing SUPPORT_PUBLIC_BASE_URL semantics for an application-owned http(s) base with optional deployment path; reject credentials/query/hash, safely encode JSON/HTML script delimiters. Snippet contains only public tenant key, canonical script/base and loadTenantProfile:true. It never mints or embeds a stored user token/signing secret; signed partners obtain tokens from their own backend at runtime, while allowed guests use017 signed guest issuance.

Intake storage projection: workflow settings persist only receiptHash/schemaHash/submittedAt, never the submitted/custom values, even for unmasked roles. Add a type-only, no-cycle hydration helper in the runtime bridge using readSupportDeskBoundIntake; canonical get/list mask/hide values according to verified viewer/original customer role and remove the internal hash. Copilot excludes hydrated intake values from its model context entirely.
