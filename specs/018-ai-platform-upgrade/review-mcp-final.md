# MCP Client / US2 — final integration review

Branch: codex/ai-platform-mcp-review. Reviewed agent integration: d30be6f4. Synchronized with origin/main at20398af3 (local merge84fb7796). This PR includes the US2 MCP implementation and its review corrections, following foundation PR48; it does not implement the other platform pillars.

## Corrections verified

| Review finding | Correction | Regression evidence |
| --- | --- | --- |
| R01: revocation during DNS | safeFetch runs authorization after validating every hop and pins those IPs for connect. Typed authorization failures propagate without a write retry. Read calls also reject rotated server configuration. | mcp-rereview.test.ts real HTTP with injected DNS; mcp-executor.test.ts rotation during initialize; MCP transport/E2E tests |
| R02: short credentials | Scrub every nonempty configured credential, including exact whitespace and JSON-escaped representations; approval redaction uses the same credential set. | mcp-rereview.test.ts short credential echo; mcp-sanitize.test.ts short/escaped strings; secret-leak.test.ts authenticated HTTP/export |
| R03: migration ownership | The safety migration leaves credential_generation to its original MCP migration. Rolling back/reapplying only safety preserves the existing generation value. | migration ai-platform-mcp-approval-safety.test.ts with generation7 and single-step down/up |
| R04: live owner recovery | Host-qualified owner identities require a demonstrably dead local PID (ESRCH) before reconciliation. Live, remote, legacy, reused PID and uncertain owners stay untouched; recovered journal state changes atomically. | mcp-maintenance.test.ts dead/live/remote/legacy/current owners and idempotent journal updates |
| R05: lossy inference controls | Forward frequency/presence penalties. A per-wire allowlist declines MCP takeover for unknown controls before quota admission; strict caller tool definitions are preserved. | mcp-rereview-http.test.ts actual provider body; mcp-tool-loop.test.ts cross-wire unsupported options and tool metadata |

The backup security fixture uses its own temporary database directory and cleans it up. It no longer depends on whether a developer checkout resides inside a hidden directory. No provider credentials, live services, packages or CI workflows were added.

## Verification

- Targeted server AI-platform + safe HTTP + safety migration:35files,300tests PASS after final runtime edits.
- Full client suite:118files,892tests PASS; i18n60locales/1336keys PASS.
- CLI:7files,181tests PASS.
- Root build PASS; final server build and root lint PASS; migration roundtrip3tests PASS; built app plain-Node import PASS.
- Root npm run test: 594 server files attempted:588passed,1timing failure,5native Windows worker exits (3221226505 / 0xC0000409). The run reported7079passed/10skipped tests before retries; its exit code was1, not a clean pass.
- The existing router-bandit exploration test hit its default5second timeout during the full run; an unchanged rerun of that exact case passed with the default timeout. No router/ratelimit source, timeout threshold or golden fixture was changed. All five interrupted files (models-management, keys, client-profiles, mcp, keys-import-selected-custom) were rerun sequentially:5files/126tests PASS, with no worker errors. The full client/CLI suites were run separately because the root script stops on the server exit code.

## Operational boundaries

MCP remains opt-in globally and per profile. Support-tenant bindings can be configured but this phase does not connect MCP to the support runtime. Approved writes execute once and expose a masked result; automatic chat/workflow continuation belongs to US7. An uncertain write is not automatically retried.

Automatic owner reconciliation is intentionally conservative. Remote or legacy owner IDs cannot prove a process is dead and require operator verification; a different UUID never authorizes a sweep. Unsupported request controls take the existing gateway path rather than losing their meaning inside the MCP loop.

Original prompt/review artifacts remain in the local mcp-dispatch directory. The committed regression tests and this report are the reproducible handoff for the final corrections. PR status/CI results are recorded on GitHub; there is no automatic merge.
