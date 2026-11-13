# Prompt Agent4 — Knowledge Studio & Actual Embeddable Widget

Bạn là **Agent4 của spec018**. Người dùng gửi prompt này để bạn triển khai phần được phân công; không phải để thay reviewer hoặc tự tạo PR.

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

## Agent4 — Knowledge Studio, Navigation & Actual Embeddable Widget

CREATE:
- client/src/custom/x-gateway/support-evidence-strings.ts
- client/src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx
- client/src/custom/x-gateway/support-evidence.test.tsx

EDIT ONLY:
- client/src/custom/x-gateway/XGatewayApp.tsx — import/route support-knowledge only, preserve live shell.
- client/src/custom/x-gateway/shell/nav.ts — localized Customer Support item, same entries feed QuickJump.
- server/src/custom/x-gateway/support-runtime-widget.ts — extend actual served widget for evidence/non-AI statuses and explicit fresh-request retry.
- server/src/__tests__/custom/x-support-runtime-widget.test.ts — add executed-script regressions, preserve017 cases.

Own complete EN/VI, editor-only four-tab management workflow, request/conflict/tenant isolation, safe inline citation cards, responseNotice reload and current widget lifecycle. Native React createRoot/act only; NEVER import @testing-library/react. Do not edit routers/DTOs/engines, global CSS/theme, brand/logo, manifests or other tests.


## Your task IDs

T022–T026. Read full descriptions/dependencies in tasks.md.

## Implementation requirements

Build `/x/support-knowledge` and extend the actual017 widget served by the server; a standalone preview is not completion. Use existing style/components and the current Thruline shell. Grouped links are in shell/nav.ts (also QuickJump), routes in XGatewayApp.tsx; do not restore the obsolete inline navigation or alter branding.

Studio:
- Complete EN/VI strings and data-testid support-evidence-tenant. Four tabs/panels: sources, preview, policy, evaluations, each tab-<id>/panel-<id>.
- Explain that published new sources are used in chat only after required mode is enabled; preview simulates that mode and is not an AI/live-default answer. Sources: create with explicit role ACL (default admin), input/file/export URL import as draft, revisions/detail and published-vs-draft distinction, publish/rollback by selected retained revision, archive/unarchive, expectedVersion conflicts and safe size/format/import errors. Use documented endpoints; do not invent an HTML/PDF parser or show an unimplemented live feature.
- Preview is retrieval only: query/role, safe excerpts/locations, lexical coverage/score (never semantic confidence), willAbstain and snapshot. Policy is explicit off/required; explain knowledge-only mode disables CRM/business tools. Evaluation editor supports cases/roles/source expectations and shows actual versioned counts/partial/error rather than generic100% accuracy.
- Require editor permissions (use_x_gateway + edit_x_settings); non-editors issue no source/preview/suite/report queries and see a permission state. Tenant list itself may use existing normal endpoint. Query/mutation state is partitioned and canceled/cleared by tenant and session revision so late data cannot cross scopes. Handle loading/error/empty/save/OCC states and actual API errors. Do not show an invented saved/off/pass state after a failed query; disable versioned mutations until the real current version has loaded.

Widget:
- Safely render canonical reply and numbered validated source text cards from runtime.evidence. No raw import URL, HTML injection, invented client citation validation, dynamic code execution or re-fetch of private sources.
- Render knowledge_abstention/responseNotice as localized non-AI status; do not label it as an AI message. A server notice's stable reason maps to complete EN/VI text. Human escalation must work using the real conversationId. Distinguish provider/network/auth failures from no knowledge.
- Rehydrate cited messages/notices from history and deduplicate on requestId across local send/poll/reload, retaining server message-ID handling. Redacted history must not retain old title/excerpt/source data in the DOM. Clear all citation/notice state on token/tenant identity change and destroy; reject late callbacks via existing epoch/abort protections.
- A409 knowledge_context_changed offers an explicit user retry generating a fresh requestId; never auto-charge a new turn or silently reuse an invalid old ID. Ordinary network retry keeps017's same ID. Keep cross-domain/base-path resolution, guest credential reload/renewal, human_agent/ai_assistant sender types, visible polling, escalation, CSAT and all017 cases.

CRITICAL CI RULE: never import @testing-library/react (not installed); use createRoot from react-dom/client and act from react, following existing support-integration.test.tsx. At least10 Studio tests (tabs/CRUD/publish/conflict/preview/policy/eval/permissions/EN-VI/tenant-session cancellation) and at least6 NEW executed-widget regressions for citation XSS/non-AI notice/history dedup/stale retry/identity change. Test the emitted JavaScript in jsdom, not just string presence. No package/tsconfig/global CSS edits and no type suppression.

## Verification to execute

From client:
`npx vitest run src/custom/x-gateway/support-evidence.test.tsx`
`npx tsc -b`
`npx eslint src/custom/x-gateway/pages/SupportKnowledgeStudio.tsx src/custom/x-gateway/support-evidence-strings.ts src/custom/x-gateway/support-evidence.test.tsx src/custom/x-gateway/shell/nav.ts src/custom/x-gateway/XGatewayApp.tsx`
From server:
`npx vitest run --pool=forks --fileParallelism=false src/__tests__/custom/x-support-runtime-widget.test.ts`

Report a missing peer interface/environment problem accurately; rerun after it is available. Do not present an unexecuted or failed command as passed. The reviewer runs final full workspace/CI gates after all owners finish.

## Completion report (required)

1. Exact files created/edited and completed task IDs.
2. Real exported APIs/DTO/wire contracts supplied to peers.
3. Actual commands, counts/pass/failure/skip and environment limitations.
4. Actual composed integration status vs unit fixtures still used; remaining issues/contract gaps.
5. Confirm no out-of-owner changes, dependency additions, staged files, commits, push or PR.

Then stop and hand back to the user/reviewer. Do not take another agent's files or start a second implementation scope.
