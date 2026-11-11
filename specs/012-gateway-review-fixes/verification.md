# Verification record

Validated on Ubuntu/WSL, Node 20.20.2 with Linux-installed dependencies:

- Full server suite: 487 files passed, 5,721 tests passed, 9 platform/optional tests
  skipped. Command: `npm exec -w server -- vitest run --pool=forks --fileParallelism=true --maxWorkers=4`.
- CLI suite: 7 files passed, 178 tests passed, 1 skipped.
- Client suite after updating the obsolete access-token-only import expectation:
  98 files passed, 671 tests passed.
- Final provider/protocol/quota/access regression run: 4 files, 85 tests passed,
  including the additional legacy Claude custom-endpoint regression.
- Root build and lint passed; i18n passed for 60 locales / 1,311 keys.
- Actual compiled server process honored supplied PORT, bound 0.0.0.0, and
  returned HTTP 200 for /livez, /api/ping and /readyz using a temporary database.

The first Windows `npm run test` was interrupted by
ERR_IPC_CHANNEL_CLOSED in the Vitest worker pool. It also exposed the GLM
factory regression, which was fixed and rerun. The first serial Linux run used
an obsolete Kiro/OpenAI-JSON fixture; that fixture was corrected to native AWS
EventStream and verified again in the complete server rerun above. Neither
failed initial invocation is being reported as a passing root command.

Docker is unavailable on this machine, so docker build/run was not verified.
No live provider credentials were supplied: Codex, Claude OAuth, Gemini CLI and
Kiro live access remains unverified. No Render resources were modified or
manually deployed. Operator commands and persistence/callback requirements are
in docs/x-gateway-subscriptions.md and docs/x-gateway-render.md.
