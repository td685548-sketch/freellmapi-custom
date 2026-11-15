# Data Model: AI Support Output Controls (020)

**Date**: 2026-11-15
**Migration**: `server/src/db/migrations/20261115_120001_support_output_controls.ts`
**Store**: `server/src/custom/x-gateway/support-output-store.ts`

## Tables

### 1. `x_support_output_policies`

Stores the per-tenant encrypted output control policy with optimistic concurrency control (`version`).

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `tenant_id` | `INTEGER` | `PRIMARY KEY REFERENCES x_support_tenants(id) ON DELETE CASCADE` | One policy row per tenant |
| `version` | `INTEGER` | `NOT NULL DEFAULT 1` | Incremented atomically on each save (`expectedVersion` OCC) |
| `payload_encrypted` | `TEXT` | `NOT NULL` | AES-GCM ciphertext of JSON `{ mode, blockedTerms, maxOutputChars, redactCredentials }` |
| `payload_iv` | `TEXT` | `NOT NULL` | AES-GCM initialization vector |
| `payload_auth_tag` | `TEXT` | `NOT NULL` | AES-GCM authentication tag |
| `updated_at` | `TEXT` | `NOT NULL` | ISO-8601 UTC timestamp |

**Behavior**:
- Absent row for a valid existing tenant returns `DEFAULT_SUPPORT_OUTPUT_POLICY` with `tenantId`, `version: 0`, `mode: 'off'`, `updatedAt: '1970-01-01T00:00:00.000Z'`.
- First save requires `expectedVersion: 0` and inserts `version: 1`.
- Subsequent saves require matching `expectedVersion` and atomically update `version = expectedVersion + 1`; mismatch throws `SupportOutputError(409, 'output_policy_conflict', ...)`.
- Corrupt ciphertext, auth tag failure, invalid JSON, or schema validation failure on read throws `SupportOutputError(503, 'output_policy_unavailable', ...)` — never falls back to `off`.

### 2. `x_support_output_events`

Stores metadata-only audit events for non-`allow`, non-`off` output policy decisions.

| Column | Type | Constraints | Notes |
| :--- | :--- | :--- | :--- |
| `id` | `TEXT` | `PRIMARY KEY` | Opaque event ID (UUID / generated safe identifier) |
| `tenant_id` | `INTEGER` | `NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE` | Tenant scope |
| `operation_id` | `TEXT` | `NOT NULL` | Internal runtime turn ID or Copilot job ID |
| `surface` | `TEXT` | `NOT NULL CHECK(surface IN ('chat', 'copilot'))` | Execution surface |
| `policy_version` | `INTEGER` | `NOT NULL` | Policy version evaluated |
| `action` | `TEXT` | `NOT NULL CHECK(action IN ('observe', 'redact', 'block'))` | Never `'allow'` |
| `reasons_json` | `TEXT` | `NOT NULL` | JSON array of `SupportOutputReason` |
| `rule_ids_json` | `TEXT` | `NOT NULL` | JSON array of validated rule IDs (`[A-Za-z0-9_-]{1,64}`) |
| `redaction_count` | `INTEGER` | `NOT NULL DEFAULT 0` | Non-negative integer |
| `created_at` | `TEXT` | `NOT NULL` | ISO-8601 UTC timestamp |

**Constraints & Indexes**:
- `UNIQUE(tenant_id, surface, operation_id)` — repeated event insert (`INSERT OR IGNORE`) is a no-op (prevents duplicate counts on replay).
- `idx_x_support_output_events_tenant_created_id` on `(tenant_id, created_at DESC, id DESC)` — supports stable descending keyset pagination (`before` cursor) and 30-day / 10,000-row per-tenant retention pruning on writes.

**Privacy & Retention Rules**:
- Metadata-only: zero prompts, responses, `userId`, user names, snippets, matched text, raw args, raw errors, or reversible content digests.
- `appendSupportOutputEvent` is a no-op for `action === 'allow'` (and `off` decisions produce `'allow'`).
- On write (inside transaction), prune rows for `tenant_id` older than 30 days and cap at 10,000 newest rows for `tenant_id`.
- `listSupportOutputEvents` is strictly read-only (never cleans up).
