import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_PRESETS,
  type ContextPolicy,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  computeFingerprint,
  createRegistry,
  getRegistry,
  registerUnit,
} from '../../../custom/context-budget/registry.js';
import { classifySegments } from '../../../custom/context-budget/segments.js';

function makePolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
  return {
    profileId: 1,
    enabled: true,
    inherited: false,
    preset: 'balanced',
    ...CONTEXT_PRESETS.balanced,
    updatedAt: '2026-11-17T00:00:00Z',
    ...overrides,
  };
}

function makeReq(): Request {
  return {} as Request;
}

describe('context-budget registry & segment classification', () => {
  it('initializes registry fields and computes NFC+trimmed 16-hex SHA-1 fingerprints', () => {
    const req = makeReq();
    expect(getRegistry(req)).toBeUndefined();
    expect(registerUnit(req, { kind: 'history', role: 'user', text: 'hello', seq: 1 })).toBeUndefined();

    const policy = makePolicy();
    const reg = createRegistry(req, policy);
    expect(getRegistry(req)).toBe(reg);
    expect(reg.policy).toBe(policy);
    expect(reg.units).toEqual([]);
    expect(reg.conversation).toBeNull();
    expect(reg.base).toBeNull();
    expect(reg.lastOutput).toBeNull();
    expect(reg.windowStartMessageId).toBeNull();
    expect(reg.report).toBeNull();
    expect(reg.fitted).toBe(false);
    expect(reg.clientMaxTokens).toBeNull();
    expect(reg.refits).toBe(0);
    expect(reg.trace).toBeNull();

    // NFC vs NFD and leading/trailing whitespace produce the same 16-char hex fingerprint
    const nfc = '  Tiếng Việt  ';
    const nfd = 'Ti\u00ea\u0301ng Vi\u00ea\u0323t';
    const fp1 = computeFingerprint(nfc);
    const fp2 = computeFingerprint(nfd);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/);
    expect(fp1).toBe(fp2);
  });

  it('marks unregistered system/developer messages as mandatory', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy());
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'developer', content: 'Follow policy X.' },
      { role: 'user', content: 'Hi' },
    ] as unknown as ChatMessage[];

    const segments = classifySegments(messages, reg);
    expect(segments).toHaveLength(3);
    for (const seg of segments) {
      expect(seg.kind).toBe('mandatory');
      expect(seg.droppable).toBe(false);
    }
    expect(segments.map((s) => s.indexes)).toEqual([[0], [1], [2]]);
  });

  it('marks the last user message and trailing assistant(tool_calls) + tool chain as mandatory', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy());
    // Even if an earlier registered history turn had the exact same text as the final user prompt,
    // the final user prompt must remain mandatory.
    registerUnit(req, { kind: 'history', role: 'user', text: 'Check status', seq: 10, messageId: 10 });

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Check status' },
      { role: 'assistant', content: 'Earlier reply' },
      { role: 'user', content: 'Check status' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_status', arguments: '{"id":1}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c1_b', content: '{"extra":1}' },
    ];

    const segments = classifySegments(messages, reg);
    expect(segments[0]).toMatchObject({ kind: 'mandatory', indexes: [0], droppable: false });
    expect(segments[1]).toMatchObject({ kind: 'history', indexes: [1], seq: 10, messageId: 10, droppable: true });
    expect(segments[2]).toMatchObject({ kind: 'client_history', indexes: [2], seq: 2 });

    // Last user message [3] and trailing tool-call chain [4, 5, 6] are mandatory
    const tail = segments.slice(3);
    expect(tail.every((s) => s.kind === 'mandatory' && s.droppable === false)).toBe(true);
    expect(tail.flatMap((s) => s.indexes)).toEqual([3, 4, 5, 6]);
    // The assistant(tool_calls) and its two tool messages stay in one segment
    expect(tail[1]?.indexes).toEqual([4, 5, 6]);
  });

  it('groups an earlier assistant(tool_calls) and all following tool results into a single segment', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy({ clientHistoryMode: 'enforce_budget' }));

    const messages: ChatMessage[] = [
      { role: 'user', content: 'Run tools' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 't2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'result 1' },
      { role: 'tool', tool_call_id: 't2', content: 'result 2' },
      { role: 'assistant', content: 'All done.' },
      { role: 'user', content: 'Thanks' },
    ];

    const segments = classifySegments(messages, reg);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ kind: 'client_history', indexes: [0], seq: 0, droppable: true });
    expect(segments[1]).toMatchObject({ kind: 'client_history', indexes: [1, 2, 3], seq: 1, droppable: true });
    expect(segments[2]).toMatchObject({ kind: 'client_history', indexes: [4], seq: 4, droppable: true });
    expect(segments[3]).toMatchObject({ kind: 'mandatory', indexes: [5], droppable: false });
  });

  it('matches registered summary, knowledge, and history units by (role, fingerprint) and preserves seq', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy());
    const summaryText = 'Summary of the earlier part of this conversation:\nUser likes coffee.';
    const kbText = 'Relevant reference material:\nEspresso uses 9 bar pressure.';

    registerUnit(req, { kind: 'summary', role: 'system', text: summaryText, seq: 0 });
    registerUnit(req, { kind: 'knowledge', role: 'system', text: kbText, seq: 1 });
    registerUnit(req, { kind: 'history', role: 'user', text: 'First question', seq: 101, messageId: 101 });
    registerUnit(req, { kind: 'history', role: 'assistant', text: 'First answer', seq: 102, messageId: 102 });
    registerUnit(req, { kind: 'history', role: 'user', text: 'First question', seq: 103, messageId: 103 });

    const messages: ChatMessage[] = [
      { role: 'system', content: 'App prompt.' },
      { role: 'system', content: `  ${summaryText}  ` },
      { role: 'system', content: kbText },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'First question' },
      { role: 'user', content: 'New prompt' },
    ];

    const segments = classifySegments(messages, reg);
    expect(segments.map((s) => ({ kind: s.kind, indexes: s.indexes, seq: s.seq, messageId: s.messageId, droppable: s.droppable }))).toEqual([
      { kind: 'mandatory', indexes: [0], seq: 0, messageId: undefined, droppable: false },
      { kind: 'summary', indexes: [1], seq: 0, messageId: undefined, droppable: true },
      { kind: 'knowledge', indexes: [2], seq: 1, messageId: undefined, droppable: true },
      { kind: 'history', indexes: [3], seq: 101, messageId: 101, droppable: true },
      { kind: 'history', indexes: [4], seq: 102, messageId: 102, droppable: true },
      { kind: 'history', indexes: [5], seq: 103, messageId: 103, droppable: true },
      { kind: 'mandatory', indexes: [6], seq: 6, messageId: undefined, droppable: false },
    ]);
  });

  it('splits Anthropic embedded summary and knowledge substrings inside the first system message with indexes and charRange', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy());
    const appPrompt = 'You are an expert coding assistant.';
    const summaryText = 'Summary of the earlier part of this conversation:\nBuilt the parser.';
    const kbText = 'Relevant reference material:\nUse UTF-8 encoding.';

    registerUnit(req, { kind: 'summary', role: 'system', text: summaryText, seq: 0 });
    registerUnit(req, { kind: 'knowledge', role: 'system', text: kbText, seq: 1 });
    registerUnit(req, { kind: 'history', role: 'user', text: 'Turn 1', seq: 42, messageId: 42 });

    const combinedSystem = `${appPrompt}\n\n${summaryText}\n\n${kbText}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: combinedSystem },
      { role: 'user', content: 'Turn 1' },
      { role: 'user', content: 'Latest question' },
    ];

    const segments = classifySegments(messages, reg);
    expect(segments).toHaveLength(5);

    expect(segments[0]).toMatchObject({
      kind: 'mandatory',
      indexes: [0],
      droppable: false,
      charRange: { start: 0, end: appPrompt.length },
    });
    expect(combinedSystem.slice(segments[0]!.charRange!.start, segments[0]!.charRange!.end)).toBe(appPrompt);

    const sumStart = combinedSystem.indexOf(summaryText);
    expect(segments[1]).toMatchObject({
      kind: 'summary',
      indexes: [0],
      seq: 0,
      droppable: true,
      charRange: { start: sumStart, end: sumStart + summaryText.length },
    });
    expect(combinedSystem.slice(segments[1]!.charRange!.start, segments[1]!.charRange!.end)).toBe(summaryText);

    const kbStart = combinedSystem.indexOf(kbText);
    expect(segments[2]).toMatchObject({
      kind: 'knowledge',
      indexes: [0],
      seq: 1,
      droppable: true,
      charRange: { start: kbStart, end: kbStart + kbText.length },
    });
    expect(combinedSystem.slice(segments[2]!.charRange!.start, segments[2]!.charRange!.end)).toBe(kbText);

    expect(segments[3]).toMatchObject({ kind: 'history', indexes: [1], seq: 42, messageId: 42, droppable: true });
    expect(segments[4]).toMatchObject({ kind: 'mandatory', indexes: [2], droppable: false });
  });

  it('classifies unmatched non-mandatory messages as client_history with seq = original index and respects clientHistoryMode droppable flag', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Old user msg' },
      { role: 'assistant', content: 'Old assistant msg' },
      { role: 'user', content: 'New user msg' },
    ];

    const reqPass = makeReq();
    const regPass = createRegistry(reqPass, makePolicy({ clientHistoryMode: 'passthrough' }));
    const segPass = classifySegments(messages, regPass);
    expect(segPass[0]).toMatchObject({ kind: 'client_history', indexes: [0], seq: 0, droppable: false });
    expect(segPass[1]).toMatchObject({ kind: 'client_history', indexes: [1], seq: 1, droppable: false });
    expect(segPass[2]).toMatchObject({ kind: 'mandatory', indexes: [2], droppable: false });

    const reqTrim = makeReq();
    const regTrim = createRegistry(reqTrim, makePolicy({ clientHistoryMode: 'trim_on_overflow' }));
    const segTrim = classifySegments(messages, regTrim);
    expect(segTrim[0]).toMatchObject({ kind: 'client_history', indexes: [0], seq: 0, droppable: true });
    expect(segTrim[1]).toMatchObject({ kind: 'client_history', indexes: [1], seq: 1, droppable: true });
    expect(segTrim[2]).toMatchObject({ kind: 'mandatory', indexes: [2], droppable: false });
  });
});
