# FreeLLMAPI — custom fork

FreeLLMAPI is a self-hosted, OpenAI-compatible LLM gateway and proxy that routes chat, embeddings and tool calls across many providers through one unified API key, with a dashboard, named fallback chains and a response cache.

This repository is a custom fork of upstream [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). It keeps the upstream single-user behaviour and adds multi-user auth: admin/member roles with granular permission grants, invite-code and operator-approved registration, and per-user `sk-flm-…` keys with their own request quota.

## Features

- **One OpenAI-compatible API** — point any OpenAI SDK or coding agent at `/v1/chat/completions`, `/v1/models`, `/v1/embeddings` and the Anthropic Messages surface.
- **Many providers, one key** — around 65 providers behind a single unified key; add provider keys on the dashboard **Keys** page.
- **Fallback chains** — named chains (`auto:<name>`) walk providers in order when one fails or runs out of quota; plain `auto` uses the active chain.
- **Dashboard** — keys, fallback-chain editing, usage, cache and per-user management at `http://localhost:3001`.
- **Response cache, compression and context budget** — on by default, so repeated prompts and large histories stay cheap and inside model limits.
- **Multi-user auth (fork)** — roles, invites and per-user keys with an RPM cap and a monthly request count; still no billing or per-user cost attribution.

## Quick start

### Docker Compose

```bash
git clone https://github.com/td685548-sketch/freellmapi-custom.git
cd freellmapi-custom
ENCRYPTION_KEY="$(openssl rand -hex 32)"
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" "$ENCRYPTION_KEY" > .env
docker compose up -d
```

### One-liner

```bash
curl -fsSL https://freellmapi.co/install.sh | bash
```

Open <http://localhost:3001>, add your provider keys, and grab the unified API key from the **Keys** page header.

### Local development

```bash
npm install
npm run dev        # server + dashboard; `npm start` runs the built server
```

Requires Node.js 20+ and an `ENCRYPTION_KEY` in `.env` (a development key is auto-generated when it is unset outside production — see the install guide).

## Try it

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer $FREEAPI_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "messages": [{"role": "user", "content": "Write a binary search in Rust."}]}'
```

## Documentation

- [Install & deploy](docs/en/install/01-install.md) — one-liner, Docker Compose, local development, desktop app, FAQ.
- [Deployment overview](docs/en/deployment/OVERVIEW.md) — Docker image, Compose quickstart, healthchecks, upgrades and backups.
- [API reference](docs/en/api/01-rest-api.md) — chat completions, `auto:*` routing, streaming, tool calling, vision and embeddings.
- [Documentation index](docs/en/README.md) — the full guide list.

## Contributing

Contributions are welcome — bug fixes, provider support, docs and tests. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the agent rules in [AGENTS.md](AGENTS.md) first: one branch per fix, tests before opening a PR, never commit straight to `main`.

## License

MIT — see [LICENSE](LICENSE).
