import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';
import { getDb, initDb } from '../../../db/index.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { applyCacheBreakpoints } from '../../../custom/ai-platform/prompt-cache/breakpoints.js';
import {
  setPromptCacheSettings,
  upsertCacheCapabilityOverride,
} from '../../../custom/ai-platform/prompt-cache/capabilities.js';
import {
  addSystemBlock,
  isVolatileSystemMessage,
  markStableSystemText,
  markVolatileSystemText,
} from '../../../custom/ai-platform/wire/extract.js';

function makeTools(minChars = 5000): ChatToolDefinition[] {
  const padding = 'x'.repeat(minChars);
  return [
    {
      type: 'function',
      function: {
        name: 'search_docs',
        description: `Search documentation ${padding}`,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
  ];
}

function longText(label: string, chars: number): string {
  return `${label}: ` + 'a'.repeat(Math.max(0, chars - label.length - 2));
}

describe('prompt-cache/breakpoints & wire/extract system stability', () => {
  beforeEach(async () => {
    await initDb(':memory:');
    resetFlagsCacheForTests();
  });

  afterEach(() => {
    resetFlagsCacheForTests();
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
  });

  it('returns exact input references without mutation when promptCache pillar is disabled', () => {
    setFlags({ promptCache: false });

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: longText('sys', 5000),
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user', content: 'hello' },
    ];
    const tools: ChatToolDefinition[] = makeTools(5000);
    const messagesBefore = structuredClone(messages);
    const toolsBefore = structuredClone(tools);

    const out = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });

    expect(out.messages).toBe(messages);
    expect(out.tools).toBe(tools);
    expect(messages).toEqual(messagesBefore);
    expect(tools).toEqual(toolsBefore);
  });

  it('tracks volatile vs stable system messages via WeakSet, bounded text sets, and RAG prefix', () => {
    const body: { messages: Array<{ role: string; content: string }> } = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    addSystemBlock('openai-chat', body, 'volatile-a', 'volatile');
    addSystemBlock('openai-chat', body, 'stable-1', 'stable');
    addSystemBlock('openai-chat', body, 'volatile-b', 'volatile');
    addSystemBlock('openai-chat', body, 'stable-2', 'stable');

    expect(body.messages.map((m) => m.content)).toEqual([
      'stable-1',
      'stable-2',
      'volatile-a',
      'volatile-b',
      'hi',
    ]);
    expect(isVolatileSystemMessage(body.messages[0])).toBe(false);
    expect(isVolatileSystemMessage(body.messages[1])).toBe(false);
    expect(isVolatileSystemMessage(body.messages[2])).toBe(true);
    expect(isVolatileSystemMessage(body.messages[3])).toBe(true);

    // Cloned message matches via normalized volatileTexts
    expect(isVolatileSystemMessage({ role: 'system', content: '  volatile-a \n ' })).toBe(true);

    // Explicit text marking and stable override
    markVolatileSystemText('ephemeral   context\nblock');
    expect(isVolatileSystemMessage({ role: 'system', content: 'ephemeral context block' })).toBe(true);
    markStableSystemText('ephemeral context block');
    expect(isVolatileSystemMessage({ role: 'system', content: 'ephemeral context block' })).toBe(false);

    // Default RAG prefix is volatile unless explicitly marked stable
    const ragMsg = {
      role: 'system',
      content: 'Reference material from this website. Use it when relevant.',
    };
    expect(isVolatileSystemMessage(ragMsg)).toBe(true);

    const overriddenRag = 'Reference material from this website. Custom static appendix.';
    markStableSystemText(overriddenRag);
    expect(
      isVolatileSystemMessage({
        role: 'system',
        content: [{ type: 'text', text: overriddenRag }],
      }),
    ).toBe(false);
  });

  it('keeps stable blocks strictly before volatile blocks across all 4 wires regardless of call order', () => {
    const openaiBody: { messages: Array<{ role: string; content: string }> } = {
      messages: [{ role: 'user', content: 'q' }],
    };
    addSystemBlock('openai-chat', openaiBody, 'v1', 'volatile');
    addSystemBlock('openai-chat', openaiBody, 's1', 'stable');
    addSystemBlock('openai-chat', openaiBody, 'v2', 'volatile');
    addSystemBlock('openai-chat', openaiBody, 's2', 'stable');
    expect(openaiBody.messages.map((m) => m.content)).toEqual(['s1', 's2', 'v1', 'v2', 'q']);

    const anthropicArrBody: { system: Array<{ type: string; text: string }> } = { system: [] };
    addSystemBlock('anthropic', anthropicArrBody, 'v1', 'volatile');
    addSystemBlock('anthropic', anthropicArrBody, 's1', 'stable');
    addSystemBlock('anthropic', anthropicArrBody, 'v2', 'volatile');
    addSystemBlock('anthropic', anthropicArrBody, 's2', 'stable');
    expect(anthropicArrBody.system.map((b) => b.text)).toEqual(['s1', 's2', 'v1', 'v2']);

    const anthropicStrBody: { system: string } = { system: 'caller' };
    addSystemBlock('anthropic', anthropicStrBody, 'v1', 'volatile');
    addSystemBlock('anthropic', anthropicStrBody, 's1', 'stable');
    addSystemBlock('anthropic', anthropicStrBody, 'v2', 'volatile');
    addSystemBlock('anthropic', anthropicStrBody, 's2', 'stable');
    const anthropicParts = anthropicStrBody.system.split('\n\n');
    expect(anthropicParts.indexOf('s1')).toBeLessThan(anthropicParts.indexOf('v1'));
    expect(anthropicParts.indexOf('s2')).toBeLessThan(anthropicParts.indexOf('v1'));
    expect(anthropicParts.indexOf('s2')).toBeLessThan(anthropicParts.indexOf('v2'));

    const responsesBody: { instructions: string } = { instructions: 'caller' };
    addSystemBlock('responses', responsesBody, 'v1', 'volatile');
    addSystemBlock('responses', responsesBody, 's1', 'stable');
    addSystemBlock('responses', responsesBody, 'v2', 'volatile');
    addSystemBlock('responses', responsesBody, 's2', 'stable');
    const respParts = responsesBody.instructions.split('\n\n');
    expect(respParts.indexOf('s1')).toBeLessThan(respParts.indexOf('v1'));
    expect(respParts.indexOf('s2')).toBeLessThan(respParts.indexOf('v1'));
    expect(respParts.indexOf('s2')).toBeLessThan(respParts.indexOf('v2'));

    const geminiBody: { systemInstruction?: { parts: Array<{ text: string }> } } = {};
    addSystemBlock('gemini', geminiBody, 'v1', 'volatile');
    addSystemBlock('gemini', geminiBody, 's1', 'stable');
    addSystemBlock('gemini', geminiBody, 'v2', 'volatile');
    addSystemBlock('gemini', geminiBody, 's2', 'stable');
    expect(geminiBody.systemInstruction?.parts.map((p) => p.text)).toEqual(['s1', 's2', 'v1', 'v2']);
  });

  it('forwards caller cache_control on explicit targets up to maxBreakpoints without mutating inputs', () => {
    setFlags({ promptCache: true });
    setPromptCacheSettings({ forward: true, autoBreakpoints: false });

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'b1', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'b2', cache_control: { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'u1', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'u2', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'u3', cache_control: { type: 'ephemeral' } },
        ],
      },
    ];
    const tools = [
      {
        ...makeTools(100)[0]!,
        cache_control: { type: 'ephemeral' },
      },
    ];
    const messagesSnapshot = structuredClone(messages);
    const toolsSnapshot = structuredClone(tools);

    const out = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });

    // Input must remain completely untouched
    expect(messages).toEqual(messagesSnapshot);
    expect(tools).toEqual(toolsSnapshot);
    expect(out.messages).not.toBe(messages);
    expect(out.tools).not.toBe(tools);

    // Total active breakpoints capped at cap.maxBreakpoints (4)
    let count = 0;
    for (const t of out.tools ?? []) {
      if (t && typeof t === 'object' && 'cache_control' in t) count += 1;
    }
    for (const m of out.messages) {
      if ('cache_control' in m && (m as Record<string, unknown>).cache_control !== undefined) count += 1;
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && typeof b === 'object' && 'cache_control' in b) count += 1;
        }
      }
    }
    expect(count).toBe(4);
  });

  it('strips all cache_control markers on implicit/none targets and when forward & autoBreakpoints are both off', () => {
    setFlags({ promptCache: true });
    setPromptCacheSettings({ forward: true, autoBreakpoints: true });

    const makePayload = () => {
      const messages: Array<ChatMessage & { cache_control?: unknown }> = [
        {
          role: 'system',
          cache_control: { type: 'ephemeral' },
          content: [{ type: 'text', text: longText('sys', 5000), cache_control: { type: 'ephemeral' } }],
        },
        { role: 'user', content: 'hi' },
      ];
      const tools = [{ ...makeTools(5000)[0]!, cache_control: { type: 'ephemeral' } }];
      return { messages, tools };
    };

    for (const target of [
      { platform: 'openai', modelId: 'gpt-4o' },
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
    ]) {
      const { messages, tools } = makePayload();
      const origMsgs = structuredClone(messages);
      const origTools = structuredClone(tools);

      const out = applyCacheBreakpoints(messages, tools, target);
      expect(messages).toEqual(origMsgs);
      expect(tools).toEqual(origTools);
      expect((out.messages[0] as Record<string, unknown>).cache_control).toBeUndefined();
      const blocks = out.messages[0]!.content as Array<Record<string, unknown>>;
      expect(blocks[0]!.cache_control).toBeUndefined();
      expect((out.tools![0] as Record<string, unknown>).cache_control).toBeUndefined();
    }

    // Explicit target with both forward=false and autoBreakpoints=false also strips
    setPromptCacheSettings({ forward: false, autoBreakpoints: false });
    const { messages, tools } = makePayload();
    const out = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
    expect((out.messages[0] as Record<string, unknown>).cache_control).toBeUndefined();
    expect(((out.messages[0]!.content as Array<Record<string, unknown>>)[0]!).cache_control).toBeUndefined();
    expect((out.tools![0] as Record<string, unknown>).cache_control).toBeUndefined();
  });

  it('places autoBreakpoints in priority order tools -> system prompt -> stable knowledge, ignoring volatile knowledge', () => {
    setFlags({ promptCache: true });
    setPromptCacheSettings({ forward: false, autoBreakpoints: true });

    const volatileText = longText('volatile-rag', 5000);
    markVolatileSystemText(volatileText);

    const messages: ChatMessage[] = [
      { role: 'system', content: longText('system-prompt', 5000) },
      { role: 'system', content: longText('stable-knowledge', 5000) },
      { role: 'system', content: volatileText },
      {
        role: 'system',
        content: [{ type: 'text', text: `Reference material from this website. ${longText('rag', 5000)}` }],
      },
      { role: 'user', content: 'What is the refund policy?' },
    ];
    const tools = makeTools(5000);
    const origMessages = structuredClone(messages);
    const origTools = structuredClone(tools);

    const out = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });

    // Inputs untouched
    expect(messages).toEqual(origMessages);
    expect(tools).toEqual(origTools);

    // 1. Last tool has cache_control
    expect((out.tools![out.tools!.length - 1] as Record<string, unknown>).cache_control).toEqual({
      type: 'ephemeral',
    });

    // 2. System prompt converted to array block with cache_control
    expect(out.messages[0]!.content).toEqual([
      {
        type: 'text',
        text: origMessages[0]!.content,
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // 3. Stable knowledge converted to array block with cache_control
    expect(out.messages[1]!.content).toEqual([
      {
        type: 'text',
        text: origMessages[1]!.content,
        cache_control: { type: 'ephemeral' },
      },
    ]);

    // 4. Volatile knowledge messages NEVER get cache_control
    expect(typeof out.messages[2]!.content).toBe('string');
    expect((out.messages[2] as Record<string, unknown>).cache_control).toBeUndefined();
    const ragBlocks = out.messages[3]!.content as Array<Record<string, unknown>>;
    expect(ragBlocks[0]!.cache_control).toBeUndefined();
  });

  it('respects remaining maxBreakpoints after caller markers and strips caller markers when forward=false', () => {
    setFlags({ promptCache: true });

    // Override maxBreakpoints to 3 for test precision
    upsertCacheCapabilityOverride({
      platform: 'anthropic',
      modelPattern: 'claude-sonnet-*',
      mode: 'explicit',
      maxBreakpoints: 3,
      minTokens: 1024,
      ttlSeconds: 300,
    });

    setPromptCacheSettings({ forward: true, autoBreakpoints: true });

    const messages: ChatMessage[] = [
      { role: 'system', content: longText('system-prompt', 5000) },
      { role: 'system', content: longText('stable-kb', 5000) },
      {
        role: 'user',
        content: [{ type: 'text', text: 'caller-marked', cache_control: { type: 'ephemeral' } }],
      },
    ];
    const tools = makeTools(5000);

    // 1 caller breakpoint leaves 2 remaining -> tools + system prompt get breakpoints, stable-kb skipped
    const out1 = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
    expect((out1.tools![0] as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' });
    expect(Array.isArray(out1.messages[0]!.content)).toBe(true);
    expect(typeof out1.messages[1]!.content).toBe('string'); // skipped due to maxBreakpoints=3 budget
    expect(((out1.messages[2]!.content as Array<Record<string, unknown>>)[0]!).cache_control).toEqual({
      type: 'ephemeral',
    });

    // When forward=false, caller marker is stripped so all 3 slots go to tools + system prompt + stable-kb
    setPromptCacheSettings({ forward: false, autoBreakpoints: true });
    const out2 = applyCacheBreakpoints(messages, tools, {
      platform: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
    expect((out2.tools![0] as Record<string, unknown>).cache_control).toEqual({ type: 'ephemeral' });
    expect(Array.isArray(out2.messages[0]!.content)).toBe(true);
    expect(Array.isArray(out2.messages[1]!.content)).toBe(true);
    expect(((out2.messages[2]!.content as Array<Record<string, unknown>>)[0]!).cache_control).toBeUndefined();
  });

  it('skips blocks below cap.minTokens (e.g. Haiku 2048 tokens) and attaches to last object block of array system messages', () => {
    setFlags({ promptCache: true });
    setPromptCacheSettings({ forward: true, autoBreakpoints: true });

    // Haiku 3.5 requires minTokens = 2048 (~8192 chars)
    const shortTools = makeTools(5000); // ~1280 tokens < 2048 -> skipped
    const messages: ChatMessage[] = [
      { role: 'system', content: longText('too-short-sys', 6000) }, // 1500 tokens < 2048 -> skipped
      {
        role: 'system',
        content: [
          { type: 'text', text: 'part-1 ' },
          { type: 'text', text: longText('long-stable-kb', 9000) },
        ],
      },
      { role: 'user', content: 'hi' },
    ];

    const out = applyCacheBreakpoints(messages, shortTools, {
      platform: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
    });

    expect((out.tools![0] as Record<string, unknown>).cache_control).toBeUndefined();
    expect(typeof out.messages[0]!.content).toBe('string');
    const kbBlocks = out.messages[1]!.content as Array<Record<string, unknown>>;
    expect(kbBlocks[0]!.cache_control).toBeUndefined();
    expect(kbBlocks[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });
});
