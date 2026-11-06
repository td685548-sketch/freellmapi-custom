# Feature Specification: Admin-only X Gateway (separate API flow and console)

**Feature Branch**: `007-admin-x-gateway`
**Created**: 2026-11-06
**Status**: Draft
**Input**: Admin-only "X gateway" (phase 1 of porting 9router-style features): a new OpenAI-compatible chat flow at its own address, reachable only by the administrator, with named model combos, output-token savers (caveman, ponytail), an input-token saver for tool outputs, and per-admin usage. Clarified by the owner: it must be **separate from the main logic**, "its own API endpoint flow with its own interface".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Call a separate gateway with my own key (Priority: P1)

As the administrator I can send chat requests to a dedicated gateway address, using my own personal key, and get answers served from the models I chose. Nobody else can use it, and the existing gateway keeps working exactly as before.

**Why this priority**: It is the core of the feature and the smallest slice that delivers value: a private, separate door to the model pool.

**Independent Test**: With the gateway enabled, call it with the administrator's personal key (success), with an ordinary member's key (refused), with a revoked or unknown key (refused) and with no key (refused); then call the existing gateway and confirm it behaves identically to before.

**Acceptance Scenarios**:

1. **Given** the gateway is enabled and I hold a personal key on an account that has the gateway permission, **When** I send a chat request to the gateway, **Then** I receive a normal completion (streaming and non-streaming) and the model list endpoint of the gateway lists what I may use.
2. **Given** an ordinary member key, an unknown key or no key, **When** a request reaches the gateway, **Then** it is refused with an authentication or permission error and nothing is sent to any provider.
3. **Given** the gateway exists, **When** anyone uses the existing gateway, dashboard or health endpoints, **Then** their behaviour and responses are unchanged.
4. **Given** the gateway is switched off (the default), **When** any caller requests it, **Then** it answers as if it does not exist.

---

### User Story 2 - Manage combos and defaults in a separate console (Priority: P2)

As the administrator I have a separate console, with its own entry point and layout distinct from the main dashboard, where I switch the gateway on or off, create combos, set default saver modes, see how to call the gateway, try it, and see its usage.

**Why this priority**: Without a place to define combos and defaults the gateway is only usable with fixed behaviour; the console makes it self-service. It is separate from the main dashboard on purpose, so the main dashboard and its settings are untouched.

**Independent Test**: Sign in as the administrator, open the console, enable the gateway, create a combo, send a test message from the console, and see the request in its usage view. Sign in as a non-administrator and confirm the console is neither visible nor reachable.

**Acceptance Scenarios**:

1. **Given** I am the administrator, **When** I open the console, **Then** I see the gateway state, the address and a ready-to-copy usage example (never my key), my combos, my default savers and a usage summary.
2. **Given** I am a member without the permission, **When** I look for the console or request its data, **Then** it does not appear in my navigation and its data is refused.
3. **Given** I create, rename, reorder or delete a combo in the console, **When** I save, **Then** the main dashboard's profiles, chains and routing settings are unchanged.
4. **Given** I use the console's test box, **When** I send a message, **Then** I see the answer, which model served it, whether any saver was applied and how many input tokens the input saver removed.

---

### User Story 3 - Use a combo as a model (Priority: P3)

As the administrator I can name a model as a combo and the gateway tries the combo's models in my order, moving to the next when one fails or is unavailable.

**Why this priority**: Combos are the main reason to want a separate gateway (a stable name for a preferred fallback order), but a single-model call (P1) already works without them.

**Independent Test**: Create a combo whose first model is unavailable; request it; confirm the answer comes from the second entry and the first failure is not shown to the caller as a failure.

**Acceptance Scenarios**:

1. **Given** a combo of three models, **When** I request it and the first model errors, **Then** the next one in the combo serves the request.
2. **Given** all combo entries are unavailable, **When** I request it, **Then** I get one clear error stating the combo is exhausted.
3. **Given** I request a combo that does not exist, **When** the request is sent, **Then** I get a clear "unknown combo" error and no provider is called.

---

### User Story 4 - Cut tokens per request, on request (Priority: P3)

As the administrator I can ask, per request, for terse replies (caveman), for minimal code-first replies (ponytail, in lite, full or ultra), and for compression of bulky tool output in the conversation, and I can turn all of it off for one request.

**Why this priority**: Saves tokens on free quotas, which is the practical payoff, but is useful only once calls (P1) work.

**Independent Test**: Send the same conversation with and without each mode; confirm the instruction is added only when asked, user content is byte-identical, a tool-output-heavy conversation arrives shorter, and the off switch removes every effect.

**Acceptance Scenarios**:

1. **Given** I ask for caveman, ponytail, or both, **When** the request is built, **Then** a single instruction block is placed ahead of the conversation and no user, assistant or tool message is changed.
2. **Given** the input saver is requested and the conversation contains bulky tool output, **When** the request is built, **Then** that output is shortened and the response reports how many input tokens were saved.
3. **Given** a saver fails or would make the content longer, **When** the request is built, **Then** the original content is sent unchanged and the request still succeeds.
4. **Given** I send the off switch with a request, **When** the request is built, **Then** no saver is applied, whatever my defaults are.
5. **Given** I name a saver mode that does not exist, **When** the request is sent, **Then** it is rejected with a message listing valid modes, rather than silently ignored.

---

### User Story 5 - See usage (Priority: P3)

As the administrator I can see how much I have used through the gateway: requests, tokens and savings, kept apart from the main gateway's figures.

**Independent Test**: Make several gateway calls and confirm the console's counts match; confirm the main dashboard's own analytics do not change meaning.

**Acceptance Scenarios**:

1. **Given** I made calls through the gateway, **When** I open the usage view, **Then** requests, tokens and tokens saved match those calls.
2. **Given** my personal key has a per-minute limit, **When** I exceed it through the gateway, **Then** I am limited the same way as on the main gateway.

---

### Edge Cases

- The administrator account is demoted or its permission removed while a key is in use: the next gateway call is refused.
- The administrator's personal key is revoked: refused on the next call.
- Gateway toggled off in the middle of streaming responses: in-flight responses finish; new ones are refused.
- A combo references a model or key that is later disabled or deleted: that entry is skipped and the console marks it as unavailable.
- Two savers requested together: one instruction block, deterministic order, no duplicated text.
- Conversation already contains a system message: the saver instruction is added without removing or editing it.
- Very large request bodies from callers without a valid key: refused before they are read, as on the rest of the application.
- Combo name collisions with real model names: combo names must be unambiguous and are rejected otherwise.
- A saver would push the request over a model's context limit: the request is sent without that saver rather than failing.

## Requirements *(mandatory)*

### Functional Requirements

**Separation and isolation**

- **FR-001**: The gateway MUST live at its own address space, distinct from the existing gateway, and MUST NOT change the behaviour, responses, routing settings, profiles or chains of any existing endpoint.
- **FR-002**: The gateway's own configuration (on/off state, combos, saver defaults) MUST be stored separately from the main application's settings, so that removing or disabling it cannot affect the main application.
- **FR-003**: The gateway MUST be off by default and MUST have an administrator-controlled switch. While off, its addresses MUST answer as nonexistent and its console MUST show a disabled state.
- **FR-004**: The gateway MUST read the existing provider keys and model catalogue but MUST NOT modify them.

**Access control**

- **FR-005**: Only the primary administrator, or an account explicitly granted a dedicated gateway permission, MUST be able to use the gateway or its console. Every other caller MUST be refused: unauthenticated or invalid credentials with an authentication error, valid credentials without the permission with a permission error.
- **FR-006**: The gateway MUST authenticate with the administrator's own personal key and MUST re-check the account's current permission on every request, so that demotion or key revocation takes effect immediately.
- **FR-007**: The gateway permission MUST be part of the existing granular permission system, so it can be granted or withheld like other permissions, and a delegated holder MUST NOT be able to grant it unless they hold it.
- **FR-008**: The console and its data MUST be invisible and refused to anyone without the permission.

**Chat flow**

- **FR-009**: The gateway MUST provide an OpenAI-compatible chat completion operation (streaming and non-streaming) and a list of available models.
- **FR-010**: Requests MUST pass the same body-size protection, rate limits and log redaction as the rest of the application, and MUST honour the account's per-minute limit.

**Combos**

- **FR-011**: The administrator MUST be able to create, rename, reorder, edit and delete named combos, each an ordered list of models.
- **FR-012**: A request naming a combo MUST try its entries in order, moving on when one fails or is unavailable, and MUST return one clear error when all are exhausted or when the combo is unknown.
- **FR-013**: Combos MUST be independent of the main application's profiles and chains.
- **FR-014**: Combo names MUST be validated (length, characters, uniqueness, no clash with real model names) and a combo MUST have a bounded number of entries.

**Token savers**

- **FR-015**: The gateway MUST support two output savers, caveman (terse technical replies) and ponytail (minimal code-first replies in lite, full and ultra levels), selectable per request and as an administrator default, and combinable.
- **FR-016**: Savers MUST only add one instruction block ahead of the conversation and MUST NOT alter, drop or reorder any user, assistant, tool or existing system message.
- **FR-017**: The gateway MUST support an input saver that shortens bulky tool output in the conversation, selectable per request and as a default, MUST fall back to the original content on any failure or when the result would not be shorter, and MUST report the input tokens saved.
- **FR-018**: A single per-request off switch MUST disable every saver for that request, overriding defaults.
- **FR-019**: Unknown saver modes MUST be rejected with an explanatory message.
- **FR-020**: Any bulky-output filter added for the gateway MUST apply only to gateway requests unless the administrator later chooses otherwise.

**Console**

- **FR-021**: The console MUST be a separate area with its own entry point and layout, not a tab inside the main dashboard, and MUST offer: gateway on/off, address and usage example (never the key), combo management, saver defaults, a test box, and a usage view.

**Usage**

- **FR-022**: Each gateway request MUST be attributed to the administrator's account and counted separately from the main gateway in the console, including tokens saved by the input saver.

**Performance and safety**

- **FR-023**: A gateway request MUST NOT cost more storage round trips than an equivalent main-gateway request, and its checks MUST be covered by the existing round-trip budget tests.
- **FR-024**: The feature MUST ship with documented security considerations: the new access path, key and permission handling, request size and rate limits, and what the gateway deliberately does not do.

### Key Entities *(include if feature involves data)*

- **Gateway state**: whether the gateway is on, and the default saver selection.
- **Combo**: a unique name and an ordered list of model entries (provider and model), with who created it and when.
- **Gateway usage record**: one per request: account, combo or model used, tokens in and out, input tokens saved, which savers were applied, outcome.
- **Gateway permission**: a grant on an account that allows use of the gateway and console.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of requests to the gateway from anonymous callers, ordinary members, revoked keys and accounts that lost the permission are refused, and none reach a provider.
- **SC-002**: The complete existing automated test suite passes unchanged, and every existing endpoint returns the same responses as before the feature.
- **SC-003**: The administrator can enable the gateway, create a combo and complete a first successful call using only the console and one personal key in under 5 minutes.
- **SC-004**: With the gateway off, 100% of requests to its addresses answer as nonexistent within one minute of switching it off.
- **SC-005**: Enabling both output savers adds no more than 300 tokens of instruction to a request, and user content is unchanged in 100% of tested requests.
- **SC-006**: On a representative conversation dominated by tool output, the input saver reduces input tokens by at least 20% while the model's answer remains usable, and on 100% of injected failures the original content is sent.
- **SC-007**: A gateway request issues no more storage round trips than an equivalent main-gateway request, measured by the existing budget tests.
- **SC-008**: A request body of 10 MB from an unauthenticated caller stalls the server for no longer than the same request against the main gateway after the pre-parse guard (under 150 ms in the local measurement).

## Assumptions

- The gateway lives under `/x/v1/` and the console under `/x`, both on the same deployment and the same sign-in as the main application. "Separate interface" is interpreted as a distinct page area with its own navigation and layout, not a separate deployment or application.
- The gateway uses the administrator's existing personal key (the same `sk-flm-` keys the main gateway issues), restricted by the new permission; no separate key type is introduced in phase 1.
- The fixed saver set in phase 1 is caveman, ponytail (lite/full/ultra) and the input saver; adding custom prompts is out of scope.
- Streaming behaves as on the main gateway.
- Phase 1 covers chat completions and the model list only; embeddings, images, audio, search and the other wire formats are out of scope.
- The existing compression filters are reused where they already cover a tool output; only genuinely missing filters are added, and only for gateway requests.
- Out of scope: OAuth subscription providers, web-session providers, cloud sync, the external Headroom proxy, and any access for non-administrators.
- Requires the existing personal-key, permission, rate-limit and pre-parse protections to stay in place.
