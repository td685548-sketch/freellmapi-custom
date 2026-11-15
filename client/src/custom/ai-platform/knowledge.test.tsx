// @vitest-environment jsdom
/**
 * T086 — AI Platform Knowledge & Semantic Retrieval UI tests
 * (native createRoot/act, zero @testing-library/react).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { Knowledge } from './pages/Knowledge';
import * as knowledgeApi from './knowledge-api';
import * as knowledgeStrings from './knowledge-strings';

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

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getToken: () => 'test-token',
  clearToken: vi.fn(),
  UNAUTHORIZED_EVENT: 'freellmapi:unauthorized',
}));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    fetchOverview: vi.fn().mockResolvedValue({
      flags: {
        prompts: false,
        retrieval: true,
        promptCache: false,
        mcpClient: false,
        outputGuard: false,
        orchestrator: false,
      },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: false, ready: false, summary: '' },
        retrieval: { enabled: true, ready: true, summary: 'Ready' },
        promptCache: { enabled: false, ready: false, summary: '' },
        mcpClient: { enabled: false, ready: false, summary: '' },
        outputGuard: { enabled: false, ready: false, summary: '' },
        orchestrator: { enabled: false, ready: false, summary: '' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./knowledge-api', async () => {
  const actual = await vi.importActual<typeof import('./knowledge-api')>('./knowledge-api');
  return {
    ...actual,
    fetchRetrievalScope: vi.fn(),
    updateRetrievalSettings: vi.fn(),
    triggerRetrievalReindex: vi.fn(),
    runRetrievalTestQuery: vi.fn(),
    fetchRetrievalUsage: vi.fn(),
  };
});

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function renderEl(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
  });
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function makeScopeStatus(
  overrides: Partial<knowledgeApi.RetrievalScopeStatusResponse> = {},
): knowledgeApi.RetrievalScopeStatusResponse {
  const base = knowledgeApi.createDefaultRetrievalStatus('profile', '1');
  return {
    ...base,
    settings: {
      ...base.settings,
      mode: 'hybrid',
      embeddingModel: 'text-embedding-3-small',
      dimensions: 1536,
      topK: 5,
      minScore: 0.25,
      citationsEnabled: true,
      updatedAt: '2026-11-15T10:00:00.000Z',
    },
    index: {
      generation: 3,
      totalChunks: 40,
      readyChunks: 38,
      pendingChunks: 2,
      errorChunks: 0,
      staleChunks: 0,
      ready: false,
      percentComplete: 95,
      indexedModel: 'text-embedding-3-small',
      indexedDimensions: 1536,
    },
    activeJob: null,
    recentJobs: [
      {
        id: 11,
        scopeKind: 'profile',
        scopeId: '1',
        reason: 'reindex',
        status: 'succeeded',
        model: 'text-embedding-3-small',
        totalChunks: 40,
        processedChunks: 40,
        lastError: null,
        retryAfter: null,
        createdAt: '2026-11-15T09:50:00.000Z',
        updatedAt: '2026-11-15T09:51:00.000Z',
      },
    ],
    availableModels: [
      {
        family: 'openai',
        modelId: 'text-embedding-3-small',
        displayName: 'Text Embedding 3 Small',
        dimensions: 1536,
        platform: 'openai',
      },
      {
        family: 'bge',
        modelId: 'bge-m3',
        displayName: 'BGE M3',
        dimensions: 1024,
        platform: 'freeinference',
      },
    ],
    ...overrides,
  };
}

function makeUsage(
  overrides: Partial<knowledgeApi.RetrievalUsageResponse> = {},
): knowledgeApi.RetrievalUsageResponse {
  return {
    from: '2026-10-17',
    to: '2026-11-15',
    days: 30,
    totals: {
      inputTokens: 12400,
      requests: 19,
      indexTokens: 10000,
      queryTokens: 2400,
    },
    rows: [
      {
        day: '2026-11-15',
        scopeKind: 'profile',
        scopeId: '1',
        model: 'text-embedding-3-small',
        purpose: 'index',
        inputTokens: 10000,
        requests: 4,
      },
      {
        day: '2026-11-15',
        scopeKind: 'profile',
        scopeId: '1',
        model: 'text-embedding-3-small',
        purpose: 'query',
        inputTokens: 2400,
        requests: 15,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms.clear();
  actor.isPrimary = false;
  actor.userId = 1;

  vi.mocked(knowledgeApi.fetchRetrievalScope).mockResolvedValue(makeScopeStatus());
  vi.mocked(knowledgeApi.fetchRetrievalUsage).mockResolvedValue(makeUsage());

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Knowledge i18n strings', () => {
  it('provides Vietnamese translations with matching placeholders for every knowledge-strings constant', () => {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(knowledgeStrings)) {
      if (typeof value !== 'string') continue;
      const translated = VI[value];
      if (!translated) {
        missing.push(`${name}: "${value}"`);
        continue;
      }
      const enVars = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const viVars = [...translated.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(viVars, `Mismatched placeholders for "${value}"`).toEqual(enVars);
    }
    expect(missing).toEqual([]);
  });
});

describe('Knowledge permissions & AiPlatformApp routing', () => {
  it('renders Knowledge page via AiPlatformApp for view_retrieval user with edit/reindex disabled', async () => {
    actor.perms.add('view_retrieval');

    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/knowledge']}>
        <AiPlatformApp />
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="knowledge-page"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Not yet implemented');
    expect(knowledgeApi.fetchRetrievalScope).toHaveBeenCalledWith(
      'profile',
      '1',
      expect.any(AbortSignal),
    );
    expect(knowledgeApi.fetchRetrievalUsage).toHaveBeenCalledTimes(1);

    const saveBtn = container.querySelector(
      '[data-testid="knowledge-save-settings-btn"]',
    ) as HTMLButtonElement;
    const reindexBtn = container.querySelector(
      '[data-testid="knowledge-reindex-btn"]',
    ) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    expect(reindexBtn.disabled).toBe(true);
    expect(container.querySelector('[data-testid="knowledge-view-only-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="knowledge-usage-total-tokens"]')?.textContent).toBe(
      '12400',
    );
  });

  it('disables edit, reindex, and query controls when explicit permission props deny them', async () => {
    actor.perms.add('view_retrieval');

    renderEl(<Knowledge canView={true} canEdit={false} canReindex={false} canQuery={false} />);
    await flush();

    const saveBtn = container.querySelector(
      '[data-testid="knowledge-save-settings-btn"]',
    ) as HTMLButtonElement;
    const reindexBtn = container.querySelector(
      '[data-testid="knowledge-reindex-btn"]',
    ) as HTMLButtonElement;
    const queryInput = container.querySelector(
      '[data-testid="knowledge-query-input"]',
    ) as HTMLTextAreaElement;
    const queryRunBtn = container.querySelector(
      '[data-testid="knowledge-query-run-btn"]',
    ) as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(true);
    expect(reindexBtn.disabled).toBe(true);
    expect(queryInput.disabled).toBe(true);
    expect(queryRunBtn.disabled).toBe(true);
  });

  it('denies access and makes zero retrieval API calls when user lacks retrieval permissions', async () => {
    actor.perms.add('manage_ai_platform');

    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/knowledge']}>
        <AiPlatformApp />
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="knowledge-page"]')).toBeNull();
    expect(knowledgeApi.fetchRetrievalScope).not.toHaveBeenCalled();
    expect(knowledgeApi.fetchRetrievalUsage).not.toHaveBeenCalled();
  });

  it('does not issue unauthorized GET requests for edit_retrieval-only user', async () => {
    actor.perms.add('edit_retrieval');

    renderEl(
      <MemoryRouter initialEntries={['/ai-platform']}>
        <AiPlatformApp />
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="knowledge-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="knowledge-view-required-notice"]')).not.toBeNull();
    expect(knowledgeApi.fetchRetrievalScope).not.toHaveBeenCalled();
    expect(knowledgeApi.fetchRetrievalUsage).not.toHaveBeenCalled();

    const saveBtn = container.querySelector(
      '[data-testid="knowledge-save-settings-btn"]',
    ) as HTMLButtonElement;
    const reindexBtn = container.querySelector(
      '[data-testid="knowledge-reindex-btn"]',
    ) as HTMLButtonElement;
    const queryBtn = container.querySelector(
      '[data-testid="knowledge-query-run-btn"]',
    ) as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(false);
    expect(reindexBtn.disabled).toBe(false);
    expect(queryBtn.disabled).toBe(true);
  });
});

describe('Knowledge actions: settings PUT, reindex POST, test query POST', () => {
  it('saves updated settings, triggers reindex, and runs test query with hits and citations', async () => {
    actor.perms.add('view_retrieval');
    actor.perms.add('edit_retrieval');

    vi.mocked(knowledgeApi.updateRetrievalSettings).mockResolvedValueOnce(
      makeScopeStatus({
        settings: {
          scopeKind: 'profile',
          scopeId: '1',
          mode: 'semantic',
          embeddingModel: 'bge-m3',
          dimensions: 1024,
          topK: 8,
          minScore: 0.4,
          citationsEnabled: false,
          updatedAt: '2026-11-15T12:00:00.000Z',
        },
      }),
    );

    vi.mocked(knowledgeApi.triggerRetrievalReindex).mockResolvedValueOnce({
      ok: true,
      job: {
        id: 77,
        scopeKind: 'profile',
        scopeId: '1',
        reason: 'reindex',
        status: 'queued',
        model: 'bge-m3',
        totalChunks: 40,
        processedChunks: 0,
        lastError: null,
        retryAfter: null,
        createdAt: '2026-11-15T12:01:00.000Z',
        updatedAt: '2026-11-15T12:01:00.000Z',
      },
    });

    vi.mocked(knowledgeApi.runRetrievalTestQuery).mockResolvedValueOnce({
      scope: { kind: 'profile', id: '1' },
      query: 'refund policy',
      modeRequested: 'hybrid',
      modeUsed: 'keyword',
      degraded: true,
      degradedReason: 'index_not_ready',
      latencyMs: 18,
      indexGeneration: 3,
      hits: [
        {
          docId: 'doc-9',
          chunkId: 2,
          ord: 1,
          title: 'Billing FAQ',
          snippet: 'Refunds are issued within 7 business days.',
          text: 'Refunds are issued within 7 business days.',
          score: 0.875,
          keywordRank: 1,
          sources: ['keyword'],
        },
      ],
      citations: [
        {
          docId: 'doc-9',
          chunkId: 2,
          title: 'Billing FAQ',
          score: 0.875,
          snippet: 'Refunds are issued within 7 business days.',
        },
      ],
    });

    renderEl(<Knowledge />);
    await flush();

    // Update settings
    const modeSelect = container.querySelector(
      '[data-testid="knowledge-mode-select"]',
    ) as HTMLSelectElement;
    const modelSelect = container.querySelector(
      '[data-testid="knowledge-model-select"]',
    ) as HTMLSelectElement;
    const topKInput = container.querySelector(
      '[data-testid="knowledge-topk-input"]',
    ) as HTMLInputElement;
    const minScoreInput = container.querySelector(
      '[data-testid="knowledge-minscore-input"]',
    ) as HTMLInputElement;
    const citationsCheckbox = container.querySelector(
      '[data-testid="knowledge-citations-checkbox"]',
    ) as HTMLInputElement;
    const saveBtn = container.querySelector(
      '[data-testid="knowledge-save-settings-btn"]',
    ) as HTMLButtonElement;

    act(() => {
      setSelectValue(modeSelect, 'semantic');
      setSelectValue(modelSelect, 'bge-m3');
      setInputValue(topKInput, '8');
      setInputValue(minScoreInput, '0.4');
      citationsCheckbox.click();
    });
    act(() => {
      saveBtn.click();
    });
    await flush();

    expect(knowledgeApi.updateRetrievalSettings).toHaveBeenCalledWith(
      'profile',
      '1',
      {
        mode: 'semantic',
        embeddingModel: 'bge-m3',
        dimensions: 1024,
        topK: 8,
        minScore: 0.4,
        citationsEnabled: false,
      },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="knowledge-save-success"]')?.textContent).toBe(
      knowledgeStrings.KNOWLEDGE_SETTINGS_SAVED,
    );

    // Trigger reindex
    const reindexBtn = container.querySelector(
      '[data-testid="knowledge-reindex-btn"]',
    ) as HTMLButtonElement;
    act(() => {
      reindexBtn.click();
    });
    await flush();

    expect(knowledgeApi.triggerRetrievalReindex).toHaveBeenCalledWith(
      'profile',
      '1',
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="knowledge-active-job"]')?.textContent).toContain(
      '#77',
    );
    expect(reindexBtn.disabled).toBe(true);

    // Run test query
    const queryInput = container.querySelector(
      '[data-testid="knowledge-query-input"]',
    ) as HTMLTextAreaElement;
    const queryRunBtn = container.querySelector(
      '[data-testid="knowledge-query-run-btn"]',
    ) as HTMLButtonElement;

    act(() => {
      setInputValue(queryInput, 'refund policy');
    });
    act(() => {
      queryRunBtn.click();
    });
    await flush();

    expect(knowledgeApi.runRetrievalTestQuery).toHaveBeenCalledWith(
      'profile',
      '1',
      { query: 'refund policy' },
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="knowledge-query-degraded"]')?.textContent).toContain(
      'Vector index not ready',
    );
    expect(container.querySelector('[data-testid="knowledge-query-hits"]')?.textContent).toContain(
      'Billing FAQ',
    );
    expect(
      container.querySelector('[data-testid="knowledge-query-citations"]')?.textContent,
    ).toContain('doc-9#2');
  });

  it('displays graceful message when test query returns 409 pillar_disabled', async () => {
    actor.perms.add('view_retrieval');

    vi.mocked(knowledgeApi.runRetrievalTestQuery).mockRejectedValueOnce(
      new knowledgeApi.KnowledgeApiError('Retrieval pillar is disabled.', {
        status: 409,
        code: 'pillar_disabled',
      }),
    );

    renderEl(<Knowledge />);
    await flush();

    const queryInput = container.querySelector(
      '[data-testid="knowledge-query-input"]',
    ) as HTMLTextAreaElement;
    const queryRunBtn = container.querySelector(
      '[data-testid="knowledge-query-run-btn"]',
    ) as HTMLButtonElement;

    act(() => {
      setInputValue(queryInput, 'how to configure webhook');
    });
    act(() => {
      queryRunBtn.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="knowledge-query-error"]')?.textContent).toBe(
      knowledgeStrings.KNOWLEDGE_QUERY_PILLAR_DISABLED,
    );
  });
});

describe('Knowledge async safety & structured error client', () => {
  it('ignores stale scope response and aborts earlier request across scope switches', async () => {
    actor.perms.add('view_retrieval');
    actor.perms.add('edit_retrieval');

    let resolveFirstScope!: (val: knowledgeApi.RetrievalScopeStatusResponse) => void;
    const firstScopePromise = new Promise<knowledgeApi.RetrievalScopeStatusResponse>((resolve) => {
      resolveFirstScope = resolve;
    });

    vi.mocked(knowledgeApi.fetchRetrievalScope)
      .mockImplementationOnce(() => firstScopePromise)
      .mockResolvedValueOnce(
        makeScopeStatus({
          scope: { kind: 'support_tenant', id: '42' },
          settings: {
            scopeKind: 'support_tenant',
            scopeId: '42',
            mode: 'keyword',
            embeddingModel: null,
            dimensions: 768,
            topK: 3,
            minScore: 0.6,
            citationsEnabled: false,
            updatedAt: null,
          },
          index: {
            generation: 9,
            totalChunks: 12,
            readyChunks: 12,
            pendingChunks: 0,
            errorChunks: 0,
            staleChunks: 0,
            ready: true,
            percentComplete: 100,
            indexedModel: 'bge-m3',
            indexedDimensions: 768,
          },
        }),
      );

    renderEl(<Knowledge />);
    await flush();

    const firstSignal = vi.mocked(knowledgeApi.fetchRetrievalScope).mock.calls[0]?.[2];
    expect(firstSignal).toBeDefined();
    expect(firstSignal?.aborted).toBe(false);

    // Switch scope ID & kind and click Load before first request finishes
    const kindSelect = container.querySelector(
      '[data-testid="knowledge-scope-kind-select"]',
    ) as HTMLSelectElement;
    const idInput = container.querySelector(
      '[data-testid="knowledge-scope-id-input"]',
    ) as HTMLInputElement;
    const loadBtn = container.querySelector(
      '[data-testid="knowledge-load-scope-btn"]',
    ) as HTMLButtonElement;

    act(() => {
      setSelectValue(kindSelect, 'support_tenant');
    });
    act(() => {
      setInputValue(idInput, '42');
    });
    act(() => {
      loadBtn.click();
    });
    await flush();

    expect(firstSignal?.aborted).toBe(true);
    expect(container.querySelector('[data-testid="knowledge-index-generation"]')?.textContent).toBe(
      '9',
    );
    expect(
      (container.querySelector('[data-testid="knowledge-topk-input"]') as HTMLInputElement).value,
    ).toBe('3');

    // Now resolve the stale first response — newer scope state must stay intact
    await act(async () => {
      resolveFirstScope(
        makeScopeStatus({
          scope: { kind: 'profile', id: '1' },
          settings: {
            scopeKind: 'profile',
            scopeId: '1',
            mode: 'semantic',
            embeddingModel: 'stale-model',
            dimensions: 3072,
            topK: 17,
            minScore: 0.1,
            citationsEnabled: true,
            updatedAt: null,
          },
          index: {
            generation: 99,
            totalChunks: 500,
            readyChunks: 100,
            pendingChunks: 400,
            errorChunks: 0,
            staleChunks: 0,
            ready: false,
            percentComplete: 20,
            indexedModel: 'stale-model',
            indexedDimensions: 3072,
          },
        }),
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="knowledge-index-generation"]')?.textContent).toBe(
      '9',
    );
    expect(
      (container.querySelector('[data-testid="knowledge-topk-input"]') as HTMLInputElement).value,
    ).toBe('3');
  });

  it('knowledge-api preserves HTTP status and code in KnowledgeApiError', async () => {
    const actualApi = await vi.importActual<typeof import('./knowledge-api')>('./knowledge-api');
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        error: {
          type: 'conflict',
          code: 'pillar_disabled',
          message: 'Retrieval pillar is disabled.',
        },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    let caught: unknown;
    try {
      await actualApi.runRetrievalTestQuery('support_tenant', '5', { query: 'hello' });
    } catch (err) {
      caught = err;
    }

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai-platform/retrieval/support-tenant/5/query',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(caught).toBeInstanceOf(actualApi.KnowledgeApiError);
    expect((caught as knowledgeApi.KnowledgeApiError).status).toBe(409);
    expect((caught as knowledgeApi.KnowledgeApiError).code).toBe('pillar_disabled');
  });
});
