# Contract: X gateway (`/x/v1`)

Base path: `/x/v1`. Wire format: OpenAI chat completions, same request and response shapes, streaming and non-streaming, as the main gateway's `/v1/chat/completions`.

## Authentication

`Authorization: Bearer <personal key>` (also `x-api-key`), the administrator's own `sk-flm-…` key. The account must hold `use_x_gateway` (the primary administrator always does). The permission is read on every request.

| Situation | Status | `error.type` |
| --- | --- | --- |
| Gateway switched off | 404 | `not_found` (same body as an unknown path) |
| No key, unknown key, revoked key | 401 | `authentication_error` |
| Valid key, account lacks `use_x_gateway` | 403 | `permission_error` |
| Per-minute limit exceeded | 429 | `rate_limit_exceeded` |
| Body over the unauthenticated limit without a valid key | 413 (public) or 401 | existing guard |

## `POST /x/v1/chat/completions`

Body: as the main gateway, plus two model forms:

- `"model": "combo:<name>"`: use the named combo (ordered fallback).
- any other value (`auto`, `auto:<profile>`, a catalogue id): handled exactly as on `/v1`.

Request headers (all optional):

| Header | Values | Effect |
| --- | --- | --- |
| `X-Token-Saver` | `off` | disables every saver for this request, overriding defaults |
| `X-Output-Saver` | comma list of `caveman`, `ponytail`, `ponytail:lite`, `ponytail:full`, `ponytail:ultra` | adds the instruction block(s); `ponytail` means `full`; overrides the default |
| `X-Input-Saver` | `off`, `lossless`, `standard` | tool-output compression for this request; overrides the default |

An unknown value in any of these headers is rejected with 400, `invalid_request_error`, and a message listing the valid values. Nothing is sent to a provider.

Response headers added (in addition to the main flow's):

| Header | Meaning |
| --- | --- |
| `X-Gateway: x` | the request went through the X gateway |
| `X-Combo` | combo name when one was used |
| `X-Output-Saver-Applied` | savers actually applied (empty if none) |
| `X-Input-Tokens-Saved` | estimated input tokens removed by the input saver (`0` if none) |

Combo errors: unknown combo → 400 `invalid_request_error`, code `combo_not_found`, no provider called; every entry unavailable → 503 with code `combo_exhausted`.

Saver guarantees: at most one added system message, placed first; no existing message is altered, dropped or reordered; on any saver failure or when the result would not be shorter, the original content is used and the request proceeds.

## `GET /x/v1/models`

Same authentication. Returns the main flow's model list for the administrator, with each combo added as `{ "id": "combo:<name>", "object": "model", "owned_by": "x-gateway" }` at the start.

## Any other path under `/x/v1`

JSON 404 in the same shape as an unknown path (never the single-page-app HTML).

## Guarantees

- `/v1/*`, `/livez`, `/readyz`, `/api/ping` and the dashboard behave exactly as before.
- No provider key, personal key or prompt content is written to logs beyond what the main flow already writes.
