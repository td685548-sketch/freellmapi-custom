// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import { apiFetch } from '@/lib/api';
import { streamPlayground } from './playground-api';
import {
  SETTINGS_OPEN_KEY,
  activeChatKey,
  historyKey,
  loadChats,
  saveActiveChatId,
  saveChats,
  settingsKey,
} from './playground-state';
import Playground from './pages/Playground';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  // Phase 2: the api modules read the CSRF token from here, never a
  // dashboard token (there is no getToken/clearToken any more).
  csrfHeaders: () => ({}),
  UNAUTHORIZED_EVENT: 'freellmapi:unauthorized',
}));

vi.mock('./playground-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./playground-api')>();
  return {
    ...actual,
    loadPlaygroundModels: vi.fn(async () => ({
      enabled: true,
      models: [
        { id: 'auto', name: 'Auto', provider: 'gateway' },
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
      ],
    })),
    streamPlayground: vi.fn(),
  };
});

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/user/session') {
      return {
        userId: 7,
        email: 'tester@local',
        role: 'admin',
        isPrimary: true,
        permissions: ['*'],
      };
    }
    return {};
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  mountPlayground();
});

afterEach(() => {
  unmountPlayground();
  queryClient.clear();
  localStorage.clear();
});

function mountPlayground(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <Playground />
          </I18nProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

function unmountPlayground(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = '';
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

function setInputValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function getSettingsControls() {
  const details = container.querySelector('details.x-chat-settings') as HTMLDetailsElement;
  const systemInput = details.querySelector('input[type="text"]') as HTMLInputElement;
  const temperatureInput = details.querySelector('input[type="range"]') as HTMLInputElement;
  const maxTokensInput = details.querySelector('input[type="number"]') as HTMLInputElement;
  const reasoningSelect = details.querySelector('select') as HTMLSelectElement;
  return { details, systemInput, temperatureInput, maxTokensInput, reasoningSelect };
}

describe('Thruline Playground Chat Settings persistence', () => {
  it('persists systemPrompt, temperature (including 0), maxTokens, reasoningEffort, and settings open state across unmount/remount before any message is sent', async () => {
    await flush();

    // Open settings panel via toolbar button
    const settingsBtn = container.querySelector('button[aria-label="Chat settings"]') as HTMLButtonElement;
    await act(async () => {
      settingsBtn.click();
    });
    await flush();

    const controls1 = getSettingsControls();
    expect(controls1.details.open).toBe(true);
    expect(localStorage.getItem(SETTINGS_OPEN_KEY)).toBe('true');

    await act(async () => {
      setInputValue(controls1.systemInput, 'You are a Rust expert.');
      setInputValue(controls1.temperatureInput, '0');
      setInputValue(controls1.maxTokensInput, '4096');
      setInputValue(controls1.reasoningSelect, 'high');
    });
    await flush();

    // Verify clamping on out-of-range maxTokens
    await act(async () => {
      setInputValue(controls1.maxTokensInput, '99999');
    });
    await flush();
    expect(getSettingsControls().maxTokensInput.value).toBe('32768');

    await act(async () => {
      setInputValue(getSettingsControls().maxTokensInput, '0');
    });
    await flush();
    expect(getSettingsControls().maxTokensInput.value).toBe('1');

    // Set final value to 4096 before tab switch
    await act(async () => {
      setInputValue(getSettingsControls().maxTokensInput, '4096');
    });
    await flush();

    // Simulate switching away to another Thruline tab (unmount) and coming back (remount)
    unmountPlayground();
    mountPlayground();
    await flush();

    const controls2 = getSettingsControls();
    expect(controls2.details.open).toBe(true);
    expect(controls2.systemInput.value).toBe('You are a Rust expert.');
    expect(controls2.temperatureInput.value).toBe('0');
    expect(controls2.maxTokensInput.value).toBe('4096');
    expect(controls2.reasoningSelect.value).toBe('high');

    // Verify localStorage has activeChatId and sampling defaults
    expect(localStorage.getItem(activeChatKey(7))).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(settingsKey(7)) ?? '{}')).toEqual({
      temperature: 0,
      maxTokens: 4096,
      reasoningEffort: 'high',
    });
  });

  it('isolates per-chat settings, inherits sampling defaults on New Chat while clearing systemPrompt, and restores activeChatId on remount', async () => {
    await flush();

    // Configure Chat A
    await act(async () => {
      const c = getSettingsControls();
      setInputValue(c.systemInput, 'Alpha prompt');
      setInputValue(c.temperatureInput, '0.2');
      setInputValue(c.maxTokensInput, '1024');
      setInputValue(c.reasoningSelect, 'low');
    });
    await flush();

    // Create Chat B via sidebar New chat button
    const newChatBtn = container.querySelector('aside.x-chat-history button') as HTMLButtonElement;
    await act(async () => {
      newChatBtn.click();
    });
    await flush();

    // Chat B inherits sampling defaults (0.2, 1024, 'low') but clears systemPrompt
    const afterNew = getSettingsControls();
    expect(afterNew.systemInput.value).toBe('');
    expect(afterNew.temperatureInput.value).toBe('0.2');
    expect(afterNew.maxTokensInput.value).toBe('1024');
    expect(afterNew.reasoningSelect.value).toBe('low');

    // Customize Chat B
    await act(async () => {
      setInputValue(afterNew.systemInput, 'Beta prompt');
      setInputValue(afterNew.temperatureInput, '1.4');
      setInputValue(afterNew.maxTokensInput, '4096');
      setInputValue(afterNew.reasoningSelect, 'medium');
    });
    await flush();

    // Switch back to Chat A (second item in history nav since Chat B was prepended)
    const chatButtons = [...container.querySelectorAll('aside.x-chat-history nav button')].filter(
      (b) => !b.getAttribute('title')?.includes('Delete'),
    ) as HTMLButtonElement[];
    expect(chatButtons).toHaveLength(2);
    const chatBId = loadChats(7)[0]!.id;
    const chatAId = loadChats(7)[1]!.id;

    await act(async () => {
      chatButtons[1]!.click();
    });
    await flush();

    expect(localStorage.getItem(activeChatKey(7))).toBe(chatAId);
    const onChatA = getSettingsControls();
    expect(onChatA.systemInput.value).toBe('Alpha prompt');
    expect(onChatA.temperatureInput.value).toBe('0.2');
    expect(onChatA.maxTokensInput.value).toBe('1024');
    expect(onChatA.reasoningSelect.value).toBe('low');

    // Remount and verify Chat A (NOT chats[0] which is Chat B) is restored as active
    unmountPlayground();
    mountPlayground();
    await flush();

    expect(localStorage.getItem(activeChatKey(7))).toBe(chatAId);
    expect(getSettingsControls().systemInput.value).toBe('Alpha prompt');

    // Switch to Chat B and verify its isolated settings are still intact
    const remountedChatButtons = [
      ...container.querySelectorAll('aside.x-chat-history nav button'),
    ].filter((b) => !b.getAttribute('title')?.includes('Delete')) as HTMLButtonElement[];
    await act(async () => {
      remountedChatButtons[0]!.click();
    });
    await flush();

    expect(localStorage.getItem(activeChatKey(7))).toBe(chatBId);
    const onChatB = getSettingsControls();
    expect(onChatB.systemInput.value).toBe('Beta prompt');
    expect(onChatB.temperatureInput.value).toBe('1.4');
    expect(onChatB.maxTokensInput.value).toBe('4096');
    expect(onChatB.reasoningSelect.value).toBe('medium');
  });

  it('sends active chat systemPrompt as messages[0] and sampling snapshot in streamPlayground on both handleSend and handleRetry', async () => {
    await flush();

    await act(async () => {
      const c = getSettingsControls();
      setInputValue(c.systemInput, 'Strictly respond with JSON.');
      setInputValue(c.temperatureInput, '0');
      setInputValue(c.maxTokensInput, '512');
      setInputValue(c.reasoningSelect, 'high');
    });
    await flush();

    // First send fails so Retry appears, second succeeds
    vi.mocked(streamPlayground)
      .mockRejectedValueOnce(new Error('gateway 502'))
      .mockImplementationOnce(async (_body, _signal, onDelta) => {
        onDelta('{"ok":true}');
        return {
          content: '{"ok":true}',
          reasoning: '',
          done: true,
          route: 'gpt-4o',
          latencyMs: 12,
        };
      });

    const composer = container.querySelector('textarea.x-chat-input') as HTMLTextAreaElement;
    const sendBtn = container.querySelector('button.x-send-button') as HTMLButtonElement;

    await act(async () => {
      setInputValue(composer, 'Hello model');
    });
    await act(async () => {
      sendBtn.click();
    });
    await flush();

    expect(vi.mocked(streamPlayground)).toHaveBeenCalledTimes(1);
    const sendPayload = vi.mocked(streamPlayground).mock.calls[0]![0];
    expect(sendPayload.messages[0]).toEqual({
      role: 'system',
      content: 'Strictly respond with JSON.',
    });
    expect(sendPayload.messages[1]).toEqual({ role: 'user', content: 'Hello model' });
    expect(sendPayload.temperature).toBe(0);
    expect(sendPayload.max_tokens).toBe(512);
    expect(sendPayload.reasoning_effort).toBe('high');

    // Click Retry
    const retryBtn = [...container.querySelectorAll('div[role="alert"] button')].find((b) =>
      b.textContent?.includes('Retry'),
    ) as HTMLButtonElement;
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn.click();
    });
    await flush();

    expect(vi.mocked(streamPlayground)).toHaveBeenCalledTimes(2);
    const retryPayload = vi.mocked(streamPlayground).mock.calls[1]![0];
    expect(retryPayload.messages[0]).toEqual({
      role: 'system',
      content: 'Strictly respond with JSON.',
    });
    expect(retryPayload.messages[1]).toEqual({ role: 'user', content: 'Hello model' });
    expect(retryPayload.temperature).toBe(0);
    expect(retryPayload.max_tokens).toBe(512);
    expect(retryPayload.reasoning_effort).toBe('high');
  });

  it('handles userId transition 0 -> 7 without clobbering persisted chats or losing pre-session edits', async () => {
    // Tear down initial mount and test delayed session resolution
    unmountPlayground();
    queryClient.clear();
    localStorage.clear();

    // Seed persisted chat for userId=7
    saveChats(7, [
      {
        id: 'persisted-7',
        title: 'Existing chat',
        model: 'gpt-4o',
        messages: [],
        updatedAt: 1000,
        systemPrompt: 'Persisted system prompt',
        temperature: 0.3,
        maxTokens: 1500,
        reasoningEffort: 'medium',
      },
    ]);
    saveActiveChatId(7, 'persisted-7');

    // Case A: user session initially unresolved (userId=0), then resolves to 7 without prior edits
    let resolveSession!: (val: unknown) => void;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/user/session') {
        return new Promise((resolve) => {
          resolveSession = resolve;
        });
      }
      return {};
    });

    mountPlayground();
    await flush();

    // Resolve session -> userId=7
    await act(async () => {
      resolveSession({
        userId: 7,
        email: 'tester@local',
        role: 'admin',
        isPrimary: true,
        permissions: ['*'],
      });
    });
    await flush();

    expect(getSettingsControls().systemInput.value).toBe('Persisted system prompt');
    expect(getSettingsControls().temperatureInput.value).toBe('0.3');
    expect(loadChats(7)[0]!.id).toBe('persisted-7');
    expect(localStorage.getItem(historyKey(0))).toBeNull();

    // Case B: user edits systemPrompt while userId=0 before session resolves -> edits are preserved
    unmountPlayground();
    queryClient.clear();
    let resolveSessionB!: (val: unknown) => void;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (path === '/api/user/session') {
        return new Promise((resolve) => {
          resolveSessionB = resolve;
        });
      }
      return {};
    });

    mountPlayground();
    await flush();

    await act(async () => {
      setInputValue(getSettingsControls().systemInput, 'Pre-session draft prompt');
    });
    await flush();

    await act(async () => {
      resolveSessionB({
        userId: 7,
        email: 'tester@local',
        role: 'admin',
        isPrimary: true,
        permissions: ['*'],
      });
    });
    await flush();

    expect(getSettingsControls().systemInput.value).toBe('Pre-session draft prompt');
    const savedAfterMerge = loadChats(7);
    expect(savedAfterMerge.some((c) => c.systemPrompt === 'Pre-session draft prompt')).toBe(true);
    expect(savedAfterMerge.some((c) => c.id === 'persisted-7')).toBe(true);
  });
});
