import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // A single slow test (cold SQLite, a big fixture) must not hang the whole
    // shard: 10s per test / hook bounds the damage instead of vitest's 5s
    // default failing genuinely slow-but-healthy tests on loaded runners.
    // No `retry` here on purpose — retrying would hide real flakes.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // The Cloudflare neuron meter asks Cloudflare's analytics API for the
    // account's own count in the background; that call would land in every
    // test's fetch mock. Its own tests switch it back on.
    // Local .env may enable Azure; offline tests opt in only with SDK mocks.
    // The exact-match response cache is on by default in production, but
    // tests reuse identical prompts across cases and expect every request to
    // reach the mocked provider; a cache hit from an earlier case would serve
    // a stale answer (or a 200 where the test staged a 429/502). Keep it off
    // here — the dedicated cache tests opt back in per describe.
    env: {
      CLOUDFLARE_NEURON_ANALYTICS: '0',
      SUPPORT_DOCUMENT_STORAGE: 'disabled',
      CLOUD_ENTITLEMENT_BACKGROUND_POLL: '0',
      RESPONSE_CACHE: '0',
    },
    setupFiles: ['./src/__tests__/setup-cloud-entitlement.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      enabled: process.env.COVERAGE === '1',
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/db/migrate/**', 'src/scripts/**', 'src/index.ts'],
      reporter: ['text', 'text-summary', 'json'],
      // A failing test run must still produce the report (and the artifact
      // upload in CI): without this, vitest silently drops coverage on any
      // failure and the coverage job goes blind exactly when it matters.
      reportOnFailure: true,
      // Baseline measured 2026-11-19 on the full suite minus the 8
      // known-failing files the CI coverage job excludes (see ci.yml):
      // statements 42.21%, branches 33.71%, functions 49.06%, lines
      // 43.17%. Thresholds sit 1pt below the floored baseline — they exist
      // to catch regressions, not to force coverage up in this PR.
      thresholds: { statements: 41, branches: 32, functions: 48, lines: 42 },
    },
  },
});
