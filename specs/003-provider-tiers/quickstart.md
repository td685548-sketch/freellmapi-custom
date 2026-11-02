# Validation guide
1. Run focused tests: npm run test -w server -- src/__tests__/custom/provider-tiers.test.ts and npm run test -w client -- src/custom/ProviderTiersPanel.test.tsx.
2. Run npm run test, npm run build and npm run lint.
3. Open Analytics as admin: verify provider keys badge, usable count, sample count and metrics; choose another range and refresh. Add/disable/remove keys in Keys and refresh: linked/usable counts update.
4. Empty providers are unranked. Below 20 samples remains unranked. Inspect explanation for thresholds/missing signals.
5. As member without view_logs, the API returns 403 and panel fetch is disabled.

## Local results (2026-11-02)
- Server custom + Analytics regression group: 11 files / 98 tests passed, including 8 new tier tests.
- Client: 60 files / 479 tests passed; 60 locales / 1311 keys validated. Includes 3 new panel tests.
- Full monorepo build passed (existing large-chunk warning). Server/CLI lint and changed client files lint passed.
- Root npm run test was attempted twice; Windows Vitest worker exited with ERR_IPC_CHANNEL_CLOSED at different existing suites, without completing server tests.
- Separate CLI suite: 178 passed, 1 existing path-separator assertion failed in detect.test.ts (/opt/... versus Windows backslashes). No CLI source/test changes in this feature.
- Linux PR CI is required before merging; do not interpret these local limitations as a full-suite pass.
