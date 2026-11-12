# Implementation Plan: AI Support Runtime Integration

**Branch**: `feat/9router-integration` (reuse; do not create a spec-number branch)
**Spec**: [spec.md](spec.md)
**Status**: Contracts ready; implementation not started

## Summary

Connect the existing 013–015 engines into the actual chat boundary, close approval replay and outbound-delivery gaps, and expose a working partner widget plus integration diagnostics. Keep spec 016 ownership and files untouched. No application code is changed during this planning turn.

## Technical Context

- Existing TypeScript/Node/Express server, React/TanStack Query client and shared package; only installed dependencies.
- SQLite via the repository Db abstraction; AES-GCM for secrets and sensitive cached payloads. Support the existing alternate DB adapters; no direct driver assumption.
- New standalone modules with small explicit hooks in existing custom routers/pipeline, plus startup/shutdown hooks for the delivery worker.
- New timestamped migrations, with up/down tests and per-Db lazy bootstrap through the same migration functions for isolated memory tests.
- UI tests use createRoot from react-dom/client and act from react; no Testing Library imports or manifest edits.

## Constitution Check

- Credentials remain encrypted and never serialized to client/logs. Raw model/tool data must not enter persistent transcripts or public traces before masking.
- External wire DTOs live in shared/support-runtime.ts; server-only interfaces remain in owned server modules. Type-only imports use existing shared package/subpath conventions; no package export changes.
- No migration edits, unrelated reformats, additional packages, new branch, automatic push/merge by implementers or changes to 016 files.
- Runtime failure, policy checks and diagnostic truthfulness take precedence over synthetic success responses.
- Full tests, lint, builds and migration roundtrips are reviewer gates. Gates apply again after review fixes.

## Architecture & Request Order

1. Validate request schema, matching tenant keys/tokens, enabled tenant, allowed Origin (including preflight), token expiry and model allowlist.
2. Resolve stable signed identity; issue guest-only short-lived sessions through the explicit guest endpoint. Legacy unsigned guests remain stateless and may not attach conversation IDs.
3. Claim (tenantId, userId, requestId), fingerprint the complete normalized request and acquire a short durable conversation lease. Replay completed masked response; conflict for changed payload/in-progress turn. Never keep a DB transaction open across await.
4. Evaluate firewall before any external call. Build bounded trusted history and role-scoped RAG/CRM context. Mask all context sections according to the verified role.
5. Reserve request/token quota atomically. Server computes the full prompt/tool/context estimate plus all-turn output budget; callers cannot specify accounting values. A provider adapter unable to enforce the configured output cap is not eligible.
6. Inject generation hooks into existing executeSupportChatPipeline: trusted context, completion cap, masked tool data, approval-aware webhook executor, bounded tool calls. Both normal and deterministic fallback branches must use the hooks.
7. POST tools default approval_required; GET defaults read. An explicit per-tool runtime policy may classify a read-only POST. A read declaration is administrator configuration, never inferred from tool name or caller role. Approval never elevates the original requester identity.
8. Persist masked messages/results once, reconcile quota, finish turn and release lease. If provider/generation fails, return an honest typed error; keep consumed request and known usage. Explicitly mark estimated accounting when usage is unavailable.
9. Business mutations enqueue partner events in the same synchronous transaction. Worker sends after commit with bounded attempts and stable event identity. Unknown side-effect outcomes are not automatically replayed.

## Dependency Direction / Required Hooks

- support-runtime.ts may import stores/engines and support-action-executor.ts but MUST NOT import support-router.ts or app/index. Generate is dependency-injected by Agent 3.
- support-action-executor.ts and support-event-outbox.ts may import existing stores/connectors; they MUST NOT import runtime or routers.
- support-runtime-store.ts owns turn leases/policy/reservations. support-guardrails.ts owns canonical quota counters and a new synchronous quota-delta helper; it does not import runtime/store (avoid cycles).
- Existing executeSupportChatPipeline gets optional typed internal hooks; production routes ALWAYS provide them. Direct legacy internal calls can retain their signature for tests, but no public route may use an unguarded alternative.
- Agent 3 imports getSupportRuntimeWidgetScript from Agent 4's standalone server module for existing GET /widget.js. Existing init options remain valid.
- startSupportEventWorker() returns an idempotent stop function. Agent 3 starts it after initDb and stops before closing DB, with no duplicate workers on IPv4 fallback.

## Project Structure / Ownership

See [ownership.md](ownership.md) for the exclusive list; [data-model.md](data-model.md) freezes function signatures and persistence; [contracts.md](contracts.md) freezes routes and error semantics. A1/A2 establish contract exports first. A3/A4 can write mocks against these contracts in parallel but must remove integration stand-ins before final verification.

## Delivery Phases

1. A1 runtime/quotas/shared DTOs and A2 approval/outbox/network safety in parallel.
2. A3 wire existing routers, core generation hooks and lifecycle. A4 widget/integration UI in parallel; their tests mock only the published boundaries.
3. All four complete their targeted checks and hand off exact changed paths, results and limitations. They do not stage/commit/push shared work.
4. Reviewer inspects actual diffs and execution paths, requests fixes from owning agent, runs full verification, then creates/reuses a PR from the same integration branch. No merge is authorized in this request.

## Complexity / Explicit Limits

- Durable outbox is at-least-once delivery; recipients deduplicate event IDs. Approval execution has a single atomic claim, not an impossible guarantee of exactly-once remote effects after a crash.
- New dedup records expire after 24 hours; active leases expire after 120 seconds and become interrupted, with no automatic re-execution of unknown tool effects.
- Deployment may use the existing remote DB adapter. If an adapter cannot support the required atomic claim/transaction semantics, fail diagnostics and reject sensitive writes explicitly rather than silently using an in-memory lock.
- No unknown research issues remain; decisions and alternatives are in research.md.