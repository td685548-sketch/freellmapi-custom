# Feature Specification: Model list pagination

**Feature Branch**: `codex/model-list-pagination`
**Created**: 2026-11-08
**Status**: Implemented; validation in progress
**Input**: Show 20 models initially and load the next 20 only when the user selects Load more, reducing database load.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Browse in batches (Priority: P1)

As a dashboard user, I want the Chat Models list to open with 20 logical models and fetch more only when requested.

**Why this priority**: Opening a large catalog currently transfers and enriches the entire list even when only a few rows are needed.
**Independent Test**: Seed over 40 models; opening the page shows 20, scrolling fetches nothing, and each Load more click adds at most 20 without duplicates.

**Acceptance Scenarios**:
1. Given 45 logical models, opening the list shows 20; successive clicks show 40 and 45, then remove Load more.
2. Given multiple providers of one model, a batch includes the complete logical model and counts it once.
3. Given a failed next-batch request, existing rows remain visible and retry is available.

### User Story 2 - Find and manage models safely (Priority: P2)

As an operator, I want search, filters and sorting to cover the full catalog while changes to visible rows preserve models I have not loaded.

**Why this priority**: Paging must not hide valid search results or accidentally remove a chain's unseen entries.
**Independent Test**: Find a model beyond the first batch, change a visible toggle and save, then verify hidden entries and another chain are unchanged.

**Acceptance Scenarios**:
1. Changing search, filters, sorting or active chain starts at the first batch of the new selection.
2. Search finds matching models anywhere in the catalog, including provider labels.
3. Saving visible edits preserves unseen rows; bulk toggles affect the displayed selection consistently with their label.
4. Manual order changes preserve the full chain and never overwrite unseen priorities.

### Edge Cases

- Empty catalogs, fewer than 20 results, a partial final batch and no search matches.
- Rapid repeated clicks, filter changes during a request and chain changes with unsaved edits.
- Concurrent catalog updates and a stale paging snapshot.
- Guest access and existing clients of the unpaged endpoints remain compatible.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Initial and subsequent batches MUST contain at most 20 logical models.
- **FR-002**: Further batches MUST require an explicit Load more action; scrolling MUST NOT automatically load more.
- **FR-003**: Search, filters and sorting MUST select results across the complete catalog before batching.
- **FR-004**: Every logical model MUST retain its complete provider membership.
- **FR-005**: Paging and edits MUST remain scoped to the active chain and preserve unseen models.
- **FR-006**: The list MUST avoid full-catalog detail and quota refreshes for unloaded models, and reuse short-lived shared work where global ranking requires it.
- **FR-007**: Existing endpoints, authentication, routing behavior and deployment modes MUST remain backward compatible.
- **FR-008**: Loading, retry and end-of-list states MUST be clear and accessible.

### Key Entities

- **Logical model**: A displayed model with one or more provider members and a global chain rank.
- **Batch**: Up to 20 logical models plus continuation and total-count information for one selection.
- **Selection**: Active chain, search text, capability/context filters and sort order.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 45-model catalog shows exactly 20, 40 and 45 rows after zero, one and two Load more actions.
- **SC-002**: No next-batch request is made by scrolling or idle time alone.
- **SC-003**: Unloaded models receive no per-model detail or quota enrichment on initial load or periodic refresh.
- **SC-004**: Searching for a model outside the initial batch returns it without loading earlier batches.
- **SC-005**: Editing loaded rows leaves unseen chain entries unchanged in integration tests.

## Assumptions

- The screenshot refers to the authenticated Chat Models table; other modality pages retain their current behavior.
- Existing authentication and logical-model grouping rules are reused.
- Global ranking may require a lightweight catalog snapshot; batching must reduce repeated database work and detailed enrichment, not merely hide rows.
