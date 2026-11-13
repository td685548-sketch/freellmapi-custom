# Prompt Agent1 — Knowledge Import & Versioned Storage

Bạn là **Agent1 của spec018**. Người dùng gửi prompt này để bạn triển khai phần được phân công; không phải để thay reviewer hoặc tự tạo PR.

You work in `C:/Users/dotha/Documents/Fsoft-Working/freellmapi` (WSL equivalent `/mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi`) on the existing shared branch `feat/9router-integration`.

Read first:
- AGENTS.md and .specify/memory/constitution.md.
- specs/018-ai-support-knowledge-evidence/spec.md
- specs/018-ai-support-knowledge-evidence/plan.md
- specs/018-ai-support-knowledge-evidence/data-model.md
- specs/018-ai-support-knowledge-evidence/contracts.md
- specs/018-ai-support-knowledge-evidence/ownership.md
- specs/018-ai-support-knowledge-evidence/tasks.md
- specs/018-ai-support-knowledge-evidence/quickstart.md and review.md.

The user delegates implementation to four separate agents. This prompt author is only preparing the handoff and will review after all four finish. Implement your assigned tasks; do not merely summarize a plan. Read CodeGraph before locating/understanding indexed code, as AGENTS.md requires.

Shared-checkout rules: write only your exact owned paths below; all other files/spec documents are read-only. Preserve untracked spec016 and existing013–017 behavior. Do not run016 simultaneously, change branches/worktrees, merge/rebase/reset/stash/clean, stage/commit/push or create/merge PRs. Do not modify dependencies, lockfiles, CI, global theme/branding or another owner's files. If a required touchpoint is missing, report the exact contract/path problem to the reviewer; do not bypass it. Do not spawn further implementation agents.

Use frozen shared DTOs/service names/wire envelopes. Test-only provider/network/store fixtures are allowed in your own unit tests while peers build, but final production has no placeholder registry, dynamic missing-module fallback, fabricated source/citation/action, fake success, ts-ignore or skipped failing test. Final end-to-end proof mocks only external provider/export transport; actual store, retrieval, runtime and HTTP guards must run.

## Your exact ownership (copied from ownership.md)

## Agent1 — Shared DTOs, Import, Versioned Store & All New Schema

CREATE:
- shared/support-evidence.ts
- server/src/custom/x-gateway/support-evidence-store.ts
- server/src/custom/x-gateway/support-evidence-import.ts
- server/src/db/migrations/20261113_090001_support_evidence.ts
- server/src/__tests__/custom/x-support-evidence-store.test.ts
- server/src/__tests__/custom/x-support-evidence-import.test.ts
- server/src/__tests__/db/migrate/support-evidence.test.ts

EDIT ONLY:
- shared/support-runtime.ts — additive evidence field/replySource type; preserve017 defaults.
- server/src/db/migrate/defaults.ts — register the new migration exactly once/in order.
- server/src/__tests__/db/migrate/roundtrip.test.ts — append the new migration expectation, preserve tests.

Owns DTOs for all stories, all018 tables including suite/run/provenance, source/policy/suite/report/reference persistence, text/export import, OCC/publish/archive and encryption. Do not touch support-knowledge.ts, routes/runtime, safe HTTP engine, widget/client or Agent2 modules. Reuse safeFetch/crypto; do not modify existing migrations.


## Your task IDs

T001–T003, T005–T008, T019. Read full descriptions/dependencies in tasks.md.

## Implementation requirements

Implement shared/support-evidence.ts first, including every DTO/limit in data-model.md and the additive017 metadata changes in shared/support-runtime.ts. Publish exact store signatures so the others can integrate, then implement them. All018 tables belong to your one new migration, including evaluation/provenance tables used by peers. Register it in defaults.ts and update the explicit migration roundtrip expectation: creating a migration file or lazy ensure alone is not sufficient.

Storage/import requirements:
- Existing Db/crypto/safeFetch only, no package. New source ACL defaults admin-only; enforce verified tenant scope and known roles. Raw revision/chunk/import-locator/suite/report content encrypted at rest, safe logs/errors.
- Import text, Markdown, FAQ JSON; <=1MiB bytes, <=64,000 normalized code units, <=128 chunks/revision, max50 sources,20 revisions/source and4000 live new-source chunks/tenant. Honor all metadata/FAQ limits. Reject HTML/PDF/binary/invalid UTF-8/unsupported media instead of pretending to parse them.
- Export URL fetch uses actual DNS-bound safeFetch, no redirects/credentials/query/fragment or caller localhost/trust/auth headers. HTTPS in production, server-owned exact-origin test exception only. Entire fetch/body/parse has5-second deadline and streamed byte limit. Aborted/late requests cannot commit.
- Draft/published pointers separate. Immutable body/metadata hash dedup; stale expectedVersion conflicts before dedup. Publish/rollback/archive/ACL/capacity/version changes atomic and short, no awaits in DB transactions. A failed import leaves the published source untouched.
- Policy defaults off only for a healthy missing row. Corruption/storage failure is503, never a silently disabled policy. Suite/report/reference APIs enforce tenant scope and bounded input.
- Answer reference rows survive017 turn-cache expiry; do not add a cascading answer->runtime-turn FK. They participate in Agent3's outer atomic message/cache/quota transaction. Respect existing lazy tenant schema and tenant deletion.

Tests: >=14 meaningful store/import cases plus registered migration up/down/up, second independent memory Db, encryption inspection, OCC contention/draft visibility, dedup, malformed/oversized/redirect/private/DNS/timeout imports and no late/partial publication. Test suite/version/report and answer-record scope/TTL persistence as appropriate. Export services must be real, not an in-memory replacement.

## Verification to execute

From server:
`npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-store.test.ts src/__tests__/custom/x-support-evidence-import.test.ts src/__tests__/db/migrate/support-evidence.test.ts src/__tests__/db/migrate/registry-drift.test.ts src/__tests__/db/migrate/roundtrip.test.ts`
From root: `npm run build -w shared`; after peers compile, `npm run build -w server` and `npm run lint -w server`.

Report a missing peer interface/environment problem accurately; rerun after it is available. Do not present an unexecuted or failed command as passed. The reviewer runs final full workspace/CI gates after all owners finish.

## Completion report (required)

1. Exact files created/edited and completed task IDs.
2. Real exported APIs/DTO/wire contracts supplied to peers.
3. Actual commands, counts/pass/failure/skip and environment limitations.
4. Actual composed integration status vs unit fixtures still used; remaining issues/contract gaps.
5. Confirm no out-of-owner changes, dependency additions, staged files, commits, push or PR.

Then stop and hand back to the user/reviewer. Do not take another agent's files or start a second implementation scope.
