# Contract and verification

All POST inference routes authenticated by xGatewayAuth enforce the selected
client key's model allowlist before preprocessing or upstream calls. Gemini's
separate entry point preserves its existing allowlist guard.

Messages streaming translates Chat tool fragments into tool_use blocks and
input_json_delta events. Terminal stop reasons distinguish tools and token limits.
Responses streaming emits function_call items, argument delta/done events and a
terminal response containing the same item IDs and array indices. An upstream
disconnect after output is never retried as a new successful stream.

Subscription session APIs are mounted below /api/x-accounts/subscriptions:
capabilities, import, start, complete, poll and cancel. See
[operator contracts and configuration](../../docs/x-gateway-subscriptions.md).
Adding requires add_keys; reconnecting requires edit_keys. Both require a valid
session and use_x_gateway, checked again after asynchronous external work.

Verify with provider-execution.test.ts, gateway-review-regressions.test.ts,
x-quota.test.ts, x-gateway-access.test.ts and the client accounts tests. Fixtures
exercise real local HTTP requests and real encrypted SQLite storage without
touching personal CLI configuration or requiring external provider credentials.

Full-suite validation also runs server, CLI and client workspaces, build, lint
and i18n. Record Windows worker/IPC failures separately from Linux results.
Docker execution and live provider checks require an appropriate environment;
do not infer either from fixture success.
