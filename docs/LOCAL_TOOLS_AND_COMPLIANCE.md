# Local-only tools and repository compliance

This document explains which files are intentionally **kept out of Git** and why,
so the repository stays compliant with the GitHub Terms of Service and
Acceptable Use Policies. See also
[`GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md`](GITHUB_COMPLIANCE_AND_SAFETY_GUIDE.md).

## What changed

| Item | Before | Now |
| :--- | :--- | :--- |
| `start-tunnel.bat` (helper that exposes the local port through a third-party tunnel) | Tracked | Removed from Git, listed in `.gitignore`; keep your own copy locally |
| Executable binaries (`.apk .so .exe .dll .ipa .idsig`) | Not excluded | Excluded in `.gitignore`; publish via GitHub Releases only |
| GitHub Actions jobs | No `timeout-minutes` | Every job has an explicit timeout |
| Test fixtures in `proxy-webhook.test.ts` | Used real third-party tunnel hostnames | Neutral `*.example.test` hostnames (the webhook `type` is a free-form label) |

## Deployment is unaffected

Nothing in the server, client, Docker image, `docker-compose.yml`, CLI or desktop
build references the removed files. A fresh clone builds and deploys exactly as
before (Docker, Render, local `npm run build && npm start`). The local tunnel
helper was only ever a convenience for a developer's own machine.

## If you need a public URL for local development

Do this **on your own machine only**:

1. Create the helper script yourself (for example `start-tunnel.bat` or
   `scripts/local/start-tunnel.sh`). Both paths are git-ignored.
2. Point it at `localhost:3001` using whichever tunneling client you are
   licensed to use.
3. Use the URL it prints as the base URL (append `/v1`) in your OpenAI-compatible
   client.

Rules that always apply:

- Never download or run tunneling clients, reverse shells or proxies inside a
  GitHub Actions workflow.
- Never commit executables or APK/native-library files. Attach them to a GitHub
  Release instead.
- Keep `README.md` and repository descriptions in neutral technical language.
- Keep `timeout-minutes` on every workflow job (long jobs such as the desktop
  release build use a higher, explicit value because macOS notarization can wait
  up to 30 minutes).
- Do not push bursts of commits or repositories while an account is under review.

## For production

On a server, expose the app with a normal reverse proxy or the platform's own
HTTPS (Render, Docker + Caddy/nginx). No tunnel is required.
