# Token-Budgeted Context Assembly (Context Policy)

Context Policy coordinates conversation history, running summaries, retrieved
knowledge, and client-sent message history under a single per-request token
budget. It is **disabled by default** for every existing and newly created
client key (`sk-cp-...`). When disabled, request assembly and provider payloads
remain unchanged.

Specification and contracts: [`specs/021-context-engineering/`](../specs/021-context-engineering/).

## Supported and Out-of-Scope Paths

Context Policy applies to client-profile keys (`sk-cp-...`) on the four main
chat inference surfaces:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`

The following paths intentionally keep their existing behavior even when Context
Policy is enabled (no budget fitting, no `X-FreeLLM-Context` header, and no
summary window boundary updates):

- Server-side MCP tool-loop takeover requests
- Multi-agent Orchestrator (`flow:<slug>`) runs
- Quick answers (short-circuited without calling a model)
- Ollama compatibility endpoints under `/api` (no client-profile gate)

## Two-Phase Assembly Pipeline

1. **Candidate collection (profile gate)**:
   - Resolves the profile's policy (or inherits the system default).
   - When `X-Conversation-Id` is active, loads candidate history up to
     `settings.maxMessages` (and a wide character cap `(maxInputTokens ?? 1_000_000) * 4`)
     and registers the running summary and each candidate history message in a
     per-request `SegmentRegistry`.
   - Applies a provisional token cap (`knowledgeSharePct% * (provisionalBudget - mandatoryTokens)`)
     to keyword and hybrid retrieval, selecting whole passages in descending score
     order while skipping passages with at least 80% 5-word shingle overlap
     against registered history or summary text.
   - Rejects requests early with HTTP `400` (`context_budget_exceeded`) if
     mandatory segments alone (system/developer instructions, enforced profile
     prompt, final user message, trailing tool chain, and tool schemas) already
     exceed the provisional budget.
2. **Dispatch fitting (per route attempt)**:
   - Adjusts the router's `chars / 4` routing estimate by subtracting droppable
     segments so fallback models with smaller context windows remain eligible.
   - Computes the route's effective budget:
     `min(maxInputTokens ?? Infinity, floor((contextWindow - outputReserve) * (1 - safetyMarginPct / 100)))`.
     If the client sent `max_tokens` / `max_completion_tokens` / `max_output_tokens`
     / `generationConfig.maxOutputTokens`, the surface's resolved output reserve is
     used; otherwise `policy.outputReserveTokens` applies.
   - Fits from the original `base` message array on every fallback retry using the
     fixed priority order:
     1. **Mandatory** (never truncated or dropped)
     2. **Summary** (trimmed at sentence boundaries if over `summarySharePct`, then dropped if still over total budget)
     3. **Knowledge** (dropped as a block if over `knowledgeSharePct` or total budget; removes `x-freellm-citations` and skips response citation appending when dropped)
     4. **History** (evicted oldest-first in aligned blocks of `dropBlockTurns` turns to keep leading prompt prefixes cache-friendly, always keeping tool-call/result pairs intact and starting history on a user turn)
   - Unused summary and knowledge headroom is automatically reallocated to history.

## Token Estimation and Calibration

Tokens are estimated locally without external tokenizer libraries using
script-weighted character ratios (`ASCII / 4`, accented Latin / Vietnamese
`U+00C0–U+024F` / `U+1E00–U+1EFF` / combining marks `/ 2.5`, CJK/Kana/Hangul `/ 1`,
other scripts `/ 3`), plus 4 tokens per message framing overhead, configurable
`imageTokens` per image block (default `765`), and JSON-serialized tool schemas.

When providers report real `input_tokens` differing from the `chars / 4` fallback
heuristic, `report.ts` updates an in-memory per-platform exponential moving
average (`alpha = 0.1`, clamped to `[0.75, 1.6]`). During dispatch fitting, the
segment multiplier is clamped to `Math.max(1.0, factor)` so conservative budget
ceilings are never relaxed below raw estimates, while persisted reports and
error statistics use the full calibrated estimate.

## Presets and Policy Configuration

Manage per-key policies from the **Context policy** card on each client profile
page (`GET/PUT/DELETE /api/client-profiles/:id/context-policy`), or configure
system defaults on `GET/PUT /api/settings/context-policy`:

| Setting | Saver (`saver`) | Balanced (`balanced`) | Max Context (`max_context`) | Custom (`custom`) Range |
| --- | --- | --- | --- | --- |
| `maxInputTokens` | `8000` | `16000` | `null` (model window) | `2000`–`1000000` or `null` |
| `outputReserveTokens` | `1024` | `1024` | `2048` | `128`–`32768` |
| `safetyMarginPct` | `10%` | `10%` | `10%` | `0`–`30%` |
| `summarySharePct` | `15%` | `15%` | `10%` | `0`–`60%` |
| `knowledgeSharePct` | `20%` | `25%` | `30%` | `0`–`60%` (`sum <= 80%`) |
| `dropBlockTurns` | `4` | `4` | `8` | `1`–`16` turns |
| `summarize` | `true` | `true` | `true` | `true` / `false` |
| `clientHistoryMode` | `passthrough` | `passthrough` | `passthrough` | `passthrough` \| `trim_on_overflow` \| `enforce_budget` |
| `knowledgeMinScore` | `null` | `null` | `null` | `0`–`1` or `null` |

For keys already using character-based server conversations, `GET .../context-policy`
returns a `suggested` conversion (`ceil((maxChars / 3.2) / 1000) * 1000`, minimum
`2000`, preserving `summarize`) while continuing to respect `maxMessages` as an
upper candidate bound.

System-wide defaults (`{ enabled, preset, fallbackWindowTokens, imageTokens }`)
default to `{ enabled: false, preset: "balanced", fallbackWindowTokens: 8192, imageTokens: 765 }`.
`fallbackWindowTokens` (`1024`–`1000000`) applies when both the selected model's
`context_window` and `policy.maxInputTokens` are `null`.

## Response Metadata and Error Payloads

When Context Policy is enabled on a supported route, responses include:

```text
X-FreeLLM-Context: budget=14400;mandatory=310;summary=402;knowledge=1180;history=8840;hist_sent=18;hist_dropped=24;kb_sent=3;kb_dropped=0;client_dropped=0;refits=1;window=32768
```

- `budget`: Effective token budget for the serving route.
- `mandatory`, `summary`, `knowledge`, `history`: Estimated tokens sent per segment kind.
- `hist_sent`, `hist_dropped`: Server-stored conversation messages sent vs evicted.
- `kb_sent`, `kb_dropped`: Knowledge segments sent vs dropped.
- `client_dropped`: Client-supplied history messages dropped (`0` in `passthrough`).
- `refits`: Number of fallback re-fittings performed on this request.
- `window`: Serving model's context window, or `unknown` when `null`.

When server conversations are active with Context Policy enabled,
`X-Conversation-History` reports the number of history messages **actually sent**
after budget fitting rather than the number of candidates loaded.

Requests rejected at the gate return HTTP `400` with `X-FreeLLM-Context: budget=<n>;mandatory=<m>`
and the native error schema for the active wire protocol (`code: "context_budget_exceeded"`
for OpenAI Chat / Responses, `invalid_request_error` for Anthropic Messages,
`INVALID_ARGUMENT` for Gemini).

## Preview, Statistics, and Permissions

- **Context Preview**: `GET /api/client-profiles/:id/conversations/:conversationId/context-preview`
  (also accessible from the **Preview context** button in the Conversations card)
  simulates the next turn without calling any upstream provider, showing per-segment
  tokens, first-200-character previews, drop reasons (`budget`, `block_alignment`,
  `leading_assistant`, `max_messages`), and summary boundary progress
  (`coversThroughMessageId`, `pendingFoldMessages`).
- **7-Day Statistics**: `GET /api/client-profiles/:id/context-stats?days=7` (`1`–`90`)
  aggregates average input tokens, average budget, trimmed request rate, tokens saved,
  and estimator error percentiles (`p50Pct`, `p95Pct`, `within15PctRate`) across rows
  with real provider usage.
- **Per-Request Reports**: `GET /api/client-profiles/:id/requests/:requestId/context`
  (shown inside expanded rows of **Recent Requests**) returns the stored
  `ContextAssemblySummary` without storing message content. Orphan reports and
  deleted profile policies are pruned at most once per hour.
- **Permissions**:
  - `view_client_profiles`: read `context-policy`, `context-stats`, and per-request context reports.
  - `edit_client_profiles`: modify or reset `context-policy`, and read `context-preview` (because preview surfaces stored conversation text).
  - `view_settings` / `edit_settings`: read / update `/api/settings/context-policy`.

## Client-Sent History Modes

Applications that send full message arrays on every request (without
`X-Conversation-Id`) are governed by `clientHistoryMode`:

- `passthrough` (default): Client-supplied messages are treated as pinned and
  forwarded verbatim within the model's context window (FR-009). If pinned
  client messages push the request over the profile's `maxInputTokens` cap,
  gateway-injected units (`summary`, `knowledge`, `history`) are dropped first.
- `trim_on_overflow`: Ignores `maxInputTokens` and drops oldest client history
  messages only when needed to fit within the selected model's context window,
  preventing premature "no suitable model" routing exclusions.
- `enforce_budget`: Applies the full profile and model effective budget to
  client-supplied history.

In both trimming modes, system instructions, the final user turn, trailing
tool calls, and `assistant(tool_calls)` / `tool` pairs are preserved atomically,
and no server-side summary is generated or stored.

## Known Limitations

- **Approximate estimation**: Script-weighted character ratios and in-memory EMA
  calibration do not run model-specific BPE tokenizers; safety margins (`10%` by
  default) account for minor tokenizer variance, and calibration multipliers reset
  on process restart.
- **Streaming header timing**: HTTP response headers (`X-FreeLLM-Context`) reflect
  the last dispatch attempt before headers commit to the client. In rare cases
  where a fallback happens after stream headers are already flushed, the header
  cannot be rewritten, while `custom_context_reports` in SQLite records the final
  served attempt.
- **Background summarization**: Summary updates run asynchronously after responses
  finish; if an upstream summary call fails or is throttled, the next turn falls
  back to the previous summary plus the current fitted window and retries on the
  subsequent turn.
