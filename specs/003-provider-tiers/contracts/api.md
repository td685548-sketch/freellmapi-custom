# GET /api/analytics/provider-tiers
Auth: dashboard session, view_logs permission (admin implicit). No provider calls or writes.
range: 24h | 7d (default) | 30d | 90d | all. Other/repeated values: 400.
200: {range, generatedAt, minSamples:20, rows:ProviderTierRow[]}. No key material or raw endpoint URLs; provider name is safe display text; providerId is an opaque endpoint digest for custom providers.
401 unauthenticated; 403 insufficient permission. Cache-Control: no-store.
