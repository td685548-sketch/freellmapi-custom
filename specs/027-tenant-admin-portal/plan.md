# Implementation Plan: Tenant Admin Portal & Granular Multi-Tenant RBAC (Spec 027)

## Architecture Overview

1. **Shared RBAC Contract (`shared/tenant-rbac.ts`)**:
   - Defines `TENANT_PERMISSION_GROUPS` across 8 functional areas (20 granular leaf permissions + 8 group permissions + wildcard `*`).
   - Defines 4 built-in role presets (`tenant_owner`, `ai_configurator`, `support_operator`, `viewer`) plus `custom`.
   - Exports deterministic permission evaluation, group visibility, preset inference, stored JSON parsing, and UI checkbox selection helpers shared by server and client.
   - Adds `tenantPortalAccess?: { tenantCount: number; isPlatformOperator: boolean }` to `UserSession` in `shared/user-access.ts`.

2. **Database Layer (`server/src/db/migrations/20261118_043000_custom_tenant_rbac.ts`)**:
   - Creates `custom_tenant_memberships (id, tenant_id, user_id, role_preset, permissions_json, assigned_by, created_at, updated_at)` with `UNIQUE(tenant_id, user_id)` and lookup indexes.
   - Completely reversible (`down()` drops indexes and table cleanly) and avoids DDL foreign-key reference to lazily initialized `x_support_tenants`.

3. **Backend Store & Enforcement (`server/src/custom/tenant-portal/`)**:
   - `store.ts`: Tenant access resolution (`resolveEffectiveTenantAccess`, `assertTenantPermission`), fail-closed `404 tenant_not_found` for unassigned tenants, `403 forbidden` for missing leaf permissions, `noBroaderThan` anti-escalation checks for both Platform Admins and Tenant Admins (`manage_tenant_members`), and safe combo/model listing (`listSafeTenantModelOptions`).
   - `admin-router.ts`: Mounted at `/api/admin/tenant-memberships` for Platform Admins on `/users`.
   - `router.ts`: Mounted at `/api/tenant-portal` providing strictly tenant-scoped endpoints for AI config, Knowledge & Masking, Tools & DB, Guardrails & Output Controls, Widget & Service Desk, Integration & Secret Rotation, Team Members, and Analytics/CSAT/Audit. Every mutating request logs to `appendSupportAuditLog`.

4. **Frontend UI (`client/src/custom/`)**:
   - `TenantAccessDialog.tsx` + minimal hook in `UsersPage.tsx`: Platform Admin assignment modal.
   - `tenant-portal/`: Modular React SPA mounted at `/tenant-portal/*` with `TenantPortalApp.tsx`, 8 permission-gated tab modules, and `My Permissions` badge/inspector.
   - Minimal hooks in `client/src/custom/route-splitting/lazy-pages.ts`, `client/src/App.tsx`, and `client/src/custom/i18n/vi.ts`.
