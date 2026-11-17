import { performance } from 'node:perf_hooks';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { CONTEXT_PRESETS, type ContextPolicy } from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { fitToBudget } from '../../../custom/context-budget/fit.js';
import { createRegistry, registerUnit } from '../../../custom/context-budget/registry.js';
import { classifySegments } from '../../../custom/context-budget/segments.js';
import { makeConversation } from './fixtures/conversations.js';

function makePolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    profileId: 1,
    enabled: true,
    inherited: false,
    preset: 'balanced',
    ...CONTEXT_PRESETS.balanced,
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

function percentile(sorted: readonly number[], pct: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

describe('context-budget assembly performance (T059, SC-007)', () => {
  it('runs classifySegments + fitToBudget across 200 iterations on a 1,000-message server conversation with p95 <= 50 ms', () => {
    const policy = makePolicy({ maxInputTokens: 16000, dropBlockTurns: 4 });
    const req = {} as Request;
    const reg = createRegistry(req, policy);

    const summaryText =
      'Summary of the earlier part of this conversation:\nKhách hàng đang tối ưu hóa ngân sách ngữ cảnh trên gateway đa người dùng.';
    registerUnit(req, { kind: 'summary', role: 'system', text: summaryText, seq: 0 });

    const kbPassages = [
      '### Prompt Caching\nKeep leading system and summary blocks immutable across turns and evict history in aligned turn blocks.',
      '### Token Estimator\nScript-weighted estimation scales ASCII at 4 chars/token, accented Latin at 2.5, and CJK at 1.',
    ];
    kbPassages.forEach((passage, idx) => {
      registerUnit(req, { kind: 'knowledge', role: 'system', text: passage, seq: idx });
    });

    const history = makeConversation({ turns: 500, lang: 'vi', withToolCalls: false, seed: 2026 });
    expect(history).toHaveLength(1000);
    history.forEach((msg, idx) => {
      registerUnit(req, {
        kind: 'history',
        role: msg.role,
        text: msg.content,
        seq: idx + 1,
        messageId: idx + 1,
      });
    });

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a concise bilingual engineering assistant.' },
      { role: 'system', content: summaryText },
      { role: 'system', content: kbPassages[0]! },
      { role: 'system', content: kbPassages[1]! },
      ...history,
      { role: 'user', content: 'Hãy tóm tắt trạng thái hiện tại của hệ thống sau 500 lượt.' },
    ];

    for (let i = 0; i < 5; i++) {
      const segments = classifySegments(messages, reg);
      const warm = fitToBudget({
        messages,
        segments,
        policy,
        contextWindow: 131072,
        outputReserve: 1024,
        fallbackWindowTokens: 8192,
      });
      expect(warm.ok).toBe(true);
    }

    const durationsMs: number[] = [];
    let lastTotal = 0;
    let lastBudget = 0;
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const segments = classifySegments(messages, reg);
      const res = fitToBudget({
        messages,
        segments,
        policy,
        contextWindow: 131072,
        outputReserve: 1024,
        fallbackWindowTokens: 8192,
      });
      const elapsed = performance.now() - start;
      expect(res.ok).toBe(true);
      if (res.ok) {
        lastTotal = res.tokens.total;
        lastBudget = res.budget;
      }
      durationsMs.push(elapsed);
    }

    durationsMs.sort((a, b) => a - b);
    const p50 = percentile(durationsMs, 50);
    const p95 = percentile(durationsMs, 95);
    console.info(`[perf] 1000-msg server history x200: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms (tokens=${lastTotal}/${lastBudget})`);

    expect(lastTotal).toBeLessThanOrEqual(lastBudget);
    expect(p95).toBeLessThanOrEqual(50);
  });

  it('runs classifySegments + fitToBudget across 200 iterations on a 1,000+ message client history with tool calls with p95 <= 50 ms', () => {
    const policy = makePolicy({
      maxInputTokens: 16000,
      dropBlockTurns: 4,
      clientHistoryMode: 'enforce_budget',
    });
    const req = {} as Request;
    const reg = createRegistry(req, policy);

    const history = makeConversation({ turns: 420, lang: 'en', withToolCalls: true, seed: 77 });
    expect(history.length).toBeGreaterThanOrEqual(1000);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Follow tool-call ordering strictly.' },
      ...history,
      { role: 'user', content: 'Report final diagnostics.' },
    ];

    for (let i = 0; i < 5; i++) {
      const segments = classifySegments(messages, reg);
      const warm = fitToBudget({
        messages,
        segments,
        policy,
        contextWindow: 32768,
        outputReserve: 1024,
        fallbackWindowTokens: 8192,
      });
      expect(warm.ok).toBe(true);
    }

    const durationsMs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const segments = classifySegments(messages, reg);
      const res = fitToBudget({
        messages,
        segments,
        policy,
        contextWindow: 32768,
        outputReserve: 1024,
        fallbackWindowTokens: 8192,
      });
      const elapsed = performance.now() - start;
      expect(res.ok).toBe(true);
      durationsMs.push(elapsed);
    }

    durationsMs.sort((a, b) => a - b);
    const p50 = percentile(durationsMs, 50);
    const p95 = percentile(durationsMs, 95);
    console.info(`[perf] ${messages.length}-msg client history x200: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);

    expect(p95).toBeLessThanOrEqual(50);
  });
});
