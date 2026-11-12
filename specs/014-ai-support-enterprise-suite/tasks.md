# Tasks: AI Support Enterprise Suite (`014-ai-support-enterprise-suite`)

## Phase 1: Parallel Backend Core Modules (Agent 1 & Agent 2)

- [ ] **T001 [P] [Agent 1]** Implement `server/src/custom/x-gateway/support-knowledge.ts` with Knowledge Base CRUD, 1-click seeding (`seedDefaultSupportKnowledgeDocs`), role-filtered BM25/keyword chunk search (`searchSupportKnowledge`), prompt builder (`buildSupportKnowledgeContextPrompt`), and recursive PII Masking Engine (`getSupportMaskingPolicy`, `updateSupportMaskingPolicy`, `maskSupportSensitiveText`, `maskSupportSensitiveData`).
- [ ] **T002 [P] [Agent 1]** Write unit test suite `server/src/__tests__/custom/x-support-knowledge.test.ts` covering role-scoped RAG isolation (`guest` vs `customer` vs `staff` vs `admin`), built-in PII detectors (`email`, `phone`, `credit_card`, `api_key`), custom regex rules, and `unmaskedRoles` bypass.
- [ ] **T003 [P] [Agent 2]** Implement `server/src/custom/x-gateway/support-workflows.ts` with Persistent Conversations (`createOrAppendSupportConversation`, `getSupportConversationForUser`, `addHumanAgentReply`), Human Escalation Tickets (`createSupportEscalationTicket`, `updateSupportEscalationTicket`), Approval-Gated Pending Actions (`proposeSupportPendingAction`, `reviewSupportPendingAction`), and SLA Analytics (`getSupportAnalyticsSummary`).
- [ ] **T004 [P] [Agent 2]** Write unit test suite `server/src/__tests__/custom/x-support-workflows.test.ts` covering conversation ownership isolation (`403` on cross-user access), human agent reply & auto-resolve, ticket creation/status transitions, action approval/rejection lifecycle, and SLA deflection rate calculation.

## Phase 2: Enterprise Support Router & Web UI (Agent 3 & Agent 4)

- [ ] **T005 [P] [Agent 3]** Implement `server/src/custom/x-gateway/support-enterprise-router.ts` (`xSupportEnterpriseConsoleRouter` & `xSupportEnterprisePublicRouter`) and mount in `server/src/custom/x-gateway/console-router.ts` and `server/src/custom/x-gateway/router.ts`.
- [ ] **T006 [P] [Agent 3]** Write integration test suite `server/src/__tests__/custom/x-support-enterprise.test.ts` testing Console endpoints (`/knowledge`, `/masking`, `/conversations`, `/tickets`, `/actions`, `/analytics`) and Partner endpoints (`/x/v1/support/knowledge/query`, `/conversations`, `/escalate`, `/actions/propose`).
- [ ] **T007 [P] [Agent 4]** Implement bilingual strings in `client/src/custom/x-gateway/support-enterprise-strings.ts` and 5-tab Web UI in `client/src/custom/x-gateway/pages/SupportEnterprise.tsx`, mounted at `/x/support-ops` in `client/src/custom/x-gateway/XGatewayApp.tsx`.
- [ ] **T008 [P] [Agent 4]** Write component test suite `client/src/custom/x-gateway/support-enterprise.test.tsx` verifying all 5 tabs (*Knowledge Base & Role RAG*, *PII & Data Masking*, *Live Inbox & Escalation Tickets*, *Action Approvals*, *Support Analytics*).
