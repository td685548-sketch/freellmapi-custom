import { describe, expect, it } from 'vitest';
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from '../../custom/context-budget/estimate.js';
import { IMAGE_TOKENS_PER_IMAGE } from '../../lib/content.js';

// The script-weighted estimator moved to lib/content.ts so routing,
// compression, and the context budget share one implementation; this pins
// the budget side of that contract (message overhead, per-image cost, and
// the CJK/Vietnamese ratios) after the move.
describe('context-budget estimate (shared script-weighted estimator)', () => {
  it('re-exports the script-weighted text estimator', () => {
    expect(estimateTextTokens('à'.repeat(100))).toBe(40);
    expect(estimateTextTokens('你'.repeat(10))).toBe(10);
    expect(estimateTextTokens('x'.repeat(400))).toBe(100);
  });

  it('counts CJK messages at ~1 token / 1 char plus the 4-token overhead', () => {
    // 40 CJK chars = 40 tokens + 4 overhead; chars/4 would have said 14.
    expect(estimateMessagesTokens([{ role: 'user', content: '你好世界'.repeat(10) }])).toBe(44);
  });

  it('counts Vietnamese messages at ~1 token / 2.5 chars plus overhead', () => {
    expect(estimateMessagesTokens([{ role: 'user', content: 'à'.repeat(100) }])).toBe(44);
  });

  it('keeps ASCII messages at ~4 chars per token plus overhead', () => {
    expect(estimateMessagesTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(104);
  });

  it('charges the shared 765 tokens per image block', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ],
    } as const;
    // 4 (overhead) + 4 ('describe this' is 13 ASCII chars) + 765 (one image).
    expect(estimateMessageTokens(message as never)).toBe(773);
    expect(estimateMessagesTokens([message as never])).toBe(773);
    expect(IMAGE_TOKENS_PER_IMAGE).toBe(765);
  });

  it('honours a per-policy image-token override', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ],
    } as const;
    expect(estimateMessageTokens(message as never, 100)).toBe(108);
  });
});
