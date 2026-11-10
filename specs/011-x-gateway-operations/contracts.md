# Operations API

Existing console gate: bearer session + use_x_gateway.

POST /api/x-gateway/tools/test
Body: { toolId, key: full client credential, model, keyId?: selected stored key ID }.
No custom destination is accepted. Invalid input is 400; console auth errors use
401/403; concurrent probes use 429. Completed probe returns 200 with `ok`, protocol,
model, endpoint, inference HTTP `status`, checkedAt, latencyMs and fixed error or
success message. An inference HTTP failure is `ok:false`, never a readiness success.
No key, provider payload or response content is returned.

GET /api/x-gateway/tools/diagnostics
No paid/network probe. Returns capability state/configuration and recent session
evidence. Evidence expires in 300 seconds and resets on server restart. No secrets.

Public routes remain unchanged; probe requests traverse their actual authentication,
model restrictions, provider execution and rate-limit middleware.
