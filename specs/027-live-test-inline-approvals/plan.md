# Implementation Plan: Inline Live-Test Pending Action Approvals (Spec 027)

1. Add `SupportLiveTestPendingActionItem`, `SupportLiveTestPendingActionsListResponse`, and `SupportLiveTestActionReviewResponse` to `shared/support-service-desk-live-test.ts` and rebuild `@freellmapi/shared`.
2. Add `linkPendingActionsToConversation` and `appendSupportActionOutcomeMessage` in `server/src/custom/x-gateway/support-workflows.ts`, call linkage in `support-runtime.ts` Step 16, and emit outcome messages on initial approve/reject completion in `support-action-executor.ts`.
3. Clean up linked `x_support_action_executions` rows in `support-live-test-sandbox.ts`, and expose live-test-scoped `GET /pending-actions` and `POST /pending-actions/:actionId/{approve,reject}` routes in `support-service-desk-live-test-router.ts`.
4. Add `syncConversation()` on the widget instance in `support-runtime-widget.ts` so operators see the outcome message immediately inside the embedded widget.
5. Add bilingual EN/VI strings in `support-service-desk-live-test-strings.ts` and inline approval cards in `SupportWidgetLiveTest.tsx` (React-Compiler clean under `lint:support-ai`).
6. Verify with new integration tests in `server/src/__tests__/custom/x-support-live-test-approvals.test.ts`, UI workflow tests in `client/src/custom/x-gateway/support-service-desk-live-test.test.tsx`, plus full `lint`, `test`, and `build`.
