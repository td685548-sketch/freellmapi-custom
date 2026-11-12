# Implementation Plan: AI Support Governance, Customer Memory CRM & Outbound Partner Webhooks (`015-ai-support-governance-and-automation`)

**Branch**: `feat/9router-integration` | **Date**: 2026-11-12 | **Spec**: `specs/015-ai-support-governance-and-automation/spec.md`

## 1. Summary

Extend the Multi-Tenant AI Support Gateway (`013` & `014`) with 4 enterprise governance and CRM automation modules built in parallel by 4 agents with zero file overlap:
1. **Prompt Injection Firewall, Topic Guardrails & Per-Role Quotas** (`support-guardrails.ts`): Detect prompt injection / role-spoofing / system-prompt leak / SQL-probe patterns, enforce blocked topics & competitor keywords, and track sliding/fixed window request + token quotas per `(tenantId, userId)` according to `roleQuotas`.
2. **Customer CRM Profiles, Long-Term Memory, CSAT Ratings & Outbound Partner Webhooks** (`support-crm-webhooks.ts`): Store per-customer CRM profiles (`memoryFacts`, `tier`, `tags`, `customAttributes`) with strict `userId` isolation, record 1–5 star CSAT ratings (`SupportCsatRating`), and dispatch HMAC-SHA256 signed outbound partner webhooks (`dispatchSupportPartnerEvent`) with delivery logs (`SupportWebhookDelivery`).
3. **Support Governance, CRM & Outbound Webhook Router** (`support-governance-router.ts`): Expose Admin Console routes (`/api/x-gateway/support/tenants/:id/guardrails|quotas|customers|csat|webhooks`) and Partner Public routes (`/x/v1/support/guardrails/check|profile|csat`).
4. **Support Governance & CRM Studio Web UI (`/x/support-guardrails`)** (`SupportGovernance.tsx`): 5-tab bilingual (EN/VI) operational studio (*Prompt Firewall & Guardrails*, *Per-Role Quotas*, *Customer CRM & Memory*, *CSAT Feedback*, *Outbound Event Webhooks*).

## 2. Technical Context

- **Language/Version**: TypeScript 5.x (Node.js 20+ backend, React 19 + Vite frontend)
- **Persistence**: `settings` key-value JSON storage via `getDb()` (`SELECT/INSERT/UPDATE settings`) using dedicated keys:
  - `x_gateway_support_guardrails_v1` (Agent 1)
  - `x_gateway_support_quotas_v1` (Agent 1)
  - `x_gateway_support_crm_v1` (Agent 2)
  - `x_gateway_support_csat_v1` (Agent 2)
  - `x_gateway_support_webhooks_v1` (Agent 2)
  - `x_gateway_support_webhook_deliveries_v1` (Agent 2)
- **Frontend Testing Constraint**: `client/src/custom/x-gateway/support-governance.test.tsx` MUST use `createRoot` from `react-dom/client` and `act` from `react` directly (never import `@testing-library/react`, which is not in `client/package.json`).
