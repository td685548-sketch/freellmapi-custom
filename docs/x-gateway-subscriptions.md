# Subscription providers on Render

The gateway has native executors for the four providers below. HTTP fixtures
verify transport and lifecycle behavior; **live access is unverified** until an
operator supplies their own authorized account and tests the selected model.
Saving/importing credentials sets status `unknown`, not `healthy`.

| Provider | Catalog | Browser connection/import | Refresh | Executor | Provider quota | Live |
| --- | --- | --- | --- | --- | --- | --- |
| Codex subscription | Yes | PKCE, paste entire localhost callback URL; full `auth.json` import | Rotating refresh token | ChatGPT backend Responses SSE | WHAM usage | Unverified |
| Claude OAuth | Yes | PKCE, paste complete `code#state`; full `claudeAiOauth` JSON import | OAuth refresh | Anthropic Messages, OAuth bearer headers | OAuth usage | Unverified |
| Gemini CLI | Yes | Registered Google OAuth web client/public callback; credential JSON import | Requires the client ID/secret matching the token's original grant | Cloud Code Assist `{project, model, request}` | `retrieveUserQuota` per model | Unverified |
| Kiro | Yes | AWS Builder ID device flow; structured credential JSON import | OIDC registration or social refresh, according to imported metadata | AWS EventStream with CRC validation | CodeWhisperer usage limits | Unverified |
| OpenRouter / Copilot | Yes | Existing browser/device flows preserved | Existing Copilot lifecycle | Existing adapters preserved | Existing adapters | Unverified in this change |
| Other OAuth catalog entries | Yes | Provider-specific support varies | No general refresh guarantee | Unsupported entries are rejected instead of using a generic OpenAI adapter | Unknown unless an adapter exists | Unverified |

The capability matrix is available to dashboard sessions with `view_keys` at
`GET /api/thruline-accounts/subscriptions/capabilities`. Executor availability describes
implementation, not an account's subscription entitlement or live readiness.

## Browser account setup

Open the provider's account page and choose Connect/Reconnect. Import reads the
selected file **in your browser** and uploads its JSON over HTTPS. The server
does not read a home-directory credential file. Keep the complete access token,
refresh token and expiry. Missing expiry forces refresh; it does not invent a
fresh session. Codex API keys belong in an API-key provider, not Codex subscription.

Older Codex/Gemini CLI/Kiro records containing only a pasted access token do not
gain a refresh token automatically. Reconnect/import the complete credential JSON
after upgrading. An old saved status is not proof that the native executor works.

Kiro OIDC imports must include their own `clientId`, `clientSecret` and `region`
alongside tokens. Include your own `profileArn` when required by the account;
the gateway does not invent a shared profile. Social imports without OIDC client
registration use Kiro's social refresh endpoint. Missing/rejected registration
requires reconnecting. Device/client registration secrets never appear in the
browser's start/poll responses.

For Gemini browser login, configure server-side `GEMINI_CLIENT_ID`,
`GEMINI_CLIENT_SECRET` and HTTPS `PUBLIC_APP_URL`. Register exactly:

```text
https://YOUR-SERVICE.onrender.com/thruline/accounts/callback
```

Imported Gemini CLI tokens must have been issued to the configured OAuth client;
changing a desktop grant to an unrelated web client does not make it refreshable.
A Google project with Code Assist entitlement is also required. Include
`projectId` in the credential JSON, or the gateway will attempt `loadCodeAssist`.
The app's Google dashboard login callback `/api/auth/google/callback` is separate.

Codex's default public client has a fixed localhost redirect. After provider
login, copy the **whole** callback URL from your browser into the connection
dialog; no listener is started on Render or your computer. Claude's default
client displays `code#state` at the provider's callback. Do not register the
Render URL for these public clients unless the provider explicitly supports it.
Pending attempts are session-bound, expire after ten minutes and reset on server
restart. Completed credentials persist in the configured database.

Endpoints under `/api/thruline-accounts/subscriptions`:

- `POST /start`: `{provider, label, reconnectId?}`
- `POST /import`: same fields plus `credential` containing full JSON as a string
- `POST /:attemptId/complete`: `{code}` containing a full callback URL or `code#state`
- `POST /:attemptId/poll`: Kiro device authorization
- `DELETE /:attemptId`: cancel

All require a dashboard session and `use_x_gateway`; adding/reconnecting also
requires `add_keys`/`edit_keys`. Authorization is checked again after external
OAuth work. These are not inference-key endpoints.

## Persistence and retries

Structured credentials, including refresh tokens and Kiro registration secrets,
are encrypted in the existing `x_gateway_keys` record. Refresh is single-flight
per account/process. Rotation is persisted before inference resumes; a concurrent
reconnect cannot be overwritten by an older refresh. An initial inference 401
may refresh/retry once; a stream that has emitted output is never replayed.

Use one Render instance. Preserve the database and matching `ENCRYPTION_KEY`:
either mount a persistent SQLite disk and set `FREEAPI_DB_PATH` to that mount,
or use the repository's supported experimental Turso configuration. Render's
default filesystem is ephemeral. Refresh locks are process-local, so multiple
instances sharing these subscription grants are not supported by this change.
See [Render deployment](x-gateway-render.md) for storage, `PORT`, bind address,
health checks, reverse proxy and restart verification.

Gemini model quota buckets are displayed separately and do not mark the entire
account exhausted. Missing provider quota remains unknown; local monthly limits
remain independent. Subscription credentials are never forwarded to generic
media/embedding APIs. Use a provider that explicitly supports those capabilities.

## Verification

Run HTTP fixtures without live secrets:

```sh
npm run test -w server -- --run src/__tests__/custom/provider-execution.test.ts src/__tests__/custom/gateway-review-regressions.test.ts
```

After importing/authorizing each live account, select an eligible model in the
account test. The subscription health check performs a small real inference.
Then run the public gateway smoke once for each provider, using its exact model
ID from `/thruline/v1/models`:

```sh
export GATEWAY_URL=https://YOUR-SERVICE.onrender.com
read -rs X_GATEWAY_API_KEY; export X_GATEWAY_API_KEY; echo
export X_GATEWAY_MODEL=codex/YOUR-ELIGIBLE-MODEL
export X_GATEWAY_TOOL=codex
node scripts/x-gateway-smoke.mjs
```

Repeat with `claude/MODEL`, `gemini-cli/MODEL`, and `kiro/MODEL` and the appropriate
client protocol (`claude`, `gemini`, or `cursor`). Expected: health and completed
inference HTTP 200; the script prints no credentials or generated content.
Check streaming/tool calls in the intended coding client too. Restart/redeploy
and repeat to verify durable storage and future refresh with the same encryption
key. A fixture pass is not live-provider verification.

PXPIPE now retains Unicode history as text because its built-in font is ASCII.
All protocol adapters receive canonical `ChatMessage` image blocks from savers;
native protocol encoding happens inside the selected executor. Messages and
Responses streams preserve parallel tool IDs, names, arguments and limit states.
