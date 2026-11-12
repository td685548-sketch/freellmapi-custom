# Implementation Plan: AI Support Enterprise Suite (`014-ai-support-enterprise-suite`)

**Branch**: `feat/9router-integration` | **Date**: 2026-11-12 | **Spec**: `specs/014-ai-support-enterprise-suite/spec.md`

## 1. Summary

Extend the Multi-Tenant AI Support Gateway (`013-ai-support-gateway`) with 4 enterprise modules built in parallel by 4 agents with zero file overlap:
1. **Role-Scoped Knowledge Base (RAG) & Dynamic PII Masking Engine** (`support-knowledge.ts`): Store per-tenant Markdown knowledge docs with `allowedRoles`, perform role-filtered BM25/keyword + tag/title chunk retrieval, and redact PII (email, phone, credit card, API key, custom regex) based on the caller's role (`unmaskedRoles`).
2. **Conversation Threads, Escalation Tickets & Approval-Gated Write Actions** (`support-workflows.ts`): Persist multi-turn customer support conversations with strict `userId` ownership isolation, manage human hand-off escalation tickets (`SupportEscalationTicket`), and enforce a **Human-in-the-Loop Approval Queue** (`SupportPendingAction`) for state-changing tools (e.g., `issue_refund`, `cancel_order`) plus real-time SLA analytics (`getSupportAnalyticsSummary`).
3. **Enterprise Support Console & Partner API Router** (`support-enterprise-router.ts`): Expose Admin Console routes (`/api/x-gateway/support/tenants/:id/knowledge|masking|conversations|tickets|actions|analytics`) and Partner API routes (`/x/v1/support/knowledge/query|conversations|escalate|actions`).
4. **Support Operations Center Web UI (`/x/support-ops`)** (`SupportEnterprise.tsx`): 5-tab bilingual (EN/VI) operational dashboard for Knowledge RAG, PII Masking, Live Inbox & Escalation Tickets, Action Approvals, and SLA Analytics.

## 2. Technical Context

- **Language/Version**: TypeScript 5.x (Node.js 20+ backend, React 19 + Vite frontend)
- **Persistence**: `settings` key-value JSON storage via `getDb()` (`SELECT/INSERT/UPDATE settings`) using dedicated keys:
  - `x_gateway_support_knowledge_v1` (Agent 1)
  - `x_gateway_support_masking_v1` (Agent 1)
  - `x_gateway_support_conversations_v1` (Agent 2)
  - `x_gateway_support_tickets_v1` (Agent 2)
  - `x_gateway_support_actions_v1` (Agent 2)
- **Testing**: Vitest + Supertest (`server/src/__tests__/custom/x-support-*.test.ts`) and React Testing Library (`client/src/custom/x-gateway/support-enterprise.test.tsx`).

## 3. Architecture & Security Guardrails

- **Role Filtering Before Scoring**: `searchSupportKnowledge` MUST filter documents where `doc.enabled !== false` AND (`doc.allowedRoles.includes('*')` OR `doc.allowedRoles.includes(userRole)`) BEFORE computing relevance scores. Unauthorized documents can never leak via snippet or score.
- **Recursive PII Masking**: `maskSupportSensitiveData` recursively traverses strings, arrays, and plain objects, applying built-in and custom regex detectors unless `policy.enabled === false` or `policy.unmaskedRoles.includes(userRole)`.
- **Conversation & Action Isolation**: Customers (`role !== 'admin'` and `role !== 'staff'`) can only list or read conversations, tickets, and pending actions where `record.userId === userContext.userId`. Attempting to read another customer's conversation returns `403 Forbidden`.
