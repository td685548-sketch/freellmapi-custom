# Stage 6 Handoff — Versioned System Prompts (US6, `T104`–`T114`)

- **Integration Branch**: `codex/ai-platform-prompts`
- **Base Branch (`codex/ai-platform-prompt-cache`)**: `2cdaa6c2` (stacked cleanly on `origin/main` `f11c5d99`)
- **Frozen C0 Contract SHA**: `6e5d86e8`
- **Integrated Worker Commits**:
  - `prompts-template`: `8808933539ce679002526e72fcdf7b6f48ae1943` -> cherry-picked as `964c88e5`
  - `prompts-store`: `87fdc46c0960871f2a8a743c8e8d3955bdd01345` -> cherry-picked as `70e8b61c`
  - `prompts-runtime`: `5fb90949df1e5336fb170181bea886b5817497fa` -> cherry-picked as `163563c4`
  - `prompts-ui`: `547ed49982d3a4633472ef7b53d6d32a7a677962` -> cherry-picked as `fc5aab91`
- **Owned Tasks**: `T104`–`T114` (11/11 marked `[x]` in `specs/018-ai-platform-upgrade/tasks.md`)
- **Overall Status**: **GREEN** on integrated `codex/ai-platform-prompts`

---

## 1. Delivered Files

### Shared Contracts & Spec Docs
- `shared/ai-platform-prompts.ts` (DTOs, `SYSTEM_PROMPT_VARIABLES`, `PROMPT_LIMITS`, `PROMPT_VAR_NAME_REGEX`)
- `specs/018-ai-platform-upgrade/handoffs/prompts-contracts.json`
- `specs/018-ai-platform-upgrade/tasks.md` (`T104`–`T114` checked off)
- `specs/018-ai-platform-upgrade/handoffs/agent-prompts.md` (this handoff)

### Template Engine (`prompts-template`)
- `server/src/custom/ai-platform/prompts/template.ts` (`sanitizeVariableValue`, `validateTemplate`, `renderWith`: single-pass substitution, `{{name}}` & `{{name|default}}`, `^[a-z][a-z0-9_]{0,31}$` validation, 1-based line/column error locations, 200-char + control-char sanitization, exact reference identity when no `{{`)
- `server/src/__tests__/custom/ai-platform/prompt-template.test.ts` (13/13 PASS)

### Migration & Version Store (`prompts-store`)
- `server/src/db/migrations/20261113_150000_custom_ai_prompt_versions.ts` (`custom_ai_prompt_versions`, `custom_ai_prompt_heads`, `idx_custom_ai_prompt_versions_scope_status`, `trg_client_profiles_delete_prompts`, Version 1 `published` backfill for `client_profiles` and `x_support_tenants`, reversible `down()` preserving existing `system_prompt` columns)
- `server/src/db/migrate/defaults.ts`, `server/src/db/turso.ts`, `server/src/__tests__/db/migrate/roundtrip.test.ts`, `server/src/__tests__/db/turso-read-cache.test.ts`
- `server/src/custom/ai-platform/prompts/store.ts` (`getPromptScopeState`, `getPromptVersion`, `getPublishedPrompt`, `saveDraft`, `discardDraft`, `publish`, `restore`, `diffPromptVersions` with immutable versions, single published/draft invariant, transactional write to `client_profiles.system_prompt`/`x_support_tenants.system_prompt`, optimistic locking 409 `RevisionConflictError`, 422 `PromptValidationError`, 50-version retention preserving `published`, and line-by-line LCS diff)
- `server/src/__tests__/db/migrate/ai-platform-prompts.test.ts` (2/2 PASS)
- `server/src/__tests__/custom/ai-platform/prompt-store.test.ts` (7/7 PASS)

### Runtime Rendering, Admin Router & E2E (`prompts-runtime`)
- `server/src/custom/ai-platform/prompts/render.ts` (`parseCallerVarsHeader`, `capturePromptRequestContext`, `renderPrompt`, `renderTenantSystemPrompt`)
- `server/src/lib/system-prompt.ts` (minimal hook calling `renderPrompt` inside `prependSystemPrompt`)
- `server/src/custom/x-gateway/support-router.ts` (minimal hook calling `renderTenantSystemPrompt`)
- `server/src/custom/ai-platform/pipeline.ts` (Slot 5 `capturePromptRequestContext`)
- `server/src/custom/ai-platform/prompts/router.ts` & `server/src/custom/ai-platform/router.ts` (all 10 `/prompts/*` routes with `view_prompts`/`edit_prompts`/`publish_prompts` permissions, loopback `/try` using unified key with zero client-key billing, `prompts` pillar `ready: true` in `/overview`)
- `server/src/__tests__/custom/ai-platform/prompt-e2e.test.ts` (5/5 PASS)

### Client UI & i18n (`prompts-ui`)
- `client/src/custom/ai-platform/prompts-api.ts`
- `client/src/custom/ai-platform/prompts-strings.ts`
- `client/src/custom/ai-platform/components/DiffView.tsx`
- `client/src/custom/ai-platform/components/VariableEditor.tsx` (system catalog, caller/custom variable CRUD, cache-prefix stability warning for dynamic/caller variables)
- `client/src/custom/ai-platform/pages/Prompts.tsx` (scope selector, draft editor, 422 line/column errors, 409 conflict banner, pruned history indicator, version history, restore, preview & try draft, RBAC gating)
- `client/src/custom/ai-platform/AiPlatformApp.tsx` (wired `Prompts` route & nav link with child permissions)
- `client/src/custom/ai-platform/prompts.test.tsx` (13/13 PASS)
- `client/src/custom/i18n/vi.ts`

---

## 2. Verification Results on `codex/ai-platform-prompts`

- `npm run build` (`shared`, `server`, `cli`, `client`): **PASS** (exit 0)
- `npm run test:migrations`: **PASS** (`roundtrip.test.ts`: 1 file, 3/3 tests)
- Server Vitest suite (10 files, **162/162 tests PASS**):
  - `src/__tests__/db/migrate/ai-platform-prompts.test.ts`: 2/2
  - `src/__tests__/db/migrate/registry-drift.test.ts`: 2/2
  - `src/__tests__/db/turso-read-cache.test.ts`: 22/22
  - `src/__tests__/lib/system-prompt.test.ts`: 8/8
  - `src/__tests__/custom/ai-platform/permissions.test.ts`: 85/85
  - `src/__tests__/custom/ai-platform/prompt-template.test.ts`: 13/13
  - `src/__tests__/custom/ai-platform/prompt-store.test.ts`: 7/7
  - `src/__tests__/custom/ai-platform/prompt-e2e.test.ts`: 5/5
  - `src/__tests__/custom/ai-platform/regression.test.ts`: 14/14
  - `src/__tests__/custom/ai-platform/pipeline.test.ts`: 4/4
- Client Vitest suite (4 files, **39/39 tests PASS**):
  - `src/custom/ai-platform/prompts.test.tsx`: 13/13
  - `src/custom/ai-platform/ai-platform.test.tsx`: 13/13
  - `src/custom/ai-platform/strings.test.ts`: 10/10
  - `src/custom/i18n/translations.test.ts`: 3/3
- `npm run check:i18n -w client`: **PASS** (60 locales, 1336 keys)
- `npm run lint` (`server` + `cli`) and `npx -w client eslint` on all touched client files: **PASS** (0 errors, 0 warnings)
