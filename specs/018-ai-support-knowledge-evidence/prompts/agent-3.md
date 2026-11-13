# Prompt Agent3 — Runtime, HTTP, Replay & History Integration

Bạn là **Agent3 của spec018**. Người dùng gửi prompt này để bạn triển khai phần được phân công; không phải để thay reviewer hoặc tự tạo PR.

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

## Agent3 — Actual Runtime, HTTP, Replay/History & Integration Proof

CREATE:
- server/src/custom/x-gateway/support-evidence-router.ts
- server/src/custom/x-gateway/support-evidence-runtime.ts
- server/src/__tests__/custom/x-support-evidence-runtime.test.ts
- server/src/__tests__/custom/x-support-evidence-http.test.ts

EDIT ONLY:
- server/src/custom/x-gateway/console-router.ts — minimal console mount under /support.
- server/src/custom/x-gateway/support-runtime.ts — required-mode orchestration, zero-model outcome, atomic settlement/provenance and no rejected-answer persistence.
- server/src/custom/x-gateway/support-runtime-store.ts — revalidation bridge/cached records as necessary; preserve017 scope/TTL/claim semantics.
- server/src/custom/x-gateway/support-router.ts — trusted provider hooks, modelUsed nullable for zero-model required outcome and canonical public response.
- server/src/custom/x-gateway/support-workflows.ts — additive message fields and guarded canonical history reads; no destructive migration of legacy history.
- server/src/__tests__/custom/x-support-runtime.test.ts
- server/src/__tests__/custom/x-support-runtime-http.test.ts
- server/src/__tests__/custom/x-support-runtime-gateway.test.ts
- server/src/__tests__/custom/x-support-enterprise.test.ts
- server/src/__tests__/custom/x-support-workflows.test.ts

Own all API routes and runtime/workflow bridge changes. Enforce editor permissions even for GET, public identity/origin/owner first, required-mode no CRM/business tools, no extra AI repair call, provider failure503, no-await DB transaction, current-snapshot recheck, cache409 and historical redaction. Do not edit shared/store/retrieval/schema/frontend/widget. Reuse existing model/quota/action services, no secondary executor.


## Your task IDs

T009, T014–T017, T021, T027. Read full descriptions/dependencies in tasks.md.

## Implementation requirements

Wire the real018 store/retrieval/evaluation services into the real017 runtime and HTTP routes. No new standalone chat executor and no fake result if a peer module is missing. Read current code before editing: existing runtime owns firewall, durable claim/lease, conservative quota reservations, provider deadline, masked transcript/cache and action gating.

HTTP:
- Mount new console router minimally under existing /support. Implement the exact knowledge-library source/revision/policy/preview/suite/run endpoints and envelopes in contracts.md.
- Every new endpoint, including GET/preview/evals, requires normal auth + use_x_gateway + edit_x_settings. Verify tenant first; cross-tenant IDs404. Preview role is a sandbox selector, not signed identity or a way to grant permissions. No public source export/list endpoint and no request-controlled evidence pack/policy override.
- Reuse public017 token/origin/owner checks for chat/history. Never trust browser-supplied source IDs, citations, user role/usage or localhost options.

Runtime:
- Off policy preserves017 payloads/fingerprints and model/tool/CRM behavior. Required is a deliberate knowledge-only mode: remove all business tool descriptors; block webhook/DB invocation at runtime/pipeline even if a model invents a tool call; do not inject CRM memory. Keep quota/firewall/lease/masking and manual escalation/CSAT intact.
- Inject only Agent2's actual bounded pack. No-match before provider is a typed knowledge_abstention, known zero tokens and one request, not a fake model reply. modelUsed/model null when no model ran. Existing provider failure/unavailable stays503; policy/storage corruption stays an error.
- Finalize the first successful completion once; invented business-tool markup is invalid in required mode and must not enter the tool loop. Existing bounded candidate failover before success is allowed. Validate provider citations and current snapshot before committing. No automatic repair-model call. A rejected response becomes an honest non-AI notice; billed usage remains actual/conservative. Rejected text must be absent from ALL returned aliases/choices/trace/cache/history/logs, not just final reply.
- Reuse one claim/lease/accounting path. Atomic customer message + optional cited AI message + durable provenance + cache + quota settlement; no awaits inside a DB transaction, active turn/lease check preserved after async boundaries. Signed abstention creates/resumes an actual conversation and stores only its customer message plus responseNotice for reload; no synthetic ai_assistant message. Compatible unsigned guests stay stateless.
- Refuse an unprovenanced old cached reply when required mode is now enabled; never fabricate provenance. Ensure evidence/responseNotice are server-only on all conversation write paths. Guard018 cache replay with current source/policy/masking snapshot ->409 knowledge_context_changed, no new model/tool/charge. Do not regenerate under the old requestId. Source changes during generation produce safe sources_changed abstention with incurred cost.
- Add optional evidence/responseNotice persistence and sanitation at canonical workflow history readers, including public current-role reads and console list original-customer-role reads. Invalid cited018 answer is wholly redacted along with all private source metadata, without mutating stored history on GET. Required provider context omits unprovenanced legacy AI history;017 legacy display/default behavior stays intact. Provenance must survive turn TTL deletion. Avoid workflow -> helper -> workflow runtime import cycles.

Integration tests: >=12 meaningful actual runtime/HTTP cases with real peer services; mock only the external provider/export transport. Do not use setTurnExecutor as the final proof. Cover source->publish->strict chat->cited history, no-match escalation, provider failure, forged citation, ACL/masking/legacy revocation during generation/replay/GET,20-way quota/replay, actual/zero usage, wrong role/tenant/origin, editor403, OCC, evaluation zero side effects and TTL cleanup. Preserve owned017/enterprise/workflow regressions and show mode off is unchanged.

## Verification to execute

From server:
`npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-runtime.test.ts src/__tests__/custom/x-support-evidence-http.test.ts src/__tests__/custom/x-support-runtime.test.ts src/__tests__/custom/x-support-runtime-http.test.ts src/__tests__/custom/x-support-runtime-gateway.test.ts src/__tests__/custom/x-support-enterprise.test.ts src/__tests__/custom/x-support-workflows.test.ts`
From root, after peers compile: `npm run build -w server`, `npm run lint -w server`, and `node --input-type=module -e "await import('./server/dist/app.js')"`.

Report a missing peer interface/environment problem accurately; rerun after it is available. Do not present an unexecuted or failed command as passed. The reviewer runs final full workspace/CI gates after all owners finish.

## Completion report (required)

1. Exact files created/edited and completed task IDs.
2. Real exported APIs/DTO/wire contracts supplied to peers.
3. Actual commands, counts/pass/failure/skip and environment limitations.
4. Actual composed integration status vs unit fixtures still used; remaining issues/contract gaps.
5. Confirm no out-of-owner changes, dependency additions, staged files, commits, push or PR.

Then stop and hand back to the user/reviewer. Do not take another agent's files or start a second implementation scope.
