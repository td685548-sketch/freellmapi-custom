# Data Model: Admin-only X Gateway

Created by one new migration, `YYYYMMDD_HHMMSS_custom_x_gateway.ts` (timestamped, idempotent, reversible). No existing migration is edited and no existing table is altered.

## Tables

### `x_gateway_config`

Key/value settings of the gateway, separate from the main `settings` table.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | text, primary key | `enabled`, `default_savers` |
| `value` | text, not null | `enabled`: `"0"` or `"1"` (absent means off); `default_savers`: JSON `{ caveman: boolean, ponytail: "off"|"lite"|"full"|"ultra", input: "off"|"lossless"|"standard" }` |
| `updated_at` | text | ISO time of last change |
| `updated_by` | integer, nullable | account that changed it |

Validation: `default_savers` is parsed with a strict schema on read and write; unknown keys are rejected on write and ignored on read; an unreadable value falls back to all savers off.

### `x_gateway_combos`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer, primary key | |
| `name` | text, unique, not null | stored lower-case; 1-48 characters of `a-z 0-9 - _ .`; must not equal an existing model id, `auto`, or start with `auto:`/`combo:` |
| `entries_json` | text, not null | ordered array of `{ platform: string, modelId: string }`, 1-20 items, no duplicates |
| `created_by` | integer, nullable | account |
| `created_at`, `updated_at` | text | |

Limits: at most 50 combos. Entries are references by `(platform, modelId)`, resolved against the live catalogue at request time, so a model that is later disabled or removed is skipped rather than breaking the combo. Entries are never validated against provider keys at save time.

### `x_gateway_usage_hourly`

Informational counters that the request log does not carry.

| Column | Type | Notes |
| --- | --- | --- |
| `hour` | text, primary key (with `user_id`) | `YYYY-MM-DD HH:00:00` UTC |
| `user_id` | integer, primary key (with `hour`) | |
| `requests` | integer | requests with at least one saver applied |
| `input_tokens_saved` | integer | estimated by the input saver |
| `output_savers_applied` | integer | requests that carried an output saver |

Written by one upsert per minute from an in-memory accumulator (no per-request write). Retained 90 days by the same pruning pass used for other hourly data, or by a bounded delete at flush time.

## Request log tagging (no schema change)

The existing `requests.caller` column is free-form text. Requests that run inside the gateway scope are written with `caller = 'x-gateway'`. The usage view reads request counts and tokens from there, and saved-token figures from `x_gateway_usage_hourly`.

## Permission group (not a table)

`manage_x_gateway` with leaves:

| Leaf | Allows |
| --- | --- |
| `use_x_gateway` | call `/thruline/v1/*` and open the console |
| `edit_x_combos` | create, edit, reorder, delete combos |
| `edit_x_settings` | switch the gateway on/off, change default savers |
| `view_x_usage` | read the usage view |

The parent implies all leaves; the primary administrator holds all implicitly.

## In-memory structures

| Structure | Lifetime | Purpose |
| --- | --- | --- |
| Config snapshot `{ enabled, savers, combos }` | invalidated on every console write; refreshed at most every 5 s | zero configuration queries per request in steady state |
| Usage accumulator `Map<hour+user, counters>` | flushed every 60 s and on graceful shutdown | one write per minute instead of one per request |
| Scope `{ gateway: 'x', combo?, savers }` | one request (`AsyncLocalStorage`) | combo resolution, log tag, per-request saver result |

## State transitions

- Gateway: `off` (default) → `on` → `off`. While off, requests answer 404 and the console shows the disabled state. In-flight responses finish.
- Combo: created → edited/reordered → deleted. Rename keeps the id; a request names the combo by its current name.
