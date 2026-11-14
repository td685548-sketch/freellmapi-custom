# Agent 4 Handoff — Output Guard UI, Acceptance, RBAC, Secret-Leak & Benchmark

- **Branch**: `codex/ai-platform-output-guard-ui`
- **Base SHA**: `92a4f520cd01cc33f403d5f1bbd30ec98a6d569d` (verified ancestor: PR52 MCP merge `d1e0a03badea3c19fc60200a13155a1eb420b12e`)
- **C0 Contract SHA**: `3abe64b6fcef0586fb3424d51e895a2beb0ec92b` (from Agent 1 C0 `a2e8aa933f3a585445def0d44b08106677d9f5a0`)
- **Code Commit SHA**: `cdc5ae1cf1153bc9a11d985e3e425c651eadda66`
- **Owned Tasks**: `T059`, `T069`, `T070`, `T071`
- **Overall Status**:
  - `T069` / `T070` (Native EN/VI UI, RBAC routing, PolicyEditor, PolicyTester, GuardEvents, unit/UI tests, `check:i18n`, ESLint, `tsc -b && vite build`): **GREEN**
  - `T059` / `T071` (Server HTTP E2E, RBAC HTTP, Secret-Leak/Backup/410, Benchmark): **PARTIAL / RED** (awaiting Agent 1 `store/policy/events/router/migration` + Agent 3 `stream-guard/interceptor/pipeline/support` integration onto a shared review branch).

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

### Passing Checks (after final code edit)
- `npx -w client eslint ...` (all 9 Agent 4 client files): **0 errors, 0 warnings**
- `npx -w client vitest run src/custom/ai-platform/output-guard.test.tsx`: **1 file, 8/8 tests PASS**
- `npm run check:i18n -w client`: **PASS (60 locales, 1336 keys)**
- `npm run lint` (`server` + `cli`): **PASS**
- `npm run build` (`shared`, `server`, `cli`, `client` `tsc -b && vite build`): **PASS**
- `npm run test:migrations`: **1 file, 3/3 tests PASS** (`roundtrip.test.ts`)
- `npx -w server vitest run src/__tests__/custom/ai-platform/regression.test.ts`: **1 file, 14/14 tests PASS** (frozen golden baseline)

### Full Client Suite & Retry
- `npm run test -w client`: **121/122 files, 904/905 tests PASS**; `src/custom/granular-permissions.test.tsx` hit its 5000ms timeout under 122-worker parallel load.
- Sequential rerun `npx -w client vitest run src/custom/granular-permissions.test.tsx`: **1 file, 11/11 tests PASS**.

### Server Output Guard Acceptance / Bench / RBAC / Secret-Leak (RED before integration)
- `npx -w server vitest run src/__tests__/custom/ai-platform/guard-e2e.test.ts src/__tests__/custom/ai-platform/guard-bench.test.ts src/__tests__/custom/ai-platform/guard-permissions.test.ts src/__tests__/custom/ai-platform/guard-secret-leak.test.ts`:
  - `guard-e2e.test.ts`: **1 passed / 16 failed** (caller-owned `tool_calls` passes; 16 guard/E2E assertions fail with 404 because `/api/ai-platform/output-guard/*` and runtime hooks are not yet integrated on this branch).
  - `guard-permissions.test.ts`: **1 passed / 4 failed** (`401` unauthenticated passes; RBAC/flag-off/409/422 fail with 404 until Agent 1 router is integrated).
  - `guard-secret-leak.test.ts`: **0 passed / 1 failed** (fails at `PUT /api/ai-platform/output-guard/profile/:id` returning 404).
  - `guard-bench.test.ts`: **0 passed / 2 failed** (fails at `GET /api/ai-platform/output-guard/profile/:id` returning 404).

---

## 4. 18-Task Coverage Matrix (`T054`–`T071`)

| Task | Owner | Description | Status on `codex/ai-platform-output-guard-ui` |
|---|---|---|---|
| T054 | Agent 1 | Migration roundtrip test | Pending integration (Agent 1) |
| T055 | Agent 2 | Local detectors unit tests | Pending integration (Agent 2 D0 ready) |
| T056 | Agent 3 | Stream guard & timer tests | Pending integration (Agent 3 S0 ready) |
| T057 | Agent 2 | External moderation/judge tests | Pending integration (Agent 2 D0 ready) |
| T058 | Agent 1 | Guard router/events/policy tests | Pending integration (Agent 1) |
| T059 | Agent 4 | Real HTTP E2E across 4 wires + Gemini array | **Authored (RED pending integration)** |
| T060 | Agent 1 | DB migration + store + defaults | Pending integration (Agent 1) |
| T061 | Agent 2 | Local detectors + ReDoS worker validator | Pending integration (Agent 2 D0 ready) |
| T062 | Agent 3 | Stream guard + OutputFilter timer sink | Pending integration (Agent 3 S0 ready) |
| T063 | Agent 2 | External moderation/judge + `moderation.ts` | Pending integration (Agent 2 D0 ready) |
| T064 | Agent 1 | Policy evaluator + `outputFilterFor` | Pending integration (Agent 1) |
| T065 | Agent 1 | Guard events + AES-GCM excerpts + 7d/90d | Pending integration (Agent 1) |
| T066 | Agent 3 | Gateway/pipeline/cache/MCP/support hooks | Pending integration (Agent 3) |
| T067 | Agent 3 | Support runtime adapter + trusted role context | Pending integration (Agent 3) |
| T068 | Agent 1 | Admin router + scope cleanup | Pending integration (Agent 1) |
| T069 | Agent 4 | UI tests (`output-guard.test.tsx`) | **GREEN (8/8)** |
| T070 | Agent 4 | Native EN/VI UI (`OutputGuard`, Editor, Tester, Events) | **GREEN** |
| T071 | Agent 4 | Benchmark (`guard-bench.test.ts`) + `regression.test.ts` | **Bench authored (RED); `regression.test.ts` GREEN (14/14)** |

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
