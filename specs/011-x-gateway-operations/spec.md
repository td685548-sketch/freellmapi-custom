# Feature Specification: X Gateway hosted operations

**Feature Branch**: `feat/9router-integration`
**Created**: 2026-11-10
**Status**: Accepted
**Input**: Complete CLI setup, real connection probes, diagnostics and Render deployment guidance.

## User Scenarios & Testing

### User Story 1 - Verify a connection (Priority: P1)
An operator selects a tool, full client key and model and verifies inference through its actual protocol.
**Independent Test**: HTTP fixture receives the selected model and answers a real inference request.
**Acceptance Scenarios**:
1. Given a working account and allowed key, a test succeeds only after a valid inference response.
2. Given a disabled gateway, revoked/restricted key or failing upstream, the test reports failure without disclosing secrets.

### User Story 2 - Configure a local client (Priority: P2)
An operator downloads setup for Claude, Codex, Gemini, OpenCode or Cursor without editing files on the hosted server.
**Independent Test**: Apply setup to a temporary home, preserve unrelated settings, restore the exact backup.
**Acceptance Scenarios**:
1. Existing settings survive setup, with an explicit backup and restore command.
2. Cursor receives manual setup instructions rather than unsupported automatic settings edits.

### User Story 3 - Understand deployment readiness (Priority: P2)
Operators distinguish configured capabilities from recently verified inference.
**Independent Test**: Diagnostics reports no ready provider before an actual probe and expires probe evidence.
**Acceptance Scenarios**:
1. Diagnostics contains no credentials or infrastructure secret values.
2. Render guidance covers port, bind, health, callbacks, proxy and durable storage.

## Requirements
- FR-001: Test the selected credential and model through the tool's actual HTTP inference surface.
- FR-002: Use bounded requests, timeouts, client cancellation and sanitized errors.
- FR-003: Never send selected credentials to an arbitrary user-provided host.
- FR-004: Provide local setup/backup/restore for supported clients and truthful manual Cursor setup.
- FR-005: Diagnostics distinguishes configured, ready, unavailable and unverified with dated evidence.
- FR-006: Preserve existing endpoints, permissions and deployments.

## Success Criteria
- SC-001: Invalid credentials and upstream failures never produce a successful probe.
- SC-002: All five client workflows are downloadable and preserve existing local files.
- SC-003: Operator documentation provides executable deploy and smoke-test steps.

## Assumptions & Dependencies
- Live verification needs operator-provided credentials; fixture verification is explicitly identified.
- Other agents own saver/provider/protocol implementation. Diagnostics does not claim their features work without evidence.
- No new runtime dependencies, schema migrations or live Render resource changes are required.
