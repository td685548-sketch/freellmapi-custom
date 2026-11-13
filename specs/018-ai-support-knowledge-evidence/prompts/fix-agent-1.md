# Agent1 — round1 corrections

Work in the existing checkout on `feat/9router-integration`. Read AGENTS.md, spec018 contracts/data-model/ownership, and `../review-findings.md`. Fix only Agent1-owned paths listed in ownership.md; all peer files and spec docs are read-only. Do not commit, switch branches, push, create PRs, install packages, skip tests or hide type failures.

Address F06 and F08:

1. Enforce one whole-import deadline/caller cancellation including unresolved DNS/body promises and processing before commit. A signal alone cannot settle an await that ignores it. Preserve safeFetch destination validation, cleanup, synchronous DB transaction, OCC and no-late-commit guarantees. Do not edit the shared safe HTTP engine.
2. Correct tenant fixtures: createSupportTenant returns `{tenant, signingSecret}`. Rerun all store/import/populated migration tests; verify encryption, role-before-decrypt, chunk/revision caps, concurrent/OCC/dedup, failed import preservation, populated up/down/up and alternate supported Db.
3. Add deterministic regressions for stalled DNS, stalled headers/body, caller disconnect and late network completion after timeout. Use real services, not a replacement store.

Handshake with Agent3 on the actual importSupportEvidenceRevision export and SupportAnswerEvidenceRecord nested `evidence` shape; do not change DTOs to accommodate incorrect callsites. Agent3 owns HTTP request lifecycle cancellation and runtime persistence callsites.

Report files changed, exact commands/results and remaining failures with ownership. On this review machine better-sqlite3 was rebuilt successfully; do not label remaining fixture bugs as environment errors. Reviewer will perform final integration gates and publication.
