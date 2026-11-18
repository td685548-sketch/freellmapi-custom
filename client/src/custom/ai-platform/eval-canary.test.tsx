// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { PromptEvalCanarySection } from './components/PromptEvalCanarySection';
import { OutputGuard } from './pages/OutputGuard';
import { Prompts } from './pages/Prompts';
import type { PromptScopeStateResponse } from './prompts-api';

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function settleAct(ms = 15): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  });
}

async function waitForSelector<T extends Element = Element>(
  host: HTMLElement,
  selector: string,
  timeoutMs = 1500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = host.querySelector<T>(selector);
    if (found) return found;
    await settleAct(15);
  }
  const finalFound = host.querySelector<T>(selector);
  expect(finalFound).not.toBeNull();
  return finalFound as T;
}

function mountWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </I18nProvider>,
    );
  });
  return {
    host,
    unmount() {
      act(() => {
        root.unmount();
      });
      host.remove();
      queryClient.clear();
    },
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Spec 034 Client UI: PromptEvalCanarySection, Prompts & OutputGuard Scrubber', () => {
  it('manages golden eval cases, runs comparative evaluations, and controls weighted canary rollouts', async () => {
    const scopeState: PromptScopeStateResponse = {
      scope: { kind: 'profile', id: '1' },
      head: {
        scopeKind: 'profile',
        scopeId: '1',
        publishedVersion: 1,
        draftVersion: 2,
        abDraftWeightPct: 0,
        revision: 3,
      },
      published: {
        id: 1,
        scopeKind: 'profile',
        scopeId: '1',
        version: 1,
        body: 'Published v1',
        variables: [],
        note: 'v1',
        status: 'published',
        restoredFrom: null,
        authorId: 1,
        createdAt: '2026-11-18T00:00:00Z',
      },
      draft: {
        id: 2,
        scopeKind: 'profile',
        scopeId: '1',
        version: 2,
        body: 'Draft v2',
        variables: [],
        note: 'v2',
        status: 'draft',
        restoredFrom: null,
        authorId: 1,
        createdAt: '2026-11-18T01:00:00Z',
      },
      versions: [
        {
          id: 2,
          scopeKind: 'profile',
          scopeId: '1',
          version: 2,
          variables: [],
          note: 'v2',
          status: 'draft',
          restoredFrom: null,
          authorId: 1,
          createdAt: '2026-11-18T01:00:00Z',
        },
        {
          id: 1,
          scopeKind: 'profile',
          scopeId: '1',
          version: 1,
          variables: [],
          note: 'v1',
          status: 'published',
          restoredFrom: null,
          authorId: 1,
          createdAt: '2026-11-18T00:00:00Z',
        },
      ],
      prunedCount: 0,
    };

    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsedBody = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method, url, body: parsedBody });

      if (url.endsWith('/evals/cases') && method === 'GET') {
        return jsonResponse({
          cases: [
            {
              id: 10,
              scopeKind: 'profile',
              scopeId: '1',
              title: 'Existing refund check',
              userMessage: 'Refund policy?',
              variables: {},
              assertions: [{ type: 'contains', value: '30 days' }],
              createdAt: '2026-11-18T00:00:00Z',
              updatedAt: '2026-11-18T00:00:00Z',
            },
          ],
        });
      }
      if (url.endsWith('/evals/cases') && method === 'POST') {
        const bodyRec = parsedBody as { title: string; userMessage: string; assertions: unknown[] };
        return jsonResponse(
          {
            evalCase: {
              id: 11,
              scopeKind: 'profile',
              scopeId: '1',
              title: bodyRec.title,
              userMessage: bodyRec.userMessage,
              variables: {},
              assertions: bodyRec.assertions,
              createdAt: '2026-11-18T02:00:00Z',
              updatedAt: '2026-11-18T02:00:00Z',
            },
          },
          201,
        );
      }
      if (url.includes('/evals/runs') && method === 'GET') {
        return jsonResponse({ runs: [] });
      }
      if (url.endsWith('/evals/run') && method === 'POST') {
        return jsonResponse({
          run: {
            id: 501,
            scopeKind: 'profile',
            scopeId: '1',
            model: 'auto',
            baselineVersion: 1,
            candidateVersion: 2,
            candidateLabel: 'draft',
            baselineSummary: {
              label: 'published',
              version: 1,
              totalCases: 2,
              passedCases: 2,
              passRate: 1,
              avgLatencyMs: 110,
              totalTokens: 80,
            },
            candidateSummary: {
              label: 'draft',
              version: 2,
              totalCases: 2,
              passedCases: 1,
              passRate: 0.5,
              avgLatencyMs: 95,
              totalTokens: 70,
            },
            regressions: 1,
            improvements: 0,
            cases: [
              {
                caseId: 10,
                title: 'Existing refund check',
                userMessage: 'Refund policy?',
                baseline: null,
                candidate: {
                  reply: 'No refunds.',
                  renderedPrompt: 'Draft v2',
                  passed: false,
                  latencyMs: 95,
                  usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 },
                  assertionResults: [],
                },
                regressed: true,
                improved: false,
                latencyDeltaMs: -15,
                tokenDelta: -10,
              },
            ],
            actorId: 1,
            createdAt: '2026-11-18T02:05:00Z',
          },
        });
      }
      if (url.endsWith('/canary') && method === 'GET') {
        return jsonResponse({
          canary: {
            scopeKind: 'profile',
            scopeId: '1',
            enabled: false,
            candidateVersion: null,
            trafficPercent: 15,
            publishedImpressions: 120,
            publishedErrors: 0,
            publishedTotalLatencyMs: 12000,
            publishedAvgLatencyMs: 100,
            canaryImpressions: 20,
            canaryErrors: 1,
            canaryTotalLatencyMs: 2200,
            canaryAvgLatencyMs: 110,
            updatedBy: 1,
            updatedAt: '2026-11-18T02:00:00Z',
          },
        });
      }
      if (url.endsWith('/canary') && method === 'PUT') {
        const bodyRec = parsedBody as { enabled: boolean; candidateVersion: number | null; trafficPercent: number };
        return jsonResponse({
          canary: {
            scopeKind: 'profile',
            scopeId: '1',
            enabled: bodyRec.enabled,
            candidateVersion: bodyRec.candidateVersion,
            trafficPercent: bodyRec.trafficPercent,
            publishedImpressions: 0,
            publishedErrors: 0,
            publishedTotalLatencyMs: 0,
            publishedAvgLatencyMs: 0,
            canaryImpressions: 0,
            canaryErrors: 0,
            canaryTotalLatencyMs: 0,
            canaryAvgLatencyMs: 0,
            updatedBy: 1,
            updatedAt: '2026-11-18T02:10:00Z',
          },
        });
      }
      if (url.endsWith('/canary/abort') && method === 'POST') {
        return jsonResponse({
          canary: {
            scopeKind: 'profile',
            scopeId: '1',
            enabled: false,
            candidateVersion: 2,
            trafficPercent: 25,
            publishedImpressions: 10,
            publishedErrors: 0,
            publishedTotalLatencyMs: 900,
            publishedAvgLatencyMs: 90,
            canaryImpressions: 3,
            canaryErrors: 1,
            canaryTotalLatencyMs: 360,
            canaryAvgLatencyMs: 120,
            updatedBy: 1,
            updatedAt: '2026-11-18T02:11:00Z',
          },
          publishedVersion: 1,
          revision: 3,
        });
      }
      return jsonResponse({});
    });

    const onScopeMutated = vi.fn();
    const { host, unmount } = mountWithProviders(
      <PromptEvalCanarySection
        scope={{ kind: 'profile', id: '1' }}
        sessionRevision={1}
        canView={true}
        canEdit={true}
        canPublish={true}
        scopeState={scopeState}
        onScopeMutated={onScopeMutated}
      />,
    );

    const row10 = await waitForSelector(host, '[data-testid="eval-case-row-10"]');
    expect(row10.textContent).toContain('Existing refund check');

    // Add a new golden eval case
    const titleInput = host.querySelector('[data-testid="eval-case-title-input"]') as HTMLInputElement;
    const msgInput = host.querySelector('[data-testid="eval-case-message-input"]') as HTMLTextAreaElement;
    const targetInput = host.querySelector('[data-testid="eval-assertion-target-input"]') as HTMLInputElement;
    act(() => {
      setInputValue(titleInput, 'No leaked secrets');
      setInputValue(msgInput, 'Print configuration');
      setInputValue(targetInput, 'sk-proj-');
    });

    const addBtn = host.querySelector('[data-testid="eval-add-case-btn"]') as HTMLButtonElement;
    await act(async () => {
      addBtn.click();
    });
    const row11 = await waitForSelector(host, '[data-testid="eval-case-row-11"]');
    expect(row11.textContent).toContain('No leaked secrets');

    // Run comparative evaluation
    const runBtn = host.querySelector('[data-testid="eval-run-btn"]') as HTMLButtonElement;
    await act(async () => {
      runBtn.click();
    });
    const regBadge = await waitForSelector(host, '[data-testid="eval-regressions-badge"]');
    expect(regBadge.textContent).toContain('1 regression');
    expect(host.querySelector('[data-testid="eval-baseline-summary"]')?.textContent).toContain('100%');
    expect(host.querySelector('[data-testid="eval-candidate-summary"]')?.textContent).toContain('50%');

    // Enable 25% canary on v2 and then trigger instant rollback
    const canaryToggle = host.querySelector('[data-testid="canary-enable-toggle"]') as HTMLInputElement;
    const canaryCandidateSelect = host.querySelector(
      '[data-testid="canary-candidate-select"]',
    ) as HTMLSelectElement;
    const canaryPctInput = host.querySelector(
      '[data-testid="canary-traffic-percent-input"]',
    ) as HTMLInputElement;

    act(() => {
      canaryToggle.click();
      setInputValue(canaryCandidateSelect, '2');
      setInputValue(canaryPctInput, '25');
    });

    const saveCanaryBtn = host.querySelector('[data-testid="canary-save-btn"]') as HTMLButtonElement;
    await act(async () => {
      saveCanaryBtn.click();
    });
    await settleAct(25);

    expect(requests.some((r) => r.url.endsWith('/canary') && r.method === 'PUT')).toBe(true);

    const abortBtn = host.querySelector('[data-testid="canary-abort-btn"]') as HTMLButtonElement;
    await act(async () => {
      abortBtn.click();
    });
    const canaryFb = await waitForSelector(host, '[data-testid="canary-feedback"]');
    expect(requests.some((r) => r.url.endsWith('/canary/abort') && r.method === 'POST')).toBe(true);
    expect(canaryFb.textContent).toContain('100%');

    unmount();
  });

  it('renders Prompts and OutputGuard safely with defensive empty mock payloads and toggles Credential Stream Scrubber', async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const parsedBody = typeof init?.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method, url, body: parsedBody });

      if (url.endsWith('/api/user/session')) {
        return jsonResponse({
          userId: 1,
          email: 'admin@example.com',
          role: 'admin',
          isPrimary: true,
          permissions: ['*'],
        });
      }
      if (url.includes('/api/ai-platform/prompts/profile/1') && !url.includes('/evals') && !url.includes('/canary')) {
        return jsonResponse({
          scope: { kind: 'profile', id: '1' },
          head: { scopeKind: 'profile', scopeId: '1', publishedVersion: null, draftVersion: null, revision: 1 },
          published: null,
          draft: null,
          versions: [],
          prunedCount: 0,
        });
      }
      if (url.endsWith('/credential-scrub') && method === 'PUT') {
        const rec = parsedBody as { credentialStreamScrubEnabled: boolean };
        return jsonResponse({
          settings: {
            scopeKind: 'profile',
            scopeId: '1',
            credentialStreamScrubEnabled: rec.credentialStreamScrubEnabled,
            updatedBy: 1,
            updatedAt: '2026-11-18T03:00:00Z',
          },
        });
      }
      // Return empty `{}` for everything else to prove defensive handling!
      return jsonResponse({});
    });

    const promptsMount = mountWithProviders(<Prompts />);
    await waitForSelector(promptsMount.host, '[data-testid="prompts-eval-section"]');
    expect(promptsMount.host.querySelector('[data-testid="prompts-canary-section"]')).not.toBeNull();
    await settleAct(25);
    promptsMount.unmount();

    const guardMount = mountWithProviders(<OutputGuard />);
    await waitForSelector(guardMount.host, '[data-testid="guard-credential-scrub-section"]');

    const scrubToggle = guardMount.host.querySelector(
      '[data-testid="guard-credential-scrub-toggle"]',
    ) as HTMLInputElement;
    expect(scrubToggle.checked).toBe(false);

    await act(async () => {
      scrubToggle.click();
    });
    await waitForSelector(guardMount.host, '[data-testid="guard-credential-scrub-feedback"]');

    expect(
      requests.some(
        (r) =>
          r.url.endsWith('/api/ai-platform/output-guard/profile/1/credential-scrub') &&
          r.method === 'PUT' &&
          (r.body as { credentialStreamScrubEnabled?: boolean })?.credentialStreamScrubEnabled === true,
      ),
    ).toBe(true);
    expect(scrubToggle.checked).toBe(true);

    guardMount.unmount();
  });
});
