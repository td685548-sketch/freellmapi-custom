# Implementation Plan: Provider tiers
## Summary
Add a dedicated read-only Analytics panel backed by two grouped SELECTs. Reuse scoring primitives without touching inference or key caches.
## Technical Context
TypeScript/ESM, Express, React/TanStack Query, SQLite/Turso synchronous Db abstraction, Vitest. No new dependencies or schema changes.
## Constitution Check
PASS: credential-free response, existing auth/view_logs permission, standalone service/router/component, minimal mount/render hooks, meaningful tests, branch/PR workflow. No migrations needed. Post-design check: PASS.
## Project Structure
- shared/provider-tiers.ts: DTO, range/tier types.
- server/src/services/provider-tiers.ts: bulk observation/key aggregation and pure tier/score calculation.
- server/src/routes/provider-tiers.ts: validated GET endpoint.
- server/src/custom/register.ts: mount behind auth + view_logs.
- client/src/custom/ProviderTiersPanel.tsx: table, explanation, query states and manual refresh.
- client/src/pages/AnalyticsPage.tsx: single panel render with range.
- server/src/__tests__/custom/provider-tiers.test.ts and client/src/custom/ProviderTiersPanel.test.tsx: regression tests.
## Design
Use retained chat requests, success/error only, requiring a recorded key_id as evidence of dispatch (deleted keys retain their numeric id in requests). Join models by primary key, never model name alone; preserve custom scope using model endpoint_scope then normalized key base_url. Group keys separately before merging so keys never multiply requests. All queries select only needed metadata, never encrypted_key or key labels. Two queries regardless of provider count.
Reliability uses expectedReliability(success,error). Speed uses successful output tokens / positive successful latency and mean valid successful TTFT; unavailable speed is null. Intelligence uses configured metadata of observed models, normalized across measured known models in the selected range, weighted by observations. Unknown labels are null. Balanced weights are renormalized over available axes; score is null for zero observations. Tier needs >=20 observations. Current usable-key status is informational, not quota/cooldown readiness. UI explains score/tier heuristics and retained-history limitation.
## Validation
Focused server tests cover endpoint isolation, range, no join fan-out, missing metrics, thresholds, permission denial and absence of secrets. Client tests cover counts and query states. Run npm run test, npm run build and npm run lint, then PR CI before merge. Verify Render deploy by exact merged SHA.
