> Historical handoff, completed. Do not redispatch this prompt. The user replaced shared-branch instructions on2026-11-13; new features, fixes and parallel agent assignments use separate branches under AGENTS.md. Current019 review/publishing branch: `codex/support-service-desk`.

You are Agent-4 for spec019 Support Service Desk & Widget Studio in C:\Users\dotha\Documents\Fsoft-Working\freellmapi (WSL equivalent /mnt/c/Users/dotha/Documents/Fsoft-Working/freellmapi), existing branch feat/9router-integration.

Read AGENTS.md and ALL of specs/019-ai-support-service-desk/{spec.md,plan.md,research.md,data-model.md,contracts.md,ownership.md,tasks.md,quickstart.md,review.md} before editing. Use CodeGraph first when .codegraph exists.019 supersedes unimplemented016 for this work; do not implement016 in parallel. PR25/018 is merged. Canonical URLs are /thruline, /api/thruline and /thruline/v1; internal permission/file names remain unchanged.

STRICT OWNERSHIP — no writes outside the paths below, including peer files, specs/prompts, old migrations, packages/lockfiles/CI/theme. No branch/worktree/switch/reset/stash/merge/rebase, staging, commits, push, PR, live provider charges or real customer writes. Preserve pending Kiro.ts and016 docs. If an unlisted edit is needed, report exact path/reason to reviewer; do not add an alias/fake store or suppress tests/types. The user dispatches four agents; reviewer reviews actual integration after handoff and alone handles conditional PR, never auto-merge.

CREATE:
- client/src/custom/x-gateway/support-service-desk-strings.ts
- client/src/custom/x-gateway/pages/SupportServiceDesk.tsx
- client/src/custom/x-gateway/components/SupportWidgetPreview.tsx
- client/src/custom/x-gateway/support-service-desk.test.tsx

EDIT ONLY:
- client/src/custom/x-gateway/XGatewayApp.tsx
- client/src/custom/x-gateway/shell/nav.ts
- server/src/custom/x-gateway/support-runtime-widget.ts
- server/src/__tests__/custom/x-support-runtime-widget.test.ts

Your tasks: T011,T012,T025,T026,T027,T028.

Implement EN/VI /thruline/support-desk with four tabs widget,copilot,queues,embed; selector support-desk-tenant and tab-ID/panel-ID test IDs. Query only for editors, isolate tenant/session keys and abort/epoch/unmount mutations as well as reads. Use exact backend envelopes/OCC errors; do not invent API aliases. Four tab flows include current config, real conversations/tickets, operator drafts/citations, department/SLA editor and safe snippet.

Copilot is manual assistance: copy into editable composer only, then explicit human send via existing reply endpoint. No auto-send or live customer/provider operations while testing. Hide stale/revoked drafts, distinguish no-evidence/provider/network/auth errors and actual usage; no fabricated confidence/sentiment or customer quota display for operator budget.

Extend the ACTUALLY SERVED support-runtime-widget.ts. Preserve017/018 canonical-prefix/session/renewal/retry/dedup/revocation/escalation/CSAT/destroy behavior. Default init has no added config fetch; new snippet opts loadTenantProfile:true. Load safe profile, sign guest before intake, validate/render fields, store receipt reference only and continue explicitly; server enforces intake even if browser flags omit it. Public bodies never set identity/role/internal metadata. Handle428/schema/expiry failures without automatic AI resubmission; all late callbacks fence identity.

Expose preview(container,publicConfig) from the same served appearance renderer with transport disabled, separate IDs and no effect on global live instance/session. SupportWidgetPreview loads canonical script safely and cleans up its own renderer only. No second widget, iframe/HTML/CSS/avatar injection, global fetch monkeypatch, new dependency or global theme refactor.

Native createRoot from react-dom/client and act from react only; NEVER @testing-library/react. >=12 UI tests and >=8 executed-widget regressions, preserving existing cases. Verify EN/VI labels/validation, conflicts/tenant races, manual send, zero-transport preview, prefix/form/credential lifecycle and018 redaction. Run tests, client tsc -b and scoped lint; Vitest alone is not CI acceptance. Coordinate Agent3 handoff, report exact files/task IDs/counts and missing contracts, never edit routers/shared/store.
