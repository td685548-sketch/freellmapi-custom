// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalQueue } from './components/ApprovalQueue';
import { ScopeToolBindings } from './components/ScopeToolBindings';
import {
  approveMcpAction,
  fetchMcpApprovals,
  fetchMcpBindings,
  fetchMcpServers,
  fetchMcpServerTools,
  fetchProfileOptions,
  fetchSupportTenantOptions,
  putMcpBindings,
  rejectMcpAction,
} from './mcp-api';

const fixtures = vi.hoisted(() => ({ tc: (key: string) => key }));
vi.mock('../i18n/use-custom-t', () => ({ useCustomT: () => fixtures.tc }));
vi.mock('./mcp-api', () => ({
  MCP_LIMITS: { minRounds: 1, maxRounds: 8, defaultMaxRounds: 8 },
  fetchProfileOptions: vi.fn(),
  fetchSupportTenantOptions: vi.fn(),
  fetchMcpBindings: vi.fn(),
  putMcpBindings: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchMcpServerTools: vi.fn(),
  fetchMcpApprovals: vi.fn(),
  approveMcpAction: vi.fn(),
  rejectMcpAction: vi.fn(),
}));

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

function setReactInputChecked(el: HTMLInputElement, checked: boolean) {
  if (el.checked !== checked) {
    el.click();
  }
}

describe('F07 & F08 UI review regression tests', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    vi.mocked(fetchProfileOptions).mockResolvedValue([{ id: 1, name: 'Fresh profile' }]);
    vi.mocked(fetchSupportTenantOptions).mockResolvedValue([]);
    vi.mocked(fetchMcpBindings).mockResolvedValue({
      binding: {
        scope: { kind: 'profile', id: '1' },
        toolIds: [],
        tools: [],
        aiToolsEnabled: false,
        maxRounds: 8,
      },
    });
    vi.mocked(fetchMcpServers).mockResolvedValue({
      servers: [{ id: 1, enabled: true }] as never,
    });
    vi.mocked(fetchMcpServerTools).mockResolvedValue({
      tools: [
        {
          id: 42,
          serverId: 1,
          name: 'lookup',
          exposedName: 'mcp__review__lookup',
          description: 'Lookup tool',
          inputSchema: {},
          outputSchema: null,
          schemaHash: 'h42',
          effect: 'read',
          state: 'allowed',
          reviewedBy: 1,
          reviewedAt: null,
          missingSince: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });
  });

  it('offers a reviewed tool for the first binding on a fresh profile', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ScopeToolBindings canEdit={true} />);
      });
      await flush();
      expect(container.querySelector('[data-testid="mcp-binding-tool-42"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('supports bind -> save -> reload -> unbind -> save -> rebind on a fresh profile', async () => {
    let serverToolIds: number[] = [];
    let serverEnabled = false;

    vi.mocked(fetchMcpBindings).mockImplementation(async () => ({
      binding: {
        scope: { kind: 'profile', id: '1' },
        toolIds: [...serverToolIds],
        tools: [],
        aiToolsEnabled: serverEnabled,
        maxRounds: 8,
      },
    }));

    vi.mocked(putMcpBindings).mockImplementation(async (_scope, input) => {
      serverToolIds = [...input.toolIds];
      serverEnabled = input.enabled;
      return {
        binding: {
          scope: { kind: 'profile', id: '1' },
          toolIds: [...serverToolIds],
          tools: [],
          aiToolsEnabled: serverEnabled,
          maxRounds: input.maxRounds ?? 8,
        },
      };
    });

    const container = document.createElement('div');
    document.body.append(container);
    let root = createRoot(container);
    try {
      // 1. Fresh profile: tool 42 is offered unchecked -> bind & save
      await act(async () => {
        root.render(<ScopeToolBindings canEdit={true} />);
      });
      await flush();

      const cb1 = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-tool-42"]')!;
      expect(cb1).not.toBeNull();
      expect(cb1.checked).toBe(false);

      await act(async () => {
        setReactInputChecked(cb1, true);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-bindings"]')!.click();
      });
      await flush();
      expect(serverToolIds).toEqual([42]);

      // 2. Reload -> tool 42 is checked -> unbind & save
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => {
        root.render(<ScopeToolBindings canEdit={true} />);
      });
      await flush();

      const cb2 = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-tool-42"]')!;
      expect(cb2.checked).toBe(true);
      await act(async () => {
        setReactInputChecked(cb2, false);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-bindings"]')!.click();
      });
      await flush();
      expect(serverToolIds).toEqual([]);

      // 3. Rebind from same screen -> save
      const cb3 = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-tool-42"]')!;
      expect(cb3.checked).toBe(false);
      await act(async () => {
        setReactInputChecked(cb3, true);
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="mcp-save-bindings"]')!.click();
      });
      await flush();
      expect(serverToolIds).toEqual([42]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('keeps pending/blocked/missing tools disabled while allowing unbind of unusable bound tools', async () => {
    vi.mocked(fetchMcpBindings).mockResolvedValue({
      binding: {
        scope: { kind: 'profile', id: '1' },
        toolIds: [43],
        tools: [
          {
            id: 43,
            serverId: 1,
            name: 'old_bound',
            exposedName: 'mcp__review__old_bound',
            description: null,
            inputSchema: {},
            outputSchema: null,
            schemaHash: 'h43',
            effect: 'write',
            state: 'blocked',
            reviewedBy: 1,
            reviewedAt: null,
          missingSince: null,
            createdAt: '',
            updatedAt: '',
          },
        ],
        aiToolsEnabled: true,
        maxRounds: 8,
      },
    });
    vi.mocked(fetchMcpServerTools).mockResolvedValue({
      tools: [
        {
          id: 42,
          serverId: 1,
          name: 'lookup',
          exposedName: 'mcp__review__lookup',
          description: null,
          inputSchema: {},
          outputSchema: null,
          schemaHash: 'h42',
          effect: 'read',
          state: 'allowed',
          reviewedBy: 1,
          reviewedAt: null,
          missingSince: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 43,
          serverId: 1,
          name: 'old_bound',
          exposedName: 'mcp__review__old_bound',
          description: null,
          inputSchema: {},
          outputSchema: null,
          schemaHash: 'h43',
          effect: 'write',
          state: 'blocked',
          reviewedBy: 1,
          reviewedAt: null,
          missingSince: null,
          createdAt: '',
          updatedAt: '',
        },
        {
          id: 44,
          serverId: 1,
          name: 'pending_tool',
          exposedName: 'mcp__review__pending_tool',
          description: null,
          inputSchema: {},
          outputSchema: null,
          schemaHash: 'h44',
          effect: 'write',
          state: 'pending',
          reviewedBy: null,
          reviewedAt: null,
          missingSince: null,
          createdAt: '',
          updatedAt: '',
        },
      ],
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ScopeToolBindings canEdit={true} />);
      });
      await flush();

      // Bound unusable tool 43 can still be unchecked
      const boundBlocked = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-tool-43"]');
      expect(boundBlocked).not.toBeNull();
      expect(boundBlocked!.checked).toBe(true);
      expect(boundBlocked!.disabled).toBe(false);

      // Unbound pending tool 44 is disabled and cannot be enabled
      const pendingTool = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-disabled-tool-44"]');
      expect(pendingTool).not.toBeNull();
      expect(pendingTool!.disabled).toBe(true);
      expect(container.querySelector('[data-testid="mcp-binding-tool-44"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('handles 403 on catalog fetch and prevents stale scope response overwrite', async () => {
    vi.mocked(fetchProfileOptions).mockResolvedValue([
      { id: 1, name: 'Profile One' },
      { id: 2, name: 'Profile Two' },
    ]);
    vi.mocked(fetchMcpServers).mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));

    let resolveP1!: (v: Awaited<ReturnType<typeof fetchMcpBindings>>) => void;
    vi.mocked(fetchMcpBindings).mockImplementation((scope) => {
      if (scope.id === '1') {
        return new Promise((res) => {
          resolveP1 = res;
        });
      }
      return Promise.resolve({
        binding: {
          scope: { kind: 'profile', id: '2' },
          toolIds: [],
          tools: [],
          aiToolsEnabled: true,
          maxRounds: 4,
        },
      });
    });

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ScopeToolBindings canEdit={true} />);
      });
      await flush();

      // Switch to profile 2 while profile 1 is still pending
      const select = container.querySelector<HTMLSelectElement>('[data-testid="mcp-binding-target"]')!;
      await act(async () => {
        select.value = '2';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();

      // Resolve stale profile 1 response now
      await act(async () => {
        resolveP1({
          binding: {
            scope: { kind: 'profile', id: '1' },
            toolIds: [99],
            tools: [],
            aiToolsEnabled: false,
            maxRounds: 8,
          },
        });
      });
      await flush();

      // Profile 2 state must remain intact
      const enabledCb = container.querySelector<HTMLInputElement>('[data-testid="mcp-binding-enabled"]')!;
      expect(enabledCb.checked).toBe(true);
      expect(container.textContent).toContain('Access denied');
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('displays masked result and error on ApprovalQueue without retry for executing/unknown (F08)', async () => {
    vi.mocked(fetchMcpApprovals).mockResolvedValue({
      approvals: [
        {
          id: 10,
          executionKey: 'exec-10',
          runId: null,
          stepSeq: 1,
          scopeKind: 'profile',
          scopeId: '1',
          endUser: null,
          toolId: 42,
          exposedName: 'mcp__review__mutate',
          serverSlug: 'review',
          argsMasked: '{"id":"order"}',
          status: 'succeeded',
          decidedBy: 1,
          decidedAt: '2026-11-14T00:00:00Z',
          decisionNote: 'ok',
          resultMasked: '{"done":true}',
          error: null,
          expiresAt: '2026-11-15T00:00:00Z',
          createdAt: '2026-11-14T00:00:00Z',
        },
        {
          id: 11,
          executionKey: 'exec-11',
          runId: null,
          stepSeq: 2,
          scopeKind: 'profile',
          scopeId: '1',
          endUser: null,
          toolId: 42,
          exposedName: 'mcp__review__mutate',
          serverSlug: 'review',
          argsMasked: '{"id":"order-2"}',
          status: 'unknown',
          decidedBy: 1,
          decidedAt: '2026-11-14T00:00:00Z',
          decisionNote: null,
          resultMasked: null,
          error: 'Remote stream dropped cleanly',
          expiresAt: '2026-11-15T00:00:00Z',
          createdAt: '2026-11-14T00:00:00Z',
        },
      ],
    });
    vi.mocked(approveMcpAction).mockResolvedValue({ approvals: [] } as never);
    vi.mocked(rejectMcpAction).mockResolvedValue({ approvals: [] } as never);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ApprovalQueue canApprove={true} />);
      });
      await flush();

      expect(container.querySelector('[data-testid="mcp-approval-result-10"]')?.textContent).toContain('{"done":true}');
      expect(container.querySelector('[data-testid="mcp-approval-result-11"]')?.textContent).toContain('Remote stream dropped cleanly');
      expect(container.querySelector('[data-testid="mcp-approve-11"]')).toBeNull();
      expect(container.querySelector('[data-testid="mcp-reject-11"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
