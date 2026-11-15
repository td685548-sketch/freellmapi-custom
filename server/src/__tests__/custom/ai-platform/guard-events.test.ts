import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import {
  getGuardExcerpt,
  listGuardEvents,
  pruneGuardEvents,
  recordGuardEvent,
  resetGuardEventRateLimitForTests,
} from '../../../custom/ai-platform/output-guard/events.js';

describe('output-guard/events', () => {
  beforeEach(() => {
    initDb(':memory:');
    resetGuardEventRateLimitForTests();
  });

  afterEach(() => {
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('encrypts excerpts <= 500 chars around match, hides cipher/text in listGuardEvents, and decrypts in getGuardExcerpt', () => {
    const longPrefix = 'A'.repeat(400);
    const match = 'SECRET_TOKEN_XYZ';
    const longSuffix = 'B'.repeat(400);
    const fullText = `${longPrefix}${match}${longSuffix}`;

    const res = recordGuardEvent({
      scope: { kind: 'profile', id: '1' },
      endUser: 'user-1',
      detector: 'keywords',
      action: 'blocked',
      wire: 'openai-chat',
      streamed: false,
      excerptSourceText: fullText,
      matchOffset: 400,
      matchLength: match.length,
    });

    expect(res.recorded).toBe(true);
    expect(res.id).toBeTypeOf('number');

    // Raw DB row must have ciphertext/iv/tag and NO plaintext excerpt
    const rawRow = getDb()
      .prepare('SELECT excerpt_ciphertext, excerpt_iv, excerpt_tag FROM custom_ai_guard_events WHERE id = ?')
      .get(res.id) as { excerpt_ciphertext: string; excerpt_iv: string; excerpt_tag: string };
    expect(rawRow.excerpt_ciphertext).toBeTruthy();
    expect(rawRow.excerpt_iv).toBeTruthy();
    expect(rawRow.excerpt_tag).toBeTruthy();
    expect(rawRow.excerpt_ciphertext).not.toContain(match);

    // List returns metadata only
    const list = listGuardEvents({ scope: 'profile/1' });
    expect(list.events).toHaveLength(1);
    const item = list.events[0]!;
    expect(item.id).toBe(res.id);
    expect(item.hasExcerpt).toBe(true);
    expect(item.excerptExpired).toBe(false);
    expect((item as unknown as Record<string, unknown>).excerpt).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).excerpt_ciphertext).toBeUndefined();
    expect((item as unknown as Record<string, unknown>).match).toBeUndefined();

    // Excerpt decrypts and is bounded to <= 500 chars around the match
    const decrypted = getGuardExcerpt(res.id!);
    expect(decrypted.excerpt.length).toBeLessThanOrEqual(500);
    expect(decrypted.excerpt).toContain(match);
    expect(decrypted.expiresAt).toBeTruthy();
  });

  it('returns 410 on getGuardExcerpt when expired even before sweeper runs, and prunes ciphertext/events by TTL', () => {
    const t0 = new Date('2026-11-01T00:00:00.000Z');
    const res = recordGuardEvent({
      scope: { kind: 'profile', id: '2' },
      endUser: 'u2',
      detector: 'patterns',
      action: 'blocked',
      wire: 'anthropic',
      streamed: true,
      excerptSourceText: 'forbidden match here',
      matchOffset: 10,
      matchLength: 5,
      now: t0,
    });
    expect(res.recorded).toBe(true);

    // 8 days later (> 7d TTL), before sweeper: getGuardExcerpt must throw 410
    const t8 = new Date('2026-11-09T00:00:00.000Z');
    expect(() => getGuardExcerpt(res.id!, t8)).toThrowError(/expired/i);

    // Sweeper at day 8 purges ciphertext/iv/tag but keeps event metadata
    const pruned1 = pruneGuardEvents(t8);
    expect(pruned1.purgedExcerpts).toBe(1);
    expect(pruned1.prunedEvents).toBe(0);

    const rowAfterPurge = getDb()
      .prepare('SELECT excerpt_ciphertext, excerpt_iv, excerpt_tag FROM custom_ai_guard_events WHERE id = ?')
      .get(res.id) as { excerpt_ciphertext: string | null; excerpt_iv: string | null; excerpt_tag: string | null };
    expect(rowAfterPurge).toEqual({ excerpt_ciphertext: null, excerpt_iv: null, excerpt_tag: null });

    const listAfterPurge = listGuardEvents({ scope: 'profile/2' }, t8);
    expect(listAfterPurge.events).toHaveLength(1);
    expect(listAfterPurge.events[0]!.hasExcerpt).toBe(false);
    expect(listAfterPurge.events[0]!.excerptExpired).toBe(true);

    // 91 days later (> 90d retention): event row itself is deleted
    const t91 = new Date('2027-02-01T00:00:00.000Z');
    const pruned2 = pruneGuardEvents(t91);
    expect(pruned2.prunedEvents).toBe(1);
    expect(listGuardEvents({ scope: 'profile/2' }, t91).events).toHaveLength(0);
  });

  it('rate-limits writes per (scope, endUser, detector) and records bypassed events', () => {
    const t0 = new Date('2026-11-10T00:00:00.000Z');
    const bypass = recordGuardEvent({
      scope: { kind: 'support_tenant', id: '5' },
      endUser: 'agent-1',
      detector: 'keywords',
      action: 'bypassed',
      wire: 'support',
      streamed: false,
      now: t0,
    });
    expect(bypass.recorded).toBe(true);

    let recordedCount = 0;
    let throttledCount = 0;
    for (let i = 0; i < 15; i += 1) {
      const r = recordGuardEvent({
        scope: { kind: 'profile', id: '9' },
        endUser: 'spammer',
        detector: 'keywords',
        action: 'blocked',
        wire: 'openai-chat',
        streamed: false,
        now: t0,
      });
      if (r.recorded) recordedCount += 1;
      if (r.throttled) throttledCount += 1;
    }
    expect(recordedCount).toBe(10);
    expect(throttledCount).toBe(5);
  });
});
