# Security Audit Archive — 2026-11-18 (`freellmapi-custom`, `run-1`)

This directory archives the baseline security audit outputs generated using the **Cloudflare `security-audit`** skill (`run-1`, `standard` profile) together with a summary of the remediations landed on branch `fix/security-audit-remediation` targeting `main`.

## Audit Methodology & Scope

- **Audited Source Baseline**: `0c16a3aaf50629d8af180344c92c061c9122bd0a` (with target repository read-only during audit execution).
- **Remediation Base Branch**: `origin/main` (`5f73a4da`).
- **Execution Policy**: `sandboxed-source-and-local-only` on `win32`. Because the Windows host lacks an OS-enforced Linux namespace/mount sandbox, live exploit execution during audit `run-1` was omitted:
  - **Coverage Units Evaluated**: `39` (`26` candidate, `4` covered, `9` deferred post-Wave-2 stop in `standard` profile)
  - **Findings Validated**: `45` consolidated (`0` `confirmed`, `41` source-verified `needs_validation`, `4` refuted `rejected` false positives excluded from findings)

> [!NOTE]
> All host-specific filesystem paths (`<local-home>`, `<repo-root>`) have been sanitized for repository archival while preserving `coverage-ledger.json` and `findings.json` schema compliance.

## Disposition of `needs_validation` Findings (`41` Total)

- **`40 / 41` Remediated on `main` (`fix/security-audit-remediation`)**:
  - **Batch A (Auth, Registration, Logs & Gateway Ingress — 6 findings)**: Boot-time log redaction before route registration; dashboard-only redaction of one-time setup/reset/initial-key lines plus nested `Error` property/cause redaction and `console.dir`/console-stream redaction; transaction-atomic user creation + invite claim + key/session minting; Google OAuth unverified auto-link permission/key revocation and `GOOGLE_DISABLE_ADMIN_AUTO_LINK` toggle; unified `/v1beta` and `/thruline/v1beta` credential extraction, case-insensitive query parsing, disabled-gateway 404 gate, and per-user rate-limiter/attribution parity.
  - **Batch B (RBAC, Proxy Credential Masking & Input Validation — 8 findings)**: `actorCanDelegateGuestAccess` delegation ceiling; lowercase/resolved `keyId` enforcement in `guardKeyAddition`; mutating Support/Quota route mapping to `edit_x_settings`; strict positive integer `:id` regex alignment; split `autoPingRouter` routes across `test_keys` and `edit_keys`; `maskProxyUrl` and relay token guard without `reveal_proxy_credentials`.
  - **Batch C (SSRF, DNS Pinning, Redirects & Relay Auth — 6 findings)**: Per-hop DNS IP-pinning with `undici` dispatcher and manual redirect blocking across `proxyFetch`, Google image fetches, media downloads, Thruline `/web/fetch`, `playground-media.ts`, provider `baseUrl` persistence (`assertSafeHttpBaseUrlSync`), `/nodes/validate`, and serverless relay template bearer authentication.
  - **Batch D (Ollama/Protocols, Skills Cache, Quotas, Cache Scope & Image Normalization — 6 findings)**: Enabled check + auth/permission + Modelfile sanitization on Thruline Ollama endpoints; post-default and post-multer `isModelAllowedForKey` enforcement in `protocols.ts`; `PUBLIC_APP_URL` / validated `Host` / `Vary` / `private, no-store` fallback in `skills-router.ts`; mid-SSE abort token/quota settlement after headers commit; principal/profile/restriction scoping in `computeCacheKey`; `limitInputPixels` and post-resize alpha `stats()` in `image-normalize.ts`.
  - **Batch E (AI Platform, Support Isolation, Key Rotation & Backups — 8 findings)**: Fail-closed `support_tenant` retrieval role filtering in `hybrid.ts`, `retrieval/router.ts`, and `orchestrator/engine.ts`; SQL comment/CTE/subquery/parenthesized-join blocking and subquery projection for `allowedColumns` in `support-connectors.ts`; requester-role masking in `support-workflows.ts`; removal of arbitrary origin + `Access-Control-Allow-Credentials: true` reflection in `applySupportCors`; removal of dynamic tool creation and RBAC/schema fallback in `POST /actions/propose`; blocking guest writes and customer self-assigned `tier`/`tags` in `PATCH /profile` + `<untrusted_customer_profile_data>` memory framing; complete coverage in `rotate-encryption-key.ts` and `probeStoredSecrets`; string/comment-aware SQL statement allowlist validator in `backups.ts`.
  - **Batch F (Client HTML Sanitizer, Desktop IPC, CLI Doctor & CI/Deployment Hardening — 6 findings)**: Canonical lowercase attribute and URL scheme sanitization in `PlaygroundMessage.tsx`; removal of `--freeapi-token` from Electron renderer argv in favor of origin-verified IPC; `redirect: 'error'` and pre-probe `sameGateway` verification in `cli/src/doctor.ts`; least-privilege `GITHUB_TOKEN` permissions and PR secret isolation in GitHub Actions workflows; required non-empty `WATCHTOWER_TOKEN` in `docker-compose.yml`; owner-only NTFS ACL hardening in `scripts/dev-bootstrap.ps1`.
- **`1 / 41` Out-of-Branch Finding (`provider-accounts/gitlab-oauth-baseurl-ssrf`)**:
  - References `server/src/custom/provider-accounts/oauth-extended.ts`, which was present only in an uncommitted feature branch (`feat/9router-render-parity`) and does not exist on `origin/main`. Documented here as N/A on `main`.

## Archived Files

- [`REPORT.md`](./REPORT.md) — Full executive report for `run-1`.
- [`NEEDS-VALIDATION.md`](./NEEDS-VALIDATION.md) — Source traces, blockers, and validation plans for all 41 source-verified leads.
- [`FINDINGS-DETAIL.md`](./FINDINGS-DETAIL.md) — Confirmed findings boundary note (`0` confirmed due to Windows sandbox constraint).
- [`architecture.md`](./architecture.md) — Trust boundary and architecture inventory mapped during discovery.
- [`findings.json`](./findings.json) — Schema-validated findings array (`needs_validation` entries).
- [`coverage-ledger.json`](./coverage-ledger.json) — Schema-validated 39-unit attack-surface coverage ledger.
- [`run-metadata.json`](./run-metadata.json) — Normalized run configuration and status (`complete`).
