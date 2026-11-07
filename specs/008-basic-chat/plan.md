# Implementation Plan: X Gateway Basic Chat

## Summary
Adapt 9Router BasicChatPageClient interactions to React/Vite X Gateway. Share the existing gateway chat handler for SSE, fallback, caps, proxies, savers and accounting. Add session-authenticated playground routes and a safe model catalog. Keep existing pending Combos/Logs work intact.

## Technical Context
TypeScript, Express 5, React 19, TanStack Query, existing SSE reader, Markdown component, Vitest/jsdom. No dependencies or database migrations.

## Constitution Check
PASS: encrypted credentials stay server-side; existing permission gate reused; standalone custom modules; minimal router mount/export; no changes to public endpoint contracts; meaningful HTTP and UI tests.

## Project Structure
- shared/x-playground.ts: request/catalog DTOs.
- server/src/custom/x-gateway/playground-router.ts: validated session chat and model catalog.
- server/src/custom/x-gateway/router.ts: export existing handler, support abort on disconnect and sanitized errors.
- client/src/custom/x-gateway/playground-{api,state,strings}.ts: transport, bounded identity-scoped history, bilingual labels.
- client/src/custom/x-gateway/pages/Playground.tsx and playground.css: responsive chat UI.
- server/src/__tests__/custom/x-playground.test.ts and client/src/custom/x-gateway/playground.test.tsx: integration and interface coverage.

## Phases
1. Write tests and shared contract.
2. Backend: safe model choices from usable accounts, validate body, reuse handler behind use_x_gateway, reject disabled gateway.
3. UI: model choices, Markdown, streaming/Stop, system/sampling settings, in-memory image attachments, conversation history isolated by userId.
4. Run targeted checks, full test/build/lint; review final diff.
