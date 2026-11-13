> Historical handoff, completed. Do not redispatch this prompt. The user replaced shared-branch instructions on2026-11-13; new features, fixes and parallel agent assignments use separate branches under AGENTS.md. Current019 review/publishing branch: `codex/support-service-desk`.

You are Agent-3 for spec019 Support Service Desk & Widget Studio in C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL equivalent /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi), existing branch feat/9router-integration.

Read AGENTS.md and ALL of specs/019-ai-support-service-desk/{spec.md,plan.md,research.md,data-model.md,contracts.md,ownership.md,tasks.md,quickstart.md,review.md} before editing. Use CodeGraph first when .codegraph exists.019 supersedes unimplemented016 for this work; do not implement016 in parallel. PR25/018 is merged. Canonical URLs are /thruline, /api/thruline and /thruline/v1; internal permission/file names remain unchanged.

STRICT OWNERSHIP — no writes outside the paths below, including peer files, specs/prompts, old migrations, packages/lockfiles/CI/theme. No branch/worktree/switch/reset/stash/merge/rebase, staging, commits, push, PR, live provider charges or real customer writes. Preserve pending Kiro.ts and016 docs. If an unlisted edit is needed, report exact path/reason to reviewer; do not add an alias/fake store or suppress tests/types. The user dispatches four agents; reviewer reviews actual integration after handoff and alone handles conditional PR, never auto-merge.

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

Your tasks: T008,T009,T010,T018,T019,T021,T022,T023,T024,T029.

Own all actual019 HTTP, server intake enforcement and canonical SLA/routing integration. Use Agent1 real DTO/store and Agent2 Copilot; no schema/raw019 SQL/secondary AI executor. Console requires verified use_x_gateway AND edit_x_settings even on GET; actual createUser/createSession/member + Bearer fixtures. Public config is a safe origin/tenant-key projection; intake/chat need verified017 signed session. No body identity/role/budget/history/clock override.

Integrate intake in BOTH runtime final transactions, current schema/receipt identity/expiry/binding recheck, off-mode fingerprint compatibility and018 replay guards. A new accepted turn (including zero-model) atomically binds receipt/metadata/messages/quota/cache; provider/quota failure doesn't consume it. Concurrent binds, schema changes mid-provider, signed guest, wrong user/tenant/conv and raw metadata spoof must fail safely. Respect exact public errors and no raw values in error payloads or workflow settings. Store receipt-reference metadata only; hydrate canonical reads from the encrypted bound record and mask/hide values without returning its internal hash.

Implement pure4-department routing and24/7 SLA engine with injected internal clock, snapshotted targets,75%/100% bounds, met/not_observed distinction and stable cursor. Lifecycle adapter imports workflow types only; hook ALL existing create/human-reply/update/resolveConversation/reopen/priority paths in synchronous workflow+SLA transactions. No read backfill, moving clock origins, AI-as-human response, worker/notification/CRM additions or implicit routing privileges. Existing nonnumeric fixtures/default-off remain compatible; real storage corruption rolls back, not silently skipped.

Minimal canonical router mounts; safe SUPPORT_PUBLIC_BASE_URL snippet with loadTenantProfile:true and no stored token/secret. Do not use req.close for disconnect. Coordinate exact envelopes with Agent4 and real pipeline/budget errors with Agent2.

Tests: >=16 pure SLA/routing cases, >=10 real lifecycle/rollback cases, >=12 intake/runtime and >=12 actual createApp HTTP scenarios. Preserve all owned017–018 regressions. Mock only external boundaries; no setTurnExecutor shortcut, fake store or swallowed assertion .catch. Run quickstart owned tests/build/lint; report exact results, code paths/exports and peer blockers. No Git publication or peer edits.
