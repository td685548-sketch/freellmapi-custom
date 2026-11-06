# Quickstart: validating the X gateway

Prerequisites: a local server with an administrator account and at least one working provider key (or the in-test provider stubs used by the suites).

## 1. Automated checks

```bash
npm run lint -w server
npm run build -w server
npm run test -w server
npm run test -w client
```

Expected: everything passes; the new server suites cover access control, combos, savers, the console API, usage, the migration round trip and the round-trip budget; the new client suite covers the console shell, permission gating and forms.

## 2. Switch it on and call it (scenario for User Story 1)

1. Sign in as the administrator, open `/x`, enable the gateway.
2. Create a personal key on the existing Keys/Users page if you do not have one.
3. Call it:

```bash
curl -s http://localhost:3001/x/v1/chat/completions \
  -H "Authorization: Bearer $ADMIN_PERSONAL_KEY" -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi"}]}'
```

Expected: a normal completion with the `X-Gateway: x` response header. The same call with a member's key returns 403, with a wrong key 401, with the gateway off 404, and `/v1/chat/completions` behaves as before.

## 3. Combo (User Story 3)

Create combo `fast` with two models in the console; call with `"model":"combo:fast"`. Disable the first model and repeat: the second serves it and `X-Combo: fast` is present. Call with `combo:nope`: 400 `combo_not_found`.

## 4. Savers (User Story 4)

```bash
curl -s ... -H "X-Output-Saver: caveman,ponytail:lite" -d '...'   # savers applied header lists both
curl -s ... -H "X-Input-Saver: standard" -d '<conversation with large tool output>'   # X-Input-Tokens-Saved > 0
curl -s ... -H "X-Token-Saver: off" -H "X-Output-Saver: caveman" -d '...'   # nothing applied
curl -s ... -H "X-Output-Saver: pirate" -d '...'   # 400 listing valid values
```

## 5. Usage (User Story 5)

Open `/x/usage`: requests, tokens and tokens saved match the calls above.

## 6. Isolation and safety checks

- Switch the gateway off: `/x/v1/*` answers 404 within a minute, the console shows the disabled state, `/v1` unaffected.
- Remove `use_x_gateway` from the account: the next call returns 403; the console disappears from the navigation.
- Send a 10 MB body without a key to `/x/v1/chat/completions`: refused before parsing (401).
- Run the round-trip budget test: a gateway request issues no more statements than the same request on `/v1`.
