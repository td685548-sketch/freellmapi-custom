# Feature Specification: X Gateway Proxy Pool

**Feature Branch**: `feat/9router-integration`
**Created**: 2026-11-07
**Status**: Ready
**Input**: Port 9Router Proxy Pools (multiple outbound proxies, sticky per account). Today X Gateway has a single gateway-wide outbound proxy plus a per-account proxy URL override.

## User Scenarios & Testing

### User Story 1 - Manage a pool of proxies (Priority: P1)
An administrator adds several named proxies (HTTP/HTTPS/SOCKS), enables/disables entries, tests them and removes them.
**Independent Test**: Create two entries, disable one, delete the other over `/api/thruline/proxy-pool`.
**Acceptance Scenarios**:
1. Given a valid proxy URL, when creating an entry, then it is stored encrypted and listed with a masked URL.
2. Given an entry bound to accounts, when deleting it, then those accounts fall back to the gateway-wide proxy (never a deleted proxy).
3. Given a member without `edit_x_settings`, when writing the pool, then 403; reads need only `use_x_gateway`.

### User Story 2 - Sticky proxy per account (Priority: P1)
Each account is bound to one pool entry — chosen manually or auto-assigned round-robin (least-bound entry) at connect time. Every request of that account leaves through the same proxy, so providers see a stable IP per account.
**Independent Test**: With two entries, connect four accounts without proxy settings; bindings split 2/2 and `resolveXGatewayAccountProxy` returns the bound URL.
**Acceptance Scenarios**:
1. Given no explicit proxy URL and no explicit binding, when connecting an account, then the enabled entry with the fewest bound accounts is assigned.
2. Given an account bound to an entry, when the entry is disabled, then requests fall back to the gateway-wide proxy, then direct.
3. Priority order: per-account explicit proxy URL > pool binding > gateway-wide proxy > direct.

### User Story 3 - Pool UI (Priority: P2)
A "Proxy Pool" page in the X Gateway console manages entries; the account edit dialog and connect dialog offer a pool selector (auto / none / specific entry).
**Independent Test**: Add an entry on the page, bind it to an account in the edit dialog, see the pool name on the account card.

### Edge Cases
Empty pool (auto-assign is a no-op), duplicate names (409), invalid schemes (400), undecryptable URLs (degrade to fallback), pool entry deleted mid-flight, gateway disabled (pool API still session-gated like the rest of the console).

## Requirements
- **FR-001**: New `x_gateway_proxy_pool` table (encrypted URL, enabled flag) and `x_gateway_keys.proxy_pool_id` FK with ON DELETE SET NULL; new timestamped migration only.
- **FR-002**: CRUD + test endpoints under `/api/thruline/proxy-pool`; reads map to `use_x_gateway`, writes to `edit_x_settings`.
- **FR-003**: Auto-assign the least-bound enabled entry on account creation when no explicit proxy URL/binding is given; `proxyPoolId: null` opts out.
- **FR-004**: Account PATCH accepts `proxyPoolId` (number binds, null unbinds); list responses expose `proxyPoolId`/`proxyPoolName`.
- **FR-005**: Keep the single gateway-wide proxy and per-account URL override working unchanged as fallbacks.
- **FR-006**: Proxy URLs never leave the server unmasked except inside the outbound dispatch layer; test results are credential-safe.
- **FR-007**: English/Vietnamese labels; reuse existing x-console styling.

## Success Criteria
- **SC-001**: Four accounts across two entries bind 2/2 without manual assignment.
- **SC-002**: Disabling/deleting a bound entry never routes through it again and never breaks the account.
- **SC-003**: Existing proxy tests (gateway-wide + per-account override) stay green.

## Assumptions
- Sticky per account (confirmed by user); per-request rotation is out of scope.
- No relay deployers (vercel/cloudflare/deno/netlify) — HTTP/HTTPS/SOCKS proxies only, matching the existing proxy layer.
- Auto-assign balances by current bound-account count, which is restart-safe (unlike 9Router's in-memory cursor).