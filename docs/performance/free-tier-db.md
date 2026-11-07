# Database cost on the free plans (Render + Turso)

Turso bills by **rows read** (rows the engine visits, not rows returned) and rows written; a
synchronous remote statement also blocks the Node event loop on Render. Measured with a statement
tracer on a production-mode server holding 100,000 request rows (the default cap):

| Job (runs while traffic flows) | Before | After |
|---|---|---|
| Count-bound prunes of `requests`, `server_logs`, `search_requests`, `decision_requests` (`DELETE … OFFSET maxRows`), every 60 s | visited every row of each table each pass (133 ms for `requests` alone) | two index-end reads per table (`MIN`/`MAX` rowid); the exact `OFFSET` delete runs only when the table may exceed its cap |
| Routing stats refresh (last 7 days + month to date of `requests`), every 60 s | full scan of both ranges each minute (458 ms on 100k rows) | every 10 minutes on Turso (`ROUTER_STATS_TTL_MS` overrides; local SQLite keeps 60 s) |

Not changed, worth knowing:

- **Health checker**: probes every key every ~5 minutes and updates its row (about one row write per key
  per pass; 138 keys ≈ 40,000 writes a day). `HEALTH_CHECK_INTERVAL_MS=900000` (15 min) cuts that to a third.
- **Analytics page**: each open runs about a dozen aggregate queries over the selected range; it does not
  poll. Short ranges are cheap; "all time" reads the whole retained log.
- **Per request**: about 11 row writes (request row, hourly aggregate, lifetime counters, rate-limit
  usage, attempt trace, key ledger trigger, plus allowance counters when configured).
- Render free sleeps when idle; anything that keeps it awake (an open dashboard tab polling
  `/api/ping`, an uptime monitor) also keeps the background jobs above running.
