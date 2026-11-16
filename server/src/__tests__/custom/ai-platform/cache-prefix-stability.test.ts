import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { applyCacheBreakpoints } from '../../../custom/ai-platform/prompt-cache/breakpoints.js';
import { setPromptCacheSettings } from '../../../custom/ai-platform/prompt-cache/capabilities.js';
import { addSystemBlock } from '../../../custom/ai-platform/wire/extract.js';
import { _clearPrefixFreezeForTesting, compressRequest } from '../../../services/compression/pipeline.js';

function longDeterministicText(tag: string, chars: number): string {
  const unit = `[${tag}] Deterministic enterprise guidance paragraph for prefix caching verification. `;
  const repeats = Math.ceil(chars / unit.length);
  return unit.repeat(repeats).slice(0, chars);
}

function makeTools(): ChatToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'get_account_status',
        description: longDeterministicText('tool-desc', 4500),
        parameters: {
          type: 'object',
          properties: {
            accountId: { type: 'string', description: 'Account identifier' },
          },
          required: ['accountId'],
        },
      },
    },
  ];
}

function countBreakpointsInMessagesPrefix(messages: ChatMessage[]): number {
  let lastIndexWithBreakpoint = -1;
  messages.forEach((msg, index) => {
    const rec = msg as unknown as Record<string, unknown>;
    if (rec.cache_control !== undefined) {
      lastIndexWithBreakpoint = index;
      return;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block && typeof block === 'object' && 'cache_control' in block && block.cache_control !== undefined) {
          lastIndexWithBreakpoint = index;
        }
      }
    }
  });
  return lastIndexWithBreakpoint + 1;
}

describe('prompt-cache prefix stability (T094)', () => {
  beforeEach(async () => {
    await initDb(':memory:');
    resetFlagsCacheForTests();
    _clearPrefixFreezeForTesting();
  });

  afterEach(() => {
    _clearPrefixFreezeForTesting();
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('produces byte-identical JSON prefix up to the last cache_control breakpoint across differing user questions and volatile RAG context', () => {
    setFlags({ promptCache: true });
    setPromptCacheSettings({
      forward: true,
      autoBreakpoints: true,
      preferStickyRoute: false,
    });

    const systemPrompt = longDeterministicText('system-prompt', 4800);
    const stableKnowledge = longDeterministicText('stable-knowledge', 4800);
    const sharedTools = makeTools();

    const buildProcessedPayload = (
      volatileRag: string,
      userQuestion: string,
      insertVolatileFirst: boolean,
    ): string => {
      const body: { messages: ChatMessage[]; tools: ChatToolDefinition[] } = {
        messages: [
          { role: 'user', content: 'Earlier turn: hello' },
          { role: 'assistant', content: 'Earlier reply: how can I help?' },
          { role: 'user', content: userQuestion },
        ],
        tools: structuredClone(sharedTools),
      };

      if (insertVolatileFirst) {
        addSystemBlock('openai-chat', body, volatileRag, 'volatile');
        addSystemBlock('openai-chat', body, systemPrompt, 'stable');
        addSystemBlock('openai-chat', body, stableKnowledge, 'stable');
      } else {
        addSystemBlock('openai-chat', body, systemPrompt, 'stable');
        addSystemBlock('openai-chat', body, stableKnowledge, 'stable');
        addSystemBlock('openai-chat', body, volatileRag, 'volatile');
      }

      const withBreakpoints = applyCacheBreakpoints(body.messages, body.tools, {
        platform: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
      });

      const cachePrefixLength = countBreakpointsInMessagesPrefix(withBreakpoints.messages);
      expect(cachePrefixLength).toBe(2);

      const compressed = compressRequest(withBreakpoints.messages, {
        tools: withBreakpoints.tools as ChatToolDefinition[],
        cacheControlPrefixLength: cachePrefixLength,
        previewMode: 'standard',
        recordStats: false,
      });

      return JSON.stringify({
        tools: withBreakpoints.tools,
        messages: compressed.messages,
      });
    };

    const json1 = buildProcessedPayload(
      'Reference material from this website. Query 1 hit: password reset flow takes 5 minutes.',
      'How do I reset my password?',
      true,
    );
    const json2 = buildProcessedPayload(
      'Reference material from this website. Query 2 hit: enterprise invoicing runs on net-30 terms.',
      'What are your enterprise billing terms?',
      false,
    );

    const marker = '"cache_control":{"type":"ephemeral"}';
    const lastIdx1 = json1.lastIndexOf(marker);
    const lastIdx2 = json2.lastIndexOf(marker);

    expect(lastIdx1).toBeGreaterThan(0);
    expect(lastIdx2).toBe(lastIdx1);

    const endOfLastBreakpoint1 = lastIdx1 + marker.length;
    const endOfLastBreakpoint2 = lastIdx2 + marker.length;

    const prefix1 = json1.slice(0, endOfLastBreakpoint1);
    const prefix2 = json2.slice(0, endOfLastBreakpoint2);

    expect(Buffer.from(prefix1, 'utf8').equals(Buffer.from(prefix2, 'utf8'))).toBe(true);
    expect(prefix1).toBe(prefix2);

    const suffix1 = json1.slice(endOfLastBreakpoint1);
    const suffix2 = json2.slice(endOfLastBreakpoint2);
    expect(suffix1).not.toBe(suffix2);
    expect(suffix1).toContain('How do I reset my password?');
    expect(suffix2).toContain('What are your enterprise billing terms?');
    expect(suffix1).not.toContain('cache_control');
    expect(suffix2).not.toContain('cache_control');
  });
});
