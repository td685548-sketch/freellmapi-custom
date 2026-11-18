# Implementation Plan: Personal AI Agent Workspace, Streaming Threads, Custom User Agents & Live Artifacts

**Branch**: `feat/038-assistant-workspace-agents` | **Date**: 2026-11-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/038-assistant-workspace-agents/spec.md`

## Summary

Extend the modular Customer AI Hub (`server/src/custom/customer-ai/`, `client/src/custom/customer-ai/`, `shared/customer-ai.ts`) with:
1. User-created Custom Assistants (`custom_user_assistants`) with 32 KB `knowledge_markdown` context and Personal API Key (`sk-flm-...`) binding (`custom_user_key_assistant_bindings`) injected transparently on `/v1` requests via `customerAiSessionRoutingMiddleware`.
2. Persistent multi-turn chat threads (`custom_assistant_threads`, `custom_assistant_messages`), turn-level thread branching, and SSE token streaming (`/api/user/ai-hub/chat/stream`) with graceful JSON fallback.
3. Wide Agent Workspace UI (`AssistantChatDrawer.tsx`), `CustomAgentModal.tsx`, bilingual VI/EN `strings.ts`, and CSP-safe `ArtifactPreviewPanel.tsx` without touching `register.ts`, `App.tsx`, `QuotaCoachCard.tsx`, or upstream locale files.

## Technical Context

**Language/Version**: TypeScript 5.8+ / Node.js >= 20.18.0 (ESM)

**Primary Dependencies**: Express 5, `better-sqlite3`, Zod 4, React 19, `@tanstack/react-query`, `react-markdown`, `remark-gfm`, Lucide Icons, Tailwind CSS 4

**Storage**: SQLite (`better-sqlite3` WAL) via reversible migration `20261118_180000_custom_assistant_workspace.ts`

**Testing**: Vitest (`server/src/__tests__/custom/assistant-workspace.test.ts` + `npm run test:migrations`)

**Target Platform**: Both Cloud Hosting (`Render` + `Turso`) and Local Production (`SQLite` + Tunnel)

**Project Type**: Monorepo (`shared`, `server`, `client`, `cli`)

**Constraints**:
- Strict Zero-Conflict Modular Design: zero edits to `server/src/custom/register.ts`, `client/src/App.tsx`, `client/src/custom/customer-ai/QuotaCoachCard.tsx`, or shared i18n JSON/TS dictionaries.
- Strict Helmet CSP (`script-src 'self'`): `ArtifactPreviewPanel.tsx` must never rely on inline `<script>` execution or unsanitized HTML/SVG injection.
- Strict per-user isolation: every SQL query on `custom_user_assistants`, `custom_user_key_assistant_bindings`, `custom_assistant_threads`, and `custom_assistant_messages` filters by `user_id = req.user.userId`.

## Constitution Check

- **I. Security & Credential Protection**: Passes — strict `user_id` isolation, input validation via Zod, HTML/SVG allowlist sanitizer blocking `<script>`, `on*` handlers, `<foreignObject>`, `<iframe>`, and `javascript:`/`data:text/html` URIs.
- **II. Monorepo Separation**: Passes — DTOs in `shared/customer-ai.ts`, backend logic in `server/src/custom/customer-ai/`, React UI in `client/src/custom/customer-ai/`.
- **III. Robustness & Resilience**: Passes — reversible idempotent SQLite migration (`// DOWN: reversible`), SSE stream cleanup on client disconnect, graceful JSON fallback when upstream responds non-streaming.
- **IV. Test-First & Quality Verification**: Passes — dedicated Vitest suite covering CRUD caps, user isolation, `/v1` personal key prompt + knowledge + routing injection, threads/branching, SSE streaming, and sanitizer safety.
- **V & VI. Backward Compatibility & Zero-Conflict**: Passes — reuses existing `/api/user/ai-hub` and `customerAiSessionRoutingMiddleware` mounts in `register.ts` without touching upstream files.

## Project Structure

### Documentation (this feature)

```text
specs/038-assistant-workspace-agents/
├── spec.md
└── plan.md
```

### Source Code (repository root)

```text
shared/
└── customer-ai.ts

server/src/
├── db/migrations/
│   └── 20261118_180000_custom_assistant_workspace.ts
├── custom/customer-ai/
│   ├── store.ts
│   ├── workspace-store.ts
│   ├── runtime.ts
│   └── router.ts
└── __tests__/custom/
    └── assistant-workspace.test.ts

client/src/custom/customer-ai/
├── strings.ts
├── artifacts.ts
├── api.ts
├── ArtifactPreviewPanel.tsx
├── CustomAgentModal.tsx
├── AssistantChatDrawer.tsx
└── CustomerAiHubPage.tsx
```
