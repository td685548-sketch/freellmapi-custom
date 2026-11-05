# Implementation Plan: Dashboard performance baseline (P01)

**Branch**: `codex/p01-dashboard-performance` | **Date**: 2026-11-05 | **Spec**: [spec.md](spec.md)

## Summary
Add opt-in bounded measurements and a synthetic authenticated HTTP benchmark before changing DB/polling behavior.

## Technical Context
TypeScript ESM, Node 20/22/24, Express 5, existing synchronous Db contract. Use AsyncLocalStorage and perf_hooks histograms without new dependencies. No schema changes or public endpoint. Target <=5% p95 overhead; measure rather than assume.

## Constitution Check
Pass before/after design: no secret-bearing structures; unchanged auth/quota; standalone custom modules and minimal hooks; tests/build/lint required. No exceptions.

## Project Structure
- server/src/custom/performance/: metrics and DB wrapper
- server/src/__tests__/custom/performance.test.ts: isolation/privacy/lifecycle/semantics
- server/src/scripts/benchmark-dashboard.ts: synthetic-only local benchmark
- docs/performance/results/: measured evidence and limits

## Design and Rollout
CUSTOM_PERF_METRICS=1 installs one process monitor and one unref timer. Fixed GET allowlist; middleware after host guard, before parsing/auth. Db wrapper retains synchronous contract. Count logical prepare/execution and native Turso prepare separately, never call these network RPCs. Minute aggregate reports contain only numeric fields and fixed labels. Explicit stop on graceful shutdown. Remove flag and restart to disable.

Benchmark imports createApp, never env.js/index.ts; always fresh in-memory SQLite, fake encrypted keys and synthetic sessions. No schedulers/provider inference. Local measurement cannot establish Render cold starts, remote Turso latency or browser hydration. Those remain explicitly unmeasured and require staging.
