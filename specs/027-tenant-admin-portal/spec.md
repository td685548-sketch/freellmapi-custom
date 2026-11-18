# Feature Specification: Tenant Admin Portal & Granular Multi-Tenant RBAC

**Feature Branch**: `feat/027-tenant-admin-portal`
**Created**: 2026-11-18
**Status**: Completed

## Problem Statement

FreeLLMAPI supports multiple external organizations through **Support Tenants** (`x_support_tenants`), where each tenant owns its AI model selector, system prompt, end-user RBAC roles, knowledge base & PII masking, webhook tools & database connectors, input guardrails & output controls, embeddable widget, and service desk. Previously, configuring any Support Tenant required platform-level `manage_x_gateway` / Thruline console privileges — exposing all tenants, provider API keys, outbound proxies, and global gateway settings.

Partner Tenant Admins and their delegated staff need a dedicated, isolated **`/tenant-portal`** workspace on the web app to configure and operate **only their assigned Support Tenant(s)** under explicit, fine-grained per-tenant permissions.

## User Stories

### US1 — Platform Admin Tenant Assignment (`/users`)
- As a Platform Administrator (`isPrimary`, `*`, `manage_x_gateway`, `use_x_gateway` + `edit_x_settings`, or `edit_user_permissions` / `view_users`), I can open a **Tenant AI** modal on any non-primary account in `/users` to assign one or more Support Tenants with a role preset (`Tenant Owner`, `AI Configurator`, `Support Operator`, `Viewer`) or fine-grained per-tenant leaf permissions, or revoke tenant access.

### US2 — Isolated Tenant Admin Portal (`/tenant-portal`)
- As an account with at least one tenant membership (or a Platform Tenant Operator), I see a **Tenant AI** tab in the main navbar linking to `/tenant-portal`.
- Inside `/tenant-portal`, I only see tenants I am assigned to (unless I am a Platform Tenant Operator), and only the tabs/controls for which I hold explicit permissions. Global provider credentials, proxy settings, and other tenants are completely hidden and inaccessible.

### US3 — Granular AI Configuration, Knowledge, Tools, Guardrails, Widget & Integration
- Each tenant capability group maps to explicit backend-enforced permissions (`view_*`, `edit_*`, `test_*`, `reply_*`, `rotate_tenant_secret`):
  - **AI & Prompt**: Model selection (safe `auto` + chat combos + custom selector), system prompt, guest access, enabled flag, end-user role matrix (`rolesConfig`), and live chat simulation.
  - **Knowledge & Masking**: Knowledge documents CRUD, default seed, RAG search test, and PII masking rules.
  - **Tools & Data**: Webhook tools and database sources CRUD + test runners.
  - **Guardrails & Output**: Prompt firewall, blocked topics, per-role quotas, quota reset, output controls (`off`/`log`/`enforce`, `maxOutputChars`, `redactCredentials`, `blockedTerms`), live preview, and output audit events.
  - **Widget & Service Desk**: Customer conversations, human replies, ticket triage, pending AI action approvals, widget appearance/intake, and SLA policies.
  - **Integration & Keys**: Public key, embed `<script>` snippet, CORS allowed origins, runtime bounds, outbound partner webhooks, and signing secret rotation (`rotate_tenant_secret`).
  - **Analytics & Audit**: Conversation deflection metrics, CSAT summary/ratings, and per-tenant audit log history.

### US4 — Delegated Sub-Member Management Inside a Tenant
- As a Tenant Member granted `manage_tenant_members` on Tenant A, I can invite/assign existing platform accounts to Tenant A, choose a preset or granular checkboxes, edit sub-members, and remove sub-members.
- **Anti-escalation invariants**:
  - A Tenant Admin can NEVER grant a permission on Tenant A that they do not personally hold on Tenant A (including `*`).
  - A Tenant Admin can NEVER alter or remove a member on Tenant A who holds broader authority than the actor holds.
  - Nobody can edit or remove their own membership via self-service delegation, and Primary Admin accounts cannot be altered.
  - Cross-tenant access attempts (`GET`/`POST`/`PUT`/`PATCH`/`DELETE` on another tenant's ID) ALWAYS fail closed with `404 tenant_not_found`.

## Non-Functional & Compliance Requirements
- **Zero-Conflict Modularity**: All new backend logic lives in `server/src/custom/tenant-portal/`, shared contracts in `shared/tenant-rbac.ts`, UI in `client/src/custom/tenant-portal/` and `client/src/custom/TenantAccessDialog.tsx`, and schema in a new reversible migration `20261118_043000_custom_tenant_rbac.ts`.
- **No Plaintext Secret Leakage**: `GET /api/tenant-portal/tenants` and model pickers never expose `sk_sup_…` signing secrets, DB auth tokens, or upstream provider keys; `rotate-secret` requires `rotate_tenant_secret` and returns the new secret once.
- **Bilingual i18n**: Every `tc('...')` literal in `client/src/custom/` has a matching Vietnamese entry in `client/src/custom/i18n/vi.ts`.
