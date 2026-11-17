import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRESETS,
  type ContextPolicy,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { estimateMessageTokens, estimateTextTokens } from '../../../custom/context-budget/estimate.js';
import { fitToBudget } from '../../../custom/context-budget/fit.js';
import type { ContextSegment } from '../../../custom/context-budget/segments.js';

function makePolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    profileId: 1,
    enabled: true,
    inherited: false,
    preset: 'custom',
    ...CONTEXT_PRESETS.balanced,
    updatedAt: '2026-11-17T00:00:00Z',
    ...overrides,
  };
}

function makeSimpleSegments(
  messages: readonly ChatMessage[],
  opts: {
    summaryIndex?: number;
    knowledgeIndex?: number;
    historyRange?: [number, number];
    clientDroppable?: boolean;
    startMessageId?: number;
  } = {},
): ContextSegment[] {
  const segments: ContextSegment[] = [];
  let nextMsgId = opts.startMessageId ?? 100;
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i]!;
    if (i >= lastUserIdx && lastUserIdx >= 0) {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        const idxs = [i];
        let j = i + 1;
        while (j < messages.length && messages[j]!.role === 'tool') idxs.push(j++);
        segments.push({
          kind: 'mandatory',
          indexes: idxs,
          tokens: idxs.reduce((s, idx) => s + estimateMessageTokens(messages[idx]!), 0),
          seq: i,
          droppable: false,
        });
        i = j;
        continue;
      }
      segments.push({
        kind: 'mandatory',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: i,
        droppable: false,
      });
      i++;
      continue;
    }

    if (i === opts.summaryIndex) {
      segments.push({
        kind: 'summary',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: 0,
        droppable: true,
      });
      i++;
      continue;
    }

    if (i === opts.knowledgeIndex) {
      segments.push({
        kind: 'knowledge',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: 1,
        droppable: true,
      });
      i++;
      continue;
    }

    if (msg.role === 'system') {
      segments.push({
        kind: 'mandatory',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: i,
        droppable: false,
      });
      i++;
      continue;
    }

    const inHistory =
      opts.historyRange !== undefined &&
      i >= opts.historyRange[0] &&
      i <= opts.historyRange[1];

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const idxs = [i];
      let j = i + 1;
      while (j < lastUserIdx && messages[j]!.role === 'tool') idxs.push(j++);
      const tokens = idxs.reduce((s, idx) => s + estimateMessageTokens(messages[idx]!), 0);
      if (inHistory) {
        const messageId = nextMsgId++;
        segments.push({
          kind: 'history',
          indexes: idxs,
          tokens,
          seq: messageId,
          messageId,
          droppable: true,
        });
      } else {
        segments.push({
          kind: 'client_history',
          indexes: idxs,
          tokens,
          seq: i,
          droppable: opts.clientDroppable ?? false,
        });
      }
      i = j;
      continue;
    }

    if (inHistory) {
      const messageId = nextMsgId++;
      segments.push({
        kind: 'history',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: messageId,
        messageId,
        droppable: true,
      });
    } else {
      segments.push({
        kind: 'client_history',
        indexes: [i],
        tokens: estimateMessageTokens(msg),
        seq: i,
        droppable: opts.clientDroppable ?? false,
      });
    }
    i++;
  }

  return segments;
}

describe('fitToBudget (pure context budget fitting)', () => {
  it('computes effectiveBudget correctly across window, maxInputTokens, and fallbackWindowTokens', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Hello' },
    ];
    const segments = makeSimpleSegments(messages);

    // (8000 - 1000) * (1 - 0.10) = 6300 < 32000
    const r1 = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: 32000, safetyMarginPct: 10 }),
      contextWindow: 8000,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(r1.ok).toBe(true);
    expect(r1.budget).toBe(6300);

    // Safety margin is NOT subtracted from maxInputTokens when maxInputTokens is smaller
    const r2 = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: 4000, safetyMarginPct: 10 }),
      contextWindow: 32000,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(r2.ok).toBe(true);
    expect(r2.budget).toBe(4000);

    // contextWindow null uses maxInputTokens when set
    const r3 = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: 5500, safetyMarginPct: 10 }),
      contextWindow: null,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });
    expect(r3.ok).toBe(true);
    expect(r3.budget).toBe(5500);

    // Both contextWindow and maxInputTokens null -> fallbackWindowTokens: floor((8192 - 1024) * 0.9) = 6451
    const r4 = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: null, safetyMarginPct: 10 }),
      contextWindow: null,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });
    expect(r4.ok).toBe(true);
    expect(r4.budget).toBe(6451);
  });

  it('drops in order: oldest history -> knowledge block -> summary (sentence trim then full drop)', () => {
    const sys: ChatMessage = { role: 'system', content: 'Sys.' };
    const summaryText =
      'Summary of the earlier part of this conversation:\n' +
      'First fact is alpha. '.repeat(3) +
      'Second fact is beta. '.repeat(3) +
      'Third fact is gamma. '.repeat(3);
    const summaryMsg: ChatMessage = { role: 'system', content: summaryText };
    const kbMsg: ChatMessage = {
      role: 'system',
      content: 'Relevant reference material:\n' + 'Reference sentence about caching. '.repeat(4),
    };
    const h1User: ChatMessage = { role: 'user', content: 'Old user turn. '.repeat(12) };
    const h1Asst: ChatMessage = { role: 'assistant', content: 'Old assistant turn. '.repeat(12) };
    const finalUser: ChatMessage = { role: 'user', content: 'Latest question?' };

    const messages = [sys, summaryMsg, kbMsg, h1User, h1Asst, finalUser];
    const segments = makeSimpleSegments(messages, {
      summaryIndex: 1,
      knowledgeIndex: 2,
      historyRange: [3, 4],
      startMessageId: 50,
    });

    const mandatoryTokens = segments[0]!.tokens + segments[5]!.tokens;
    const summaryTokens = segments[1]!.tokens;
    const kbTokens = segments[2]!.tokens;

    // Case A: budget allows summary (within cap) + knowledge (within cap), but NOT history -> history dropped, summary & kb kept
    const resA = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: mandatoryTokens + summaryTokens + kbTokens + 20,
        summarySharePct: 60,
        knowledgeSharePct: 40,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });
    expect(resA.ok).toBe(true);
    if (!resA.ok) return;
    expect(resA.counts.historyDropped).toBe(2);
    expect(resA.knowledgeDropped).toBe(false);
    expect(resA.counts.summaryUsed).toBe(true);
    expect(resA.counts.summaryDropped).toBe(false);
    expect(resA.windowStartMessageId).toBeNull();

    // Case B: tighter budget drops history + knowledge block, trims summary at sentence boundary
    const partialSummaryBudget = mandatoryTokens + Math.floor(summaryTokens * 0.65);
    const resB = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: partialSummaryBudget,
        summarySharePct: 100,
        knowledgeSharePct: 0,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });
    expect(resB.ok).toBe(true);
    if (!resB.ok) return;
    expect(resB.counts.historyDropped).toBe(2);
    expect(resB.knowledgeDropped).toBe(true);
    expect(resB.counts.knowledgeDropped).toBe(1);
    expect(resB.counts.summaryUsed).toBe(true);
    expect(resB.counts.summaryTrimmed).toBe(true);
    expect(resB.tokens.summary).toBeLessThan(summaryTokens);
    expect(resB.tokens.total).toBeLessThanOrEqual(partialSummaryBudget);
    const trimmedSummaryContent = String(resB.messages[1]!.content);
    expect(trimmedSummaryContent.endsWith('.')).toBe(true);

    // Case C: ultra-tight budget (only mandatory + 5 tokens) drops summary completely too
    const resC = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: mandatoryTokens + 5,
        summarySharePct: 15,
        knowledgeSharePct: 25,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });
    expect(resC.ok).toBe(true);
    if (!resC.ok) return;
    expect(resC.counts.summaryUsed).toBe(false);
    expect(resC.counts.summaryDropped).toBe(true);
    expect(resC.messages).toEqual([sys, finalUser]);
  });

  it('handles Anthropic charRange embedded summary and knowledge inside the first system message', () => {
    const appPrompt = 'You are an expert assistant.';
    const summaryText = 'Summary of earlier chat:\nUser name is Linh. She prefers concise answers. '.repeat(3).trim();
    const kbText = 'Knowledge snippet:\nUse UTF-8 everywhere for Vietnamese text.';
    const combinedSystem = `${appPrompt}\n\n${summaryText}\n\n${kbText}`;

    const messages: ChatMessage[] = [
      { role: 'system', content: combinedSystem },
      { role: 'user', content: 'Question now?' },
    ];

    const appStart = 0;
    const sumStart = combinedSystem.indexOf(summaryText);
    const kbStart = combinedSystem.indexOf(kbText);

    const segments: ContextSegment[] = [
      {
        kind: 'mandatory',
        indexes: [0],
        tokens: 4 + estimateTextTokens(appPrompt),
        seq: 0,
        droppable: false,
        charRange: { start: appStart, end: appPrompt.length },
      },
      {
        kind: 'summary',
        indexes: [0],
        tokens: estimateTextTokens(summaryText),
        seq: 0,
        droppable: true,
        charRange: { start: sumStart, end: sumStart + summaryText.length },
      },
      {
        kind: 'knowledge',
        indexes: [0],
        tokens: estimateTextTokens(kbText),
        seq: 1,
        droppable: true,
        charRange: { start: kbStart, end: kbStart + kbText.length },
      },
      {
        kind: 'mandatory',
        indexes: [1],
        tokens: estimateMessageTokens(messages[1]!),
        seq: 1,
        droppable: false,
      },
    ];

    const mandatoryTokens = segments[0]!.tokens + segments[3]!.tokens;
    const budget = mandatoryTokens + Math.floor(segments[1]!.tokens * 0.65);

    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: budget,
        summarySharePct: 100,
        knowledgeSharePct: 0,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.knowledgeDropped).toBe(true);
    expect(res.counts.summaryTrimmed).toBe(true);
    expect(res.messages).toHaveLength(2);
    const rebuiltSys = String(res.messages[0]!.content);
    expect(rebuiltSys.startsWith(appPrompt)).toBe(true);
    expect(rebuiltSys).not.toContain(kbText);
    expect(rebuiltSys).toContain('User name is Linh.');
    expect(rebuiltSys.length).toBeLessThan(combinedSystem.length);
  });

  it('never drops mandatory segments and returns mandatory_exceeds when mandatory > budget', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Critical system instructions '.repeat(40) },
      { role: 'user', content: 'Huge user message '.repeat(40) },
    ];
    const segments = makeSimpleSegments(messages);
    const mandatoryTokens = segments.reduce((s, seg) => s + seg.tokens, 0);

    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: mandatoryTokens - 10 }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(res).toEqual({
      ok: false,
      reason: 'mandatory_exceeds',
      mandatoryTokens,
      budget: mandatoryTokens - 10,
    });
  });

  it('enforces summary/knowledge share caps and reallocates unused share to history', () => {
    const sys: ChatMessage = { role: 'system', content: 'Sys.' };
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: 'Short summary note.',
    };
    const bigKbMsg: ChatMessage = {
      role: 'system',
      content: 'Large knowledge block '.repeat(60),
    };
    const turns: ChatMessage[] = [];
    for (let i = 0; i < 16; i++) {
      turns.push({ role: 'user', content: `Turn ${i} user question `.repeat(5) });
      turns.push({ role: 'assistant', content: `Turn ${i} assistant reply `.repeat(5) });
    }
    const finalUser: ChatMessage = { role: 'user', content: 'Final question' };

    const messages = [sys, summaryMsg, bigKbMsg, ...turns, finalUser];
    const segments = makeSimpleSegments(messages, {
      summaryIndex: 1,
      knowledgeIndex: 2,
      historyRange: [3, 34],
    });

    const mandatoryTokens = segments[0]!.tokens + segments[segments.length - 1]!.tokens;
    const budget = mandatoryTokens + 1000;

    // summarySharePct=15 -> summaryCap=150; knowledgeSharePct=10 -> knowledgeCap=100
    // bigKbMsg >> 100 -> dropped; summary (~9 tokens) << 150 -> unused summary + unused kb go to history!
    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: budget,
        summarySharePct: 15,
        knowledgeSharePct: 10,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.caps.summary).toBe(150);
    expect(res.caps.knowledge).toBe(100);
    expect(res.knowledgeDropped).toBe(true);
    expect(res.tokens.knowledge).toBe(0);
    // History gets > 750 tokens because unused summary & knowledge caps flowed to history
    expect(res.caps.history).toBeGreaterThan(750);
    expect(res.tokens.history).toBeGreaterThan(750);
    expect(res.tokens.total).toBeLessThanOrEqual(budget);
  });

  it('drops history in block-aligned dropBlockTurns chunks so window start stays stable across 3+ consecutive turns before jumping by 4', () => {
    const sys: ChatMessage = { role: 'system', content: 'Sys.' };
    const finalUser: ChatMessage = { role: 'user', content: 'Latest prompt' };
    const turnUser: ChatMessage = { role: 'user', content: 'Turn 10: ' + 'User turn text '.repeat(6) };
    const turnAsst: ChatMessage = { role: 'assistant', content: 'Reply 10: ' + 'Assistant turn text '.repeat(6) };
    const turnTokens = estimateMessageTokens(turnUser) + estimateMessageTokens(turnAsst);
    const mandatoryTokens = estimateMessageTokens(sys) + estimateMessageTokens(finalUser);

    // Budget comfortably holds 6 turns of history, overflows on 7th
    const budget = mandatoryTokens + turnTokens * 6 + 10;
    const policy = makePolicy({
      maxInputTokens: budget,
      dropBlockTurns: 4,
      summarySharePct: 0,
      knowledgeSharePct: 0,
    });

    const starts: Array<number | null> = [];
    for (let totalTurns = 7; totalTurns <= 13; totalTurns++) {
      const historyMsgs: ChatMessage[] = [];
      for (let t = 0; t < totalTurns; t++) {
        historyMsgs.push({ role: 'user', content: `Turn ${t}: ` + 'User turn text '.repeat(6) });
        historyMsgs.push({ role: 'assistant', content: `Reply ${t}: ` + 'Assistant turn text '.repeat(6) });
      }
      const messages = [sys, ...historyMsgs, finalUser];
      const segments = makeSimpleSegments(messages, {
        historyRange: [1, historyMsgs.length],
        startMessageId: 1000,
      });

      const res = fitToBudget({
        messages,
        segments,
        policy,
        contextWindow: 100_000,
        outputReserve: 1024,
        fallbackWindowTokens: 8192,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      starts.push(res.windowStartMessageId);
    }

    // Turns 7, 8, 9, 10 all start at Turn 4 (messageId 1008); Turn 11 jumps by 4 turns (8 messages) to Turn 8 (messageId 1016)
    expect(starts[0]).toBe(1008);
    expect(starts[1]).toBe(1008);
    expect(starts[2]).toBe(1008);
    expect(starts[3]).toBe(1008);
    expect(starts[4]).toBe(1016);
    expect(starts[5]).toBe(1016);
    expect(starts[6]).toBe(1016);
  });

  it('drops leading assistant messages after trimming so history always begins with a user turn', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys.' },
      { role: 'assistant', content: 'Orphan leading assistant turn' },
      { role: 'user', content: 'First real user turn' },
      { role: 'assistant', content: 'First real assistant turn' },
      { role: 'user', content: 'Current question' },
    ];
    const segments = makeSimpleSegments(messages, {
      historyRange: [1, 3],
      startMessageId: 200,
    });

    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: 16000, dropBlockTurns: 4 }),
      contextWindow: 32000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(res.windowStartMessageId).toBe(201);
    expect(res.counts.historyDropped).toBe(1);
    expect(res.counts.historySent).toBe(2);
  });

  it('never splits an assistant tool_calls + tool result segment', () => {
    const toolAssistant: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }],
    };
    const toolResult: ChatMessage = { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' };

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys.' },
      { role: 'user', content: 'Run lookup 1 ' + 'pad '.repeat(12) },
      toolAssistant,
      toolResult,
      { role: 'assistant', content: 'Lookup 1 done ' + 'pad '.repeat(12) },
      { role: 'user', content: 'Run lookup 2' },
      { role: 'assistant', content: 'Lookup 2 done' },
      { role: 'user', content: 'Final question' },
    ];

    const segments = makeSimpleSegments(messages, {
      clientDroppable: true,
    });

    const turn2Tokens = segments[3]!.tokens + segments[4]!.tokens;
    const mandatoryTokens = segments[0]!.tokens + segments[5]!.tokens;

    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({
        maxInputTokens: mandatoryTokens + turn2Tokens + 5,
        clientHistoryMode: 'enforce_budget',
        summarySharePct: 0,
        knowledgeSharePct: 0,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The whole first turn (including assistant tool_calls + tool result + final assistant) was dropped atomically
    expect(res.messages.some((m) => m.role === 'tool')).toBe(false);
    expect(res.messages.some((m) => Boolean(m.tool_calls?.length))).toBe(false);
    expect(res.messages.map((m) => m.content)).toEqual([
      'Sys.',
      'Run lookup 2',
      'Lookup 2 done',
      'Final question',
    ]);
  });

  it('handles clientHistoryMode passthrough (with FR-009 exception), trim_on_overflow, and enforce_budget', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys.' },
      { role: 'system', content: 'Gateway summary note. '.repeat(15) },
      { role: 'user', content: 'Client old user '.repeat(25) },
      { role: 'assistant', content: 'Client old assistant '.repeat(25) },
      { role: 'user', content: 'Client recent user '.repeat(25) },
      { role: 'assistant', content: 'Client recent assistant '.repeat(25) },
      { role: 'user', content: 'New prompt' },
    ];

    // 1. passthrough: pinned client history exceeds maxInputTokens (400), fits window (10000) -> drops gateway summary, returns ok
    const segPass = makeSimpleSegments(messages, { summaryIndex: 1, clientDroppable: false });
    const resPass = fitToBudget({
      messages,
      segments: segPass,
      policy: makePolicy({
        maxInputTokens: 400,
        clientHistoryMode: 'passthrough',
        summarySharePct: 15,
        knowledgeSharePct: 25,
      }),
      contextWindow: 10_000,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(resPass.ok).toBe(true);
    if (!resPass.ok) return;
    expect(resPass.counts.clientHistoryDropped).toBe(0);
    expect(resPass.counts.summaryDropped).toBe(true);
    expect(resPass.messages).toHaveLength(6); // Sys + 4 client history + New prompt

    // 1b. passthrough exceeding model window returns mandatory_exceeds
    const resPassTooBig = fitToBudget({
      messages,
      segments: segPass,
      policy: makePolicy({
        maxInputTokens: 400,
        clientHistoryMode: 'passthrough',
      }),
      contextWindow: 1200,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(resPassTooBig.ok).toBe(false);
    if (!resPassTooBig.ok) {
      expect(resPassTooBig.reason).toBe('mandatory_exceeds');
    }

    // 2. trim_on_overflow: ignores maxInputTokens (e.g. 250), fits against model window instead
    const segTrim = makeSimpleSegments(messages, { summaryIndex: 1, clientDroppable: true });
    const resTrim = fitToBudget({
      messages,
      segments: segTrim,
      policy: makePolicy({
        maxInputTokens: 250,
        clientHistoryMode: 'trim_on_overflow',
        dropBlockTurns: 1,
      }),
      contextWindow: 10_000,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(resTrim.ok).toBe(true);
    if (!resTrim.ok) return;
    expect(resTrim.budget).toBe(8100); // floor((10000 - 1000) * 0.9)
    expect(resTrim.counts.clientHistoryDropped).toBe(0);

    // When trim_on_overflow exceeds model window, drops oldest client_history
    const totalTokens = segTrim.reduce((s, x) => s + x.tokens, 0);
    const tightWindow = Math.floor((totalTokens - 100) / 0.9) + 1000;
    const resTrimTight = fitToBudget({
      messages,
      segments: segTrim,
      policy: makePolicy({
        maxInputTokens: 250,
        clientHistoryMode: 'trim_on_overflow',
        dropBlockTurns: 1,
        summarySharePct: 50,
      }),
      contextWindow: tightWindow,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(resTrimTight.ok).toBe(true);
    if (!resTrimTight.ok) return;
    expect(resTrimTight.counts.clientHistoryDropped).toBeGreaterThan(0);

    // 3. enforce_budget: enforces maxInputTokens on client_history
    const mandatoryAndOneTurn = segTrim[0]!.tokens + segTrim[4]!.tokens + segTrim[5]!.tokens + segTrim[6]!.tokens;
    const resEnforce = fitToBudget({
      messages,
      segments: segTrim,
      policy: makePolicy({
        maxInputTokens: mandatoryAndOneTurn + 10,
        clientHistoryMode: 'enforce_budget',
        summarySharePct: 0,
        knowledgeSharePct: 0,
        dropBlockTurns: 1,
      }),
      contextWindow: 100_000,
      outputReserve: 1000,
      fallbackWindowTokens: 8192,
    });
    expect(resEnforce.ok).toBe(true);
    if (!resEnforce.ok) return;
    expect(resEnforce.budget).toBe(mandatoryAndOneTurn + 10);
    expect(resEnforce.tokens.total).toBeLessThanOrEqual(resEnforce.budget);
    expect(resEnforce.counts.clientHistoryDropped).toBe(2);
    expect(resEnforce.counts.clientHistorySent).toBe(2);
  });

  it('does not mutate input messages and reports full per-kind counts and tokens', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys.' },
      { role: 'user', content: 'H1 user' },
      { role: 'assistant', content: 'H1 assistant' },
      { role: 'user', content: 'Latest user' },
    ];
    const snapshot = JSON.stringify(messages);
    const segments = makeSimpleSegments(messages, {
      historyRange: [1, 2],
      startMessageId: 42,
    });

    const res = fitToBudget({
      messages,
      segments,
      policy: makePolicy({ maxInputTokens: 16000 }),
      contextWindow: 32000,
      outputReserve: 1024,
      fallbackWindowTokens: 8192,
    });

    expect(JSON.stringify(messages)).toBe(snapshot);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.messages).not.toBe(messages);
    expect(res.windowStartMessageId).toBe(42);
    expect(res.knowledgeDropped).toBe(false);
    expect(res.counts).toMatchObject({
      historySent: 2,
      historyDropped: 0,
      knowledgeSent: 0,
      knowledgeDropped: 0,
      clientHistorySent: 0,
      clientHistoryDropped: 0,
      summaryUsed: false,
    });
    expect(res.tokens.total).toBe(
      res.tokens.mandatory +
        res.tokens.summary +
        res.tokens.knowledge +
        res.tokens.history +
        res.tokens.clientHistory,
    );
  });
});
