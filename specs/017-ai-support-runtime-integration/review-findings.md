# Spec017 — Review Findings / Round 1

**Date**: 2026-11-12, Asia/Saigon
**Branch**: feat/9router-integration
**Base HEAD at review**: 540dad37; implementation is currently uncommitted.
**Round 1 decision**: BLOCKED at the time of initial review. Subsequent authorized fixes and final verification are tracked in [fix-report.md](fix-report.md); this document preserves the original findings.

Reviewer did not change application code. The findings below come from current source/diffs, commands and isolated in-memory reproductions. User reports all four agents finished; peer-integration placeholders are still present in production paths and must be removed before acceptance.

## Verification Actually Run

| Check | Result |
| --- | --- |
| New client integration tests | PASS: 9/9 |
| Client `npx tsc -b` | PASS |
| Root `npm run build` | FAIL: TS2322, support-action-executor.ts:524 |
| Root `npm run lint` | FAIL: 6 unused-binding errors listed below |
| Eight targeted server/migration files | 55 passed, 41 failed, 22 skipped; overall FAIL. Native better-sqlite3 addon fails to load on this Windows environment, affecting 5 files. Not treated as application assertion failures or as passed tests. |
| Isolated reproduction using shipped nodeSqliteFactory | Confirmed four behavioral failures; no native-addon dependence or external network calls |
| `git diff --check` | PASS |
| Full root test suite / full migration acceptance | Not run to acceptance after blocking build/runtime findings; still required after fixes |

The temporary diagnostic script used the current runtime, real stores/engines and the existing Node SQLite adapter, with only generation replaced by a controlled callback. It is outside the repository at `%TEMP%/freellmapi-spec017-review.mts`; scenarios and observations below allow owners to turn them into owned regression tests. The script contains only test identities and no production credentials.

## Blocking Findings

### F01 [P1] Build does not compile — Agent2

**Location**: `server/src/custom/x-gateway/support-action-executor.ts:524`.

`reviewSupportPendingAction` accepts only approved/rejected decisions, but the new caller passes `'failed'` on unsuccessful execution. `npm run build` stops with TS2322. Keep the approval decision distinct from execution outcome as specified; do not cast away the error or broaden semantics merely to silence TypeScript. Add success, rejected, failed-HTTP and unknown-outcome tests against actual workflow API.

### F02 [P1] Approval errors become nonexistent fake pending actions — Agent1

**Location**: `server/src/custom/x-gateway/support-runtime.ts:405–445` (especially fallback beginning436).

The dynamic import/invoke is surrounded by a broad catch. Any real service error, including failure to save the execution snapshot, is swallowed and replaced with a fresh random action ID and `ok:true,status:202`. No action corresponding to that ID is persisted. Reproduction: install a SQLite trigger rejecting inserts to x_support_action_executions, invoke a permitted POST tool through runtime, and observe `returnedPendingAction:true, returnedIdExists:false`. Remove the production placeholder, use the actual service and propagate a safe failure. Snapshot/proposal creation must be atomic so this failure also leaves no orphan legacy proposal (Agent2 coordination).

### F03 [P1] Customer transcript persists raw PII despite masking — Agent1

**Location**: `server/src/custom/x-gateway/support-runtime.ts:555–568`.

The model receives maskedServerMessages, but the stored customer message uses raw `lastUserText`. With email detector enabled and customer role, a turn containing a test email produced `providerReceivedRaw:false` but `persistedRawEmail:true` in the real conversation store. Persist the role-masked message and audit identity fields/trace/response for the same bypass. Keep encrypted execution arguments separate from public/transcript representations. Regression must read the actual stored conversation/settings, not only inspect the provider input or assistant reply.

### F04 [P1] Quota reservation omits authoritative history and repeated prompt cost — Agent1 + Agent3

**Locations**: runtime.ts:350–357, 606–624; support-router.ts:512–514.

Reservation estimates `totalChars` from the submitted final message rather than actual server history, omits the complete tool schema/results and reserves prompt cost only once for a multi-call loop. Reconciliation then applies overage with enforceLimits:false. Isolated reproduction: existing 20000-character history + short Hello, token budget3000, runtime reserved1649 and called generation with20017 message characters; after reported usage6000 it charged6000, already beyond the configured budget. The pipeline also overwrites promptTokens with the last call rather than summing all calls. Bound and reserve the complete worst-case authorized turn before dispatch, account all model calls/attempts honestly, and enforce eligibility/output caps. Prove rejection before provider when the full history will not fit; prove multi-call accounting, not just one callback reporting small usage.

### F05 [P1] Production runtime can fail open into a standalone bypass — Agent3

**Location**: `server/src/custom/x-gateway/support-runtime-router.ts:250–295`.

If peer import/initialization fails, dispatchRuntimeTurn still calls generate with original messages, empty trusted context, identity mask and synthetic runtime metadata. This skips firewall/quota/persistence/idempotency rather than returning503. Test-only setters and fallback implementations must not provide a public production escape. Wire actual exports statically (or fail closed) and test real runtime boundaries. A missing or broken runtime module is an availability error, not permission to serve unguarded model requests.

### F06 [P1] Outbox errors are swallowed, losing atomicity and tenant isolation — Agent3

**Location**: `server/src/custom/x-gateway/support-runtime-router.ts:319–391`.

dispatchPartnerEvent catches durable enqueue failures and appends fake delivery records to a process-local array. This lets the surrounding business transaction commit without a durable event, loses the event on restart, and reports a nonexistent default recipient. Those array entries contain no tenant ID; listPartnerOutbox returns the whole array whenever a tenant's durable list is empty, so the fallback can expose another tenant's event metadata. Remove fallback storage; enqueue failure must roll back the business mutation. All listing/retry paths must remain tenant-bound even during failures. Add transaction rollback and empty-tenant isolation tests against real storage.

### F07 [P1] Escalated conversations still invoke the AI — Agent1

**Location**: `server/src/custom/x-gateway/support-runtime.ts:284–313`, before generation at467.

The loaded conversation status is not used to stop generation. Reproduction: create a signed conversation, escalate it with the actual workflow service, then submit another turn to that conversation; the generation callback still runs (`generatedDuringHandoff:true`). Respect handoff state on the server; the browser disabling its input is not enforcement. Define/persist accepted waiting-customer messages consistently and prevent model/tool calls until resumed. Test direct /chat on an escalated conversation, not only widget behavior.

### F08 [P1] Timeout/lease completion is not actually fenced — Agent1 + Agent3

**Locations**: runtime.ts:389–390, 467–499, 555–649; support-router.ts:475–496; runtime-store.ts:371–390.

The90-second timer only aborts a signal; executeSupportTurn continues awaiting generate and never checks the aborted signal before appending messages or returning success. The actual provider call does not receive the signal. A provider resolving after lease expiry can therefore still append messages, execute subsequent work and return success; completeSupportTurn's boolean result is ignored, and transcript writes happen before any successful completion claim. Thread cancellation into eligible provider adapters, enforce the deadline, gate tool dispatch and fence ALL final writes by current turn/lease claim. Add delayed-provider/fake-time tests crossing90/120seconds with a competing turn and verify no late transcript overwrite or new side effect.

### F09 [P1] Human replies are not recognized by the widget — Agent4

**Location**: `server/src/custom/x-gateway/support-runtime-widget.ts:497–505` and580–587.

Backend message sender types are `customer`, `ai_assistant`, `human_agent`, `system`. Widget checks only `staff`/`agent` and `assistant`. During resume it renders real human/AI messages as customer messages; during polling it drops real human_agent replies entirely. Map the actual wire types and preserve any deliberate backward aliases. Update widget fixtures to the actual API schema and prove a real human_agent reply appears after escalation.

### F10 [P1] Both generated embed snippets are unusable with the real contract — Agent4 + Agent3

**Locations**: `client/src/custom/x-gateway/pages/SupportIntegration.tsx:649–662`; `server/src/custom/x-gateway/support-runtime-router.ts:632`.

Client declares tenant.tenantKey and emits that property, but GET /tenants returns publicKey; copied snippet therefore contains tenantKey:"undefined" with real data. Backend readiness snippet emits only a deferred script with data-tenant-key, while the script does not auto-initialize from that attribute, so that snippet creates no widget. Use canonical DTO/publicKey and one tested embed contract. Escape tenant names/config safely for inline script context. Prove copied server AND UI snippets work with actual tenant response shape in jsdom; do not supply invented tenantKey in the mock.

### F11 [P2] Model policy/throttle/readiness still use temporary local state — Agent3

**Locations**: runtime-router.ts:103–115, 398–420, 603–606, 803–826; support-router.ts model validation before dispatchRuntimeTurn.

Chat authorizes model overrides through getLocalRuntimePolicy, separate from the durable policy that the runtime reads. After restart the Map is empty, so a model saved in the durable allowedModels list is rejected by HTTP before the real runtime sees it. PUT also catches persistence errors and returns apparent success from the Map; guest throttle never calls Agent1's durable helper; quota/approval readiness is hard-coded ready. Remove temporary local state and use real store/helper/health results, propagating persistence failures. Test restart and the actual HTTP path with persisted nondefault models and guest issuance counters.

### F12 [P2] Action crash recovery and terminal replay semantics are incomplete — Agent2

**Location**: `server/src/custom/x-gateway/support-action-executor.ts:261–284`, 420–455.

Rows left executing by a process crash remain executing forever; no recovery changes them to unknown for reconciliation. Failed execution and rejected decision are conflated as failed+reviewer, so a repeated approve of an approved-but-failed action is treated as an opposite decision instead of returning the cached outcome. Persist decision independently and provide safe recovery to unknown without re-dispatch. Add restart after claim/before outcome and terminal same/opposite-decision tests. Also avoid lowercasing case-sensitive URL paths when fingerprinting the target, and validate actual arguments against the declared schema before proposal/approval.

### F13 [P2] Batch outbox leases expire before queued sends and writes lack claim fencing — Agent2

**Location**: `server/src/custom/x-gateway/support-event-outbox.ts:264–288`, delivery updates304–429.

Worker claims20 rows for30seconds, then sends them serially with5second timeouts. Later rows can begin after lease expiry and be reclaimed by another worker. Final updates use WHERE id only, so the old worker can overwrite a newer claim's delivered/dead result and break bounded-attempt bookkeeping. Claim near dispatch or renew leases, persist a claim token and fence every completion update to that token. Test distinct worker/process claims with elapsed fake time; the process-local isDraining flag is not proof of multi-worker safety.

### F14 [P2] Guest widget identity cannot resume after a page reload — Agent4

**Location**: support-runtime-widget.ts:137–147, 418–440, 789–792.

renewGuestSession changes activeToken but does not save/reload the guest credential. Conversation ID is stored under a key derived from that token; after reload activeToken is empty, so initialization looks under the guest prefix and cannot find the old conversation. Persist the short-lived guest credential in the scoped session store and validate it before rendering/resume; never confuse a supplied logged-in token with a guest or silently downgrade it. Add reload tests beginning with no contextToken and an actual guest-session response.

## Lint Findings To Fix In Owner Files

- Agent1: x-support-runtime.test.ts:1 unused crypto.
- Agent2: support-crm-webhooks.ts:5 unused SafeHttpError; support-event-outbox.ts:10 unused SafeHttpError and318 unused err.
- Agent4: x-support-runtime-widget.test.ts:20 unused e and208 unused inst2.

## Verification Gap / Required Retest

The gateway suite injects setTurnExecutor, setActionReviewExecutor and setEventOutboxDispatcher for the important success paths. Those tests validate adapters around mocks, not the actual cross-agent composition; this missed the fake approval and real widget sender/tenant DTO mismatches. Agent3 must add the agreed HTTP proof using real runtime/stores/engines and only mock provider/network boundaries. Each owner adds regression tests for assigned findings; reviewer reruns full required gates after fixes. No skipped/native-unavailable test counts as acceptance.

## Return-To-Agent Checklist

- **Agent1**: F02/F03/F04/F07/F08 + own lint; coordinate exact runtime/provider hook changes with Agent3 and atomic proposal with Agent2.
- **Agent2**: F01/F12/F13 + F02 atomic snapshot/proposal + own lint; preserve original approval identity and add actual schema/snapshot tests.
- **Agent3**: F04/F05/F06/F08/F10/F11 + real HTTP integration tests. Remove all production peer-pending placeholders, local registries and swallowed persistence failures.
- **Agent4**: F09/F10/F14 + own lint; use actual shared/API DTOs and sender types in tests, not duplicated incompatible interfaces.

All owners keep original ownership boundaries, do not edit another agent's files, and do not commit/push/create PR. Return findings that need a peer export to the reviewer rather than implementing a replacement. Reviewer will re-review after all four corrections; no PR is authorized for this failing round.
