# Agent3 — current-main integration

Read AGENTS.md,018 ownership/contracts, `../integration-main.md` and `../review-round-3.md`. R2 fixes are accepted by scoped tests; preserve them. Work only on Agent3-owned files in the existing integration branch. No Git sync/stash/reset/commit/push/PR, packages, test skips or peer-file edits.

Prerequisite: integration coordinator safely composes current origin/main into this shared checkout while preserving pending018/016/Kiro changes. Do not independently switch/merge branches or add legacy server mounts to make old tests pass. If the baseline still has old register.ts mounts, report that prerequisite instead of inventing production aliases.

Address your part of R3-01/R3-02: update all new018 actual HTTP tests/helpers/direct requests to `/api/thruline/support/...` and `/thruline/v1/support/...`, using existing real console auth/runtime/store APIs. Preserve the main permission fixes and correct module registration; do not rename internal permissions/files. Coordinate wire URLs with Agent4.

Run all5 new HTTP tests with assertions,12 runtime tests and affected017 HTTP/gateway/workflow tests on the composed baseline. Prove source -> publish -> chat -> cited history -> no-match/escalation -> revoke/replay409, guest role denial, evaluation zero-side-effects and normal vs disconnected URL import. Report exact commands/results and any conflict/ownership blocker. Reviewer performs final full gates/publication; no merge authorization.
