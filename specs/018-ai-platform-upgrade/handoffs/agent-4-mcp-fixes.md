# Agent 4 Fixes Handoff — MCP UI (F07, F08), Consolidated Review Probes & HTTP/Security Acceptance

- **Status**: `PARTIAL` (UI fixes **F07** + **F08 UI-result**, **F10** DNS deadline probe, **T041** 9-cell E2E + Gemini JSON-array stream, and **T053** permissions all **GREEN**; **F01/F03/F04/F05/F06/F08-journal/F09** server probes & `secret-leak.test.ts` remain **RED** awaiting Agent 2 executor/dispatch and Agent 3 runtime/approval commits)
- **Branch**: `codex/fix-mcp-ui`
- **Worktree**: `/tmp/wt-fix-mcp-ui`
- **Base SHA**: `d91b649d0a83d921ba4f15ffd0bd65412a21cc62`
- **Imported Peer Commits (cherry-picked cleanly)**:
  - Agent 1 `C1` (shared DTOs + contracts): `d97bfa7d63f3d9cd0caf6f52e9fcd8d6686bea17` → local `ce7b3ff4`
  - Agent 2 `F10` (DNS/execution deadline budget): `4c310ee5` → local `fe5109dd`
  - Agent 1 `C2` (sanitizer, approval-safety, migration, journal): `19281b03` → local `fb082b14`
- **Self Code Commit SHA**: `80fa468b764a91b29b8340263e94dd90ee8c6fb7`

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
- `server/src/__tests__/custom/ai-platform/mcp-review-probes.test.ts` (copied verbatim from `review-probes/mcp-review-probes.test.ts.txt`)
- `server/src/__tests__/custom/ai-platform/mcp-review-http.test.ts` (copied from `review-probes/mcp-review-http.test.ts.txt` + added F06 end-user isolation 403, quick-answer zero-provider, and single-KB-injection across MCP rounds)
- `specs/018-ai-platform-upgrade/handoffs/agent-4-mcp-fixes.md`

---

## 2. Finding → Test Mapping & Current Status

| Finding | Test File(s) | Baseline RED (`d91b649d`) | Current Status | Blocker (if not GREEN) |
| :--- | :--- | :--- | :--- | :--- |
| **F01** | `mcp-review-probes.test.ts`, `secret-leak.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `approvals.ts` + Agent 2 `executor.ts` sanitization integration with C2 |
| **F02** | `mcp-review-probes.test.ts`, `secret-leak.test.ts` | RED | **PARTIAL** | `registry.ts` C2 landed; `secret-leak.test.ts` backup test still catches `OPAQUE_CREDENTIAL` written to `custom_ai_approvals.args_masked` by unfixed `approvals.ts` (F01) |
| **F03** | `mcp-review-probes.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `approvals.ts` & Agent 2 `executor.ts` snapshot lock |
| **F04** | `mcp-review-probes.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `approvals.ts` & Agent 2 `executor.ts` effective scope guard |
| **F05** | `mcp-review-probes.test.ts`, `mcp-review-http.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `messages.ts` / `admission.ts` / `loopback.ts` |
| **F06** | `mcp-review-http.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `profile-gate.ts` / `pipeline.ts` |
| **F07** | `mcp-review-ui.test.tsx` | RED (`1 failed`) | **GREEN (`5/5` passed)** | Resolved in `ScopeToolBindings.tsx` |
| **F08** | `mcp-review-ui.test.tsx`, `mcp-review-probes.test.ts` | RED | **UI GREEN / Server BLOCKED** | `ApprovalQueue.tsx` UI GREEN; server `calls.ts`/`executor.ts`/`approvals.ts` awaiting Agent 2 & Agent 3 |
| **F09** | `mcp-review-probes.test.ts` | RED | **BLOCKED (RED)** | Awaiting Agent 3 `messages.ts` |
| **F10** | `mcp-review-probes.test.ts` (`includes DNS resolution in the transport deadline`) | RED (`353ms >= 200ms`) | **GREEN (`1 passed`)** | Resolved by Agent 2 `4c310ee5` |

---

## 3. Observed Verification Commands (After Final Code Edit)

| Command | Exit Code | Counts / Result |
| :--- | :---: | :--- |
| `npm exec -w client -- vitest run src/custom/ai-platform/mcp-review-ui.test.tsx src/custom/ai-platform/mcp.test.tsx` | `0` | `2` files passed, `13 passed (13)` tests |
| `npm run check:i18n -w client` | `0` | Passed (`60` locales, `1336` keys) |
| `npm exec -w client -- eslint src/custom/ai-platform/ src/custom/i18n/vi.ts` | `0` | Clean |
| `npm exec -w client -- tsc -b && npm run build -w client` | `0` | Clean (`vite build`, 3288 modules) |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/mcp-review-probes.test.ts -t "includes DNS resolution in the transport deadline"` | `0` | `1 passed \| 8 skipped (9)` (filtered run for F10 only) |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/mcp-e2e.test.ts src/__tests__/custom/ai-platform/mcp-permissions.test.ts` | `0` | `2` files passed, `18 passed (18)` tests (`mcp-e2e` 13/13 incl. Gemini JSON-array stream + DB accounting; `mcp-permissions` 5/5) |
| `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/secret-leak.test.ts` | `1` | `0 passed \| 2 failed` (F01 `approvals.ts` still persists `OPAQUE_CREDENTIAL` in `args_masked` until Agent 3 fix lands) |

---

## 4. Next Action Required

Once Agent 2 (`codex/fix-mcp-transport`) and Agent 3 (`codex/fix-mcp-runtime`) publish their remaining fix commits, Agent 4 will cherry-pick those explicit SHAs, re-run all 12+ reviewer probes, `secret-leak.test.ts`, `mcp-e2e.test.ts`, `regression.test.ts`, `npm run test`, `npm run build`, `npm run lint`, and `npm run test:migrations`, and update this handoff to `DONE`.
