# Concurrent integration ownership

Operations agent owns CLI Tools UI/API (operations-api.ts, operations-config.ts,
operations-router.ts and pages/CLIOperations.tsx),
tool-probe.ts, diagnostics.ts, OperationsStatus.tsx, local setup/download,
shared/x-operations.ts, operations tests and docs/x-gateway*.md.

No package.json, lockfile or Dockerfile changes are required. Minimal mount hooks
are in XGatewayApp.tsx and console-router.ts. A standalone OAuth credential writer
supplies a missing dependency of the lifecycle module already committed on this
branch, without including pending provider adapters/UI work. Other agents' changes
changes are preserved. Inference probes use real HTTP, so no shared handler hook
is necessary. Diagnostics deliberately leaves saver/media verification unclaimed.
