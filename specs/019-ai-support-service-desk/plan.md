# Implementation Plan: Support Service Desk & Widget Studio

**Branch**: codex/support-service-desk | **Date**:2026-11-13 | **Spec**: spec.md

## Summary

Compose a new standalone019 module with existing017 runtime,018 evidence and014 workflow writes. Keep default-off semantics, canonical Thruline mounts and exclusive ownership. No application implementation in this specification turn.

## Technical Context

Existing TypeScript ESM/shared/server/React monorepo; Node supported range from package.json; SQLite through existing Db/crypto/migration registry; existing model pipeline, auth/masking and native React tests. No package/schema replacement, old migration edit, new service runner or CI job.

## Constitution check

Encryption/redaction, tenant/identity gates, shared DTOs, no await in transactions, bounded model work, new reversible migration, minimal entrypoint edits and backward compatibility are mandatory. New feature edits stay on the reusable integration branch. Final sync/publication belongs to reviewer, not implementation agents.

## Architecture and ownership

1. Agent1 freezes shared/support-service-desk.ts and implements all019 schema/store, widget profile/intake validation, OCC and claim/budget primitives. New migration is registered once. All peers read these exports.
2. Agent2 implements support-agent-copilot.ts using real018 retrieval/current policy and existing model pipeline with disableTools. It claims/reserves/settles through Agent1, never executeSupportTurn (which would write customer messages), and never workflow mutation.
3. Agent3 owns SLA/routing engine, no-cycle lifecycle adapter, intake runtime bridge, both new routers and minimal workflow/runtime mounts. The lifecycle adapter takes typed snapshots, imports workflows only as types, and performs no provider/network calls. Canonical workflow writes and SLA writes share synchronous transactions.
4. Agent4 owns Studio/strings/native UI, grouped nav/route and actual served widget/tests. Existing operations page is not refactored; the new Studio uses existing conversation/reply endpoints for explicit human sends.

## Data and flow

### Intake

Signed public auth -> claim turn/replay semantics017 -> verify current required schema + valid receipt/bound conversation -> existing provider/no-match path -> in either final transaction recheck active turn/schema/receipt -> persist non-value receipt-reference metadata + bind receipt + messages/quota/cache atomically. Receipt is not consumed for provider/quota failure. Default-off turn fingerprint is byte-compatible; active receipt reference is included in the normalized turn identity. Current018 replay guards still run before returning cached content.

### Copilot

Editor identity -> tenant-scoped conversation original role/history018 -> actor/request claim -> bounded role pack -> no-match safe result or model attempts with per-attempt reservation -> strict response parse and independent citation validation -> current conversation/source snapshot recheck -> encrypted job result + settlement. GET/replay revalidate; changed context409. Copying a draft into UI composer does not send a message.

### SLA

Canonical ticket creation stores current policy/targets + routing + cycle. Human reply records first qualifying response for all currently open linked cycles. Status/priority updates transition tracked cycles in the same transaction; resolveConversation reply also finishes applicable tickets' SLA clocks without fabricating ticket status changes. Queue is a projection of ticket and tracked state, no writes on GET. Pure engine accepts an explicit now for tests; HTTP caller cannot supply now.

## Phases

Foundation/DTO/migration -> parallel widget validation, Copilot tests, SLA tests and UI skeleton -> actual public/console integration -> full lifecycle/regression proofs -> reviewer gates. Source schema and exports must be real before a peer can claim integration pass. See tasks.md for IDs and ownership.md for exact paths.

## Project structure

New shared/support-service-desk.ts; dedicated support-service-desk-store.ts, support-widget-profile.ts, support-agent-copilot.ts, support-sla-routing.ts, support-service-desk-lifecycle.ts, support-service-desk-runtime.ts and support-service-desk-router.ts. New client SupportServiceDesk.tsx/strings/native test; existing served widget remains the only implementation. One new migration20261113_180001_support_service_desk.ts.

## Risks and mitigations

- Shared checkout: one owner per touched file; no branch/stash/commit by agents, no simultaneous016 work.
- Intake replay/concurrent receipt binding: persisted claims/OCC and final atomic recheck, not browser storage.
- Copilot cost after timeout: dispatch recorded before external work; actual/conservative settlement even for invalid output; stale results never accepted.
- Workflow circular imports: lifecycle only consumes plain typed input/store, never runtime readers; existing018 guards stay intact.
- Windows native/IPC: reviewer records environment failures separately, bounded complete inventory reruns, no package changes or skipped assertions.
- Large scope: strict v1 exclusions in spec; no CRM writes/macros/calendars/background notifications/auto-send.
