# Implementation Plan
## Summary
Add custom quota adapters/store/router and Quota page. Follow 9Router usage schemas and Subscription → Cheap → Free ordering. Reuse proxy transport and encrypted account store. No Playground edits.
## Technical Context
Express/TypeScript, React/TanStack Query, SQLite/Turso migration runner, Vitest/jsdom. No dependencies.
## Constitution Check
PASS: standalone modules, timestamped migration, additive DTOs, minimal mounts and response observer hook, no credential DTOs, exact auth gates and tests.
## Structure
shared/x-quota.ts; server/src/custom/x-gateway/quota/{adapters,store,router,tracking}.ts; timestamped x quota migration + defaults registration; client/src/custom/x-gateway/pages/Quota.tsx with quota-api/strings/CSS. Existing gateway candidate resolver filters quota and orders auto; transport observer scoped only to X accounts.
## Validation
Provider parsing, HTTP permission/refresh/tier, quota routing and header observations, migration up/down, UI countdown/error tests, full npm run test/build/lint. Review diff before commit/PR on shared integration branch.

## Release branch exception
The user explicitly authorized a dedicated Quota PR to keep concurrent Media and Proxy Pool work outside this release.
