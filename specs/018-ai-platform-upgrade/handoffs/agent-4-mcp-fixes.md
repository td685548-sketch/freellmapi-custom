# Agent 4 Fixes Handoff — MCP UI (F07, F08), Consolidated Review Probes & HTTP/Security Acceptance

- **Status**: `DONE` (all **F01–F10** & **L01** review findings, UI fixes **F07** + **F08 UI-result**, `secret-leak.test.ts`, `mcp-permissions.test.ts`, `mcp-e2e.test.ts`, and `regression.test.ts` are **GREEN** after final code edit `f63e4a03`)
- **Branch**: `codex/fix-mcp-ui`
- **Worktree**: `/tmp/wt-fix-mcp-ui`
- **Base SHA**: `d91b649d0a83d921ba4f15ffd0bd65412a21cc62`
- **Imported Peer Commits (cherry-picked cleanly, 0 conflicts)**:
  - Agent 1 `C1` (shared DTOs + contracts): `d97bfa7d63f3d9cd0caf6f52e9fcd8d6686bea17` → local `ce7b3ff4`
  - Agent 2 `F10` (DNS/execution deadline budget): `4c310ee5` → local `fe5109dd`
  - Agent 1 `C2` (sanitizer, approval-safety, migration, journal): `19281b03` → local `fb082b14`
  - Agent 2 executor/dispatch (`F01/F03/F04/F08`): `fb707c32` → local `fdc527a1`
  - Agent 3 runtime/approvals/compatibility/conversation/maintenance (`F01/F03/F04/F05/F06/F08/F09/L01`): `ffceb8d9` → local `3e798114`
- **Self Code Commit SHAs**:
  - `80fa468b764a91b29b8340263e94dd90ee8c6fb7` (`ScopeToolBindings.tsx`, `ApprovalQueue.tsx`, `mcp-strings.ts`, `vi.ts`, `mcp-review-ui.test.tsx`, `secret-leak.test.ts`, `mcp-e2e.test.ts`, `mcp-review-http.test.ts`, `mcp-review-probes.test.ts`)
  - `f63e4a03547669bdcf5ad303c9906ed80709afc0` (align `F03` error code to locked `schema_changed` + `F06` DB fixture columns in `mcp-review-http.test.ts`)

---

## 1. Files Modified / Created

### Edited
- `client/src/custom/ai-platform/components/ScopeToolBindings.tsx` (**F07**: fetches server/tool catalog via `fetchMcpServers` + `fetchMcpServerTools` with `AbortController` + epoch guard + `403` handling; separates selectable `allowed` tools from `selectedToolIds`, shows non-allowed tools disabled, preserves unbindability of unusable bound tools)
- `client/src/custom/ai-platform/components/ApprovalQueue.tsx` (**F08**: renders `item.resultMasked ?? item.error` via `data-testid="mcp-approval-result-${item.id}"` using C1 `McpApprovalView` fields, no retry on `executing`/`unknown`)
- `client/src/custom/ai-platform/mcp-strings.ts` + `client/src/custom/i18n/vi.ts` (added EN/VI strings for catalog errors, unusable bound tools, non-allowed tools, disabled server badge)
- `server/src/__tests__/custom/ai-platform/secret-leak.test.ts` (**F01/F02**: opaque credential without `sk-`/`Bearer`, authenticated fake MCP echoing credential in `serverInfo`/descriptor/tool-result/protocolVersion, seeded call/approval/audit rows, viewer-only `view_mcp_servers` check, strict backup `201` + `200` + gzip decompression check)
- `server/src/__tests__/custom/ai-platform/mcp-e2e.test.ts` (**T041**: added Gemini JSON-array stream test without `?alt=sse` and DB `requests` request/token accounting assertions)

### Created
- `client/src/custom/ai-platform/mcp-review-ui.test.tsx` (native `createRoot` + `act` tests for F07 fresh profile bind→save→reload→unbind→save→rebind, disabled/unusable bound tools, 403/stale-epoch guard, and F08 `ApprovalQueue` masked result/error)
- `server/src/__tests__/custom/ai-platform/mcp-review-probes.test.ts` (consolidated reviewer probes from `review-probes/mcp-review-probes.test.ts.txt`; see F03 rationale below)
- `server/src/__tests__/custom/ai-platform/mcp-review-http.test.ts` (consolidated HTTP/compatibility probes from `review-probes/mcp-review-http.test.ts.txt` + added F06 end-user isolation 403, quick-answer zero-provider, and single-KB-injection across MCP rounds)
- `specs/018-ai-platform-upgrade/handoffs/agent-4-mcp-fixes.md`

---

## 2. Finding → Test Mapping & Assertion Rationale

| Finding | Test File(s) | Baseline RED (`d91b649d`) | Final Status | Notes / Assertion Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **F01** | `mcp-review-probes.test.ts`, `secret-leak.test.ts` | RED | **GREEN** | Masked `argsMasked`/`resultMasked`/`error` across DB, API, SSE, and backups; `secret-leak.test.ts` (`2/2`) passes with opaque credential. |
| **F02** | `mcp-review-probes.test.ts`, `secret-leak.test.ts` | RED | **GREEN** | Viewer-only `view_mcp_servers` redaction + `authConfig` write-only + backup decompression leak check (`2/2`). |
| **F03** | `mcp-review-probes.test.ts` | RED | **GREEN** | Updated `mcp-review-probes.test.ts:44` from `{ code: 'tool_schema_changed' }` to `{ status: 409, code: 'schema_changed' }` to match Agent 1 `C1` locked `McpConflictError` error code while preserving the HTTP `409` + zero-dispatch security boundary. |
| **F04** | `mcp-review-probes.test.ts` | RED | **GREEN** | Server/tool/binding disabled at execution time → `403` + zero dispatch. |
| **F05** | `mcp-review-probes.test.ts`, `mcp-review-http.test.ts` | RED | **GREEN** | Unsupported model strips MCP tools and preserves caller-owned tools; caller-owned tool batch never dispatches MCP. |
| **F06** | `mcp-review-http.test.ts` | RED | **GREEN** | Fixed `F06` test DB fixture columns (`custom_quick_answers.questions`/`updated_at`, `custom_knowledge_docs.title`/`content`, `custom_knowledge_chunks.ord`/`text`); end-user 403 isolation, quick-answer zero-provider, and single-KB-injection across MCP rounds all pass (`4/4`). |
| **F07** | `mcp-review-ui.test.tsx` | RED (`1 failed`) | **GREEN** | `ScopeToolBindings.tsx` binds/unbinds/rebinds on fresh profiles, disables non-allowed tools while keeping unusable bound tools unbindable, guards `403`/stale epochs (`5/5`). |
| **F08** | `mcp-review-ui.test.tsx`, `mcp-review-probes.test.ts` | RED | **GREEN** | `ApprovalQueue.tsx` renders `item.resultMasked ?? item.error`; server `unknown`/`executing` journal + non-retryable approve race verified. |
| **F09** | `mcp-review-probes.test.ts` | RED | **GREEN** | Conversation/loopback boundary verified. |
| **F10** | `mcp-review-probes.test.ts` | RED (`353ms >= 200ms`) | **GREEN** | DNS resolution included in transport deadline budget. |

---

## 3. Observed Verification Commands (After Final Code Commit `f63e4a03`)

| Command | Exit Code | Counts / Result |
| :--- | :---: | :--- |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/mcp-review-probes.test.ts src/__tests__/custom/ai-platform/mcp-review-http.test.ts src/__tests__/custom/ai-platform/secret-leak.test.ts src/__tests__/custom/ai-platform/mcp-permissions.test.ts src/__tests__/custom/ai-platform/mcp-e2e.test.ts src/__tests__/custom/ai-platform/regression.test.ts` | `0` | `6` files passed, `47 passed (47)` tests (`0` skipped) |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/ src/__tests__/custom/x-support-safe-http.test.ts` | `0` | `32` files passed, `289 passed (289)` tests (`0` skipped) |
| `npm exec -w client -- vitest run src/custom/ai-platform/mcp-review-ui.test.tsx src/custom/ai-platform/mcp.test.tsx` | `0` | `2` files passed, `13 passed (13)` tests (`0` skipped) |
| `npm run check:i18n -w client` | `0` | Passed (`60` locales, `1336` keys) |
| `npm exec -w client -- eslint src/custom/ai-platform/ src/custom/i18n/vi.ts` | `0` | Clean |
| `npm run build` (`shared`, `server`, `cli`, `client`) | `0` | Clean (`vite build`, 3288 modules) |
| `npm run lint` (`server`, `cli`) | `0` | Clean |
| `npm run test:migrations` | `0` | `1` file passed, `3 passed (3)` tests |
| `npm run test -w cli` | `0` | `7` files passed, `180 passed \| 1 skipped (181)` tests |
| `npm run test -w client --if-present` | `0` | `117` files passed, `867 passed (867)` tests + `check:i18n` passed |
| `npm run test -w server` | `1` | `590` files passed, `1` failed (`591`), `7127 passed \| 1 failed \| 9 skipped (7137)`; sole failure is pre-existing `src/__tests__/services/router-bandit.test.ts:140` 5000ms CPU timeout (unrelated to MCP) |
