# Feature Specification: Provider tiers and linked keys

**Feature Branch**: `codex/provider-tier-key-count`
**Created**: 2026-11-02
**Status**: Ready
**Input**: Create a provider tier table with linked key counts beside each provider.

## User Scenarios & Testing

### User Story 1 - Compare providers (Priority: P1)
An operator opens Analytics to compare reliability, speed, configured intelligence and an explained composite score.
**Independent Test**: Providers with at least 20 observations receive S/A/B/C/D tiers; smaller samples remain unranked.
**Acceptance Scenarios**:
1. Measured providers show tier, score, three axes and sample count for the selected range.
2. Unseen providers show missing metrics rather than invented measurements.
3. Missing speed/intelligence is explicitly shown and omitted from the weighted score.

### User Story 2 - See linked keys (Priority: P1)
An operator sees stored provider key totals beside the provider name and usable counts separately.
**Independent Test**: A second linked key increases the total without duplicating observations.
**Acceptance Scenarios**:
1. Disabled/error keys count toward linked totals, but not usable totals.
2. Custom endpoints on the same host with different paths have separate counts.
3. Providers with keys but no requests remain visible.

### Edge Cases
Zero samples, all failures, missing timing/intelligence, canceled calls, pruned history and deleted keys. If both a custom key and model are deleted, its historical endpoint identity may be unknown.

## Requirements
### Functional Requirements
- **FR-001**: Show S/A/B/C/D tiers with explained thresholds and a minimum of 20 observed chat attempts.
- **FR-002**: Show linked key totals adjacent to provider names, with usable counts separately. Counts are installation-wide upstream credentials, not personal gateway tokens.
- **FR-003**: Use retained observations only. Exclude canceled and pre-dispatch rejected calls; state that pruned history is unavailable.
- **FR-004**: Explain intelligence is configured model metadata, not measured answer quality.
- **FR-005**: Honor the Analytics time selector; current key counts are independent of historical ranges.
- **FR-006**: Require log-view permission. Expose no credentials, key labels or request contents.
- **FR-007**: Reading the table makes no provider calls, writes or routing changes.
- **FR-008**: Include loading, empty, error/retry and refresh states in the existing dashboard style.

### Key Entities
Provider: catalog platform or individual custom endpoint. Observation: successful/failed retained chat dispatch. Linked key: stored upstream credential.

## Success Criteria
- **SC-001**: Every stored key belongs to one provider row and is counted once.
- **SC-002**: Providers below 20 observations never receive a tier.
- **SC-003**: Changing range updates observations, while current linked key totals remain independent of range.
- **SC-004**: Tests verify permissions, endpoint isolation, no duplicated observations and missing data.

## Assumptions
The new table lives in Analytics and does not change routing. Fixed balanced weights: reliability 50%, speed 25%, intelligence 25%; missing axes are omitted and remaining weights normalized. Tier thresholds: S >= .85, A >= .75, B >= .65, C >= .50, otherwise D. These are product defaults, not industry standards. Usable means enabled with last health healthy/unknown; quota/cooldown are not checked. Key counts do not multiply the score.
