# API
GET /api/thruline/quota — view_x_usage. Account metadata + windows, freshness/errors, local caps and tier, no credentials.
POST /api/thruline/quota/:id/refresh — view_x_usage. Official read-only adapter with 10s timeout, 30s cooldown and in-flight coalescing.
PUT /api/thruline/quota/:id/tier — edit_x_settings. Strict {tier: subscription|cheap|free}.
All routes require dashboard session; unknown account 404, malformed ID/body 400. Provider failures become sanitized per-account state, not dashboard authentication failures.
