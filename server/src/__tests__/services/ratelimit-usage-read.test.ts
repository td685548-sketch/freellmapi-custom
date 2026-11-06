import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { persistedUsage, recordRequest, recordTokens, setUsageMemoTestOverride } from '../../services/ratelimit.js';

// The request and token gates used to issue four statements per attempt (rpm, rpd,
// tpm, tpd). One statement now answers all four; this pins that the numbers are
// exactly what the four separate statements returned, and that the short-lived
// reuse inside one attempt can never read past a usage write.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// The statements as they were before the merge.
function reference(platform: string, modelId: string, keyId: number, now: number) {
  const db = getDb();
  const count = (windowMs: number) => (db.prepare(`SELECT COUNT(*) AS used FROM rate_limit_usage
    WHERE platform = ? AND model_id = ? AND key_id = ? AND kind = 'request' AND created_at_ms > ?`).get(platform, modelId, keyId, now - windowMs) as { used: number }).used;
  const sum = (windowMs: number) => (db.prepare(`SELECT COALESCE(SUM(tokens), 0) AS used FROM rate_limit_usage
    WHERE platform = ? AND model_id = ? AND key_id = ? AND kind = 'tokens' AND created_at_ms > ?`).get(platform, modelId, keyId, now - windowMs) as { used: number }).used;
  return { rpm: count(MINUTE), rpd: count(DAY), tpm: sum(MINUTE), tpd: sum(DAY) };
}

describe('rate-limit usage read', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    setUsageMemoTestOverride(false);
  });
  afterEach(() => setUsageMemoTestOverride(null));

  it('returns exactly what the four separate statements returned', () => {
    const now = 1_800_000_000_000;
    const ins = getDb().prepare('INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
    const ages = [1_000, 30_000, 59_999, 60_000, 60_001, 3_600_000, 86_399_000, DAY, DAY + 1, 2 * DAY];
    ages.forEach((age, i) => {
      for (const [platform, model, key] of [['groq', 'm1', 1], ['groq', 'm1', 2], ['groq', 'm2', 1], ['google', 'm1', 1]] as const) {
        ins.run(platform, model, key, 'request', 0, now - age - i);
        ins.run(platform, model, key, 'tokens', 100 + i * 7, now - age - i);
      }
    });
    for (const [platform, model, key] of [['groq', 'm1', 1], ['groq', 'm1', 2], ['groq', 'm2', 1], ['google', 'm1', 1], ['groq', 'none', 9]] as const) {
      expect(persistedUsage(platform, model, key, now), `${platform}/${model}/${key}`).toEqual(reference(platform, model, key, now));
    }
    expect(persistedUsage('groq', 'none', 9, now)).toEqual({ rpm: 0, rpd: 0, tpm: 0, tpd: 0 });
  });

  describe('short-lived reuse inside one attempt', () => {
    function counted() {
      const db = getDb();
      let reads = 0;
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        const stmt = prepare(sql);
        if (/FROM rate_limit_usage/.test(sql) && /^\s*SELECT/.test(sql)) return { ...stmt, get: (...a: unknown[]) => { reads++; return stmt.get(...a); } } as any;
        return stmt;
      }) as typeof db.prepare;
      return { reads: () => reads, restore: () => { db.prepare = prepare; } };
    }

    it('shares one read between the gates of one attempt', () => {
      setUsageMemoTestOverride(true);
      const c = counted();
      try {
        const now = Date.now();
        const a = persistedUsage('groq', 'm1', 1, now);
        const b = persistedUsage('groq', 'm1', 1, now + 2);
        expect(b).toEqual(a);
        expect(c.reads()).toBe(1);
      } finally { c.restore(); }
    });

    it('never reads past a usage write, another key, or a few milliseconds of age', () => {
      setUsageMemoTestOverride(true);
      const c = counted();
      try {
        const now = Date.now();
        expect(persistedUsage('groq', 'm1', 1, now)!.rpm).toBe(0);
        recordRequest('groq', 'm1', 1);
        expect(persistedUsage('groq', 'm1', 1, now)!.rpm).toBe(1); // write invalidated the reuse
        recordTokens('groq', 'm1', 1, 40);
        expect(persistedUsage('groq', 'm1', 1, now)!.tpm).toBe(40);
        const before = c.reads();
        persistedUsage('groq', 'm1', 2, now); // different key
        expect(c.reads()).toBe(before + 1);
        persistedUsage('groq', 'm1', 2, now + 1_000); // older than the reuse window
        expect(c.reads()).toBe(before + 2);
      } finally { c.restore(); }
    });
  });
});
