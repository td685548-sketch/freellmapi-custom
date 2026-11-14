// @vitest-environment jsdom
/**
 * T069 — AI Platform Output Guard UI tests (native createRoot/act, no @testing-library/react).
 *
 * Covers:
 * - Bilingual EN/VI string parity for output-guard-strings.ts
 * - AiPlatformApp exact child permission guards (view_output_guard, edit_output_guard, view_guard_excerpts; manage_ai_platform does NOT auto-grant)
 * - Editor-only & excerpt-only users never trigger unauthorized GET policy/events queries
 * - GuardPolicyEditor (profile/support_tenant/agent unavailable, latency/buffering/judge/bypass warnings, 409 conflict, 422 validation)
 * - PolicyTester (local-only default, explicit includeExternal, 409 pillar_disabled)
 * - GuardEvents (metadata only, filters, cursor pagination, excerpt fetch 410/404, abort & clear on scope switch/unmount)
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { OutputGuard } from './pages/OutputGuard';
import * as guardApi from './output-guard-api';
import * as guardStrings from './output-guard-strings';

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
      flags: { prompts: false, retrieval: false, promptCache: false, mcpClient: false, outputGuard: true, orchestrator: false },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: false, ready: false, summary: '' },
        retrieval: { enabled: false, ready: false, summary: '' },
        promptCache: { enabled: false, ready: false, summary: '' },
        mcpClient: { enabled: false, ready: false, summary: '' },
        outputGuard: { enabled: true, ready: true, summary: 'Ready' },
        orchestrator: { enabled: false, ready: false, summary: '' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./output-guard-api', async () => {
  const actual = await vi.importActual<typeof import('./output-guard-api')>('./output-guard-api');
  return {
    ...actual,
    fetchGuardPolicy: vi.fn(),
    putGuardPolicy: vi.fn(),
    testGuardPolicy: vi.fn(),
    fetchGuardEvents: vi.fn(),
    fetchGuardEventExcerpt: vi.fn(),
    fetchGuardProfileOptions: vi.fn(),
    fetchGuardSupportTenantOptions: vi.fn(),
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

function makePolicy(overrides: Partial<guardApi.GuardPolicyView> = {}): guardApi.GuardPolicyView {
  return {
    ...guardApi.createDefaultGuardPolicy({ kind: 'profile', id: '1' }),
    mode: 'block',
    revision: 1,
    ...overrides,
  };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms.clear();
  actor.isPrimary = false;
  actor.userId = 1;

  vi.mocked(guardApi.fetchGuardProfileOptions).mockResolvedValue([{ id: 1, name: 'Default Key' }]);
  vi.mocked(guardApi.fetchGuardSupportTenantOptions).mockResolvedValue([{ id: 't1', name: 'Acme Support' }]);
  vi.mocked(guardApi.fetchGuardPolicy).mockResolvedValue({ policy: makePolicy() });
  vi.mocked(guardApi.fetchGuardEvents).mockResolvedValue({ events: [], nextBefore: null });

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
});

describe('Output Guard i18n strings', () => {
  it('has Vietnamese translations for every constant in output-guard-strings.ts', () => {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(guardStrings)) {
      if (typeof value !== 'string') continue;
      if (!(value in VI)) {
        missing.push(`${name}: "${value}"`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('Output Guard permissions & AiPlatformApp routing', () => {
  it('allows view_output_guard-only user into OutputGuard without canOverview/canMcp', async () => {
    actor.perms.add('view_output_guard');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/output-guard']}>
        <AiPlatformApp />
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="output-guard-page"]')).not.toBeNull();
    expect(guardApi.fetchGuardPolicy).toHaveBeenCalledTimes(1);
    const saveBtn = container.querySelector('[data-testid="guard-save-policy-btn"]') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
  });

  it('does NOT grant output-guard access to manage_ai_platform alone', async () => {
    actor.perms.add('manage_ai_platform');
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/output-guard']}>
        <AiPlatformApp />
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="output-guard-page"]')).toBeNull();
    expect(guardApi.fetchGuardPolicy).not.toHaveBeenCalled();
  });

  it('does NOT fire GET policy or GET events for edit_output_guard-only user', async () => {
    actor.perms.add('edit_output_guard');
    renderEl(<OutputGuard />);
    await flush();

    expect(guardApi.fetchGuardPolicy).not.toHaveBeenCalled();
    expect(guardApi.fetchGuardEvents).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="guard-editor-only-notice"]')).not.toBeNull();
  });

  it('does NOT fire GET policy or GET events for view_guard_excerpts-only user and allows direct excerpt lookup', async () => {
    actor.perms.add('view_guard_excerpts');
    vi.mocked(guardApi.fetchGuardEventExcerpt).mockResolvedValue({
      excerpt: 'masked-secret-snippet',
      expiresAt: '2026-11-21T00:00:00.000Z',
    });

    renderEl(<OutputGuard />);
    await flush();

    expect(guardApi.fetchGuardPolicy).not.toHaveBeenCalled();
    expect(guardApi.fetchGuardEvents).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="guard-excerpt-only-panel"]')).not.toBeNull();

    const input = container.querySelector('[data-testid="guard-excerpt-lookup-input"]') as HTMLInputElement;
    const btn = container.querySelector('[data-testid="guard-excerpt-lookup-btn"]') as HTMLButtonElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '42');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      btn.click();
    });
    await flush();

    expect(guardApi.fetchGuardEventExcerpt).toHaveBeenCalledWith('42', expect.any(AbortSignal));
    expect(container.querySelector('[data-testid="guard-excerpt-content"]')?.textContent).toContain('masked-secret-snippet');
  });
});

describe('GuardPolicyEditor & PolicyTester', () => {
  it('shows latency, full-buffering, judge identity, and bypass semantics warnings, and handles 409/422', async () => {
    actor.perms.add('view_output_guard');
    actor.perms.add('edit_output_guard');

    const policyWithPatternsAndJudge = makePolicy({
      detectors: {
        ...guardApi.createDefaultGuardDetectors(),
        patterns: { enabled: true, rules: [{ id: 'r1', name: 'R1', pattern: 'abc', flags: 'i' }] },
        judge: { enabled: true, model: 'auto', criteria: 'No PII' },
      },
    });
    vi.mocked(guardApi.fetchGuardPolicy).mockResolvedValue({ policy: policyWithPatternsAndJudge });

    renderEl(<OutputGuard />);
    await flush();

    expect(container.querySelector('[data-testid="guard-latency-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guard-buffering-patterns-warning"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guard-buffering-external-warning"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="guard-bypass-roles-warning"]')).not.toBeNull();
    expect(container.textContent).not.toContain('all policies <= 300ms');

    // Switch to support_tenant -> judge identity warning appears
    const scopeSelect = container.querySelector('[data-testid="guard-scope-kind-select"]') as HTMLSelectElement;
    act(() => {
      scopeSelect.value = 'support_tenant';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-judge-identity-warning"]')).not.toBeNull();

    // Switch to agent -> unavailable notice, no GET policy call for agent
    const callsBeforeAgent = vi.mocked(guardApi.fetchGuardPolicy).mock.calls.length;
    act(() => {
      scopeSelect.value = 'agent';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-agent-unavailable"]')).not.toBeNull();
    expect(vi.mocked(guardApi.fetchGuardPolicy).mock.calls.length).toBe(callsBeforeAgent);

    // Switch back to profile and test 422 then 409
    act(() => {
      scopeSelect.value = 'profile';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    vi.mocked(guardApi.putGuardPolicy).mockRejectedValueOnce(
      Object.assign(new Error('Regex too slow'), { status: 422 }),
    );
    const saveBtn = container.querySelector('[data-testid="guard-save-policy-btn"]') as HTMLButtonElement;
    act(() => {
      saveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-policy-error"]')?.textContent).toContain('Regex too slow');

    vi.mocked(guardApi.putGuardPolicy).mockRejectedValueOnce(
      Object.assign(new Error('Revision conflict'), { status: 409 }),
    );
    act(() => {
      saveBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-policy-error"]')?.textContent).toContain('refreshed');
  });

  it('runs PolicyTester local-only by default and supports explicit includeExternal + 409 handling', async () => {
    actor.perms.add('view_output_guard');
    vi.mocked(guardApi.testGuardPolicy).mockResolvedValueOnce({
      action: 'blocked',
      triggered: [{ detector: 'keywords', match: 'forbidden' }],
      maskedText: 'This response was blocked by output guard policy.',
      buffering: false,
      bufferingReason: 'streaming_window',
    });

    renderEl(<OutputGuard />);
    await flush();

    const textInput = container.querySelector('[data-testid="guard-tester-text-input"]') as HTMLTextAreaElement;
    const runBtn = container.querySelector('[data-testid="guard-tester-run-btn"]') as HTMLButtonElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textInput, 'hello forbidden world');
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      runBtn.click();
    });
    await flush();

    expect(guardApi.testGuardPolicy).toHaveBeenCalledWith(
      { kind: 'profile', id: '1' },
      expect.objectContaining({ text: 'hello forbidden world', includeExternal: false }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="guard-tester-result-action"]')?.textContent).toBe('blocked');

    // Toggle includeExternal -> 409 pillar disabled
    const extCheckbox = container.querySelector('[data-testid="guard-tester-include-external"]') as HTMLInputElement;
    vi.mocked(guardApi.testGuardPolicy).mockRejectedValueOnce(
      Object.assign(new Error('Pillar disabled'), { status: 409 }),
    );
    act(() => {
      extCheckbox.click();
    });
    act(() => {
      runBtn.click();
    });
    await flush();

    expect(guardApi.testGuardPolicy).toHaveBeenLastCalledWith(
      { kind: 'profile', id: '1' },
      expect.objectContaining({ includeExternal: true }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="guard-tester-error"]')?.textContent).toContain('409');
  });
});

describe('GuardEvents metadata, excerpts, and abort/cleanup', () => {
  it('lists metadata, paginates, handles 410 expired excerpt, and aborts/clears on scope switch', async () => {
    actor.perms.add('view_output_guard');
    actor.perms.add('view_guard_excerpts');

    vi.mocked(guardApi.fetchGuardEvents)
      .mockResolvedValueOnce({
        events: [
          {
            id: 101,
            scopeKind: 'profile',
            scopeId: '1',
            endUser: 'u1',
            detector: 'keywords',
            action: 'blocked',
            wire: 'openai-chat',
            streamed: true,
            runId: null,
            hasExcerpt: true,
            excerptExpired: false,
            excerptExpiresAt: '2026-11-21T00:00:00.000Z',
            createdAt: '2026-11-14T10:00:00.000Z',
          },
        ],
        nextBefore: 'cursor-101',
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: 100,
            scopeKind: 'profile',
            scopeId: '1',
            endUser: 'u1',
            detector: 'pii',
            action: 'masked',
            wire: 'anthropic',
            streamed: false,
            runId: null,
            hasExcerpt: true,
            excerptExpired: false,
            excerptExpiresAt: '2026-11-10T00:00:00.000Z',
            createdAt: '2026-11-01T10:00:00.000Z',
          },
        ],
        nextBefore: null,
      })
      .mockResolvedValue({ events: [], nextBefore: null });

    vi.mocked(guardApi.fetchGuardEventExcerpt)
      .mockResolvedValueOnce({ excerpt: 'secret-excerpt-101', expiresAt: '2026-11-21T00:00:00.000Z' })
      .mockRejectedValueOnce(Object.assign(new Error('Expired'), { status: 410 }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderEl(<OutputGuard />);
    await flush();

    // Switch to Events tab
    const eventsTab = container.querySelector('[data-testid="guard-tab-events"]') as HTMLButtonElement;
    act(() => {
      eventsTab.click();
    });
    await flush();

    expect(container.querySelector('[data-testid="guard-event-row-101"]')).not.toBeNull();

    // Load more
    const loadMoreBtn = container.querySelector('[data-testid="guard-events-load-more-btn"]') as HTMLButtonElement;
    act(() => {
      loadMoreBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-event-row-100"]')).not.toBeNull();

    // View excerpt 101 (success) and 100 (410 expired)
    const viewBtn101 = container.querySelector('[data-testid="guard-view-excerpt-101"]') as HTMLButtonElement;
    act(() => {
      viewBtn101.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-excerpt-content-101"]')?.textContent).toBe('secret-excerpt-101');

    const viewBtn100 = container.querySelector('[data-testid="guard-view-excerpt-100"]') as HTMLButtonElement;
    act(() => {
      viewBtn100.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-excerpt-error-100"]')?.textContent).toContain('410');

    // Switch scope -> clears excerpt state
    const scopeSelect = container.querySelector('[data-testid="guard-scope-kind-select"]') as HTMLSelectElement;
    act(() => {
      scopeSelect.value = 'support_tenant';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="guard-excerpt-content-101"]')).toBeNull();

    // Never logged sensitive excerpt to console
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('secret-excerpt-101');
    expect(errSpy.mock.calls.flat().join(' ')).not.toContain('secret-excerpt-101');
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
