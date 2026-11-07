import { describe, expect, it } from 'vitest';
import {
  setPxpipeEnabled,
  getPxpipeMinChars,
  setPxpipeMinChars,
  getPxpipeConfig,
  setPxpipeConfig,
  estTokens,
  compressPrompt,
  compressRequestBody,
  recordPxpipeEvent,
  getPxpipeStats,
  DEFAULT_PXPIPE_MIN_CHARS,
} from '../../custom/x-gateway/pxpipe.js';

describe('pxpipe Prompt Compression Suite', () => {
  describe('configuration & settings', () => {
    it('handles minChars threshold with boundaries', () => {
      setPxpipeMinChars(30000);
      expect(getPxpipeMinChars()).toBe(30000);

      // Minimum clamped to 1000
      setPxpipeMinChars(500);
      expect(getPxpipeMinChars()).toBe(1000);

      // Maximum clamped to 200000
      setPxpipeMinChars(300000);
      expect(getPxpipeMinChars()).toBe(200000);

      // Restore
      setPxpipeMinChars(DEFAULT_PXPIPE_MIN_CHARS);
    });

    it('manages config object updates', () => {
      setPxpipeConfig({ enabled: true, minChars: 25000 });
      const cfg = getPxpipeConfig();
      expect(cfg.enabled).toBe(true);
      expect(cfg.minChars).toBe(25000);
    });
  });

  describe('estTokens', () => {
    it('estimates 1 token per 4 characters roughly', () => {
      expect(estTokens(100)).toBe(25);
      expect(estTokens(4000)).toBe(1000);
    });
  });

  describe('compressPrompt', () => {
    it('bypasses prompts smaller than threshold', () => {
      const short = 'Small prompt here';
      const result = compressPrompt(short, { minChars: 1000 });
      expect(result.applied).toBe(false);
      expect(result.reason).toBe('below_threshold');
      expect(result.compressed).toBe(short);
      expect(result.tokensSavedEst).toBe(0);
    });

    it('collapses excessive empty lines and markdown dividers when above threshold', () => {
      const excessiveDividers = '-'.repeat(50);
      const padding = 'Useful instruction text here. '.repeat(100);
      const longPrompt = [
        '# Header',
        '',
        '',
        '',
        '',
        'Section 1',
        excessiveDividers,
        padding,
        '',
        '',
        '',
        'Section 2',
      ].join('\n');

      const result = compressPrompt(longPrompt, { minChars: 100 });
      expect(result.applied).toBe(true);
      expect(result.compressed.length).toBeLessThan(longPrompt.length);
      expect(result.tokensSavedEst).toBeGreaterThan(0);
      // Collapsed separators
      expect(result.compressed).not.toContain(excessiveDividers);
      expect(result.compressed).toContain('----');
      // Collapsed empty lines
      expect(result.compressed).not.toContain('\n\n\n\n');
    });

    it('collapses repeating logs in massive contexts', () => {
      const repeatingLogs = 'INFO 2026-11-07 status ok\n'.repeat(20);
      const context = 'Context start\n' + repeatingLogs + 'Context end';
      const result = compressPrompt(context, { minChars: 50 });
      expect(result.applied).toBe(true);
      expect(result.compressed).toContain('[repeated log entries collapsed]');
    });
  });

  describe('compressRequestBody', () => {
    it('returns untouched body when pxpipe is disabled', () => {
      setPxpipeEnabled(false);
      const body = {
        messages: [{ role: 'user', content: 'hello world' }],
      };
      const res = compressRequestBody(body);
      expect(res.applied).toBe(false);
      expect(res.savedTokensEst).toBe(0);
    });

    it('compresses messages if pxpipe enabled and length exceeds threshold', () => {
      setPxpipeEnabled(true);
      setPxpipeMinChars(1000);

      const massiveContent = 'Line text\n\n\n\n'.repeat(600) + '-'.repeat(50) + '\nEnd of prompt';
      const body = {
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: massiveContent },
        ],
      };

      const res = compressRequestBody(body, 'gpt-4o');
      expect(res.applied).toBe(true);
      expect(res.savedTokensEst).toBeGreaterThan(0);
      expect((res.body.messages as Array<{ content: string }>)[1].content.length).toBeLessThan(massiveContent.length);
    });
  });

  describe('timeline and window stats', () => {
    it('records events and computes windows correctly', () => {
      const now = new Date();
      recordPxpipeEvent({
        id: 'test-1',
        time: now.toISOString(),
        date: now.toISOString().slice(0, 10),
        model: 'claude-3-5-sonnet',
        originalChars: 40000,
        compressedChars: 24000,
        tokensBeforeEst: 10000,
        tokensAfterEst: 6000,
        tokensSavedEst: 4000,
        savedPct: 40.0,
        durationMs: 15,
        status: 'compressed',
      });

      const stats = getPxpipeStats();
      expect(stats.windows.today.requests).toBeGreaterThanOrEqual(1);
      expect(stats.windows.today.compressed).toBeGreaterThanOrEqual(1);
      expect(stats.windows.today.tokensSavedEst).toBeGreaterThanOrEqual(4000);
      expect(stats.timeline.length).toBe(30);
      expect(stats.recentLogs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
