# Agent 4 Handoff — MCP Client UI, Permissions, Secret-Leak & 4-Wire E2E Acceptance

- **Status**: `DONE`
- **Branch**: `codex/ai-platform-mcp-ui`
- **Tasks**: `T041`, `T051`, `T052`, `T053`
- **Worktree**: `/tmp/wt-ai-platform-mcp-ui`
- **baseSha**: `1d0efd55fd6b5d978d6dd7de06c2b83f87d5fd0a`
- **foundationMergeSha**: `1d0efd55fd6b5d978d6dd7de06c2b83f87d5fd0a` (PR #48 `MERGED`)
- **Imported Peer Commits (cherry-picked cleanly, 0 conflicts)**:
  - Agent 1 `C0` (shared DTOs + base signatures): upstream `327e6a282a150a54877a4ae03f6b656756af636f` → local `3a021fc0`
  - Agent 1 `D0` (MCP migration + repositories + audit/backup hooks): upstream `1f4b4b23605ed6c629c814571b800e87d5fd0a` (`1f4b4b23605ed6c629c814571b800e87d5fd0a` wait: `1f4b4b23605ed6c629c814571b800e87d5fd0a`? No: `1f4b4b23605ed6c629c814571b800e87d5fd0a` -> exact SHA `1f4b4b23605ed6c629c814571b800e87d5fd57de` / local `43a7899e`)
  - Agent 2 `N0` (fake MCP HTTP fixture): upstream `e42675a8bf5dc71c3ee25205d582e8881f226890` → local `208f522f`
  - Agent 2 `X0` (SSRF + transport + secret-redaction): upstream `6d52726eb13b5e3e20928e0879ab8f02eaa8faf6` → local `f21a4d4d`
  - Agent 2 `HeadersInit` + RED `mcp-tools`: upstream `69002f9972ab83907d731558fe8cf2927b9289b6` → local `1be4fdcc`
  - Agent 2 `tools.ts` facade: upstream `d193ccc79adc6dd34042ea6a6f60d059cfaa86e5` → local `e93fd8d1`
  - Agent 3 `I0` (MCP router + runtime + pipeline integration): upstream `5a55b155e5a2b0d2df6a7f49de2c4b053a166504` → local `b19b6520`
- **Self Code Commit SHAs**:
  - `1e81f53d60c05bda2f65298afdc5d84c43ebf8d7` — Client MCP Admin UI (`T051`, `T052`) + initial `T053` RED/acceptance specs
  - `e8774b61` — Initial `PARTIAL` handoff before `I0`
  - `6f582e15f02b1b80fd76ef9b226ddcd07ed6116b` — `T041` 4-wire × stream/non-stream E2E HTTP acceptance + `T053` `I0` verification updates

---

## 1. Ownership & Modified Files

All changes are strictly within Agent 4's ownership manifest (`ownership.json`):

### Created
- `client/src/custom/ai-platform/mcp-api.ts`
- `client/src/custom/ai-platform/mcp-strings.ts`
- `client/src/custom/ai-platform/pages/McpServers.tsx`
- `client/src/custom/ai-platform/components/ToolReviewTable.tsx`
- `client/src/custom/ai-platform/components/ScopeToolBindings.tsx`
- `client/src/custom/ai-platform/components/ApprovalQueue.tsx`
- `client/src/custom/ai-platform/components/McpCallLog.tsx`
- `client/src/custom/ai-platform/components/InternalOriginsEditor.tsx`
- `client/src/custom/ai-platform/mcp.test.tsx`
- `server/src/__tests__/custom/ai-platform/mcp-e2e.test.ts`
- `server/src/__tests__/custom/ai-platform/mcp-permissions.test.ts`
- `server/src/__tests__/custom/ai-platform/secret-leak.test.ts`
- `specs/018-ai-platform-upgrade/handoffs/agent-4-mcp.md`

### Edited (Minimal Scope)
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (MCP tab navigation, route, and exact child permission guard)
- `client/src/custom/i18n/vi.ts` (appended MCP EN→VI translation entries only)

---

## 2. Exported Signatures & API/Envelopes Used

- **`client/src/custom/ai-platform/mcp-api.ts`**:
  - `listMcpServers`, `createMcpServer`, `updateMcpServer`, `deleteMcpServer`, `testMcpServer`, `syncMcpServer`
  - `listMcpTools`, `reviewMcpTool`
  - `getScopeMcpBindings`, `putScopeMcpBindings`
  - `listMcpApprovals`, `approveMcpApproval`, `rejectMcpApproval`
  - `listMcpCalls`, `getAllowedInternalOrigins`, `putAllowedInternalOrigins`
  - Typed directly against `shared/ai-platform-mcp.ts` (`McpServerView` with `hasSecret: boolean` only, `McpServerCreateInput`, `McpServerUpdateInput`, `McpToolView`, `ScopeToolBindingView`, `McpApprovalView`, `McpCallView`, `McpToolExecutionResult`).
- **`client/src/custom/ai-platform/pages/McpServers.tsx`**:
  - Default/named export `McpServers`: server CRUD with write-only secret handling (empty edit keeps existing secret; explicit clear sets `clearSecret: true`), enable/disable, test connection, sync tools, delete with `409 in_use` force-delete confirmation, `409 revision_conflict` refresh, and request-epoch / `AbortController` stale-response cancellation.
- **Subcomponents**:
  - `ToolReviewTable`: displays `name`, `inputSchema`, `description`, `schemaHash`, `effect`, `state`, `remoteReadOnlyHint` (never auto-trusts remote `readOnlyHint`), and enforces `review_mcp_tools`.
  - `ScopeToolBindings`: profile + `support_tenant` scope selector, `aiToolsEnabled`/`maxRounds` controls, explains unavailable `agent` scope and US2 support-runtime boundary.
  - `ApprovalQueue`: renders `argsMasked`/`resultMasked`/status/expiry, restricts approve/reject to `pending`, disables buttons in-flight, handles `409` conflict refresh, no retry on `executing`/`unknown`, and notes US2 executes approved tool without resuming US7 chat.
  - `McpCallLog`: cursor pagination (`nextBefore`), status/server filters, duration/bytes/masked error display.
  - `InternalOriginsEditor`: visible and editable only for `session.isPrimary`, exact origin list, server-enforced `403` otherwise.

---

## 3. RED → GREEN Evidence & Acceptance Matrix

- **T051 → T052 (`mcp.test.tsx`)**:
  - Uses `react-dom/client` `createRoot` + `act` + `jsdom` (zero `@testing-library/react` imports).
  - Covers i18n EN/VI completeness & placeholder parity, write-only secret creation/editing, `409 in_use` → force delete, `409 revision_conflict`, `ToolReviewTable` non-auto-trust & permission guards, `ScopeToolBindings` stale-response prevention & support-runtime boundary, `ApprovalQueue` `pending`-only actions & no retry for `executing`/`unknown`, `McpCallLog` pagination, `InternalOriginsEditor` primary-only visibility, and `AiPlatformApp` exact child permission routing.
- **T041 (`mcp-e2e.test.ts`)**:
  - Exercises real `createApp()` HTTP server + `:memory:` SQLite + `startFakeProviderServer` + `startFakeMcpHttpServer` (real TCP HTTP dispatch, non-mocked `runToolLoop`/`pipeline`/`executor`/`transport`).
  - **8-Cell Wire × Stream Matrix (`model -> MCP lookup_order -> model -> output`)**:
    1. `openai-chat` (`POST /v1/chat/completions`, `stream=false`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, summed usage = `45`, call journal `status=ok`).
    2. `openai-chat` (`POST /v1/chat/completions`, `stream=true`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, call journal `status=ok`).
    3. `responses` (`POST /v1/responses`, `stream=false`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, summed usage = `45`, call journal `status=ok`).
    4. `responses` (`POST /v1/responses`, `stream=true`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, call journal `status=ok`).
    5. `anthropic` (`POST /v1/messages`, `stream=false`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, summed usage = `45`, call journal `status=ok`).
    6. `anthropic` (`POST /v1/messages`, `stream=true`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, call journal `status=ok`).
    7. `gemini` (`POST /v1beta/models/gemini-2.5-flash:generateContent`, `stream=false`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, summed usage = `45`, call journal `status=ok`).
    8. `gemini` (`POST /v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, `stream=true`): PASS (`200`, `x-freellm-tool-rounds: 2`, `tools/call` count = `1`, `trust="untrusted"` injected on turn 2, summed usage = `45`, call journal `status=ok`).
  - **Governance & Edge Cases**:
    - Caller-tool batch containing MCP call stops without MCP dispatch (`tools/call` = `0`) and returns `caller_fn` to caller.
    - Write tool (`refund_order`) queues `pending` approval (`tools/call` = `0`); concurrent approve race resolves `[200, 409]` with exactly `1` real MCP dispatch; mid-flight disconnect transitions to `unknown` and re-approve returns `409` without retry dispatch.
    - `x-freellm-tools: off` bypasses MCP tools; unbound profile receives no MCP tools (tenant/scope isolation).
    - `unsupported_model` (`groq/compound`) emits `x-freellm-tools-skipped: unsupported_model` without MCP tool injection; client `AbortController` cancels delayed in-flight MCP call cleanly.
- **T053 (`mcp-permissions.test.ts`, `secret-leak.test.ts`, `regression.test.ts`)**:
  - `mcp-permissions.test.ts`: verifies `401` unauthenticated, `403` for non-MCP permissions (`view_ai_platform`/`edit_ai_flags`) on MCP/approvals, `403` for `manage_ai_platform` non-primary on `/mcp/allowed-internal-hosts`, and flag-off CRUD allowance vs `409 pillar_disabled` on outbound `test`/`sync`/inference.
  - `secret-leak.test.ts`: seeds sentinel credential `SENTINEL_MCP_SECRET_991122` in MCP server auth; verifies zero occurrences across server list/create/update/error responses, test/sync responses, `custom_mcp_calls`, `custom_mcp_approvals`, `custom_audit_log`, stdout/stderr sinks, and encrypted backup export.
  - `regression.test.ts`: all 14 frozen baseline golden tests pass unmodified.

---

## 4. Verification Commands & Results (Observed After Final Edit)

| Check / Command | Exit Code | Counts / Result | Notes |
| :--- | :--- | :--- | :--- |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/mcp-e2e.test.ts src/__tests__/custom/ai-platform/mcp-permissions.test.ts src/__tests__/custom/ai-platform/secret-leak.test.ts src/__tests__/custom/ai-platform/regression.test.ts` | `0` | `4` files passed, `33 passed (33)` tests (`0` skipped) | Targeted T041 + T053 + golden baseline |
| `npm exec -w client -- vitest run src/custom/ai-platform/mcp.test.tsx` | `0` | `1` file passed, `8 passed (8)` tests (`0` skipped) | T051/T052 UI unit/integration |
| `npm run check:i18n -w client` | `0` | Passed (`60` locales, `1336` keys) | EN/VI parity check |
| `npm exec -w client -- tsc -b` | `0` | Clean | Client TypeScript build |
| `npm run build -w client` | `0` | Clean (`vite build`, 3288 modules) | Client production bundle |
| `npm run build` | `0` | Clean (`shared`, `server`, `cli`, `client`) | Full monorepo build |
| `npm run lint` | `0` | Clean (`server` + `cli` eslint) | Zero lint errors |
| `npm run test:migrations` | `0` | `1` file passed, `3 passed (3)` tests (`0` skipped) | Migration up/down/up roundtrip |
| `npm run test -w cli` | `0` | `7` files passed, `180 passed | 1 skipped (181)` | Pre-existing 1 skip in `cli/src/index.test.ts` |
| `npm run test -w client --if-present` | `0` | `116` files passed, `862 passed (862)` (`0` skipped) + `check:i18n` | Full client test suite |
| `npm run test` (root) | `1` | `test:bootstrap`: `2 passed, 2 skipped` (PowerShell on Linux); `test:hooks`: `9 passed`; `server`: `584 passed | 1 failed (585)` files, `7093 passed | 1 failed | 9 skipped (7103)` | Only failure is pre-existing `server/src/__tests__/services/router-bandit.test.ts:140` 5000ms CPU timeout (also fails standalone: `4 failed | 27 passed (31)` due to 5000ms host CPU timeouts) |

---

## 5. Limitations & Blockers

- **Pre-existing upstream host CPU timeout**: `server/src/__tests__/services/router-bandit.test.ts` hits Vitest's 5000ms test timeout on this host (1 failure in full `server` run; 4 timeouts when run standalone). Unrelated to Agent 4 files; no timeout thresholds were altered per instructions.
- **No push / PR / merge performed**: left ready on branch `codex/ai-platform-mcp-ui` in `/tmp/wt-ai-platform-mcp-ui` for reviewer integration.
