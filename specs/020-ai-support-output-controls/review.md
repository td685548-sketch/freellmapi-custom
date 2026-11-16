# Reviewer remediation and publication — 020

Branch: `codex/support-output-controls`. Base: `origin/main` at `1dbf92f5` (2026-11-15). User authorized remediation and PR creation after the initial review.

## Scope

Integrated the four owner implementations from their separate worktrees at baseline `90e45f06`, applying only their020 changes onto current main. Source checkouts and unrelated dirty changes are preserved. Current-main AI Platform output guard hooks/finish reasons remain composed with020.

- F1: inspect public trace names and sanitize/strip history traces on read.
- F2: restore validated citation ordinals before revalidation; retain already-redacted title/excerpt text instead of resurrecting source credentials. Covered for chat and every Copilot artifact.
- F3: policy evaluation, audit and lease-fenced Copilot completion/failure share one synchronous transaction. Blocking is reported after committing the failed job; corrupt-policy failures retain fenced state and honest model cost.
- F4: redact nonempty Bearer tokens, including1–7 characters, preserving delimiters and idempotent replacement.
- F5: route-specific256KiB middleware runs after existing preparse guards and before general JSON parsing. Limit applies to streamed/chunked and inflated JSON; malformed bodies get fixed errors without raw parser details.

No package/dependency/lockfile, CI, old migration, global theme or unrelated provider changes. New migration only; public endpoint compatibility preserved. No live model, external moderation, customer sends or production writes.

## Verification — accepted locally

Application source hashes match the frozen isolated server snapshots. Full server inventory and exact per-file counts: [verification-inventory.json](verification-inventory.json).

| Gate | Final evidence |
| --- | --- |
| Complete backend inventory | 620/620 unique files verified; 7,351 passed / 9 existing conditional skips / zero remaining failed tests |
| Execution method | Four isolated Linux snapshots, Node20.20.2; each shard155 files. A legacy migration test initially assumed its migration was latest; changed it to roll back through the named target, then reran that entire file successfully on Linux and Windows. No old migration changed. |
| UI suite | 123 files / 913 tests passed on Windows Node24.15.0; i18n60 locales /1336 keys passed |
| CLI suite | 7 files /181 tests passed |
| Bootstrap / hooks | PowerShell bootstrap2 pass /2 Bash platform skips; hooks9/9 passed |
| Migrations | Roundtrip3/3 and focused new/output + approval rollback suite6/6 passed |
| Build / compiled import | Full workspace build passed; final client rebuild after tenant-state cleanup passed; plain Node import of compiled app passed |
| Lint | Root server/CLI lint passed; scoped new Studio files lint passed |
| Diff review | Whitespace check passed; no package/lockfile/CI/provider/binary/unrelated changes |

An earlier Windows monolithic root test run was started before the last Copilot source adjustment and stopped; it is **not** reported as a pass. Acceptance uses the complete frozen Linux server inventory above plus the full Windows client/CLI and bootstrap/hooks runs. After source freeze, only the migration test correction changed a tested source file; that full file was rerun cold successfully.

Scoped additions prove the six original failures are fixed, as well as valid citations for summary/every Copilot draft, no restored source token in citation title/excerpt, policy-error job fencing and actual cost retention, malformed/oversized/chunked/inflated JSON boundaries, and preservation of current-main Support guard behavior. The new Studio editor uses tenant-keyed state and derives untouched drafts from query results; native UI regressions remain green.

## Publication

Ready for a single PR targeting main on codex/support-output-controls. CI is tracked in GitHub after publication. No merge authorized.

## Limits

Rules are bounded literal matching/known credential patterns, not semantic moderation or universal secret detection. Preview does not call models. Streaming, embeddings and missing MCP Client functionality are outside020. The initial rejected review remains in review-findings.md as history; this report supersedes its status.

## Follow-up completion — 2026-11-16

Branch: `fix/support-output-controls-completion`. Base: `origin/main` at `69d408be` (post-PR #73 merge).

### Scope

1. Stage 4 `retrievalCitations` enforcement & zero-model abstention ordering (`server/src/custom/x-gateway/support-output-runtime.ts`, `server/src/custom/x-gateway/support-runtime.ts`, `server/src/__tests__/custom/x-support-output-runtime.test.ts`):
   - Inspect `retrievalCitations` (`title` and `snippet` leaves) in `evaluateAndApplySupportOutputToTurn` and legacy `sanitizeSupportReplayResult`, removing `citations` / `runtime.citations` on `block` and returning redacted entries on `redact`.
   - Apply 017 `maskSupportSensitiveText` to `retrievalCitations` and pass the sanitized `activeCitations` through `finalResult.citations`, `runtimeMetadata.citations`, and the `X-FreeLLM-Citations` response header.
   - In the zero-model abstention short-circuit, run `evaluateAndApplySupportOutputToTurn` before `createOrAppendSupportConversation` / `saveSupportAnswerEvidence` and mask `finalResult.userContext` via `maskSupportSensitiveData`.
2. Canonical history/list read-only masking & 018 snapshot revalidation (`server/src/custom/x-gateway/support-workflows.ts`, `server/src/__tests__/custom/x-support-output-history.test.ts`):
   - Pass the conversation's original `userRole` (`found.userRole || requester.role`) into `sanitizeSupportEvidenceConversation` in `getSupportConversationForUser` (preserving `requester.role` for `hydrateSupportConversationIntake`) so staff views do not trigger false 018 snapshot mismatches or role elevation.
   - Apply read-only 017 `maskSupportSensitiveText` using `conv.userRole` across `ai_assistant` messages (`content`, `toolTrace[].toolName`, and `evidence.citations[]` `title`/`excerpt`) before `sanitizeSupportConversationOutput` in both `getSupportConversationForUser` and `listSupportConversations`, leaving `customer`/`human_agent`/`system` messages untouched.
3. Spec 020 documentation sync (`specs/020-ai-support-output-controls/checklists/requirements.md`, `tasks.md`, `README.md`, `review.md`):
   - Replaced absolute local `spec.md` path in `checklists/requirements.md` with relative `[spec.md](../spec.md)`, marked `T019` complete in `tasks.md`, updated `README.md` status, and recorded follow-up scope here.

### Verification

- Workspace build & lint (`npm run build && npm run lint`): exit code `0` (`@freellmapi/shared` `tsc`, `@freellmapi/server` `tsc`, `freellmapi` `tsc`, `@freellmapi/client` `tsc -b && vite build`, `server` `eslint .`, `cli` `eslint .`).
- Server scoped tests (`cd server && ./node_modules/.bin/vitest run src/__tests__/custom/x-support-output-store.test.ts src/__tests__/custom/x-support-output-engine.test.ts src/__tests__/custom/x-support-output-runtime.test.ts src/__tests__/custom/x-support-output-history.test.ts src/__tests__/custom/x-support-output-copilot.test.ts src/__tests__/custom/x-support-output-http.test.ts src/__tests__/db/migrate/support-output.test.ts src/__tests__/custom/x-support-evidence-runtime.test.ts src/__tests__/custom/x-support-workflows.test.ts src/__tests__/custom/x-support-service-desk-runtime.test.ts src/__tests__/custom/ai-platform/retrieval-citations.test.ts src/__tests__/custom/x-support-evidence-retrieval.test.ts`): exit code `0`, `Test Files 12 passed (12)`, `Tests 145 passed (145)`.
- Client 020 UI test (`cd client && ./node_modules/.bin/vitest run src/custom/x-gateway/support-output.test.tsx`): exit code `0`, `Test Files 1 passed (1)`, `Tests 5 passed (5)`.
- Diff audit: zero type suppressions (`as any`, `@ts-ignore`, `@ts-expect-error`), zero skipped tests, zero raw secret leaks.
