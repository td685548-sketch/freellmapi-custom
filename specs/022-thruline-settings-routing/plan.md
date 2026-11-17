# Plan — 022

- `server/src/custom/x-gateway/routing-defaults.ts`: schema, normalisation,
  cached read (5 s TTL, invalidated on write), `effectiveProviderPolicy`,
  `shouldRotateCombo`.
- `server/src/custom/x-gateway/routing-defaults-router.ts`: GET/PUT router,
  mounted from `console-router.ts`.
- `combos.ts#rotateComboEntries(name, entries, stickyLimit = 1)`: counter-based
  sticky rotation; limit 1 is byte-for-byte the old behaviour.
- `router.ts`: provider policy fallback → `effectiveProviderPolicy`; combo
  rotation → `shouldRotateCombo` + sticky limit.
- Client: `settings-api.ts`, `settings-strings.ts` (en/vi), `pages/Settings.tsx`,
  route + nav entry.
- Tests: server unit + HTTP tests, client page test.
