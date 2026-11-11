# Decisions and evidence

- Use the existing shared integration branch. The latest origin/main was a
  merge-only commit with an identical tree and was fast-forwarded without
  discarding workspace changes.
- Protocol references are the local `9router/open-sse/executors/codex.js`,
  `gemini-cli.js`, `kiro.js`, AWS EventStream utilities, Claude registry and
  OpenAI-to-Claude translator, and provider usage adapters.
- Codex CLI 0.159.0, Gemini CLI 0.34.0 and Claude CLI 2.1.280 wire identities
  come from that checkout, not from assumed versions. Live acceptance is unknown.
- Keep native inference behind the existing account factory, wrapping credentials
  at execution time. Preserve legacy API-key custom endpoints while pinning
  structured Claude OAuth credentials to the official Anthropic origin.
- Preserve existing encrypted storage; use an atomic ciphertext comparison when
  saving rotation so an older refresh cannot overwrite a reconnect.
- Refresh locks and pending authorization attempts are process-local. Deploy one
  instance with a durable database and stable ENCRYPTION_KEY.
- Run savers only on canonical ChatMessage objects. Retain Unicode text because
  the existing PNG renderer has an ASCII-only font. Encode native images in the
  selected executor, not in the shared preprocessing pipeline.
- No new dependencies, migrations, CI utilities or Render resource changes.
