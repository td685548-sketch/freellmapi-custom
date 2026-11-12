# Spec017 review remediation

Date: 2026-11-12. User explicitly authorized corrections after the four-agent review.

## Corrections

| Finding | Correction and regression evidence |
| --- | --- |
| F01 | Separate approved/rejected decision from execution outcome; TypeScript build and failed-HTTP approval replay tests. |
| F02 | Remove fabricated action IDs; real proposal and encrypted snapshot commit atomically. Trigger-injected insert failure verifies no orphan proposal. |
| F03 | Mask customer input, identity fields, assistant replies, traces and replay before transcript/cache persistence. Runtime and real HTTP tests inspect persisted history. |
| F04 | Reserve against full authoritative history/context/tools; expand reservation atomically before each provider dispatch; sum usage across calls. Long-history rejection and actual HTTP two-call billing tests. |
| F05 | Production delegates directly to required runtime/services; test overrides are unavailable outside NODE_ENV=test. Real HTTP tests exercise no-provider denial and actual approval creation. |
| F06 | Remove in-memory outbox fallback; only durable tenant-scoped operations remain. Outbox isolation and failure tests. |
| F07 | Reject generation on an escalated conversation, and disable widget input during human handoff. Runtime and widget tests. |
| F08 | Pass AbortSignal to provider, enforce deadline with a race, and fence model/tool/persistence operations against active turn/lease. Late-result test verifies no transcript writes. |
| F09 | Recognize actual human_agent/ai_assistant sender types. Executed widget reload regression. |
| F10 | Use tenant.publicKey and JSON-escaped explicit widget initialization; configured public base is supported. Client embed tests and server readiness tests. |
| F11 | Share persistent policy/throttle state with runtime; inspect storage and actual policy enable flags for readiness; require recent successful worker progress, tested for stale heartbeat and storage failure. Shared DTOs and localized status codes. |
| F12 | Validate JSON schema and case-sensitive target snapshot, preserve review decision, recover abandoned execution as unknown, fence late completions. Executor regression tests. |
| F13 | Claim each recipient immediately before dispatch, reserve attempts before HTTP, and fence completion with a claim token. Stale-sender and shutdown tests. |
| F14 | Persist short-lived guest credential with conversation scope; reuse it on reload. Guest renewal is bounded and discards the old identity’s conversation. Widget regression. |

## Additional migration integration defect

The full suite exposed F15: all three new migration files were absent from the static DEFAULT_MIGRATIONS registry, so normal startup/upgrades would silently skip them. Registered them in filename order in server/src/db/migrate/defaults.ts. The existing registry-drift test provides regression coverage; full migration roundtrip is rerun with the registered modules.

## Accounting and operational limits

Token reservations use a conservative UTF-8 byte estimate, including the full serialized prompt before every provider attempt and that attempt’s completion cap. A later model call cannot dispatch until its additional reservation succeeds. Known provider usage is summed; missing usage or interrupted turns retain a conservative charge rather than refunding an unknown cost.

Event delivery is at least once. Recipients should deduplicate stable event IDs. Unknown action outcomes require manual reconciliation and are never automatically redispatched. Shutdown aborts/fences an active outbox drain before database closure; claimed deliveries remain durable for recovery.

A new migration, 20261112_180001_support_runtime_fencing, adds decision and delivery claim-token columns without rewriting the original migrations.

## Verification

Build, root lint, targeted client lint, plain Node compiled-app load, and registered migration roundtrip pass. Targeted checks include 129/129 combined runtime/action/outbox/HTTP/migration tests, 43/43 final worker/outbox/gateway/HTTP checks and 9/9 client integration tests. Complete local coverage is verified: 524 server files, 6376 tests passed and 10 skipped; CLI 181/181; client 747/747; i18n validates 60 locales and 1320 keys. Bootstrap has 2 passes and 2 platform skips; hooks 9/9.

The canonical monolithic npm run test command did not complete on Windows/Node24: Tinypool lost its IPC channel after 318 server files completed without assertion failures. All remaining 206 server files were then run in six bounded fresh-process Vitest batches with the same forks/fileParallelism=false flags; all six commands exited0. A path inventory comparison confirmed no server test file was omitted. The newest worker readiness/outbox/HTTP changes additionally passed the fresh 43-test targeted run. This is complete per-file coverage, not a claim that the monolithic command passed. Canonical Linux/Node22 CI remains the merge gate. Initial attempts interrupted by ERR_IPC_CHANNEL_CLOSED or superseded by fixes were not counted as passed. better-sqlite3 was rebuilt locally for the Windows runtime; no dependency manifests changed.

The shared integration branch was fast-forwarded to origin/main (8808c321) without changing unrelated pending spec016 documentation. The prospective commit includes only reviewed spec017 implementation, regressions and the minimal migration registry/default roundtrip updates. No binary or dependency changes.

Accepted for PR publication with this explicit local-runner limitation. Canonical CI must pass before any merge; the user has not authorized merging.
