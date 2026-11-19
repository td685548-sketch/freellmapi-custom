import type { CompressionMode, CompressionRequestStats } from './types.js';

interface EngineAggregate {
  applied: number;
  discarded: number;
  savedChars: number;
}

interface ModeAggregate {
  requests: number;
  savedChars: number;
  savedTokens: number;
}

let requests = 0;
let compressedRequests = 0;
let originalChars = 0;
let compressedChars = 0;
let savedTokens = 0;
let totalDurationMs = 0;
const engines = new Map<string, EngineAggregate>();
const modes = new Map<CompressionMode, ModeAggregate>();

export function recordCompressionStats(mode: CompressionMode, stats: CompressionRequestStats): void {
  requests += 1;
  if (stats.compressedChars < stats.originalChars) compressedRequests += 1;
  originalChars += stats.originalChars;
  compressedChars += stats.compressedChars;
  // Sum the per-request script-weighted saved-tokens figure; deriving it
  // from aggregate savedChars (/ 4) would undercount Vietnamese/CJK savings.
  savedTokens += stats.estSavedTokens;
  totalDurationMs += stats.durationMs;
  const modeRow = modes.get(mode) ?? { requests: 0, savedChars: 0, savedTokens: 0 };
  modeRow.requests += 1;
  modeRow.savedChars += stats.originalChars - stats.compressedChars;
  modeRow.savedTokens += stats.estSavedTokens;
  modes.set(mode, modeRow);
  for (const stage of stats.stages) {
    const row = engines.get(stage.engine) ?? { applied: 0, discarded: 0, savedChars: 0 };
    if (stage.applied) row.applied += 1;
    else if (stage.discarded && stage.discarded !== 'disabled' && stage.discarded !== 'unchanged') row.discarded += 1;
    row.savedChars += stage.savedChars;
    engines.set(stage.engine, row);
  }
}

export function getCompressionStats() {
  const savedChars = Math.max(0, originalChars - compressedChars);
  return {
    requests,
    compressedRequests,
    originalChars,
    compressedChars,
    estSavedTokens: savedTokens,
    savingsPercent: originalChars > 0 ? Math.round((savedChars / originalChars) * 10_000) / 100 : 0,
    avgDurationMs: requests > 0 ? Math.round((totalDurationMs / requests) * 100) / 100 : 0,
    byMode: Object.fromEntries([...modes.entries()].map(([mode, row]) => [
      mode,
      { requests: row.requests, savedChars: row.savedChars, estSavedTokens: row.savedTokens },
    ])),
    engines: Object.fromEntries([...engines.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function clearCompressionStats(): void {
  requests = 0;
  compressedRequests = 0;
  originalChars = 0;
  compressedChars = 0;
  savedTokens = 0;
  totalDurationMs = 0;
  engines.clear();
  modes.clear();
}
