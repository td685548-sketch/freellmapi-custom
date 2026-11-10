# Implementation Plan: X Gateway hosted operations

## Technical Context
TypeScript/Express, React, Node 20–24, existing SQLite/Turso. No new dependencies.

## Constitution Check
Pass: encrypted storage unchanged; custom modules; existing permissions and public endpoints preserved; no migration; tests required.

## Phase 0: Research
Use actual loopback HTTP on the incoming socket's local port, never Host/Forwarded headers or user-provided URLs. Require full selected key. Bound response sizes, timeouts and concurrent probes. Keep evidence per console session, expiring after five minutes. Static configuration is not proof of upstream availability.

## Phase 1: Design
shared/x-operations.ts contracts; tool-probe.ts bounded HTTP; diagnostics.ts conservative readiness; cli-tools-router.ts actual probes; CLI Tools full key/model inputs; standalone local setup script with backup/restore; Render docs and smoke tests. No package/lockfile/Dockerfile changes expected.

## Validation
HTTP fixture through real app auth and upstream, credential restrictions, cancellation, malformed responses, setup preservation/restore in temporary homes, UI submission; full test/build/lint. Linux via WSL if Docker unavailable, report limits.
