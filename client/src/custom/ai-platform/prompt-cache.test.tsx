// @vitest-environment jsdom
/**
 * T102 — AI Platform Prompt Cache UI tests (native createRoot/act, no @testing-library/react).
 *
 * Covers:
 * - Bilingual EN/VI string parity for prompt-cache-strings.ts
 * - AiPlatformApp routing & RBAC guards (view_prompt_cache read-only, edit_prompt_cache editor-only,
 *   no-access guard, no leaked GET requests without view_prompt_cache)
 * - Section 1: Settings toggles (forward, autoBreakpoints, preferStickyRoute advisory) & save + error handling
 * - Section 2: Savings & usage summary cards, SVG bar chart, breakdown table across days/groupBy
 * - Section 3: Capabilities table (builtin vs override), add/update override, delete override + error handling
 * - AbortSignal cleanup on unmount & stale response isolation on session change
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { PromptCache } from './pages/PromptCache';
import * as promptCacheApi from './prompt-cache-api';
import * as promptCacheStrings from './prompt-cache-strings';

const actor = vi.hoisted(() => ({
  perms: new Set<string>(),
  isPrimary: false,
  userId: 1,
}));

vi.mock('../use-administrative-access', () => ({
  useAdministrativeAccess: () => ({
    can: (p: string) => actor.isPrimary || actor.perms.has(p),
    isPending: false,
    isPrimary: actor.isPrimary,
    isAdmin: false,
    isMember: true,
    identity: `test:${actor.userId}:${actor.isPrimary}:${[...actor.perms].sort().join(',')}`,
    hasPermission: (p: Permission) => actor.isPrimary || actor.perms.has(p),
    group: (parent: string) => actor.isPrimary || actor.perms.has(parent),
  }),
}));

vi.mock('../use-session', () => ({
  useUserSession: () => ({
    session: {
      userId: actor.userId,
      permissions: [...actor.perms] as Permission[],
      role: 'member' as const,
      isPrimary: actor.isPrimary,
    },
    hasPermission: (p: Permission) => actor.isPrimary || actor.perms.has(p),
    isPrimary: actor.isPrimary,
    isAdmin: false,
    isMember: true,
    permissions: [...actor.perms] as Permission[],
  }),
}));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    fetchOverview: vi.fn().mockResolvedValue({
      flags: {
        prompts: false,
        retrieval: false,
        promptCache: true,
        mcpClient: false,
        outputGuard: false,
        orchestrator: false,
      },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: false, ready: false, summary: '' },
        retrieval: { enabled: false, ready: false, summary: '' },
        promptCache: { enabled: true, ready: true, summary: 'Ready' },
        mcpClient: { enabled: false, ready: false, summary: '' },
        outputGuard: { enabled: false, ready: false, summary: '' },
        orchestrator: { enabled: false, ready: false, summary: '' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./prompt-cache-api', async () => {
  const actual = await vi.importActual<typeof import('./prompt-cache-api')>('./prompt-cache-api');
  return {
    ...actual,
    fetchPromptCacheSettings: vi.fn(),
    putPromptCacheSettings: vi.fn(),
    fetchPromptCacheCapabilities: vi.fn(),
    putPromptCacheCapability: vi.fn(),
    deletePromptCacheCapability: vi.fn(),
    fetchPromptCacheStats: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;
let qc: QueryClient;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderEl(el: React.ReactElement) {
  act(() => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
  });
}

function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const SAMPLE_CAPABILITIES: promptCacheApi.PromptCacheCapability[] = [
  {
    platform: 'anthropic',
    modelPattern: 'claude-*',
    mode: 'explicit',
    maxBreakpoints: 4,
    minTokens: 1024,
    ttlSeconds: 300,
    source: 'builtin',
    updatedAt: '2026-11-13 00:00:00',
  },
  {
    platform: 'openrouter',
    modelPattern: 'anthropic/claude-*',
    mode: 'explicit',
    maxBreakpoints: 6,
    minTokens: 2048,
    ttlSeconds: 600,
    source: 'override',
    updatedAt: '2026-11-15 10:00:00',
  },
];

const SAMPLE_STATS_DAY: promptCacheApi.PromptCacheStatsResponse = {
  days: 30,
  groupBy: 'day',
  rows: [
    {
      key: '2026-11-14',
      requests: 120,
      requestsWithHit: 90,
      hitRate: 0.75,
      requestHitRate: 0.75,
      inputTokens: 40_000,
      cacheReadTokens: 120_000,
      cacheWriteTokens: 10_000,
      estSavedUsd: 0.42,
    },
    {
      key: '2026-11-15',
      requests: 80,
      requestsWithHit: 60,
      hitRate: 0.8,
      requestHitRate: 0.75,
      inputTokens: 20_000,
      cacheReadTokens: 80_000,
      cacheWriteTokens: 5_000,
      estSavedUsd: 0.28,
    },
  ],
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms.clear();
  actor.isPrimary = false;
  actor.userId = 1;

  vi.mocked(promptCacheApi.fetchPromptCacheSettings).mockResolvedValue({
    settings: { forward: true, autoBreakpoints: false, preferStickyRoute: false },
  });
  vi.mocked(promptCacheApi.putPromptCacheSettings).mockResolvedValue({
    settings: { forward: true, autoBreakpoints: true, preferStickyRoute: true },
  });
  vi.mocked(promptCacheApi.fetchPromptCacheCapabilities).mockResolvedValue({
    capabilities: SAMPLE_CAPABILITIES,
  });
  vi.mocked(promptCacheApi.putPromptCacheCapability).mockResolvedValue({
    capability: {
      platform: 'openai',
      modelPattern: 'gpt-4o*',
      mode: 'implicit',
      maxBreakpoints: 0,
      minTokens: 1024,
      ttlSeconds: 300,
      source: 'override',
      updatedAt: '2026-11-16 00:00:00',
    },
  });
  vi.mocked(promptCacheApi.deletePromptCacheCapability).mockResolvedValue({ deleted: true });
  vi.mocked(promptCacheApi.fetchPromptCacheStats).mockResolvedValue(SAMPLE_STATS_DAY);

  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  qc.clear();
  container.remove();
  vi.clearAllMocks();
});

describe('Prompt Cache i18n strings', () => {
  it('has Vietnamese translations for every constant in prompt-cache-strings.ts and preserves placeholders', () => {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(promptCacheStrings)) {
      if (typeof value !== 'string') continue;
      expect(value.trim().length, `${name} must not be empty`).toBeGreaterThan(0);
      if (!(value in VI)) {
        missing.push(`${name}: "${value}"`);
      } else {
        const known = new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
        for (const m of VI[value].matchAll(/\{(\w+)\}/g)) {
          expect(known.has(m[1]), `Unknown placeholder {${m[1]}} in VI["${value}"]`).toBe(true);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('Prompt Cache RBAC & AiPlatformApp routing', () => {
  it('allows view_prompt_cache-only user into PromptCache via AiPlatformApp and locks edit controls', async () => {
    actor.perms.add('view_prompt_cache');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/prompt-cache']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompt-cache-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="prompt-cache-view-only-notice"]')).not.toBeNull();
    expect(promptCacheApi.fetchPromptCacheSettings).toHaveBeenCalledTimes(1);
    expect(promptCacheApi.fetchPromptCacheCapabilities).toHaveBeenCalledTimes(1);
    expect(promptCacheApi.fetchPromptCacheStats).toHaveBeenCalledTimes(1);

    const forwardSw = container.querySelector('[data-testid="cache-setting-forward"]') as HTMLButtonElement;
    const autoBpSw = container.querySelector('[data-testid="cache-setting-auto-breakpoints"]') as HTMLButtonElement;
    const stickySw = container.querySelector('[data-testid="cache-setting-sticky-route"]') as HTMLButtonElement;
    const saveSettingsBtn = container.querySelector('[data-testid="cache-save-settings-btn"]') as HTMLButtonElement;
    const saveOverrideBtn = container.querySelector('[data-testid="cache-override-save-btn"]') as HTMLButtonElement;
    const deleteOverrideBtn = container.querySelector(
      '[data-testid="cache-cap-delete-openrouter-anthropic/claude-*"]',
    ) as HTMLButtonElement;

    expect(forwardSw.disabled).toBe(true);
    expect(autoBpSw.disabled).toBe(true);
    expect(stickySw.disabled).toBe(true);
    expect(saveSettingsBtn.disabled).toBe(true);
    expect(saveOverrideBtn.disabled).toBe(true);
    expect(deleteOverrideBtn.disabled).toBe(true);
  });

  it('does NOT grant prompt-cache access to manage_ai_platform alone', async () => {
    actor.perms.add('manage_ai_platform');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/prompt-cache']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompt-cache-page"]')).toBeNull();
    expect(promptCacheApi.fetchPromptCacheSettings).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheCapabilities).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheStats).not.toHaveBeenCalled();
  });

  it('shows no-access notice and fires zero GETs when PromptCache is rendered without permissions', async () => {
    renderEl(<PromptCache />);
    await flush();

    expect(container.querySelector('[data-testid="prompt-cache-no-permission"]')).not.toBeNull();
    expect(promptCacheApi.fetchPromptCacheSettings).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheCapabilities).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheStats).not.toHaveBeenCalled();
  });

  it('does NOT fire GET requests for edit_prompt_cache-only user and allows submitting settings', async () => {
    actor.perms.add('edit_prompt_cache');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="prompt-cache-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="prompt-cache-editor-only-notice"]')).not.toBeNull();
    expect(promptCacheApi.fetchPromptCacheSettings).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheCapabilities).not.toHaveBeenCalled();
    expect(promptCacheApi.fetchPromptCacheStats).not.toHaveBeenCalled();

    const autoBpSw = container.querySelector('[data-testid="cache-setting-auto-breakpoints"]') as HTMLButtonElement;
    const saveSettingsBtn = container.querySelector('[data-testid="cache-save-settings-btn"]') as HTMLButtonElement;
    expect(autoBpSw.disabled).toBe(false);
    expect(saveSettingsBtn.disabled).toBe(false);

    act(() => {
      autoBpSw.click();
    });
    act(() => {
      saveSettingsBtn.click();
    });
    await flush();

    expect(promptCacheApi.putPromptCacheSettings).toHaveBeenCalledWith(
      { forward: true, autoBreakpoints: true, preferStickyRoute: false },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="cache-settings-saved"]')).not.toBeNull();
  });
});

describe('Prompt Cache settings section', () => {
  it('toggles forward, autoBreakpoints, preferStickyRoute and handles 403/500 without showing saved', async () => {
    actor.perms.add('view_prompt_cache');
    actor.perms.add('edit_prompt_cache');

    renderEl(<PromptCache />);
    await flush();

    const forwardSw = container.querySelector('[data-testid="cache-setting-forward"]') as HTMLButtonElement;
    const autoBpSw = container.querySelector('[data-testid="cache-setting-auto-breakpoints"]') as HTMLButtonElement;
    const stickySw = container.querySelector('[data-testid="cache-setting-sticky-route"]') as HTMLButtonElement;
    const saveBtn = container.querySelector('[data-testid="cache-save-settings-btn"]') as HTMLButtonElement;

    expect(forwardSw.getAttribute('aria-checked')).toBe('true');
    expect(autoBpSw.getAttribute('aria-checked')).toBe('false');
    expect(stickySw.getAttribute('aria-checked')).toBe('false');
    expect(container.textContent).toMatch(/advisory/i);

    act(() => {
      autoBpSw.click();
      stickySw.click();
    });
    expect(autoBpSw.getAttribute('aria-checked')).toBe('true');
    expect(stickySw.getAttribute('aria-checked')).toBe('true');

    // 403 error must NOT show saved
    vi.mocked(promptCacheApi.putPromptCacheSettings).mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    );
    act(() => {
      saveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="cache-settings-saved"]')).toBeNull();
    expect(container.querySelector('[data-testid="cache-settings-error"]')).not.toBeNull();

    // 500 error must NOT show saved
    vi.mocked(promptCacheApi.putPromptCacheSettings).mockRejectedValueOnce(
      Object.assign(new Error('Internal Server Error'), { status: 500 }),
    );
    act(() => {
      saveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="cache-settings-saved"]')).toBeNull();
    expect(container.querySelector('[data-testid="cache-settings-error"]')?.textContent).toContain('Internal Server Error');

    // Success save
    vi.mocked(promptCacheApi.putPromptCacheSettings).mockResolvedValueOnce({
      settings: { forward: true, autoBreakpoints: true, preferStickyRoute: true },
    });
    act(() => {
      saveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="cache-settings-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="cache-settings-saved"]')).not.toBeNull();
  });
});

describe('Prompt Cache stats & chart section', () => {
  it('renders summary cards, SVG chart, and table; refetches when days and groupBy change', async () => {
    actor.perms.add('view_prompt_cache');
    renderEl(<PromptCache />);
    await flush();

    expect(container.querySelector('[data-testid="cache-summary-requests"]')?.textContent).toContain('200');
    expect(container.querySelector('[data-testid="cache-summary-hit-rate"]')?.textContent).toContain('%');
    expect(container.querySelector('[data-testid="cache-summary-read-tokens"]')?.textContent).toContain('200,000');
    expect(container.querySelector('[data-testid="cache-summary-write-tokens"]')?.textContent).toContain('15,000');
    expect(container.querySelector('[data-testid="cache-summary-est-saved"]')?.textContent).toContain('$0.70');

    const chart = container.querySelector('[data-testid="cache-stats-chart"]');
    expect(chart).not.toBeNull();
    expect(chart?.querySelector('svg')).not.toBeNull();
    expect(chart?.querySelectorAll('rect').length).toBeGreaterThanOrEqual(2);

    const table = container.querySelector('[data-testid="cache-stats-table"]');
    expect(table?.textContent).toContain('2026-11-14');
    expect(table?.textContent).toContain('2026-11-15');

    // Change days to 7 and groupBy to model
    vi.mocked(promptCacheApi.fetchPromptCacheStats).mockResolvedValueOnce({
      days: 7,
      groupBy: 'day',
      rows: [],
    });
    const daysSelect = container.querySelector('[data-testid="cache-stats-days-select"]') as HTMLSelectElement;
    act(() => {
      setSelectValue(daysSelect, '7');
    });
    await flush();
    expect(promptCacheApi.fetchPromptCacheStats).toHaveBeenLastCalledWith(
      { days: 7, groupBy: 'day' },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="cache-stats-empty"]')).not.toBeNull();

    vi.mocked(promptCacheApi.fetchPromptCacheStats).mockResolvedValueOnce({
      days: 7,
      groupBy: 'model',
      rows: [
        {
          key: 'claude-3-5-sonnet-20241022',
          requests: 50,
          requestsWithHit: 40,
          hitRate: 0.82,
          requestHitRate: 0.8,
          inputTokens: 10_000,
          cacheReadTokens: 45_000,
          cacheWriteTokens: 2_000,
          estSavedUsd: 0.19,
        },
      ],
    });
    const groupBySelect = container.querySelector('[data-testid="cache-stats-groupby-select"]') as HTMLSelectElement;
    act(() => {
      setSelectValue(groupBySelect, 'model');
    });
    await flush();
    expect(promptCacheApi.fetchPromptCacheStats).toHaveBeenLastCalledWith(
      { days: 7, groupBy: 'model' },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="cache-stats-table"]')?.textContent).toContain('claude-3-5-sonnet-20241022');
  });
});

describe('Prompt Cache capabilities table & overrides', () => {
  it('renders builtin and override rows, adds an override, deletes an override, and handles errors', async () => {
    actor.perms.add('view_prompt_cache');
    actor.perms.add('edit_prompt_cache');

    renderEl(<PromptCache />);
    await flush();

    const table = container.querySelector('[data-testid="cache-capabilities-table"]');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('anthropic');
    expect(table?.textContent).toContain('claude-*');
    expect(table?.textContent).toContain('openrouter');
    expect(table?.textContent).toContain('anthropic/claude-*');

    // Builtin row should NOT have a delete button, override row SHOULD
    expect(container.querySelector('[data-testid="cache-cap-delete-anthropic-claude-*"]')).toBeNull();
    expect(container.querySelector('[data-testid="cache-cap-delete-openrouter-anthropic/claude-*"]')).not.toBeNull();

    // Add override
    const platformInput = container.querySelector('[data-testid="cache-override-platform-input"]') as HTMLInputElement;
    const patternInput = container.querySelector('[data-testid="cache-override-pattern-input"]') as HTMLInputElement;
    const modeSelect = container.querySelector('[data-testid="cache-override-mode-select"]') as HTMLSelectElement;
    const saveOverrideBtn = container.querySelector('[data-testid="cache-override-save-btn"]') as HTMLButtonElement;

    act(() => {
      setInputValue(platformInput, 'openai');
      setInputValue(patternInput, 'gpt-4o*');
      setSelectValue(modeSelect, 'implicit');
    });

    vi.mocked(promptCacheApi.fetchPromptCacheCapabilities).mockResolvedValueOnce({
      capabilities: [
        ...SAMPLE_CAPABILITIES,
        {
          platform: 'openai',
          modelPattern: 'gpt-4o*',
          mode: 'implicit',
          maxBreakpoints: 4,
          minTokens: 1024,
          ttlSeconds: 300,
          source: 'override',
          updatedAt: '2026-11-16 00:00:00',
        },
      ],
    });

    act(() => {
      saveOverrideBtn.click();
    });
    await flush();

    expect(promptCacheApi.putPromptCacheCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'openai',
        modelPattern: 'gpt-4o*',
        mode: 'implicit',
      }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="cache-override-saved"]')).not.toBeNull();

    // Delete override error -> does not show deleted
    vi.mocked(promptCacheApi.deletePromptCacheCapability).mockRejectedValueOnce(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    );
    const deleteBtn = container.querySelector(
      '[data-testid="cache-cap-delete-openrouter-anthropic/claude-*"]',
    ) as HTMLButtonElement;
    act(() => {
      deleteBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="cache-override-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="cache-override-deleted"]')).toBeNull();

    // Delete override success
    vi.mocked(promptCacheApi.fetchPromptCacheCapabilities).mockResolvedValueOnce({
      capabilities: [SAMPLE_CAPABILITIES[0]],
    });
    act(() => {
      deleteBtn.click();
    });
    await flush();
    expect(promptCacheApi.deletePromptCacheCapability).toHaveBeenLastCalledWith(
      { platform: 'openrouter', modelPattern: 'anthropic/claude-*' },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="cache-override-deleted"]')).not.toBeNull();
  });
});

describe('Prompt Cache abort & session isolation', () => {
  it('aborts in-flight requests on unmount and ignores late resolves after session change', async () => {
    actor.perms.add('view_prompt_cache');
    actor.perms.add('edit_prompt_cache');

    let resolveLateSettings!: (val: promptCacheApi.PromptCacheSettingsResponse) => void;
    vi.mocked(promptCacheApi.fetchPromptCacheSettings).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveLateSettings = resolve;
      }),
    );

    renderEl(<PromptCache />);
    await flush();

    const firstSignal = vi.mocked(promptCacheApi.fetchPromptCacheSettings).mock.calls[0][0]!;
    expect(firstSignal.aborted).toBe(false);

    // Change session userId -> aborts previous request and resets state
    actor.userId = 2;
    vi.mocked(promptCacheApi.fetchPromptCacheSettings).mockResolvedValueOnce({
      settings: { forward: false, autoBreakpoints: true, preferStickyRoute: false },
    });
    renderEl(<PromptCache />);
    await flush();

    expect(firstSignal.aborted).toBe(true);
    const forwardSw = container.querySelector('[data-testid="cache-setting-forward"]') as HTMLButtonElement;
    expect(forwardSw.getAttribute('aria-checked')).toBe('false');

    // Late resolution from session 1 must NOT overwrite session 2
    await act(async () => {
      resolveLateSettings({
        settings: { forward: true, autoBreakpoints: false, preferStickyRoute: true },
      });
    });
    await flush();
    expect(forwardSw.getAttribute('aria-checked')).toBe('false');

    // Unmount aborts any new in-flight request
    let pendingSignal: AbortSignal | undefined;
    vi.mocked(promptCacheApi.putPromptCacheSettings).mockImplementationOnce((_patch, signal) => {
      pendingSignal = signal;
      return new Promise(() => {});
    });
    const saveBtn = container.querySelector('[data-testid="cache-save-settings-btn"]') as HTMLButtonElement;
    act(() => {
      saveBtn.click();
    });
    expect(pendingSignal?.aborted).toBe(false);

    act(() => {
      root.unmount();
    });
    expect(pendingSignal?.aborted).toBe(true);
    // Recreate root so afterEach doesn't fail on double unmount
    root = createRoot(container);
  });
});
