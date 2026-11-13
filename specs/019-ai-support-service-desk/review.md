# Reviewer acceptance and PR gate

**Status**: ACCEPTED after reviewer corrections and complete local validation; publishing on the dedicated feature branch. The original specification-only readiness record and rejected first review below are retained as history.

Specification validation2026-11-13:32 unique sequential task IDs,4 prompts,38 exclusively owned application paths, no duplicate ownership, no missing EDIT paths or existing CREATE collisions, no broken local Markdown links or unresolved template markers. Spec/plan/tasks templates resolved through project Spec Kit scripts with explicit019 directory and no-persist; global feature pointer/shared branch preserved. Deleted17 unmodified completed017/018 prompt files; Kiro and016 hashes preserved. `git diff --check` passes. These checks certify documentation readiness only; no application/build/test pass is claimed for019.

## Required evidence after handoff

- [x] Exact four-owner diffs/exports match contracts; no mixed016/Kiro/package/lockfile/binary/CI/theme changes.
- [x] All019 tables/crypto/migration registration/roundtrip/second Db verified; corrupt storage fails closed.
- [x] Default-off/no-intake017 compatibility, both runtime commit branches, scoped receipt replay/expiry/concurrency/schema races and trusted metadata verified.
- [x] Actual model-bound Copilot uses role/current evidence, strict artifacts and operator budgets; no fake AI, CRM/tools/customer charges or raw rejected output leaks.
- [x] Claim/lease/deadline/cost/replay/conversation/source revalidation and expiry retention verified with real persisted state, not entire-runtime mocks.
- [x] SLA/routing pure boundary cases AND canonical create/human-reply/update transactions/rollback/reopen/priority/resolveConversation paths verified. No read backfill or false success denominators.
- [x] New real HTTP endpoints prove auth/origin/tenant/actor gates, current canonical mounts and normal failure envelopes.
- [x] Four native UI tabs/EN/VI/OCC/epoch permissions pass; widget executes real profile/intake transport and renderer-only preview with017–018 lifecycle intact.
- [x] Native tests/tsc/lint/build/plain Node import/migration gates/full workspace inventory verified; no skipped regression or type suppression introduced.
- [x] Latest origin/main safely composed into same integration branch without dropping pending work; prospective PR scope and secrets/binary inventory reviewed.

Record actual command results, counts, environment failures/retries and remaining risk here. Never infer success from an agent report alone. Return fixes to owner; do not silently take over implementation unless user explicitly asks. Do not create a spec-only PR in this turn.

Only after implementation acceptance: focused reviewed commit(s), push same feat/9router-integration branch, reuse an open PR or create the next to main. Report verified link/CI state. PR25 is already merged; do not reuse it or auto-merge019. No direct main commit, history rewrite or live customer/provider test charges.

## Implementation review 2026-11-13 — NOT ACCEPTED

Reviewer checked the four owners' actual pending implementation in the shared `feat/9router-integration` checkout. No application implementation was changed, committed, pushed, or merged by this review. Pending Kiro, theme and other unrelated changes remain outside acceptance scope.

### Verified commands and results

- Windows `npm run build`: FAIL at `server/src/custom/x-gateway/support-service-desk-runtime.ts:232`, TS2367. The discriminated union already excludes `disabled` after `!gate.active`; remove/restructure the unreachable comparison without suppressing types.
- Windows `npm run lint`: FAIL at `server/src/__tests__/custom/x-support-runtime-widget.test.ts:1164`, unused `instance`. CLI stage is not reached.
- Client `npx tsc -b`: PASS.
- Client `npx vitest run src/custom/x-gateway/support-service-desk.test.tsx`: 18 passed.
- Eleven related server test files (all new 019 suites, served widget, migration roundtrip and registry drift), bounded fork execution under WSL: 131 passed, 1 failed; 10 files passed, 1 failed. HTTP case 6 fails at line407 with `Unsupported field "title" in source`. It also uses obsolete revision import/publish signatures and must be updated to real 018 APIs, without weakening production validation.
- Initial Windows server execution failed loading Linux-built better-sqlite3 (`not a valid Win32 application`). WSL loaded the existing binary successfully; no dependency/manifest/lockfile/native-binary changes made.
- Five additional temporary reviewer regression probes reproduced five defects below: PII masking, expired dispatch recovery, hourly intake issuance, conversation switching, canonical reply body. All five fail the expected correct behavior. Probe files were removed after execution; logs remain outside the repository. Original suites were not modified or skipped.
- Full-workspace test inventory, successful build, plain Node import and final PR gates are NOT claimed. Acceptance stops at the confirmed blockers.

### Required fixes by owner

1. **[P1, Agent 3] Build and real HTTP gate fail.** `support-service-desk-runtime.ts:232` prevents the server/workspace build. HTTP fixture at `x-support-service-desk-http.test.ts:407` passes `title` to `createSupportEvidenceSource`, then uses obsolete `importSupportEvidenceRevision`/`publishSupportEvidenceRevision` signatures. Follow Agent 2's actual provider-bound fixtures and rerun the full HTTP case, including cited result, actor isolation and provider failure.

2. **[P1, Agent 4] Human reply uses the wrong wire fields.** `SupportServiceDesk.tsx:838` sends `{message,senderName}`; the canonical enterprise reply route requires `{content,agentName}` (`support-enterprise-router.ts:266`). Every real Send Reply receives400 "Reply content is required". The UI test mock wrongly accepts the invented fields, so its passing send test hides this failure. Correct the UI and contract assertions.

3. **[P1, Agent 4] Composer text survives switching customers.** `SupportServiceDesk.tsx:875` clears the displayed Copilot result but does not clear `composerText` or abort/fence a pending human reply. Generate/use a draft for conversation A, select B: A's text remains and `handleSendReply` targets B. The reviewer probe reproduced this. Reset/fence all conversation-scoped state, mutations and completion callbacks, including automatic fallback when the selected conversation disappears.

4. **[P1, Agent 2] Generated Copilot text bypasses masking.** `support-agent-copilot.ts:713,796` copies `canonicalReply` directly into drafts/summary. Citation validation masks citation titles/excerpts, not reply text. With email masking enabled and no exempt roles, a valid cited model result containing `private.person@example.com` is returned unchanged and cached. The real provider-bound reviewer probe reproduced this. Mask the complete accepted artifact for the original customer role before persistence/return; verify initial result, replay and GET without damaging citations or returning raw aliases.

5. **[P1, Agent 1] Expired dispatched job recovery is rolled back.** `support-service-desk-store.ts:792–815` updates the job to failed/settled then throws inside `db.transaction`. SQLite rolls back those updates. A reviewer probe dispatched a claim, advanced past the lease, retried it and observed `state='running'` after the504. The original lease remains valid to late settlement/completion paths that do not check expiry. Persist failure and fence the lease before throwing outside the transaction; prove durable conservative cost and rejection of late callbacks/finish.

6. **[P1, Agent 4] Schema changes leave the live intake form stuck.** `support-runtime-widget.ts:729–737,1387–1394` handles `intake_schema_changed` by calling `ensureAndShowIntakeForm`, which prefers the cached schema/version. The user sees the old form again; submitting it gets409 `widget_config_changed`, whose intake-submit catch merely shows a generic network error. Fetch/apply the current profile on schema/config conflicts, discard the stale receipt/form and allow an explicit fresh submission. Cover a real served-widget config edit while open.

7. **[P2, Agent 1] Receipt cleanup resets the hourly issuance count early.** `support-service-desk-store.ts:302–306,350–358` deletes expired unbound receipts before counting rows for the last hour. TTL is30 minutes. Issuing10 receipts at10:00 then another at10:31 succeeds even though all11 belong to one rolling hour. The reviewer probe reproduced this. Keep an issuance ledger/tombstones or retain rows through the rate window; cleanup must not remove quota evidence. Preserve bounded retention and same-request expiry behavior.

8. **[P1, Agent 4] Displayed drafts are never revalidated after generation.** `SupportServiceDesk.tsx:788–859,1047` stores the POST response in local state, but never calls the job GET endpoint before copying/sending or when current conversation/source state changes. Source revocation or a conversation edit after generation leaves old text/citations visible and usable indefinitely; sending a human reply even invalidates the snapshot without hiding the old result. Use the existing revalidating job GET and scoped query/state lifecycle; hide both the artifact and its copied composer content when it becomes stale. Test revocation after a successful generation, rather than only a failed new POST.

9. **[P2, Agents 1 and 3] Reopening erases completed SLA-cycle history.** `support-service-desk-store.ts:1786–1789` re-encrypts only `policyTargets`/`routingSource`; lifecycle reopen clears the prior timestamps. `StoredTicketMeta.historicalCycles` is declared but never persisted or preserved. In particular, disabling policy then reopening permanently loses the previous completed cycle, contrary to the frozen lifecycle contract. Preserve bounded encrypted prior-cycle context atomically with the transition and prove later routing/priority writes retain it.

10. **[P2, Agent 4] Preview is a second renderer and misses deployment-prefix behavior.** `support-runtime-widget.ts:145–293` independently builds preview DOM rather than sharing the live appearance renderer. `SupportWidgetPreview.tsx:58` hardcodes `/thruline/v1/support/widget.js`, so a deployment under `/prefix` loads from the wrong root. Extract/use the same safe appearance rendering path and the canonical base-aware asset URL. Keep transport disabled and existing live instance untouched; test the actual script, not only the mocked preview factory. Also remove the unused test variable reported by lint.

### Handoff and PR decision

Return these fixes to their file owners under the existing ownership map. Add real regression assertions for the demonstrated cases, then rerun targeted 017–019 regressions and all documented acceptance gates on a stable snapshot. Do not mix the unrelated pending Kiro/theme changes into the 019 commit. No PR created for 019 and no merge authorized by this review.

## Reviewer corrections completed (2026-11-13)

The user explicitly authorized the reviewer to implement the fixes and open a PR, then replaced the shared-branch policy. Current publication branch: `codex/support-service-desk`, based on origin/main `ec34c6f0`. PR31/Kiro was independently merged into main and safely fast-forwarded into this checkout (`50737fcf`); it adds no Kiro changes to this PR. Original pending theme changes and016 remain outside this feature's diff. AGENTS.md now requires dedicated branches and a single task scope per PR, including parallel agent assignments.

All ten first-review findings have been addressed:

| Finding | Resolution and verification |
| --- | --- |
| Build / HTTP fixture | Remove impossible discriminant comparison; use actual018 source/revision APIs. Complete HTTP suite now passes. |
| Reply body | Use canonical content/agentName; UI regression checks the real wire contract. |
| Customer switching | Conversation-keyed editor remounts and aborts its mutations; copied composer state cannot follow another customer. |
| Copilot PII | Mask accepted summary/draft text before persistence/return; verify initial response, replay and GET with a cited provider fixture. |
| Expired dispatch | Commit conservative failure/fenced lease before throwing outside the transaction; reject expired usage/completion and prove late callbacks cannot overwrite failure/cost. |
| Intake schema conflicts | Refresh current profile/schema/version for chat and intake POST conflicts; render a fresh form and require an explicit next action. |
| Intake hourly limit | Keep expired receipt issuance evidence until its rolling-hour window ends; verify31-minute denial and61-minute recovery. |
| Draft revocation | Revalidating job query refreshes on focus/poll and conversation changes; revalidate again before copying/sending and clear stale artifacts/composer. |
| SLA history | Retain20 encrypted completed cycle snapshots and preserve them through routing/priority updates, including paused reopen. |
| Preview / prefix / lint | Share the safe appearance renderer between live/preview; deployment-base-aware script loading with disposed-load fencing; execute actual preview/widget regression and remove unused test variable. |

Additional boundary coverage: cancellation completes promptly even if a provider ignores AbortSignal, with conservative cost and fenced late output; turning on required intake during generation rolls back the turn; network retries retain their intake request ID; profile-load failures expose an explicit retry; intake controls have associated labels and localized select placeholders; failed accepted Copilot jobs still count against the hourly request cap.

Final focused server verification:10 files with successful final per-file reruns,141 passed,0 failed. Full client verification:107 files,784 passed; i18n60 locales/1320 keys passed. CLI181 passed. Bootstrap2 passed/2 platform-specific skips; hook tests9 passed. Workspace build, root lint, scoped frontend lint, migration roundtrip3 tests and plain Node import of server/dist/app.js passed. Complete541-file server inventory reconciled across eight bounded fork reports and successful final per-file reruns:6585 passed,11 pre-existing platform/runtime-conditional skips,0 failed; no missing, extra or duplicate files.

Native environment: original checkout's better-sqlite3 was Linux-built, so initial reviewer tests used WSL (135 passed after first fixes). Final Windows validation uses an isolated12.10.0 dependency under the system temporary directory, linked only in this checkout's ignored server/node_modules. No package/lockfile/CI/native binary is changed or staged. No live customer/provider call or automatic PR merge has been performed.


Final inventory notes: Windows shard6 encountered ERR_IPC_CHANNEL_CLOSED twice; its report and shard8 completed under WSL. WSL then exposed a5-second cold-import timeout in the existing health-interval-env suite and a missing optional Linux libsql binary in request-log-batch. Both entire files were rerun successfully on Windows (12 passed) using their unchanged tests/timeouts and existing Windows libsql dependency. Final inventory replaces those failing file results with the successful reruns; it does not count either failed run as passed or suppress a case. Windows and WSL reports normalize the same relative file inventory. Final changed-file reports also cover conservative token-usage DTO accounting and preservation of an existing live widget when the served factory reloads for preview.

All staged paths were checked:72 files, no Kiro/theme/016/package/lockfile/CI/native-binary changes; local Markdown links and staged whitespace checks passed. The final server build and changed-file lint were repeated after the last Copilot/widget correction. No source assertion or test timeout was relaxed. The user has authorized this feature PR, not an automatic merge. The verified PR URL and GitHub CI state are reported by the reviewer after creation.
