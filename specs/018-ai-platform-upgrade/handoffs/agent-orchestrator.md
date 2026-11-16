# Stage 7 Handoff — Multi-Step, Multi-Agent Orchestrator (US7, `T115`–`T131`)

- **Integration Branch**: `codex/ai-platform-orchestrator`
- **Base Branch (`codex/ai-platform-prompts`)**: `2493b57e` (Stages 1–6 stacked cleanly on `origin/main` `f11c5d99`)
- **Frozen C0 Contract SHA**: `1e7681b5`
- **Integrated Worker Commits**:
  - `orch-foundation`: `c1de55a61c5dfb4fdbcb7e82de63ea5a492572d0` -> cherry-picked as `dc58fc67`
  - `orch-limits-trace`: `f80e033dff9a44de4ec398ea6321cd32ced1d816` -> cherry-picked as `870658ed`
  - `orch-engine-runtime`: `684b4125cf82bda0dac1bf427ef8122064456ae8` -> cherry-picked as `2bd0f49c`
  - `orch-ui`: `aae710f06b319152e8230313c99ae47b18a2c3c8` -> cherry-picked as `ae0140f3`
- **Owned Tasks**: `T115`–`T131` (17/17 marked `[x]` in `specs/018-ai-platform-upgrade/tasks.md`)
- **Overall Status**: **GREEN** on integrated `codex/ai-platform-orchestrator`

---

## 1. Delivered Files

### Shared Contracts & Spec Docs
- `shared/ai-platform-orchestrator.ts` (DTOs, `FLOW_LIMITS`, `DEFAULT_FLOW_LIMITS`, `FLOW_SLUG_REGEX`, `AGENT_SLUG_REGEX`)
- `specs/018-ai-platform-upgrade/handoffs/orchestrator-contracts.json`
- `specs/018-ai-platform-upgrade/tasks.md` (`T115`–`T131` checked off)
- `specs/018-ai-platform-upgrade/handoffs/agent-orchestrator.md` (this handoff)

### Migration, Reserved Prefix & Definitions (`orch-foundation`)
- `server/src/db/migrations/20261113_160000_custom_ai_orchestrator.ts` (`custom_ai_agents`, `custom_ai_flows`, `custom_ai_flow_grants`, `custom_ai_runs`, `custom_ai_run_steps`, 3 indexes, `trg_client_profiles_delete_orchestrator`, reversible `down()`)
- `server/src/db/migrate/defaults.ts`, `server/src/db/turso.ts`, `server/src/__tests__/db/migrate/roundtrip.test.ts`, `server/src/__tests__/db/turso-read-cache.test.ts`
- `server/src/custom/x-gateway/combos.ts` (`RESERVED_PREFIXES = ['auto:', 'combo:', 'flow:']`)
- `server/src/custom/ai-platform/orchestrator/definitions.ts` (Agent CRUD + 409 `in_use` guard, Flow CRUD/validation with hard ceilings `50/100/10/500_000/600`, `publishFlow` prompt/agent snapshots, `setFlowGrants`, `isFlowGrantedToProfile`, `listGrantedFlowsForProfile`)
- `server/src/__tests__/db/migrate/ai-platform-orchestrator.test.ts` (3/3 PASS)
- `server/src/__tests__/custom/ai-platform/flow-definitions.test.ts` (5/5 PASS)

### Limits & Execution Trace (`orch-limits-trace`)
- `server/src/custom/ai-platform/orchestrator/limits.ts` (`normalizeFlowLimits`, `LimiterSnapshot`, `FlowRunLimiter`: `max_steps`, `max_tool_calls`, `max_handoffs`, `max_tokens` post-step check, `max_seconds`, canonical `(toolName, args)` 3rd-repeat loop cut, `A -> B -> A -> B` ping-pong handoff cut)
- `server/src/custom/ai-platform/orchestrator/trace.ts` (`maskAndTruncateTrace` 8 KB UTF-8 safe masking, `createRunRecord`, `appendRunStep`, `updateRunProgress`, `pauseRunForApproval`, `markRunRunning`, `finishRunRecord`, `getRunRecord`, `getRunDetail` with `?after=`, `listRuns`, `pruneExpiredRuns`)
- `server/src/__tests__/custom/ai-platform/flow-limits.test.ts` (9/9 PASS)

### Engine, Approvals Resume, Public & Admin APIs (`orch-engine-runtime`)
- `server/src/custom/ai-platform/orchestrator/engine.ts` (`isFlowModel`, `extractRequestedModel`, `startRun`, `resumeRun`, `cancelRun`, `markInterruptedRuns`, `executeFlowHttpRequest`, per-agent tool/knowledge isolation, virtual `transfer_to_<slug>` handoffs, `quota_exhausted` stop on 429, SSE `: progress` comments, final output guard evaluation, disconnect & admin abort)
- `server/src/custom/ai-platform/orchestrator/approvals.ts` (enabled for `mcpClient || orchestrator`, invokes `resumeRun` on approve/reject, transitions expired approvals' runs to `stopped` / `expired`)
- `server/src/custom/ai-platform/orchestrator/runs-public.ts` & `server/src/custom/register.ts` (`GET /v1/ai/runs/:id`, startup `markInterruptedRuns()`, non-client-key `400 flow_requires_client_key` & `404 flow_not_found`)
- `server/src/custom/ai-platform/orchestrator/router.ts` & `server/src/custom/ai-platform/router.ts` (16 `/agents*`, `/flows*`, `/runs*` routes + `/overview` `orchestrator.ready = true`)
- `server/src/custom/ai-platform/pipeline.ts` & `server/src/middleware/profile-gate.ts` (Slot 4 `flow:<slug>` takeover, `403 flow_not_granted`, per-step quota/token attribution, `GET /v1/models` granted flow entries)
- `server/src/__tests__/custom/ai-platform/flow-engine.test.ts` (4/4 PASS)
- `server/src/__tests__/custom/ai-platform/flow-approvals.test.ts` (4/4 PASS)
- `server/src/__tests__/custom/ai-platform/flow-e2e.test.ts` (12/12 PASS)

### Client UI & i18n (`orch-ui`)
- `client/src/custom/ai-platform/flows-api.ts`
- `client/src/custom/ai-platform/flows-strings.ts`
- `client/src/custom/ai-platform/components/RunTrace.tsx`
- `client/src/custom/ai-platform/pages/Flows.tsx`
- `client/src/custom/ai-platform/pages/Runs.tsx`
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (replaced placeholder routes with `<Flows />` and `<Runs />` gated by `canFlows` / `canRuns`)
- `client/src/custom/ai-platform/flows.test.tsx` (11/11 PASS)
- `client/src/custom/i18n/vi.ts`

---

## 2. Verification Results on `codex/ai-platform-orchestrator`

- `npm run build` (`shared`, `server`, `cli`, `client`): **PASS** (exit 0)
- `npm run test:migrations`: **PASS** (`roundtrip.test.ts`: 1 file, 3/3 tests)
- Server Vitest suite (13 files, **181/181 tests PASS**):
  - `src/__tests__/db/migrate/ai-platform-orchestrator.test.ts`: 3/3
  - `src/__tests__/db/migrate/registry-drift.test.ts`: 2/2
  - `src/__tests__/db/turso-read-cache.test.ts`: 22/22
  - `src/__tests__/custom/ai-platform/flow-definitions.test.ts`: 5/5
  - `src/__tests__/custom/ai-platform/flow-limits.test.ts`: 9/9
  - `src/__tests__/custom/ai-platform/flow-engine.test.ts`: 4/4
  - `src/__tests__/custom/ai-platform/flow-approvals.test.ts`: 4/4
  - `src/__tests__/custom/ai-platform/flow-e2e.test.ts`: 12/12
  - `src/__tests__/custom/ai-platform/regression.test.ts`: 14/14
  - `src/__tests__/custom/ai-platform/pipeline.test.ts`: 4/4
  - `src/__tests__/custom/ai-platform/permissions.test.ts`: 85/85
  - `src/__tests__/custom/surface.test.ts`: 7/7
  - `src/__tests__/custom/x-gateway-foundation.test.ts`: 10/10
- Client Vitest suite (4 files, **37/37 tests PASS**):
  - `src/custom/ai-platform/flows.test.tsx`: 11/11
  - `src/custom/ai-platform/ai-platform.test.tsx`: 13/13
  - `src/custom/ai-platform/strings.test.ts`: 10/10
  - `src/custom/i18n/translations.test.ts`: 3/3
- `npm run check:i18n -w client`: **PASS** (60 locales, 1336 keys)
- `npm run lint` (`server` + `cli`) and `npx -w client eslint` on all touched client files: **PASS** (0 errors, 0 warnings)
