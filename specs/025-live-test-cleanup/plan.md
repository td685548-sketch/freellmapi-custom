# Implementation Plan: Live Test Sandbox Tagging & Cleanup (Spec 025)

1. Extend `@freellmapi/shared/support-service-desk-live-test` with `SupportLiveTestSandboxStats` and `SupportLiveTestSandboxCleanupResponse`.
2. Add standalone `server/src/custom/x-gateway/support-live-test-sandbox.ts` using Node `AsyncLocalStorage` (`runWithLiveTestContext`, `isInLiveTestContext`, `isLiveTestConversation`, `recordLiveTestIntakeRequest`, `getLiveTestSandboxStats`, `purgeLiveTestSandboxData`) with zero circular imports.
3. Minimal touch points in `support-workflows.ts` and `support-crm-webhooks.ts` to stamp `isLiveTest: true` server-side and exclude live-test records from production analytics/CSAT/CRM rollups while preserving active Copilot/Queue visibility until cleanup.
4. Wire `GET`/`DELETE /sandbox` and `runWithLiveTestContext` bridge execution in `support-service-desk-live-test-router.ts`.
5. Add EN/VI strings in `support-service-desk-live-test-strings.ts` and `live-test-sandbox-panel` UI in `SupportWidgetLiveTest.tsx`.
6. Cover server isolation + cleanup in `x-support-live-test-sandbox.test.ts` and UI counts/cleanup in `support-service-desk-live-test.test.tsx`.
