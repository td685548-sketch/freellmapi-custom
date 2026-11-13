# Implementation Plan: Knowledge Evidence & Answer Quality

**Branch**: feat/9router-integration · **Date**: 2026-11-13 · **Spec**: [spec.md](spec.md)

## Summary

Add a versioned, encrypted knowledge library, deterministic role-filtered retrieval, validated answer citations and a retrieval evaluation workflow. Preserve017 by default; an explicit required policy switches a tenant to a knowledge-only assistant. Use existing runtime dedup/lease/quota/masking and existing escalation; do not introduce an independent chat executor.

## Technical Context

- Existing TypeScript ESM npm monorepo; React/native createRoot/act frontend tests; existing SQLite Db abstraction for supported adapters; no new dependencies/services.
- Plain text/Markdown/FAQ JSON; bounded synchronous normalization/chunking, safeFetch for editor-only remote exports. No HTML/PDF parser or crawling.
- New tables and one registered migration; SQL stores encrypted source/revision/chunk content, optimistic source versions, policy, evaluation and answer references. See data-model.md.
- Retrieval is normalized lexical matching, not vector search/confidence. Scan only bounded authorized chunks; legacy docs use a read-only adapter, not a rewrite of support-knowledge.ts.
- New `/thruline/support-knowledge` admin page; current grouped navigation in shell/nav.ts, route in XGatewayApp.tsx; extend actual runtime widget for citations and abstention.

## Constitution Check

PASS at design: encrypted raw imported content; no provider secrets in errors/logs; shared DTO ownership; additive migration and static registration; existing safe HTTP; minimal new router/nav mounts; old `/v1`, health endpoints and017 default behavior unchanged. No new package, native binary or CI network tool. Schema down/second-memory-Db checks and full tests/lint/build are required at implementation review.

## Project Structure / Ownership

Authoritative exact lists and handshake are in ownership.md. Four disjoint owners:
1. Shared contracts, all new schema, source import/revision/policy/evaluation/answer-reference store, migration registry and roundtrip expectation.
2. Read-only retrieval/legacy adapter, evidence pack, citation verifier, deterministic evaluation service and fixtures.
3. Console routes; actual runtime, provider pipeline, replay/history integration and regression HTTP tests. Own all017 runtime/workflow bridge edits.
4. Knowledge Studio EN/VI, current navigation/route, runtime widget rendering and native React/jsdom tests.

No source files are created by the spec author. Agent1 exports exact interfaces first; others may test their owned modules with contract fixtures until peers exist, but final integration has no fallback/mock registry or fabricated citation.

## Phase 0 — Research

[research.md](research.md) records current-code evidence, explicit limits, migration registration, opt-in behavior, no-package import formats, the difference between citation membership and factual support, and the intentional separation from016. No external research service or unresolved clarification is needed for this repository-scoped design.

## Phase 1 — Design

Canonical DTOs/schema/services: [data-model.md](data-model.md). HTTP and runtime protocol: [contracts.md](contracts.md), mirrored by [contracts/http.md](contracts/http.md) for Spec Kit discovery. Agent assignments: [ownership.md](ownership.md). Validation: [quickstart.md](quickstart.md).

### Flow

Import outside transaction -> normalized immutable draft + chunks committed atomically -> explicit OCC publish -> role-filtered EvidencePack ->017 firewall/claim/lease/quota orchestration -> optional bounded provider call with business tools/CRM disabled -> citation/snapshot verification -> masked final answer or explicit abstention -> atomic history/provenance/cache/quota settlement.

Generation failure stays a503. No evidence before generation is a known zero-model result with one request charge and zero tokens. A generated answer rejected by citation/snapshot checks still bills observed provider usage; unknown cost is never refunded. Record exactly one customer message and at most one AI message; abstention has no AI transcript message and carries turn-linked evidence metadata for reload. The persisted customer message carries a safe responseNotice for the non-AI status (see contracts).

### Publication / concurrency

Each mutable source has OCC version. Draft creation changes its management version but not the active snapshot. Publish, archive and ACL edits are short atomic transactions. Active snapshot hashes published revisions, current ACL/state, policy version and current eligible legacy doc hashes; no hook into legacy mutations is needed. After any async boundary, revalidate against current tenant/role/catalog before committing. Never run network/model awaits inside a Db transaction.

### Cache / history

Revalidate an018 cached result before returning it; changed snapshot ->409 knowledge_context_changed, no provider call or extra charge, client must choose a new requestId. For018-cited assistant messages, revalidate references when sending history to browser/provider; invalid sources redact the whole affected answer and citations. Required-mode provider context omits legacy assistant messages without evidence rather than claiming them grounded. Preserve017 behavior for unprovenanced legacy history displays.

### Non-goals

016 branding/Copilot/SLA; semantic embeddings; arbitrary HTML/PDF imports; scheduler/crawl; streaming/SDK/billing/SSO; autonomous promotion of drafts; business-tool/CRM evidence and model-based semantic evaluation. These remain later work, not unfinished acceptance placeholders.

## Phase 2 — Implementation handoff

30 tasks in tasks.md, not executed by this reviewer. Development gate: frozen shared contract -> foundation/API exports -> actual integration -> reviewer security/regression acceptance. One Agent1 migration includes all tables consumed by Agent2/3; only Agent1 changes defaults.ts so there is no competing registration edit.

## Complexity Tracking / Risks

- Required mode is a separate explicit product choice: knowledge-only, no business tools or CRM. UI must explain this before enabling it.
- Lexical coverage is not semantic confidence; citation validity is not entailment. All claims/metrics must preserve that distinction.
- Bounded source/chunk/suite limits keep this deployment self-contained; reject over-capacity rather than silently omitting eligible sources or claiming full evaluation.
- Existing raw legacy documents are not migrated/encrypted retroactively. New imported bodies/chunks are encrypted; no new plaintext copy/cache of their bodies.
- A cache reply may be refused after source changes. No automatic regeneration under an old requestId; this is safer and more predictable than charging an implicit new turn.
- CLI/client/full server checks may be sharded for local runner limits only with a complete file inventory and honest command evidence, never by skipping failures.

Post-design constitution gate: PASS. Implementation/CI acceptance remains pending; no PR at specification time.
