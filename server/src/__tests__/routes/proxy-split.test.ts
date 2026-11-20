import { describe, it, expect } from 'vitest';
import { proxyRouter } from '../../routes/proxy.js';
import { chatCompletionsRouter, handleChatCompletions } from '../../routes/chat-completions.js';
import { completionsRouter, handleLegacyCompletions } from '../../routes/completions.js';
import { resolveChatRoute } from '../../routes/chat-route.js';
import {
  clearReasoningMemory,
  completionReasoningText,
  extractApiToken,
  getRequestGroupId,
  getStickyModel,
  providerSafeStop,
  sessionIdentityMessages,
  setStickyModel,
  streamChunkText,
  streamReasoningText,
  traceRouteEvent,
} from '../../routes/proxy.js';

// Structural pin for the proxy.ts split (routes/proxy.ts -> chat-route.ts,
// chat-completions.ts, completions.ts): the two handlers live in their own
// modules, are mounted on proxyRouter under the same /v1 paths, and the
// helpers other routes/tests still import from proxy.js keep working.
// Behavior itself is covered by the proxy-*.test.ts HTTP suites, which run
// unchanged against the split routers.
describe('proxy.ts split wiring', () => {
  it('exports the moved handlers and the shared route resolver', () => {
    expect(typeof handleChatCompletions).toBe('function');
    expect(typeof handleLegacyCompletions).toBe('function');
    expect(typeof resolveChatRoute).toBe('function');
  });

  it('registers POST /chat/completions on the chat router', () => {
    const stack = (chatCompletionsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === '/chat/completions');
    expect(layer).toBeDefined();
    expect(layer!.route!.methods.post).toBe(true);
  });

  it('registers POST /completions on the legacy router', () => {
    const stack = (completionsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === '/completions');
    expect(layer).toBeDefined();
    expect(layer!.route!.methods.post).toBe(true);
  });

  it('mounts both sub-routers on proxyRouter', () => {
    const stack = (proxyRouter as unknown as { stack: Array<{ handle: unknown }> }).stack;
    expect(stack.some((l) => l.handle === chatCompletionsRouter)).toBe(true);
    expect(stack.some((l) => l.handle === completionsRouter)).toBe(true);
  });

  it('keeps the proxy.js helper surface for existing importers', () => {
    for (const fn of [
      clearReasoningMemory,
      completionReasoningText,
      extractApiToken,
      getRequestGroupId,
      getStickyModel,
      providerSafeStop,
      sessionIdentityMessages,
      setStickyModel,
      streamChunkText,
      streamReasoningText,
      traceRouteEvent,
    ]) expect(typeof fn).toBe('function');

    expect(streamChunkText({ choices: [{ delta: { content: 'hello' } }] })).toBe('hello');
    expect(streamChunkText({ usage: {} })).toBe('');
    expect(streamReasoningText({ choices: [{ delta: { reasoning_content: 'think' } }] })).toBe('think');
    expect(completionReasoningText({ choices: [{ message: { reasoning: 'think' } }] })).toBe('think');
    expect(providerSafeStop(['a', 'b', 'c', 'd', 'e'])).toEqual(['a', 'b', 'c', 'd']);
    expect(extractApiToken({ headers: { authorization: 'Bearer k' } } as never)).toBe('k');
    expect(getRequestGroupId({ headers: { 'x-request-id': 'req-1' } } as never)).toBe('req-1');
    expect(sessionIdentityMessages([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
