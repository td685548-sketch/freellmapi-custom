# Quickstart
Sign in with use_x_gateway + view_x_usage. Open /x/quota, refresh a supported account, inspect limits/source/reset countdown. Configure tiers with edit_x_settings; verify auto uses subscription then cheap then free. Exhaust a fixture account; verify skip until reset/freshness expiry. Unsupported providers show unknown and local caps separately.

## Verification (2026-11-07)
- Validated an isolated quota-only source snapshot; concurrent Media and Proxy Pool changes are excluded.
- All 461 server test files passed. The Windows fork runner intermittently lost its IPC channel in long runs; the complete inventory was verified in smaller isolated batches, retrying only interrupted batches.
- Complete client suite: 90 files / 624 tests passed; i18n validation passed for 60 locales and 1311 keys.
- Complete CLI suite: 7 files / 179 tests passed.
- npm run build and npm run lint passed; the compiled server imported successfully with plain Node.
- Migration round trips, idempotence and cascading deletion passed.
- Fixed test-only Windows portability: avoid racing a refused upload against socket closure, use platform-aware path separators in the CLI fixture, and isolate conversation storage tests from the unrelated per-IP request cap. Production guards remain unchanged.
- Dedicated quota tests cover actual three-tier HTTP fallback, provider schemas, scoped 429, failed refresh, authorization, countdown and tier editing. Provider requests are mocked; no real credentials or paid resets were used.
