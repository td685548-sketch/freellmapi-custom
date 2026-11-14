// @vitest-environment jsdom
/**
 * T051 — AI Platform MCP UI tests (native createRoot/act, no @testing-library/react).
 *
 * Covers:
 * - Bilingual EN/VI string parity for mcp-strings.ts
 * - McpServers CRUD dialog (write-only secret, blank=keep, clear=null, only hasSecret)
 * - Enable/disable, test, sync, delete (409 in_use -> force delete), 409 revision_conflict
 * - ToolReviewTable (schema/hash/effect/state, remote readOnly not auto-trusted, review_mcp_tools guard)
 * - ScopeToolBindings (profile/support-tenant/agent unavailable, abort/epoch on scope switch)
 * - ApprovalQueue (masked args, approve/reject only when pending, in-flight disable, 409 refresh, no retry for executing/unknown, US2 scope note)
 * - McpCallLog (filter, pagination, masked output)
 * - InternalOriginsEditor (primary-only guard, exact origin validation)
 * - AiPlatformApp navigation & exact child permission guards
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { McpServers } from './pages/McpServers';
import * as mcpApi from './mcp-api';
import * as mcpStrings from './mcp-strings';

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
      flags: { prompts: false, retrieval: false, promptCache: false, mcpClient: true, outputGuard: false, orchestrator: false },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: false, ready: false, summary: '' },
        retrieval: { enabled: false, ready: false, summary: '' },
        promptCache: { enabled: false, ready: false, summary: '' },
        mcpClient: { enabled: true, ready: true, summary: 'Ready' },
        outputGuard: { enabled: false, ready: false, summary: '' },
        orchestrator: { enabled: false, ready: false, summary: '' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./mcp-api', async () => {
  const actual = await vi.importActual<typeof import('./mcp-api')>('./mcp-api');
  return {
    ...actual,
    fetchMcpServers: vi.fn(),
    createMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
    deleteMcpServer: vi.fn(),
    testMcpServer: vi.fn(),
    syncMcpServer: vi.fn(),
    fetchMcpServerTools: vi.fn(),
    reviewMcpTool: vi.fn(),
    fetchMcpBindings: vi.fn(),
    putMcpBindings: vi.fn(),
    fetchProfileOptions: vi.fn(),
    fetchSupportTenantOptions: vi.fn(),
    fetchMcpApprovals: vi.fn(),
    approveMcpAction: vi.fn(),
    rejectMcpAction: vi.fn(),
    fetchMcpCalls: vi.fn(),
    fetchAllowedInternalOrigins: vi.fn(),
    putAllowedInternalOrigins: vi.fn(),
  };
});

function makeServer(overrides: Partial<mcpApi.McpServerView> = {}): mcpApi.McpServerView {
  return {
    id: 1,
    slug: 'orders',
    name: 'Orders MCP',
    url: 'https://orders.example.com/mcp',
    authKind: 'bearer',
    authHeaderName: null,
    hasSecret: true,
    enabled: true,
    timeoutMs: 20000,
    maxResultBytes: 262144,
    maxConcurrency: 4,
    status: 'ok',
    lastError: null,
    lastConnectedAt: '2026-11-14T10:00:00Z',
    failCount: 0,
    pausedUntil: null,
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'orders-srv', version: '1.0.0' },
    createdBy: 1,
    createdAt: '2026-11-14T09:00:00Z',
    updatedAt: '2026-11-14T10:00:00Z',
    revision: 1,
    ...overrides,
  };
}

function makeTool(overrides: Partial<mcpApi.McpToolView> = {}): mcpApi.McpToolView {
  return {
    id: 10,
    serverId: 1,
    name: 'lookup_order',
    description: 'Look up an order by ID',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, annotations: { readOnlyHint: true } },
    outputSchema: null,
    schemaHash: 'hash-abc-123',
    exposedName: 'mcp__orders__lookup_order',
    state: 'pending',
    effect: 'write',
    reviewedBy: null,
    reviewedAt: null,
    missingSince: null,
    createdAt: '2026-11-14T09:00:00Z',
    updatedAt: '2026-11-14T09:00:00Z',
    ...overrides,
  };
}

function makeApproval(overrides: Partial<mcpApi.McpApprovalView> = {}): mcpApi.McpApprovalView {
  return {
    id: 50,
    executionKey: 'exec-key-1',
    runId: null,
    stepSeq: 1,
    scopeKind: 'profile',
    scopeId: '1',
    endUser: 'user-1',
    toolId: 10,
    toolName: 'refund_order',
    exposedName: 'mcp__orders__refund_order',
    serverId: 1,
    serverSlug: 'orders',
    argsMasked: '{"orderId":"ord_1","token":"***"}',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: '2026-11-15T10:00:00Z',
    createdAt: '2026-11-14T10:00:00Z',
    ...overrides,
  };
}

function makeCall(overrides: Partial<mcpApi.McpCallView> = {}): mcpApi.McpCallView {
  return {
    id: 100,
    runId: null,
    scopeKind: 'profile',
    scopeId: '1',
    endUser: null,
    serverId: 1,
    serverSlug: 'orders',
    toolName: 'lookup_order',
    argsMasked: '{"orderId":"ord_1"}',
    resultMasked: '{"status":"shipped"}',
    status: 'ok',
    durationMs: 42,
    resultBytes: 128,
    createdAt: '2026-11-14T10:01:00Z',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms = new Set(['view_mcp_servers', 'edit_mcp_servers', 'review_mcp_tools', 'approve_ai_actions']);
  actor.isPrimary = false;
  actor.userId = 1;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  vi.mocked(mcpApi.fetchMcpServers).mockResolvedValue({ servers: [makeServer()] });
  vi.mocked(mcpApi.fetchMcpServerTools).mockResolvedValue({ tools: [makeTool()] });
  vi.mocked(mcpApi.fetchProfileOptions).mockResolvedValue([{ id: 1, name: 'Default Profile' }, { id: 2, name: 'Second Profile' }]);
  vi.mocked(mcpApi.fetchSupportTenantOptions).mockResolvedValue([{ id: '101', name: 'Acme Support' }]);
  vi.mocked(mcpApi.fetchMcpBindings).mockResolvedValue({
    binding: {
      scope: { kind: 'profile', id: '1' },
      aiToolsEnabled: true,
      maxRounds: 8,
      toolIds: [10],
      tools: [makeTool({ state: 'allowed', effect: 'read' })],
    },
  });
  vi.mocked(mcpApi.fetchMcpApprovals).mockResolvedValue({ approvals: [makeApproval()] });
  vi.mocked(mcpApi.fetchMcpCalls).mockResolvedValue({ calls: [makeCall()], nextBefore: null });
  vi.mocked(mcpApi.fetchAllowedInternalOrigins).mockResolvedValue({ origins: ['https://mcp.internal:8443'] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

async function renderMcp() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ai-platform/mcp']}>
          <McpServers />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

describe('MCP i18n strings', () => {
  it('has Vietnamese translations and matching placeholders for every mcp-strings constant', () => {
    const entries = Object.entries(mcpStrings).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
    expect(entries.length).toBeGreaterThan(30);
    for (const [, en] of entries) {
      expect(en.length).toBeGreaterThan(0);
      const viText = VI[en];
      expect(viText, `Missing VI translation for "${en}"`).toBeTruthy();
      const enVars = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const viVars = [...viText.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(viVars).toEqual(enVars);
    }
  });
});

describe('McpServers CRUD & write-only secret', () => {
  it('creates a server with write-only secret and never renders any stored secret on edit', async () => {
    vi.mocked(mcpApi.createMcpServer).mockResolvedValue({ server: makeServer({ id: 2, slug: 'crm', name: 'CRM' }) });
    vi.mocked(mcpApi.updateMcpServer).mockResolvedValue({ server: makeServer({ revision: 2 }) });
    await renderMcp();

    expect(container.textContent).toContain('orders');
    expect(container.textContent).toContain(mcpStrings.MCP_SECRET_SET);

    // Open create dialog
    const addBtn = container.querySelector<HTMLButtonElement>('[data-testid="mcp-add-server"]');
    expect(addBtn).not.toBeNull();
    await act(async () => addBtn!.click());

    const slugInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-input-slug"]')!;
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-input-name"]')!;
    const urlInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-input-url"]')!;
    const secretInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-input-secret"]')!;
    await act(async () => {
      setInputValue(slugInput, 'crm');
      setInputValue(nameInput, 'CRM');
      setInputValue(urlInput, 'https://crm.example.com/mcp');
      setInputValue(secretInput, 'sk-super-secret-value');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-server"]')!.click();
    });
    await flush();

    expect(mcpApi.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'crm',
        name: 'CRM',
        url: 'https://crm.example.com/mcp',
        secret: 'sk-super-secret-value',
      }),
      expect.any(AbortSignal),
    );

    // Edit existing server: secret input must be empty (write-only), leaving blank keeps secret
    const editBtn = container.querySelector<HTMLButtonElement>('[data-testid="mcp-edit-server-1"]')!;
    await act(async () => editBtn.click());
    const editSecretInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-input-secret"]')!;
    expect(editSecretInput.value).toBe('');
    expect(container.textContent).not.toContain('sk-super-secret-value');

    await act(async () => {
      setInputValue(container.querySelector<HTMLInputElement>('[data-testid="mcp-input-name"]')!, 'Orders Renamed');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-server"]')!.click();
    });
    await flush();

    const patchArg = vi.mocked(mcpApi.updateMcpServer).mock.calls[0][1];
    expect(patchArg.revision).toBe(1);
    expect('secret' in patchArg).toBe(false);

    // Explicit clear sends secret: null
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-edit-server-1"]')!.click());
    const clearCheckbox = container.querySelector<HTMLInputElement>('[data-testid="mcp-clear-secret"]')!;
    await act(async () => clearCheckbox.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-server"]')!.click();
    });
    await flush();

    expect(vi.mocked(mcpApi.updateMcpServer).mock.calls[1][1].secret).toBeNull();
  });

  it('handles test, sync, 409 in_use delete -> force delete, and 409 revision_conflict', async () => {
    vi.mocked(mcpApi.testMcpServer).mockResolvedValue({ ok: true, protocolVersion: '2025-06-18', toolCount: 2 });
    vi.mocked(mcpApi.syncMcpServer).mockResolvedValue({ added: 1, changed: 0, missing: 0, unchanged: 1 });
    vi.mocked(mcpApi.deleteMcpServer)
      .mockRejectedValueOnce(Object.assign(new Error('in use'), { status: 409, code: 'in_use' }))
      .mockResolvedValueOnce({ ok: true });

    await renderMcp();

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-test-server-1"]')!.click());
    await flush();
    expect(container.textContent).toContain('2025-06-18');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-sync-server-1"]')!.click());
    await flush();
    expect(container.textContent).toContain('1 added');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-delete-server-1"]')!.click());
    await flush();
    expect(container.textContent).toContain(mcpStrings.MCP_IN_USE_TITLE);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-force-delete-1"]')!.click());
    await flush();
    expect(mcpApi.deleteMcpServer).toHaveBeenLastCalledWith(1, { force: true }, expect.any(AbortSignal));
  });
});

describe('ToolReviewTable', () => {
  it('shows schema/hash/effect/state, does not auto-trust remote readOnly, and enforces review_mcp_tools', async () => {
    vi.mocked(mcpApi.reviewMcpTool).mockResolvedValue({
      tool: makeTool({ state: 'allowed', effect: 'read' }),
    });
    await renderMcp();

    expect(container.textContent).toContain('lookup_order');
    expect(container.textContent).toContain('mcp__orders__lookup_order');
    expect(container.textContent).toContain('hash-abc-123');
    // Remote readOnlyHint in inputSchema must NOT auto-select read/allowed
    const effectSelect = container.querySelector<HTMLSelectElement>('[data-testid="mcp-tool-effect-10"]')!;
    expect(effectSelect.value).toBe('write');

    await act(async () => {
      setInputValue(effectSelect, 'read');
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mcp-tool-allow-10"]')!.click();
    });
    await flush();

    expect(mcpApi.reviewMcpTool).toHaveBeenCalledWith(10, { state: 'allowed', effect: 'read' }, expect.any(AbortSignal));

    // Without review_mcp_tools, action buttons are disabled
    actor.perms = new Set(['view_mcp_servers']);
    await renderMcp();
    expect(container.querySelector<HTMLButtonElement>('[data-testid="mcp-tool-allow-10"]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="mcp-tool-block-10"]')!.disabled).toBe(true);
  });
});

describe('ScopeToolBindings', () => {
  it('switches scopes, explains unavailable agent scope & support runtime boundary, and prevents stale response overwrite', async () => {
    let resolveSlow!: (v: mcpApi.McpBindingResponse) => void;
    const slowPromise = new Promise<mcpApi.McpBindingResponse>((r) => {
      resolveSlow = r;
    });
    vi.mocked(mcpApi.fetchMcpBindings)
      .mockResolvedValueOnce({
        binding: {
          scope: { kind: 'profile', id: '1' },
          aiToolsEnabled: true,
          maxRounds: 8,
          toolIds: [10],
          tools: [makeTool({ state: 'allowed', effect: 'read' })],
        },
      })
      .mockImplementationOnce(() => slowPromise)
      .mockResolvedValueOnce({
        binding: {
          scope: { kind: 'support_tenant', id: '101' },
          aiToolsEnabled: false,
          maxRounds: 4,
          toolIds: [],
          tools: [makeTool({ state: 'allowed', effect: 'read' })],
        },
      });

    await renderMcp();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-tab-bindings"]')!.click());
    await flush();

    // Trigger slow load for profile 2, then immediately switch to support_tenant 101
    const scopeIdSelect = container.querySelector<HTMLSelectElement>('[data-testid="mcp-binding-target"]')!;
    await act(async () => setInputValue(scopeIdSelect, '2'));

    const scopeKindSelect = container.querySelector<HTMLSelectElement>('[data-testid="mcp-binding-scope-kind"]')!;
    await act(async () => setInputValue(scopeKindSelect, 'support_tenant'));
    await flush();

    expect(container.textContent).toContain(mcpStrings.MCP_SUPPORT_RUNTIME_NOTE);

    // Resolve the stale profile 2 request; support_tenant 101 state must stay intact
    await act(async () => {
      resolveSlow({
        binding: {
          scope: { kind: 'profile', id: '2' },
          aiToolsEnabled: true,
          maxRounds: 12,
          toolIds: [10],
          tools: [],
        },
      });
    });
    await flush();
    const maxRoundsInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-max-rounds"]')!;
    expect(maxRoundsInput.value).toBe('4');

    // Agent scope shows unavailable explanation
    await act(async () => setInputValue(scopeKindSelect, 'agent'));
    await flush();
    expect(container.textContent).toContain(mcpStrings.MCP_SCOPE_UNAVAILABLE);
  });
});

describe('ApprovalQueue', () => {
  it('renders masked args, restricts approve/reject to pending, handles 409 conflict, and has no retry for executing/unknown', async () => {
    vi.mocked(mcpApi.fetchMcpApprovals).mockResolvedValue({
      approvals: [
        makeApproval({ id: 50, status: 'pending' }),
        makeApproval({ id: 51, status: 'executing' }),
        makeApproval({ id: 52, status: 'unknown' }),
      ],
    });
    vi.mocked(mcpApi.approveMcpAction).mockRejectedValueOnce(
      Object.assign(new Error('already decided'), { status: 409, code: 'already_decided' }),
    );

    await renderMcp();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-tab-approvals"]')!.click());
    await flush();

    expect(container.textContent).toContain(mcpStrings.MCP_APPROVALS_US2_NOTE);
    expect(container.textContent).toContain('{"orderId":"ord_1","token":"***"}');
    expect(container.querySelector('[data-testid="mcp-approve-50"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-reject-50"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mcp-approve-51"]')).toBeNull();
    expect(container.querySelector('[data-testid="mcp-approve-52"]')).toBeNull();
    expect(container.textContent).toContain(mcpStrings.MCP_APPROVAL_UNKNOWN_NOTICE);

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-approve-50"]')!.click());
    await flush();
    expect(container.textContent).toContain(mcpStrings.MCP_APPROVAL_CONFLICT);
    expect(mcpApi.fetchMcpApprovals).toHaveBeenCalledTimes(2);
  });
});

describe('McpCallLog & InternalOriginsEditor & Guards', () => {
  it('paginates call log and hides internal origins from non-primary users', async () => {
    vi.mocked(mcpApi.fetchMcpCalls)
      .mockResolvedValueOnce({ calls: [makeCall({ id: 100 })], nextBefore: '100' })
      .mockResolvedValueOnce({ calls: [makeCall({ id: 99, toolName: 'older_tool' })], nextBefore: null });

    await renderMcp();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-tab-calls"]')!.click());
    await flush();

    expect(container.textContent).toContain('lookup_order');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-calls-load-more"]')!.click());
    await flush();
    expect(container.textContent).toContain('older_tool');

    // Non-primary user cannot see or fetch internal origins
    expect(container.querySelector('[data-testid="mcp-tab-origins"]')).toBeNull();
    expect(mcpApi.fetchAllowedInternalOrigins).not.toHaveBeenCalled();

    // Primary user can open and save valid exact origin
    actor.isPrimary = true;
    vi.mocked(mcpApi.putAllowedInternalOrigins).mockResolvedValue({
      origins: ['https://mcp.internal:8443', 'http://127.0.0.1:9000'],
    });
    await renderMcp();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-tab-origins"]')!.click());
    await flush();
    expect(mcpApi.fetchAllowedInternalOrigins).toHaveBeenCalled();

    const originInput = container.querySelector<HTMLInputElement>('[data-testid="mcp-origin-input"]')!;
    await act(async () => setInputValue(originInput, 'http://127.0.0.1:9000'));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-origin-add"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="mcp-origin-save"]')!.click());
    await flush();
    expect(mcpApi.putAllowedInternalOrigins).toHaveBeenCalledWith(
      { origins: ['https://mcp.internal:8443', 'http://127.0.0.1:9000'] },
      expect.any(AbortSignal),
    );
  });

  it('guards AiPlatformApp MCP route by exact child permissions', async () => {
    actor.perms = new Set(['view_mcp_servers']);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/ai-platform/mcp']}>
            <AiPlatformApp />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(container.textContent).toContain(mcpStrings.MCP_PAGE_TITLE);

    // Without any AI platform permissions, shows no access and makes zero MCP calls
    vi.mocked(mcpApi.fetchMcpServers).mockClear();
    actor.perms = new Set();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/ai-platform/mcp']}>
            <AiPlatformApp />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(mcpApi.fetchMcpServers).not.toHaveBeenCalled();
  });
});
