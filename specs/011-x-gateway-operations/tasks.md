# Tasks: X Gateway hosted operations
- [x] T001 [US1] Implement bounded real HTTP probe and shared contracts.
- [x] T002 [US1] Replace CLI test API; cover auth, restrictions and upstream failures with HTTP fixtures.
- [x] T003 [US2] Add local setup/merge/backup/restore and temporary-home tests.
- [x] T004 [US2] Connect full key/model selection and setup download to CLI Tools UI.
- [x] T005 [US3] Add conservative session-scoped diagnostics and UI.
- [x] T006 [US3] Update operator guide, Render deployment matrix and smoke checks.
- [ ] T007 Run full tests/build/lint and Linux smoke; record verification limits.

Dependencies: T001 before T002/T005; T003 before T004; T006 after implementation.
Independent files may be developed concurrently; shared entry points stay isolated.
