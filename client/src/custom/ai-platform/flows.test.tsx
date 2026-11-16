// @vitest-environment jsdom
/**
 * T130 — AI Platform Orchestrator (Flows & Runs) UI tests (native createRoot/act, no @testing-library/react).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../../../shared/user-access';
import { VI } from '../i18n/vi';
import { AiPlatformApp } from './AiPlatformApp';
import { RunTrace } from './components/RunTrace';
import * as flowsApi from './flows-api';
import * as flowsStrings from './flows-strings';
import { Flows } from './pages/Flows';
import { RUN_POLL_INTERVAL_MS, Runs } from './pages/Runs';

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
        promptCache: false,
        mcpClient: false,
        outputGuard: false,
        orchestrator: true,
      },
      retention: { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 },
      pillars: {
        prompts: { enabled: false, ready: false, summary: '' },
        retrieval: { enabled: false, ready: false, summary: '' },
        promptCache: { enabled: false, ready: false, summary: '' },
        mcpClient: { enabled: false, ready: false, summary: '' },
        outputGuard: { enabled: false, ready: false, summary: '' },
        orchestrator: { enabled: true, ready: true, summary: 'Ready' },
      },
      warnings: [],
    }),
  };
});

vi.mock('./flows-api', async () => {
  const actual = await vi.importActual<typeof import('./flows-api')>('./flows-api');
  return {
    ...actual,
    fetchAgents: vi.fn(),
    fetchAgent: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    fetchFlows: vi.fn(),
    fetchFlowDetail: vi.fn(),
    createFlow: vi.fn(),
    updateFlowDraft: vi.fn(),
    publishFlow: vi.fn(),
    setFlowGrants: vi.fn(),
    tryFlow: vi.fn(),
    deleteFlow: vi.fn(),
    fetchRuns: vi.fn(),
    fetchRunDetail: vi.fn(),
    cancelRun: vi.fn(),
    fetchFlowApprovals: vi.fn(),
    approveFlowAction: vi.fn(),
    rejectFlowAction: vi.fn(),
    fetchFlowProfileOptions: vi.fn(),
    fetchFlowSupportTenantOptions: vi.fn(),
    fetchFlowModelOptions: vi.fn(),
  };
});

function makeAgent(overrides: Partial<flowsApi.AgentView> = {}): flowsApi.AgentView {
  return {
    id: 1,
    slug: 'triage',
    name: 'Triage Agent',
    description: 'Routes incoming questions',
    model: 'auto',
    knowledgeScopeKind: null,
    knowledgeScopeId: null,
    outputPolicyScope: null,
    maxOutputTokens: null,
    enabled: true,
    revision: 1,
    publishedPromptVersion: 1,
    systemPrompt: 'Route customer requests.',
    ...overrides,
  };
}

function makeFlow(overrides: Partial<flowsApi.FlowView> = {}): flowsApi.FlowView {
  return {
    id: 10,
    slug: 'triage-flow',
    name: 'Triage Flow',
    description: 'Main support triage',
    draft: {
      kind: 'handoff',
      entryAgent: 'triage',
      agents: ['triage', 'billing'],
      handoffs: { triage: ['billing'], billing: [] },
      limits: { ...flowsApi.DEFAULT_FLOW_LIMITS },
      awaitingApprovalText: flowsApi.FLOW_LIMITS.defaultAwaitingApprovalText,
      approvalTtlHours: flowsApi.FLOW_LIMITS.defaultApprovalTtlHours,
    },
    published: null,
    publishedVersion: 0,
    enabled: true,
    revision: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<flowsApi.FlowRunView> = {}): flowsApi.FlowRunView {
  return {
    id: 'run_abc-123',
    flowId: 10,
    flowSlug: 'triage-flow',
    flowVersion: 1,
    profileId: 1,
    endUser: 'cust-42',
    wire: 'openai-chat',
    status: 'completed',
    stopReason: null,
    steps: 2,
    toolCalls: 1,
    handoffs: 1,
    promptTokens: 120,
    completionTokens: 45,
    totalTokens: 165,
    finalTextMasked: 'Your refund has been initiated.',
    error: null,
    startedAt: '2026-11-16T10:00:00Z',
    finishedAt: '2026-11-16T10:00:02Z',
    isDryRun: false,
    ...overrides,
  };
}

function makeStep(overrides: Partial<flowsApi.FlowRunStepView> = {}): flowsApi.FlowRunStepView {
  return {
    runId: 'run_abc-123',
    seq: 1,
    kind: 'model',
    agentSlug: 'triage',
    model: 'gpt-4o-mini',
    toolName: null,
    inputMasked: '{"message":"Need refund for [EMAIL]"}',
    outputMasked: '{"tool":"transfer_to_billing"}',
    promptTokens: 60,
    completionTokens: 20,
    durationMs: 310,
    status: 'ok',
    error: null,
    createdAt: '2026-11-16T10:00:01Z',
    ...overrides,
  };
}

function makeApproval(overrides: Partial<flowsApi.McpApprovalView> = {}): flowsApi.McpApprovalView {
  return {
    id: 77,
    executionKey: 'exec-flow-77',
    runId: 'run_wait-1',
    stepSeq: 3,
    scopeKind: 'agent',
    scopeId: '2',
    endUser: 'cust-99',
    toolId: 15,
    toolName: 'issue_refund',
    exposedName: 'mcp__billing__issue_refund',
    serverId: 1,
    serverSlug: 'billing',
    argsMasked: '{"orderId":"ord_99","token":"***"}',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: '2026-11-17T10:00:00Z',
    createdAt: '2026-11-16T10:00:00Z',
    ...overrides,
  };
}

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

function setInputValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
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

function renderEl(el: React.ReactElement) {
  act(() => {
    root.render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
  });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  actor.perms = new Set([
    'view_flows',
    'edit_flows',
    'publish_flows',
    'view_flow_runs',
    'cancel_flow_runs',
    'approve_ai_actions',
  ]);
  actor.isPrimary = false;
  actor.userId = 1;

  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const triage = makeAgent();
  const billing = makeAgent({ id: 2, slug: 'billing', name: 'Billing Agent', model: 'fusion' });
  const flow = makeFlow();

  vi.mocked(flowsApi.fetchAgents).mockResolvedValue({ agents: [triage, billing] });
  vi.mocked(flowsApi.fetchFlows).mockResolvedValue({ flows: [flow] });
  vi.mocked(flowsApi.fetchFlowDetail).mockResolvedValue({ flow, grantedProfileIds: [1] });
  vi.mocked(flowsApi.fetchFlowProfileOptions).mockResolvedValue([
    { id: 1, name: 'Default Profile' },
    { id: 2, name: 'VIP Support' },
  ]);
  vi.mocked(flowsApi.fetchFlowSupportTenantOptions).mockResolvedValue([
    { id: '10', name: 'Acme Tenant' },
  ]);
  vi.mocked(flowsApi.fetchFlowModelOptions).mockResolvedValue(['auto', 'fusion', 'gpt-4o-mini']);
  vi.mocked(flowsApi.fetchRuns).mockResolvedValue({ runs: [makeRun()] });
  vi.mocked(flowsApi.fetchRunDetail).mockResolvedValue({
    run: makeRun(),
    steps: [makeStep()],
  });
  vi.mocked(flowsApi.fetchFlowApprovals).mockResolvedValue({ approvals: [makeApproval()] });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  qc.clear();
  container.remove();
  vi.clearAllMocks();
});

describe('Flows i18n strings', () => {
  it('provides Vietnamese translations with matching placeholders for every flows-strings constant', () => {
    const entries = Object.entries(flowsStrings).filter(
      ([, v]) => typeof v === 'string',
    ) as Array<[string, string]>;
    expect(entries.length).toBeGreaterThan(50);

    for (const [key, en] of entries) {
      expect(en.trim().length, `${key} must not be empty`).toBeGreaterThan(0);
      const viText = VI[en];
      expect(viText, `Missing VI translation for ${key}: "${en}"`).toBeTruthy();
      const enVars = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const viVars = [...viText.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(viVars).toEqual(enVars);
    }
  });
});

describe('Flows RBAC & AiPlatformApp routing', () => {
  it('does NOT grant flows or runs access to manage_ai_platform alone', async () => {
    actor.perms = new Set(['manage_ai_platform']);
    renderEl(
      <MemoryRouter initialEntries={['/ai-platform/flows']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();

    expect(container.querySelector('[data-testid="flows-page"]')).toBeNull();
    expect(flowsApi.fetchFlows).not.toHaveBeenCalled();
    expect(flowsApi.fetchAgents).not.toHaveBeenCalled();
  });

  it('routes /ai-platform/flows and /ai-platform/runs to real Flows and Runs pages when permitted', async () => {
    renderEl(
      <MemoryRouter key="flows-route" initialEntries={['/ai-platform/flows']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();
    expect(container.querySelector('[data-testid="flows-page"]')).not.toBeNull();
    expect(container.textContent).toContain('Triage Flow');

    renderEl(
      <MemoryRouter key="runs-route" initialEntries={['/ai-platform/runs']}>
        <Routes><Route path="/ai-platform/*" element={<AiPlatformApp />} /></Routes>
      </MemoryRouter>,
    );
    await flush();
    expect(container.querySelector('[data-testid="runs-page"]')).not.toBeNull();
    expect(container.textContent).toContain('run_abc-123');
  });

  it('locks edit, publish, grants, and dry-run for view_flows-only user', async () => {
    actor.perms = new Set(['view_flows']);
    renderEl(<Flows />);
    await flush();

    expect(container.querySelector('[data-testid="flows-view-only-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="agent-add-btn"]')).toBeNull();
    expect(
      (container.querySelector('[data-testid="flow-save-draft-btn"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector('[data-testid="flow-publish-btn"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector('[data-testid="flow-save-grants-btn"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (container.querySelector('[data-testid="flow-try-btn"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('fires zero GET requests on Flows when user lacks view_flows and zero GET /runs without view_flow_runs', async () => {
    actor.perms = new Set(['edit_flows']);
    renderEl(<Flows />);
    await flush();

    expect(container.querySelector('[data-testid="flows-editor-only-notice"]')).not.toBeNull();
    expect(flowsApi.fetchAgents).not.toHaveBeenCalled();
    expect(flowsApi.fetchFlows).not.toHaveBeenCalled();

    // approve_ai_actions only on Runs: fetches approvals, never /runs
    actor.perms = new Set(['approve_ai_actions']);
    renderEl(<Runs />);
    await flush();

    expect(container.querySelector('[data-testid="runs-view-required-notice"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="runs-approvals-section"]')).not.toBeNull();
    expect(flowsApi.fetchRuns).not.toHaveBeenCalled();
    expect(flowsApi.fetchFlowApprovals).toHaveBeenCalledWith('pending', expect.any(AbortSignal));
  });
});

describe('Agents CRUD & 409 in_use error (T130)', () => {
  it('creates an agent with model/combo and renders 409 in_use referencing flows on delete', async () => {
    vi.mocked(flowsApi.createAgent).mockResolvedValue({
      agent: makeAgent({ id: 3, slug: 'qa', name: 'QA Agent', model: 'combo:support' }),
    });
    vi.mocked(flowsApi.deleteAgent).mockRejectedValueOnce(
      Object.assign(new Error('Agent is used by flows'), {
        status: 409,
        code: 'in_use',
        details: { flows: ['triage-flow', 'escalation-flow'] },
      }),
    );

    renderEl(<Flows />);
    await flush();

    // Create agent
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-add-btn"]')!.click();
    });
    act(() => {
      setInputValue(container.querySelector('[data-testid="agent-input-slug"]')!, 'qa');
      setInputValue(container.querySelector('[data-testid="agent-input-name"]')!, 'QA Agent');
      setInputValue(
        container.querySelector('[data-testid="agent-input-model"]')!,
        'combo:support',
      );
      setInputValue(
        container.querySelector('[data-testid="agent-input-prompt"]')!,
        'Answer QA questions.',
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-save-btn"]')!.click();
    });
    await flush();

    expect(flowsApi.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'qa',
        name: 'QA Agent',
        model: 'combo:support',
        systemPrompt: 'Answer QA questions.',
      }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="agent-row-qa"]')).not.toBeNull();

    // Delete agent referenced by flows -> 409 in_use
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="agent-delete-triage"]')!.click();
    });
    await flush();

    const inUseBox = container.querySelector('[data-testid="agent-in-use-error"]');
    expect(inUseBox).not.toBeNull();
    expect(inUseBox?.textContent).toContain('triage-flow');
    expect(inUseBox?.textContent).toContain('escalation-flow');
  });
});

describe('Flow draft editing, hard ceilings, 422, 409, publish, grants & dry-run Try (T130)', () => {
  it('edits single vs handoff, shows hard ceiling hints & warnings, handles 422 & 409, publishes, saves grants & runs dry test', async () => {
    const updatedFlow = makeFlow({ revision: 2 });
    const publishedFlow = makeFlow({
      revision: 3,
      publishedVersion: 1,
      published: {
        ...makeFlow().draft,
        agentPromptVersions: { triage: 1, billing: 1 },
      },
    });
    vi.mocked(flowsApi.updateFlowDraft)
      .mockRejectedValueOnce(
        Object.assign(new Error('Validation failed'), {
          status: 422,
          code: 'invalid_flow_definition',
          errors: [{ field: 'limits.maxSteps', message: 'maxSteps must be <= 50' }],
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('Revision conflict'), {
          status: 409,
          code: 'revision_conflict',
        }),
      )
      .mockResolvedValueOnce({ flow: updatedFlow });

    vi.mocked(flowsApi.publishFlow).mockResolvedValue({ flow: publishedFlow });
    vi.mocked(flowsApi.setFlowGrants).mockResolvedValue({
      grantedProfileIds: [1, 2],
      flow: publishedFlow,
    });
    vi.mocked(flowsApi.tryFlow)
      .mockRejectedValueOnce(
        Object.assign(new Error('Pillar disabled'), { status: 409, code: 'pillar_disabled' }),
      )
      .mockResolvedValueOnce({
        run: makeRun({ id: 'run_try-1', isDryRun: true, finalTextMasked: 'Dry-run reply' }),
        steps: [
          makeStep({ runId: 'run_try-1', seq: 1, kind: 'model', agentSlug: 'triage' }),
          makeStep({
            runId: 'run_try-1',
            seq: 2,
            kind: 'handoff',
            agentSlug: 'billing',
            model: null,
            toolName: 'transfer_to_billing',
          }),
        ],
        outputText: 'Dry-run reply',
      });

    renderEl(<Flows />);
    await flush();

    // Hard ceiling hints displayed (50, 100, 10, 500,000, 600s)
    const editorText = container.querySelector('[data-testid="flow-draft-editor"]')?.textContent ?? '';
    expect(editorText).toContain('50');
    expect(editorText).toContain('100');
    expect(editorText).toContain('10');
    expect(editorText).toContain('500,000');
    expect(editorText).toContain('600s');

    // Toggle single -> handoffs note shown, then back to handoff
    const kindSelect = container.querySelector<HTMLSelectElement>('[data-testid="flow-kind-select"]')!;
    act(() => {
      setInputValue(kindSelect, 'single');
    });
    expect(container.querySelector('[data-testid="flow-handoffs-single-note"]')).not.toBeNull();
    act(() => {
      setInputValue(kindSelect, 'handoff');
    });
    const billingToTriage = container.querySelector<HTMLInputElement>(
      '[data-testid="flow-handoff-billing-triage"]',
    )!;
    expect(billingToTriage).not.toBeNull();
    act(() => {
      billingToTriage.click();
    });

    // Exceeding hard ceiling triggers client warning and 422 error display on submit
    const stepsInput = container.querySelector<HTMLInputElement>('[data-testid="flow-limit-steps"]')!;
    act(() => {
      setInputValue(stepsInput, '51');
    });
    expect(container.querySelector('[data-testid="flow-limits-ceiling-errors"]')).not.toBeNull();

    const saveDraftBtn = container.querySelector<HTMLButtonElement>('[data-testid="flow-save-draft-btn"]')!;
    act(() => {
      saveDraftBtn.click();
    });
    await flush();

    const valErrors = container.querySelector('[data-testid="flow-validation-errors"]');
    expect(valErrors).not.toBeNull();
    expect(valErrors?.textContent).toContain('limits.maxSteps');

    // Fix steps to valid value, trigger 409 conflict banner & reload
    act(() => {
      setInputValue(stepsInput, '15');
    });
    act(() => {
      saveDraftBtn.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="flow-conflict-banner"]')).not.toBeNull();

    const reloadCallsBefore = vi.mocked(flowsApi.fetchFlowDetail).mock.calls.length;
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flow-conflict-reload-btn"]')!.click();
    });
    await flush();
    expect(vi.mocked(flowsApi.fetchFlowDetail).mock.calls.length).toBeGreaterThan(reloadCallsBefore);
    expect(container.querySelector('[data-testid="flow-conflict-banner"]')).toBeNull();

    // Save draft succeeds
    act(() => {
      saveDraftBtn.click();
    });
    await flush();
    expect(flowsApi.updateFlowDraft).toHaveBeenLastCalledWith(
      10,
      expect.objectContaining({ revision: 1 }),
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="flow-revision-badge"]')?.textContent).toContain('2');

    // Publish flow
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flow-publish-btn"]')!.click();
    });
    await flush();
    expect(flowsApi.publishFlow).toHaveBeenCalledWith(10, 2, expect.any(AbortSignal));

    // Update client profile grants
    const profile2Check = container.querySelector<HTMLInputElement>(
      '[data-testid="flow-grant-profile-2"]',
    )!;
    act(() => {
      profile2Check.click();
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flow-save-grants-btn"]')!.click();
    });
    await flush();
    expect(flowsApi.setFlowGrants).toHaveBeenCalledWith(10, [1, 2], expect.any(AbortSignal));

    // Try Draft: 409 pillar_disabled then success with RunTrace
    act(() => {
      setInputValue(
        container.querySelector('[data-testid="flow-try-message-input"]')!,
        'Help with invoice',
      );
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flow-try-btn"]')!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="flow-try-error"]')?.textContent).toContain('409');

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="flow-try-btn"]')!.click();
    });
    await flush();
    expect(container.querySelector('[data-testid="flow-try-output"]')?.textContent).toContain(
      'Dry-run reply',
    );
    expect(container.querySelector('[data-testid="flow-try-trace"]')?.textContent).toContain(
      'transfer_to_billing',
    );
  });
});

describe('Runs, RunTrace, live ?after= polling, Cancel & Pending Approvals (T130)', () => {
  it('renders all RunTrace step kinds cleanly', () => {
    const steps: flowsApi.FlowRunStepView[] = [
      makeStep({ seq: 1, kind: 'model', agentSlug: 'triage' }),
      makeStep({ seq: 2, kind: 'tool', agentSlug: 'triage', toolName: 'lookup_order' }),
      makeStep({ seq: 3, kind: 'handoff', agentSlug: 'billing', toolName: 'transfer_to_billing' }),
      makeStep({ seq: 4, kind: 'approval', agentSlug: 'billing', toolName: 'issue_refund' }),
      makeStep({ seq: 5, kind: 'guard', agentSlug: 'billing', status: 'error', error: 'PII masked' }),
      makeStep({ seq: 6, kind: 'stop', agentSlug: 'billing', outputMasked: 'max_steps' }),
    ];
    renderEl(<RunTrace run={makeRun({ status: 'stopped', stopReason: 'max_steps' })} steps={steps} />);

    expect(container.querySelector('[data-testid="run-trace-stop-reason"]')?.textContent).toBe('max_steps');
    expect(container.querySelector('[data-testid="run-step-kind-1"]')?.textContent).toBe('Model');
    expect(container.querySelector('[data-testid="run-step-kind-2"]')?.textContent).toBe('Tool');
    expect(container.querySelector('[data-testid="run-step-kind-3"]')?.textContent).toBe('Handoff');
    expect(container.querySelector('[data-testid="run-step-kind-4"]')?.textContent).toBe('Approval');
    expect(container.querySelector('[data-testid="run-step-kind-5"]')?.textContent).toBe('Output guard');
    expect(container.querySelector('[data-testid="run-step-kind-6"]')?.textContent).toBe('Stopped');
    expect(container.textContent).toContain('PII masked');
  });

  it('filters runs, polls ?after=<seq> while running, cancels active run, and handles Pending Approvals', async () => {
    vi.useFakeTimers();

    const runningRun = makeRun({ id: 'run_live-1', status: 'running', steps: 1 });
    const completedRun = makeRun({
      id: 'run_live-1',
      status: 'completed',
      steps: 2,
      finalTextMasked: 'All done!',
    });

    vi.mocked(flowsApi.fetchRuns).mockResolvedValue({ runs: [runningRun] });
    vi.mocked(flowsApi.fetchRunDetail)
      .mockResolvedValueOnce({
        run: runningRun,
        steps: [makeStep({ runId: 'run_live-1', seq: 1, kind: 'model' })],
      })
      .mockResolvedValueOnce({
        run: runningRun,
        steps: [makeStep({ runId: 'run_live-1', seq: 2, kind: 'tool', toolName: 'lookup_order' })],
      })
      .mockResolvedValueOnce({
        run: completedRun,
        steps: [],
      });

    vi.mocked(flowsApi.cancelRun).mockResolvedValue({
      ok: true,
      run: makeRun({ id: 'run_live-1', status: 'cancelled' }),
    });
    vi.mocked(flowsApi.approveFlowAction)
      .mockRejectedValueOnce(
        Object.assign(new Error('Already decided'), { status: 409, code: 'already_decided' }),
      )
      .mockResolvedValueOnce({ approval: makeApproval({ id: 77, status: 'approved' }) });
    vi.mocked(flowsApi.rejectFlowAction).mockResolvedValue({
      approval: makeApproval({ id: 78, status: 'rejected' }),
    });

    renderEl(<Runs />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="run-trace-polling"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="run-step-1"]')).not.toBeNull();

    // First poll tick fetches ?after=1 and merges step #2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_INTERVAL_MS);
    });
    expect(flowsApi.fetchRunDetail).toHaveBeenCalledWith(
      'run_live-1',
      1,
      expect.any(AbortSignal),
    );
    expect(container.querySelector('[data-testid="run-step-2"]')).not.toBeNull();

    // Cancel active run (when cancel_flow_runs is granted)
    const cancelBtn = container.querySelector<HTMLButtonElement>('[data-testid="run-trace-cancel-btn"]');
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn!.disabled).toBe(false);
    act(() => {
      cancelBtn!.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(flowsApi.cancelRun).toHaveBeenCalledWith('run_live-1', expect.any(AbortSignal));

    // Pending approvals: 409 already_decided refreshes queue, then approve & reject work
    vi.mocked(flowsApi.fetchFlowApprovals).mockResolvedValueOnce({
      approvals: [makeApproval({ id: 77 }), makeApproval({ id: 78, toolName: 'delete_ticket' })],
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="runs-approve-77"]')!.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="runs-approvals-error"]')).not.toBeNull();

    act(() => {
      setInputValue(container.querySelector('[data-testid="runs-approval-note-77"]')!, 'Verified');
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="runs-approve-77"]')!.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(flowsApi.approveFlowAction).toHaveBeenLastCalledWith(
      77,
      { note: 'Verified' },
      expect.any(AbortSignal),
    );

    act(() => {
      container.querySelector<HTMLButtonElement>('[data-testid="runs-reject-78"]')!.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(flowsApi.rejectFlowAction).toHaveBeenCalledWith(78, { note: undefined }, expect.any(AbortSignal));

    // Filter changes trigger fetchRuns with query params
    act(() => {
      setInputValue(container.querySelector('[data-testid="runs-filter-flow"]')!, 'triage-flow');
      setInputValue(container.querySelector('[data-testid="runs-filter-status"]')!, 'stopped');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(flowsApi.fetchRuns).toHaveBeenLastCalledWith(
      expect.objectContaining({ flow: 'triage-flow', status: 'stopped' }),
      expect.any(AbortSignal),
    );
  });

  it('disables Cancel button when user lacks cancel_flow_runs', async () => {
    actor.perms = new Set(['view_flow_runs']);
    vi.mocked(flowsApi.fetchRuns).mockResolvedValue({
      runs: [makeRun({ id: 'run_ro-1', status: 'running' })],
    });
    vi.mocked(flowsApi.fetchRunDetail).mockResolvedValue({
      run: makeRun({ id: 'run_ro-1', status: 'running' }),
      steps: [],
    });

    renderEl(<Runs />);
    await flush();

    const cancelBtn = container.querySelector<HTMLButtonElement>('[data-testid="run-trace-cancel-btn"]');
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn!.disabled).toBe(true);
    expect(container.querySelector('[data-testid="runs-approvals-section"]')).toBeNull();
  });
});

describe('AbortSignal & session isolation', () => {
  it('aborts in-flight flow load on unmount and ignores stale resolve after session change', async () => {
    let resolveLate!: (val: flowsApi.FlowsListResponse) => void;
    vi.mocked(flowsApi.fetchFlows).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLate = resolve;
        }),
    );

    renderEl(<Flows />);
    await flush();

    const firstSignal = vi.mocked(flowsApi.fetchFlows).mock.calls[0][0]!;
    expect(firstSignal.aborted).toBe(false);

    // Session switch aborts first request and loads second session cleanly
    actor.userId = 2;
    vi.mocked(flowsApi.fetchFlows).mockResolvedValueOnce({
      flows: [makeFlow({ id: 99, slug: 'session-2-flow', name: 'Session 2 Flow' })],
    });
    renderEl(<Flows />);
    await flush();

    expect(firstSignal.aborted).toBe(true);
    expect(container.textContent).toContain('Session 2 Flow');

    // Late resolve from session 1 must NOT overwrite session 2
    await act(async () => {
      resolveLate({
        flows: [makeFlow({ id: 55, slug: 'stale-flow', name: 'Stale Session 1 Flow' })],
      });
    });
    await flush();
    expect(container.textContent).not.toContain('Stale Session 1 Flow');
    expect(container.textContent).toContain('Session 2 Flow');
  });
});
