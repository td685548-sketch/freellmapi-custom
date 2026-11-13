> Historical handoff, completed. Do not redispatch this prompt. The user replaced shared-branch instructions on2026-11-13; new features, fixes and parallel agent assignments use separate branches under AGENTS.md. Current019 review/publishing branch: `codex/support-service-desk`.

You are Agent-1 for spec019 Support Service Desk & Widget Studio in C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL equivalent /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi), existing branch feat/9router-integration.

Read AGENTS.md and ALL of specs/019-ai-support-service-desk/{spec.md,plan.md,research.md,data-model.md,contracts.md,ownership.md,tasks.md,quickstart.md,review.md} before editing. Use CodeGraph first when .codegraph exists.019 supersedes unimplemented016 for this work; do not implement016 in parallel. PR25/018 is merged. Canonical URLs are /thruline, /api/thruline and /thruline/v1; internal permission/file names remain unchanged.

STRICT OWNERSHIP — no writes outside the paths below, including peer files, specs/prompts, old migrations, packages/lockfiles/CI/theme. No branch/worktree/switch/reset/stash/merge/rebase, staging, commits, push, PR, live provider charges or real customer writes. Preserve pending Kiro.ts and016 docs. If an unlisted edit is needed, report exact path/reason to reviewer; do not add an alias/fake store or suppress tests/types. The user dispatches four agents; reviewer reviews actual integration after handoff and alone handles conditional PR, never auto-merge.

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

Your tasks: T001,T002,T003,T005,T006,T007,T014,T020.

Implement all019 DTO/schema/storage and widget profile/intake validation. Publish the exact camelCase constants/types and real exports from data-model.md first; tell peers when ready. shared/support-runtime.ts changes are additive receipt input/accepted metadata only. Create/register only the new20261113_180001 migration, never edit old migrations.

Use existing Db/AES-GCM, base migrations and lazy tenant schema; test a second independent memory Db, populated up/down/up/cascade/encryption. Healthy missing config returns fresh defaults; corruption/unavailable storage typed503, never off/default fallback. createSupportTenant returns {tenant,signingSecret}; initialize real settings/base schema in tests.

Validate strict bounded profile/intake fields and reserved keys; schemaHash excludes appearance, receipt bound to tenant/user/current role/schema/optional conversation, encrypted replay payload, hashed receipt lookup, TTL/rate cap/OCC. bind is atomic/idempotent for one conversation, never identity/CRM mutation. Raw values remain encrypted; workflow settings store only receipt-reference metadata, never a duplicate of values. Provide the scoped internal bound-receipt hydration reader; no browser-role trust.

Copilot jobs own actor/request claim, leaseToken fencing, before-attempt reservation/attemptId idempotency, actual/conservative cost, request/hour and token/day windows and expiry retention. No customer quota reuse or await in transactions. SLA table stores snapshotted cycle/targets/routing with version; no runtime-table FK or raw019 SQL in peers.

Write >=16 store/profile/budget/intake regressions plus migration tests. Run your first quickstart command and build/type checks when peer imports exist. Publish exact service signatures to Agent2/3, do not silently change contracts. Report files, task IDs, exports, commands/counts, adapter coverage and remaining blockers; reviewer integrates the complete feature.
