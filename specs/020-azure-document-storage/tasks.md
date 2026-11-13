# Tasks: Azure tenant document archive

Dependencies: T001 -> T002 -> T003 -> T004 -> T005.
- [x] T001 [US1] Provision private Azure account/container and scoped identity RBAC; record spec.md and plan.md.
- [x] T002 [US1] Write adapter tests in server/src/__tests__/custom/x-support-document-storage.test.ts and observe failure before adapter exists.
- [x] T003 [US1] Implement server/src/custom/x-gateway/support-document-storage.ts and integrate with support-evidence-store.ts; test no DB commit on archive failure.
- [x] T004 [US2] Add .env.example settings and docs/azure-document-storage.md; configure ignored local environment.
- [x] T005 [US1] Run focused tests/build/lint and verify an encrypted real Azure roundtrip plus denied anonymous reads.


Validation results (2026-11-14):
- Root `npm run build` and `npm run lint` passed; server build and changed-file lint passed again after the revision-capacity correction.
- Server: all 557 test files exercised in eight isolated source snapshots with `--pool=forks --fileParallelism=false --testTimeout=30000`. Four Windows fork crashes were reconciled by rerunning the four affected files serially (76 tests passed). A Windows HTTP ECONNRESET in preparse-guard was reconciled by a separate run (7 tests passed). The 5-second router-bandit timeout also reproduced on unchanged main; all 31 tests passed at 30 seconds. No test assertions were disabled or altered to accommodate those environment failures.
- CLI: 181 tests passed. Client: 798 tests passed; i18n validation passed for 60 locales / 1336 keys. Bootstrap: 2 passed / 2 platform skips. Hooks: 9 passed.
- Storage/evidence focused suites: 71 tests passed before final capacity correction; affected adapter/import/store/HTTP suites passed again afterward (29 tests). Capacity test observed failure before the fix, then passed including duplicate-at-capacity coverage.
- Real Azure SDK roundtrip through the knowledge import service passed; anonymous GET denied (HTTP 409), synthetic object removed. Ignored local .env was not included in Git.
- Sequential root test invocation did not finish cleanly due the Windows timeouts; the isolated shards and targeted retries above provide the full test reconciliation. Production deployment and PR merge remain outside this task.
