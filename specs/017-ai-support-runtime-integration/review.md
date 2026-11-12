# Reviewer Acceptance & PR Gate

**Current status**: Accepted for PR publication after authorized remediation on 2026-11-12, with the local runner limitation below explicitly disclosed. All 524 server test files have completed successfully across the monolithic run's completed files and six bounded continuation batches; client, CLI, build, lint and migration gates passed. The monolithic Windows command itself did not finish successfully. The user's subsequent instruction, “sửa những phần chưa đạt nhé”, authorized reviewer corrections and regression tests. No merge is authorized. See [fix-report.md](fix-report.md).


## Required Handoffs

- [x] Agent1 implementation present; actual diff reviewed after the user confirmed completion.
- [x] Agent2 implementation present; actual diff reviewed after the user confirmed completion.
- [x] Agent3 implementation present; actual diff reviewed after the user confirmed completion.
- [x] Agent4 implementation present; actual diff reviewed after the user confirmed completion.

Reviewer waits for all four, then reads actual current code and branch history. Agent statements/test counts alone are insufficient. Implementation remains based on the four agents’ work; the reviewer applies the explicitly authorized corrections and validates their actual behavior.

## Code / Security Review

- [x] All changes respect ownership and preserve concurrent016 work; no secret/dependency/binary/unrelated changes.
- [x] Actual /chat and /simulate-chat traverse runtime; no fallback, direct tool, simulator or legacy endpoint can bypass applicable checks.
- [x] Origin enforcement, conflicting-token rejection, trusted role/user/model selection and cross-tenant ownership work at HTTP boundary.
- [x] RAG/CRM context, tool inputs to model, reply, trace, cached replay and transcript are masked; raw execution args are encrypted and not leaked.
- [x] Client histories/system roles cannot replace server instructions/history; external reference content is untrusted data, not executable instructions.
- [x] Concurrent quota reservation, settlement/window rollover, failed calls and provider usage are accounted honestly; one request per turn.
- [x] Turn replay and conversation lease are durable, atomic and tenant/user/role-bound; no async DB transaction or stale lease completion can overwrite a newer turn.
- [x] Action claim occurs before HTTP; role/ownership/schema/target/args are revalidated; approve replay/opposite decision/missing tool/unknown outcome are safe.
- [x] Outbox enqueue and business mutation are atomic; worker claims/retries survive restart; stable event IDs and exact-byte signatures; recipients can deduplicate.
- [x] HTTP destination validation is applied to actual resolved connection; no public allowLocalhost, redirect/private/metadata escape or default signing secret.
- [x] Worker starts once and stops before DB close; no network calls during module import/readiness and no stale loops after shutdown.
- [x] Widget server URL is correct cross-origin; no secret, identity leakage, unsafe HTML, silent auth downgrade or duplicate side effect on retry/reload.
- [x] Native React tests compile after clean dependency install; no Testing Library/new package requirement. UI does not claim fake readiness or model success.

## Verification Evidence (fill only after execution)

| Check | Result / command / evidence |
| --- | --- |
| Targeted runtime/approval/outbox/network/gateway/widget tests | PASS: 95 tests in six files; final executor/widget/gateway/fencing rerun 56/56. Additional worker-health/outbox/gateway/HTTP rerun 43/43. |
| New migrations up/down + alternate memory Db | PASS: 14/14 in three new migration files; registry/default runner migration coverage included in 129/129 combined tests. |
| Integration UI tests + client tsc -b | PASS: 9/9 UI tests, client build passes. Native createRoot/act harness; no Testing Library. |
| Existing013–015 regression tests | PASS as part of complete server/client file coverage and final real HTTP runtime checks. |
| Full test coverage / npm run test | Monolithic root command FAILS with Windows Tinypool ERR_IPC_CHANNEL_CLOSED after 318 completed server files, with no assertion failures. Ran the remaining 206 files in six fresh-process batches, all exit0. Coverage inventory confirms all 524 server files: 6376 tests passed, 10 skipped. CLI 181/181; client 747/747; i18n 60 locales/1320 keys; bootstrap 2 passed/2 platform skips; hooks 9/9. No command failure is relabeled as a pass. |
| npm run lint + targeted client lint | PASS: root server/CLI lint and targeted new client files. Reran root lint after worker heartbeat and migration registry fixes. |
| npm run build | PASS: full workspace build; final server/shared build after worker heartbeat correction also exit0. Compiled app loads with plain Node. |
| npm run test:migrations | PASS: 3/3 against the registered migration list, including full up/down/up. |
| git diff --cached --check | PASS after checking all newly staged files. |

Use fake transport/provider boundaries for repeatable tests; do not mock away the entire runtime in the final HTTP proof. A failing test assertion/build or unresolved material security/behavior issue blocks acceptance. The monolithic Windows worker failure is disclosed separately from the complete successful per-file coverage; CI must verify the canonical command on Linux/Node22 before any merge. Return findings to the owning agent and rerun impacted and required checks after fixes.

## PR Authorization & Scope

The user authorized **creating a PR only after the four agents' code passes review**. They did not authorize merging. No spec-only PR now and no premature draft claiming implementation.

At acceptance: inspect full `origin/main...HEAD` and pending work, include only the intended reviewed changes in focused commits, preserve unrelated/untracked work (including016). Reuse `feat/9router-integration` and an existing open PR from it; if the previous PR merged, create the next PR from the same branch. Synchronize current main according to AGENTS.md only with a safe working state, preserve history and rerun verification after any merge.

Before publishing, inventory the entire prospective PR diff, not just spec017 files. If previous unmerged batches are included, review/validate those too and describe the complete actual scope. Do not stage everything with git add . or discard others' work.

PR description leads with the original problem and actual resulting website behavior, followed by validation and honest limitations (at-least-once events; unknown side-effect outcomes require reconciliation). Share PR link with the user and leave it unmerged. If GitHub auth/remote permissions prevent creation, report the concrete blocker without treating PR as created.
