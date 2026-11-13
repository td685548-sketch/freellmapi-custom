# Quickstart: AI Support Governance, Customer Memory CRM & Outbound Partner Webhooks (`015-ai-support-governance-and-automation`)

## 1. Run Backend & Frontend Tests

```bash
# Agent 1: Prompt Firewall, Topic Guardrails & Per-Role Quotas
cd server && npx vitest run src/__tests__/custom/x-support-guardrails.test.ts

# Agent 2: Customer CRM Memory, CSAT & Outbound Partner Webhooks
cd server && npx vitest run src/__tests__/custom/x-support-crm-webhooks.test.ts

# Agent 3: Support Governance Console & Partner Router
cd server && npx vitest run src/__tests__/custom/x-support-governance.test.ts

# Agent 4: Support Governance & CRM Studio Web UI (/thruline/support-guardrails)
cd client && npx vitest run src/custom/x-gateway/support-governance.test.tsx && npx tsc -b
```

## 2. Lint & Full Workspace Build

```bash
npm run lint
npm run build
```
