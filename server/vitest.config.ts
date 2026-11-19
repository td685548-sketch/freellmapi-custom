import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
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
      reporter: ['text', 'text-summary'],
    },
  },
});
