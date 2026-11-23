// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import { apiFetch } from '@/lib/api';
import type { Permission, UserSession } from '../../../../shared/user-access';
import { AiPlatformApp } from './AiPlatformApp';
import { SemanticCache } from './pages/SemanticCache';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  // Phase 2: the api modules read the CSRF token from here, never a
  // dashboard token (there is no getToken/clearToken any more).
  getCsrfToken: () => null,
  CSRF_HEADER_NAME: 'X-CSRF-Token',
  UNAUTHORIZED_EVENT: 'freellmapi:unauthorized',
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function flushUi(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function makeSession(permissions: Permission[], isPrimary = false): UserSession {
  return {
    userId: 7,
    email: 'operator@example.com',
    role: isPrimary ? 'admin' : 'member',
    isPrimary,
    permissions,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Spec 030 — SemanticCache UI', () => {
  it('blocks API calls and shows no-permission notice when user lacks prompt cache permissions', async () => {
    vi.mocked(apiFetch).mockResolvedValue(makeSession(['view_ai_platform']));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <MemoryRouter>
              <SemanticCache />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushUi();

    expect(container.querySelector('[data-testid="semantic-cache-no-permission"]')).not.toBeNull();
    expect(container.textContent).toContain(
      'You do not have permission to view semantic cache settings',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('loads settings & stats, saves updated config, runs lookup preview, and flushes entries', async () => {
    vi.mocked(apiFetch).mockResolvedValue(makeSession(['view_prompt_cache', 'edit_prompt_cache']));

    let currentEnabled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.endsWith('/api/ai-platform/semantic-cache/profile/1/settings') && method === 'GET') {
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          settings: {
            scopeKind: 'profile',
            scopeId: '1',
            enabled: currentEnabled,
            semanticEnabled: true,
            minSimilarity: 0.94,
            maxTemperature: 0.2,
            ttlSeconds: 3600,
            maxEntries: 1000,
            persistToDb: true,
            isolateByEndUser: false,
            updatedAt: '2026-11-18T09:00:00.000Z',
          },
        });
      }

      if (url.endsWith('/api/ai-platform/semantic-cache/profile/1/settings') && method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { enabled?: boolean };
        currentEnabled = Boolean(body.enabled);
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          settings: {
            scopeKind: 'profile',
            scopeId: '1',
            enabled: currentEnabled,
            semanticEnabled: true,
            minSimilarity: 0.94,
            maxTemperature: 0.2,
            ttlSeconds: 3600,
            maxEntries: 1000,
            persistToDb: true,
            isolateByEndUser: false,
            updatedAt: '2026-11-18T09:05:00.000Z',
          },
        });
      }

      if (url.endsWith('/api/ai-platform/semantic-cache/profile/1/stats') && method === 'GET') {
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          stats: {
            exactHits: 12,
            semanticHits: 8,
            misses: 5,
            bypassed: 2,
            tokensSavedEst: 4820,
            entriesCount: 1,
            memoryEntriesCount: 1,
            hitRate: 0.8,
          },
          recentEntries: [
            {
              id: 'entry-1',
              scopeKind: 'profile',
              scopeId: '1',
              endUserScope: '',
              wire: 'openai-chat',
              model: 'gpt-4o-mini',
              contractHash: 'abcdef1234567890',
              promptVersionHash: '9876543210fedcba',
              exactHash: '1111222233334444',
              hasEmbedding: true,
              embeddingModel: 'gemini-embedding-001',
              embeddingDims: 768,
              tokensSaved: 240,
              hitCount: 4,
              createdAt: '2026-11-18T09:01:00.000Z',
              expiresAt: '2026-11-18T10:01:00.000Z',
            },
          ],
        });
      }

      if (
        url.endsWith('/api/ai-platform/semantic-cache/profile/1/lookup-preview') &&
        method === 'POST'
      ) {
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          status: 'SEMANTIC_HIT',
          score: 0.9712,
          contractHash: 'abcdef1234567890',
          promptVersionHash: '9876543210fedcba',
          exactHash: '5555666677778888',
          semanticAvailable: true,
          latencyMs: 6,
          matchedEntry: null,
          cachedResponsePreview: 'Go to Settings -> API Keys to rotate your credential.',
        });
      }

      if (url.endsWith('/api/ai-platform/semantic-cache/profile/1/flush') && method === 'POST') {
        return jsonResponse({
          ok: true,
          scope: { kind: 'profile', id: '1' },
          deletedEntries: 3,
          metricsReset: true,
        });
      }

      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="en">
            <MemoryRouter>
              <SemanticCache />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushUi();

    expect(
      container.querySelector('[data-testid="sem-cache-stat-exact-hits"]')?.textContent,
    ).toContain('12');
    expect(
      container.querySelector('[data-testid="sem-cache-stat-semantic-hits"]')?.textContent,
    ).toContain('8');
    expect(
      container.querySelector('[data-testid="sem-cache-stat-hit-rate"]')?.textContent,
    ).toContain('80.0%');
    expect(container.textContent).toContain('Ready (768d)');

    // Toggle enabled switch and save
    const enableToggle = container.querySelector(
      '[data-testid="sem-cache-toggle-enabled"]',
    ) as HTMLButtonElement;
    expect(enableToggle.getAttribute('aria-checked')).toBe('false');
    await act(async () => {
      enableToggle.click();
    });
    const saveBtn = container.querySelector(
      '[data-testid="sem-cache-save-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      saveBtn.click();
    });
    await flushUi();

    expect(container.textContent).toContain('Semantic cache settings saved');
    expect(enableToggle.getAttribute('aria-checked')).toBe('true');

    // Run lookup preview
    const queryTextarea = container.querySelector(
      '[data-testid="sem-cache-preview-query"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      setter?.call(queryTextarea, 'How can I rotate my key?');
      queryTextarea.dispatchEvent(new Event('input', { bubbles: true }));
      queryTextarea.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const previewBtn = container.querySelector(
      '[data-testid="sem-cache-preview-submit"]',
    ) as HTMLButtonElement;
    await act(async () => {
      previewBtn.click();
    });
    await flushUi();

    expect(
      container.querySelector('[data-testid="sem-cache-preview-status"]')?.textContent,
    ).toContain('SEMANTIC_HIT');
    expect(
      container.querySelector('[data-testid="sem-cache-preview-score"]')?.textContent,
    ).toContain('0.9712');
    expect(
      container.querySelector('[data-testid="sem-cache-preview-response"]')?.textContent,
    ).toContain('Go to Settings -> API Keys');

    // Flush cache
    const flushBtn = container.querySelector(
      '[data-testid="sem-cache-flush-btn"]',
    ) as HTMLButtonElement;
    await act(async () => {
      flushBtn.click();
    });
    await flushUi();

    expect(container.textContent).toContain('Flushed 3 cached entries');
  });

  it('renders bilingual Vietnamese UI and exposes the Semantic cache tab in AiPlatformApp', async () => {
    vi.mocked(apiFetch).mockResolvedValue(makeSession(['view_prompt_cache']));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/settings')) {
          return jsonResponse({
            scope: { kind: 'profile', id: '1' },
            settings: {
              scopeKind: 'profile',
              scopeId: '1',
              enabled: false,
              semanticEnabled: true,
              minSimilarity: 0.94,
              maxTemperature: 0.2,
              ttlSeconds: 3600,
              maxEntries: 1000,
              persistToDb: true,
              isolateByEndUser: false,
              updatedAt: null,
            },
          });
        }
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          stats: {
            exactHits: 0,
            semanticHits: 0,
            misses: 0,
            bypassed: 0,
            tokensSavedEst: 0,
            entriesCount: 0,
            memoryEntriesCount: 0,
            hitRate: 0,
          },
          recentEntries: [],
        });
      }),
    );

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider initialLocale="vi">
            <MemoryRouter initialEntries={['/ai-platform/semantic-cache']}>
              <Routes>
                <Route path="/ai-platform/*" element={<AiPlatformApp />} />
              </Routes>
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushUi();

    const text = container.textContent ?? '';
    expect(text).toContain('Bộ nhớ đệm ngữ nghĩa');
    expect(text).toContain('Bộ nhớ đệm phản hồi ngữ nghĩa đa phạm vi');
    expect(container.querySelector('[data-testid="semantic-cache-view-only-notice"]')).not.toBeNull();
  });
});
