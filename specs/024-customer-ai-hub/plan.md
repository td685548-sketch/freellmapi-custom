# Implementation Plan: Spec 024 — Customer AI Hub & Dual-Persona Intelligence

## Architecture Overview

### Shared Contracts (`shared/`)
- `shared/customer-ai.ts`: canonical types and enums for assistants, routing modes, user AI preferences, customer quota coach, and admin anomaly radar.
- `shared/user-access.ts`: optional `routingMode`, `assistantId`, `assistantSlug`, `assistantName` fields on `UserApiKey`.
- `shared/guest-access.ts`: `view_assistants` guest permission entry.

### Database (`server/src/db/`)
- Migration `20261118_030000_custom_customer_ai_hub.ts` registered in `server/src/db/migrate/defaults.ts`:
  - `custom_ai_assistants` table + 4 seeded starter assistants (`code-reviewer`, `fast-pair-coder`, `sql-api-architect`, `bilingual-tech-writer`).
  - `custom_user_ai_preferences` table (`user_id`, `custom_instructions`, `apply_to_keys`, `updated_at`).
  - `user_api_keys.routing_mode` (`TEXT NOT NULL DEFAULT 'default'`) and `user_api_keys.assistant_id` (`INTEGER`).

### Server Modules (`server/src/custom/customer-ai/`)
- `store.ts`: CRUD for assistants, role-filtered customer/guest reads (excluding `systemPrompt`), user preferences, per-key routing/assistant updates, bulk Eco switch.
- `runtime.ts`: `routingModeToPreset`, `composeUserKeySystemPrompt`, `customerAiSessionRoutingMiddleware`, `chatWithAssistant` loopback inference over `/v1/chat/completions` with per-user RPM + usage quota enforcement.
- `coach.ts`: `buildCustomerQuotaCoach` (per-user deterministic insights) and `buildAdminAnomalyRadar` (24h vs. 7d baseline spike/error/non-Eco detection).
- `router.ts`: `customerAiUserRouter` (`/api/user/ai-hub/*`) and `customerAiAdminRouter` (`/api/ai-platform/customer-assistants*`, `/api/ai-platform/anomaly-radar*`).

### Minimal Upstream Hook Points
- `server/src/lib/client-context.ts`: `keyRoutingPreset` request-scoped context field.
- `server/src/services/router.ts`: honor `getClientContext().keyRoutingPreset` in `effectiveRoutingStrategy()` and `routeRequest()`.
- `server/src/services/user-keys.ts` & `server/src/routes/user-keys.ts`: hydrate key routing mode and composed system prompt on `validateUserApiKey`, join assistant metadata in `listUserApiKeys`, and accept optional routing/assistant options when minting keys.
- `server/src/middleware/user-rate-limit.ts`: attach `keyRoutingPreset` for `sk-flm-` keys.
- `server/src/lib/system-prompt.ts`: pass `valid.systemPrompt` through `resolveAuth()` for `'user'` keys.
- `server/src/services/guest-access.ts`: allow `GET /api/user/ai-hub/catalog` when guest has `view_assistants`.
- `server/src/custom/ai-platform/permissions.ts` & `router.ts`: map leaf permissions and mount `customerAiAdminRouter`.
- `server/src/custom/register.ts`: mount `customerAiSessionRoutingMiddleware` and `customerAiUserRouter`.

### Client Modules (`client/src/custom/customer-ai/`)
- `api.ts`, `QuotaCoachCard.tsx`, `AssistantChatDrawer.tsx`, `AdminCustomerAiPanel.tsx`, `CustomerAiHubPage.tsx`.
- Minimal integrations in `MemberKeysView.tsx`, `GuestShell.tsx`, `AiPlatformApp.tsx`, `lazy-pages.ts`, `App.tsx`, and `client/src/custom/i18n/vi.ts`.
