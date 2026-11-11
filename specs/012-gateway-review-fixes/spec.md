# X Gateway review fixes

## User Scenarios & Testing
1. A restricted client key must reject disallowed models on every inference protocol before upstream execution.
2. Coding clients must receive complete streaming tool IDs, names, arguments, stop reasons and terminal responses.
3. Savers must preserve canonical system instructions, tool pairs, image data and Unicode. Savings must reflect the forwarded payload.
4. Subscription accounts must use native provider protocols, browser credential imports and encrypted, rotating refresh credentials on Render.

## Requirements
- Preserve existing /v1, health and single-user behavior.
- Test real HTTP gateway/upstream fixtures, parallel refresh, rotation/reopen, abort, quota and fallback.
- Keep provider failures redacted and connection status unknown until a real probe succeeds.
- No server home-directory credential discovery, no desktop dependency, no Render resource changes.

## Success Criteria
All reproduced review failures have regression tests; focused tests, full tests, build and lint pass. Provider live verification remains explicitly unknown without credentials.
