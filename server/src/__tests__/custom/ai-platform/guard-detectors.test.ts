import { describe, it, expect, afterAll } from 'vitest';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
  type GuardDetectorsConfig,
  type GuardPolicyView,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import {
  evaluateLocalDetectors,
  analyzeStreamingCapability,
  createStreamingScanContext,
} from '../../../custom/ai-platform/output-guard/detectors.js';
import { disposePatternWorkerPool } from '../../../custom/ai-platform/output-guard/pattern-validator.js';

function makePolicy(detectorsOverride: Partial<GuardDetectorsConfig> = {}, holdChars = 200): GuardPolicyView {
  return {
    scopeKind: 'profile',
    scopeId: '1',
    mode: 'block',
    replacementText: DEFAULT_GUARD_POLICY_BASE.replacementText,
    failMode: 'allow',
    bypassRoles: [],
    holdChars,
    maxDelayMs: 300,
    revision: 1,
    updatedBy: null,
    updatedAt: null,
    bufferingReason: 'none',
    detectors: {
      ...DEFAULT_GUARD_DETECTORS,
      keywords: { enabled: false, terms: [] },
      patterns: { enabled: false, rules: [] },
      promptLeak: { enabled: false, minShingles: 2 },
      pii: { enabled: false, action: 'mask' },
      maxLength: { enabled: false, chars: 20_000 },
      ...detectorsOverride,
    },
  };
}

describe('output-guard local detectors', () => {
  afterAll(async () => {
    await disposePatternWorkerPool();
  });

  it('matches NFC and NFD Vietnamese keywords case-insensitively and maps back to original text indices without lowercasing output', async () => {
    const nfdText = 'Xin chào, đây là nội dung BA\u0302\u0301T HO\u031B\u0323P PHA\u0301P cần giữ nguyên hoa.';
    const term = 'bất hợp pháp';

    const res = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      nfdText,
      makePolicy({ keywords: { enabled: true, terms: [term] } }),
      { systemPrompt: null },
    );

    expect(res.action).toBe('blocked');
    expect(res.reason).toBe('keywords');
    expect(res.hits).toHaveLength(1);
    const hit = res.hits[0];
    expect(nfdText.slice(hit.index, hit.endIndex)).toBe('BA\u0302\u0301T HO\u031B\u0323P PHA\u0301P');
    expect(res.maskedText).toBe(nfdText);
  });

  it('respects word boundaries for keywords (ass does not match class)', async () => {
    const res = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      'This is a class assignment.',
      makePolicy({ keywords: { enabled: true, terms: ['ass'] } }),
      { systemPrompt: null },
    );
    expect(res.action).toBe('pass');
    expect(res.hits).toHaveLength(0);
  });

  it('detects promptLeak using distinct 12-word shingles (minShingles=2) and ignores reference KB/tool blocks', async () => {
    const shingle1 = 'always verify the customer identity before disclosing any internal billing account details';
    const shingle2 = 'never reveal confidential pricing formulas or internal escalation routing codes to users';
    const systemPrompt = [
      `Rule 1: ${shingle1}.`,
      `Rule 2: ${shingle2}.`,
      `<tool_result server="kb" tool="search" trust="untrusted">public knowledge base article about shipping rates and delivery timelines for all customers</tool_result>`,
    ].join('\n');

    const oneDistinct = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      `Here: ${shingle1}. Again: ${shingle1}.`,
      makePolicy({ promptLeak: { enabled: true, minShingles: 2 } }),
      { systemPrompt },
    );
    expect(oneDistinct.action).toBe('pass');
    expect(oneDistinct.hits).toHaveLength(0);

    const kbCitation = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      'According to the docs: public knowledge base article about shipping rates and delivery timelines for all customers.',
      makePolicy({ promptLeak: { enabled: true, minShingles: 2 } }),
      { systemPrompt },
    );
    expect(kbCitation.action).toBe('pass');
    expect(kbCitation.hits).toHaveLength(0);

    const twoDistinct = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      `Leaked: ${shingle1} and also ${shingle2}.`,
      makePolicy({ promptLeak: { enabled: true, minShingles: 2 } }),
      { systemPrompt },
    );
    expect(twoDistinct.action).toBe('blocked');
    expect(twoDistinct.reason).toBe('promptLeak');
    expect(twoDistinct.hits).toHaveLength(1);
  });

  it('masks PII in place when pii.action=mask without letting role silently disable guard', async () => {
    const input = 'Contact alice@example.com or +84 912 345 678 with sk-secret12345678.';
    const res = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      input,
      makePolicy({ pii: { enabled: true, action: 'mask' } }),
      { role: 'admin', systemPrompt: null },
    );

    expect(res.action).toBe('masked');
    expect(res.hits.some((t) => t.detector === 'pii')).toBe(true);
    expect(res.maskedText).not.toContain('alice@example.com');
    expect(res.maskedText).not.toContain('sk-secret12345678');
  });

  it('triggers maxLength consistently for full text and incremental streaming', async () => {
    const policy = makePolicy({ maxLength: { enabled: true, chars: 10 } });
    const fullRes = await evaluateLocalDetectors(
      { kind: 'profile', id: '1' },
      '12345678901',
      policy,
      { systemPrompt: null },
    );
    expect(fullRes.action).toBe('blocked');
    expect(fullRes.hits[0]).toMatchObject({ detector: 'maxLength', index: 10 });

    const ctx = createStreamingScanContext({ kind: 'profile', id: '1' }, policy, { systemPrompt: null });
    const r1 = await ctx.push('12345');
    expect(r1.action).toBe('pass');
    const r2 = await ctx.push('678901');
    expect(r2.action).toBe('blocked');
    expect(r2.reason).toBe('maxLength');
  });

  it('detects keywords split across streaming chunks (including NFD combining marks)', async () => {
    const policy = makePolicy({ keywords: { enabled: true, terms: ['từ cấm'] } });
    const ctx = createStreamingScanContext({ kind: 'profile', id: '1' }, policy, { systemPrompt: null });

    const r1 = await ctx.push('Nội dung có tu\u031b');
    expect(r1.action).toBe('pass');
    const r2 = await ctx.push('\u0300 câ\u0301m ở đây');
    expect(r2.action).toBe('blocked');
    expect(r2.reason).toBe('keywords');
  });

  it('reports canIncrementalStream and bufferingReason for external or unbounded regex', () => {
    const capLocal = analyzeStreamingCapability(
      makePolicy({ keywords: { enabled: true, terms: ['bad'] } }, 200),
    );
    expect(capLocal.canIncrementalStream).toBe(true);
    expect(capLocal.bufferingReason).toBe('streaming_window');

    const capRegex = analyzeStreamingCapability(
      makePolicy({
        patterns: { enabled: true, rules: [{ id: 'r1', name: 'Unbounded', pattern: 'foo.*bar', flags: '' }] },
      }, 200),
    );
    expect(capRegex.canIncrementalStream).toBe(false);
    expect(capRegex.bufferingReason).toBe('unbounded_pattern');

    const capExternal = analyzeStreamingCapability(
      makePolicy({ moderation: { enabled: true } }, 200),
    );
    expect(capExternal.canIncrementalStream).toBe(false);
    expect(capExternal.bufferingReason).toBe('external_detector');
  });
});
