# Implementation plan
## Technical context
TypeScript/ESM shared permission catalog, Express custom gate integration, React/TanStack Query, existing settings JSON and Vitest. No dependencies or schema changes.
## Constitution check
PASS: modular custom permission classifier and UI sections, minimal upstream hooks, no secret storage change, backward-compatible parent grants, test-first authorization matrix, branch/PR. Recheck after design: PASS.
## Architecture
shared/permissions.ts owns immutable group/child definitions and implication helpers, reexported by user-access.ts. Server requirePermission and client session hook consume it. Custom permission route classifier resolves method+normalized full URL to a child or exact parent fallback; no child can authorize an unknown operation. User management re-reads actor/target permissions transactionally and enforces no escalation/self changes/root protection. Explicit admin grants replace unconditional role bypass.
A separate cache-preferences route exposes safe settings metadata and atomically updates enabled/persist flags. Cache service reads persisted preference with env fallback. Settings General embeds a dedicated component. Restricted key users use a small custom page with existing add/edit/reveal/export dialogs; unrelated upstream key widgets remain unchanged for full managers. Other custom pages gate requests/actions individually; original complex pages use scoped capability hooks.
## Validation
Unit implication/classifier tests plus actual HTTP denied/allowed/no-side-effect matrices; actor/target escalation tests, UI permission editor/scoped actions and cache settings tests. Run focused tests then full tests/build/lint. Linux CI must be green before merge; wait main CI and verify deployed SHA.
