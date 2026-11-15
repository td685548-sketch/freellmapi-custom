# Reviewer remediation and publication — 020

Branch: `codex/support-output-controls`. Base: `origin/main` at `1dbf92f5` (2026-11-15). User authorized remediation and PR creation after the initial review.

## Scope

Integrated the four owner implementations from their separate worktrees at baseline `90e45f06`, applying only their020 changes onto current main. Source checkouts and unrelated dirty changes are preserved. Current-main AI Platform output guard hooks/finish reasons remain composed with020.

- F1: inspect public trace names and sanitize/strip history traces on read.
- F2: restore validated citation ordinals before revalidation; retain already-redacted title/excerpt text instead of resurrecting source credentials. Covered for chat and every Copilot artifact.
- F3: policy evaluation, audit and lease-fenced Copilot completion/failure share one synchronous transaction. Blocking is reported after committing the failed job; corrupt-policy failures retain fenced state and honest model cost.
- F4: redact nonempty Bearer tokens, including1–7 characters, preserving delimiters and idempotent replacement.
- F5: route-specific256KiB middleware runs after existing preparse guards and before general JSON parsing. Limit applies to streamed/chunked and inflated JSON; malformed bodies get fixed errors without raw parser details.

No package/dependency/lockfile, CI, old migration, global theme or unrelated provider changes. New migration only; public endpoint compatibility preserved. No live model, external moderation, customer sends or production writes.

## Verification — accepted locally

Application source hashes match the frozen isolated server snapshots. Full server inventory and exact per-file counts: [verification-inventory.json](verification-inventory.json).

| Gate | Final evidence |
| --- | --- |
| Complete backend inventory | 620/620 unique files verified; 7,351 passed / 9 existing conditional skips / zero remaining failed tests |
| Execution method | Four isolated Linux snapshots, Node20.20.2; each shard155 files. A legacy migration test initially assumed its migration was latest; changed it to roll back through the named target, then reran that entire file successfully on Linux and Windows. No old migration changed. |
| UI suite | 123 files / 913 tests passed on Windows Node24.15.0; i18n60 locales /1336 keys passed |
| CLI suite | 7 files /181 tests passed |
| Bootstrap / hooks | PowerShell bootstrap2 pass /2 Bash platform skips; hooks9/9 passed |
| Migrations | Roundtrip3/3 and focused new/output + approval rollback suite6/6 passed |
| Build / compiled import | Full workspace build passed; final client rebuild after tenant-state cleanup passed; plain Node import of compiled app passed |
| Lint | Root server/CLI lint passed; scoped new Studio files lint passed |
| Diff review | Whitespace check passed; no package/lockfile/CI/provider/binary/unrelated changes |

An earlier Windows monolithic root test run was started before the last Copilot source adjustment and stopped; it is **not** reported as a pass. Acceptance uses the complete frozen Linux server inventory above plus the full Windows client/CLI and bootstrap/hooks runs. After source freeze, only the migration test correction changed a tested source file; that full file was rerun cold successfully.

Scoped additions prove the six original failures are fixed, as well as valid citations for summary/every Copilot draft, no restored source token in citation title/excerpt, policy-error job fencing and actual cost retention, malformed/oversized/chunked/inflated JSON boundaries, and preservation of current-main Support guard behavior. The new Studio editor uses tenant-keyed state and derives untouched drafts from query results; native UI regressions remain green.

## Publication

Ready for a single PR targeting main on codex/support-output-controls. CI is tracked in GitHub after publication. No merge authorized.

## Limits

Rules are bounded literal matching/known credential patterns, not semantic moderation or universal secret detection. Preview does not call models. Streaming, embeddings and missing MCP Client functionality are outside020. The initial rejected review remains in review-findings.md as history; this report supersedes its status.
