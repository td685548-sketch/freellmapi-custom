# Agent 4 Handoff — Output Guard UI, Acceptance, RBAC, Secret-Leak & Benchmark

- **Branch**: `codex/ai-platform-output-guard-ui`
- **Base SHA**: `92a4f520cd01cc33f403d5f1bbd30ec98a6d569d` (verified ancestor: PR52 MCP merge `d1e0a03badea3c19fc60200a13155a1eb420b12e`)
- **C0 Contract SHA**: `3abe64b6fcef0586fb3424d51e895a2beb0ec92b` (from Agent 1 C0 `a2e8aa933f3a585445def0d44b08106677d9f5a0`)
- **Imported Prerequisites** (cherry-picked cleanly):
  - `be11bcfe` (Agent 3 S0 `5860591e`)
  - `53b807e8` (Agent 1 migration/store/events/router `9ca92dd2`)
  - `ee6eab98` (Agent 2 D0 `a0517018`)
  - `2664b9a3` (Agent 1 policy/stream wiring `bc48dc8a`)
  - `2688e33f` (Agent 3 `policy.ts` runtime wiring `3442f0e8`)
  - `70edff67` (Agent 1 RBAC `manage_ai_platform` fix `b138c959`)
  - `a1ecfd50` (Agent 1 `guard_log` / multi-candidate fix `a4b7a97e`)
  - `bbd8792f` (Agent 3 `mode: 'log'` & Gemini JSON-array stream fix `3ddb4a1f`)
- **Code Commit SHAs**: `cdc5ae1cf1153bc9a11d985e3e425c651eadda66`, `8dd41052e816fdf943cbd85813d063523977e622`, `31c8e595c2fd5933bc0804322077ac4122daccec`
- **Owned Tasks**: `T059`, `T069`, `T070`, `T071`
- **Overall Status**:
  - `T069` / `T070` (UI, RBAC, i18n, `output-guard.test.tsx`, `check:i18n`, ESLint, build): **GREEN**
  - `T059` (`guard-e2e.test.ts` 17/17, `guard-permissions.test.ts` 5/5, `guard-secret-leak.test.ts` 1/1): **GREEN**
  - `T071` (`guard-bench.test.ts` 2/2, `regression.test.ts` 14/14): **GREEN**

---

## 1. Actual File List

### Created
- `client/src/custom/ai-platform/output-guard-api.ts`
- `client/src/custom/ai-platform/output-guard-strings.ts`
- `client/src/custom/ai-platform/pages/OutputGuard.tsx`
- `client/src/custom/ai-platform/components/GuardPolicyEditor.tsx`
- `client/src/custom/ai-platform/components/PolicyTester.tsx`
- `client/src/custom/ai-platform/components/GuardEvents.tsx`
- `client/src/custom/ai-platform/output-guard.test.tsx`
- `server/src/__tests__/custom/ai-platform/guard-e2e.test.ts`
- `server/src/__tests__/custom/ai-platform/guard-bench.test.ts`
- `server/src/__tests__/custom/ai-platform/guard-permissions.test.ts`
- `server/src/__tests__/custom/ai-platform/guard-secret-leak.test.ts`
- `server/src/__tests__/fixtures/ai-platform-output-guard/guard-eval.json`
- `specs/018-ai-platform-upgrade/handoffs/agent-4-output-guard.md` (this handoff)

### Edited
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (replaced placeholder `output-guard` route with `<OutputGuard />`, added `canOutputGuard` child-permission check without requiring `canOverview` or `canMcp`, preserved MCP routes/permissions)
- `client/src/custom/i18n/vi.ts` (appended Vietnamese translations for all new `output-guard-strings.ts` constants)

---

## 2. Exports & API Envelopes

### Client Exports
- `client/src/custom/ai-platform/output-guard-api.ts`:
  - Re-exports C0 shared DTOs/constants from `shared/ai-platform-output-guard.ts` (`GuardPolicyInput`, `GuardPolicyView`, `GuardEventView`, `GuardEventsListResponse`, `GuardEventExcerptResponse`, `GuardTestRequest`, `GuardTestResponse`, `DEFAULT_GUARD_DETECTORS`, `DEFAULT_GUARD_POLICY_BASE`, `OUTPUT_GUARD_LIMITS`, etc.).
  - Exports `createDefaultGuardDetectors`, `createDefaultGuardPolicy`, `scopeToPath`, `guardPolicyKey`, `guardEventsKey`, `fetchGuardPolicy`, `putGuardPolicy`, `testGuardPolicy`, `fetchGuardEvents`, `fetchGuardEventExcerpt`, `fetchGuardProfileOptions`, `fetchGuardSupportTenantOptions`.
- `client/src/custom/ai-platform/pages/OutputGuard.tsx`: `OutputGuard`
- `client/src/custom/ai-platform/components/GuardPolicyEditor.tsx`: `GuardPolicyEditor`
- `client/src/custom/ai-platform/components/PolicyTester.tsx`: `PolicyTester`
- `client/src/custom/ai-platform/components/GuardEvents.tsx`: `GuardEvents`

### UI Semantics & Security Boundaries Implemented
- **Exact child permissions**:
  - `view_output_guard` grants `GET /output-guard/:scope`, `POST /output-guard/:scope/test`, `GET /output-guard/events`.
  - `edit_output_guard` grants `PUT /output-guard/:scope` without firing unauthorized `GET` policy/events queries.
  - `view_guard_excerpts` grants direct excerpt lookup (`GET /output-guard/events/:id/excerpt`) without listing policies or events.
  - `manage_ai_platform` alone does NOT grant output-guard access.
- **Safety disclosures**:
  - Editor & tester explicitly warn about hold/delay added latency, full-buffering when unbounded regex or external checks are enabled, loss of incremental streaming with external checks (plus model call/cost/quota impact), missing authorized identity for model judge, and server-verified/signed bypass role semantics (never trusting client input/headers).
- **Lifecycle**:
  - Request epoch + `AbortController` on unmount, scope switch, and `sessionRevision` change; excerpt cache/state cleared immediately on scope/session switch or unmount. No console/toast logging of events, excerpts, or prompts.

---

## 3. Verification Commands & Observed Results

### Passing Checks (after final code edit `31c8e595`)
- `npx -w client eslint ...` (all 9 Agent 4 client files): **0 errors, 0 warnings**
- `npx -w client vitest run src/custom/ai-platform/output-guard.test.tsx`: **1 file, 8/8 tests PASS**
- `npm run check:i18n -w client`: **PASS (60 locales, 1336 keys)**
- `npm run lint --workspace=server` & `npm run lint --workspace=cli`: **PASS**
- `npm run build` (`shared`, `server`, `cli`, `client` `tsc -b && vite build`): **PASS**
- `npm run test:migrations`: **1 file, 3/3 tests PASS** (`roundtrip.test.ts`)
- `npx -w server vitest run src/__tests__/custom/ai-platform/regression.test.ts`: **1 file, 14/14 tests PASS** (frozen golden baseline)
- `npx -w server vitest run src/__tests__/custom/ai-platform/guard-permissions.test.ts src/__tests__/custom/ai-platform/guard-secret-leak.test.ts src/__tests__/custom/ai-platform/guard-bench.test.ts src/__tests__/custom/ai-platform/guard-e2e.test.ts`: **4 files, 25/25 tests PASS** (`guard-permissions` 5/5, `guard-secret-leak` 1/1, `guard-bench` 2/2, `guard-e2e` 17/17)

### Full Workspace Suites & Retry Results
- `npm run test:bootstrap`: **2 passed, 2 skipped (PowerShell on Linux), 0 failed**
- `npm run test:hooks`: **9 passed, 0 failed**
- `npm run test -w server`: **609/611 files passed, 2 failed; 7243 passed, 2 failed, 9 skipped (7254 total)**
  1. `src/__tests__/db/turso-read-cache.test.ts > knows about every trigger in the migrations`: **FAIL** — migration `20261113_120000_custom_ai_output_guard.ts` (Agent 1) defines a `CREATE TRIGGER` not yet registered in `turso-read-cache.test.ts` / `TRIGGER_SIDE_EFFECTS` (both read-only for Agent 4).
  2. `src/__tests__/services/router-bandit.test.ts > exploration draws are never wasted on a model that cannot serve the request`: **FAIL** (5000ms timeout; standalone rerun: 30/31 PASS, same test timed out at 7833ms > 5000ms).
- `npx -w cli vitest run`: **7/7 files passed, 180 passed, 1 skipped (181 total)**
- `npm run test -w client`: **121/122 files passed, 1 failed; 904 passed, 1 failed (905 total)** — `src/custom/granular-permissions.test.tsx > saves actual child grants for a restricted secondary admin` timed out at 5000ms under 122-worker parallel load.
- Sequential rerun `npx -w client vitest run src/custom/granular-permissions.test.tsx`: **1 file, 11/11 tests PASS**.

---

## 6. Peer Integration Findings

### Resolved (Verified GREEN via `70edff67`, `a1ecfd50`, `bbd8792f`)
1. **Agent 1 RBAC (`permission-actions.ts`)**: `manage_ai_platform` alone now returns `403` on `/api/ai-platform/output-guard/*` (`guard-permissions.test.ts` 5/5 PASS).
2. **Agent 3 `mode: 'log'` non-stream**: `POST /v1/chat/completions` with `mode: 'log'` preserves original text (`guard-e2e.test.ts` PASS).
3. **Agent 3 Gemini JSON-array stream (`?alt=sse` omitted)**: Now emits replacement `'Blocked by output guard.'` in `mode: 'block'` (`guard-e2e.test.ts` PASS).
4. **Agent 1 / Agent 3 Gemini multi-candidate non-stream**: Now blocks and returns `'Blocked by output guard.'` (`guard-e2e.test.ts` PASS).

### Open Finding for Reviewer / Agent 1 (Outside Agent 4 Ownership)
- **`src/__tests__/db/turso-read-cache.test.ts`**: Fails on full `server` run because Agent 1's migration `20261113_120000_custom_ai_output_guard.ts` adds a `CREATE TRIGGER` whose written tables are not listed in `TRIGGER_SIDE_EFFECTS` / `turso-read-cache.test.ts`.

---

## 4. 18-Task Coverage Matrix (`T054`–`T071`)

| Task | Owner | Description | Status on `codex/ai-platform-output-guard-ui` |
|---|---|---|---|
| T054–T058, T060–T068 | Agents 1–3 | Foundation, detectors, stream guard, policies, events, gateway/MCP/support hooks, admin router | Integrated prerequisites imported (`be11bcfe`..`bbd8792f`); Agent 4 E2E/RBAC/secret-leak/bench GREEN against integrated runtime (1 open `turso-read-cache.test.ts` trigger-list item for Agent 1/Reviewer) |
| T059 | Agent 4 | Real HTTP E2E across 4 wires + Gemini array + RBAC + secret-leak | **GREEN (`guard-e2e.test.ts` 17/17, `guard-permissions.test.ts` 5/5, `guard-secret-leak.test.ts` 1/1)** |
| T069 | Agent 4 | UI tests (`output-guard.test.tsx`) | **GREEN (8/8)** |
| T070 | Agent 4 | Native EN/VI UI (`OutputGuard`, Editor, Tester, Events) | **GREEN (`check:i18n` PASS, 0 ESLint errors on Agent 4 files, `build` PASS)** |
| T071 | Agent 4 | Benchmark (`guard-bench.test.ts`) + `regression.test.ts` | **GREEN (`guard-bench.test.ts` 2/2, `regression.test.ts` 14/14)** |

---

## 5. E2E Wire Matrix & Benchmark Disclosure

### 4-Wire (+ Gemini JSON-Array) Matrix Covered in `guard-e2e.test.ts`
- `openai-chat` (`/v1/chat/completions`): non-stream block (`content_filter`), SSE stream cross-chunk split, `mode: 'off'` passthrough, `mode: 'log'`, PII `mask`, multi-choice filtering, exact-cache hit (0 second provider call) + spoofed `x-ai-platform-internal` / `x-user-role` rejection, MCP 1-round read loop (`x-freellm-tool-rounds: 1`), caller-owned `tool_calls` intact, provider pause `>300ms`, client mid-stream abort.
- `anthropic` (`/v1/messages`): non-stream block (`stop_reason: "refusal"`), SSE stream cross-chunk split.
- `responses` (`/v1/responses`): non-stream block (`status: "incomplete"`), SSE stream cross-chunk split.
- `gemini` (`/v1beta/models/...`): non-stream block (`finishReason: "SAFETY"`), SSE stream (`?alt=sse`) cross-chunk split, JSON-array stream (without `?alt=sse`) cross-chunk split, multi-candidate filtering.

### Benchmark Corpus & Methodology (`guard-bench.test.ts` + `guard-eval.json`)
- **Corpus**: `server/src/__tests__/fixtures/ai-platform-output-guard/guard-eval.json` — 220 diverse benign responses + 7 deterministic violation/masking fixtures (`seed: 20261113`).
- **Default policy**: `mode: 'block'`, `failMode: 'allow'`, `holdChars: 200`, `maxDelayMs: 300`, non-model detectors (`keywords`, `promptLeak`, `pii` `mask`).
- **Scope boundary**: Policies requiring full buffering (unbounded custom regex, external moderation, model judge) are explicitly excluded from the `<= 300ms` streaming TTFC claim. Measurements use synthetic `FakeProviderServer` on `127.0.0.1:0` and measure time to first real content delta (excluding HTTP headers, SSE comments, empty role frames); not a production SLA guarantee.


## Reviewer acceptance — 2026-11-14

This acceptance supersedes the earlier open trigger-cache finding and full-suite failures above. Integrated branch: `codex/ai-platform-output-guard-review`, with `origin/main` at `ff4de7df` merged before validation.

- Fixed all seven review findings: skipped bounded streaming regex, PII continuation after timer flush, missing authenticated judge request, inconsistent streamed prompt-leak normalization, malformed moderation results accepted as safe, stale cross-scope policy saves, and trigger side-effect cache invalidation.
- All enabled regex rules now buffer before worker evaluation; the additive `custom_pattern` buffering reason is documented in contract version 2 and the EN/VI UI disclosure.
- Added 13 backend review regressions, 7 real-HTTP acceptance cases, 3 malformed-moderation HTTP cases, stale-save success/conflict UI cases, and a trigger-driven cache invalidation regression.
- Made the two existing suite blockers deterministic: router exploration tests force scoring/draw conditions; the query-count fixture freezes Date while leaving network timers real. Existing query budgets and timeouts are unchanged.
- Spec tasks T054–T071 are complete.

Final local validation:
- Server: `npx -w server vitest run --pool=forks --maxWorkers=4` — 613 files passed; 7,281 tests passed, 9 skipped.
- Client: `npx -w client vitest run --maxWorkers=2` — 122 files / 907 tests passed.
- CLI: `npm run test -w cli` — 7 files / 180 tests passed, 1 skipped.
- `npm run test:bootstrap`, `npm run test:hooks`, `npm run lint`, changed-client-file ESLint, `npm run check:i18n -w client`, `npm run test:migrations`, `npm run build`, plain-Node compiled app import and compiled regex-worker smoke — passed. Bootstrap skips the two PowerShell-only cases on Linux.
- The false-positive/latency benchmark remains synthetic local HTTP evidence, not a production SLA guarantee. CI is reported separately by the PR checks.
