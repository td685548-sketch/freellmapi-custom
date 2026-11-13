> Historical handoff, completed. Do not redispatch this prompt. The user replaced shared-branch instructions on2026-11-13; new features, fixes and parallel agent assignments use separate branches under AGENTS.md. Current019 review/publishing branch: `codex/support-service-desk`.

You are Agent-2 for spec019 Support Service Desk & Widget Studio in C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL equivalent /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi), existing branch feat/9router-integration.

Read AGENTS.md and ALL of specs/019-ai-support-service-desk/{spec.md,plan.md,research.md,data-model.md,contracts.md,ownership.md,tasks.md,quickstart.md,review.md} before editing. Use CodeGraph first when .codegraph exists.019 supersedes unimplemented016 for this work; do not implement016 in parallel. PR25/018 is merged. Canonical URLs are /thruline, /api/thruline and /thruline/v1; internal permission/file names remain unchanged.

STRICT OWNERSHIP — no writes outside the paths below, including peer files, specs/prompts, old migrations, packages/lockfiles/CI/theme. No branch/worktree/switch/reset/stash/merge/rebase, staging, commits, push, PR, live provider charges or real customer writes. Preserve pending Kiro.ts and016 docs. If an unlisted edit is needed, report exact path/reason to reviewer; do not add an alias/fake store or suppress tests/types. The user dispatches four agents; reviewer reviews actual integration after handoff and alone handles conditional PR, never auto-merge.

CREATE:
- server/src/custom/x-gateway/support-agent-copilot.ts
- server/src/__tests__/custom/x-support-agent-copilot.test.ts
- server/src/__tests__/fixtures/support-service-desk/copilot-cases.json

EDIT ONLY:
- None.

Your tasks: T004,T013,T015,T016,T017. No existing application file edits are allowed.

Build a real provider-bound operator Copilot, not canned text or a second customer-chat executor. Read canonical conversation using its original customer's userId/role,018-sanitized history (exclude unprovenanced/redacted AI) and bounded actual-policy evidence packs even if chat evidence mode is off. Never upgrade to staff role, inject CRM/intake as instructions, accept browser history/context/model or call business tools.

Use executeSupportChatPipeline with disableTools=true and actual beforeModelCall/recordModelUsage/signal hooks. Do not call executeSupportTurn or mutate workflow/customer quota. Reuse Agent1 claims/budgets: reserve before every attempt, persist dispatch/cost, fence leaseToken and settle each attemptId once. Respect2 attempts/15s/1024 output tokens/whole prompt bound, no repair or fake usedFallback success. Whole assembled system/user/context is masked.

Strictly parse {summary,drafts} with exactly3 unique tones and independently validate018 citations for summary and every draft. One invalid artifact rejects the whole output; no raw text/aliases/log/cache leak. No-evidence is honest zero-model abstention; provider error503 remains error. Revalidate conversation and current evidence/policy/ACL/masking before commit/GET/replay; stale409 or safe sources_changed as specified, incurred costs retained. Do not fabricate confidence/sentiment/performance.

Write >=14 real-service regressions and >=16 EN/VI/four-role fixtures: budgets/concurrency/replay/lease/timeout/failure/corrupt policy/forged citations and deferred context changes. Mock external providers only, never the entire store/runtime. Publish generateSupportAgentCopilot/readSupportAgentCopilotJob to Agent3. Run owned tests and type checks after peer readiness; report exact results and unresolved API issues. No automatic human reply is part of your module.
