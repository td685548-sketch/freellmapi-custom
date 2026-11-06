# X Gateway (9Router Integration) Operator Guide

## What it is

The X Gateway (`/x/v1`) is an administrative, OpenAI-compatible entrypoint into FreeLLMAPI's existing model pool. It provides an isolated routing and edge layer that offers:

- **Strict Admin-Only Access**: Gated by the `use_x_gateway` permission (held by default by the primary administrator).
- **Independent Configuration**: Dedicated configuration tables (`x_gateway_config`, `x_gateway_combos`, `x_gateway_usage_hourly`) separate from upstream tables.
- **Ordered Fallback Combos**: Custom model combos are stored and validated, but `combo:<name>` routing is not wired into the request path yet.
- **Token Savers**: The gateway-wide output savers are available on `/v1` and editable from the console; the separate per-request X defaults are stored but not applied to `/x/v1` yet.
- **Dedicated Console**: Separate management UI at `/x` (Providers, Provider accounts, Endpoint & Key, Token Saver, Account usage), behind the same permission model.

It reuses the core proxy routing and fallback execution internally without altering `/v1` endpoints.

## Enabling it

The X Gateway is **disabled by default**. When disabled, any request to `/x/v1` answers with a 404 `not_found` response identical to an unmapped path to prevent information leakage.

To enable the gateway:
1. Sign in as an administrator holding the `edit_x_settings` permission.
2. Open `/x/endpoint` and use the gateway switch, or issue an authorized request:
   ```http
   PUT /api/x-gateway/enabled
   Content-Type: application/json

   {
     "enabled": true
   }
   ```
3. The setting takes effect immediately and invalidates the cached configuration snapshot.

## Calling it

Call the X Gateway using standard OpenAI client libraries with your personal API key (`sk-flm-...`):

```bash
curl http://localhost:3000/x/v1/chat/completions \
  -H "Authorization: Bearer sk-flm-YOUR_PERSONAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Hello world!"}
    ]
  }'
```

Response headers added by the X Gateway:
- `X-Gateway: x`
- `X-Output-Saver-Applied`: currently empty (savers are not applied on this path yet)
- `X-Input-Tokens-Saved`: currently `0`

The request is then handed to the ordinary chat handler, so routing, fallback, provider selection, limits and logging are the same as `/v1`.

## Console (`/x`)

`/x` is a separate application shell (its own sidebar and header, no main dashboard navbar) shown only to a signed-in account holding `use_x_gateway`. Any other account gets the not-found page.

| Page | What it does | Permission |
| --- | --- | --- |
| `/x/providers` | Lists every configured provider, split into login providers (OpenRouter, GitHub Copilot) and API-key providers, with real account counts and a search / connected-only filter. | `view_keys` |
| `/x/providers/:id` | Accounts of one provider: enable/pause, health check, rename, reconnect, remove, and the models each account contributes. | `view_keys` to read; key permissions for actions |
| `/x/endpoint` | Base URL, a copyable `curl` example with a placeholder key, and a link to the personal-key page. Never shows a real key. | `use_x_gateway` |
| `/x/savers` | The existing gateway-wide output savers (caveman / ponytail levels), not the per-request X defaults. | `manage_compression` to write |
| `/x/usage` | Per-account request and token usage for the current month against each account's local caps. | `view_keys` |

## Provider accounts

The Providers pages manage credentials in the same `api_keys` table the main dashboard uses, so connected accounts immediately join the shared provider pool for both `/v1` and `/x/v1`. Three connection methods are offered, and a button is shown only where a real flow exists:

| Provider | Method | Flow |
| --- | --- | --- |
| OpenRouter | `oauth_pkce` or `api_key` | The browser is sent to `openrouter.ai/auth` with an S256 PKCE challenge and a same-origin callback at `/x/accounts/callback`. The server exchanges the returned code for an OpenRouter key. The callback can also be pasted manually into the dialog. |
| GitHub Copilot | `device_code` | The server requests a device code from GitHub, the dialog shows the user code and the verification page, and the server polls until the grant is issued. The GitHub token is stored server-side and exchanged for a short-lived Copilot token at request time. |
| Every other provider | `api_key` | The credential is submitted through the existing `/api/keys` path and encrypted with the install key. |

Permissions are the existing granular key permissions, all under `use_x_gateway`:

- `view_keys` to list providers and accounts,
- `add_keys` to connect a new account, plus `manage_key_models` for GitHub Copilot because it registers models,
- `edit_keys` to rename, pause, or reconnect (reconnect is refused for a different GitHub account),
- `delete_keys` to remove an account,
- `test_keys` to run a credential health check.

Connect attempts are held in memory only: they are bound to the creating user and session token, expire after 10 minutes, are capped per user, and can be cancelled. Credentials, codes, and session tokens are never returned to the browser; only account labels, identities (the GitHub user id), status, models, and usage are.

## Savers

There are two separate settings, and only the first one affects requests today:

1. **Gateway-wide output savers** (`/api/savers`, edited on `/x/savers`): caveman and ponytail levels applied to `/v1` chat requests by the existing saver middleware. No X-specific savers are involved.
2. **X default savers** (`PUT /api/x-gateway/defaults`): the stored shape is `{ caveman: boolean, ponytail: 'off'|'lite'|'full'|'ultra', input: 'off'|'lossless'|'standard' }`. **Not applied yet:** `/x/v1` currently forwards the conversation unchanged and does not read the `X-Token-Saver`, `X-Output-Saver` or `X-Input-Saver` headers, so setting them has no effect. The response headers report an empty saver list and `0` saved tokens.

## Combos

Combos are stored and validated but **not routed yet**: `/x/v1` does not resolve `model: "combo:<name>"`, so such a request is handled like any other unknown model. The validation rules that the storage layer already enforces are:

- Maximum 50 combos per instance, 1-20 ordered entries each, no duplicate entries.
- Combo names are 1-48 characters matching `[a-z0-9\-_.]` and cannot be `auto` or start with `auto:` or `combo:`.
- Entries are stored as `{ platform, modelId }` and are not checked against live provider credentials at save time.

## Security Considerations

The X Gateway attack surface is mitigated according to the following threat matrix:

| Threat | Control |
| --- | --- |
| Non-admin uses the gateway | Permission checked on every request; 401/403; tests for anonymous, member, revoked key, demoted admin |
| Combo names used from `/v1` | Planned resolver answers only inside the gateway scope (not wired yet) |
| Privilege escalation through the new permission | Existing delegation rule; group appears in the existing dialog |
| Large or slow anonymous bodies | Existing pre-parse guard extended to `/x/v1` |
| Abuse by a stolen admin key | Per-user rate limit, revocation (existing), kill switch, logging with the `x-gateway` tag |
| Instruction injection through savers | Planned: fixed server-side text only, no user-supplied saver text (not applied on `/x/v1` yet) |
| Key disclosure through the console | The console never receives or displays a key; the usage example uses a placeholder |
| CSRF on console APIs | Bearer-token session, no cookies |
| Cache staleness after permission change | Permission read from the key lookup on every request, not cached |
| Information leakage when off | 404 identical to an unknown path |
| OAuth callback hijack or open redirect | Callback must be same-origin `/x/accounts/callback`; the attempt id is unguessable and bound to the session; PKCE verifier stays on the server |
| Phishing through a forged login link | The dialog only links to `https://openrouter.ai` or `https://github.com` with no credentials or port |
| Credential or token disclosure in the console | Accounts API returns labels, status, models and usage only; keys never leave the server |
| Reconnect stealing another grant | Reconnect requires the original provider subject and `edit_keys` |
| Resource exhaustion by combos | Name length, 50 combos, 20 entries each (storage layer enforced) |

## What it deliberately does not do

The X Gateway explicitly does **not**:
- Replace, duplicate, or alter `/v1/*`, `/livez`, `/readyz`, or `/api/ping`.
- Sign in to arbitrary providers or scrape a web session; only OpenRouter browser login and GitHub Copilot device login are implemented, everything else uses an API key.
- Bypass a provider's subscription limits or quotas.
- Provide cloud synchronization or external compression proxies.
- Permit non-administrator access or anonymous invocation.
