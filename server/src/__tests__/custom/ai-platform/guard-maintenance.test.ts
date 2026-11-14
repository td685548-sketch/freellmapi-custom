import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { recordGuardEvent, resetGuardEventRateLimitForTests } from '../../../custom/ai-platform/output-guard/events.js';
import {
  maybeRunGuardMaintenance,
  resetGuardMaintenanceForTests,
} from '../../../custom/ai-platform/output-guard/maintenance.js';

describe('output-guard/maintenance', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetGuardEventRateLimitForTests();
    resetGuardMaintenanceForTests();
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('throttles periodic maintenance and purges expired excerpts + old events when due', () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    recordGuardEvent({
      scope: { kind: 'profile', id: '1' },
      endUser: 'u1',
      detector: 'keywords',
      action: 'blocked',
      wire: 'openai-chat',
      streamed: false,
      excerptSourceText: 'secret text',
      matchOffset: 0,
      matchLength: 6,
      now: t0,
    });

    const first = maybeRunGuardMaintenance({ now: t0 });
    expect(first.ran).toBe(true);
    expect(first.purgedExcerpts).toBe(0);

    // Within interval -> throttled
    const second = maybeRunGuardMaintenance({ now: new Date(t0.getTime() + 5_000) });
    expect(second.ran).toBe(false);

    // 8 days later -> runs and purges excerpt
    const t8 = new Date('2026-11-09T00:00:00.000Z');
    const third = maybeRunGuardMaintenance({ now: t8 });
    expect(third.ran).toBe(true);
    expect(third.purgedExcerpts).toBe(1);
    expect(third.prunedEvents).toBe(0);
  });
});
