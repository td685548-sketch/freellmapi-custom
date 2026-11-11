# X Gateway operator guide

X Gateway is the fork's isolated inference surface at `/x/v1`, with its console
at `/x`. It uses `x_gateway_keys` provider accounts, dedicated configuration and
client keys. Existing `/v1/*` routes remain available independently.

## Enable and connect

Sign in with `use_x_gateway`; enable the gateway on `/x/endpoint` with
`edit_x_settings`. Connect provider credentials on `/x/providers`. Client calls
use a dedicated `sk-xgw-...` key or a personal `sk-flm-...` key whose owner holds
`use_x_gateway`. Revocation and current permissions are checked for inference.
When disabled the inference surface returns 404.

Provider credentials are encrypted server-side. Dedicated client keys are stored
as hashes, displayed in full only when created, and cannot be recovered later.
Provider accounts are separate from the main dashboard pool.

```sh
curl "$GATEWAY_URL/x/v1/chat/completions" \
  -H "Authorization: Bearer $X_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Reply OK"}],"max_tokens":16}'
```

## Console and permissions

| Page | Purpose |
| --- | --- |
| `/x/providers` | Connect, pause, test and manage provider accounts and custom nodes |
| `/x/endpoint` | Enable gateway, create/revoke client keys and restrict model access |
| `/x/combos` | Configure fallback, round-robin, smart and fusion routing |
| `/x/savers` | Configure output savers and input compression options |
| `/x/quota` | Provider quota observations, reset windows and routing tiers |
| `/x/usage` | Account usage and local caps |
| `/x/proxies` | Outbound proxy pool management |
| `/x/media` | Provider-specific media configuration/tests |
| `/x/tools` | Local client setup, actual inference tests and diagnostics |
| `/x/translator` | Inspect protocol translation |
| `/x/playground` | Interactive chat |
| `/x/skills` | Discover/download client skills |

Granular permissions still apply: `view_keys`, account key actions,
`edit_x_settings`, combo permissions, `manage_compression`, usage permissions.
The CLI operations API is under `/api/x-gateway/tools`, behind console session
authentication and `use_x_gateway`; an inference key alone is not a console session.

## CLI Tools: setup and real tests

1. Open CLI Tools; paste a full client key or create a new key. Selecting a stored
   key never reconstructs its secret. If selecting a stored key, paste its full
   value before selecting its row; the test checks that the values match.
2. Select a real provider/model, `auto`, or `combo:<name>` from the model catalog.
3. Choose the tool and run **Test Connection**. This sends a small non-streaming
   inference through its actual endpoint using that key/model, including auth,
   model restrictions and rate limits. It consumes provider quota.
4. Download **local setup + backup/restore**, run `node x-gateway-setup.mjs` on
   your own computer, then run the generated launcher. Node.js 20+ is required.
   The script does not launch the client or edit the hosted server's home.

The endpoint test always targets this installation's bound local HTTP port. It
does not send your key to a custom host or use the incoming Host/Forwarded headers
as a network destination. Use the current origin URL for testing. Custom URLs
are for downloadable configuration; verify public ingress separately.

| Tool | Test protocol | Local setup |
| --- | --- | --- |
| Claude Code | `/x/v1/messages` | Merge `~/.claude/settings.json`; preserve unrelated settings |
| Codex | `/x/v1/responses` | Launcher supplies `-c` overrides; existing `config.toml` and `auth.json` untouched |
| Gemini CLI | `/x/v1beta/models/...:generateContent` | API-key auth setting and launcher environment |
| OpenCode | `/x/v1/chat/completions` | Merge existing provider map; v1 detected from `provider`, otherwise v2 |
| Cursor | `/x/v1/chat/completions` | Private instruction file for Settings; no keychain/settings database edits |

Claude's base URL is the `/x` root because its SDK appends `/v1/messages`.
Gemini's base URL is `/x`, with `GOOGLE_GENAI_API_VERSION=v1beta`. OpenAI clients
use `/x/v1`. The setup launcher carries the chosen model and key.

Setup creates timestamped backups under `~/.x-gateway/backups/` and prints:
`node x-gateway-setup.mjs --restore "<backup-directory>"`. Restore reinstates
original file bytes or removes newly created files. Invalid existing JSON is
refused before changes. JSONC-only OpenCode configurations are refused instead
of shadowed; merge manually. Explicitly pass `--opencode-version 1` or `2` if needed.
Downloads, launchers and backups can contain credentials: keep them private.

## Diagnostics

`GET /api/x-gateway/tools/diagnostics` reports configuration without running any
paid inference. **Configured** means settings/accounts exist, **unverified** means
no recent execution evidence, **ready** means a successful recent text probe for
the displayed protocol/model/key, and **unavailable** means disabled/missing or
the most recent probe failed. Ready does not verify streaming or tool calls.

Evidence is session-scoped, expires after five minutes and resets on server
restart. It is historical evidence, not a health guarantee; key/account changes
require another test. Other models, savers and media remain unverified by a text
probe. Diagnostics never returns credentials or provider response content.
SQLite persistence requires operator verification of the mounted disk; the
server cannot prove that an arbitrary filesystem path survives Render redeploys.

## Combos, savers and protocol support

Combos **are routed** by `model: "combo:<name>"`. Fallback and round-robin use the
saved model entries; smart routing uses observed health and optional session
stickiness. Fusion semantics are defined by the implementation, not the main
dashboard's synthesis model. Saved provider/model aliases and disabled models
are applied at routing time. Test the exact combo you intend to use.

Caveman/Ponytail output prompts **are applied** on the X request paths. Global
output saver settings and X defaults are separate. Compression UI/configuration
alone does not prove input preprocessing is connected. Check actual request
metadata and the implementation's tests before claiming RTK/Headroom/PXPIPE
savings. `X-Input-Tokens-Saved: 0` is not evidence of successful compression.

Core surfaces include chat, Messages, Responses, completions, embeddings, image,
speech/transcription, Gemini and Ollama compatibility, and search/fetch. Capability
depends on the selected provider, credentials and protocol implementation. A
catalog entry alone does not prove provider execution support. Media and coding
agent streaming/tools need their own tests, even after a successful text probe.

## Deployment and remaining work

Native subscription executors, browser import/login, refresh requirements and
the provider availability matrix are documented in
[Subscription providers on Render](x-gateway-subscriptions.md). HTTP fixture
verification does not imply live access for an imported account. Protocol model
allowlists apply to Messages/Responses/media as well as Chat Completions.

See [Render deployment and smoke checks](x-gateway-render.md), including durable
SQLite or the experimental Turso backend, encryption key, callbacks and proxy.

Backlog: wider provider execution/quota coverage; verified OAuth refresh for every
subscription provider; protocol/media parity where not yet implemented; saver
execution verification; SSO/cloud sync; additional relay deployment targets.
No SSO/cloud sync readiness is inferred from menus. Tunneling binaries are not
required to deploy this web service and must not be added to GitHub Actions.
