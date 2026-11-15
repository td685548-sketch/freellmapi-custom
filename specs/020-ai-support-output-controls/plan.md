# Technical plan

TypeScript ESM, existing Db abstraction/crypto, Express, React createRoot/act tests. No dependencies, CI, package/lockfile changes. Separate output files; minimal hooks in custom runtime and console.

1. Freeze shared DTOs/store/evaluator contracts from contracts.md. Use Spec Kit specify -> plan -> tasks before speckit-implement when actual implementation begins; preserve the agreed020 scope and record deviations for reviewer.
2. Agent1: new encrypted policy table and metadata-only events table, reversible timestamped migration; schema bootstrap reuse migration up() with per-Db identity. Never edit old migrations. OCC synchronous/atomic, no await in transaction.
3. Agent2: pure evaluator accepts explicit policy and text leaves; no Db/model/network/logging. Bounded Unicode normalization/literal matching, credential patterns, fixed notices and deterministic results.
4. Agent3: standalone adapter composes existing masking and018 validation with evaluator. Hook customer generation and both final commit branches; transaction reload of latest policy and no async work. Sanitize canonical reads, cached payloads and019 Copilot. Preserve original charge/lease/fencing.
5. Agent4: protected console router, minimal mounting and permission-map hook; isolated Studio and route/nav changes. No new public management endpoints.

Dependency direction: shared <- store/engine <- adapter <- runtime/workflows/Copilot. Adapter must not import runtime/workflows/Copilot/router to avoid cycles. Policy/event store does not import runtime. Auth is explicit at HTTP and existing canonical ownership checks remain before reads.

Events and final result are committed together where generated finalization already uses a synchronous DB transaction. Store accepts explicit Db to join the transaction, never chooses a different DB. Separate history/replay evaluation is read-only and emits no duplicate events.

Integration baseline is reviewer-owned because current dirty019 code is not a portable baseline. Four isolated branches share exact accepted baseline SHA and contracts. Do not cherry-pick unrelated provider/Playground changes.

Constitution check: encrypted rules; zero raw logs; bounded execution; preserved public endpoints/single-user deployments; standalone files; new reversible migration; feature branches; test/build/lint; no binaries/CI network tooling.
