import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  SupportOutputDecision,
  SupportOutputLeaf,
  SupportOutputPolicy,
} from '@freellmapi/shared/support-output.js';
import {
  evaluateSupportOutput,
  normalizeSupportOutputText,
  SUPPORT_OUTPUT_CREDENTIAL_LIMITATIONS,
  SupportOutputEngineError,
} from '../../custom/x-gateway/support-output-engine.js';

interface FixtureCase {
  id: string;
  description: string;
  policy: SupportOutputPolicy;
  leaves: SupportOutputLeaf[];
  expected: SupportOutputDecision;
}

interface FixtureFile {
  version: number;
  cases: FixtureCase[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, '../fixtures/support-output/cases.json');
const fixtureData = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureFile;

function makePolicy(overrides: Partial<SupportOutputPolicy> = {}): SupportOutputPolicy {
  return {
    tenantId: 1,
    version: 1,
    mode: 'enforce',
    blockedTerms: [],
    maxOutputChars: 16_000,
    redactCredentials: true,
    updatedAt: '2026-11-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('support-output-engine', () => {
  describe('deterministic fixtures (cases.json)', () => {
    it.each(fixtureData.cases)('$id: $description', (tc) => {
      const decision = evaluateSupportOutput({
        policy: tc.policy,
        leaves: tc.leaves,
      });
      expect(decision).toEqual(tc.expected);
    });
  });

  describe('normalization and literal matching', () => {
    it('normalizes NFKC, zero-width chars, case, and whitespace while keeping Vietnamese accents', () => {
      expect(normalizeSupportOutputText('  ＭẬＴ\u200B  ＫＨẨＵ\u200C\u200D\uFEFF\t\nNỘI   BỘ  ')).toBe(
        'mật khẩu nội bộ',
      );
    });

    it('supports 0, 1, and max (50) rules', () => {
      const fiftyRules = Array.from({ length: 50 }, (_, i) => ({
        id: `rule-${i}`,
        text: `forbidden_phrase_${String(i).padStart(2, '0')}`,
      }));

      const zero = evaluateSupportOutput({
        policy: makePolicy({ blockedTerms: [] }),
        leaves: [{ path: 'reply', text: 'forbidden_phrase_49' }],
      });
      expect(zero.action).toBe('allow');

      const one = evaluateSupportOutput({
        policy: makePolicy({ blockedTerms: [fiftyRules[0]] }),
        leaves: [{ path: 'reply', text: 'forbidden_phrase_00' }],
      });
      expect(one.action).toBe('block');
      expect(one.ruleIds).toEqual(['rule-0']);

      const max = evaluateSupportOutput({
        policy: makePolicy({ blockedTerms: fiftyRules }),
        leaves: [{ path: 'reply', text: 'contains forbidden_phrase_49 inside' }],
      });
      expect(max.action).toBe('block');
      expect(max.ruleIds).toEqual(['rule-49']);
    });

    it('does not mutate returned display text when allowed or observed', () => {
      const original = '  Xin Chào\u200B   ＡＰＩ   Line1\r\nLine2  ';
      const decision = evaluateSupportOutput({
        policy: makePolicy({ mode: 'log', blockedTerms: [{ id: 'r1', text: 'api' }] }),
        leaves: [{ path: 'reply', text: original }],
      });
      expect(decision.action).toBe('observe');
      expect(decision.leaves[0].text).toBe(original);
    });
  });

  describe('structural validation and safe errors (no raw leakage)', () => {
    const sentinel = 'SENTINEL_RAW_LEAK_XYZ_999';

    function expectSafe400(fn: () => unknown, expectedCode: string): void {
      try {
        fn();
        expect.unreachable('Expected SupportOutputEngineError');
      } catch (err) {
        expect(err).toBeInstanceOf(SupportOutputEngineError);
        const typed = err as SupportOutputEngineError;
        expect(typed.status).toBe(400);
        expect(typed.code).toBe(expectedCode);
        expect(typed.message).not.toContain(sentinel);
      }
    }

    it('rejects >50 rules, duplicate rule IDs, and duplicate normalized terms', () => {
      const fiftyOne = Array.from({ length: 51 }, (_, i) => ({
        id: `r_${i}`,
        text: `term_${i}`,
      }));
      expectSafe400(
        () => evaluateSupportOutput({ policy: makePolicy({ blockedTerms: fiftyOne }), leaves: [] }),
        'invalid_output_policy',
      );

      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy({
              blockedTerms: [
                { id: 'dup', text: `${sentinel}_1` },
                { id: 'dup', text: `${sentinel}_2` },
              ],
            }),
            leaves: [],
          }),
        'invalid_output_policy',
      );

      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy({
              blockedTerms: [
                { id: 'r1', text: `  ${sentinel}  ` },
                { id: 'r2', text: `${sentinel.toLowerCase()}\u200B` },
              ],
            }),
            leaves: [],
          }),
        'invalid_output_policy',
      );
    });

    it('rejects invalid rule IDs, empty/overlong normalized terms, and invalid policy bounds', () => {
      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy({ blockedTerms: [{ id: 'bad id!', text: sentinel }] }),
            leaves: [],
          }),
        'invalid_output_policy',
      );

      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy({ blockedTerms: [{ id: 'r1', text: ' \u200B\uFEFF ' }] }),
            leaves: [],
          }),
        'invalid_output_policy',
      );

      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy({ blockedTerms: [{ id: 'r1', text: 'a'.repeat(101) }] }),
            leaves: [],
          }),
        'invalid_output_policy',
      );

      expectSafe400(
        () => evaluateSupportOutput({ policy: makePolicy({ maxOutputChars: 255 }), leaves: [] }),
        'invalid_output_policy',
      );
      expectSafe400(
        () => evaluateSupportOutput({ policy: makePolicy({ maxOutputChars: 64_001 }), leaves: [] }),
        'invalid_output_policy',
      );
      expectSafe400(
        () => evaluateSupportOutput({ policy: makePolicy({ tenantId: 0 }), leaves: [] }),
        'invalid_output_policy',
      );
      expectSafe400(
        () => evaluateSupportOutput({ policy: makePolicy({ version: -1 }), leaves: [] }),
        'invalid_output_policy',
      );
    });

    it('rejects invalid leaves and duplicate leaf paths without leaking raw text', () => {
      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy(),
            leaves: [
              { path: 'reply', text: sentinel },
              { path: 'reply', text: 'other' },
            ],
          }),
        'invalid_output_input',
      );

      expectSafe400(
        () =>
          evaluateSupportOutput({
            policy: makePolicy(),
            leaves: [{ path: 'p'.repeat(129), text: sentinel }],
          }),
        'invalid_output_input',
      );
    });

    it('never leaks raw input in block decision', () => {
      const decision = evaluateSupportOutput({
        policy: makePolicy({
          mode: 'enforce',
          blockedTerms: [{ id: 'r1', text: 'secret' }],
        }),
        leaves: [{ path: 'reply', text: `Prefix ${sentinel} secret suffix` }],
      });
      expect(decision.action).toBe('block');
      expect(decision.leaves).toEqual([]);
      expect(JSON.stringify(decision)).not.toContain(sentinel);
    });
  });

  describe('hard inspection limits (distinct from maxOutputChars)', () => {
    it('allows exactly 128000 raw code units and 32 leaves when within maxOutputChars or blocks too_long', () => {
      const exactLeaves = Array.from({ length: 32 }, (_, i) => ({
        path: `leaf.${i}`,
        text: 'a'.repeat(10),
      }));
      const ok = evaluateSupportOutput({
        policy: makePolicy({ mode: 'enforce', maxOutputChars: 1000 }),
        leaves: exactLeaves,
      });
      expect(ok.action).toBe('allow');

      const exactMaxChars = evaluateSupportOutput({
        policy: makePolicy({ mode: 'log', maxOutputChars: 64_000 }),
        leaves: [{ path: 'reply', text: 'x'.repeat(128_000) }],
      });
      expect(exactMaxChars.action).toBe('observe');
      expect(exactMaxChars.reasons).toEqual(['too_long']);
    });

    it('blocks without scanning in enforce mode when over 128000 code units or >32 leaves', () => {
      const overChars = evaluateSupportOutput({
        policy: makePolicy({
          mode: 'enforce',
          blockedTerms: [{ id: 'r1', text: 'secret' }],
          redactCredentials: true,
        }),
        leaves: [{ path: 'reply', text: `secret sk-1234567890 ${'x'.repeat(128_000)}` }],
      });
      expect(overChars).toEqual({
        action: 'block',
        leaves: [],
        reasons: ['inspection_limit'],
        ruleIds: [],
        redactionCount: 0,
        policyVersion: 1,
      });

      const overLeaves = evaluateSupportOutput({
        policy: makePolicy({ mode: 'enforce' }),
        leaves: Array.from({ length: 33 }, (_, i) => ({ path: `l.${i}`, text: 'ok' })),
      });
      expect(overLeaves.action).toBe('block');
      expect(overLeaves.reasons).toEqual(['inspection_limit']);
    });

    it('throws safe 503 output_inspection_limit in off and log modes when over hard limit', () => {
      const sentinel = 'RAW_OVERSIZED_SENTINEL_123';
      for (const mode of ['off', 'log'] as const) {
        try {
          evaluateSupportOutput({
            policy: makePolicy({ mode }),
            leaves: [{ path: 'reply', text: `${sentinel}${'y'.repeat(128_000)}` }],
          });
          expect.unreachable(`Expected 503 for mode=${mode}`);
        } catch (err) {
          expect(err).toBeInstanceOf(SupportOutputEngineError);
          const typed = err as SupportOutputEngineError;
          expect(typed.status).toBe(503);
          expect(typed.code).toBe('output_inspection_limit');
          expect(typed.message).not.toContain(sentinel);
        }
      }
    });
  });

  describe('credential detection, idempotency, and known limitations', () => {
    it('redacts idempotently (second pass returns allow with 0 redactions)', () => {
      const policy = makePolicy({ mode: 'enforce', redactCredentials: true });
      const first = evaluateSupportOutput({
        policy,
        leaves: [
          {
            path: 'reply',
            text: [
              'Bearer abcdef1234567890',
              'sk-test-1234567890',
              'sk_sup_prod_9876543210',
              'sup_ctx_token_12345678',
              '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8=\n-----END PRIVATE KEY-----',
            ].join('\n'),
          },
        ],
      });
      expect(first.action).toBe('redact');
      expect(first.redactionCount).toBe(5);

      const second = evaluateSupportOutput({
        policy,
        leaves: first.leaves,
      });
      expect(second.action).toBe('allow');
      expect(second.redactionCount).toBe(0);
      expect(second.leaves).toEqual(first.leaves);
    });

    it('redacts nonempty short Bearer tokens and preserves delimiters', () => {
      const policy = makePolicy({ mode: 'enforce', redactCredentials: true });
      for (let length = 1; length <= 9; length++) {
        const result = evaluateSupportOutput({
          policy, leaves: [{ path: 'reply', text: 'Bearer ' + 'a'.repeat(length) + '.\r\nNext header' }],
        });
        expect(result.action).toBe('redact');
        expect(result.leaves[0].text).toBe('Bearer [REDACTED_TOKEN].\r\nNext header');
        expect(evaluateSupportOutput({ policy, leaves: result.leaves }).action).toBe('allow');
      }
      const padded = evaluateSupportOutput({ policy, leaves: [{ path: 'reply', text: 'Bearer abc123==, suffix' }] });
      expect(padded.leaves[0].text).toBe('Bearer [REDACTED_TOKEN], suffix');
      expect(SUPPORT_OUTPUT_CREDENTIAL_LIMITATIONS.length).toBeGreaterThan(0);
    });

    it('handles adversarial unclosed PEM and repeated Bearer prefixes in bounded time without ReDoS', () => {
      const policy = makePolicy({ mode: 'enforce', maxOutputChars: 64_000, redactCredentials: true });
      const hugeAdversarial = `${'-----BEGIN PRIVATE KEY-----\n'.repeat(100)}${'Bearer ; '.repeat(2000)}${'a'.repeat(40_000)}`;
      expect(hugeAdversarial.length).toBeLessThanOrEqual(64_000);

      const start = performance.now();
      const decision = evaluateSupportOutput({
        policy,
        leaves: [{ path: 'reply', text: hugeAdversarial }],
      });
      const elapsedMs = performance.now() - start;

      expect(decision.action).toBe('allow');
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});
