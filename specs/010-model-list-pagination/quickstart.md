# Quickstart validation
1. Run server and client normally with a test catalog of at least 45 distinct logical models and one usable key.
2. Open /models/chat. Confirm 20 model rows and no legacy full-list requests; scroll without fetching more.
3. Click Load more twice: 40 then 45 rows; button disappears. Verify a multi-provider model stays on one row.
4. Search for a model after the first 20; it must appear immediately in its matching first page. Change capability/context/sort and verify results reset.
5. Toggle one displayed model and save; verify an unloaded model and another profile are unchanged. Load further pages after staging a toggle and confirm the toggle remains.
6. Simulate a next-page network failure, retry, and verify prior rows remain and no duplicates appear.
7. Run focused route/component tests, legacy fallback/routing budget regressions, npm run test, npm run build and npm run lint.

## Local results (2026-11-08)
- Production build, server/CLI lint and lint of changed client files passed.
- Client: 98 files / 658 tests passed; translations validated for all 60 locales. The additional save-reset assertions passed in the 11-test page suite.
- CLI: 7 files / 179 tests passed. Bootstrap (4) and hook (9) tests passed.
- Paging/query-budget regressions and the legacy routing-budget check passed. A 45-model browser preview verified 20/40/45 rows and explicit loading.
- `npm test` was attempted. The Windows Node 24 fork pool terminated with `ERR_IPC_CHANNEL_CLOSED` in unrelated existing API tests; a thread-pool attempt also crashed. Split fork runs exposed an existing timer-sensitive hedge test (passed on focused retry) and a pre-parse socket test returning `ECONNRESET` on Windows. Do not report the local full backend suite as green. Full Linux CI on Node 20/22/24 is required before merging.

Cold global ranking still reads a lightweight catalog index. Continuation tests assert detail joins bind only selected member IDs and perform no additional request-history/rate-limit-history scan while the shared caches are warm.
