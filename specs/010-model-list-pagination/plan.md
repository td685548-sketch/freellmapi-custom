# Implementation Plan: Model list pagination

**Branch**: `codex/model-list-pagination` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

## Summary
Add a paged dashboard endpoint with a short-lived shared ranking index and SQL detail reads scoped to the next 20 complete logical groups. Reuse the scorer's quota snapshot for selected members. Replace the Chat Models page's four eager catalog queries with an infinite-query hook and an explicit Load more button. Preserve existing API contracts.

## Technical Context
TypeScript / Node 20-24, Express, React 19, TanStack Query, SQLite and synchronous Turso. Tests use Vitest and existing DB statement instrumentation. No dependencies or schema migrations. Global ranking/group identity needs a thin all-catalog index; cache it across clicks and users rather than claim a cold score ranking can read only 20 records.

## Constitution Check
Pass: existing auth and permissions apply, no keys returned, new standalone route/service/hook modules, small isolated upstream integrations, no schema changes. Legacy unpaged routes remain unchanged. Meaningful route, query-budget and component tests cover boundaries and unseen-row preservation.

## Project Structure
- `server/src/services/model-list-page.ts`: cached thin index, global filtering/order, scoped details and cached quota usage.
- `server/src/routes/model-list-page.ts`: validated paging and profile-pinned partial writes.
- `shared/model-list-page.ts`: paging metadata contract.
- `client/src/custom/model-list/`: query hook, controls and strings.
- `client/src/pages/FallbackPage.tsx`: replace eager list queries, retain routing controls and table cells.
- `server/src/__tests__/custom/model-list-page.test.ts` and client component/hook tests.

## Design
Stable snapshot IDs prevent duplicate/missing rows when scores change between clicks. Reuse indexes for 30 seconds; retain up to 16 snapshots with a sliding five-minute expiry and LRU eviction. One periodic live request refreshes all opened groups without repeating their detail joins. Reuse existing global scoring/window snapshots; expose their already-computed monthly usage for a lightweight total budget summary. Load the full budget legend only on explicit request.

Saving is explicitly profile-pinned and updates only provided IDs. Staged edits merge by model ID as pages append. Reordering requires every matching group loaded with no filters/sort; use existing priority slots so unseen/keyless rows keep their positions. Search/filter/sort/profile changes reset paging and cancel stale requests.

## Validation
Verify 20/40/45 rows, full provider groups, global search/sort, no automatic scroll fetching, stable cursors, expiry/retry, profile isolation and hidden-row preservation. Inspect scoped SQL and assert cached continuation avoids full catalog/detail/history reads. Run relevant regressions, full test/build and lint; merge via PR only with green CI.
