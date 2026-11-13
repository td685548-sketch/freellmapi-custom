# Agent3 — review round2

Read AGENTS.md, spec018 contracts/ownership and `../review-round-2.md`. Existing feat/9router-integration checkout; only Agent3-owned files. No commit/push/PR/merge, branch switch, manifest changes, skipped tests/type suppression, production mocks or peer-file edits.

Address R2-01 and R2-03 completely:

1. Replace invented HTTP console fixtures with actual createUser/createSession/permissions schema and Authorization Bearer or X-Dashboard-Token authentication. There is no users.username, role user, createSessionToken export or auth-service hashPassword export; Cookie session is not dashboard authentication. Fix all request helpers/direct requests, not just the first INSERT. Make teardown restore mocks/env and close the Db/server safely even on beforeEach failure. Do not modify production auth/schema to fit incorrect tests.
2. Execute all5 HTTP tests against createApp, real auth/runtime/stores. Their current failures occur before server creation, so normal-vs-disconnect import behavior is still unverified. Fix any subsequent assertion/production failure within your ownership once setup really works.
3. Positive citation runtime fixture query must meet the specified lexical coverage (current 1/5 <0.25 produces correct no-match). Use a matching query/content; assert provider invocation and downstream cited/history/provenance behavior. Do not weaken ranking/citation guards.
4. Role/ACL-bound old snapshots remain invalid after ACL change, including staff reads. Prove GET doesn't mutate raw history by inspecting persisted raw record separately; do not force staff public read to cited by relaxing validation.
5. Provider-history test currently may never enter generate and catches every exception. Ensure a new authorized/matching source forces the provider path; assert invocation and expected outcome, let assertion failures fail. Prove redacted and unprovenanced AI are absent from actual provider context.

Rerun both evidence HTTP/runtime files and affected017 tests, server build/lint/built-app import. Coordinate typed storage failure handling with Agent2 for R2-04. Report exact files/commands/counts and any remaining blocker; reviewer handles final workspace checks and conditional PR, no automatic merge.
