# Agent4 — round1 corrections

Use existing `feat/9router-integration`. Read AGENTS.md, spec018 contracts/ownership and `../review-findings.md`. Only Agent4-owned page/strings/native test/navigation/served widget/widget test may be edited. Peer files/docs are read-only. No commit/push/PR/branch switch, package changes, Testing Library, skipped tests or type suppression.

Address F05, client part of F09, F10 and F11:

1. Fix widget updates before request/message dedup: when an already rendered cited response becomes redacted, remove its original answer and all citation cards/titles/excerpts and show the localized revocation notice. Handle send/poll/resume consistently without duplicates; preserve017 identity reset/destroy/cancellation. Add an executed-script test that sends a cited reply and then polls the same ID as redacted on the same instance. Reviewer reproduced stale answer/title after7 such polls despite existing20 tests passing.
2. Fix client test JSON.parse(init.body) with real type narrowing/validation. Run both11+ native Vitest tests and `npx tsc -b`; Vitest alone is not acceptance.
3. Add editing of existing source allowedRoles via PATCH with expectedVersion, and editing/loading/updating existing evaluation suites via PUT with expectedVersion. Preserve EN/VI, editor gating, conflict errors and tenant/session partition. Exercise existing resources, not only create workflows.
4. Make evaluation case IDs unique/stable after remove/reorder/add; regression: create1/2/3, remove2, add, save successfully. Maintain identities when editing saved suites.

Confirm URL imports use the chosen format/source kind rather than always sending text, so markdown/FAQ exports supported by the backend are usable. Coordinate response/error envelopes with Agent3 without editing routes.

Run owned native UI and executed widget tests, client tsc and scoped lint. Report exact files/commands/results and any blocked peer API. Reviewer will rerun full gates and create a PR only after acceptance; do not merge.
