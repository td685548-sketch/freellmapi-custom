# Feature Specification: X Gateway Basic Chat

**Feature Branch**: `feat/9router-integration`
**Created**: 2026-11-07
**Status**: Ready
**Input**: Bring 9Router Basic Chat / Playground into this web application.

## User Scenarios & Testing

### User Story 1 - Chat with connected models (Priority: P1)
An authorized user chooses auto, a connected provider model or combo and sees replies appear progressively.
**Why this priority**: Makes connected accounts usable directly on the web.
**Independent Test**: Complete two turns through a connected model without entering an API key.
**Acceptance Scenarios**:
1. Given a connected account, when sending, then the selected model receives the conversation and streams its answer.
2. Given a running answer, when pressing Stop, then generation ends and another message can be sent.
3. Given a disabled gateway or no accounts, when sending, then a clear credential-safe error appears.

### User Story 2 - Manage conversations (Priority: P2)
Users create, reopen and delete browser-local chats, view formatted answers and copy them.
**Why this priority**: Supports practical multi-turn use like 9Router Basic Chat.
**Independent Test**: Create two chats, reload, reopen and delete one.
**Acceptance Scenarios**:
1. Given saved chats, when reloading, then the same user can reopen them.
2. Given an account change, when opening Playground, then another account's history is never displayed.

### User Story 3 - Configure chat and attach images (Priority: P2)
Users set system instructions, temperature and response limit, and attach images for compatible models.
**Why this priority**: Enables model evaluation and vision use cases.
**Independent Test**: Send configured chat with an image to a compatible model.
**Acceptance Scenarios**:
1. Given an attached image, when sending, then it accompanies the prompt.
2. Given oversized or unsupported files, when attaching, then validation explains the problem.

### Edge Cases
Empty prompts, unavailable storage, corrupt history, stream errors, double submits, navigating during generation, revoked permissions and no connected models.

## Requirements
### Functional Requirements
- **FR-001**: Expose Playground in X Gateway navigation using existing gateway permissions.
- **FR-002**: Offer auto routing, connected provider models and named combos without entering credentials.
- **FR-003**: Stream replies, allow Stop, retain multi-turn context, and safely format Markdown and code.
- **FR-004**: Create, select, delete and retain up to 20 conversations per signed-in identity on this browser.
- **FR-005**: Accept a system instruction, temperature, token limit and up to four PNG/JPEG/WebP/GIF images of at most 1 MB each.
- **FR-006**: Show credential-safe errors; exclude empty failed or stopped replies from context.
- **FR-007**: Support English, Vietnamese and narrow screens.
- **FR-008**: Preserve existing inference endpoints, routing limits, proxies, accounting and savers.
### Key Entities
- Conversation: identity, title, selected model, messages, update time.
- Message: role, text, optional images, routing and usage metadata.

## Success Criteria
### Measurable Outcomes
- **SC-001**: Complete two chat turns without copying an API key.
- **SC-002**: Two chats survive reload and can be independently deleted.
- **SC-003**: Unauthorized, disabled-gateway and invalid requests never invoke a provider.
- **SC-004**: Use Playground at 390 px and desktop widths in both languages.

## Assumptions
- Scope is X Gateway; the main Playground remains available.
- Provider support determines vision availability.
- Browser-local history only; images remain in memory to bound stored data.
- Automated integration and UI tests follow the project constitution.
