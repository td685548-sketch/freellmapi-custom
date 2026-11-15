# Exclusive file ownership

All unlisted paths read-only. No edit to019/provider/Playground pending work in the shared checkout. All implementation in isolated checkouts on dedicated branches; baseline SHA identical. No stage/commit/push/PR until required tests/build pass; no auto-merge. No live providers/customer writes. Reviewer integrates accepted commits; only reviewer edits020 contracts/spec/task files after freeze. Agent1 may prepare the Spec Kit artifacts before freeze, not peer application files.

## Agent1 — persistence/shared
CREATE:
- shared/support-output.ts
- server/src/custom/x-gateway/support-output-store.ts
- server/src/db/migrations/20261115_120001_support_output_controls.ts
- server/src/__tests__/custom/x-support-output-store.test.ts
- server/src/__tests__/db/migrate/support-output.test.ts

EDIT:
- shared/support-runtime.ts (optional output metadata + replySource union only)
- server/src/db/migrate/defaults.ts (register new migration only)
- server/src/__tests__/db/migrate/roundtrip.test.ts (new expectation only)
- specs/020-ai-support-output-controls/ (Spec Kit preparation only, before all agents freeze contracts)

## Agent2 — pure engine
CREATE:
- server/src/custom/x-gateway/support-output-engine.ts
- server/src/__tests__/custom/x-support-output-engine.test.ts
- server/src/__tests__/fixtures/support-output/cases.json

No existing file edits; no DB/runtime imports.

## Agent3 — runtime/history/Copilot
CREATE:
- server/src/custom/x-gateway/support-output-runtime.ts
- server/src/__tests__/custom/x-support-output-runtime.test.ts
- server/src/__tests__/custom/x-support-output-history.test.ts
- server/src/__tests__/custom/x-support-output-copilot.test.ts

EDIT (minimal hooks/types/regressions only):
- server/src/custom/x-gateway/support-runtime.ts
- server/src/custom/x-gateway/support-runtime-store.ts
- server/src/custom/x-gateway/support-router.ts
- server/src/custom/x-gateway/support-workflows.ts
- server/src/custom/x-gateway/support-agent-copilot.ts (accepted019 prerequisite)
- shared/support-service-desk.ts (optional output metadata only, accepted019 prerequisite)

Do not edit shared/support-runtime.ts, engine/store, console or UI. Existing017/018/019 tests read-only; new regressions live in owned test files. If an existing expected assertion must change, report exact path to reviewer.

## Agent4 — API/Studio
CREATE:
- server/src/custom/x-gateway/support-output-router.ts
- server/src/__tests__/custom/x-support-output-http.test.ts
- client/src/custom/x-gateway/pages/SupportOutput.tsx
- client/src/custom/x-gateway/support-output-strings.ts
- client/src/custom/x-gateway/support-output.test.tsx

EDIT:
- server/src/custom/x-gateway/console-router.ts (one router mount only)
- server/src/custom/permission-actions.ts (exact output endpoints gate only)
- client/src/custom/x-gateway/XGatewayApp.tsx (import/route only)
- client/src/custom/x-gateway/shell/nav.ts (one localized nav item only)

No widget rewrite, global CSS, dependency/lockfile, CI, old migration or upstream proxy edits. The existing widget displays the safe canonical reply notice.

## Dependency handshake

Agent1 freezes DTO/store -> Agent2 freezes engine -> Agent3 integrates; Agent4 can develop UI/API against typed contracts meanwhile. Use real peer commits to verify; test-only isolated boundaries are allowed but missing peer code is not success. Reviewer handles inter-branch integration and full checks. Never silently widen file ownership, duplicate missing services, add aliases, cast away errors or skip failures.


## Reviewer remediation authorization — 2026-11-15

The user explicitly requested “bạn hãy fix và tạo PR nhé” after the review. The reviewer integrates all four owner implementations on codex/support-output-controls from latest origin/main; no source owner checkout is mutated. The historical implementation ownership above remains the handoff record.

Authorized minimal additional hook/helper paths for F1–F5:
- server/src/app.ts: one preparse middleware mount after existing host/security/preparse gates.
- server/src/custom/x-gateway/support-output-body-limit.ts: route-specific 256KiB parser, including inflated/chunked bodies; also reused in the console router.
- server/src/custom/x-gateway/support-output-citations.ts: canonical ordinal restoration and preservation of already-redacted source display text.

Existing owned tests are strengthened/extended for the six reproductions, Copilot credential/citation preservation, policy-error fencing, malformed/oversized/chunked/gzip requests. The current-main AI Platform guard hooks and finish reasons are preserved while composing020. No new dependencies, CI changes, old migration edits or production/provider calls.

Final regression correction: server/src/__tests__/db/migrate/ai-platform-mcp-approval-safety.test.ts now rolls back through its named migration instead of assuming it is latest; required because020 adds a later migration. The old migration itself is unchanged. New Studio lint findings were corrected within its owned page by tenant-keyed state and query-derived untouched drafts.
