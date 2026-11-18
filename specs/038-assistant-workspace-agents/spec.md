# Feature Specification: Personal AI Agent Workspace, Streaming Threads, Custom User Agents & Live Artifacts

**Feature Branch**: `feat/038-assistant-workspace-agents`

**Created**: 2026-11-18

**Status**: Approved

**Input**: Spec 038 — Personal AI Agent Workspace, Streaming Threads, Custom User Agents & Live Artifacts

## User Scenarios & Testing *(mandatory)*

### User Story 1 - User-Created Custom Assistants & Personal Knowledge Context (Priority: P1)

Signed-in members can author, edit, and delete their own private Custom AI Assistants (`custom_user_assistants`) with a custom `system_prompt`, compact `knowledge_markdown` reference notes (up to 32 KB), category, and `recommended_routing_mode` (`eco`, `balanced`, `max`). Members can chat with their Custom Assistants in the AI Hub or bind a Custom Assistant (`user:<id>` or custom slug) to any of their active Personal API Keys (`sk-flm-...`) so external `/v1` IDE/CLI calls automatically inherit that persona, knowledge context, and routing preset.

**Why this priority**: Transforms the AI Hub from a static admin-curated catalog into a personal multi-agent workspace that works both in the web UI and across external `/v1` coding tools.

**Independent Test**: Create a Custom Assistant as User A, verify User B receives 404/empty visibility, bind `user:<id>` (or slug) to User A's `sk-flm-...` key, invoke `/v1/chat/completions`, and confirm the upstream payload receives the injected `system_prompt`, compact `knowledge_markdown`, and routing preset.

**Acceptance Scenarios**:

1. **Given** an authenticated member, **When** they create a Custom Assistant via `POST /api/user/ai-hub/custom-assistants`, **Then** it is stored scoped to `req.user.userId`, enforces a max of 20 assistants per user and 32 KB UTF-8 limit on `knowledge_markdown`, and appears in their AI Hub workspace.
2. **Given** User A's Custom Assistant bound to User A's personal key `sk-flm-...`, **When** an external client calls `/v1/chat/completions`, `/v1/messages`, or `/v1/responses` with that key, **Then** `customerAiSessionRoutingMiddleware` injects the Custom Assistant's `system_prompt` + compacted `knowledge_markdown` (plus optional personal custom instructions) and applies the assistant's routing mode when key routing mode is `default`.
3. **Given** User B attempting to read, update, delete, chat with, or bind User A's Custom Assistant, **Then** the server rejects the request with `404` without leaking metadata.

---

### User Story 2 - Persistent Chat Threads, Conversation Branching & Live SSE Streaming (Priority: P1)

Members can hold multi-turn persistent conversations in an upgraded wide Agent Workspace drawer (`AssistantChatDrawer.tsx`), switch between saved threads in a left sidebar, rename or delete threads, fork/branch any conversation from an arbitrary turn index (`POST /api/user/ai-hub/threads/:id/branch`), and stream assistant tokens in real time over Server-Sent Events (`POST /api/user/ai-hub/chat/stream`) with automatic graceful fallback to JSON responses.

**Why this priority**: Eliminates ephemeral single-modal chat limitations, enabling real iterative engineering workflows, prompt experimentation via branching, and low-latency token streaming.

**Independent Test**: Create a thread, stream two assistant turns via SSE, fork the thread at message index `1`, verify the branched thread copies messages `0..1` cleanly under `req.user.userId` while leaving the original thread intact, and verify User B cannot access or fork User A's thread.

**Acceptance Scenarios**:

1. **Given** an open assistant in the Agent Workspace, **When** the user sends a prompt, **Then** tokens stream progressively via SSE (`event: delta` / `data: ...`) and persist both user and assistant messages into `custom_assistant_threads` and `custom_assistant_messages`.
2. **Given** an existing thread with 4 messages (`0..3`), **When** the user clicks `[Fork Thread]` at message index `1`, **Then** a new thread is created containing messages `0..1` with `forked_from_thread_id` and `forked_from_message_index` metadata.
3. **Given** an upstream or test environment returning non-streaming JSON or SSE fallback, **When** `/chat/stream` completes, **Then** the workspace still emits coherent SSE events (or JSON when `Accept: application/json` / `stream: false`) without dropping the reply.

---

### User Story 3 - CSP-Safe Live Artifacts Split-Pane Preview (Priority: P2)

When an assistant reply contains fenced code blocks (`html`, `svg`, `mermaid`, `markdown`, `json`, `tsx`/`ts`/`js`), the workspace detects them automatically and offers a `[Preview Artifact]` button that opens a side-by-side `ArtifactPreviewPanel.tsx` with safe rendering, raw source inspection, 1-click Copy, and 1-click file Download — all strictly compliant with Helmet's `script-src 'self'` Content Security Policy.

**Why this priority**: Gives developers and writers an immediate Claude-Artifacts-style visual preview without weakening FreeLLMAPI's strict CSP or introducing XSS vectors.

**Independent Test**: Render assistant replies containing malicious `<script>`, `onerror=`, `<foreignObject>`, and `javascript:` payloads inside `svg`/`html`/`markdown` blocks and verify all executable vectors are stripped before preview while Copy and Download buttons export clean content.

**Acceptance Scenarios**:

1. **Given** an assistant message containing fenced `svg`, `html`, `markdown`, `json`, `mermaid`, or `tsx` blocks, **When** the user clicks `[Preview Artifact]`, **Then** the split pane renders a sanitized visual preview alongside a Raw Code tab, Copy button, and Download button.
2. **Given** untrusted HTML or SVG containing `<script>`, inline `on*` event attributes, `<iframe>`, `<object>`, or `javascript:`/`data:text/html` URLs, **When** rendered in `ArtifactPreviewPanel`, **Then** all dangerous elements/attributes/URIs are stripped and zero inline scripts are executed.

### Edge Cases

- **Per-user caps**: Creating a 21st Custom Assistant returns HTTP `400` (`custom_assistant_limit_reached`). Uploading `knowledge_markdown` exceeding 32,768 UTF-8 bytes returns HTTP `400` (`knowledge_too_large`).
- **Large knowledge context on `/v1` calls**: `knowledge_markdown` is compacted (whitespace-normalized and bounded with a clear `[Assistant Knowledge Context]` section) so personal API key inference remains fast and within model context budgets.
- **Branching boundary indices**: Forking with a negative index or an index beyond the thread's messages returns HTTP `400` (`invalid_branch_point`).
- **Deleted Custom Assistant**: Deleting a Custom Assistant cascades cleanup on `custom_user_key_assistant_bindings` so bound personal keys fall back gracefully to normal routing instead of failing `/v1` requests.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Persist user-authored assistants in `custom_user_assistants` with `user_id` foreign key cascade, unique `(user_id, slug)`, max 20 rows per user, and max 32 KB `knowledge_markdown`.
- **FR-002**: Expose member-scoped CRUD routes under `/api/user/ai-hub/custom-assistants` and key binding support via `PATCH /api/user/ai-hub/keys/:id` accepting `user:<id>` or custom slug references.
- **FR-003**: Enhance `customerAiSessionRoutingMiddleware` so personal API keys (`sk-flm-...`) bound to a Custom Assistant automatically inject its `system_prompt` + compact `knowledge_markdown` and apply its `recommended_routing_mode` (when key mode is `default`) across `/v1` endpoints.
- **FR-004**: Persist multi-turn conversations in `custom_assistant_threads` and `custom_assistant_messages` strictly scoped to `user_id`, supporting list, create, get, rename, delete, and `POST /api/user/ai-hub/threads/:id/branch`.
- **FR-005**: Support real-time SSE token streaming via `POST /api/user/ai-hub/chat/stream` (and thread/assistant sub-routes) with rate-limit, quota enforcement, usage accounting, and graceful JSON fallback.
- **FR-006**: Upgrade `CustomerAiHubPage.tsx` with `CustomAgentModal.tsx` (`[Create My Assistant]`), custom assistant cards (edit/delete/bind/chat), bilingual VI/EN strings in `client/src/custom/customer-ai/strings.ts`, wide `AssistantChatDrawer.tsx` with thread sidebar + `[Fork Thread]`, and CSP-safe `ArtifactPreviewPanel.tsx`.
