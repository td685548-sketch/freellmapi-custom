# Implementation Plan: Admin-only X Gateway (separate API flow and console)

**Branch**: `007-admin-x-gateway` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-admin-x-gateway/spec.md`

## Summary

A second, admin-only door into the existing model pool: an OpenAI-compatible chat flow at `/thruline/v1`, its own configuration (on/off switch, combos, saver defaults) in its own tables, and its own console at `/thruline` with its own layout. The chat flow does **not** re-implement routing: a thin edge layer authenticates the administrator, applies the optional token savers, resolves a combo into an ordered chain, and hands the request to the existing chat handler, so provider selection, failover, streaming, quota recording and logging stay in one place. Isolation is at the edge (separate address space, storage, permission, UI), not by duplicating the core.

## Technical Context

**Language/Version**: TypeScript (ESM), Node 20/22/24, Express 5; React + Vite client (existing).
**Primary Dependencies**: none new. Reuses the compression pipeline, the system-prompt helper, the personal-key service, `AsyncLocalStorage`.
**Storage**: two new tables (config, combos) and one hourly usage table, created by a new timestamped migration; SQLite locally, Turso remotely (synchronous driver).
**Testing**: Vitest (server and client), the existing remote-style round-trip budget harness, the migration round-trip test.
**Target Platform**: the existing single deployment (Render, Docker, desktop); no new service.
**Project Type**: web application (server + client monorepo).
**Performance Goals**: no more storage round trips per request than an equivalent `/v1` request (SC-007); configuration is served from memory in steady state.
**Constraints**: synchronous remote database (each statement blocks the process, about 100 ms on Render+Turso); 512 MB RAM; zero-conflict modular design; `/v1/*`, `/livez`, `/readyz`, `/api/ping` untouched.
**Scale/Scope**: one administrator, tens of combos (cap 20 entries each, 50 combos), a handful of concurrent requests.

## Constitution Check

*GATE: passed before research; re-checked after design (below).*

| Principle | Assessment |
| --- | --- |
| I. Security and credential protection | No provider key or personal key is stored or returned by the new code; the key is only ever read by the existing personal-key service. New access path gated by permission, re-checked per request; body-size guard and rate limits extended to the new address space; documented in research D9. **Pass.** |
| II. Monorepo separation | Server code in `server/src/custom|routes|services`, UI in `client/src/custom/x-gateway`, shared permission names in `shared/`. **Pass.** |
| III. Robustness | Idempotent migration with down step; fail-open savers; kill switch; no new background process except a 60 s unref'd flush. **Pass.** |
| IV. Test-first | Server, client and migration round-trip tests listed in the task phase; budget tests for round trips. **Pass.** |
| V. Backward compatibility | Existing endpoints unchanged; all new behaviour behind the switch (default off). **Pass.** |
| VI. Zero-conflict modular design | New files only, plus the small upstream touch points enumerated below. **Pass with listed touch points.** |
| VII. Branch/PR workflow | Work on a branch, PR into `main`, CI green. **Pass.** |

### Upstream touch points (each minimal, none reformats code)

| File | Change |
| --- | --- |
| `server/src/app.ts` | add `/thruline/v1` to the large-body JSON limit list and to the proxy rate-limiter mounts (two one-token edits) |
| `server/src/custom/preparse-guard.ts` (custom) | classify `/thruline/v1` as a credentialed path |
| `server/src/services/router.ts` | one optional resolver hook at the top of `resolveRoutingChain` (about 5 lines) |
| `server/src/lib/request-log.ts` | read an optional caller tag from the request context (about 2 lines) |
| `server/src/db/migrate/defaults.ts` and `__tests__/db/migrate/roundtrip.test.ts` | register the new migration (2 lines each) |
| `client/src/App.tsx` | split the top-level routes so `/thruline/*` renders its own shell (about 6 lines) |
| `shared/permissions.ts`, `custom/permission-actions.ts`, `custom/register.ts` (custom) | new permission group, path mapping, mounts |

## Project Structure

### Documentation (this feature)

```text
specs/007-admin-x-gateway/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── x-gateway-api.md      # /thruline/v1 public contract
│   └── console-api.md        # /api/x-gateway console contract
├── checklists/requirements.md
└── tasks.md                  # created by /speckit-tasks
```

### Source Code

```text
server/src/
├── custom/x-gateway/
│   ├── config.ts            # cached config + combos, invalidation, kill switch
│   ├── auth.ts              # permission gate for the /thruline/v1 flow
│   ├── savers.ts            # caveman / ponytail / input saver, request-header parsing
│   ├── combos.ts            # name validation, combo -> ordered chain
│   ├── context.ts           # AsyncLocalStorage flag (combo resolution + usage tag)
│   ├── router.ts            # /thruline/v1/chat/completions, /thruline/v1/models, JSON 404
│   ├── console-router.ts    # /api/x-gateway/* (status, combos, defaults, usage, test)
│   └── usage.ts             # in-memory saved-token counters, 60 s hourly flush
├── db/migrations/20261106_000001_custom_x_gateway.ts
└── __tests__/custom/x-gateway-*.test.ts

client/src/custom/x-gateway/
├── XGatewayApp.tsx          # own shell + routes (/thruline, /thruline/combos, /thruline/test, /thruline/usage)
├── pages/                   # Overview, Combos, Savers, Test, Usage
├── api.ts, strings.ts       # own API client and own strings (no shared locale files)
└── *.test.tsx

shared/permissions.ts        # + manage_x_gateway group
docs/x-gateway.md            # security considerations and operator guide
```

**Structure Decision**: web application layout already used by the repository; everything new lives under `custom/x-gateway` directories so an upstream sync cannot conflict with it.

## Design

1. **Edge pipeline for `/thruline/v1/chat/completions`**: pre-parse guard (existing) → JSON parser (large limit) → per-user rate limit and key validation (existing personal-key gate, mounted for the new address space) → gateway switch (404 when off) → permission check (`use_x_gateway`, per request) → request-header parsing (savers, bypass) → combo resolution → savers → dispatch into the existing chat handler → response. Failures before dispatch never reach a provider.
2. **Dispatch**: the edge middleware rewrites the internal path to the chat handler and invokes the existing router inside an `AsyncLocalStorage` scope carrying `{ gateway: 'x', combo, savers }`. The existing handler re-validates the key (memoised inside the same request) and runs its normal fallback, streaming and logging.
3. **Combos** are resolved by one optional hook in `resolveRoutingChain`; the hook answers only when the scope flag is set, so a client of `/v1` cannot name a combo. A combo becomes an ordered chain of enabled catalogue rows, scored with the strict-order strategy, so entries are tried in the administrator's order.
4. **Savers** are pure functions over the parsed messages: output savers prepend one instruction block; the input saver calls the existing compression pipeline with an explicit mode and without recording its statistics, and the delegated request carries the compression-off directive so the main flow does not compress twice. Every saver fails open.
5. **Configuration** lives in `x_gateway_config` and `x_gateway_combos`, read through an in-memory cache that is invalidated on every console write and re-read at most every 5 s, so a request normally costs no configuration query.
6. **Usage**: requests are tagged `x-gateway` in the existing request log through the scope flag (no extra write); tokens saved are counted in memory and flushed once a minute into `x_gateway_usage_hourly`; the usage view reads both.
7. **Console API** under `/api/x-gateway/*`, authenticated by the dashboard session (bearer, so no cookie CSRF surface) and gated by the new permission group through the existing permission-gate table.
8. **Console UI**: a top-level route split renders `XGatewayApp` with its own header and navigation for any path under `/thruline`; the main navigation shows a link only to permitted users. The console uses its own small string table so the 60 shared locale files stay untouched.

## Post-design Constitution Re-check

All principles still pass. The one cost is the upstream touch-point table above; each entry is a few lines, listed so a future upstream sync knows exactly where to look. No complexity exceptions are needed.

## Complexity Tracking

None.
