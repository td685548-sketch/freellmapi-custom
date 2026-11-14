# Agent 4 Foundation Handoff — Native Dashboard, Bilingual UI, and RBAC/Audit Acceptance (`T019`, `T020`, `T031`, `T032`)

- **Spec**: `specs/018-ai-platform-upgrade/` (FOUNDATION / US1, T001–T033 scope only)
- **Base SHA**: `17328a176bd02b7510c51d7a458d038e16848a0b` (`origin/main`)
- **Branch**: `codex/ai-platform-foundation-ui`
- **Worktree**: `/tmp/wt-ai-platform-ui`

## Commits on `codex/ai-platform-foundation-ui`

### Agent 4 Self Commits
1. `fc31faaf` — `test(ai-platform): add RED permission matrix and audit tests (T019, T020)`
2. `448106e9` — `test(ai-platform): enable real HTTP RBAC and audit tests (T019, T020)`
3. `2c4afee8` — `feat(ai-platform): add native AI Platform dashboard and bilingual UI (T031, T032)`
4. *(pending)* — `docs(ai-platform): add agent-4 foundation handoff`

### Prerequisite Cherry-Picks (Not Modified by Agent 4)
- `8c776f21` (from Agent 1 `226c10ab5be44ffc506df396351e92613820474e`) — T001 `shared/ai-platform.ts`, `shared/permissions.ts`
- `ce568155` (from Agent 1 `305849fdaa09738c1e43cb7749b2507f01ab4658`) — T015, T017–T030 (`flags`, `permissions`, `router`, `masking`, `scope`, `permission-actions`, `audit-log`, `20261113_100000_custom_ai_platform_base.ts`, `defaults.ts`, `roundtrip.test.ts`, unit tests)
- `7e1737ec` (from Agent 3 `233ab137`) — T012–T014 (`loopback.ts`, `loopback.test.ts`, `preparse-guard.ts`, `preparse-guard.test.ts`)
- `e20ef40e` (from Agent 3 `49869efd`) — T021, T027, T029, T033 (`pipeline.ts`, `pipeline.test.ts`, `profile-gate.ts`, `register.ts`, `surface.test.ts`, `backup-restore.test.ts`)

## Task Statuses & Owned Files

| Task | Status | Files | Notes |
| :--- | :--- | :--- | :--- |
| **T019** | Done | `server/src/__tests__/custom/ai-platform/permissions.test.ts` | 85 tests covering 21 `ai_platform_*` permissions, fail-closed `fl%61gs` -> `manage_ai_platform` check, and real HTTP RBAC via `createApp()` / `createUser()` / `createSession()` / `setUserPermissions(..., primaryId)`. |
| **T020** | Done | `server/src/__tests__/custom/ai-platform/audit.test.ts` | 15 tests covering `summarize()` redaction (`args`/`headers` -> `'[hidden]'`), secret masking, and real HTTP audit + retention (`{ runsDays, toolCallsDays, guardExcerptsDays }`). |
| **T031** | Done | `client/src/custom/ai-platform/AiPlatformApp.tsx`, `client/src/custom/ai-platform/api.ts`, `client/src/custom/ai-platform/pages/Overview.tsx`, `client/src/custom/ai-platform/ai-platform.test.tsx`, `client/src/App.tsx` | Native dashboard mounted at `/ai-platform`, Overview page with 6 pillar flags (all default `false`), `can('edit_ai_flags')` lock, `sessionRevision` + `scopeKey` query keys, `AbortSignal` + `epochRef`/`mountedRef` guards, native `createRoot` + `act` UI tests (13 tests). |
| **T032** | Done | `client/src/custom/ai-platform/strings.ts`, `client/src/custom/ai-platform/strings.test.ts`, `client/src/custom/i18n/vi.ts` | Complete EN/VI bilingual strings for AI Platform nav, Overview, 6 pillars, lock/error states, and `vi.ts` parity. |

## Exported Paths & DTO Alignment
- **Frontend Route**: `/ai-platform` (`AiPlatformApp.tsx` mounted in `client/src/App.tsx`)
- **API Client (`client/src/custom/ai-platform/api.ts`)**:
  - Uses `AiPlatformOverviewResponse`, `PillarFlags`, `AiPlatformRetention` from `shared/ai-platform.ts`.
  - `FlagsEnvelope` (`{ flags: PillarFlags }`) and `RetentionEnvelope` (`{ retention: AiPlatformRetention }`).
  - Cache key helpers: `overviewKey(sessionRevision, scope = 'global')`, `retentionKey(sessionRevision, scope = 'global')`.
  - Endpoints: `GET /api/custom/ai-platform/overview`, `PUT /api/custom/ai-platform/flags`, `GET/PUT /api/custom/ai-platform/retention`.
- **`PermissionsDialog.tsx` No-Edit Evidence**:
  - Verified via `grep -n "PERMISSION_GROUPS"` that `client/src/custom/PermissionsDialog.tsx` dynamically reads `PERMISSION_GROUPS` from `shared/permissions` (`!isXGatewayGroup(g.key)`). No edit was required.

## RED -> GREEN & Verification Evidence

### RED Phase (`fc31faaf`)
- Before cherry-picking Agent 1/3 prerequisites, `permissions.test.ts` failed on missing `server/src/custom/ai-platform/permissions.ts`, and `audit.test.ts` had 5 skipped HTTP tests pending router/audit prerequisites.

### GREEN Verification
1. **Server RBAC & Audit (`448106e9`)**:
   - Command: `npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/ai-platform/permissions.test.ts src/__tests__/custom/ai-platform/audit.test.ts`
   - Result: **2/2 files passed, 100/100 tests passed** (`permissions.test.ts` 85/85, `audit.test.ts` 15/15).
2. **Client Tests, Typecheck, Lint, Build, Diff Check (after final UI edit, `2c4afee8`)**:
   - `npx vitest run src/custom/ai-platform/ai-platform.test.tsx src/custom/ai-platform/strings.test.ts src/custom/i18n/translations.test.ts`: **3/3 files passed, 26/26 tests passed** (`strings.test.ts` 10/10, `translations.test.ts` 3/3, `ai-platform.test.tsx` 13/13).
   - `npx tsc -b`: **passed (exit 0)**.
   - `npx eslint src/custom/ai-platform src/App.tsx src/custom/i18n/vi.ts`: **passed (exit 0)**.
   - `npm run build -w client`: **passed (exit 0)**.
   - `git diff --check`: **passed (exit 0)**.
