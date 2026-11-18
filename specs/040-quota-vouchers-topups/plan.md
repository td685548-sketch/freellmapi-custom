# Implementation Plan: Self-Service Quota Redeem Vouchers & 1-Click Top-Up Requests

**Branch**: `feat/040-quota-vouchers-topups` | **Date**: 2026-11-18 | **Spec**: [`spec.md`](./spec.md)

**Input**: Feature specification from `/specs/040-quota-vouchers-topups/spec.md`

## Summary

Implement `New-API`-inspired self-service Quota Redeem Vouchers (`custom_quota_vouchers`, `custom_quota_voucher_redemptions`) and 1-Click Member Quota Top-Up Requests (`custom_quota_topup_requests`) as an isolated custom module under `server/src/custom/quota-vouchers/` and `client/src/custom/quota-vouchers/`, backed by shared TypeScript contracts in `shared/quota-vouchers.ts` and reversible SQLite migration `20261118_200000_custom_quota_vouchers_topups.ts`.

## Technical Context

**Language/Version**: TypeScript 5.8+, Node.js >= 20.18.0 (ESM `"type": "module"`)

**Primary Dependencies**: Express 5, `better-sqlite3`, Zod 4, React, TanStack Query, Tailwind CSS, Lucide Icons

**Storage**: SQLite (`custom_quota_vouchers`, `custom_quota_voucher_redemptions`, `custom_quota_topup_requests`, stacking into `custom_usage_quotas` and notifying via `custom_notifications`)

**Testing**: Vitest (`server/src/__tests__/custom/quota-vouchers.test.ts` and `npm run test:migrations`)

**Target Platform**: Web service + React SPA monorepo (`shared`, `server`, `client`, `cli`)

**Project Type**: Full-stack TypeScript monorepo custom module

**Performance Goals**: Single synchronous SQLite `IMMEDIATE` transaction (< 2ms local WAL) per voucher redemption or top-up approval; immediate in-memory `usage-quotas` cache update via `setQuota`.

**Constraints**: Zero-Conflict Modular Design — do NOT modify `PERMISSION_GATES` in `server/src/custom/register.ts` or shared i18n files; enforce RBAC inside `quotaVouchersRouter`.

**Scale/Scope**: Multi-user gateway deployments supporting member self-service redemptions, spam-guarded top-up requests, and 1-click operator review.

## Constitution Check

- **I. Security & Credential Protection**: No credentials logged or exposed; `assertCanManageAccount` prevents privilege escalation; `requireAuth` + non-guest session enforcement + `requireActionPermission` RBAC enforced on every route.
- **II. Monorepo Architecture**: DTOs in `shared/quota-vouchers.ts`, backend service/router in `server/src/custom/quota-vouchers/`, React components & strings in `client/src/custom/quota-vouchers/`.
- **III. Robustness**: Atomic `db.transaction(...).immediate()` prevents double-redemption, over-redemption, duplicate pending top-ups, and double-approval races; reversible migration with `// DOWN: reversible`.
- **IV. Test-First & Quality Verification**: Covered by `quota-vouchers.test.ts`, `npm run test:migrations`, `npm run lint`, and `npm run build`.
- **V & VI. Backward Compatibility & Zero-Conflict Modular Design**: Single 1-line mount at the end of `registerCustomRoutes` in `server/src/custom/register.ts`, compact member controls in `QuotaCoachCard.tsx`, and admin panels in `InvitesPage.tsx`.

## Project Structure

### Documentation (this feature)

```text
specs/040-quota-vouchers-topups/
├── spec.md
└── plan.md
```

### Source Code (repository root)

```text
shared/
└── quota-vouchers.ts

server/src/
├── db/
│   ├── migrate/defaults.ts                                           # 1-line registration
│   └── migrations/20261118_200000_custom_quota_vouchers_topups.ts    # Reversible DDL
├── custom/
│   ├── register.ts                                                   # 1-line router mount
│   └── quota-vouchers/
│       ├── service.ts                                                # Atomic SQLite transactions & quota stacking
│       └── router.ts                                                 # Express router + RBAC guards + Zod schemas
└── __tests__/
    ├── custom/quota-vouchers.test.ts                                 # End-to-end & concurrency/RBAC tests
    └── db/migrate/roundtrip.test.ts                                  # 1-line migration list entry

client/src/custom/
├── customer-ai/QuotaCoachCard.tsx                                    # Compact [Redeem Code] + [Request Top-Up] + badge
├── InvitesPage.tsx                                                   # Embedded admin panels for vouchers & top-up requests
└── quota-vouchers/
    ├── api.ts
    ├── strings.ts
    ├── RedeemVoucherBox.tsx
    ├── TopUpRequestModal.tsx
    ├── AdminVouchersPanel.tsx
    └── AdminTopUpRequestsPanel.tsx
```

**Structure Decision**: Follows FreeLLMAPI custom-extension architecture (`server/src/custom/<feature>/` + `client/src/custom/<feature>/` + `shared/<feature>.ts`) to keep upstream merge touchpoints minimal.
