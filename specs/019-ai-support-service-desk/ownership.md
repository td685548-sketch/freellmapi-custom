> Branch policy update2026-11-13: the user retired the shared integration branch. The implementation handoff below is historical; current review fixes and PR use `codex/support-service-desk`. Future feature/fix/parallel-agent branches follow AGENTS.md. Existing ownership of application files remains unchanged.

# Exclusive four-agent ownership

Use existing feat/9router-integration in this checkout; no new branch/worktree, switch, reset, stash, merge/rebase, stage, commit, push, PR or live provider/customer writes by implementation agents. Preserve pending Kiro.ts and untracked016; do not implement016 in parallel. User owns dispatch. Reviewer reviews real diffs after all handoffs, returns fixes to owners and creates/reuses a PR only after gates; no auto-merge. Today's turn changes documentation only.

Every unlisted path is read-only, including019 documents/prompts, packages/lockfiles/CI, old migrations, branding/theme and peer files. Report exact missing path/signature rather than silently widening ownership, duplicating modules, suppressing types or adding production fallbacks. ownership.json is the machine-readable mirror; this prose describes allowed edit scope.

## Agent-1 — Shared DTOs, all019 persistence, widget profile & intake validation

CREATE:
- shared/support-service-desk.ts
- server/src/custom/x-gateway/support-service-desk-store.ts
- server/src/custom/x-gateway/support-widget-profile.ts
- server/src/db/migrations/20261113_180001_support_service_desk.ts
- server/src/__tests__/custom/x-support-service-desk-store.test.ts
- server/src/__tests__/custom/x-support-widget-profile.test.ts
- server/src/__tests__/db/migrate/support-service-desk.test.ts

EDIT ONLY:
- shared/support-runtime.ts
- server/src/db/migrate/defaults.ts
- server/src/__tests__/db/migrate/roundtrip.test.ts

## Agent-2 — Real-model grounded operator Copilot

CREATE:
- server/src/custom/x-gateway/support-agent-copilot.ts
- server/src/__tests__/custom/x-support-agent-copilot.test.ts
- server/src/__tests__/fixtures/support-service-desk/copilot-cases.json

EDIT ONLY:
- None.

## Agent-3 — SLA/routing lifecycle, real HTTP and intake runtime enforcement

CREATE:
- server/src/custom/x-gateway/support-sla-routing.ts
- server/src/custom/x-gateway/support-service-desk-lifecycle.ts
- server/src/custom/x-gateway/support-service-desk-runtime.ts
- server/src/custom/x-gateway/support-service-desk-router.ts
- server/src/__tests__/custom/x-support-sla-routing.test.ts
- server/src/__tests__/custom/x-support-service-desk-lifecycle.test.ts
- server/src/__tests__/custom/x-support-service-desk-runtime.test.ts
- server/src/__tests__/custom/x-support-service-desk-http.test.ts

EDIT ONLY:
- server/src/custom/x-gateway/console-router.ts
- server/src/custom/x-gateway/router.ts
- server/src/custom/x-gateway/support-router.ts
- server/src/custom/x-gateway/support-runtime.ts
- server/src/custom/x-gateway/support-runtime-store.ts
- server/src/custom/x-gateway/support-workflows.ts
- server/src/__tests__/custom/x-support-runtime.test.ts
- server/src/__tests__/custom/x-support-runtime-http.test.ts
- server/src/__tests__/custom/x-support-workflows.test.ts

## Agent-4 — Service Desk Studio, native UI and actual served widget

CREATE:
- client/src/custom/x-gateway/support-service-desk-strings.ts
- client/src/custom/x-gateway/pages/SupportServiceDesk.tsx
- client/src/custom/x-gateway/components/SupportWidgetPreview.tsx
- client/src/custom/x-gateway/support-service-desk.test.tsx

EDIT ONLY:
- client/src/custom/x-gateway/XGatewayApp.tsx
- client/src/custom/x-gateway/shell/nav.ts
- server/src/custom/x-gateway/support-runtime-widget.ts
- server/src/__tests__/custom/x-support-runtime-widget.test.ts

## Limits on existing files

- Agent1 shared/support-runtime.ts: additive optional SupportRuntimeMetadata.intake={schemaHash,submittedAt} and SupportRuntimeChatInput.intakeReceiptId?:string only; no changes to017 defaults/quotas/evidence. defaults/roundtrip: register/expect only the new migration.
- Agent3 console-router/router.ts: minimal new console/public router mounts; preserve canonical /api/thruline and /thruline/v1 gates. support-router.ts: trusted intake field plumbing/strict rejection of spoofed internal metadata only, no provider refactor. runtime/store: receipt fingerprint/gate hooks and both final transactions, no second executor. workflows: additive internalIntake/metadata and synchronous lifecycle transaction hooks; preserve018 read redaction and legacy off behavior. Existing tests add regressions, do not rewrite unrelated cases.
- Agent4 XGatewayApp/nav: only new Service Desk import/route/grouped nav item. Served widget changes must compose017/018 behavior; no second widget file, no global theme/CSS or legacy redirect edits. Native React createRoot/act; never @testing-library/react.

## Handshake / dependency order

1. Agent1 publishes actual shared DTOs, exact camelCase constants, tables/bootstrap and typed store signatures. Other agents can prepare owned tests/components but cannot claim integration with a missing peer or a fake registry.
2. Agent2 publishes generateSupportAgentCopilot/readSupportAgentCopilotJob signatures and the actual provider-bound hooks. Agent3 consumes them only behind editor auth. Agent1 owns every019 storage change including budget/claim fencing.
3. Agent3 confirms actual config/intake/copilot/queue envelopes and trusted metadata with Agent4; Agent4 consumes canonical paths and server codes. Agent3 never edits served widget/frontend, Agent4 never edits backend routers.
4. Read spec/data-model/contracts before edits. Changes to frozen contracts require reporting to reviewer; no unilateral alias or fake test DTO. No await in SQLite transactions, no customer quota charge for Copilot, no autonomous send.
5. Each handoff states task IDs, exact paths/exports, actual commands/counts, peer prerequisites and unverified issues. Reviewer handles latest-main sync with pending work preserved, whole workspace inventory, scoped commit and conditional PR. Do not infer merge authorization.
