# Foundation review — 2026-11-14

Verdict after corrections: F1–F7 FIXED on `codex/ai-platform-foundation-review`. Review scope is foundation/US1 T001–T033, not the future US2–US7 engines. The original findings below are retained as the review record; see the correction and release verification sections. No production deployment or PR merge performed.

## Reviewed integration

Reviewer branch: `codex/ai-platform-foundation-review`, based on latest origin/main `7bfdb7b0`. Agent-owned commits assembled with `git cherry-pick --no-commit`; peer cherry-pick copies were not imported twice. Original branches and commits remain unchanged.

- Agent 1/core: 226c10ab, 305849fd, 6929d5f5.
- Agent 2/wire: 2d8818d0, 1be8fdab, 5d70a5de.
- Agent 3/integration: cd78c350, 4073b141, 233ab137, 99eafcc7, 49869efd, d2af111f, 85e4c298.
- Agent 4/UI: fc31faaf, 448106e9, 2c4afee8, 5ebb162c.

## Findings

### F1 — P1 — Buffered Responses stream exposes unfiltered terminal payload (Agent 2)

`server/src/custom/ai-platform/wire/interceptor.ts:647–648` forwards pendingNonTextFrames without inspecting/rebuilding text-bearing lifecycle events. A normal `response.completed` contains the complete original output; `response.output_text.done` and `response.content_part.done` can also contain text.

Reproduction: install a buffering/failClosed Responses filter whose onComplete returns `[MASKED]`; stream `response.output_text.delta` containing `private@example.test`, followed by `response.completed` containing the same output. Actual client response contains BOTH `[MASKED]` and `private@example.test`. Expected: every client-visible textual representation reflects the filtered result. Sanitize/rebuild all terminal/content events and keep protocol ordering valid. Add real HTTP stream tests; checking only delta frames is insufficient.

### F2 — P1 — Gemini JSON-array streaming bypasses failClosed and buffering (Agent 2)

`server/src/custom/ai-platform/wire/interceptor.ts:434–435` immediately forwards frames without `data:` even when filters are failClosed/buffering. Gemini streamGenerateContent without alt=sse uses JSON-array streaming.

Reproduction: end a Gemini response with `[{"candidates":[{"content":{"parts":[{"text":"unfiltered-private-text"}]}}]}]`, using a failClosed/buffering filter that returns `[BLOCKED]` with a reason. Actual: original private text reaches the client before the synthetic block SSE frames. This also mixes JSON and SSE, corrupting framing. Expected: parse/support the negotiated Gemini format or reject unsupported framing before emitting any original bytes. Documenting pass-through as a limitation does not satisfy failClosed.

### F3 — P1 — purgeScope deletes neighboring scope data (Agent 1)

`server/src/custom/ai-platform/scope.ts:48–49` interpolates literal separators and arbitrary agent IDs into a LIKE pattern without escaping SQL wildcards. Specifying ESCAPE alone does not escape underscores or percent signs.

Reproduction with an in-memory settings table: insert `ai_platform_scope_profile_1_notes` and `ai_platform_scope_profile_10_notes`; call `purgeScope('profile', '1')`. Actual: 2 rows deleted, no rows remain. Expected: only profile 1 is deleted. Agent IDs containing `%` or `_` broaden the match further. Escape all literal pattern characters, including separators/ID, or use exact prefix comparison. Add profile 1/10 and wildcard-agent isolation tests. This exported helper is not yet wired to profile deletion; its current implementation must not become a cleanup primitive unchanged.

### F4 — P2 — Valid loopback HMAC fails at the real mounted middleware boundary (Agent 3)

`server/src/custom/ai-platform/loopback.ts:162` verifies req.path, but callGateway signs `/v1/chat/completions`. In the actual `app.use(['/v1', '/v1beta'], profileInferenceGate)` mount, req.path is `/chat/completions`.

Reproduction using real Express JSON parsing and callGateway: root POST handler at `/v1/chat/completions` verifies `{depth:1}`; handler under `app.use('/v1', ...)` receives the same valid signed call and verifies null. Expected: stable canonical signed path and valid internal-call detection in the real gateway pipeline. Also verify before profile prompt/knowledge injection changes the signed body; otherwise the original body hash no longer matches. Existing flat-server tests miss the mount boundary.

### F5 — P2 — Gemini caller credentials are lost on loopback (Agent 3)

`server/src/custom/ai-platform/loopback.ts:243–246` only reads Authorization and x-api-key. Existing inference gates accept x-goog-api-key and Gemini `?key=` too.

Reproduction: callGateway with a caller request using only `x-goog-api-key: test-caller-key`; the receiving local handler observes no Authorization header. A real authenticated gateway rejects this subcall with 401. Expected: reuse the existing canonical credential extractor and forward the same caller credential, without replacing it with a privileged key. Cover all accepted credential spellings and preserve caller scope restrictions.

### F6 — P2 — Internal-header stripping helper is never installed (Agent 3)

`server/src/custom/preparse-guard.ts:86–95` defines stripInternalHeaders, but preparseGuard never invokes it. Repository search finds no production caller. app.ts installs only preparseGuard.

Reproduction: invoke the production preparseGuard on a small external POST with socket remoteAddress `203.0.113.9` and `x-ai-platform-internal: forged`. The guard calls next with the header unchanged. Expected: remove the header before every early return/auth check, including small requests. HMAC still prevents direct forgery from becoming a valid internal call, so this finding does not claim an authentication bypass; it is a missing required trust-boundary control. Add an HTTP integration test rather than only directly testing the helper.

### F7 — P2 — Native dashboard has no navigation entry (Agent 4)

`client/src/App.tsx:520` dispatches a directly entered `/ai-platform` URL, but no native Navbar/menu item was added. A search outside the new subapplication and translation file finds only the import and pathname dispatch; no `/ai-platform` navigation target exists.

Expected by T032: add the native navigation entry, gate it by the AI Platform permission group, and test the real app navigation for viewer/non-viewer sessions. The subapplication's own Overview link does not make the page discoverable from the main dashboard.

## Initial review verification (before corrections)

- Combined foundation backend + surface + base migration tests: 14 files, 163 tests passed.
- Client AI Platform + translation tests: 3 files, 26 tests passed.
- `npm run build -w server`: passed, including shared compilation.
- Client `tsc -b`: passed.
- Additional synthetic probes used only in-memory SQLite and local HTTP servers; all confirmed F1–F6 as described. Positive root loopback control returned `{depth:1}`.
- No Azure writes, real provider calls, production mutations, merges or pushes.
- Broad monorepo tests were not repeated after identifying these blockers; current green unit tests do not establish the missing integration invariants.

Local reproducer commands (ignored diagnostics in this review checkout):

```powershell
node --import tsx data/foundation-review-probes.mjs
node --import tsx data/foundation-loopback-control.mjs
```

## Handoff/ownership notes

Agent 3 commit 99eafcc7 edited original research.md and contracts/inference-surface.md despite the dispatch ownership list marking unlisted original spec files read-only. The reviewer checked the actual register.ts mount and accepted these documentation corrections. The migration registration/roundtrip touchpoints are now recorded in plan.md, and research.md R11 explicitly records that foundation does not install SQL UDFs or automatic cleanup for future pillar tables. The baseline provenance was subsequently verified against the original base and helper commit as documented below. Coverage remains normalized payload/body and Content-Type, not a certification of every response header or raw byte.

## Corrections and verification — 2026-11-14

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| F1 | Responses delta/done/content-part/item/response snapshots are rewritten consistently. Buffered events retain their original order and item identifiers; empty start events remain empty. | Real HTTP tests for buffered and non-buffered masking; original private text absent from every returned event. |
| F2 | Gemini JSON arrays are held within a finite buffer, parsed and filtered before output, and returned as JSON arrays with usage metadata. Malformed/oversized failClosed streams return a valid SAFETY response. | Chunked-array mask/block cases, malformed input and a >4 MiB end chunk. |
| F3 | Scope deletion uses an exact substring prefix comparison rather than SQL LIKE wildcard matching. | Profile 1/10 and agent IDs containing literal percent/underscore remain isolated. |
| F4 | HMAC uses the original canonical path. The profile gate captures verification in a private WeakMap before token caps, conversations and knowledge injection mutate the request. Gateway subcalls target a loopback IP and the server's own listening port. | Real mounted profile gate test verifies depth/runId after max_tokens capping and actual knowledge injection. |
| F5 | Gateway loopback reuses the existing inference credential extractor and sends the same credential as Bearer authorization. | Bearer, x-goog-api-key and Gemini query-key requests pass the real profile gate with the same caller key. |
| F6 | preparseGuard calls stripInternalHeaders before all early returns. | Real external/forwarded GET and small POST requests lose the forged header. |
| F7 | Native desktop/mobile menu entries use the AI Platform permission group and localized label. | Native Navbar rendered with createRoot/act; viewer/editor/parent permissions can click through, unauthorized users see no link, Vietnamese label is verified. |

Also prevented Express res.json from being filtered a second time through the patched res.end, bounded buffered SSE frames/text, and removed two unused variables in Agent 4's permission tests that failed lint.

Observed RED: the initial new backend regression run had 10 failures (the existing two scope cases still passed). After implementation, the regression cases passed; no assertions were weakened or disabled.

Final checks observed:

- Related server suite: **24 files / 264 tests passed**, covering the complete foundation tests, default surface, preparse, profile knowledge/conversations/restrictions/usage, client profiles, system prompts and migration registration/roundtrip.
- Final focused rerun after the stream snapshot correction: **3 files / 100 tests passed** (HTTP regressions, scope, permissions); subsequent buffer-bound corrections rechecked interceptor/HTTP tests (**18 passed**).
- Entire client suite: **112 files / 826 tests passed**; i18n validation **60 locales / 1336 keys** passed.
- Root `npm run build` passed; final server rebuild passed; compiled app loaded with plain Node.
- Root `npm run lint` passed; scoped client lint passed.
- `npm run test:migrations`: **3 passed**.
- No real provider or Azure storage calls were performed by these checks. The full server suite was not rerun in this correction turn; release/PR validation must not present these targeted counts as a full monorepo test pass.

## Release/PR verification — after main 8ce07065

The review branch was fast-forwarded to main 8ce07065 before restoring the foundation changes. The App.tsx conflict was resolved by keeping the new FreeLLMAPI/Thruline PageSwitch and the permission-gated AI Platform entry, without restoring the obsolete Thruline menu entry. The temporary pre-update stash was retained until the changes were safely committed.

- **Server coverage: all 571 test files exercised** in 8 isolated source snapshots, each with its own temporary directory and module cache; command `vitest run --pool=forks --fileParallelism=false --shard=N/8 --testTimeout=30000 --no-cache --fsModuleCachePath=../module-cache`.
- Six Windows native fork exits (3221226505) were not counted as passes. Affected files were rerun serially: `routes/mcp`, `routes/moderation`, `routes/proxy-tools`, `routes/keys-import-models`, `routes/keys-export-password`, `custom/x-request-details-systemone`. The five latter files plus preparse/failover tests passed together (**60 tests**); the MCP file passed separately (**21 tests**).
- The existing `custom/preparse-guard` first upload test had an intermittent Windows ECONNRESET and the existing `custom/failover-budget` query-count test exceeded its unchanged budget during the parallel run. Both passed on the serial rerun; their assertions and budgets were not relaxed.
- The full run exposed the old `custom/granular-permissions` exhaustive leaf-operation matrix missing the new 21 leaves. Added explicit method/path/permission rows without removing its set-equality assertion. The complete updated file passed (**12 tests**). A separate rerun also confirmed the golden regression suite (**14 tests**) using the extended manifest.
- These are reconciled full-suite results, not a claim that one uninterrupted root `npm test` command returned zero. Ten existing conditional server skips were observed. The 30-second CLI timeout is local validation configuration; no source test timeout or CI workflow was changed.
- **Client: 115 files / 851 tests passed**, including main's new page-switch tests, AI Platform UI and real native Navbar tests. i18n validation passed for **60 locales / 1336 keys**.
- **CLI: 7 files / 181 tests passed**. Bootstrap: **2 passed / 2 Windows platform skips**. Hooks: **9 passed**.
- Root `npm run build` and `npm run lint` passed after the main update. Scoped lint of the additional permission-matrix edit passed. `npm run test:migrations`: **3 passed**. Compiled `server/dist/app.js` loaded with plain Node.
- Replayed frozen T005 tests against an immutable archive of base **17328a17**, with only T002 helper **2d8818d0** and original T005 test/fixtures **cd78c350** added: **14 passed**, without CAPTURE_BASELINE and without regenerating fixtures. The manifest now records the exact source/helper/fixture commits, verification command and SHA-256 values of the original fixture Git blobs.

No unresolved failed test files remain after the documented correction/reruns. No test assertion was disabled to make the release checks pass. No real provider call, Azure write or production deployment was required.
