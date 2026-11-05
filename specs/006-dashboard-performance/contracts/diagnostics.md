# Diagnostics contract

- `CUSTOM_PERF_METRICS=1`: opt-in at process start, otherwise off. Restart after changing it.
- No HTTP endpoint, header or response-body changes.
- `[performance]` log records are JSON aggregates. Fixed backend/phase/GET route labels, numeric counters/durations and completion status only. No per-request identifiers, URL parameters, SQL, identities or payloads.
- Request duration includes downstream middleware, parsing, authentication, handler and response finish; it is not a separately isolated handler timer or browser time-to-data.
- Logical `prepare_calls`/`db_calls` are not RPC counts. `native_prepare_calls` measures Turso adapter cache misses, not transport handshakes/retries. SQLite native preparation is represented only by logical prepare timing. Prepare time can include native prepare time; do not add them.
- `db_calls` counts get/all/run/exec/pragma invocations, not statements inside multi-statement exec. The database histogram is execution time per request, excluding preparation. Zero/sub-microsecond samples are represented by the minimum 1 microsecond bucket.
- Route request/database histograms use microseconds internally and report milliseconds; clamp at one hour, with 3 significant figures. Event-loop histogram uses nanoseconds internally and reports milliseconds. No samples => null distribution.
- Minute snapshots reset bounded route counters/histograms. Event-loop stats and RSS are process-wide; RSS is a current sample, not a process peak. Workload benchmark samples RSS after responses and reports that sampled peak.
- Startup phases measure DB initialization and response-cache hydration separately. They exclude Render scheduling, container startup and prior module imports.
- Internal benchmark collector disables periodic reset so long workloads retain all server samples. Client count mismatch fails the benchmark.
- Stop monitor/timer on graceful shutdown. Rollback: remove flag and restart.
