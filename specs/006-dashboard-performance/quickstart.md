# Quickstart

- `npm run test -w server -- src/__tests__/custom/performance.test.ts`
- `node --import tsx server/src/scripts/benchmark-dashboard.ts --samples=100 --keys=60 --ledger=1000 --concurrency=1,5,10 --output=dashboard-baseline.json`
- Repeat runs and scale to 1/300 keys and 100000 ledger rows. `--overhead=10000` compares disabled/enabled measurements.
- Set `CUSTOM_PERF_METRICS=1` on staging and restart; inspect minute `[performance]` summaries. No metrics endpoint. Remove flag/restart to disable.
- Full tests/build/lint, i18n, plain Node import and diff check before PR. Review evidence under docs/performance/REVIEW.md before merge/deploy.
