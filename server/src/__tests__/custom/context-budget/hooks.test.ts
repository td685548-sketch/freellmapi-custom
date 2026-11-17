import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_PRESETS,
  type ContextPolicy,
} from '@freellmapi/shared/context-budget.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  createRegistry,
  registerUnit,
} from '../../../custom/context-budget/registry.js';
import {
  contextRoutingTokens,
  fitContextForRoute,
} from '../../../custom/context-budget/hooks.js';

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

function makeRes(headersSent = false) {
  const headers = new Map<string, string>();
  const res = {
    headersSent,
    setHeader: vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), String(value));
    }),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    removeHeader: vi.fn((name: string) => {
      headers.delete(name.toLowerCase());
    }),
  };
  return { res: res as unknown as Response, headers, setHeader: res.setHeader };
}

function buildConversation(
  req: Request,
  turns: number,
  charsPerMsg = 400,
): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'System instruction.' }];
  for (let i = 0; i < turns; i++) {
    const userId = i * 2 + 1;
    const asstId = i * 2 + 2;
    const uText = `U${i}: ` + 'u'.repeat(charsPerMsg - `U${i}: `.length);
    const aText = `A${i}: ` + 'a'.repeat(charsPerMsg - `A${i}: `.length);
    registerUnit(req, { kind: 'history', role: 'user', text: uText, seq: userId, messageId: userId });
    registerUnit(req, { kind: 'history', role: 'assistant', text: aText, seq: asstId, messageId: asstId });
    msgs.push({ role: 'user', content: uText });
    msgs.push({ role: 'assistant', content: aText });
  }
  msgs.push({ role: 'user', content: 'Current question?' });
  return msgs;
}

describe('context-budget hooks', () => {
  it('acts as a strict no-op when registry is absent or policy is disabled', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'Hello' },
    ];
    const { res, setHeader } = makeRes();

    // No registry
    const reqNoReg = makeReq();
    expect(contextRoutingTokens(reqNoReg, 1234, messages)).toBe(1234);
    expect(fitContextForRoute(reqNoReg, res, messages, { contextWindow: 8192 }, 1024)).toBe(messages);

    // Disabled policy
    const reqOff = makeReq();
    createRegistry(reqOff, makePolicy({ enabled: false }));
    expect(contextRoutingTokens(reqOff, 1234, messages)).toBe(1234);
    expect(fitContextForRoute(reqOff, res, messages, { contextWindow: 8192 }, 1024)).toBe(messages);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it('subtracts droppable chars/4 tokens in contextRoutingTokens and uses base on fallback', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy({ enabled: true, maxInputTokens: 16000 }));
    const messages = buildConversation(req, 10, 400); // 20 history messages * 100 chars/4 tokens = 2000

    const routingTotal = 2100;
    const reduced = contextRoutingTokens(req, routingTotal, messages);
    expect(reduced).toBe(100);

    // Simulate route 1 fitting into a small window so `messages` becomes `registry.lastOutput`
    const { res } = makeRes();
    const fittedSmall = fitContextForRoute(req, res, messages, { contextWindow: 2500 }, 500);
    expect(fittedSmall.length).toBeLessThan(messages.length);
    expect(reg.lastOutput).toBe(fittedSmall);

    // On fallback attempt 2 (e.g. anthropic/responses), route() passes `fittedSmall` === `lastOutput`:
    // contextRoutingTokens must still measure droppable tokens from `registry.base`.
    expect(contextRoutingTokens(req, routingTotal, fittedSmall)).toBe(100);
  });

  it('re-fits from base when called again with lastOutput, and resets base when given a new array', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy({ enabled: true, maxInputTokens: 32000 }));
    const messages = buildConversation(req, 12, 400);
    const { res } = makeRes();

    expect(reg.fitted).toBe(false);
    expect(reg.refits).toBe(0);

    // Route 1: small window (3000) drops older turns
    const smallOut = fitContextForRoute(req, res, messages, { contextWindow: 3000 }, 500);
    expect(reg.fitted).toBe(true);
    expect(reg.refits).toBe(0);
    expect(smallOut.length).toBeLessThan(messages.length);

    // Route 2: large window (32000) receives `smallOut` (=== lastOutput) and recovers all history from `base`
    const largeOut = fitContextForRoute(req, res, smallOut, { contextWindow: 32000 }, 500);
    expect(reg.refits).toBe(1);
    expect(largeOut.length).toBe(messages.length);

    // Route 3: called with a brand-new message array (e.g. proxy handoff/reasoning restore) -> becomes new base
    const newBase: ChatMessage[] = [
      { role: 'system', content: 'Handoff system prompt' },
      { role: 'user', content: 'Fresh message' },
    ];
    const newOut = fitContextForRoute(req, res, newBase, { contextWindow: 32000 }, 500);
    expect(reg.refits).toBe(2);
    expect(reg.base).toEqual(newBase);
    expect(newOut).toEqual(newBase);
  });

  it('throws providerRejection=request when mandatory context exceeds the route window without flipping fitted', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy({ enabled: true, outputReserveTokens: 1024, safetyMarginPct: 10 }));
    const bigMandatory: ChatMessage[] = [
      { role: 'system', content: 'a'.repeat(16000) }, // ~4004 tokens
      { role: 'user', content: 'hi' },
    ];
    const { res } = makeRes();

    let caught: unknown;
    try {
      fitContextForRoute(req, res, bigMandatory, { contextWindow: 4096 }, 1024);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("exceeds this model's context window");
    expect((caught as { providerRejection?: string }).providerRejection).toBe('request');
    expect(reg.fitted).toBe(false);
    expect(reg.refits).toBe(0);
  });

  it('uses surface outputReserve when clientMaxTokens is set, and policy.outputReserveTokens when null (FR-007)', () => {
    // Window = 4000, safetyMarginPct = 10%, mandatory ~= 2500 tokens.
    // With reserve = 500:  floor((4000 - 500) * 0.9) = 3150 -> fits!
    // With reserve = 2000: floor((4000 - 2000) * 0.9) = 1800 -> mandatory exceeds!
    const messages: ChatMessage[] = [
      { role: 'system', content: 'a'.repeat(9600) }, // ~2404 tokens
      { role: 'user', content: 'go' }, // ~5 tokens
    ];

    // clientMaxTokens !== null -> uses surface `outputReserve` (500), ignoring policy.outputReserveTokens (2000)
    const reqWithClientMax = makeReq();
    createRegistry(
      reqWithClientMax,
      makePolicy({ enabled: true, outputReserveTokens: 2000, maxInputTokens: 16000 }),
      { clientMaxTokens: 500 },
    );
    const { res: res1 } = makeRes();
    expect(() => fitContextForRoute(reqWithClientMax, res1, messages, { contextWindow: 4000 }, 500)).not.toThrow();

    // clientMaxTokens === null -> uses policy.outputReserveTokens (2000), ignoring surface `outputReserve` (500)
    const reqWithoutClientMax = makeReq();
    createRegistry(
      reqWithoutClientMax,
      makePolicy({ enabled: true, outputReserveTokens: 2000, maxInputTokens: 16000 }),
      { clientMaxTokens: null },
    );
    const { res: res2 } = makeRes();
    expect(() => fitContextForRoute(reqWithoutClientMax, res2, messages, { contextWindow: 4000 }, 500)).toThrow(
      /exceeds this model's context window/,
    );
  });

  it('sets X-Conversation-History and windowStartMessageId when server conversation is active and headers not sent', () => {
    const req = makeReq();
    const reg = createRegistry(req, makePolicy({ enabled: true, maxInputTokens: 2500 }));
    reg.conversation = { id: 7, key: 'conv-7', endUser: 'user-a' };
    const messages = buildConversation(req, 15, 400);

    const { res, headers } = makeRes(false);
    fitContextForRoute(req, res, messages, { contextWindow: 8192 }, 500);

    expect(reg.windowStartMessageId).toBeGreaterThan(1);
    expect(headers.get('x-conversation-history')).toBeDefined();
    const sentCount = Number(headers.get('x-conversation-history'));
    expect(sentCount).toBeGreaterThan(0);
    expect(sentCount).toBeLessThan(30);

    // Does not attempt to set header when headersSent is already true
    const req2 = makeReq();
    const reg2 = createRegistry(req2, makePolicy({ enabled: true, maxInputTokens: 2500 }));
    reg2.conversation = { id: 8, key: 'conv-8', endUser: null };
    const messages2 = buildConversation(req2, 4, 400);
    const { res: sentRes, setHeader } = makeRes(true);
    fitContextForRoute(req2, sentRes, messages2, { contextWindow: 8192 }, 500);
    expect(setHeader).not.toHaveBeenCalled();

    // Does not set X-Conversation-History when registry.conversation is null
    const req3 = makeReq();
    createRegistry(req3, makePolicy({ enabled: true, maxInputTokens: 16000 }));
    const { res: noConvRes, setHeader: setHeader3 } = makeRes(false);
    fitContextForRoute(req3, noConvRes, [{ role: 'user', content: 'hi' }], { contextWindow: 8192 }, 500);
    expect(setHeader3).not.toHaveBeenCalled();
  });
});
