# Prompt Agent2 — Role Retrieval, Citations & Evaluations

Bạn là **Agent2 của spec018**. Người dùng gửi prompt này để bạn triển khai phần được phân công; không phải để thay reviewer hoặc tự tạo PR.

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

## Agent2 — Retrieval, Citation Verification & Retrieval Evaluations

CREATE:
- server/src/custom/x-gateway/support-evidence-retrieval.ts
- server/src/custom/x-gateway/support-evidence-evaluations.ts
- server/src/__tests__/custom/x-support-evidence-retrieval.test.ts
- server/src/__tests__/custom/x-support-evidence-evaluations.test.ts
- server/src/__tests__/fixtures/support-evidence/evaluation-cases.json

No existing file edits. Own normalized lexical ranking, read-only legacy adapter, exact bounded pack, current snapshots, fresh/stored citation validation, suite execution and >=24 fixture cases. Read Agent1 store/shared APIs and existing knowledge/masking; no DB schema, router/runtime imports, live model/network calls, runtime overrides, business tools, new packages or production seed endpoint.


## Your task IDs

T004, T010–T013, T018, T020. Read full descriptions/dependencies in tasks.md.

## Implementation requirements

Create pure/read-only retrieval and citation verification, then suite execution using Agent1 persistence. Do not import routers/runtime/workflows or change the old knowledge engine. Use listSupportKnowledgeDocs through a read-only legacy adapter; role/enabled filtering occurs before legacy chunk/rank work. For new sources, filter tenant/published/ACL before decrypting/ranking.

Engine requirements:
- Use the exact Unicode/accent normalization, lexicalCoverage/score formula, stable ranking and policy limits in contracts.md. No embeddings dependency, semantic confidence, undocumented threshold or claim of factual correctness.
- <=100 enabled role-visible legacy docs and bounded chunks; reject capacity overflow honestly. A draft is never a candidate. Unknown/cross-tenant/archived/unpublished source is never eligible.
- Build an actual bounded EvidencePack: count wrappers/titles/markers/text toward min(policy.maxEvidenceChars,runtime.maxContextChars). A returned candidate must have text in the actual prompt; clip on safe code-point boundaries per data-model, not an unrelated larger hidden chunk.
- Snapshot hashes current publication/ACL, relevant policy/masking version and legacy current revision hashes. Draft-only edits do not invalidate it. Do not add mutation hooks to peer/legacy files.
- Accept1..5 distinct `[cite:<citationId>]` references only from the actual pack and current source snapshot. Malformed/unknown/stale/no citations reject; canonicalize valid markers to numeric references. Mask public title/excerpt for current role; excerpt<=240 chars comes from providedText. No hidden import URLs/full docs/ACL data. Required-mode business-tool markup invalidates the completion even if a valid citation is present.
- validateStoredSupportEvidence must work when017 turn rows expired and must reject now-revoked/policy-changed data without exposing rejected titles/excerpts. This is provenance validation, not semantic entailment checking.
- Evaluation runs use the real bounded retrieval engine, <=50 cases and2-second CPU budget, no AI/network/CRM/tools/chat quota. Correct hitAtK denominator/expectedCasesChecked and explicit partial/failed/allPassed=false; changed snapshots cannot be presented as a complete consistent run. Save only the encrypted run report through Agent1.

Fixture dataset: at least24 genuinely meaningful EN/VI cases across four roles, no match and cross-tenant/forbidden sources. Store test-only JSON with fixtureVersion, source fixtures keyed by fixtureKey and cases referring to expected/forbidden fixture keys. Test setup uses Agent1 APIs to map keys to real generated IDs; do not add a production seed endpoint or populate customers/live sources just to run an eval. Include legacy mutation/revocation and irrelevant-but-lexically-similar query tests; make the expected outcomes explicit rather than changing them merely to make the engine green.

Tests: >=12 retrieval/citation cases and >=8 evaluation cases, including schema/capacity, candidate-not-in-prompt, supplied citation forgery, source/ACL/masking/legacy edit/delete, no-match denominator, partial/error, deterministic replay and no external/operational mutations. Publish the exact named exports in data-model.md for Agent3.

## Verification to execute

From server:
`npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-retrieval.test.ts src/__tests__/custom/x-support-evidence-evaluations.test.ts`
After peers compile, from root: `npm run build -w server` and `npm run lint -w server`.

Report a missing peer interface/environment problem accurately; rerun after it is available. Do not present an unexecuted or failed command as passed. The reviewer runs final full workspace/CI gates after all owners finish.

## Completion report (required)

1. Exact files created/edited and completed task IDs.
2. Real exported APIs/DTO/wire contracts supplied to peers.
3. Actual commands, counts/pass/failure/skip and environment limitations.
4. Actual composed integration status vs unit fixtures still used; remaining issues/contract gaps.
5. Confirm no out-of-owner changes, dependency additions, staged files, commits, push or PR.

Then stop and hand back to the user/reviewer. Do not take another agent's files or start a second implementation scope.
