# Feature Specification: Dashboard performance baseline (P01)

**Feature Branch**: `codex/p01-dashboard-performance`
**Created**: 2026-11-05
**Status**: Implemented; local evidence ready, staging acceptance pending review
**Input**: Improve Render startup and dashboard database loading; begin with the P01 baseline required by docs/performance.

## User Scenarios & Testing

### User Story 1 - Locate expensive dashboard reads (Priority: P1)

An operator can distinguish HTTP response time, database work and process stalls before choosing an optimization.

**Independent Test**: Exercise authenticated dashboard reads against synthetic data and compare route summaries with instrumentation disabled/enabled.

**Acceptance Scenarios**:
1. Given concurrent reads, when summaries are produced, each request's database work belongs to its own route.
2. Given instrumentation is disabled, when the app starts, no performance monitor, timer or database wrapper is installed.
3. Given a slow or aborted response, when a report is produced, failures and disconnects remain visible and are counted once.

### User Story 2 - Reproduce safely (Priority: P2)

A developer can run the same measurement without production credentials or provider calls.

**Independent Test**: Run a local fixture with administrator and member sessions and inspect the generated report.

**Acceptance Scenarios**:
1. Given local environment files contain credentials, when the benchmark runs, it uses only a fresh in-memory database and synthetic sessions.
2. Given secrets in paths, bodies, queries or database errors, when summaries are serialized, none appear in the report.

### Edge Cases

Concurrent asynchronous work; statements prepared before a request; exceptions and nested transactions; client disconnect followed by finish; no samples; long responses; repeated app creation; monitor shutdown.

## Requirements

### Functional Requirements

- **FR-001**: Measurement is opt-in and exposes no public metrics endpoint.
- **FR-002**: Reports contain only fixed route identifiers, numeric aggregates and fixed backend identifiers; no user IDs, URLs, SQL or credentials.
- **FR-003**: Count database preparation separately from execution and actual native preparation; do not label logical calls as network requests.
- **FR-004**: Retain bounded aggregate distributions rather than individual request records.
- **FR-005**: Use existing authentication and permissions unchanged; measure successful and denied reads separately through status counts.
- **FR-006**: Supply a reproducible synthetic benchmark, record environment and limitations, and rank measured bottlenecks.
- **FR-007**: Preserve all existing APIs and SQLite/Turso behavior; no migration, infrastructure change or provider inference.

### Key Entities

- Request measurement: fixed route, elapsed time, database counters and completion status, scoped to one request.
- Window summary: bounded route aggregates, process memory and event-loop distribution.
- Benchmark workload: fixture size, role, concurrency, sample count and client-observed results.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Two independent concurrent requests never share database counters.
- **SC-002**: At least 100 samples per recorded route/role/concurrency workload, with errors retained.
- **SC-003**: Publish instrumentation overhead from at least 10,000 synthetic requests and report whether the 5% p95 target is met.
- **SC-004**: Repeated windows and unknown paths do not increase the number of retained route series.
- **SC-005**: Full checks pass or failures are documented without claiming unverified production gains.

## Assumptions

- This PR implements P01 only; optimization PRs follow measured evidence and review.
- Local SQLite and synthetic delay cannot establish production Turso latency or Render cold-start duration.
- Browser waterfalls and live authenticated measurements require a separately configured staging session; report unavailable measurements explicitly.
