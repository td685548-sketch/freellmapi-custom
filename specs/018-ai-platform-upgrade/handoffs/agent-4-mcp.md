# Agent 4 Handoff — MCP Client UI, Permissions, Secret-Leak & Acceptance (US2)

- **Role**: UI và acceptance: quản trị MCP, approvals, bốn giao thức (`T041`, `T051`, `T052`, `T053`)
- **Branch**: `codex/ai-platform-mcp-ui`
- **Worktree**: `/tmp/wt-ai-platform-mcp-ui`
- **Status**: `PARTIAL` (T051 & T052 client UI/i18n/tests and T053 golden `regression.test.ts` are complete and GREEN; T053 `mcp-permissions.test.ts` and `secret-leak.test.ts` are written and verified in RED state with `404` on `/api/ai-platform/mcp/*` awaiting Agent 3's **I0** router; T041 `mcp-e2e.test.ts` is **BLOCKED** on Agent 3's **I0** `tool-loop.ts` / `pipeline.ts` / `router.ts`).

## Commit Lineage & SHAs

- **PR #48 (`MERGED`)**: `https://github.com/td685548-sketch/freellmapi-custom/pull/48`
- **`foundationMergeSha`**: `1d0efd55fd6b5d978d6dd7de06c2b83f87d5fd0a`
- **`baseSha`** (`origin/main`): `1d0efd55fd6b5d978d6dd7de06c2b83f87d5fd0a`
- **Imported peer commits**:
  - **C0 (Agent 1)**: `327e6a282a150a54877a4ae03f6b656756af636f` (cherry-picked as `3a021fc0...` on `codex/ai-platform-mcp-ui`)
- **Self code commit SHA**: `1e81f53d60c05bda2f65298afdc5d84c43ebf8d7`

## Files Created / Edited

### Created
- `client/src/custom/ai-platform/mcp-api.ts`
- `client/src/custom/ai-platform/mcp-strings.ts`
- `client/src/custom/ai-platform/pages/McpServers.tsx`
- `client/src/custom/ai-platform/components/ToolReviewTable.tsx`
- `client/src/custom/ai-platform/components/ApprovalQueue.tsx`
- `client/src/custom/ai-platform/components/ScopeToolBindings.tsx`
- `client/src/custom/ai-platform/components/McpCallLog.tsx`
- `client/src/custom/ai-platform/components/InternalOriginsEditor.tsx`
- `client/src/custom/ai-platform/mcp.test.tsx`
- `server/src/__tests__/custom/ai-platform/mcp-permissions.test.ts`
- `server/src/__tests__/custom/ai-platform/secret-leak.test.ts`
- `specs/018-ai-platform-upgrade/handoffs/agent-4-mcp.md` (this handoff)

### Edited
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (permission-gated `mcp` nav item & `<Route path="mcp" element={<McpServers />} />`)
- `client/src/custom/i18n/vi.ts` (appended MCP EN→VI translations)

### Not Yet Created (Blocked on I0)
- `server/src/__tests__/custom/ai-platform/mcp-e2e.test.ts` (requires Agent 2 **N0** `ai-platform-fake-mcp-http.ts` + Agent 3 **I0** `router.ts` / `tool-loop.ts` / `pipeline.ts`)

## Exported Signatures & API Envelopes

- `client/src/custom/ai-platform/mcp-api.ts`:
  - Re-exports shared DTOs from `shared/ai-platform-mcp.ts` (no duplicate schemas)
  - `scopeToPath(scope: Scope): string` (`support_tenant` → `support-tenant/<id>`)
  - `mcpServersKey`, `mcpServerToolsKey`, `mcpBindingsKey`, `mcpApprovalsKey`, `mcpCallsKey`, `mcpAllowedOriginsKey`
  - `fetchMcpServers`, `createMcpServer`, `updateMcpServer`, `deleteMcpServer`, `testMcpServer`, `syncMcpServer`
  - `fetchMcpServerTools`, `reviewMcpTool`
  - `fetchMcpBindings`, `putMcpBindings`, `fetchProfileOptions`, `fetchSupportTenantOptions`
  - `fetchMcpApprovals`, `approveMcpAction`, `rejectMcpAction`
  - `fetchMcpCalls`, `fetchAllowedInternalOrigins`, `putAllowedInternalOrigins`
- Components / Pages:
  - `McpServers` (`pages/McpServers.tsx`)
  - `ToolReviewTable` (`components/ToolReviewTable.tsx`)
  - `ScopeToolBindings` (`components/ScopeToolBindings.tsx`)
  - `ApprovalQueue` (`components/ApprovalQueue.tsx`)
  - `McpCallLog` (`components/McpCallLog.tsx`)
  - `InternalOriginsEditor` (`components/InternalOriginsEditor.tsx`)

## RED → GREEN Evidence & Checks

1. **T051 UI RED → GREEN (`mcp.test.tsx`)**:
   - **RED**: `npm exec -w client -- vitest run src/custom/ai-platform/mcp.test.tsx` → exit `1` (`Failed to resolve import "./pages/McpServers"`).
   - **GREEN**: `npm exec -w client -- vitest run src/custom/ai-platform/mcp.test.tsx src/custom/ai-platform/ai-platform.test.tsx src/custom/ai-platform/navigation.test.tsx src/custom/ai-platform/strings.test.ts` → exit `0` (`4 passed (4)` files, `36 passed (36)` tests, `0` skipped).
2. **Client Lint, i18n, Typecheck & Build**:
   - `npm exec -w client -- eslint src/custom/ai-platform/ src/custom/i18n/vi.ts` → exit `0` (verified after final edit).
   - `npm run check:i18n -w client` → exit `0` (`60 locales and 1336 keys`).
   - `npm exec -w client -- tsc -b` → exit `0`.
   - `npm run build -w client` → exit `0` (`vite build` `3288 modules transformed`).
3. **Server Typecheck, Lint, Migrations & Golden Regression**:
   - `npm exec -w server -- tsc --noEmit` → exit `0`.
   - `npm run lint` (`server`, `cli`) → exit `0`.
   - `npm run test:migrations` → exit `0` (`1 passed (1)` file, `3 passed (3)` tests, `0` skipped).
   - `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/regression.test.ts` → exit `0` (`1 passed (1)` file, `14 passed (14)` tests, `0` skipped).
4. **T053 Server RED (Awaiting I0)**:
   - `npm exec -w server -- vitest run src/__tests__/custom/ai-platform/mcp-permissions.test.ts src/__tests__/custom/ai-platform/secret-leak.test.ts` → exit `1` (`2 passed, 5 failed` — all 5 failures are `404` on `/api/ai-platform/mcp/*` because Agent 3's **I0** router is not yet integrated; `401` unauthenticated and `/api/backups` `403` authorization checks passed).
5. **T041 HTTP E2E (`mcp-e2e.test.ts`)**:
   - **NOT RUN / BLOCKED** on Agent 3 **I0** (`router.ts`, `tool-loop.ts`, `pipeline.ts`). Note: Agent 2 **N0** (`e42675a8`) and **X0** (`6d52726e`) landed on `codex/ai-platform-mcp-transport`, but **I0** is not yet present on `codex/ai-platform-mcp-runtime`.

## Limitations & Blockers

- **Blocker**: Agent 3 **I0** (`router.ts`, `tool-loop.ts`, `pipeline.ts`, `approvals.ts`) is required to rerun `mcp-permissions.test.ts` and `secret-leak.test.ts` to GREEN and to implement and run the 8-cell (`4 wires × stream/non-stream`) `mcp-e2e.test.ts` against `createApp` + `ai-platform-fake-mcp-http.ts`.
- **US2 Scope Boundaries**:
  - `ScopeToolBindings` explicitly notes that `agent` scopes are unavailable until Orchestrator (US7) is installed and that MCP execution in support runtime is not enabled in this release.
  - `ApprovalQueue` explicitly notes that US2 executes approved tools once and records the masked result without US7 automatic chat resume.
  - `InternalOriginsEditor` is gated to `isPrimary` only; non-primary users never trigger `GET /mcp/allowed-internal-hosts`.
