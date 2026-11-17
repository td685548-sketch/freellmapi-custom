// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n';
import { VI } from '../i18n/vi';
import { MemberKeysView } from '../MemberKeysView';
import { CustomerAiHubPage } from './CustomerAiHubPage';

const actor = vi.hoisted(() => ({
  role: 'member' as 'admin' | 'member',
  isPrimary: false,
  permissions: [] as string[],
}));

vi.mock('../use-session', () => ({
  useUserSession: () => ({
    session: { userId: 1, email: 'user@example.com', role: actor.role, isPrimary: actor.isPrimary, permissions: actor.permissions },
    isPrimary: actor.isPrimary,
    isAdmin: actor.role === 'admin',
    isMember: actor.role === 'member',
    permissions: actor.permissions,
    hasPermission: (p: string) => actor.isPrimary || actor.permissions.includes('*') || actor.permissions.includes(p),
    hasPermissionGroup: () => false,
  }),
}));

vi.mock('../use-administrative-access', () => ({
  useAdministrativeAccess: () => ({
    can: (p: string) => actor.isPrimary || actor.permissions.includes('*') || actor.permissions.includes(p),
    group: () => false,
    identity: `${actor.role}:${actor.permissions.join(',')}`,
    isPending: false,
    session: { userId: 1, email: 'user@example.com', role: actor.role, isPrimary: actor.isPrimary, permissions: actor.permissions },
  }),
}));

const ASSISTANTS = [
  {
    id: 1,
    slug: 'fast-pair-coder',
    name: 'Fast Pair Programmer (Eco)',
    description: 'Low-latency IDE coding helper.',
    category: 'coding',
    icon: 'zap',
    recommendedRoutingMode: 'eco',
    starterPrompts: ['Write a unit test'],
    audience: 'guest_preview',
    boundKeysCount: 2,
    playgroundRuns: 5,
  },
];

const COACH_REPORT = {
  windowDays: 14,
  totalRequests: 12,
  totalTokens: 9600,
  avgTokensPerRequest: 800,
  errorRatePct: 0,
  potentialSavingsPct: 35,
  routingBreakdown: { default: 1, eco: 0, balanced: 0, max: 0 },
  headline: 'You can save up to ~35% quota with Eco routing.',
  tips: [
    {
      id: 'switch-to-eco',
      severity: 'saving',
      title: 'Switch routine keys to Eco mode',
      detail: 'Save up to 35% monthly quota on routine completions.',
      estimatedTokenSavingsPct: 35,
      recommendedMode: 'eco',
      targetKeyId: 10,
      targetKeyName: 'Cursor Key',
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function flush() {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise(r => setTimeout(r, 0));
    });
  }
}

function mount(node: React.ReactNode) {
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <MemoryRouter>{node}</MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  actor.role = 'member';
  actor.isPrimary = false;
  actor.permissions = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Customer AI Hub & Dual-Persona UI', () => {
  it('translates every tc() literal in customer-ai/*.tsx into Vietnamese', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter(f => f.endsWith('.tsx') && !f.includes('.test.'));
    const literal = /\btc\(\s*'((?:[^'\\]|\\.)*)'/g;
    const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));
    const missing: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(here, f), 'utf8');
      for (const m of src.matchAll(literal)) {
        const key = unescape(m[1]!);
        if (/\p{L}{2,}/u.test(key) && !(key in VI)) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('renders customer AI Hub for members without exposing admin controls, supports chat and Quota Coach Eco switch', async () => {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body ? String(init.body) : undefined });
      if (u.endsWith('/api/user/ai-hub/catalog')) return json({ assistants: ASSISTANTS });
      if (u.endsWith('/api/user/ai-hub/preferences')) return json({ preferences: { customInstructions: '', applyCustomInstructionsToKeys: true, updatedAt: null } });
      if (u.endsWith('/api/user/keys')) {
        return json({
          keys: [{ id: 10, userId: 1, name: 'Cursor Key', keyPrefix: 'sk-flm-abc', rpmLimit: 60, revoked: false, createdAt: '2026-11-18', lastUsedAt: null, routingMode: 'default', assistantId: null }],
        });
      }
      if (u.includes('/api/user/ai-hub/coach')) return json({ report: COACH_REPORT });
      if (u.endsWith('/api/user/ai-hub/assistants/fast-pair-coder/chat')) {
        return json({ reply: 'Mock assistant reply', model: 'fast-eco-8b', routingMode: 'eco', usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } });
      }
      if (u.endsWith('/api/user/ai-hub/keys/apply-eco')) return json({ updatedCount: 1 });
      return json({});
    }));

    mount(<CustomerAiHubPage />);
    await flush();

    expect(container.textContent).toContain('Fast Pair Programmer (Eco)');
    expect(container.textContent).toContain('AI Quota & Routing Coach');
    expect(container.textContent).not.toContain('Admin Studio & Radar');
    expect(calls.some(c => c.url.includes('/api/ai-platform/'))).toBe(false);

    // Open chat drawer and send a starter prompt
    const chatBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Chat Now'))!;
    act(() => chatBtn.click());
    await flush();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Write a unit test');
    const starterBtn = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.includes('Write a unit test'))!;
    act(() => starterBtn.click());
    await flush();
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Mock assistant reply');

    // Close drawer, then trigger 1-click Eco switch in QuotaCoachCard
    const closeBtn = container.querySelector('[role="dialog"] button[aria-label="Close"]') as HTMLButtonElement;
    act(() => closeBtn.click());
    await flush();
    const ecoBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Switch key to Eco'))!;
    act(() => ecoBtn.click());
    await flush();
    expect(calls.some(c => c.url.endsWith('/api/user/ai-hub/keys/apply-eco') && c.method === 'POST')).toBe(true);
  });

  it('shows Admin Studio & Anomaly Radar switcher for admins without failing member flows', async () => {
    actor.role = 'admin';
    actor.isPrimary = true;
    actor.permissions = ['*'];

    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/api/user/ai-hub/catalog')) return json({ assistants: ASSISTANTS });
      if (u.endsWith('/api/user/ai-hub/preferences')) return json({ preferences: { customInstructions: '', applyCustomInstructionsToKeys: true, updatedAt: null } });
      if (u.endsWith('/api/user/keys')) return json({ keys: [] });
      if (u.includes('/api/user/ai-hub/coach')) return json({ report: COACH_REPORT });
      if (u.includes('/api/ai-platform/anomaly-radar')) {
        return json({
          report: {
            generatedAt: '2026-11-18T00:00:00Z',
            windowHours: 24,
            totalAssistants: 1,
            enabledAssistants: 1,
            boundPersonalKeys: 2,
            ecoPersonalKeys: 1,
            anomalies: [{
              id: 'spike-7',
              kind: 'token_spike',
              severity: 'high',
              userId: 7,
              email: 'heavy@example.com',
              requests24h: 30,
              tokens24h: 85000,
              baselineDailyTokens: 5000,
              errorRatePct: 0,
              activeNonEcoKeys: 1,
              summary: '85,000 tokens in 24h vs 5,000/day baseline.',
              recommendedAction: 'switch_keys_to_eco',
            }],
            topAssistants: [],
          },
        });
      }
      if (u.endsWith('/api/ai-platform/customer-assistants')) {
        return json({
          assistants: [{ ...ASSISTANTS[0]!, systemPrompt: 'ADMIN SECRET SYSTEM PROMPT', enabled: true, sortOrder: 10, createdAt: '', updatedAt: '' }],
        });
      }
      return json({});
    }));

    mount(<CustomerAiHubPage />);
    await flush();

    const adminTab = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Admin Studio & Radar'))!;
    expect(adminTab).toBeDefined();
    act(() => adminTab.click());
    await flush();

    expect(container.textContent).toContain('AI Anomaly Radar');
    expect(container.textContent).toContain('heavy@example.com');
    expect(container.textContent).toContain('ADMIN SECRET SYSTEM PROMPT');
    expect(calls.some(u => u.includes('/api/ai-platform/anomaly-radar'))).toBe(true);
  });

  it('renders guest read-only catalog and triggers sign-in prompt on chat click', async () => {
    const promptSpy = vi.fn();
    window.addEventListener('freellmapi:guest-prompt', promptSpy);
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/user/ai-hub/catalog')) return json({ assistants: ASSISTANTS });
      return json({}, 401);
    }));

    mount(<CustomerAiHubPage guestMode />);
    await flush();

    expect(container.textContent).toContain('Fast Pair Programmer (Eco)');
    expect(container.textContent).not.toContain('Personal Custom Instructions');
    const signInBtn = [...container.querySelectorAll('button')].find(b => b.textContent?.includes('Sign in to chat'))!;
    act(() => signInBtn.click());
    expect(promptSpy).toHaveBeenCalledTimes(1);
    window.removeEventListener('freellmapi:guest-prompt', promptSpy);
  });

  it('lets members change routing mode and assistant preset directly inside MemberKeysView', async () => {
    const patchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (init?.method === 'PATCH') {
        patchCalls.push({ url: u, body: JSON.parse(String(init.body)) });
        return json({ key: { id: 10, routingMode: 'eco', assistantId: 1, assistantSlug: 'fast-pair-coder', assistantName: 'Fast Pair Programmer (Eco)' } });
      }
      if (u.endsWith('/api/user/keys')) {
        return json({
          keys: [{ id: 10, userId: 1, name: 'Cursor Key', keyPrefix: 'sk-flm-abc', rpmLimit: 60, revoked: false, createdAt: '2026-11-18', lastUsedAt: null, routingMode: 'default', assistantId: null }],
        });
      }
      if (u.endsWith('/api/user/ai-hub/catalog')) return json({ assistants: ASSISTANTS });
      if (u.includes('/api/user/ai-hub/coach')) return json({ report: COACH_REPORT });
      if (u.endsWith('/api/user/usage')) return json({ usage: { requests: 12, tokens: 9600, month: '2026-11' } });
      return json({});
    }));

    mount(<MemberKeysView />);
    await flush();

    const modeSelect = container.querySelector('select[aria-label="Routing mode for Cursor Key"]') as HTMLSelectElement;
    expect(modeSelect).not.toBeNull();
    act(() => {
      modeSelect.value = 'eco';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    expect(patchCalls).toContainEqual({
      url: '/api/user/ai-hub/keys/10',
      body: { routingMode: 'eco' },
    });
  });
});
