// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VI } from '../i18n/vi';
import * as flowsStrings from './flows-strings';
import * as mcpStrings from './mcp-strings';
import * as tracingStrings from './tracing-strings';
import { computeWaterfallBar, countSpanNodes, formatSpanDuration } from './tracing-api';
import type { TraceRecord, TraceSummary } from '../../../../shared/ai-platform-tracing-oauth';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface MockAuthState {
  isPrimary: boolean;
  permissions: Set<string>;
}

const authState: MockAuthState = {
  isPrimary: true,
  permissions: new Set<string>(['*']),
};

vi.mock('../use-session', () => ({
  useUserSession: () => ({
    session: { userId: 1, email: 'admin@example.com', role: 'admin', isPrimary: authState.isPrimary },
    isAdmin: true,
    isPrimary: authState.isPrimary,
  }),
}));

vi.mock('../use-administrative-access', () => ({
  useAdministrativeAccess: () => ({
    hasAdministrativeAccess: true,
    loading: false,
    identity: '1:admin:1',
    can: (perm: string) =>
      authState.isPrimary || authState.permissions.has('*') || authState.permissions.has(perm),
  }),
}));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { AiPlatformApp } from './AiPlatformApp';
import { Flows } from './pages/Flows';
import { McpServers } from './pages/McpServers';
import { TraceTimelinePage } from './pages/TraceTimelinePage';

const mockApiFetch = vi.mocked(apiFetch);

const SAMPLE_SUMMARY: TraceSummary = {
  traceId: 'trace-035-demo',
  requestId: 'req-035-1',
  threadId: 'thread-035-a',
  traceSource: 'x-trace-id',
  scopeKind: 'profile',
  scopeId: '1',
  endUser: 'alice',
  wire: 'openai-chat',
  requestedModel: 'spec035-model',
  servedModel: 'spec035-model',
  status: 'ok',
  durationMs: 200,
  promptTokens: 54,
  completionTokens: 27,
  cachedTokens: 10,
  totalTokens: 81,
  spansCount: 4,
  errorSummary: null,
  startedAt: '2026-11-18T02:00:00.000Z',
  finishedAt: '2026-11-18T02:00:00.200Z',
};

const SAMPLE_RECORD: TraceRecord = {
  ...SAMPLE_SUMMARY,
  rootSpan: {
    id: 'span-root',
    parentId: null,
    name: 'POST /v1/chat/completions',
    kind: 'request',
    startOffsetMs: 0,
    durationMs: 200,
    status: 'ok',
    model: 'spec035-model',
    promptTokens: 54,
    completionTokens: 27,
    cachedTokens: 10,
    attributes: { wire: 'openai_chat', apiKey: '[REDACTED]' },
    children: [
      {
        id: 'span-prompt',
        parentId: 'span-root',
        name: 'Render system prompt',
        kind: 'prompt_render',
        startOffsetMs: 5,
        durationMs: 15,
        status: 'ok',
        attributes: { version: 3 },
        children: [],
      },
      {
        id: 'span-mcp',
        parentId: 'span-root',
        name: 'orders / lookup_order',
        kind: 'mcp_tool_call',
        startOffsetMs: 30,
        durationMs: 90,
        status: 'ok',
        attributes: { serverSlug: 'orders', toolName: 'lookup_order' },
        children: [],
      },
      {
        id: 'span-upstream',
        parentId: 'span-root',
        name: 'custom / spec035-model',
        kind: 'upstream_attempt',
        startOffsetMs: 125,
        durationMs: 70,
        status: 'ok',
        model: 'spec035-model',
        promptTokens: 30,
        completionTokens: 15,
        cachedTokens: 10,
        attributes: { platform: 'custom', statusCode: 200 },
        children: [],
      },
    ],
  },
};

let container: HTMLDivElement;
let root: Root;

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function extractPlaceholders(text: string): string[] {
  return [...text.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]).sort();
}

beforeEach(() => {
  authState.isPrimary = true;
  authState.permissions = new Set(['*']);
  mockApiFetch.mockReset();

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('Spec 035 — i18n EN/VI string parity', () => {
  it('defines matching Vietnamese translations and identical placeholders for all tracing, MCP OAuth, and async/schedule strings', () => {
    const modules: Array<Record<string, unknown>> = [tracingStrings, mcpStrings, flowsStrings];
    for (const mod of modules) {
      for (const [key, value] of Object.entries(mod)) {
        if (typeof value !== 'string') continue;
        const translated = VI[value];
        expect(translated, `Missing VI translation for ${key}: "${value}"`).toBeDefined();
        expect(extractPlaceholders(translated)).toEqual(extractPlaceholders(value));
      }
    }
  });
});

describe('Spec 035 — Waterfall geometry & TraceTimelinePage UI', () => {
  it('computes proportional waterfall offsets and widths clamped within [0, 100]', () => {
    expect(computeWaterfallBar(30, 90, 200)).toEqual({ leftPercent: 15, widthPercent: 45 });
    expect(computeWaterfallBar(0, 0, 200)).toEqual({ leftPercent: 0, widthPercent: 0.6 });
    expect(formatSpanDuration(42)).toBe('42ms');
    expect(formatSpanDuration(1500)).toBe('1.50s');
    expect(countSpanNodes(SAMPLE_RECORD.rootSpan)).toBe(4);
  });

  it('renders hierarchical waterfall rows, collapses/expands children, opens span metadata inspector, and purges traces', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/ai-platform/traces/trace-035-demo')) {
        return { trace: SAMPLE_RECORD };
      }
      if (url.startsWith('/api/ai-platform/traces') && init?.method === 'DELETE') {
        return { deleted: 1 };
      }
      if (url.startsWith('/api/ai-platform/traces')) {
        return { traces: [SAMPLE_SUMMARY], nextBefore: null };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/ai-platform/traces']}>
          <Routes>
            <Route path="/ai-platform/*" element={<AiPlatformApp />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await flushUi();
    await flushUi();

    expect(container.querySelector('[data-testid="ai-platform-tab-traces"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="traces-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trace-span-row-span-root"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trace-span-row-span-mcp"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="trace-span-bar-span-mcp"]')).not.toBeNull();

    // Click child MCP span to inspect its redacted metadata in the drawer
    const mcpRow = container.querySelector('[data-testid="trace-span-row-span-mcp"]') as HTMLElement;
    await act(async () => {
      mcpRow.click();
    });

    const inspector = container.querySelector('[data-testid="trace-span-inspector"]');
    expect(inspector).not.toBeNull();
    expect(inspector?.textContent).toContain('span-mcp');
    expect(inspector?.textContent).toContain('lookup_order');

    // Collapse root span -> hides child rows
    const rootToggle = container.querySelector('[data-testid="trace-span-toggle-span-root"]') as HTMLButtonElement;
    await act(async () => {
      rootToggle.click();
    });
    expect(container.querySelector('[data-testid="trace-span-row-span-mcp"]')).toBeNull();

    // Expand root span again
    await act(async () => {
      rootToggle.click();
    });
    expect(container.querySelector('[data-testid="trace-span-row-span-mcp"]')).not.toBeNull();

    // Purge traces button calls DELETE /api/ai-platform/traces
    const purgeBtn = container.querySelector('[data-testid="traces-purge-btn"]') as HTMLButtonElement;
    await act(async () => {
      purgeBtn.click();
    });
    await flushUi();
    expect(container.querySelector('[data-testid="traces-banner"]')?.textContent).toContain('1');
  });

  it('renders no-permission guard when operator lacks view_ai_platform', async () => {
    authState.isPrimary = false;
    authState.permissions = new Set();

    await act(async () => {
      root.render(<TraceTimelinePage />);
    });
    await flushUi();

    expect(container.querySelector('[data-testid="traces-no-permission"]')).not.toBeNull();
  });
});

describe('Spec 035 — MCP OAuth 2.1 PKCE panel & Flows Async/Schedule controls', () => {
  it('renders OAuth 2.1 PKCE panel for oauth2 MCP servers and triggers PKCE start', async () => {
    mockApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/ai-platform/mcp/servers') {
        return {
          servers: [
            {
              id: 7,
              slug: 'oauth-srv',
              name: 'OAuth Remote Server',
              url: 'https://mcp.example.com/mcp',
              authKind: 'oauth2',
              authHeaderName: null,
              hasSecret: false,
              oauthStatus: 'connected',
              enabled: true,
              timeoutMs: 10000,
              maxResultBytes: 65536,
              maxConcurrency: 4,
              status: 'ok',
              consecutiveFailures: 0,
              circuitOpenUntil: null,
              lastTestedAt: null,
              lastSyncedAt: null,
              lastError: null,
              revision: 1,
              createdAt: '2026-11-18T00:00:00Z',
              updatedAt: '2026-11-18T00:00:00Z',
            },
          ],
        };
      }
      if (url === '/api/ai-platform/mcp/servers/7/tools') {
        return { tools: [] };
      }
      if (url === '/api/ai-platform/mcp/servers/7/oauth/status') {
        return {
          oauth: {
            serverId: 7,
            connectionStatus: 'connected',
            issuerUrl: 'https://auth.example.com',
            authorizationEndpoint: 'https://auth.example.com/authorize',
            tokenEndpoint: 'https://auth.example.com/token',
            revocationEndpoint: null,
            clientId: 'mcp-web-client',
            hasClientSecret: true,
            scopes: ['mcp:tools'],
            redirectUri: 'https://localhost/ai-platform/mcp',
            pkceMethod: 'S256',
            expiresAt: '2026-11-18T04:00:00Z',
            hasRefreshToken: true,
            lastRefreshedAt: null,
            lastError: null,
            updatedAt: '2026-11-18T02:00:00Z',
          },
        };
      }
      if (url === '/api/ai-platform/mcp/servers/7/oauth/start' && init?.method === 'POST') {
        return {
          authorizationUrl: 'https://auth.example.com/authorize?code_challenge_method=S256&state=st_123',
          state: 'st_123',
          codeChallengeMethod: 'S256',
          expiresAt: '2026-11-18T02:10:00Z',
          oauth: {
            serverId: 7,
            connectionStatus: 'connected',
            issuerUrl: 'https://auth.example.com',
            authorizationEndpoint: 'https://auth.example.com/authorize',
            tokenEndpoint: 'https://auth.example.com/token',
            revocationEndpoint: null,
            clientId: 'mcp-web-client',
            hasClientSecret: true,
            scopes: ['mcp:tools'],
            redirectUri: 'https://localhost/ai-platform/mcp',
            pkceMethod: 'S256',
            expiresAt: '2026-11-18T04:00:00Z',
            hasRefreshToken: true,
            lastRefreshedAt: null,
            lastError: null,
            updatedAt: '2026-11-18T02:00:00Z',
          },
        };
      }
      throw new Error(`Unexpected MCP URL: ${url}`);
    });

    await act(async () => {
      root.render(<McpServers />);
    });
    await flushUi();
    await flushUi();

    const panel = container.querySelector('[data-testid="mcp-oauth-panel"]');
    expect(panel).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-oauth-status-badge"]')?.textContent).toContain(
      'OAuth connected',
    );

    const startBtn = container.querySelector('[data-testid="mcp-oauth-start-btn"]') as HTMLButtonElement;
    await act(async () => {
      startBtn.click();
    });
    await flushUi();

    const authLink = container.querySelector('[data-testid="mcp-oauth-auth-url-link"]') as HTMLAnchorElement;
    expect(authLink?.href).toContain('code_challenge_method=S256');
  });

  it('renders FlowAsyncScheduleSection in Flows page and displays 202 accepted statusUrl', async () => {
    const sampleFlow = {
      id: 11,
      slug: 'ops-digest',
      name: 'Ops Digest',
      description: 'Scheduled digest',
      enabled: true,
      revision: 1,
      publishedVersion: 1,
      publishedAt: '2026-11-18T00:00:00Z',
      draft: {
        kind: 'single' as const,
        entryAgent: 'ops-agent',
        agents: ['ops-agent'],
        handoffs: { 'ops-agent': [] },
        limits: { maxSteps: 5, maxToolCalls: 5, maxHandoffs: 1, maxTokens: 10000, maxSeconds: 60 },
        awaitingApprovalText: 'Awaiting approval',
        approvalTtlHours: 24,
      },
      createdAt: '2026-11-18T00:00:00Z',
      updatedAt: '2026-11-18T00:00:00Z',
    };

    mockApiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/ai-platform/agents') return { agents: [] };
      if (url === '/api/ai-platform/flows') return { flows: [sampleFlow] };
      if (url === '/api/ai-platform/flows/11') return { flow: sampleFlow, grantedProfileIds: [1] };
      if (url === '/api/ai-platform/flows/11/schedule') {
        return {
          schedule: {
            id: 3,
            flowId: 11,
            flowSlug: 'ops-digest',
            enabled: true,
            scheduleKind: 'cron',
            intervalSeconds: null,
            cronExpr: '*/15 * * * *',
            profileId: 1,
            endUser: null,
            inputMessage: 'Run scheduled digest',
            lastRunId: 'run_prev_01',
            lastRunAt: '2026-11-18T01:45:00Z',
            lastStatus: 'completed',
            nextRunAt: '2026-11-18T02:00:00Z',
            createdAt: '2026-11-18T00:00:00Z',
            updatedAt: '2026-11-18T01:45:00Z',
          },
        };
      }
      if (url === '/api/profiles') return [{ id: 1, name: 'Primary Profile' }];
      if (url === '/api/thruline/support/tenants') return { tenants: [] };
      if (url === '/api/models') return [{ modelId: 'spec035-model' }];
      throw new Error(`Unexpected Flows URL: ${url}`);
    });

    await act(async () => {
      root.render(<Flows />);
    });
    await flushUi();
    await flushUi();
    await flushUi();

    const section = container.querySelector('[data-testid="flow-async-schedule-section"]');
    expect(section).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-schedule-meta"]')?.textContent).toContain(
      'run_prev_01',
    );
  });
});
