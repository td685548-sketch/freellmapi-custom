# Feature Specification: Cache settings and granular permissions
**Branch**: codex/cache-settings-granular-permissions
**Created**: 2026-11-02
**Status**: Ready
## User scenarios
### US1 - Configure response cache (P1)
An authorized operator opens Settings, views cache status, explicitly enables/disables it, chooses memory-only versus persistence, and clears entries with a separate permission. Existing cache default stays off until a user changes it. Explain system-wide scope, exact matching and plaintext persisted responses.
Acceptance: config survives a restart; unauthorized users cannot change or clear cache; failed saves show errors without claiming success.
### US2 - Grant granular actions (P1)
Primary Admin assigns child permissions within all existing groups: provider keys, users, invites, registration, settings/cache, backups, logs/analytics. Existing parent grants imply their children; child grants never imply the parent or sibling actions.
Acceptance: view-only cannot add/edit/delete/reveal/export; add-only cannot list other keys; each action is checked by API, not only UI.
### US3 - Restricted secondary administrators (P1)
Primary Admin always has full immutable authority. Existing full-access admins keep it; explicitly assigning a limited set to a secondary admin takes effect on its next request. Delegates cannot edit their own grants, alter Primary Admin, grant permissions they do not hold, or obtain full access by promoting an account.
Acceptance: restricted admin sessions and members obey the same child gates. Role changes never mint broader access for a restricted actor. Unknown routes under a protected prefix fail closed to the parent permission.
## Requirements
- R1: Grouped parent/child permission editor, select/clear group and individual leaf actions, with clear full-access semantics.
- R2: Shared implication rules on client/server, complete method/path checks for existing administrative surfaces and preserved public/member inference routes.
- R3: Capability-aware navigation and UI actions; original full-management pages stay available to full managers, restricted key holders get a dedicated minimal view using existing key dialogs.
- R4: Atomic cache preference writes; persistence preference affects subsequent writes and startup preload. Turning master off is not a flush; clear has separate confirmation.
- R5: No cache activation or production permission changes performed by the agent. No credential logging, new secret exposure or modified old migrations.
- R6: Tests cover denial matrices, backward compatibility, secondary-admin restrictions and anti-escalation, cache preference validation and UI capability behavior.
## Success criteria
Every group has independently enforceable children, parent grants retain their former authority, denied mutations have no side effects, key secrets require reveal/export permissions and reauthentication, and CI is green before merge/deploy.
## Assumptions and edge cases
Existing JSON permission storage accepts new names, so no schema migration. Explicit empty admin permissions restrict the account; absent legacy permissions on an admin retain old full access. Corrupt JSON fails closed. Existing setup/local single-user behavior remains. Root account cannot be downgraded. A delegated role promotion keeps the target's already-held subset of permissions, never grants wildcard authority.
