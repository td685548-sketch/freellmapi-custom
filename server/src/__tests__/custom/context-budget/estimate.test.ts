import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { estimateInputTokens } from '../../../lib/content.js';
import {
  estimateMessagesTokens,
  estimateMessageTokens,
  estimateTextTokens,
  getCalibrationFactor,
  heuristicTokens,
  recordCalibrationSample,
  resetCalibration,
} from '../../../custom/context-budget/estimate.js';

describe('context-budget token estimator', () => {
  beforeEach(() => {
    resetCalibration();
  });

  describe('estimateTextTokens', () => {
    it('returns 0 for an empty string', () => {
      expect(estimateTextTokens('')).toBe(0);
    });

    it('estimates ~100 tokens for 400 ASCII characters', () => {
      expect(estimateTextTokens('a'.repeat(400))).toBe(100);
      const asciiSentence = 'The quick brown fox jumps over the lazy dog. '.repeat(9).slice(0, 400);
      expect(asciiSentence).toHaveLength(400);
      expect(estimateTextTokens(asciiSentence)).toBe(100);
    });

    it('estimates ~100 tokens for 250 accented Latin / Vietnamese characters', () => {
      // Mix of U+00C0–U+024F and U+1E00–U+1EFF Vietnamese accented characters
      const accentedChars = 'àáâãèéêìíòóôõùúýăđơưấầậệịộờởựỹ'.repeat(9).slice(0, 250);
      expect(accentedChars).toHaveLength(250);
      expect(estimateTextTokens(accentedChars)).toBe(100);
    });

    it('treats combining diacritical marks (U+0300–U+036F) as 2.5 chars/token', () => {
      // 125 ASCII base letters + 125 combining acute marks = 125/4 + 125/2.5 = 81.25 -> 82
      const decomposed = 'a\u0301'.repeat(125);
      expect(estimateTextTokens(decomposed)).toBe(82);
    });

    it('estimates ~100 tokens for 100 CJK, Kana, or Hangul characters', () => {
      expect(estimateTextTokens('中'.repeat(100))).toBe(100);
      expect(estimateTextTokens('あ'.repeat(50) + 'カ'.repeat(50))).toBe(100);
      expect(estimateTextTokens('한'.repeat(100))).toBe(100);
    });

    it('estimates other scripts at ~3 chars/token', () => {
      expect(estimateTextTokens('д'.repeat(300))).toBe(100);
    });
  });

  describe('estimateMessageTokens', () => {
    it('adds 4 overhead tokens per message', () => {
      expect(estimateMessageTokens({ role: 'user', content: '' }, 765)).toBe(4);
      expect(estimateMessageTokens({ role: 'assistant', content: null }, 765)).toBe(4);
      expect(estimateMessageTokens({ role: 'user', content: 'a'.repeat(400) }, 765)).toBe(104);
    });

    it('adds imageTokens for each image block alongside text blocks', () => {
      const msg: ChatMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'a'.repeat(40) },
          { type: 'image_url', image_url: { url: 'https://example.com/1.png' } },
          { type: 'image', source: { type: 'base64', data: 'abc' } } as any,
        ],
      };
      // 4 overhead + 10 text + 2 * 765 image
      expect(estimateMessageTokens(msg, 765)).toBe(4 + 10 + 2 * 765);
      expect(estimateMessageTokens(msg, 500)).toBe(4 + 10 + 2 * 500);
    });

    it('counts tool_calls function name and arguments', () => {
      const msg: ChatMessage = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'a'.repeat(40),
              arguments: 'b'.repeat(360),
            },
          },
        ],
      };
      expect(estimateMessageTokens(msg, 765)).toBe(4 + 100);
    });
  });

  describe('estimateMessagesTokens', () => {
    it('returns 0 for empty messages without tools', () => {
      expect(estimateMessagesTokens([], { imageTokens: 765 })).toBe(0);
    });

    it('sums messages and JSON-serialized tool definitions', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'a'.repeat(400) },
        { role: 'user', content: 'b'.repeat(400) },
      ];
      const tools = [
        {
          type: 'function',
          function: {
            name: 'lookup_order',
            description: 'Find order details by ID',
            parameters: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      ];
      const expectedToolsTokens = estimateTextTokens(JSON.stringify(tools));
      expect(estimateMessagesTokens(messages, { imageTokens: 765 })).toBe(208);
      expect(estimateMessagesTokens(messages, { tools: [], imageTokens: 765 })).toBe(208);
      expect(estimateMessagesTokens(messages, { tools, imageTokens: 765 })).toBe(208 + expectedToolsTokens);
    });
  });

  describe('heuristicTokens', () => {
    it('matches estimateInputTokens from lib/content.ts exactly', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: [{ type: 'text', text: 'Xin chào Việt Nam! ' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '{"temp":28}' },
      ];
      const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }];

      expect(heuristicTokens(messages)).toBe(estimateInputTokens(messages));
      expect(heuristicTokens(messages, tools)).toBe(estimateInputTokens(messages, tools));
    });
  });

  describe('calibration', () => {
    it('defaults to 1.0 for an unsampled platform', () => {
      expect(getCalibrationFactor('groq')).toBe(1.0);
      expect(getCalibrationFactor(undefined)).toBe(1.0);
    });

    it('converges toward ~1.2 after 50 samples with ratio 1.2 and scales estimates', () => {
      for (let i = 0; i < 50; i++) {
        recordCalibrationSample('groq', 1200, 1000);
      }
      const factor = getCalibrationFactor('groq');
      expect(factor).toBeCloseTo(1.2, 2);
      expect(factor).toBeGreaterThanOrEqual(0.75);
      expect(factor).toBeLessThanOrEqual(1.6);

      // Other platforms stay at 1.0
      expect(getCalibrationFactor('google')).toBe(1.0);

      const messages: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(400) }];
      const uncalibrated = estimateMessagesTokens(messages, { imageTokens: 765 });
      const calibrated = estimateMessagesTokens(messages, { imageTokens: 765, platform: 'groq' });
      expect(uncalibrated).toBe(104);
      expect(calibrated).toBe(Math.round(104 * factor));
    });

    it('clamps calibration factor within [0.75, 1.6]', () => {
      for (let i = 0; i < 50; i++) {
        recordCalibrationSample('high', 5000, 1000);
        recordCalibrationSample('low', 100, 1000);
      }
      expect(getCalibrationFactor('high')).toBe(1.6);
      expect(getCalibrationFactor('low')).toBe(0.75);

      // Single extreme spike on fresh platform stays clamped
      recordCalibrationSample('spike', 100000, 10);
      expect(getCalibrationFactor('spike')).toBeLessThanOrEqual(1.6);
      expect(getCalibrationFactor('spike')).toBeGreaterThanOrEqual(0.75);
    });

    it('ignores invalid or non-positive samples and supports resetCalibration()', () => {
      recordCalibrationSample('groq', 0, 1000);
      recordCalibrationSample('groq', 1000, 0);
      recordCalibrationSample('groq', -50, 100);
      recordCalibrationSample('groq', Number.NaN, 100);
      recordCalibrationSample('', 1200, 1000);
      expect(getCalibrationFactor('groq')).toBe(1.0);

      recordCalibrationSample('groq', 1500, 1000);
      expect(getCalibrationFactor('groq')).toBeGreaterThan(1.0);

      resetCalibration();
      expect(getCalibrationFactor('groq')).toBe(1.0);
    });
  });
});
