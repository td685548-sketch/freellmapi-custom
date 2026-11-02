# Verification
Test isolated permissions against actual API endpoints as member and restricted admin; verify 403 and unchanged DB for sibling mutations. Verify legacy parents/wildcard and Primary Admin, no self grant and no grant beyond actor. Exercise cache Settings toggle/persistence/clear only on local fixtures, never enable production cache as part of deployment. Run npm run test, npm run build, npm run lint and changed-client lint; require full Linux CI and verify exact live SHA.

## Local verification (2026-11-02)
- Server custom/cache/proxy-cache/config-batching regression group: 14 files / 150 tests passed. The security matrix covers all 43 action names and 420 unrelated HTTP operations, plus actual add-only creation, prohibited upserts, no self-grants, restricted role promotion, credential reads and cache updates.
- Client: 62 files / 493 tests passed; 60 locales validated. Original add/edit/keyless/unified-key flows remain covered.
- Monorepo build and server/CLI lint passed. All changed client files except the proxy component passed ESLint; proxy-settings-section.tsx retains exactly the existing upstream set-state-in-effect error and exhaustive-deps warning, verified by linting origin/main via stdin. No unrelated proxy refactor was made.
- Root npm run test attempted; Windows Vitest worker exited with ERR_IPC_CHANNEL_CLOSED, as on previous PRs. Full Linux CI is mandatory before merge.
- Read-only live audit: response cache remains off; no secondary administrators currently exist. No live users, keys, permissions or cache preferences were changed by the agent.
