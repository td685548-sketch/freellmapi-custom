# Research: Admin-only X Gateway

All unknowns from the plan are resolved below. Nothing is left as NEEDS CLARIFICATION.

## D1. Reuse the existing chat handler through dispatch, do not re-implement it

- **Decision**: the new flow authenticates and prepares the request, then invokes the existing chat router in-process.
- **Rationale**: the chat handler is about 1,500 lines (validation, tool-call normalisation, failover, streaming, retries, logging, quota). Copying it would fork every future fix; extracting it would be a large refactor of an upstream file. Dispatch gives separation at the edge with zero duplication, and every protection added to the main flow (including the performance work already merged) applies automatically.
- **Alternatives**: copy the handler (drifts, doubles maintenance); extract a function from `routes/proxy.ts` (invasive for upstream sync); a second server process (no benefit on a 512 MB instance).

## D2. Combos use their own storage and one guarded resolver hook

- **Decision**: store combos in `x_gateway_combos`; resolve them in `resolveRoutingChain` through an optional hook that only answers when the request scope is flagged as the X gateway.
- **Rationale**: the owner asked for separation, so combos must not be profiles; the routing seam that already turns `auto:<name>` into a chain is the narrowest place to plug in. The scope flag stops a `/v1` client from naming a combo, which would bypass the permission.
- **Alternatives**: create hidden profiles (shares a namespace and the dashboard's chain UI); rewrite the model to a profile name (same); expand combos in the edge layer and loop over providers there (re-implements failover).

## D3. Authenticate with the administrator's personal key, one extra column set, no extra round trip

- **Decision**: reuse the personal-key service and extend its existing lookup to also return the account's primary flag and permission list.
- **Rationale**: the key lookup already joins the user row; adding columns costs nothing, so the per-request permission re-check (FR-006) does not add a storage round trip (SC-007). Rate limiting and usage tagging come from the existing personal-key gate once it is also mounted for `/x/v1`.
- **Alternatives**: a separate key type (new table and UI, more attack surface, no benefit); a second query per request (+1 round trip, about 100 ms on Turso).

## D4. New permission group, checked per request

- **Decision**: group `manage_x_gateway` with leaves `use_x_gateway`, `edit_x_combos`, `edit_x_settings`, `view_x_usage`; the primary administrator holds everything implicitly; delegation follows the existing rule (cannot grant what you do not hold).
- **Rationale**: matches how every other area is permissioned, so the existing permission dialog, gate table and tests apply. Unknown paths fall back to the parent permission, which is the safe default.

## D5. Input saver: reuse the compression pipeline with an explicit mode

- **Decision**: call the existing compression with a forced mode and statistics recording off, and tell the main flow not to compress again.
- **Rationale**: the pipeline already has about 17 tool-output filters (git status/diff/log, search, file lists, build and test output, stack traces, JSON dumps) plus deduplication, so it covers the 9router behaviours that matter. The global compression setting stays untouched (default off), because a request header can never raise a mode the operator did not permit; forcing the mode per call avoids touching that setting.
- **New filters**: none planned. The success criterion (at least 20% on a tool-output-heavy fixture) decides; a filter is added only for the gateway, and only if the fixture falls short.

## D6. Output savers are static instruction blocks, one message

- **Decision**: caveman and ponytail (lite/full/ultra) are fixed strings injected as a single system message ahead of the conversation; stackable in a fixed order; never edit other messages; skipped if they would exceed the model's context.
- **Rationale**: satisfies FR-015/016 and SC-005 (at most 300 tokens). Fixed text removes any prompt-injection path from configuration.

## D7. Configuration and usage storage

- **Decision**: three tables in one idempotent migration; config served from an invalidating in-memory cache (TTL 5 s as a safety net); tokens saved counted in memory and flushed once a minute.
- **Rationale**: the driver blocks the process for every statement, so configuration reads and per-request usage writes must not be per request. Request counts and tokens come from the existing request log, tagged through the scope flag, so there is no second write. Losing at most one minute of "tokens saved" on a crash is acceptable for an informational figure.
- **Alternatives**: read config per request (+1 round trip); write a usage row per request (+1 write).

## D8. Address space, body limits, rate limits, pre-parse guard

- **Decision**: `/x/v1` is a credentialed path for the pre-parse guard, uses the large-body limit, and sits behind the proxy rate limiter; any unmatched path under `/x/v1` answers JSON 404 so the single-page-app fallback never serves HTML there.
- **Rationale**: without these edits the administrator's own large requests would be refused as anonymous (the guard defaults unknown paths to public) and the gateway would sit outside the rate limits. All are one-token changes.

## D9. Security considerations (new attack surface)

| Threat | Control |
| --- | --- |
| Non-admin uses the gateway | permission checked on every request; 401/403; tests for anonymous, member, revoked key, demoted admin |
| Combo names used from `/v1` | resolver answers only inside the gateway scope |
| Privilege escalation through the new permission | existing delegation rule; group appears in the existing dialog |
| Large or slow anonymous bodies | existing pre-parse guard extended to `/x/v1` |
| Abuse by a stolen admin key | per-user rate limit, revocation (existing), kill switch, logging with the `x-gateway` tag |
| Instruction injection through savers | fixed server-side text only; no user-supplied saver text in phase 1 |
| Key disclosure through the console | the console never receives or displays a key; the usage example uses a placeholder |
| CSRF on console APIs | bearer-token session, no cookies |
| Cache staleness after permission change | permission read from the key lookup on every request, not cached |
| Information leakage when off | 404 identical to an unknown path |
| Resource exhaustion by combos | name length, 50 combos, 20 entries each |

Deliberately not done: OAuth subscription providers, web-session providers, cloud sync, external compression proxy, any non-administrator access.

## D10. Console UI

- **Decision**: top-level route split in the client; own shell and strings; no shared locale keys.
- **Rationale**: a separate interface inside the same sign-in (owner's decision); the shared locale check requires every key in every one of the 60 locales, so the console keeps its own string table. Main navigation shows a link only to permitted users.

## D11. Models list

- **Decision**: `GET /x/v1/models` returns the combos (as `combo:<name>`) followed by the same catalogue listing the main flow builds, for the administrator.
- **Rationale**: reuses the existing listing builder; adds no query beyond the main flow's.
