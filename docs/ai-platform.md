# AI Platform operator guide

The AI Platform adds six optional capabilities ("pillars") to the existing
inference endpoints. Every pillar is off by default. With all of them off the
gateway behaves as before: no request or response field changes, and the
added processing on the hot path measures about 0.1% of a request
(`server/src/__tests__/custom/ai-platform/overhead-bench.test.ts`).

Specification and design: [`specs/018-ai-platform-upgrade/`](../specs/018-ai-platform-upgrade/).
Request and response contract: [`contracts/inference-surface.md`](../specs/018-ai-platform-upgrade/contracts/inference-surface.md).

## Where it applies

The pillars run on client-profile keys for the four chat protocols:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/responses`
- `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent`

Requests under `/thruline/v1` do not pass through the profile gate and are not
affected. The CLI and desktop app need no changes.

## Pillars

| Pillar | Flag | What it does |
| --- | --- | --- |
| Versioned prompts | `prompts` | Draft, publish, compare and restore a client key's system prompt. Templates take variables such as `{{date}}`, `{{profile_name}}`, `{{end_user_id}}` and caller variables sent in `x-freellm-vars`. |
| Semantic retrieval | `retrieval` | Embeds the knowledge library and searches it by meaning (`keyword`, `semantic` or `hybrid`). Can return citations. |
| Provider prompt cache | `promptCache` | Forwards or places cache breakpoints for providers that support explicit caching, and records cache read and write tokens. |
| MCP client | `mcpClient` | Connects remote MCP servers over HTTP. Reviewed tools are offered to the model and run in a server-side loop. Tools that write need approval first. |
| Output guard | `outputGuard` | Checks answers for keywords, patterns, prompt leaks, PII and length, then logs, masks or blocks them. |
| Orchestrator | `orchestrator` | Runs multi-agent flows, called as `model: "flow:<slug>"`, with step, tool, handoff, token and time limits. |

## Processing order

The order is fixed. `server/src/__tests__/custom/ai-platform/all-pillars.test.ts`
checks it with every pillar on.

```text
 1. authentication, model restrictions, rate limits        (existing)
 2. input content filter                                    (existing)
 3. server-side conversations, quick answers                (existing)
 4. flow:<slug>  ->  orchestrator takes over (steps 5-8 run for each agent)
 5. system prompt: render variables                         (prompts)
 6. knowledge: search and inject                            (retrieval)
 7. MCP tools: attach definitions, run the tool loop        (mcpClient)
 8. provider cache breakpoints, on every attempt            (promptCache)
 9. model call                                              (existing)
10. response: cache stats -> citations -> output guard
```

Each round of the MCP tool loop calls the model through an internal loopback
request. That request is signed with a per-process HMAC, skips steps 4 to 7,
and receives the caller's `x-freellm-vars`, `x-end-user-name` and
`accept-language` so the prompt renders the same as in the outer request.
`x-ai-platform-internal` is removed from external requests before
authentication.

## Turning pillars on and off

- Dashboard: **AI Platform -> Overview** (`/ai-platform`). The switches need the
  `edit_ai_flags` permission.
- API: `PUT /api/ai-platform/flags` with any subset of
  `{ "prompts", "retrieval", "promptCache", "mcpClient", "outputGuard", "orchestrator" }`
  as booleans. Keys you leave out keep their value.

Flags are cached for 5 seconds. A missing or unreadable flag record means
every pillar is off. Turning a pillar off keeps its data, so turning it back
on restores the previous configuration.

Per request, callers can opt out of some behaviour:

| Header | Effect |
| --- | --- |
| `x-freellm-citations: off` | No citations in the response; knowledge is still injected. |
| `x-freellm-tools: off` | No MCP tools for this request. |

## Default limits

| Area | Default | Ceiling |
| --- | --- | --- |
| Caller variables (`x-freellm-vars`) | 2 KB header, 200 chars per value | — |
| Prompt body / retained versions | 32,000 chars / 50 versions | — |
| Retrieval | top-K 5, min score 0.25, 768 dimensions, 1.5 s query timeout | top-K 20, 4,096 dimensions |
| Citations header | 4 KB | — |
| MCP call timeout / result size | 20 s / 256 KB | 120 s / 1 MB |
| MCP concurrency / tool rounds | 4 / 8 | 32 / 20 |
| MCP circuit breaker | opens after 5 failures, 60 s doubling to 15 min | — |
| Tool approval expiry | 24 h | — |
| Output guard hold / delay (streaming) | 200 chars / 300 ms | 2,000 chars / 2 s |
| Output guard max length | 20,000 chars | 1,000,000 chars |
| Prompt cache breakpoints / min tokens / TTL | 4 / 1,024 / 300 s | 16 / 100,000 / 1 day |
| Flow steps / tool calls / handoffs | 12 / 20 / 4 | 50 / 100 / 10 |
| Flow tokens / time | 60,000 / 120 s | 500,000 / 600 s |

Sources: `shared/ai-platform*.ts`.

## Data retention and cleanup

- Run traces and tool call logs are kept 30 days and guard excerpts 7 days.
  Change this with `GET/PUT /api/ai-platform/retention`.
- Deleting a client profile removes that profile's pillar data: prompt
  versions, retrieval settings and embeddings, cache statistics, guard
  policies and events, flow grants and runs, and MCP bindings, call logs and
  approvals.
- MCP credentials are stored encrypted with `ENCRYPTION_KEY` and are never
  returned by the API.

## Backups

Backups include every `custom_ai_*` table and the `ai_platform_*` settings.
MCP credentials stay encrypted in the dump. `custom_ai_chunk_embeddings` can
be left out of a backup to keep it small: after such a restore, the index
worker finds chunks that have no embedding and reindexes those scopes. It
checks when it starts and then every 5 minutes, while the retrieval pillar is
on. A scope whose last indexing job failed is retried after 30 minutes.

## Permissions

All pillars sit under the `manage_ai_platform` permission group, with
separate view, edit and publish permissions per pillar. A single-user
deployment's owner has every permission. Each permission is described in
[`data-model.md`](../specs/018-ai-platform-upgrade/data-model.md).
