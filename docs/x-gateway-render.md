# Deploy and verify X Gateway on Render

Use the repository's root Dockerfile in a Render Web Service. No desktop, browser
automation or local client installation is required on the server. This guide
does not change any existing Render service or credentials.

## Environment and storage

| Setting | Value / requirement |
| --- | --- |
| Runtime | Docker; root Dockerfile |
| `NODE_ENV` | `production` (already in Dockerfile) |
| `HOST` | `0.0.0.0` |
| `PORT` | Use Render's injected port; do not hard-code the external HTTPS port |
| Health Check Path | `/livez` |
| `PUBLIC_APP_URL` | Your canonical HTTPS origin, e.g. `https://your-service.onrender.com` |
| `ENCRYPTION_KEY` | Stable existing 64-character hex key; never regenerate during redeploy |
| `TRUST_PROXY` | Configure for your actual proxy topology; normally `1` with Render's direct edge; never blindly trust all proxies |
| Instance count | One for SQLite or the current experimental synchronous Turso backend |

Render requires `0.0.0.0` and forwards HTTPS to the service's internal `PORT`.
Its filesystem is ephemeral unless a persistent disk is attached. Disks require
a paid service; an ordinary local path does not establish persistence.
Sources: [Web Services](https://render.com/docs/web-services),
[Persistent Disks](https://render.com/docs/disks),
[Health Checks](https://render.com/docs/health-checks).

Choose one supported storage mode:

**SQLite with persistent disk:** attach a disk at `/app/server/data`; set
`FREEAPI_DB_DRIVER=sqlite` and `FREEAPI_DB_PATH=/app/server/data/freellmapi.db`.
The entrypoint prepares ownership and drops privileges to the node user. Keep
the DB, WAL and SHM on this disk. Preserve the matching `ENCRYPTION_KEY` as a
Render secret; back it up securely alongside database backups.

**External Turso/libSQL:** set `FREEAPI_DB_DRIVER=turso`, `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN` (database scoped) and the stable `ENCRYPTION_KEY`. No local
SQLite disk is needed for the primary database in this mode. This backend is
experimental and synchronous; measure responsiveness in your Render region and
follow [the Turso guide](en/deployment/03-turso.md). An ephemeral local backup is
not a durable backup. This change does not migrate existing SQLite data for you.

Do not switch storage modes or keys casually: preserve the current database and
matching key before cutover. Provider accounts, client key hashes, configuration
and any durable token lifecycle state must stay in the configured database.

## Deploy checklist

1. Build and test the combined integration branch, including other agents' changes.
   Keep environment secrets out of Git and container image layers.
2. Configure storage and environment above in Render; deploy the tested revision.
3. Verify `/livez` and `/api/ping` return HTTP 200. `/readyz` describes the main
   provider pool and can return 503 on a fresh install; it does not prove X Gateway
   inference readiness. Do not use it as the initial deployment health check.
4. Complete first-user setup through the normal dashboard, enable X Gateway,
   connect a provider, create an inference key and select a real model.
5. Run CLI Tools Test Connection, then a public ingress smoke test below.
6. Restart/redeploy and verify the same accounts/settings remain and the same
   client key still works. Diagnostics evidence correctly resets to unverified.

For provider browser login, the console callback is
`https://your-service.onrender.com/thruline/accounts/callback`; it must match the console
origin. `PUBLIC_APP_URL` also configures application auth callbacks; Google login
uses `/api/auth/google/callback`. Configure the correct callback for each flow.
Device-code login does not require a localhost callback on the user's computer.
Reverse proxies must forward HTTPS origin correctly and avoid buffering SSE;
verify streaming through the public URL, separately from non-streaming tests.

## Public smoke checks

On your own machine, export `GATEWAY_URL` (origin only), `X_GATEWAY_API_KEY`, and
`X_GATEWAY_MODEL`. Optional `X_GATEWAY_TOOL` is cursor, claude, codex or gemini.
Do not paste real keys into repository files or shared logs.

```sh
npm run test
npm run build
npm run lint
node scripts/x-gateway-smoke.mjs
```

Expected: health checks 200, selected protocol inference 200 with a completed
text response; the script never prints keys or response content. Exit code is
nonzero on failure. A successful HTTP fixture test is not a live provider test.

For a local container check, with an existing private env file and Docker:

```sh
docker build -t freellmapi-x-gateway .
docker run --rm --name x-gateway-smoke -p 10000:10000 \
  --env-file .env.local -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=10000 \
  -e FREEAPI_DB_DRIVER=sqlite -e FREEAPI_DB_PATH=/app/server/data/freellmapi.db \
  -v freellmapi-x-data:/app/server/data freellmapi-x-gateway
```

Then use `GATEWAY_URL=http://127.0.0.1:10000` and run the same smoke script.
Do not run a second container against the production SQLite disk.

## Capability matrix

| Capability | Render requirement | Evidence needed |
| --- | --- | --- |
| CLI connection test | Running HTTP app + selected full client key/model | Actual completed inference, protocol-specific |
| Provider routing/combos | Working provider credentials, correct executor | Test exact model/combo |
| OAuth | Public callback/device flow and persisted lifecycle state | Login + expiry/refresh + restart check for that provider |
| Output savers | Enabled configuration | Actual applied prompt/metadata |
| RTK/Headroom/PXPIPE | Implemented request preprocessing and any required service/library | Execution-specific tests; UI switch alone is insufficient |
| Media | Provider-specific capability and credentials | Image/audio/embedding/video test, not text inference |
| Local client setup | Node.js on user's computer | Run generated launcher and client; Cursor manual Verify |
| Persistence | Mounted SQLite disk or configured external DB, stable encryption key | Restart/redeploy check |
| SSO/cloud sync | Not supplied by this operations change | Remains backlog; no placeholder success |

## Client configuration references

- [Codex custom provider configuration](https://developers.openai.com/codex/config-reference)
- [Gemini CLI base URL and authentication](https://geminicli.com/docs/reference/configuration/)
- [OpenCode provider schemas](https://opencode.ai/docs/providers)
- Cursor uses its Models/API Keys settings; the setup download preserves prior
  files and asks the user to record existing UI values before manual changes.

OpenCode v1/v2 schemas differ. Setup detects an existing v1 `provider` map,
otherwise generates v2 `providers`; explicitly select the version when needed.
Only a client-side launch verifies the installed client's compatibility.
