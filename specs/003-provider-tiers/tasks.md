# Tasks: Provider tiers

## Setup
- [x] T001 Create spec/design/contracts in specs/003-provider-tiers/.

## US1: Compare providers
- [x] T002 [US1] Add regression tests in server/src/__tests__/custom/provider-tiers.test.ts for ranking, missing axes and permission enforcement.
- [x] T003 [US1] Define nullable [0,1] metrics and S/A/B/C/D-or-null tiers in shared/provider-tiers.ts.
- [x] T004 [US1] Implement bulk aggregation in server/src/services/provider-tiers.ts and validated route in server/src/routes/provider-tiers.ts; mount in server/src/custom/register.ts.

## US2: Linked keys
- [x] T005 [US2] Test independent endpoint counts and disabled keys in server/src/__tests__/custom/provider-tiers.test.ts.
- [x] T006 [US2] Add count badges, sample/metric display and loading/error states in client/src/custom/ProviderTiersPanel.tsx; render in client/src/pages/AnalyticsPage.tsx.
- [x] T007 [US2] Test panel counts, missing data and denied-session behavior in client/src/custom/ProviderTiersPanel.test.tsx.

## Verification
- [x] T008 Run tests/build/lint and document outcomes and the Linux CI merge requirement in specs/003-provider-tiers/quickstart.md.
