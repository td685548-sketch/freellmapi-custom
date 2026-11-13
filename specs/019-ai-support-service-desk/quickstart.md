# Implementation and reviewer verification

Read spec.md, contracts.md, data-model.md, plan.md and ownership.md. These documents are the only current019 brief; old016 is not executable scope. User sends each full prompts/agent-N.md to a separate agent. This reviewer does not spawn them or implement during the spec turn.

Use SPECIFY_FEATURE_DIRECTORY=specs/019-ai-support-service-desk and SPECIFY_FEATURE_NO_PERSIST=1 if invoking project Spec Kit scripts. Use the dedicated `codex/support-service-desk` review branch; preserve the global feature pointer. The old shared-branch handoff is superseded by the current AGENTS.md policy. Canonical URLs only: /thruline/support-desk, /api/thruline/support, /thruline/v1/support.

## Per-agent commands

From server:

```text
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-service-desk-store.test.ts src/__tests__/custom/x-support-widget-profile.test.ts src/__tests__/db/migrate/support-service-desk.test.ts src/__tests__/db/migrate/registry-drift.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-agent-copilot.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-sla-routing.test.ts src/__tests__/custom/x-support-service-desk-lifecycle.test.ts src/__tests__/custom/x-support-service-desk-runtime.test.ts src/__tests__/custom/x-support-service-desk-http.test.ts
npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-runtime-widget.test.ts
```

From client:

```text
npx vitest run src/custom/x-gateway/support-service-desk.test.tsx
npx tsc -b
npx eslint src/custom/x-gateway/pages/SupportServiceDesk.tsx src/custom/x-gateway/components/SupportWidgetPreview.tsx src/custom/x-gateway/support-service-desk-strings.ts src/custom/x-gateway/support-service-desk.test.tsx src/custom/x-gateway/XGatewayApp.tsx src/custom/x-gateway/shell/nav.ts
```

Reviewer at root after all owners complete:

```text
npm run test
npm run lint
npm run build
npm run test:migrations
node --input-type=module -e "await import('./server/dist/app.js')"
git diff --check
```

Run all related017 runtime/public auth/quota/claims/HTTP/workflow and018 evidence/store/retrieval/history/widget/UI regressions. Native better-sqlite3 can differ between Windows and WSL: report actual loader failure, rebuild locally only if needed, rerun without changing manifests/lockfiles. Fork IPC failures are not passes; use bounded fresh processes/shards, preserve all-files JSON inventory and account for every file/skip/retry, plus bootstrap/hooks/CLI/client/i18n. CI must be green before any later merge; no CI edits or test suppression.

## Required integrated demonstrations

1. Off mode preserves existing APIs/widget and017 fingerprints. Enable branded intake, retrieve safe public config on partner origin, submit signed guest/customer form. Missing/invalid/unknown/reserved fields, spoofed role, wrong tenant/user/conv, expired/stale receipts and direct chat bypass all fail safely.
2. Chat no-match and provider-success commits bind one receipt to one owned conversation atomically with notice/messages/quota/cache. Provider/quota failure doesn't consume it. Concurrent binds and request replay cannot double-charge or overwrite metadata; appearance-only edits do not invalidate accepted schema. Schema change during generation discards output without losing incurred cost.
3. Copilot uses actual conversation/original role/evidence. No sources ->zero AI; valid fixture ->3 distinct drafts + cited summary. Invalid JSON/marker/tool output is discarded, provider failure remains503. Deferred provider races with source/ACL/masking/history changes. Durable operator budget/reservation/replay/lease recovery tested; customer transcript/quota/tickets/actions unchanged until explicit existing human reply.
4. SLA fixtures for4 priorities/departments, first-match/fallback, policy snapshots,75%/100%, real ticket creation, AI vs human reply, resolution via either route, reopen and priority update. Run direct canonical service calls and actual HTTP paths, not only pure engine. Fail injected lifecycle persistence and prove workflow/SLA rollback together; default-off and legacy fixtures remain compatible.
5. Studio editor gating, four tabs, real IDs, conflicts, EN/VI, late tenant/session requests and explicit copy/edit/send. Execute actual served widget for prefix/CORS/session/intake/error/reload/renewal/abort/destroy and018 source revocation. Actual preview renderer has zero transport or live-widget side effects; generated snippet contains no signing/user secrets.
6. Migration populated up/down/up, lazy schema, cascades, encryption at rest and second memory Db. No reads backfill tickets or customer records. All sensitive GET/error payloads checked for hidden snippets, intake values, tokens and rejected provider text.
