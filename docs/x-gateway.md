# X Gateway (9Router Integration) Operator Guide

## What it is

The X Gateway (`/x/v1`) is an administrative, OpenAI-compatible entrypoint into FreeLLMAPI's existing model pool. It provides an isolated routing and edge layer that offers:

- **Strict Admin-Only Access**: Gated by the `use_x_gateway` permission (held by default by the primary administrator).
- **Independent Configuration**: Dedicated configuration tables (`x_gateway_config`, `x_gateway_combos`, `x_gateway_usage_hourly`) separate from upstream tables.
- **Ordered Fallback Combos**: Custom model combos defined via `combo:<name>` for prioritized routing.
- **Token Savers**: Optional prompt-level output savers (Caveman, Ponytail lite/full/ultra) and input tool-output compression.
- **Dedicated Console**: Separate management UI accessible at `/x` (Overview, Combos, Test, Usage).

It reuses the core proxy routing and fallback execution internally without altering `/v1` endpoints.

## Enabling it

The X Gateway is **disabled by default**. When disabled, any request to `/x/v1` answers with a 404 `not_found` response identical to an unmapped path to prevent information leakage.

To enable the gateway:
1. Sign in as an administrator holding the `edit_x_settings` permission.
2. Navigate to the `/x` console or issue an authorized request:
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
- `X-Combo`: name of the active combo (when invoked via `combo:<name>`)
- `X-Output-Saver-Applied`: comma-separated list of applied output savers
- `X-Input-Tokens-Saved`: estimated input tokens saved by compression

## Savers

The X Gateway supports prompt-level output savers and input compression:
- **Caveman**: Instructs the model to output ultra-concise, telegram-style responses.
- **Ponytail**: Concise outputs with levels `lite`, `full` (default), and `ultra`.
- **Input Saver**: Compresses lengthy tool responses (`off`, `lossless`, `standard`).

Savers can be configured globally as defaults or overridden per request via headers:
- `X-Token-Saver: off`: Disables all savers for the request.
- `X-Output-Saver: caveman,ponytail:lite`: Explicit output savers.
- `X-Input-Saver: standard`: Explicit input compression level.

## Combos

Combos define ordered fallback lists of models (1-20 entries) referenced as `combo:<name>`. When a client requests `model: "combo:<name>"`, the gateway attempts models strictly in the configured order.
- Maximum 50 combos per instance.
- Combo names are restricted to 1-48 characters matching `[a-z0-9\-_.]` and cannot start with `auto:` or `combo:`.
- If an entry is disabled or missing credentials, the router automatically fails over to the next candidate.

## Security Considerations

The X Gateway attack surface is mitigated according to the following threat matrix:

| Threat | Control |
| --- | --- |
| Non-admin uses the gateway | Permission checked on every request; 401/403; tests for anonymous, member, revoked key, demoted admin |
| Combo names used from `/v1` | Resolver answers only inside the gateway scope |
| Privilege escalation through the new permission | Existing delegation rule; group appears in the existing dialog |
| Large or slow anonymous bodies | Existing pre-parse guard extended to `/x/v1` |
| Abuse by a stolen admin key | Per-user rate limit, revocation (existing), kill switch, logging with the `x-gateway` tag |
| Instruction injection through savers | Fixed server-side text only; no user-supplied saver text in phase 1 |
| Key disclosure through the console | The console never receives or displays a key; the usage example uses a placeholder |
| CSRF on console APIs | Bearer-token session, no cookies |
| Cache staleness after permission change | Permission read from the key lookup on every request, not cached |
| Information leakage when off | 404 identical to an unknown path |
| Resource exhaustion by combos | Name length, 50 combos, 20 entries each |

## What it deliberately does not do

The X Gateway explicitly does **not**:
- Replace, duplicate, or alter `/v1/*`, `/livez`, `/readyz`, or `/api/ping`.
- Support OAuth subscription providers or web-session providers.
- Provide cloud synchronization or external compression proxies.
- Permit non-administrator access or anonymous invocation.
