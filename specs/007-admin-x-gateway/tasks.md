---

description: "Task list for the admin-only X gateway (separate API flow and console)"
---

# Tasks: Admin-only X Gateway (separate API flow and console)

**Input**: Design documents from `/specs/007-admin-x-gateway/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: INCLUDED. The repository constitution (principle IV) requires tests for every new feature, migration round trips for schema changes, and the round-trip budget tests for anything on the request path.

**Organization**: grouped by user story. Phase 1-2 are shared; each user story phase is independently testable after Phase 2.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an unfinished task)
- **[Story]**: US1-US5 from `spec.md`
- All paths are relative to the repository root.

## Path Conventions

Server: `server/src/` (new code under `custom/x-gateway/`). Client: `client/src/custom/x-gateway/`. Shared: `shared/`. Tests: `server/src/__tests__/custom/x-gateway-*.test.ts` and `client/src/custom/x-gateway/*.test.tsx`.

---

## Phase 1: Setup

- [x] T001 Create the empty module directories `server/src/custom/x-gateway/` and `client/src/custom/x-gateway/pages/` with a one-line `README.md` in `server/src/custom/x-gateway/` pointing to `specs/007-admin-x-gateway/plan.md`
- [x] T002 [P] Add the operator guide skeleton `docs/x-gateway.md` with the sections: what it is, enabling it, calling it, savers, combos, security considerations (copy the threat table from `specs/007-admin-x-gateway/research.md` D9), and what it deliberately does not do

---

## Phase 2: Foundational (blocks every user story)

**Purpose**: permission group, storage, request context, configuration cache, and the protections that must cover the new address space before any endpoint exists.

- [x] T003 Add the permission group `manage_x_gateway` to `PERMISSION_GROUPS` in `shared/permissions.ts` with leaves `use_x_gateway` ("Use the X gateway and open its console"), `edit_x_combos` ("Create, edit, reorder and delete combos"), `edit_x_settings` ("Switch the gateway on or off and change default savers"), `view_x_usage` ("Read the X gateway usage view"); keep the file's existing formatting and ordering style
- [x] T004 [P] Extend `server/src/custom/permission-actions.ts` `permissionForAction`: map `/api/thruline/enabled` and `/api/thruline/defaults` writes to `edit_x_settings`, combo writes to `edit_x_combos`, `/api/thruline/models` to `edit_x_combos`, `/api/thruline/usage` to `view_x_usage`, and every other read or `test` to `use_x_gateway`; anything unlisted must fall through to the parent `manage_x_gateway`
- [x] T005 [P] Add `{ path: '/api/thruline', permission: 'manage_x_gateway' }` to `PERMISSION_GATES` in `server/src/custom/register.ts` and update the frozen copy in `server/src/__tests__/custom/surface.test.ts`
- [x] T006 Write the migration `server/src/db/migrations/20261106_000001_custom_x_gateway.ts` (idempotent `up`, reversible `down`) creating `x_gateway_config` (`key` text primary key, `value` text not null, `updated_at` text, `updated_by` integer nullable), `x_gateway_combos` (`id` integer primary key, `name` text unique not null, `entries_json` text not null, `created_by` integer nullable, `created_at`, `updated_at` text) and `x_gateway_usage_hourly` (`hour` text, `user_id` integer, `requests` integer, `input_tokens_saved` integer, `output_savers_applied` integer, primary key (`hour`, `user_id`)); do not edit any existing migration
- [x] T007 Register the migration in `server/src/db/migrate/defaults.ts` (import, filename constant `CUSTOM_X_GATEWAY_FILENAME`, entry in `DEFAULT_MIGRATIONS`) and add the filename to the expected list in `server/src/__tests__/db/migrate/roundtrip.test.ts`
- [x] T008 [P] Create `server/src/custom/x-gateway/context.ts`: an `AsyncLocalStorage` scope `{ gateway: 'x', combo?: string, outputSavers: string[], inputSaver: string, inputTokensSaved: number }` with `runInGatewayScope`, `getGatewayScope`
- [x] T009 Add the log tag hook in `server/src/lib/request-log.ts`: when a gateway scope is active, write `caller = 'x-gateway'` (about two lines, the existing `caller` parameter wins when given); add a unit test in `server/src/__tests__/lib/request-log-counters.test.ts` style covering tagged and untagged rows
- [x] T010 Extend the personal-key lookup in `server/src/services/user-keys.ts` (`lookupUserApiKey` and `ValidatedUserKey`) to also return `isPrimary` and the account's `permissions` from the SAME query (no extra statement); update `server/src/__tests__/services/user-keys-and-invites.test.ts` for the new fields
- [x] T011 Create `server/src/custom/x-gateway/config.ts`: read and write `x_gateway_config` and `x_gateway_combos`; in-memory snapshot `{ enabled, savers, combos }`, invalidated on every write, refreshed at most every 5 s; `enabled` is off when the row is absent; `default_savers` parsed with a strict schema (`caveman` boolean, `ponytail` one of `off|lite|full|ultra`, `input` one of `off|lossless|standard`), unreadable value falls back to all off
- [x] T012 [P] Create `server/src/custom/x-gateway/combos.ts`: validation `name` stored lower-case, 1-48 characters of `a-z 0-9 - _ .`, must not equal an existing model id or `auto` and must not start with `auto:` or `combo:`; at most 50 combos; `entries` 1-20 items of `{ platform, modelId }` with no duplicates; export `validateCombo`
- [x] T013 Protect the new address space: (a) in `server/src/custom/preparse-guard.ts` `classify`, treat `/thruline/v1` as a credentialed path; (b) in `server/src/app.ts` add `'/thruline/v1'` to the large-body JSON limit mount list and to the proxy rate-limiter mounts (one token each)
- [x] T014 Mount the existing personal-key gate for the new address space: change `app.use(['/v1', '/v1beta'], userInferenceGate)` in `server/src/custom/register.ts` to include `'/thruline/v1'`
- [x] T015 [P] Foundational tests in `server/src/__tests__/custom/x-gateway-foundation.test.ts`: migration creates and drops the three tables idempotently; config snapshot defaults to off, reflects a write immediately and falls back on a corrupt value; combo validation accepts and rejects each rule in T012; permission group appears in `PERMISSION_GROUPS` and unlisted `/api/thruline/*` paths require the parent permission
- [x] T016 [P] Extend `server/src/__tests__/custom/preparse-guard.test.ts`: a 600 KB anonymous POST to `/thruline/v1/chat/completions` is refused 401 by the guard, and the same body with a valid personal key is not refused by the guard

**Checkpoint**: storage, permissions, protections and request scope exist; nothing is reachable yet.

---

## Phase 3: User Story 1 - Call a separate gateway with my own key (Priority: P1) MVP

**Goal**: the administrator can call `/thruline/v1/chat/completions` and `/thruline/v1/models` with their personal key; everyone else is refused; the main gateway is unchanged; the gateway is off by default.

**Independent Test**: enable the gateway through the config store, call with the administrator's key (200), a member's key (403), a revoked or unknown key (401), no key (401), switch it off (404); run the existing suite unchanged.

### Tests for User Story 1

- [x] T017 [P] [US1] Access-control tests in `server/src/__tests__/custom/x-gateway-access.test.ts`: anonymous 401, unknown key 401, revoked key 401, member 403, account demoted after a first success 403 on the next call, primary administrator 200, delegated holder of `use_x_gateway` 200, gateway off 404 with the same body as an unknown path, unmatched `/thruline/v1/anything` JSON 404 (never HTML), and the contract status table in `contracts/x-gateway-api.md`
- [x] T018 [P] [US1] Isolation test in `server/src/__tests__/custom/x-gateway-isolation.test.ts`: `/v1/chat/completions`, `/v1/models`, `/livez`, `/readyz`, `/api/ping` return identical responses with the gateway on and off; a `/v1` client sending `model: "combo:x"` gets the ordinary unknown-model behaviour
- [x] T019 [P] [US1] Round-trip budget test in `server/src/__tests__/custom/x-gateway-budget.test.ts` using the harness pattern of `chat-steady-budget.test.ts`: consecutive successful `/thruline/v1` chat requests issue no more statements than the same request on `/v1` (SC-007)

### Implementation for User Story 1

- [x] T020 [US1] Create `server/src/custom/x-gateway/auth.ts`: middleware that (in order) answers JSON 404 when the config snapshot is off, takes the already-validated personal key from the existing key memo, returns 401 `authentication_error` when absent, and returns 403 `permission_error` unless the key's account holds `use_x_gateway` (use `permissionGranted` with the fields from T010); never cache the permission
- [x] T021 [US1] Create `server/src/custom/x-gateway/router.ts` with `POST /chat/completions`: after `auth.ts`, parse the headers (stub returning "no savers" for now), run `runInGatewayScope`, rewrite the internal path to the existing chat handler and dispatch into `proxyRouter` from `server/src/routes/proxy.ts`; set response headers `X-Gateway: x`, `X-Combo`, `X-Output-Saver-Applied`, `X-Input-Tokens-Saved` per `contracts/x-gateway-api.md`
- [x] T022 [US1] In the same router add `GET /models` returning the main flow's listing (`buildModelListing` in `server/src/services/model-listing.ts`) for the administrator, and a final catch-all returning JSON 404 for any other path or method under `/thruline/v1`
- [x] T023 [US1] Mount the router in `registerCustomRoutes` in `server/src/custom/register.ts` as `app.use('/thruline/v1', xGatewayRouter)` after the personal-key gate and before the upstream mounts
- [x] T024 [US1] Run `npm run lint -w server`, `npm run build -w server`, `npm run test -w server`; fix any regression (existing suites must pass unchanged, SC-002)

**Checkpoint**: User Story 1 works and is testable on its own (MVP). Everything else builds on it.

---

## Phase 4: User Story 2 - Console in a separate area (Priority: P2)

**Goal**: a separate console at `/thruline` with its own layout: gateway on/off, address and usage example, default savers, test box. Invisible and refused to anyone without the permission.

**Independent Test**: sign in as the administrator, open `/thruline`, enable the gateway, send a message from the test box; sign in as a member and confirm the console is neither listed nor reachable.

### Tests for User Story 2

- [ ] T025 [P] [US2] Console API tests in `server/src/__tests__/custom/x-gateway-console.test.ts`: status/enabled/defaults/test per `contracts/console-api.md`, including 403 without `edit_x_settings` for writes, 409 `gateway_disabled` for `test` while off, no response ever contains a personal key, provider key or session token, and a defaults write invalidates the snapshot immediately
- [ ] T026 [P] [US2] Client tests in `client/src/custom/x-gateway/XGatewayApp.test.tsx`: the console renders its own shell for any path under `/thruline`, shows the disabled state when off, hides write controls without `edit_x_settings`, shows a placeholder (never a real key) in the usage example; the main navigation shows the link only to a user holding `use_x_gateway`

### Implementation for User Story 2

- [ ] T027 [US2] Create `server/src/custom/x-gateway/console-router.ts` with `GET /status`, `PUT /enabled`, `GET /defaults`, `PUT /defaults` (strict body schema from T011) and `POST /test` (builds the same edge pipeline as `/thruline/v1` for the signed-in administrator and returns `{ answer, servedBy, saversApplied, inputTokensSaved }`; accepts no key)
- [ ] T028 [US2] Mount it in `server/src/custom/register.ts` as `app.use('/api/thruline', requireAuth, requireActionPermission('manage_x_gateway'), xGatewayConsoleRouter)` (the permission gate from T005 supplies the per-path leaf check)
- [ ] T029 [P] [US2] Create the client data layer `client/src/custom/x-gateway/api.ts` (typed calls to `/api/thruline/*` through `apiFetch` in `client/src/lib/api.ts`) and the console's own strings `client/src/custom/x-gateway/strings.ts` (Vietnamese and English; do NOT add keys to the shared locale files)
- [ ] T030 [P] [US2] Create the shell `client/src/custom/x-gateway/XGatewayApp.tsx` with its own header and navigation (Overview, Combos, Test, Usage) and a back link to the main dashboard; redirect to the not-found page when the session lacks `use_x_gateway`
- [ ] T031 [P] [US2] Create `client/src/custom/x-gateway/pages/Overview.tsx`: gateway switch, base address, a copyable usage example with a placeholder key, default savers form (caveman toggle, ponytail level, input saver level)
- [ ] T032 [P] [US2] Create `client/src/custom/x-gateway/pages/Test.tsx`: message box that calls `POST /api/thruline/test` and shows the answer, the serving model, savers applied and input tokens saved
- [ ] T033 [US2] Split the top-level routes in `client/src/App.tsx` so any path under `/thruline/*` renders `XGatewayApp` inside the existing sign-in gate but without the main navbar (about six lines); add the permission-gated link in the main navigation using `useUserSession().can('use_x_gateway')`
- [ ] T034 [US2] Run `npm run lint`, `npm run build`, `npm run test -w client` and confirm the shared locale parity test still passes

**Checkpoint**: Stories 1 and 2 both work; the administrator can operate the gateway from the console.

---

## Phase 5: User Story 3 - Use a combo as a model (Priority: P3)

**Goal**: combos stored separately, managed in the console, usable as `combo:<name>` with ordered fallback.

**Independent Test**: create a combo whose first model is unavailable, request it, and confirm the second entry serves; unknown combo and exhausted combo return the documented errors.

### Tests for User Story 3

- [ ] T035 [P] [US3] Combo tests in `server/src/__tests__/custom/x-gateway-combos.test.ts`: create/rename/reorder/delete through the console API (409 duplicate name, 400 invalid name or more than 20 entries or more than 50 combos), `combo:<name>` serves from the first available entry, skips a disabled or deleted model and uses the next, returns 400 `combo_not_found` without calling any provider for an unknown name, returns 503 `combo_exhausted` when nothing is available, and the combo list in `GET /thruline/v1/models` includes `combo:<name>`
- [ ] T036 [P] [US3] Isolation test in the same file: creating, editing or deleting combos changes no row in `profiles`, `profile_models`, `fallback_config` or `settings`, and a `/v1` request naming `combo:<name>` is not routed to it
- [ ] T037 [P] [US3] Client test `client/src/custom/x-gateway/pages/Combos.test.tsx`: create, reorder (the order is the fallback order), delete, and unavailable-entry marking

### Implementation for User Story 3

- [ ] T038 [US3] Add the optional resolver hook at the top of `resolveRoutingChain` in `server/src/services/router.ts` (about five lines): when a registered resolver exists and answers for the model string, return its result; export `setRoutingChainResolver`
- [ ] T039 [US3] In `server/src/custom/x-gateway/combos.ts` implement the resolver: answers only when `getGatewayScope()?.combo` is set; builds the ordered `ChainRow[]` from the combo's `(platform, modelId)` entries against the live catalogue (skipping disabled or missing rows), returns the strict-order strategy override, throws 400 `combo_not_found` / 503 `combo_exhausted`; register it from `server/src/custom/register.ts`
- [ ] T040 [US3] In `server/src/custom/x-gateway/router.ts` detect `model: "combo:<name>"`, validate the name format, set it on the scope and rewrite the delegated model to a neutral automatic value so the resolver supplies the chain
- [ ] T041 [US3] Add `GET/POST /combos`, `PUT/DELETE /combos/:id` and `GET /models` (catalogue picker) to `server/src/custom/x-gateway/console-router.ts`; invalidate the config snapshot on every write; entries are never validated against provider keys at save time
- [ ] T042 [P] [US3] Create `client/src/custom/x-gateway/pages/Combos.tsx` (list, editor with ordered entries, availability badges) and add the Combos route to `XGatewayApp.tsx`
- [ ] T043 [US3] Extend `GET /thruline/v1/models` in `server/src/custom/x-gateway/router.ts` to prepend each combo as `{ id: "combo:<name>", object: "model", owned_by: "x-gateway" }`

**Checkpoint**: combos work end to end and leave the main routing configuration untouched.

---

## Phase 6: User Story 4 - Cut tokens per request, on request (Priority: P3)

**Goal**: caveman, ponytail (lite/full/ultra) and the input saver, per request or by default, with an off switch.

**Independent Test**: send the same conversation with and without each mode; instruction added only when asked, user content byte-identical, tool-output-heavy conversation shorter, off switch removes everything.

### Tests for User Story 4

- [ ] T044 [P] [US4] Saver unit tests in `server/src/__tests__/custom/x-gateway-savers.test.ts`: header parsing (`X-Token-Saver: off`, `X-Output-Saver` list with `ponytail:lite|full|ultra`, `X-Input-Saver`), unknown values rejected 400 with the valid values listed, one system message placed first, existing system messages and every user/assistant/tool message byte-identical, both output savers stack in a fixed order without duplicated text, the added instruction is at most 300 tokens, saver skipped when it would exceed the model's context
- [ ] T045 [P] [US4] Input-saver tests in the same file: a tool-output-heavy fixture conversation shrinks by at least 20% (SC-006), a forced compression failure sends the original content and the request succeeds, a result that is not shorter is discarded, `X-Input-Tokens-Saved` reports the figure, and the delegated request carries the compression-off directive so the main flow does not compress again
- [ ] T046 [P] [US4] Default-saver tests in the same file: defaults from the console apply when no header is sent, a header overrides them, and the off switch overrides both

### Implementation for User Story 4

- [ ] T047 [US4] Create `server/src/custom/x-gateway/savers.ts`: fixed instruction blocks for caveman and ponytail (lite/full/ultra) as constants, `parseSaverHeaders`, `applyOutputSavers(messages, savers)` using `prependSystemPrompt` from `server/src/lib/system-prompt.ts`, and `applyInputSaver(messages, mode, tools)` calling `compressRequest` from `server/src/services/compression/pipeline.ts` with an explicit `previewMode` and `recordStats: false`, fail-open on any error, keeping the original when the result is not shorter, and estimating tokens with `estimateTokensFromChars`
- [ ] T048 [US4] Wire the savers into `server/src/custom/x-gateway/router.ts` and into the console `POST /test`: resolve effective settings (header over default, off switch over everything), apply to `req.body.messages`, set `X-FreeLLM-Compress: off` on the delegated request, record applied savers and tokens saved on the scope, and emit the response headers
- [ ] T049 [US4] Only if T045's 20% target fails on the fixture: add the missing tool-output filter definition(s) used by the gateway only (a separate list passed to the compression call), with a test per filter; otherwise skip and note the measured figure in `docs/x-gateway.md`

**Checkpoint**: savers work and are provably safe (content untouched, fail-open, bypassable).

---

## Phase 7: User Story 5 - See usage (Priority: P3)

**Goal**: usage view for the gateway, separate from the main gateway's figures.

**Independent Test**: make several gateway calls and match the view's counts; exceed the per-minute limit and confirm the same limiting as the main gateway.

### Tests for User Story 5

- [ ] T050 [P] [US5] Usage tests in `server/src/__tests__/custom/x-gateway-usage.test.ts`: gateway requests are tagged `x-gateway` and main-gateway requests are not; the usage endpoint's requests and tokens equal the calls made; tokens saved are flushed to `x_gateway_usage_hourly` by the 60 s flush (injectable clock), flushed on shutdown, and a flush issues one write regardless of request count; per-minute limit from the personal-key gate applies (429)
- [ ] T051 [P] [US5] Client test `client/src/custom/x-gateway/pages/Usage.test.tsx`: renders ranges 24h/7d/30d, hides the page without `view_x_usage`

### Implementation for User Story 5

- [ ] T052 [US5] Create `server/src/custom/x-gateway/usage.ts`: in-memory accumulator keyed by hour and user, `noteRequest(scope)`, an unref'd 60 s flush upserting into `x_gateway_usage_hourly` (one statement per flush via `runWriteGroup` from `server/src/lib/write-group.ts`), a flush on graceful shutdown, and a bounded delete of rows older than 90 days at flush time; call `noteRequest` from the router when a response finishes
- [ ] T053 [US5] Add `GET /usage?range=24h|7d|30d` to `server/src/custom/x-gateway/console-router.ts`: request counts, tokens and breakdown by combo and model from `requests WHERE caller = 'x-gateway'`, saved tokens from `x_gateway_usage_hourly`; read-only
- [ ] T054 [P] [US5] Create `client/src/custom/x-gateway/pages/Usage.tsx` and add the route to `XGatewayApp.tsx`

**Checkpoint**: all five stories work independently.

---

## Phase 8: Polish and cross-cutting

- [ ] T055 [P] Finish `docs/x-gateway.md`: enabling, calling, headers, combos, savers, the measured savings figure, the security considerations table, the list of upstream touch points from `specs/007-admin-x-gateway/plan.md`, and the rollback (switch off, or remove the permission)
- [ ] T056 [P] Add a security regression suite `server/src/__tests__/custom/x-gateway-security.test.ts`: delegation rule (a holder of `edit_user_permissions` without `manage_x_gateway` cannot grant it), the guard and body limits on `/thruline/v1`, console API never returns secrets, `/thruline/v1` while off leaks nothing about the feature, combo and saver inputs with quotes, newlines and control characters are stored and echoed safely
- [ ] T057 Run the full verification: `npm run lint`, `npm run build`, `npm run test` (server, cli, client, bootstrap, hooks), the migration round trip (`npm run test:migrations`), and the plain-Node import check of the compiled server; all existing suites must pass unchanged
- [ ] T058 Walk through every scenario in `specs/007-admin-x-gateway/quickstart.md` against a local server and record the results (including the measured input-saver reduction and the round-trip comparison) in `docs/x-gateway.md`
- [ ] T059 Re-run the pre-parse measurement for `/thruline/v1` (10 MB anonymous body) and confirm the stall stays under 150 ms (SC-008)

---

## Dependencies and Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: none.
- **Phase 2 (Foundational)**: after Phase 1; blocks every story. Within it, T003 before T004/T005/T015; T006 before T007/T015; T008 before T009; T010 before T020; T011 before T012/T015/T020; T013 and T014 before T016/T017.
- **US1 (P1)**: after Phase 2. MVP.
- **US2 (P2)**: after US1 (the test box and status use the edge pipeline).
- **US3 (P3)**: after US1; its console and client tasks also need US2's shell (T030) and console router (T027).
- **US4 (P3)**: after US1 (needs the router); independent of US3. T048 also touches the console `test` endpoint from US2.
- **US5 (P3)**: after US1; independent of US3 and US4 except that saved-token figures need US4 to produce anything.
- **Polish**: after the stories it documents or tests.

### Within a story

Tests first (they must fail), then implementation, then the story's checkpoint run. Tasks that touch the same file (for example several edits to `router.ts` or `console-router.ts`) are not parallel with each other.

### Parallel opportunities

- Phase 2: T004, T005, T008, T012, T015, T016 can run alongside once T003, T006 and T011 exist.
- US1 tests T017, T018, T019 in parallel; US2 tests T025, T026 and client files T029-T032 in parallel; US3 tests T035-T037 in parallel; US4 tests T044-T046 in parallel (one file, split by describe blocks); US5 tests T050, T051 in parallel.
- After US1, US3 server work, US4 and US5 can proceed in parallel by different developers because they touch different modules (`combos.ts`, `savers.ts`, `usage.ts`).

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 and Phase 2.
2. Phase 3 (US1). **Stop and validate**: the administrator can call `/thruline/v1/chat/completions` with their key, others are refused, the main gateway is unchanged, the gateway is off by default. This alone can be deployed behind the switch.

### Incremental delivery

1. MVP (US1) → merge behind the off switch.
2. US2 console → the administrator can operate it without touching the database.
3. US4 savers → the main token-saving value; US3 combos and US5 usage in either order.
4. Polish and the security suite before announcing it to anyone, and before any external security testing of the site.

### Notes

- Keep every upstream edit to the listed touch points (T009, T013, T033, T038 and the registry lines); do not reformat surrounding code.
- Run the round-trip budget test after every task that touches the request path (T014, T020-T023, T040, T048).
- Commit after each task or small group; open one pull request per phase boundary.
