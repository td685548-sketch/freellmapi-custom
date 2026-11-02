# Feature Specification: Add keys from provider tiers
**Branch**: codex/provider-tier-add-key
**Created**: 2026-11-02
**Status**: Ready
## User Scenarios & Testing
### US1 - Add a provider key (P1)
An operator presses Add key beside a tier row and sees the existing key popup preselected to that provider. Successful additions update the displayed count and preserve the existing optional model-scope follow-up.
Acceptance: open two different provider rows consecutively; each preselects correctly, with no credential carried between providers. Cancel makes no write.
### US2 - Custom endpoint and permissions (P1)
A custom row adds a credential to its exact endpoint, including same-host endpoints with different paths. Users without manage_keys see no add action and make no key-roster request.
Acceptance: custom endpoints are resolved from current authorized key metadata, never from display names. Unsupported/deleted endpoint targets show an explanation instead of opening the wrong provider.
## Requirements
- FR1: Reuse the existing provider/endpoint popups and submission APIs, including validation and error handling.
- FR2: Add one labeled action to each supported row, gated by manage_keys; preserve view_logs for the table.
- FR3: Invalidate tier counts when the add flow closes; keep existing model-scope follow-up intact.
- FR4: No new backend endpoints, permissions, schema, credential storage or secret logging.
## Success Criteria
Tests verify preselection, consecutive providers, exact endpoint targeting, permissions and count refresh. Full build/lint and Linux PR CI must pass before merge.
## Edge Cases
Hidden/unsupported providers, custom rows whose keys were removed, roster-fetch errors, session changes and dialog cancellation.
## Assumptions
The action belongs next to the provider/count badge. A current custom endpoint credential is needed to resolve its private endpoint URL without exposing it in the public tier DTO. Historical unsupported rows have a disabled action with an explanation.
