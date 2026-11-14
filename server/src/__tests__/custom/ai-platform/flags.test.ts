import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import {
  getFlags,
  isPillarEnabled,
  resetFlagsCacheForTests,
  setFlags,
} from '../../../custom/ai-platform/flags.js';

describe('ai-platform/flags', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetFlagsCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFlagsCacheForTests();
    try { getDb().close(); } catch { /* already closed */ }
  });

  it('defaults all 6 pillars to false when settings row is missing or malformed', () => {
    expect(getFlags()).toEqual({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
    expect(isPillarEnabled('prompts')).toBe(false);
    expect(isPillarEnabled('mcpClient')).toBe(false);

    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_flags_v1', '{bad-json')")
      .run();
    resetFlagsCacheForTests();
    expect(getFlags()).toEqual({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
  });

  it('returns false on DB errors without throwing', () => {
    getDb().close();
    resetFlagsCacheForTests();
    expect(isPillarEnabled('outputGuard')).toBe(false);
    expect(getFlags()).toEqual({
      prompts: false,
      retrieval: false,
      promptCache: false,
      mcpClient: false,
      outputGuard: false,
      orchestrator: false,
    });
  });

  it('updates only patched boolean keys, preserves others, and invalidates 5s cache', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T00:00:00Z'));

    expect(isPillarEnabled('prompts')).toBe(false);

    // Direct DB edit should be hidden by 5s cache until TTL expires
    getDb()
      .prepare(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('ai_platform_flags_v1', ?)",
      )
      .run(JSON.stringify({ prompts: true }));
    expect(isPillarEnabled('prompts')).toBe(false);

    vi.advanceTimersByTime(5_001);
    expect(isPillarEnabled('prompts')).toBe(true);

    // setFlags patches only provided keys and invalidates cache immediately
    const updated = setFlags({ mcpClient: true });
    expect(updated).toEqual({
      prompts: true,
      retrieval: false,
      promptCache: false,
      mcpClient: true,
      outputGuard: false,
      orchestrator: false,
    });
    expect(isPillarEnabled('mcpClient')).toBe(true);
    expect(isPillarEnabled('prompts')).toBe(true);
  });

  it('throws when setFlags cannot persist to DB instead of faking success', () => {
    getDb().close();
    expect(() => setFlags({ prompts: true })).toThrow();
  });
});
