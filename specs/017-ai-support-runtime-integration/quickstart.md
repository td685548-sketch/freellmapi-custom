# Implementation Handoff & Validation

This is a validation guide, not an implementation. Spec016 remains separate. Use the same integration branch for all four agents and preserve other agents' pending work.

## Dispatch

Send the complete content of one prompt to each separate agent:

1. [Agent1 — Runtime/context/quotas](prompts/agent-1.md)
2. [Agent2 — Approval/outbox/safe HTTP](prompts/agent-2.md)
3. [Agent3 — HTTP integration/lifecycle](prompts/agent-3.md)
4. [Agent4 — Widget/integration UI](prompts/agent-4.md)

Agents read the common contracts and ownership before coding. No one except the reviewer stages, commits, pushes or creates a PR. The original implementation is delegated to the four agents. After round 1 review, the user explicitly authorized the reviewer to fix identified defects. When all four finish, send their completion reports and ask the reviewer to review spec017.

## Targeted Verification

From server, after all peer exports exist:

```text
npx vitest run src/__tests__/custom/x-support-runtime.test.ts src/__tests__/custom/x-support-action-executor.test.ts src/__tests__/custom/x-support-event-outbox.test.ts src/__tests__/custom/x-support-safe-http.test.ts src/__tests__/custom/x-support-runtime-gateway.test.ts src/__tests__/custom/x-support-runtime-widget.test.ts src/__tests__/custom/x-support-runtime-http.test.ts
npx vitest run src/__tests__/db/migrate/support-runtime.test.ts src/__tests__/db/migrate/support-execution-outbox.test.ts src/__tests__/db/migrate/support-runtime-fencing.test.ts
```

From client:

```text
npx vitest run src/custom/x-gateway/support-integration.test.tsx
npx tsc -b
```

From repository root:

```text
npm run test
npm run lint
npm run build
npm run test:migrations
git diff --check
```

Also lint the new client files with the installed client ESLint command: root lint currently covers server/cli only. No new package is needed or authorized. An environment failure is recorded with its cause; it is not a passing check and tests must not be silently skipped to make a PR green.

## End-to-End Demonstration (local test environment)

- Create two tenants with distinct documents, policies and test customer identities. Configure an eligible provider fixture and public HTTPS test webhook through mocked transport.
- Obtain a signed user session, call /chat directly without /guardrails/check, verify role RAG/CRM and masked tool/result/history. Prompt with forbidden topic and exhaust quota: verify zero extra provider/tool calls.
- Replay a request ID, reload widget, try another user/tenant conversation ID and send conflicting token headers. Verify cached replay or appropriate rejection, not duplicate append/execution.
- Ask for a POST write tool. Verify pending action and no HTTP. Approve concurrently and verify one execution; reject another action and verify none. Simulate timeout after dispatch and verify unknown state without automatic re-execution.
- Escalate, reply as staff and submit CSAT. Verify outbox events and delivery status; simulate receiver outage/restart and successful bounded retry with stable signed event bytes.
- In /thruline/support-integration verify EN/VI, runtime policy validation, readiness without network calls, outbox manual retry and safe embed. Test widgets served by a different origin than the host website.

No real refund/cancellation/webhook against an unrelated external service is required for acceptance. Use owned fixtures and deterministic network boundaries.

## Windows worker recovery used during review

On local Node24/Windows the monolithic fork pool ended with ERR_IPC_CHANNEL_CLOSED after 318 passing server files. Do not call that a passing root command. Review completed all 206 remaining files in six fresh-process batches (35/35/35/35/35/31 files), using `node ../node_modules/vitest/vitest.mjs run --pool=forks --fileParallelism=false <explicit file paths>` from server. A comparison against all 524 test file paths confirmed full coverage. Client/CLI tests and bootstrap/hooks were also verified. For a repeatable bounded full run, Vitest's `--shard=1/6` through `--shard=6/6` can distribute the full suite across separate processes; this shard alternative is suggested, not claimed as the command executed here. Keep canonical Linux/Node22 CI required before merge.
