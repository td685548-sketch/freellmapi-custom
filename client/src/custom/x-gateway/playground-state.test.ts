import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TEMPERATURE,
  MAX_MAX_TOKENS,
  MAX_TEMPERATURE,
  MIN_MAX_TOKENS,
  MIN_TEMPERATURE,
  activeChatKey,
  buildWindowedPlaygroundMessages,
  getChatSettings,
  historyKey,
  loadActiveChatId,
  loadChats,
  loadDefaultSettings,
  newChat,
  resolveActiveChatId,
  sanitizeChatSamplingSettings,
  sanitizeChatSettings,
  sanitizeMaxTokens,
  sanitizeReasoningEffort,
  sanitizeSystemPrompt,
  sanitizeTemperature,
  saveActiveChatId,
  saveChats,
  saveDefaultSettings,
  settingsKey,
  type ChatSession,
} from './playground-state';

function stubStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  return store;
}

describe('playground-state sanitization helpers', () => {
  it('sanitizes and clamps temperature within [0, 2] while preserving 0', () => {
    expect(sanitizeTemperature(0)).toBe(0);
    expect(sanitizeTemperature(1.3)).toBe(1.3);
    expect(sanitizeTemperature(-1)).toBe(MIN_TEMPERATURE);
    expect(sanitizeTemperature(5)).toBe(MAX_TEMPERATURE);
    expect(sanitizeTemperature(Number.NaN)).toBe(DEFAULT_TEMPERATURE);
    expect(sanitizeTemperature('0.5')).toBe(DEFAULT_TEMPERATURE);
    expect(sanitizeTemperature(undefined, 0.2)).toBe(0.2);
  });

  it('sanitizes and clamps maxTokens within [1, 32768]', () => {
    expect(sanitizeMaxTokens(1)).toBe(1);
    expect(sanitizeMaxTokens(4096)).toBe(4096);
    expect(sanitizeMaxTokens(0)).toBe(MIN_MAX_TOKENS);
    expect(sanitizeMaxTokens(-50)).toBe(MIN_MAX_TOKENS);
    expect(sanitizeMaxTokens(99_999)).toBe(MAX_MAX_TOKENS);
    expect(sanitizeMaxTokens(1234.6)).toBe(1235);
    expect(sanitizeMaxTokens(Number.NaN)).toBe(DEFAULT_MAX_TOKENS);
    expect(sanitizeMaxTokens('2048')).toBe(DEFAULT_MAX_TOKENS);
  });

  it('validates reasoningEffort values', () => {
    expect(sanitizeReasoningEffort('')).toBe('');
    expect(sanitizeReasoningEffort('low')).toBe('low');
    expect(sanitizeReasoningEffort('medium')).toBe('medium');
    expect(sanitizeReasoningEffort('high')).toBe('high');
    expect(sanitizeReasoningEffort('ultra')).toBe(DEFAULT_REASONING_EFFORT);
    expect(sanitizeReasoningEffort(null, 'medium')).toBe('medium');
  });

  it('sanitizes systemPrompt without trimming spaces during typing', () => {
    expect(sanitizeSystemPrompt('You are helpful ')).toBe('You are helpful ');
    expect(sanitizeSystemPrompt(123)).toBe('');
    expect(sanitizeSystemPrompt(undefined, 'fallback')).toBe('fallback');
  });

  it('normalizes composite settings objects and getChatSettings', () => {
    expect(sanitizeChatSamplingSettings({ temperature: -2, maxTokens: 0, reasoningEffort: 'bad' })).toEqual({
      temperature: 0,
      maxTokens: 1,
      reasoningEffort: '',
    });

    expect(
      sanitizeChatSettings(
        { systemPrompt: 'Stay brief', temperature: 0, maxTokens: 99999, reasoningEffort: 'high' },
        { temperature: 0.9 },
      ),
    ).toEqual({
      systemPrompt: 'Stay brief',
      temperature: 0,
      maxTokens: 32_768,
      reasoningEffort: 'high',
    });

    expect(getChatSettings(null, { temperature: 0.3, maxTokens: 1024, reasoningEffort: 'low' })).toEqual({
      systemPrompt: '',
      temperature: 0.3,
      maxTokens: 1024,
      reasoningEffort: 'low',
    });
  });
});

describe('playground-state persistence', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = stubStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('newChat() starts with empty systemPrompt and inherits provided sampling defaults', () => {
    const def = newChat();
    expect(def.systemPrompt).toBe('');
    expect(def.temperature).toBe(DEFAULT_TEMPERATURE);
    expect(def.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(def.reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);

    const custom = newChat({ temperature: 0, maxTokens: 4096, reasoningEffort: 'high' });
    expect(custom.systemPrompt).toBe('');
    expect(custom.temperature).toBe(0);
    expect(custom.maxTokens).toBe(4096);
    expect(custom.reasoningEffort).toBe('high');
  });

  it('saveChats / loadChats round-trips settings including temperature: 0 and systemPrompt', () => {
    const session: ChatSession = {
      id: 'chat-1',
      title: 'Test',
      model: 'gpt-4o',
      messages: [{ id: 'm1', role: 'user', content: 'Hi' }],
      updatedAt: 1_700_000_000_000,
      systemPrompt: 'Reply in JSON',
      temperature: 0,
      maxTokens: 1024,
      reasoningEffort: 'high',
    };

    expect(saveChats(42, [session])).toBe(true);
    const loaded = loadChats(42);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: 'chat-1',
      title: 'Test',
      model: 'gpt-4o',
      systemPrompt: 'Reply in JSON',
      temperature: 0,
      maxTokens: 1024,
      reasoningEffort: 'high',
    });
  });

  it('loadChats stays backward-compatible with legacy chats missing settings fields and clamps invalid stored values', () => {
    const legacyPayload = [
      {
        id: 'legacy-1',
        title: 'Old chat',
        model: 'auto',
        messages: [{ id: 'm1', role: 'user', content: 'Hello' }],
        updatedAt: 1000,
      },
      {
        id: 'corrupt-settings-1',
        title: 'Clamped chat',
        model: 'auto',
        messages: [],
        updatedAt: 2000,
        systemPrompt: 42,
        temperature: 9,
        maxTokens: -10,
        reasoningEffort: 'extreme',
      },
    ];
    store.set(historyKey(7), JSON.stringify(legacyPayload));

    const loaded = loadChats(7);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toMatchObject({
      id: 'legacy-1',
      systemPrompt: '',
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
    expect(loaded[1]).toMatchObject({
      id: 'corrupt-settings-1',
      systemPrompt: '',
      temperature: MAX_TEMPERATURE,
      maxTokens: MIN_MAX_TOKENS,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
  });

  it('persists activeChatId and resolves fallbacks cleanly', () => {
    expect(loadActiveChatId(0)).toBe('');
    expect(saveActiveChatId(0, 'chat-1')).toBe(false);

    expect(saveActiveChatId(5, 'chat-2')).toBe(true);
    expect(store.get(activeChatKey(5))).toBe('chat-2');
    expect(loadActiveChatId(5)).toBe('chat-2');

    const chats: ChatSession[] = [
      { id: 'chat-1', title: 'One', model: 'auto', messages: [], updatedAt: 1 },
      { id: 'chat-2', title: 'Two', model: 'auto', messages: [], updatedAt: 2 },
    ];
    expect(resolveActiveChatId(chats, 'chat-2')).toBe('chat-2');
    expect(resolveActiveChatId(chats, 'deleted-id')).toBe('chat-1');
    expect(resolveActiveChatId([], 'chat-2')).toBe('');
  });

  it('persists sampling defaults and handles corrupt storage safely', () => {
    expect(saveDefaultSettings(0, { temperature: 0.2 })).toBe(false);
    expect(saveDefaultSettings(5, { temperature: 0, maxTokens: 8192, reasoningEffort: 'medium' })).toBe(true);
    expect(loadDefaultSettings(5)).toEqual({
      temperature: 0,
      maxTokens: 8192,
      reasoningEffort: 'medium',
    });

    store.set(settingsKey(5), '{bad json');
    expect(loadDefaultSettings(5)).toEqual({
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    });
  });

  it('buildWindowedPlaygroundMessages prepends non-empty systemPrompt as messages[0]', () => {
    const msgs = buildWindowedPlaygroundMessages(
      [{ id: '1', role: 'user', content: 'Ping' }],
      '  Be terse  ',
    );
    expect(msgs[0]).toEqual({ role: 'system', content: 'Be terse' });
    expect(msgs[1]).toEqual({ role: 'user', content: 'Ping' });
  });
});
