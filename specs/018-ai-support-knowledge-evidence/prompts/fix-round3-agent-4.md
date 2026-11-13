# Agent4 — current-main integration

Read AGENTS.md,018 ownership/contracts, `../integration-main.md` and `../review-round-3.md`. Only Agent4-owned paths; no packages, peer files, global rename, Git switch/sync/stash/reset/commit/push/PR or test suppression. R2 UI/widget fixes already pass; preserve them.

Prerequisite: coordinator safely syncs/composes current origin/main while preserving pending018/016/Kiro work. Do not replace the existing shell with an old copy or independently merge the shared branch.

Address R3-01/R3-02:

1. Knowledge Studio/nav/native tests must use canonical `/thruline/support-knowledge` and `/api/thruline/support/...`. Keep the main legacy console redirect and canonical shell behavior. No mass rename of filesystem modules, DB keys or permission identifiers.
2. Compose widget018 citation/redaction/notices/dedup/fresh-retry with main's `/thruline/v1/support/*` default chat/guest/poll/resume/escalation/CSAT calls and script-base parser. The parser must keep deployment prefixes for canonical script URL; retain main's accepted legacy suffix parsing without adding legacy API mounts.
3. Extend executed widget tests for canonical script URL under a deployment prefix and all affected default requests; retain same-instance cited->redacted, XSS safety, identity lifecycle, guest renewal, escalation/CSAT and017 regressions. Update fixtures/assertions to current canonical URLs.

Coordinate actual HTTP wire contract with Agent3; do not edit register.ts/router peer files or reintroduce old mounts. Run native evidence UI, executed widget tests, client tsc and scoped lint on the composed baseline. Report exact files/commands/results and conflicts rather than claiming tests on the obsolete baseline certify integration. Reviewer owns final PR gates; no automatic merge.
