# Tasks: Tenant Admin Portal & Granular Multi-Tenant RBAC (Spec 027)

- [x] **Phase 1 — Setup & Shared Contracts**
  - [x] T001 Create isolated worktree `027-tenant-admin-portal` from `origin/main` and install dependencies
  - [x] T002 Create `specs/027-tenant-admin-portal/{spec,plan,tasks}.md`
  - [x] T003 Create `shared/tenant-rbac.ts` and update `shared/user-access.ts`

- [x] **Phase 2 — Database Migration**
  - [x] T004 Create `server/src/db/migrations/20261118_043000_custom_tenant_rbac.ts`
  - [x] T005 Register migration in `server/src/db/migrate/defaults.ts` and `server/src/__tests__/db/migrate/roundtrip.test.ts`
  - [x] T006 Verify `npm run test:migrations` passes cleanly

- [x] **Phase 3 — Backend RBAC & Tenant Portal API**
  - [x] T007 Implement `server/src/custom/tenant-portal/store.ts`
  - [x] T008 Implement `server/src/custom/tenant-portal/admin-router.ts`
  - [x] T009 Implement `server/src/custom/tenant-portal/router.ts`
  - [x] T010 Hook `tenantPortalAccess` into `server/src/routes/user-keys.ts` and mount routers in `server/src/custom/register.ts`

- [x] **Phase 4 — Frontend UI & Bilingual Translations**
  - [x] T011 Implement `client/src/custom/TenantAccessDialog.tsx` and hook button into `client/src/custom/UsersPage.tsx`
  - [x] T012 Implement `client/src/custom/tenant-portal/` (`api.ts`, `TenantPortalApp.tsx`, 8 tab components)
  - [x] T013 Wire lazy route & navbar entry in `client/src/custom/route-splitting/lazy-pages.ts` and `client/src/App.tsx`
  - [x] T014 Add complete Vietnamese translations in `client/src/custom/i18n/vi.ts`

- [x] **Phase 5 — Tests & Full CI Verification**
  - [x] T015 Add `server/src/__tests__/custom/tenant-rbac.test.ts`
  - [x] T016 Add `client/src/custom/tenant-portal/tenant-portal.test.tsx`
  - [x] T017 Run migrations, lint, client tests, server tests, full build, and full test suite
  - [x] T018 Commit, push `feat/027-tenant-admin-portal`, and open Pull Request targeting `main`
