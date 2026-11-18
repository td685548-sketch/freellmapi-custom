# Feature Specification: Self-Service Quota Redeem Vouchers & 1-Click Top-Up Requests

**Feature Branch**: `feat/040-quota-vouchers-topups`

**Created**: 2026-11-18

**Status**: Implemented

**Input**: Spec 040 — Redeemable Quota Vouchers / Gift Codes (`New-API` inspired) and 1-Click Member Quota Top-Up Requests with Admin 1-Click Approval.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Member Self-Service Quota Voucher Redemption (Priority: P1)

Signed-in members can redeem promotional or team gift codes (e.g. `GIFT-ABCD-1234`) directly from their Quota Coach card on the Personal API Keys page to immediately receive stacked daily/monthly request and token bonus allowances without waiting for manual admin intervention.

**Why this priority**: Eliminates manual quota adjustments for hackathons, onboarding cohorts, and burst sprints while enforcing strict atomic single-use-per-user and global redemption caps.

**Independent Test**: Create a voucher via admin API, redeem as a member with Starter Quota (and as an uncapped member), verify atomic allowance stacking in `custom_usage_quotas`, and verify duplicate/expired/inactive/exhausted redemptions are rejected.

**Acceptance Scenarios**:

1. **Given** an active, non-expired voucher with `redeemed_count < max_redemptions`, **When** a signed-in member posts `{ code }` to `POST /api/quota-vouchers/redeem`, **Then** `redeemed_count` increments atomically, a `custom_quota_voucher_redemptions` record is inserted, and bonus allowances stack onto the member's `custom_usage_quotas` row (preserving unlimited `null` dimensions on already-tracked accounts, or creating a new row cleanly if none existed).
2. **Given** a member has already redeemed a voucher, **When** the same member submits the same code again (including lowercase/padded variants), **Then** the server rejects the request with `409 Conflict` (`voucher_already_redeemed`) and leaves quotas untouched.
3. **Given** a voucher is inactive, expired, or has `redeemed_count >= max_redemptions`, **When** a member attempts redemption, **Then** the server rejects the request and performs zero state changes.

---

### User Story 2 - 1-Click Member Quota Top-Up Requests & Admin 1-Click Review (Priority: P2)

Members running low on daily request or token allowances can submit a 1-click Top-Up Request with preset or custom daily boosts and a brief reason. Operators holding `manage_users` or `manage_invites` can review pending requests and 1-click Approve (with editable grant overrides) or Reject, automatically stacking the approved quota and sending an in-app notification.

**Why this priority**: Provides a structured, spam-resistant self-service escalation path inside the dashboard instead of ad-hoc out-of-band chat messages.

**Independent Test**: Submit a top-up request as a member, verify a second concurrent pending request is blocked (`409`), approve as admin with custom grant overrides, and verify `custom_usage_quotas` increments atomically alongside a `custom_notifications` entry.

**Acceptance Scenarios**:

1. **Given** a signed-in member has no open `pending` top-up request, **When** they submit a top-up request, **Then** a `pending` row is created in `custom_quota_topup_requests` and visible in their pending status badge.
2. **Given** a member already has an open `pending` top-up request, **When** they attempt to submit another, **Then** the server rejects with `409 Conflict` (`pending_topup_exists`).
3. **Given** a `pending` top-up request, **When** an authorized admin approves it (with default or edited grant amounts), **Then** the request transitions to `approved`, the member's quota increases atomically, and an in-app notification is recorded in `custom_notifications` (when present).

---

### User Story 3 - Bilingual (VI/EN) Dashboard Controls & Strict RBAC Isolation (Priority: P3)

Members access compact `[Redeem Code]`, `[Request Top-Up]`, and live pending request status badges inside `QuotaCoachCard.tsx`, while operators manage vouchers and top-up requests inside `InvitesPage.tsx`, fully localized in English and Vietnamese.

**Why this priority**: Seamless discoverability in existing member and operator workflows without touching shared i18n dictionaries or `PERMISSION_GATES`.

**Independent Test**: Verify regular members receive `403 Forbidden` on all admin voucher/top-up endpoints, and verify full TypeScript + Vite client build passes cleanly.

**Acceptance Scenarios**:

1. **Given** a non-admin member without `manage_invites` or `manage_users`, **When** calling admin voucher or admin top-up endpoints, **Then** `403 Forbidden` is returned.
2. **Given** UI locale set to `vi` or `en`, **When** viewing member or admin voucher/top-up panels, **Then** all labels, statuses, and actions render in the active locale from `client/src/custom/quota-vouchers/strings.ts`.

---

### Edge Cases

- Concurrent redemptions on the final slot (`max_redemptions = 1`): Serialized via SQLite `IMMEDIATE` transaction + conditional `UPDATE ... WHERE redeemed_count < max_redemptions` + `UNIQUE(voucher_id, user_id)`.
- Case/whitespace variations in voucher codes (`"  gift-2026  "`): Normalized to trimmed uppercase (`"GIFT-2026"`) on both creation and redemption.
- Stacking onto Starter Quota with `monthlyRequests: null` (unlimited): Preserves `null` on already-tracked unlimited dimensions so redeeming a voucher never shrinks an unlimited window into a finite cap, while cleanly creating the `custom_usage_quotas` row when the user was previously untracked.
- Missing `custom_notifications` table in minimal DB fixtures: Checked via `sqlite_master` before notification insertion so approval never fails.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST persist vouchers in `custom_quota_vouchers`, per-user redemptions in `custom_quota_voucher_redemptions` (`UNIQUE(voucher_id, user_id)`), and top-up requests in `custom_quota_topup_requests` via reversible migration `20261118_200000_custom_quota_vouchers_topups.ts`.
- **FR-002**: System MUST execute voucher redemption inside a single atomic SQLite `IMMEDIATE` transaction updating `redeemed_count`, inserting the redemption record, and stacking allowances in `custom_usage_quotas` (plus refreshing `usage-quotas` cache).
- **FR-003**: System MUST limit each member to at most 1 open `pending` top-up request at a time, enforced both in service validation and via a partial unique index `WHERE status = 'pending'`.
- **FR-004**: System MUST enforce `requireAuth` and `manage_invites` / `manage_users` (plus appropriate leaf capabilities) inside `quotaVouchersRouter` without altering `PERMISSION_GATES` in `server/src/custom/register.ts`.
- **FR-005**: System MUST deliver localized VI/EN UI components inside `client/src/custom/quota-vouchers/` with minimal integration hooks in `QuotaCoachCard.tsx` and `InvitesPage.tsx`.

### Key Entities

- **QuotaVoucher (`custom_quota_vouchers`)**: Normalized uppercase gift code, label, daily/monthly request & token bonuses, max redemptions, redeemed count, optional UTC expiry, active flag, creator metadata.
- **QuotaVoucherRedemption (`custom_quota_voucher_redemptions`)**: Immutable ledger linking `voucher_id` and `user_id` with unique constraint preventing double redemption.
- **QuotaTopUpRequest (`custom_quota_topup_requests`)**: Member-submitted daily token/request boost request with `pending` | `approved` | `rejected` lifecycle, reviewer audit metadata, and admin note.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 duplicate redemptions or over-redemptions possible under sequential or concurrent requests.
- **SC-002**: 100% of unit, integration, RBAC, and roundtrip migration tests pass (`quota-vouchers.test.ts` + `npm run test:migrations`).
- **SC-003**: Zero modifications to `PERMISSION_GATES` or shared i18n dictionaries; `npm run lint` and `npm run build` succeed cleanly.

## Assumptions

- Allowances stack onto `custom_usage_quotas` (`subject_kind = 'user'`) managed by `server/src/services/usage-quotas.ts` and capped at `MAX_QUOTA_VALUE` (`1,000,000,000,000`).
- Operators managing either invitations (`manage_invites`) or user accounts/quotas (`manage_users` / `edit_user_quotas`) are authorized to administer vouchers and review top-up requests, subject to `assertCanManageAccount` hierarchy checks when modifying another user's quota.
