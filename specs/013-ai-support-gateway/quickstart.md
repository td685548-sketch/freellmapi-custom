# Quickstart & Verification (`013-ai-support-gateway`)

## 1. Chạy kiểm thử từng Agent

```bash
# Agent 1: Store & Signed User Context
npx vitest run server/src/__tests__/custom/x-support-store.test.ts

# Agent 2: Webhook & Read-Only RBAC SQL Connectors
npx vitest run server/src/__tests__/custom/x-support-connectors.test.ts

# Agent 3: Console API, Public /x/v1/support/* & Widget JS
npx vitest run server/src/__tests__/custom/x-support-gateway.test.ts

# Agent 4: Frontend Web UI (/x/support)
cd client && npx vitest run src/custom/x-gateway/support-gateway.test.tsx
```

## 2. Kiểm tra Lint & Build toàn dự án

```bash
npm run lint
npm run build
```
