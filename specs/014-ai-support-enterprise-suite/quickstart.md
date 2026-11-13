# Quickstart: AI Support Enterprise Suite (`014-ai-support-enterprise-suite`)

## 1. Run Backend & Frontend Tests

```bash
# Agent 1: Knowledge Base & PII Masking
cd server && npx vitest run src/__tests__/custom/x-support-knowledge.test.ts

# Agent 2: Conversations, Escalation Tickets & Approval Actions
cd server && npx vitest run src/__tests__/custom/x-support-workflows.test.ts

# Agent 3: Enterprise Support Console & Public Partner Router
cd server && npx vitest run src/__tests__/custom/x-support-enterprise.test.ts

# Agent 4: Support Operations Center Web UI (/thruline/support-ops)
cd client && npx vitest run src/custom/x-gateway/support-enterprise.test.tsx
```

## 2. Lint & Full Workspace Build

```bash
npm run lint
npm run build
```
