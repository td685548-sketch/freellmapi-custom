# Research & Gap Audit

**Date**: 2026-11-12. Evidence is the current local checkout, not a claim about a deployed server. Task checkboxes in older specs are not treated as proof of implementation.

| Evidence in code | Missing behavior | Decision |
| --- | --- | --- |
| `executeSupportChatPipeline` in `server/src/custom/x-gateway/support-router.ts` builds identity/tool context and calls providers | No built-in RAG/CRM/firewall/masking/conversation orchestration | Add a standalone runtime with injected generation hooks; route real chat and simulator through it. |
| Browser can submit message roles/history and `model` directly | Untrusted system instructions/history and model selection | Server-authoritative history; reject client system messages, authorize model overrides. |
| `checkAndConsumeSupportUserQuota` increments requests on each call | Direct chat skips it; no reservation/reconciliation for concurrent generation | Extend canonical counters with transactional deltas and per-turn durable reservations. Do not count tool-loop iterations as separate customer requests. |
| POST `/chat` calls pipeline and returns JSON without persistence | Reload and inbox are disconnected | Turn ledger plus existing conversations; signed unique guests, ownership checks and conversation leases. |
| Pipeline immediately invokes `executeSupportWebhookTool` | Sensitive tools bypass the standalone action-approval API | Route webhook invocation through a default-approval classifier; retain GET read default and explicitly configured read-only POST support. |
| Enterprise approve handler invokes HTTP before reviewing state; no pending-status compare-and-set; missing tool produces `simulated: true` | Replay can repeat a side effect; approval can look successful without execution | Durable execution claim; separate decision/execution status; no simulated production success and no automatic retry after ambiguous network outcomes. |
| `dispatchSupportPartnerEvent` uses `default_secret`, optional local override, raw fetch and sequential delivery | Weak secret fallback, no durable retry, no redirect/DNS binding boundary | Require actual tenant secret; shared safe HTTP transport and transactional outbox. Default deny private destinations; bounded server-only test opt-in. |
| Governance public route passes `allowLocalhost: true`; other lifecycle endpoints do not consistently dispatch their events | Production network override and incomplete lifecycle wiring | Remove public overrides; enqueue event at every actual business transition. |
| Widget script defaults endpoint to its embedding website's relative `/thruline/v1/support/chat`, keeps history in memory | Cross-domain wiring, persisted conversations, staff replies, escalation and CSAT missing | Derive server base from widget script URL or explicit endpoint; replace script body via separate renderer module while preserving init compatibility. |
| Existing `/thruline/support`, `/thruline/support-ops`, `/thruline/support-guardrails` configure standalone modules | No safe read-only report proving full runtime wiring | Add `/thruline/support-integration` readiness/policy/outbox UI and a single consolidated diagnostics API. |

## Decisions / Alternatives

1. **Reuse existing engines** rather than duplicate RAG, CRM, masking, connectors and workflow records. Reason: module behavior is already covered by tests; the gap is orchestration and trust boundaries.
2. **Dependency-inject generation**, rather than import support-router from runtime. Reason: support-router already imports router/provider code; injection avoids a runtime/router cycle and supports deterministic boundary tests.
3. **Durable SQLite claims/outbox**, rather than process-local Map locks or awaited webhook retries in chat. Reason: overlapping requests, multiple workers and restarts must not discard state or repeat unknown side effects.
4. **At-least-once webhook delivery with recipient deduplication**, rather than promise exactly-once over HTTP. Reason: response loss cannot prove the receiver did not process an event.
5. **No automatic mutation retry**, rather than blindly rerun a timed-out tool. Reason: refund/cancel operations may already have happened. Record `unknown` and require reconciliation.
6. **One new integration page**, rather than edit all three older screens. Reason: explicit ownership and minimal diff. Existing editors remain useful and new policy fields are kept in their own module.
7. **Freeze contracts in documentation before parallel coding**. Agents may mock missing peer modules in tests, but must not add production stubs or edit each other's files.
8. **Defer spec 016 and unrelated capabilities**. Branding, intake forms, Copilot and departmental SLA already have a separate spec. Streaming, embeddings/vector search, commercial billing and omnichannel support are backlog after the end-to-end runtime is proven.

No unresolved architectural research questions remain. No research subagents were launched: the user requested prompts for separate agents and reviewer-only implementation follow-up.
