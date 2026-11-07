# Tasks: X Gateway Proxy Pool

## Phase 1: Foundation
- [x] T001 Migration `20261107_150000_custom_x_gateway_proxy_pool.ts` + registry entry in db/migrate/defaults.ts.
- [x] T002 Store `server/src/custom/x-gateway/proxy-pool.ts` (CRUD, masked list, resolve, least-bound pick).

## Phase 2: Wiring
- [x] T003 store.ts: `proxy_pool_id` on AccountRow, resolution order explicit > pool > gateway, auto-assign on create, bind/unbind on update.
- [x] T004 `proxy-pool-router.ts` mounted in console-router; permission mapping in permission-actions.ts; shared/x-accounts.ts + provider-accounts/router.ts pass-through.

## Phase 3: UI
- [x] T005 `proxy-pool-api.ts`, `proxy-pool-strings.ts`, `pages/ProxyPool.tsx`; nav + route in XGatewayApp.
- [x] T006 Pool selector in account edit dialog + connect dialog; pool name on account card.

## Phase 4: Verification
- [x] T007 `server/src/__tests__/custom/x-proxy-pool.test.ts`: CRUD, permissions, resolution order, auto-assign balance, fallback on disable/delete, test endpoint.
- [x] T008 npm test (server), build, lint; existing x-gateway-access proxy test stays green.