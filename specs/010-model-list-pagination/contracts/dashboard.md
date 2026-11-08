# Dashboard contract
GET /api/fallback/page: existing dashboard auth/permission gates. Query: profile, search, vision, tools, context, sort, direction; continuation adds snapshot and offset. Page size is fixed at 20 groups. Filtering/order applies globally. Return entries, routing (page scores only), rateLimitUsage (page rows only), tokenSummary totals, ranks, total/matched group counts, nextOffset, snapshot and unconfiguredPlatforms. Invalid input is 400, missing profile 404, expired/mismatched snapshot 410.

PUT /api/fallback/page: explicit nullable profileId and entries [{modelDbId, priority, enabled}]. Validate profile and IDs, update/upsert only submitted rows in a transaction and invalidate page snapshots. Existing legacy routes retain their original behavior.

GET /api/fallback/page/live: same selection plus required snapshot and count (number of opened logical groups). One 30-second refresh returns current scores/quota for opened groups only, retaining the pinned table order. It reuses the scoring/window snapshots and does not rehydrate detail joins. A cursor expires after five minutes without access; at most 16 snapshots are retained per database, with least-recently-used eviction.

GET /api/fallback/page/budget: explicit profile; returns the full monthly-budget legend only when expanded. Initial pages carry aggregate totals. Budget usage reuses the existing scoring statistics rather than issuing another history scan.

UI: Load more is explicit and disabled while in flight. Keep earlier pages on a failed continuation. Changing selection resets to the first batch. Show loaded/matching totals. Reordering is guarded until all configured models are loaded and the selection is unfiltered.

Successful save/strategy changes reset the list to its first batch. Endpoint-collision metadata is computed across the index so a custom endpoint remains unambiguous when its sibling is on an unopened page.
