# Agent 3 Handoff — Frozen Baseline, Loopback Safety & Real Gateway Integration (FOUNDATION/US1, T001–T033)

- **Branch**: `codex/ai-platform-foundation-integration`
- **Base SHA**: `17328a176bd02b7510c51d7a458d038e16848a0b` (`origin/main`)
- **Worktree**: `/tmp/wt-agent3`

## Commits on `codex/ai-platform-foundation-integration`

### Agent 3 Commits
1. `cd78c350` — `test(ai-platform): capture frozen 4-protocol baseline before hooks (T005)`
   - Captured on untouched base `17328a17` + T002 (`ai-platform-fake-provider.ts`) across all 4 protocols (`openai-chat`, `anthropic`, `responses`, `gemini`), stream & non-stream, enriched (system prompt + knowledge + `cache_control`) vs plain, and 3 auth types (`profile`, `unified`, `user`).
   - Files: `server/src/__tests__/custom/ai-platform/regression.test.ts`, `server/src/__tests__/fixtures/ai-platform-baseline/{manifest.json,14 case fixtures}`.
2. `4073b141` — `test(ai-platform): add fake MCP server, fake embeddings, and retrieval eval fixtures (T003, T004)`
   - Files: `server/src/__tests__/helpers/fake-mcp-server.ts`, `server/src/__tests__/helpers/fake-embeddings.ts`, `server/src/__tests__/fixtures/retrieval-eval.json` (32 chunks, 52 paraphrased queries).
3. `233ab137` — `feat(ai-platform): add loopback safety and preparse internal-header stripping (T012-T014)`
   - Files: `server/src/custom/ai-platform/loopback.ts`, `server/src/__tests__/custom/ai-platform/loopback.test.ts`, `server/src/custom/preparse-guard.ts`, `server/src/__tests__/custom/preparse-guard.test.ts`.
4. `99eafcc7` — `docs(ai-platform): verify /thruline/v1 is outside profileInferenceGate (T016)`
   - Files: `specs/018-ai-platform-upgrade/research.md` (R1), `specs/018-ai-platform-upgrade/contracts/inference-surface.md`.
5. `49869efd` — `feat(ai-platform): wire pipeline composition, gateway routes, and backup-restore verification (T021, T027, T029, T033)`
   - Files: `server/src/custom/ai-platform/pipeline.ts`, `server/src/__tests__/custom/ai-platform/pipeline.test.ts`, `server/src/middleware/profile-gate.ts`, `server/src/custom/register.ts`, `server/src/__tests__/custom/surface.test.ts`, `server/src/__tests__/custom/ai-platform/backup-restore.test.ts`.
6. `d2af111f` — `chore(ai-platform): remove unused targetHost in loopback.ts`
   - Files: `server/src/custom/ai-platform/loopback.ts`.

### Cherry-Picked Prerequisite Commits (Unmodified)
- `f43ba4c7` (from Agent 2 `2d8818d0c0796b22f0b7f7d7900d27554696ffc7`) — T002 `ai-platform-fake-provider.ts`
- `4a17bd8f` (from Agent 2 `1be8fdabdf083aab3e73c8f87a8f82698d2204bf`) — T006–T011 `wire/{detect,extract,respond,interceptor}.ts` + tests
- `fe4fa611` (from Agent 1 `226c10ab5be44ffc506df396351e92613820474e`) — T001 `shared/ai-platform.ts`, `shared/permissions.ts`
- `0c6afae1` (from Agent 1 `305849fdaa09738c1e43cb7749b2507f01ab4658`) — T015, T017–T030 (`flags`, `permissions`, `router`, `masking`, `scope`, `permission-actions`, `audit-log`, `20261113_100000_custom_ai_platform_base.ts`, `defaults.ts`, `roundtrip.test.ts`, unit tests)

## Verified Checks (Observed After Final Code Edit `d2af111f`)
- Targeted test suite (`npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/loopback.test.ts src/__tests__/custom/ai-platform/pipeline.test.ts src/__tests__/custom/ai-platform/regression.test.ts src/__tests__/custom/ai-platform/backup-restore.test.ts src/__tests__/custom/preparse-guard.test.ts src/__tests__/custom/surface.test.ts`): **6/6 files, 49/49 tests passed**.
- `npm run lint`: exited 0 (0 errors, 0 warnings).
- `npm run build` (`shared`, `server`, `cli`, `client`): exited 0.
- `npm run test:migrations`: **3/3 tests passed** (`roundtrip.test.ts`).
- `node --input-type=module -e "await import('./server/dist/app.js')"`: exited 0.
- `git diff --check`: exited 0 (no whitespace errors).
