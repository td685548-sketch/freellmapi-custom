# Context Budget Assembly (`server/src/custom/context-budget/`)

Token-budgeted context assembly for client-key traffic (Spec 021).
Architecture and design details: [specs/021-context-engineering/plan.md](../../../../specs/021-context-engineering/plan.md).

## Two-Stage Pipeline

1. **Collection at the gate (`gate.ts`)**
   - Runs in `server/src/middleware/profile-gate.ts` alongside `conversation-inject.ts`, `knowledge-inject.ts`, and `ai-platform/pipeline.ts` (slot 6) before surface compression or routing.
   - When the client key's context policy is enabled, resolves the effective policy, loads wider history/summary/knowledge candidates, deduplicates knowledge against history/summary, and records each injected unit in a request-scoped `SegmentRegistry` (`WeakMap<Request, SegmentRegistry>`).
   - Rejects requests with HTTP 400 `context_budget_exceeded` at the gate when mandatory context already exceeds the provisional budget.

2. **Budget fitting at dispatch (`hooks.ts` + `fit.ts`)**
   - Runs in each surface's `runFallbackLoop` (`proxy.ts`, `anthropic.ts`, `responses.ts`, `inbound-chat.ts`) via two minimal hooks:
     - `contextRoutingTokens(req, routingTotal, messages)` in the `route` closure so smaller models are not prematurely excluded when droppable context can be trimmed.
     - `fitContextForRoute(req, res, messages, route, outputReserve)` at the start of `dispatch` so the final `ChatMessage[]` (after protocol translation, compression, enforced prompts, and reasoning restoration) is fitted to `min(maxInputTokens ?? Infinity, floor((contextWindow - outputReserve) * (1 - safetyMarginPct / 100)))`.
   - Segments are dropped in fixed priority order: oldest history turns (anchored in blocks of `dropBlockTurns` to preserve prefix caching, never splitting tool-call/result groups and always starting on a user turn), then retrieved knowledge (whole block), then summary (sentence-trimmed, then dropped). Mandatory segments are never dropped.
   - Each fallback attempt refits from the original `base` transcript so moving from a smaller model to a larger one recovers previously dropped turns.
   - Sets the `X-FreeLLM-Context` response header and persists an allocation report to `custom_context_reports` on response finish (without logging message content).

## Backward Compatibility & Scope

- When the key's context policy is disabled (the default), every hook is a strict no-op: input values/references are returned unchanged, no headers are added, and no DB rows are written.
- Out-of-scope paths (MCP takeover, orchestrator flows, quick answers, and `/api` Ollama emulation) do not pass through surface dispatch with a client-key registry, so `fitted` remains `false` and behavior is unchanged.
