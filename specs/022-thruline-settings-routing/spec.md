# Spec 022 — Thruline Settings page & global routing defaults

**Branch**: `feat/thruline-settings-routing` · **Status**: Implemented

## Background
A comparison with 9Router showed Thruline lacks (a) global routing-strategy
settings and (b) a Settings page. Thruline only had per-provider and per-combo
round-robin. Items that are local-machine only in 9Router (MITM, tunnels,
database location, process control, "Require login") are explicitly out of scope
for a hosted multi-user deployment.

## User stories
1. **Admin** sets a default account strategy (Fallback / Round-robin) and sticky
   limit that applies to every provider without its own explicit strategy.
2. **Admin** can make all `fallback` combos rotate (Combo Round Robin) and choose
   how many calls each combo step serves before rotating (Combo Sticky Limit).
3. **Any signed-in user** can change the interface language and change their
   password from a Settings page inside Thruline.

## Functional requirements
- FR-1 `GET/PUT /api/thruline/routing-defaults` returns/stores
  `{ accountStrategy: 'fallback'|'round-robin', accountStickyLimit: 1..100,
  comboRoundRobin: boolean, comboStickyLimit: 1..100 }`. Defaults:
  `fallback`, 3, `false`, 1. Strict validation; unknown keys rejected.
- FR-2 Read needs `use_x_gateway`; write needs `edit_x_settings`.
- FR-3 Provider-level explicit `strategy` always wins over the global default.
- FR-4 Combos with strategy `round-robin` always rotate; `fallback` combos rotate
  only when `comboRoundRobin` is on; `smart` and `fusion` are never altered.
- FR-5 Combo sticky limit of 1 preserves today's per-request rotation exactly.
- FR-6 Settings page `/thruline/settings` with Routing, Account (password) and
  Language sections; routing section read-only without `edit_x_settings`.
- FR-7 Password change uses existing `POST /api/auth/change-password` (min 8).

## Non-functional / constraints
- Zero-conflict rules: new files, no new migration (uses `x_gateway_config` key
  `routing_defaults`), minimal edits to `router.ts`, `combos.ts`,
  `console-router.ts`, `permission-actions.ts`, `XGatewayApp.tsx`, `nav.ts`.
- `/thruline/v1`, `/v1/*` and other public endpoints are unchanged.
- Default values keep behaviour identical for existing deployments.

## Out of scope
SSO (SAML/OIDC), Require-login toggle, tunnels, MITM, database location.
