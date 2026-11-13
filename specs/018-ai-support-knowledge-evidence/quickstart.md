# Handoff & Validation Guide

This is a specification, not implemented behavior. Use current shared branch feat/9router-integration. Preserve all existing work, particularly untracked016 docs. No application tests/build are claimed as run for018 at specification time.

## Dispatch

Send each complete prompts/agent-N.md to one separate agent. They must read spec.md, plan.md, data-model.md, contracts.md and ownership.md. User owns dispatch; this reviewer does not spawn the implementation agents. Agent1 exposes DTO/store interfaces first; others can prepare owned tests/UI using contract fixtures, then replace test-only mocks with actual peer integration for final acceptance. No agent stages/commits/pushes or creates a PR.

Use explicit feature context if invoking Spec Kit scripts: SPECIFY_FEATURE_DIRECTORY=specs/018-ai-support-knowledge-evidence; SPECIFY_FEATURE_NO_PERSIST=1. Do not let an implementation agent overwrite another feature's global pointer.

## Per-agent checks

From server:

```text
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-store.test.ts src/__tests__/custom/x-support-evidence-import.test.ts src/__tests__/db/migrate/support-evidence.test.ts src/__tests__/db/migrate/registry-drift.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-retrieval.test.ts src/__tests__/custom/x-support-evidence-evaluations.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-evidence-runtime.test.ts src/__tests__/custom/x-support-evidence-http.test.ts src/__tests__/custom/x-support-runtime.test.ts src/__tests__/custom/x-support-runtime-http.test.ts src/__tests__/custom/x-support-enterprise.test.ts src/__tests__/custom/x-support-workflows.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-runtime-widget.test.ts
```

From client:

```text
npx vitest run src/custom/x-gateway/support-evidence.test.tsx
npx tsc -b
npx eslint src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx src/custom/x-gateway/support-evidence-strings.ts src/custom/x-gateway/support-evidence.test.tsx src/custom/x-gateway/shell/nav.ts src/custom/x-gateway/XGatewayApp.tsx
```

From root after peers finish:

```text
npm run test
npm run lint
npm run build
npm run test:migrations
node --input-type=module -e "await import('./server/dist/app.js')"
git diff --check
```

The previous Windows/Node24 monolithic fork runner lost IPC. If it recurs, record the failing command; run the entire server suite in bounded shards/fresh processes, preserve an all-files inventory and account for all tests, skips and failures. Example from server: `npx vitest run --pool=forks --fileParallelism=false --shard=1/6`, repeat2/6..6/6. A partial run is not a pass. CLI/client/hooks/bootstrap must also be verified if root stopped early. Canonical CI must pass before any merge. Do not weaken tests, alter CI, or label an infrastructure failure as a successful root command.

## Repeatable demonstration (mock only external boundaries)

1. Two tenants, four support roles, different signed customers. Create draft source, import txt/md/FAQ export fixture, verify no public eligibility before publish. Publish and verify role-specific retrieval. Corrupt UTF-8, size/content type and a slow/redirect/private-address export must fail without changing live source. Race two expectedVersion mutations; one wins.
2. Required mode: allowed source yields a real provider-bound reply fixture using candidate IDs from the actual provided context. Inspect provider input, canonical citation DTO, masked transcript and quota. A nonexistent/admin-only/other-tenant/unprovided citation is withheld, not stored in any reply alias/trace/cache.
3. Missing evidence ->zero provider/tools/CRM calls, one request/zero tokens, one customer message with persisted notice and an actual conversationId for a signed user. Escalate through existing endpoint, send human reply, reload widget and verify notice is not an AI message or duplicate. Provider503 remains503, not a success notice.
4. Change published source/role/masking while generation is pending and verify safe abstention with incurred usage charged. Replay20 times ->no duplicate charges/messages; after publication/ACL change replay ->409 without AI. Retry only after explicit user action and new requestId.
5. GET/poll the conversation under lower current role and via console list; revoked018 answer text/title/excerpt/source IDs are redacted. Required provider context excludes unknown legacy AI provenance; original017 default-mode regressions remain intact. Delete/expire runtime turn rows and verify durable transcript provenance still guards history.
6. Run >=24 EN/VI evaluation fixtures over all roles, no-match/forbidden/cross-tenant cases. Verify hitAtK denominator and no fabricated semantic confidence. Check snapshot change, time budget and partial run; no provider/network/quota effect and no private source snippets in report.
7. Native UI tests for four tabs, source creation/import/publish/archive/OCC conflict, preview, policy save, suite/run, tenant/session isolation and non-editor no sensitive queries. Executed widget tests for safe citation rendering, non-AI notice/reload/poll dedup, revoked source history, explicit fresh-request retry and late identity-change callbacks.

No live customer records, third-party crawling, real provider charges or real business write actions are needed. Use owned fixtures/localhost HTTP and existing provider/network mocks at the external boundary only.
