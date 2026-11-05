# Measurement data model

No persistent schema changes.

- Request scope: prepare/native-prepare/execution counts and durations, errors and settled flag. Late work after settlement is ignored.
- Route aggregate: fixed GET route, response status class counters, aborted counter, bounded duration histograms, numeric DB totals.
- Process window: event-loop p95/max in ms, utilization, RSS, elapsed time. One monitor/timer per process with explicit cleanup.
- Workload: synthetic fixture size, role, route, concurrency, sample count, client duration and expected/unexpected status counts.
