# Stage 5 Handoff — Provider Prompt Caching (US5, `T089`–`T103`)

- **Integration Branch**: `codex/ai-platform-prompt-cache`
- **Base SHA (`origin/main`)**: `f11c5d99142fae0d5483588da73dff9806c207c0`
- **Frozen C0 Contract SHA**: `001a86542394484a1fcf91688fef0b4272635ff6`
- **Integrated Worker Commits**:
  - `cache-core`: `6941437454f6bcf2b0522ca6d598657812a161b5` -> cherry-picked as `3dc3b2fa`
  - `cache-breakpoints`: `150ed74cae3dcdf3cafde11a44a3ac82206045c6` -> cherry-picked as `c956fa6a`
  - `cache-runtime`: `b8dcb7822e9893b9f54ac9f4d2c72263d33f3c17` -> cherry-picked as `9cdb51d2`
  - `cache-ui`: `9a484f840fb8bb5d635647c3ba5e30ab4173cb89` -> cherry-picked as `7852b9ca`
- **Owned Tasks**: `T089`–`T103` (15/15 marked `[x]` in `specs/018-ai-platform-upgrade/tasks.md`)
- **Overall Status**: **GREEN** on integrated `codex/ai-platform-prompt-cache`

---

## 1. Delivered Files

### Shared Contracts & Spec Docs
- `shared/ai-platform-prompt-cache.ts` (DTOs, capability/stats/settings/override types)
- `specs/018-ai-platform-upgrade/research.md` (Section `R4`: single outbound hook point & 28 builtin provider capabilities catalog)
- `specs/018-ai-platform-upgrade/handoffs/prompt-cache-contracts.json` (frozen Stage 5 interface/table/route contracts)
- `specs/018-ai-platform-upgrade/tasks.md` (`T089`–`T103` checked off)
- `specs/018-ai-platform-upgrade/handoffs/agent-prompt-cache.md` (this handoff)

### Database Migration & Core Services (`cache-core`)
- `server/src/db/migrations/20261113_140000_custom_ai_prompt_cache.ts` (`custom_ai_cache_capabilities` with 28 deterministic builtin seeds, `custom_ai_cache_usage_daily`, `idx_custom_ai_cache_usage_daily_profile`, `trg_client_profiles_delete_prompt_cache`, reversible `down()`)
- `server/src/db/migrate/defaults.ts` (registered migration in chronological order)
- `server/src/db/turso.ts` (registered `custom_ai_cache_usage_daily` under `TRIGGER_SIDE_EFFECTS.client_profiles`)
- `server/src/__tests__/db/migrate/roundtrip.test.ts` & `server/src/__tests__/db/turso-read-cache.test.ts`
- `server/src/custom/ai-platform/prompt-cache/capabilities.ts` (settings + wildcard capability resolution with `override > builtin`, longest pattern tie-breaking, missing-DB/table safety)
- `server/src/custom/ai-platform/prompt-cache/stats.ts` (usage extraction across all 4 wires, micro-USD savings calculation, `cacheUsageFilter`, daily aggregation by `day|profile|model`)
- `server/src/custom/ai-platform/prompt-cache/router.ts` (6 `/prompt-cache/*` endpoints with `view_prompt_cache`/`edit_prompt_cache` permission checks and zod validation)
- `server/src/__tests__/db/migrate/ai-platform-prompt-cache.test.ts`
- `server/src/__tests__/custom/ai-platform/cache-capabilities.test.ts`
- `server/src/__tests__/custom/ai-platform/cache-stats.test.ts`

### Breakpoints & Prefix Stability (`cache-breakpoints`)
- `server/src/custom/ai-platform/wire/extract.ts` (`addSystemBlock` stable-before-volatile ordering across all 4 wires; `markVolatileSystemText`, `markStableSystemText`, `isVolatileSystemMessage`)
- `server/src/custom/ai-platform/prompt-cache/breakpoints.ts` (`applyCacheBreakpoints`: identity pass-through when pillar off, non-mutating clones, strip on `implicit`/`none` or disabled forwarding/auto, caller marker cap enforcement, auto placement priority `tools -> system prompt -> stable knowledge`)
- `server/src/__tests__/custom/ai-platform/cache-breakpoints.test.ts`
- `server/src/__tests__/custom/ai-platform/cache-prefix-stability.test.ts`

### Runtime Hook, Pipeline, Router & E2E (`cache-runtime`)
- `server/src/custom/ai-platform/prompt-cache/runtime.ts` (`captureCallerCacheControl`, `withPromptCacheRoute`, target/usage tracking per request, direct recording fallback for unified `profileId=0` traffic)
- `server/src/lib/fallback-loop.ts` (minimal `withPromptCacheRoute(route)` hook in `runFallbackLoopAttempts`)
- `server/src/custom/knowledge-inject.ts` (`markVolatileSystemText` on per-query retrieved RAG blocks)
- `server/src/custom/ai-platform/pipeline.ts` (Slot 8 caller cache hint capture and response interceptor ordering `stats -> citations -> outputGuard`)
- `server/src/custom/ai-platform/router.ts` (mounted `promptCacheAdminRouter`, marked `promptCache` pillar `ready: true` in `/overview`)
- `server/src/__tests__/custom/ai-platform/cache-e2e.test.ts`

### Client Dashboard & i18n (`cache-ui`)
- `client/src/custom/ai-platform/prompt-cache-api.ts`
- `client/src/custom/ai-platform/prompt-cache-strings.ts`
- `client/src/custom/ai-platform/pages/PromptCache.tsx`
- `client/src/custom/ai-platform/prompt-cache.test.tsx`
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (replaced `prompt-cache` placeholder with `<PromptCache />`)
- `client/src/custom/i18n/vi.ts`

---

## 2. Verification Results on `codex/ai-platform-prompt-cache`

- `npm run build` (`shared`, `server`, `cli`, `client`): **PASS** (exit 0)
- `npm run test:migrations`: **PASS** (`roundtrip.test.ts`: 1 file, 3/3 tests)
- Integrated server Vitest suite (11 files, **76/76 tests PASS**):
  - `src/__tests__/db/migrate/ai-platform-prompt-cache.test.ts`: 2/2
  - `src/__tests__/db/migrate/registry-drift.test.ts`: 2/2
  - `src/__tests__/db/turso-read-cache.test.ts`: 22/22
  - `src/__tests__/custom/ai-platform/cache-capabilities.test.ts`: 5/5
  - `src/__tests__/custom/ai-platform/cache-breakpoints.test.ts`: 8/8
  - `src/__tests__/custom/ai-platform/cache-prefix-stability.test.ts`: 1/1
  - `src/__tests__/custom/ai-platform/cache-stats.test.ts`: 5/5
  - `src/__tests__/custom/ai-platform/cache-e2e.test.ts`: 6/6
  - `src/__tests__/custom/ai-platform/regression.test.ts`: 14/14
  - `src/__tests__/custom/ai-platform/wire-extract.test.ts`: 7/7
  - `src/__tests__/custom/ai-platform/pipeline.test.ts`: 4/4
- Client Vitest suite (4 files, **35/35 tests PASS**):
  - `src/custom/ai-platform/prompt-cache.test.tsx`: 9/9
  - `src/custom/ai-platform/ai-platform.test.tsx`: 13/13
  - `src/custom/ai-platform/strings.test.ts`: 10/10
  - `src/custom/i18n/translations.test.ts`: 3/3
- `npm run check:i18n -w client`: **PASS** (60 locales, 1336 keys)
- `npm run lint` (`server` + `cli`) and `npx -w client eslint` on all touched client files: **PASS** (0 errors, 0 warnings)
