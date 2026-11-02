# Validation
Run client tests, npm run test, npm run build, npm run lint and lint changed client files. In Analytics, open Add key on google and another provider: popup defaults follow the selected row. Submit with an operator-owned credential only; verify count refresh and optional scope picker. Cancel does not submit. Verify custom endpoints target distinct paths; viewers without manage_keys have no action. CI must be green before merge; Render must deploy the exact merged SHA after main CI.

## Local verification
- Client: 61 files / 484 tests passed; 60 locales / 1311 keys validated.
- Five new action tests cover provider preselection/reopening, preserved scope follow-up, permissions, same-host endpoint isolation, missing endpoint and unsupported rows.
- Monorepo build, server/CLI lint and lint of changed client files passed; existing large-bundle warning remains.
- Root npm run test attempted: 98 server test files completed before the Windows Vitest worker exited with ERR_IPC_CHANNEL_CLOSED; no full-suite pass claimed. This environment issue also occurred on PR #30. Linux PR CI must pass before merge.
