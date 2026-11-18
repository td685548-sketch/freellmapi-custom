# Implementation Plan: Scenario-Based Auto-Routing & 1-Click IDE Config Packager (Spec 039)

**Branch**: `feat/039-scenario-routing-ide-packager` | **Date**: 2026-11-18 | **Spec**: [`spec.md`](./spec.md)

## 1. Technical Context
- **Runtime**: Node.js >= 20.18, TypeScript ESM (`@freellmapi/shared`, `@freellmapi/server`, `@freellmapi/client`).
- **Database**: SQLite (`better-sqlite3` / LibSQL) via `getDb()`, timestamped reversible migration `20261118_190000_custom_scenario_routing.ts`.
- **Frontend**: React + TanStack Query + Tailwind CSS + Lucide icons, strict Helmet CSP (`script-src 'self'`).

## 2. Database Schema (`20261118_190000_custom_scenario_routing.ts`)
1. `custom_scenario_routing_policies`:
   - `id` INTEGER PRIMARY KEY AUTOINCREMENT
   - `user_id` INTEGER NOT NULL REFERENCES `users(id)` ON DELETE CASCADE
   - `key_id` INTEGER REFERENCES `user_api_keys(id)` ON DELETE CASCADE (NULL = user-wide default policy; non-null = per-key policy override)
   - `enabled` INTEGER NOT NULL DEFAULT 1
   - `long_context_threshold` INTEGER NOT NULL DEFAULT 60000
   - `rules_json` TEXT NOT NULL DEFAULT `'{}'` (serialized per-scenario rules: `{ enabled, targetMode: 'default'|'eco'|'balanced'|'max', targetModel: string | null, overrideExplicitModel?: boolean }`)
   - `created_at` TEXT NOT NULL DEFAULT `(datetime('now'))`
   - `updated_at` TEXT NOT NULL DEFAULT `(datetime('now'))`
   - Unique indexes ensuring at most 1 user-default policy (`key_id IS NULL`) and 1 policy per `(user_id, key_id)`.
2. `custom_scenario_routing_stats`:
   - `id` INTEGER PRIMARY KEY AUTOINCREMENT
   - `user_id` INTEGER NOT NULL REFERENCES `users(id)` ON DELETE CASCADE
   - `key_id` INTEGER NOT NULL DEFAULT 0 (0 = aggregate / session-attributed, >0 = specific `user_api_keys.id`)
   - `scenario` TEXT NOT NULL (`background` | `think` | `longContext` | `vision` | `webSearch` | `default`)
   - `hit_count` INTEGER NOT NULL DEFAULT 0
   - `offloaded_count` INTEGER NOT NULL DEFAULT 0
   - `total_tokens` INTEGER NOT NULL DEFAULT 0
   - `estimated_tokens_saved` INTEGER NOT NULL DEFAULT 0
   - `last_model` TEXT
   - `last_routed_mode` TEXT
   - `last_hit_at` TEXT NOT NULL DEFAULT `(datetime('now'))`
   - Unique index on `(user_id, key_id, scenario)`.

## 3. Module Architecture (Zero-Conflict)
- **`shared/scenario-routing.ts`**: Shared TypeScript types, scenario constants (`SCENARIO_IDS`), IDE target constants (`IDE_PACKAGER_TOOLS`), policy/telemetry/packager DTOs.
- **`server/src/custom/scenario-routing/classifier.ts`**:
  - Ordered `ScenarioPolicyEngine` (`claude-code-router` pattern) + deterministic multilingual keyword/wire signal matchers (`OmniRoute` pattern).
  - Supports `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`.
  - Priority: `vision` -> `webSearch` -> `longContext` -> explicit `think` knob -> `background` -> heuristic `think` -> `default`.
- **`server/src/custom/scenario-routing/store.ts`**:
  - Policy resolution (`per-key policy` -> `user default policy`), CRUD with strict `user_id` ownership validation, routable catalog model verification (`isRoutableScenarioTargetModel`) for safe fallback, and telemetry recording (`recordScenarioRoutingHit`) + key verification state.
- **`server/src/custom/scenario-routing/ide-packager.ts`**:
  - Pure deterministic config & terminal script generator for **Claude Code, Cursor, Cline / Roo Code, Codex CLI, OpenCode, Continue** (PowerShell + Bash one-liners + downloadable config files + curl/PowerShell live test ping commands).
- **`server/src/custom/scenario-routing/middleware.ts`**:
  - Mounted at `app.use('/v1', scenarioRoutingMiddleware)` right after `customerAiSessionRoutingMiddleware` in `server/src/custom/register.ts`.
  - Resolves caller `userId` & `keyId`, evaluates active scenario policy, sets `X-FreeLLM-Scenario` and `X-FreeLLM-Scenario-Mode` headers, steers `setRequestKeyRoutingPreset`, safely rewrites `req.body.model` only when `targetModel` is routable and compatible, and books post-response token savings on `res.once('finish')`.
- **`server/src/custom/scenario-routing/router.ts`**:
  - Mounted at `app.use('/api/scenario-routing', scenarioRoutingRouter)` in `register.ts` (enforcing `requireAuth` + non-guest check internally without touching `PERMISSION_GATES`).
  - Endpoints:
    - `GET /api/scenario-routing/config` (policies, telemetry summary, routable models, keys)
    - `PUT /api/scenario-routing/policy` (save user-level or key-level policy)
    - `DELETE /api/scenario-routing/policy/:keyId` (remove per-key override)
    - `POST /api/scenario-routing/classify-preview` (deterministic dry-run classifier preview)
    - `POST /api/scenario-routing/ide-package` (generate personalized IDE config bundle)
    - `GET /api/scenario-routing/connection-status` (live poller for recent key activity & ping verification)
    - `POST /api/scenario-routing/verify-ping` (accepts either dashboard session + keyId/rawKey OR Bearer Personal API Key `sk-flm-...` directly from terminal/IDE to mark live connection verified!)
- **Client UI (`client/src/custom/scenario-routing/*`)**:
  - `strings.ts`, `api.ts`, `ScenarioRouterPanel.tsx`, `IdeConfigPackagerCard.tsx`.
  - Minimal hooks in `client/src/custom/PersonalKeyPanel.tsx` and `client/src/pages/AgentsPage.tsx`.
