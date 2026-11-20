// Standalone vitest config so tests don't load vite.config.ts (whose React +
// Tailwind plugins are pointless for unit tests). Most tests are plain
// TypeScript and run in the default node environment — no jsdom.
//
// The exception is the chart-axis render test, which mounts a real recharts
// chart to prove the axis props actually reach recharts. That single file
// opts into jsdom with an `@vitest-environment jsdom` docblock, so we only pay
// for a DOM where one is genuinely needed.
//
// Two things about that jsdom dependency are deliberate and easy to undo by
// accident:
//
//   * It is declared in the *root* package.json, not this one. vitest itself
//     hoists to the root node_modules, and vitest resolves an environment
//     package relative to its own location — it never looks inside
//     client/node_modules. A client-level jsdom that npm chooses to nest
//     (which it does, depending on how the rest of the tree deduplicates)
//     makes the run die with "Cannot find package 'jsdom'".
//   * It is pinned to ^27. jsdom 28+ depends on undici, and undici 8 both
//     declares `engines: >=22.19.0` and calls worker_threads.markAsUncloneable
//     unguarded — a function Node 20 does not have. Since the repo supports
//     Node >=20.18 and CI runs the suite on Node 20, that combination fails
//     at import time with "webidl.util.markAsUncloneable is not a function".
//     jsdom 27 has no undici dependency at all.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Same `@` → src alias as vite.config.ts, so a test can mount a component
  // that imports its own dependencies the way the app does.
  resolve: {
    alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src') },
  },
  // esbuild only reads the *nearest* tsconfig.json, and ours is a solution
  // file (`files: []` + project references), so `jsx: react-jsx` from
  // tsconfig.app.json never reaches it. Say it here instead.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Same 10s bound as the server suite; no `retry` — retrying would hide
    // real flakes instead of fixing them.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      enabled: process.env.COVERAGE === '1',
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}'],
      reporter: ['text', 'text-summary', 'json'],
      // Same as the server suite: a failing run must still produce the
      // report, or the CI coverage artifact goes missing exactly when the
      // numbers would explain the failure.
      reportOnFailure: true,
      // Baseline measured 2026-11-19 on the full client suite (72 files,
      // 526 tests, all passing): statements 21.31%, branches 17.05%,
      // functions 13.6%, lines 22.7%. Thresholds sit 1pt below the floored
      // baseline — they exist to catch regressions, not to force coverage
      // up in this PR.
      //
      // Thresholds are evaluated ONLY on a full-suite run (same rule as the
      // server suite: a `--shard` slice cannot meet a global threshold, and
      // PR #169 showed that combination failing a green suite). The client
      // suite is never sharded in CI today, but the guard is cheap insurance
      // against a future sharded run collecting coverage.
      ...(isShardedRun()
        ? {}
        : { thresholds: { statements: 20, branches: 16, functions: 12, lines: 21 } }),
    },
    // jsdom 27 delegates Storage to Node's experimental webstorage, which is
    // undefined without --experimental-webstorage; the setup file installs a
    // memory Storage only where the native one is missing. See the file.
    setupFiles: ['./vitest.setup-storage.ts'],
  },
})

// True when this invocation runs a `--shard=N/M` slice (space or `=`
// form). Only a sharded CI job passes it; the coverage job and local
// `test:coverage` runs never do.
function isShardedRun(): boolean {
  return process.argv.some((a) => a === '--shard' || a.startsWith('--shard='))
}
