# Research

- Use fixed allowlisted GET paths, never query strings, SQL or dynamic route labels. Native histograms bound retained memory; AsyncLocalStorage isolates concurrent request counters.
- Existing Keys monthly usage JOIN is already constant-query. TanStack shares matching health observers, so duplicate observers are not proof of duplicate HTTP requests.
- Models routing/usage poll every 15s; Analytics opens about 12 requests; Logs polls every 3s and reads a ring buffer. Auth is performed by custom permission gates and repeated by upstream mounts; measure this before a separate optimization.
- Benchmark only createApp with in-memory SQLite, fake encrypted keys and synthetic sessions. Do not import env.js/index.ts or start workers. Native libSQL stays unchanged; no Promise conversion of the existing contract.
- Local evidence cannot measure browser waterfall, remote network latency, Render sleep or region. Staging measurements remain necessary before choosing infrastructure or async rollout.
