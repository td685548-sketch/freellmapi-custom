// Desktop tests previously ran on vitest's defaults (no config file): a
// 5s test timeout and no explicit include. Pin the same 10s test/hook
// timeout the server and client suites use, so a slow machine (or a cold
// first run after `npm ci`) fails loudly instead of hanging the CI job.
// No `retry` here on purpose — retrying would hide real flakes.
// Electron itself is never launched: tests that touch it mock the module.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
