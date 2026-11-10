# Validation

Operations were recovered from the tested Ubuntu workspace after concurrent work
removed the uncommitted files. Active UI/API use isolated operations modules with
minimal XGatewayApp.tsx and console-router.ts hooks. Existing provider/protocol
work and pending changes from other agents are not included in this commit.

Previously verified: 23 backend/setup tests on Ubuntu, actual compiled Linux app
boot and HTTP 200 health checks, UI credential/model submission and session clearing,
and full monorepo build. Docker and live Render/provider credentials were not used.
Full suite hit the existing 5000ms bandit exploration timeout, including isolated
recheck; lint previously reported require-yield in the in-progress Kiro executor.

The PR must remain a draft until combined-branch tests/lint are green and the root
Docker image plus live Render ingress/persistence are verified. See
docs/x-gateway-render.md for deployment steps. Current restoration checks are
recorded in the PR description.
