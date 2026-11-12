# Tasks: AI Support Governance, Customer Memory CRM & Outbound Partner Webhooks (`015-ai-support-governance-and-automation`)

## Phase 1: Parallel Backend Core Modules (Agent 1 & Agent 2)

- [ ] **T001 [P] [Agent 1]** Implement `server/src/custom/x-gateway/support-guardrails.ts` with `getSupportGuardrailPolicy`, `updateSupportGuardrailPolicy`, `evaluateSupportInputGuardrails` (`ignore_instructions`, `role_spoofing`, `system_prompt_leak`, `sql_injection_probe`, `blockedTopics`, `competitorKeywords`, `maxInputLength`, `bypassRoles`), and per-role user quota tracking (`getSupportUserQuotaStatus`, `checkAndConsumeSupportUserQuota`, `resetSupportUserQuota`).
- [ ] **T002 [P] [Agent 1]** Write unit test suite `server/src/__tests__/custom/x-support-guardrails.test.ts` (at least 16 tests) covering prompt injection detection, role bypass, blocked topics, competitor keywords, and per-role request/token quota enforcement.
- [ ] **T003 [P] [Agent 2]** Implement `server/src/custom/x-gateway/support-crm-webhooks.ts` with Customer CRM Profiles & Long-Term Memory (`upsertSupportCustomerProfile`, `getSupportCustomerProfileForRequester`, `appendCustomerMemoryFact`, `buildCustomerMemoryPrompt`), CSAT Ratings (`submitSupportCsatRating`, `listSupportCsatRatings`, `getSupportCsatSummary`), and Outbound Partner Event Webhooks (`upsertSupportWebhookSubscription`, `dispatchSupportPartnerEvent`, `listSupportWebhookDeliveries`).
- [ ] **T004 [P] [Agent 2]** Write unit test suite `server/src/__tests__/custom/x-support-crm-webhooks.test.ts` (at least 18 tests) covering CRM profile isolation (`403` on cross-user access), memory prompt building, CSAT score validation & profile average recalculation, and HMAC-SHA256 signed webhook delivery + SSRF protection.

## Phase 2: Support Governance Router & Web UI (Agent 3 & Agent 4)

- [ ] **T005 [P] [Agent 3]** Implement `server/src/custom/x-gateway/support-governance-router.ts` (`xSupportGovernanceConsoleRouter` & `xSupportGovernancePublicRouter`) and mount in `server/src/custom/x-gateway/console-router.ts` and `server/src/custom/x-gateway/router.ts`.
- [ ] **T006 [P] [Agent 3]** Write integration test suite `server/src/__tests__/custom/x-support-governance.test.ts` (at least 16 tests) covering Console endpoints (`/guardrails`, `/quotas`, `/customers`, `/csat`, `/webhooks`) and Public Partner endpoints (`/x/v1/support/guardrails/check`, `/profile`, `/csat`).
- [ ] **T007 [P] [Agent 4]** Implement bilingual strings in `client/src/custom/x-gateway/support-governance-strings.ts` and 5-tab Web UI in `client/src/custom/x-gateway/pages/SupportGovernance.tsx`, mounted at `/x/support-guardrails` in `client/src/custom/x-gateway/XGatewayApp.tsx`.
- [ ] **T008 [P] [Agent 4]** Write component test suite `client/src/custom/x-gateway/support-governance.test.tsx` using native `createRoot` (`react-dom/client`) and `act` (`react`) (NO `@testing-library/react` import) verifying all 5 tabs.
