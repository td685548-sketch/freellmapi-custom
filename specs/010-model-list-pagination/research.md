# Research

## Decision: cache the lightweight global index, hydrate only selected groups
The backend research agent found four full reads on landing: chain metadata, scores, quota usage and monthly budget. Keeping these while slicing rows would save no DB work. Global dynamic ranking and canonical grouping still require all model identities, so reuse one scored index across visitors/clicks and query detail joins for selected IDs only. Reuse pure `groupRows` and pass the index to `getRoutingScores` to avoid duplicate scans.

## Decision: preserve whole groups and pinned snapshots
A model can have multiple providers; LIMIT 20 on provider rows would split models. Page group IDs, keep provider membership atomic and preserve a snapshot through continuation.

## Decision: partial writes and guarded ordering
Legacy PUT already updates only submitted IDs but targets the currently active chain. Add a validated profile-pinned write for the new client. Manual drag/jump is enabled only after all configured groups are loaded; reuse existing priority slots to preserve unseen rows.

## Alternatives
Client slicing alone was rejected because it saves rendering but no reads. LIMIT before global filtering/ranking was rejected because it changes search/sort and grouping. A new persistent model index/migration is unnecessary; existing caches and a bounded in-memory snapshot suffice.

## Decision: one refresh for opened groups
TanStack infinite-query polling would refetch every opened page and repeat detail joins. Disable it and use one live endpoint carrying the pinned selection and opened count. Reuse the scorer's cached best-key window usage instead of introducing another history SQL query; only opened IDs appear in the response. Keep the original snapshot alive during polling with a bounded, sliding five-minute lifetime.
