import { describe, it, expect, afterAll } from 'vitest';
import {
  validatePatternRule,
  validatePatternsConfig,
  evaluatePatternInWorker,
  evaluatePatternsSafe,
  PatternTimeoutError,
  disposePatternWorkerPool,
} from '../../../custom/ai-platform/output-guard/pattern-validator.js';

describe('output-guard pattern-validator & worker isolation', () => {
  afterAll(async () => {
    await disposePatternWorkerPool();
  });

  it('accepts valid safe regex rules within limits', async () => {
    const res = await validatePatternsConfig({
      enabled: true,
      rules: [
        { id: 'r1', name: 'Secret prefix', pattern: 'SECRET_[A-Z0-9]{4,12}', flags: 'i' },
        { id: 'r2', name: 'Order id', pattern: 'ORD-\\d{6}', flags: '' },
      ],
    });
    expect(res).toMatchObject({ ok: true });
  });

  it('rejects invalid regex syntax or invalid flags with validation_error', async () => {
    const bad1 = await validatePatternRule({ id: 'bad1', name: 'Unclosed', pattern: '[unclosed', flags: 'i' });
    expect(bad1).toMatchObject({ ok: false, code: 'validation_error' });

    const bad2 = await validatePatternRule({ id: 'bad2', name: 'Bad flag', pattern: 'abc', flags: 'z' });
    expect(bad2).toMatchObject({ ok: false, code: 'validation_error' });
  });

  it('rejects >20 rules or patterns >200 chars with validation_error', async () => {
    const tooLong = 'a'.repeat(201);
    const rLong = await validatePatternRule({ id: 'long', name: 'Too long', pattern: tooLong, flags: '' });
    expect(rLong).toMatchObject({ ok: false, code: 'validation_error' });

    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `r${i}`,
      name: `Rule ${i}`,
      pattern: `tok_${i}`,
      flags: '',
    }));
    const rMany = await validatePatternsConfig({ enabled: true, rules: many });
    expect(rMany).toMatchObject({ ok: false, code: 'validation_error' });
  });

  it('rejects catastrophic ReDoS patterns (>5ms on 10,000 chars) via worker termination with unsafe_pattern', async () => {
    const res = await validatePatternRule({
      id: 'redos',
      name: 'Catastrophic',
      pattern: '^(a+)+$',
      flags: '',
    });
    expect(res).toMatchObject({ ok: false, code: 'unsafe_pattern' });
  });

  it('separates worker startup time from regex 5ms execution budget', async () => {
    const res = await validatePatternRule({
      id: 'fast',
      name: 'Fast literal',
      pattern: 'forbidden_token_\\d+',
      flags: 'i',
    });
    expect(res.ok).toBe(true);
    if (res.ok && res.evalMs !== undefined) {
      expect(res.evalMs).toBeLessThanOrEqual(5);
    }
  });

  it('enforces runtime execution budget and terminates catastrophic input different from save-time sample', async () => {
    const adversarial = 'x'.repeat(28) + '!';
    const single = await evaluatePatternInWorker(
      { id: 'adv', name: 'Backtrack', pattern: '^(x+x+)+y$', flags: '' },
      adversarial,
      15,
    );
    expect(single).toMatchObject({ matched: false, timedOut: true });

    await expect(
      evaluatePatternsSafe(
        [{ id: 'adv', name: 'Backtrack', pattern: '^(x+x+)+y$', flags: '' }],
        adversarial,
        { timeoutMs: 15 },
      ),
    ).rejects.toThrow(PatternTimeoutError);
  });

  it('finds matches with original text indices when safe', async () => {
    const matches = await evaluatePatternsSafe(
      [{ id: 'm1', name: 'Key', pattern: 'KEY-[0-9]{4}', flags: 'i' }],
      'Here is key-1234 and KEY-5678.',
    );
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ id: 'm1', start: 8, end: 16, match: 'key-1234' });
    expect(matches[1]).toMatchObject({ id: 'm1', start: 21, end: 29, match: 'KEY-5678' });
  });
});
