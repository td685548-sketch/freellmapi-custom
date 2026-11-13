# Contract: console API (`/api/thruline`)

Authenticated by the dashboard session (`Authorization: Bearer <session token>`), gated by the permission groups below through the existing permission-gate table. Anything not listed falls back to the parent permission `manage_x_gateway`. All responses are JSON; errors use `{ "error": { "message", "type" } }`.

| Method and path | Permission | Purpose |
| --- | --- | --- |
| `GET /api/thruline/status` | `use_x_gateway` | `{ enabled, baseUrl, defaults, combosCount, canEdit: { combos, settings }, example }`. `example` is a usage snippet with a placeholder key. |
| `PUT /api/thruline/enabled` | `edit_x_settings` | body `{ enabled: boolean }`; takes effect immediately in this process |
| `GET /api/thruline/defaults` | `use_x_gateway` | default savers |
| `PUT /api/thruline/defaults` | `edit_x_settings` | body `{ caveman, ponytail, input }` (strict schema) |
| `GET /api/thruline/combos` | `use_x_gateway` | list with each entry's availability (`available`, `reason`) |
| `POST /api/thruline/combos` | `edit_x_combos` | body `{ name, entries[] }`; 409 on duplicate name; 400 on invalid |
| `PUT /api/thruline/combos/:id` | `edit_x_combos` | rename and/or replace entries (order is the fallback order) |
| `DELETE /api/thruline/combos/:id` | `edit_x_combos` | delete |
| `GET /api/thruline/models` | `edit_x_combos` | catalogue entries the combo editor may pick from (platform, model id, display name, enabled) |
| `GET /api/thruline/usage?range=24h\|7d\|30d` | `view_x_usage` | `{ requests, tokensIn, tokensOut, inputTokensSaved, byCombo[], byModel[] }` |
| `POST /api/thruline/test` | `use_x_gateway` | body `{ model, messages, savers? }`; runs the request through the same edge pipeline as `/thruline/v1` on behalf of the signed-in administrator and returns `{ answer, servedBy, saversApplied, inputTokensSaved }`; never accepts or returns a key |

Rules:

- The console API works while the gateway is off (so it can be switched on); `test` answers 409 `gateway_disabled` in that case.
- A combo write invalidates the in-memory snapshot immediately.
- No endpoint returns a personal key, provider key or session token.
