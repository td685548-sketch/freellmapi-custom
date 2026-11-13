# Reviewer Acceptance & PR Gate

**Status**: ACCEPTED LOCALLY — user-authorized fixes complete on main `769e4145`. All532 server files verified:6,455 passed/10 existing conditional skips, no remaining failed/missing/duplicate files; client763/763, CLI181/181, build/lint/migrations/built import pass. See [final integration report](review-final.md) for sharding, retries and exact scope. PR creation pending; no PR merge authorized.

## Handoffs / scope

- [x] User reports all four owners completed; actual current diffs including untracked018 files reviewed.
- [x] Scoped ownership reviewed; user-authorized redirect helper/App import exception documented;016/Kiro preserved; no package/lockfile/binary/CI/unrelated branding changes.
- [x] New migration is registered and reversible, including lazy support tenant schema and second-memory-Db tests; no mutation of old migrations.

## Code and behavioral checks

- [x] Import is editor-only, bounded for bytes/characters/time/chunks; UTF-8/formats validated; actual destination/redirect checks applied; no late commit or async DB transaction.
- [x] Draft/publish/archive/OCC/dedup behavior is atomic; old published source survives errors; default roles are admin-only and decrypted data follows ACL.
- [x] Shared DTOs and all signatures/envelopes match; peer services are real, no production fallback/placeholder registry or fake citation success.
- [x] Off policy preserves017. Required mode actually disables CRM and all business tool descriptors/invocation, without bypassing public auth/firewall/quota/lease/approval protections.
- [x] Evidence context and public citation set are exactly aligned and bounded; snapshots cover policy/masking/current legacy and source ACL/publication; drafts do not invalidate live sources.
- [x] No-match and discarded-answer paths have honest replySource/model/usage; rejected provider text never enters any reply alias/history/cache/log. Provider failures remain errors.
- [x] Accepted zero-model turns charge one request/zero tokens and persist one user message/notice; other calls charge actual/conservative costs. Replay and20-way contention retain017 guarantees.
- [x] Source changes during generation/cache/history cannot resurrect revoked data; provenance survives runtime TTL; canonical workflow readers guard all public/list/provider paths.
- [x] Eval runs are retrieval-only, snapshot/version labeled, correct denominator, complete or explicitly partial, private-role-safe and never advertised as factual accuracy.
- [x] Admin page uses current Thruline nav, EN/VI, editor permissions, OCC errors and tenant/session isolation; widget safely renders citations and non-AI notices across send/poll/reload/identity change.
- [x] Native createRoot/act tests only; no Testing Library, skipped regressions, type suppression or fabricated performance/accuracy claims.

## Evidence (fill only after actually executing)

| Gate | Evidence |
| --- | --- |
| Source/import/store/registry/migration tests | Full current-main server inventory532/532 verified:6,455 pass,10 existing conditional skips, zero remaining failed files |
| Retrieval/citation/eval >=24-case fixtures | Retrieval18/18 (includes fail-closed corrupt/unavailable policy); eval12/12 pass |
| Actual HTTP/runtime and013–017 regressions | Canonical current-main HTTP5/5, runtime12/12 and existing related cases pass in full inventory; HTTP/widget smoke28/28 |
| Studio native UI and executed widget | Full client763/763, i18n60 locales/1320 keys; final Studio+App19/19; executed widget23/23 including prefixed canonical lifecycle and live redaction |
| Full tests / lint / workspace build / plain Node import | All workspace test inventories verified via bounded runs; bootstrap2 pass/2 platform skips, hooks9/9, CLI181/181. Root monolithic attempt not claimed as passed; build/lint/built app import pass, client scoped lint pass |
| Migration up/down/up and supported Db adapters | Default roundtrip3/3, populated018 suite3/3 and registry-drift pass; explicit npm run test:migrations3/3 |
| Prospective PR diff and secret/binary/ownership inventory | Scoped diff reviewed, no binary/package/lockfile/CI/016/Kiro included; staged whitespace check passes; exceptions documented in final report |

A mock of the entire runtime is not end-to-end evidence. Infrastructure problems are recorded separately and never relabeled as passes; bounded complete-suite reruns need a file inventory. Return actionable findings to the owning agent, wait for corrections and rerun affected/required checks. The reviewer is not asked to implement instead of the four agents; explicit later user authorization would change that.

## Publication

Only after all owners and actual integration pass review: safely synchronize current main into the reusable branch, preserve pending work, inspect the complete prospective PR diff, commit only reviewed018 work, push to origin and reuse an open PR from this branch or open the next PR targeting main. No spec-only PR now. User has authorized conditional PR creation after implementation acceptance, not merging; leave unmerged and report the verified link/CI state. Do not claim unexecuted checks or automatically merge when CI finishes.
