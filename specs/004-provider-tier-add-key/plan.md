# Implementation plan
## Summary and technical context
React/TypeScript, TanStack Query, existing AddKeyDialog and AddEndpointKeyDialog. Standalone custom row-action component, minimal render hook in ProviderTiersPanel, no backend changes or dependencies.
## Constitution check
PASS: no credential persistence/logging, existing manage_keys controls and APIs, modular implementation, branch/PR, tests/build/lint. No migrations. Post-design: PASS.
## Design
Only fetch /api/keys when an authorized operator opens a custom row. Match normalized endpoint scope to the existing opaque SHA-256 providerId (first 20 hex digits), never by label/host. Reuse existing endpoint dialog for the resolved URL. Standard supported providers use initialPlatform. Mount dialogs only after first selection but keep them mounted across close so AddKeyDialog can show its model-scope offer. Use a per-open key when reopening to clear stale form/scope state. Invalidate provider-tiers on close and use session-revision component keys to drop old session state. No changes to shared add-key components.
## Validation
Component tests cover permission hiding, standard preselection, independent providers, exact custom matching, failure without fallback, and tier invalidation. Run workspace tests/build/lint; require Linux CI before merging.
