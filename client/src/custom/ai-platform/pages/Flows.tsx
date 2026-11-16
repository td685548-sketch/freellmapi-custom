import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useSessionRevision } from '../../session-state';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import { RunTrace } from '../components/RunTrace';
import {
  DEFAULT_FLOW_LIMITS,
  FLOW_LIMITS,
  createAgent,
  createFlow,
  deleteAgent,
  deleteFlow,
  extractFlowErrorInfo,
  fetchAgents,
  fetchFlowDetail,
  fetchFlowModelOptions,
  fetchFlowProfileOptions,
  fetchFlowSupportTenantOptions,
  fetchFlows,
  publishFlow,
  setFlowGrants,
  tryFlow,
  updateAgent,
  updateFlowDraft,
  type AgentInput,
  type AgentPatchInput,
  type AgentView,
  type FlowDefinition,
  type FlowDetailView,
  type FlowKind,
  type FlowLimitsConfig,
  type FlowTryResponse,
  type FlowValidationIssue,
  type FlowView,
  type ProfileOption,
  type ScopeKind,
  type SupportTenantOption,
} from '../flows-api';
import {
  AGENTS_ADD_BTN,
  AGENTS_CREATE_HEADING,
  AGENTS_DELETED,
  AGENTS_DELETE_ERROR,
  AGENTS_EDIT_HEADING,
  AGENTS_EMPTY,
  AGENTS_FIELD_DESCRIPTION,
  AGENTS_FIELD_KNOWLEDGE_ID,
  AGENTS_FIELD_KNOWLEDGE_KIND,
  AGENTS_FIELD_MAX_TOKENS,
  AGENTS_FIELD_MAX_TOKENS_PLACEHOLDER,
  AGENTS_FIELD_MODEL,
  AGENTS_FIELD_MODEL_HINT,
  AGENTS_FIELD_NAME,
  AGENTS_FIELD_OUTPUT_POLICY,
  AGENTS_FIELD_OUTPUT_POLICY_HINT,
  AGENTS_FIELD_PROMPT,
  AGENTS_FIELD_PROMPT_PLACEHOLDER,
  AGENTS_FIELD_SLUG,
  AGENTS_FIELD_SLUG_HINT,
  AGENTS_HEADING,
  AGENTS_IN_USE_FLOWS,
  AGENTS_IN_USE_TITLE,
  AGENTS_NO_PROMPT_VERSION,
  AGENTS_PROMPT_VERSION,
  AGENTS_SAVED,
  AGENTS_SAVE_ERROR,
  AGENTS_SCOPE_NONE,
  AGENTS_SCOPE_PROFILE,
  AGENTS_SCOPE_SUPPORT_TENANT,
  AGENTS_SUBTITLE,
  FLOWS_ADD_BTN,
  FLOWS_CANCEL,
  FLOWS_CREATED,
  FLOWS_CREATE_HEADING,
  FLOWS_DELETE,
  FLOWS_DELETED,
  FLOWS_DELETE_ERROR,
  FLOWS_DISABLED,
  FLOWS_DRAFT_SAVED,
  FLOWS_EDIT,
  FLOWS_EDITOR_ONLY_NOTICE,
  FLOWS_EMPTY,
  FLOWS_ENABLED,
  FLOWS_FIELD_DESCRIPTION,
  FLOWS_FIELD_NAME,
  FLOWS_FIELD_SLUG,
  FLOWS_FIELD_SLUG_HINT,
  FLOWS_FORBIDDEN_ERROR,
  FLOWS_GRANTS_ERROR,
  FLOWS_GRANTS_SAVED,
  FLOWS_LIST_HEADING,
  FLOWS_LOADING,
  FLOWS_LOAD_ERROR,
  FLOWS_NO_PERMISSION,
  FLOWS_NO_PUBLISH_NOTICE,
  FLOWS_PAGE_SUBTITLE,
  FLOWS_PAGE_TITLE,
  FLOWS_PILLAR_DISABLED,
  FLOWS_PUBLISHED,
  FLOWS_PUBLISHED_VERSION,
  FLOWS_PUBLISH_ERROR,
  FLOWS_REFRESH,
  FLOWS_RELOAD_LATEST,
  FLOWS_REVISION,
  FLOWS_REVISION_CONFLICT,
  FLOWS_SAVE,
  FLOWS_SAVE_ERROR,
  FLOWS_SAVING,
  FLOWS_SESSION_EXPIRED,
  FLOWS_UNPUBLISHED,
  FLOWS_VIEW_ONLY_NOTICE,
  FLOW_APPROVAL_TEXT_LABEL,
  FLOW_APPROVAL_TTL_HINT,
  FLOW_APPROVAL_TTL_LABEL,
  FLOW_EDITOR_HEADING,
  FLOW_ENTRY_AGENT,
  FLOW_GRANTS_EMPTY,
  FLOW_GRANTS_HEADING,
  FLOW_GRANTS_SAVE_BTN,
  FLOW_GRANTS_SAVING_BTN,
  FLOW_GRANTS_SUBTITLE,
  FLOW_HANDOFFS_FROM,
  FLOW_HANDOFFS_HEADING,
  FLOW_HANDOFFS_SINGLE_NOTE,
  FLOW_KIND_HANDOFF,
  FLOW_KIND_LABEL,
  FLOW_KIND_SINGLE,
  FLOW_LIMITS_HEADING,
  FLOW_LIMIT_CEILING_EXCEEDED,
  FLOW_LIMIT_HANDOFFS,
  FLOW_LIMIT_HANDOFFS_HINT,
  FLOW_LIMIT_SECONDS,
  FLOW_LIMIT_SECONDS_HINT,
  FLOW_LIMIT_STEPS,
  FLOW_LIMIT_STEPS_HINT,
  FLOW_LIMIT_TOKENS,
  FLOW_LIMIT_TOKENS_HINT,
  FLOW_LIMIT_TOOL_CALLS,
  FLOW_LIMIT_TOOL_CALLS_HINT,
  FLOW_NO_AGENTS_HINT,
  FLOW_PARTICIPATING_AGENTS,
  FLOW_PUBLISHING_BTN,
  FLOW_PUBLISH_BTN,
  FLOW_SAVE_DRAFT_BTN,
  FLOW_SAVING_DRAFT_BTN,
  FLOW_SELECT_HINT,
  FLOW_TRYING_BTN,
  FLOW_TRY_BTN,
  FLOW_TRY_ERROR,
  FLOW_TRY_HEADING,
  FLOW_TRY_MESSAGE_LABEL,
  FLOW_TRY_MESSAGE_PLACEHOLDER,
  FLOW_TRY_NOTE,
  FLOW_TRY_OUTPUT_LABEL,
  FLOW_VALIDATION_HEADING,
} from '../flows-strings';

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

interface AgentFormState {
  mode: 'create' | 'edit';
  editingId: number | null;
  revision: number;
  slug: string;
  name: string;
  description: string;
  model: string;
  systemPrompt: string;
  knowledgeScopeKind: '' | 'profile' | 'support_tenant';
  knowledgeScopeId: string;
  outputPolicyScope: string;
  maxOutputTokens: string;
  enabled: boolean;
}

function emptyAgentForm(): AgentFormState {
  return {
    mode: 'create',
    editingId: null,
    revision: 1,
    slug: '',
    name: '',
    description: '',
    model: 'auto',
    systemPrompt: '',
    knowledgeScopeKind: '',
    knowledgeScopeId: '',
    outputPolicyScope: '',
    maxOutputTokens: '',
    enabled: true,
  };
}

function agentToForm(agent: AgentView): AgentFormState {
  const kKind =
    agent.knowledgeScopeKind === 'profile' || agent.knowledgeScopeKind === 'support_tenant'
      ? agent.knowledgeScopeKind
      : '';
  return {
    mode: 'edit',
    editingId: agent.id,
    revision: agent.revision,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    model: agent.model,
    systemPrompt: agent.systemPrompt ?? '',
    knowledgeScopeKind: kKind,
    knowledgeScopeId: agent.knowledgeScopeId ?? '',
    outputPolicyScope: agent.outputPolicyScope ?? '',
    maxOutputTokens: agent.maxOutputTokens !== null ? String(agent.maxOutputTokens) : '',
    enabled: agent.enabled,
  };
}

function defaultFlowDefinition(agentsList: AgentView[]): FlowDefinition {
  const firstEnabled = agentsList.find((a) => a.enabled) ?? agentsList[0];
  const entry = firstEnabled ? firstEnabled.slug : '';
  return {
    kind: 'single',
    entryAgent: entry,
    agents: entry ? [entry] : [],
    handoffs: entry ? { [entry]: [] } : {},
    limits: { ...DEFAULT_FLOW_LIMITS },
    awaitingApprovalText: FLOW_LIMITS.defaultAwaitingApprovalText,
    approvalTtlHours: FLOW_LIMITS.defaultApprovalTtlHours,
  };
}

function cloneDefinition(def: FlowDefinition): FlowDefinition {
  const handoffs: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(def.handoffs ?? {})) {
    handoffs[k] = [...v];
  }
  return {
    kind: def.kind,
    entryAgent: def.entryAgent,
    agents: [...def.agents],
    handoffs,
    limits: { ...def.limits },
    awaitingApprovalText: def.awaitingApprovalText,
    approvalTtlHours: def.approvalTtlHours,
  };
}

export function Flows() {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();
  const globalSessionRev = useSessionRevision();

  const canView = isPrimary || can('view_flows');
  const canEdit = isPrimary || can('edit_flows');
  const canPublish = isPrimary || can('publish_flows');

  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    let idHash = 0;
    for (let i = 0; i < identity.length; i += 1) {
      idHash = (idHash * 31 + identity.charCodeAt(i)) | 0;
    }
    return uid * 10_000 + Math.abs(idHash % 1000) + globalSessionRev * 1000;
  }, [session?.userId, identity, globalSessionRev]);

  if (!canView && !canEdit && !canPublish) {
    return (
      <div data-testid="flows-no-permission">
        <p className="text-sm text-muted-foreground">{tc(FLOWS_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <FlowsContent
      key={sessionRevision}
      canView={canView}
      canEdit={canEdit}
      canPublish={canPublish}
    />
  );
}

function FlowsContent({
  canView,
  canEdit,
  canPublish,
}: {
  canView: boolean;
  canEdit: boolean;
  canPublish: boolean;
}) {
  const tc = useCustomT();

  // Lists & options
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [flows, setFlows] = useState<FlowView[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [tenants, setTenants] = useState<SupportTenantOption[]>([]);
  const [modelOptions, setModelOptions] = useState<string[]>(['auto', 'fusion']);

  const [loadingLists, setLoadingLists] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Agent form & errors
  const [agentForm, setAgentForm] = useState<AgentFormState | null>(null);
  const [savingAgent, setSavingAgent] = useState(false);
  const [agentBanner, setAgentBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [agentInUseError, setAgentInUseError] = useState<{
    agentName: string;
    flows: string[];
    message: string;
  } | null>(null);

  // Create flow form
  const [showCreateFlow, setShowCreateFlow] = useState(false);
  const [newFlowSlug, setNewFlowSlug] = useState('');
  const [newFlowName, setNewFlowName] = useState('');
  const [newFlowDesc, setNewFlowDesc] = useState('');
  const [newFlowKind, setNewFlowKind] = useState<FlowKind>('single');
  const [newFlowEntry, setNewFlowEntry] = useState('');
  const [creatingFlow, setCreatingFlow] = useState(false);

  // Selected flow & draft editor
  const [selectedFlowId, setSelectedFlowId] = useState<number | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<FlowView | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftDef, setDraftDef] = useState<FlowDefinition>(() => defaultFlowDefinition([]));
  const [draftRevision, setDraftRevision] = useState(1);
  const [grantedProfileIds, setGrantedProfileIds] = useState<number[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Flow actions feedback
  const [savingDraft, setSavingDraft] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [savingGrants, setSavingGrants] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FlowValidationIssue[]>([]);
  const [conflictBanner, setConflictBanner] = useState(false);
  const [flowBanner, setFlowBanner] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Dry-run try
  const [tryMessage, setTryMessage] = useState('');
  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  const [tryResult, setTryResult] = useState<FlowTryResponse | null>(null);

  // Lifecycle refs
  const mountedRef = useRef(true);
  const listsEpochRef = useRef(0);
  const detailEpochRef = useRef(0);
  const listsAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const actionAbortRef = useRef<AbortController | null>(null);
  const tryAbortRef = useRef<AbortController | null>(null);

  const formatApiError = useCallback(
    (err: unknown, fallback: string): string => {
      const info = extractFlowErrorInfo(err);
      if (info.status === 401) return tc(FLOWS_SESSION_EXPIRED);
      if (info.status === 403) return tc(FLOWS_FORBIDDEN_ERROR);
      if (info.status === 409 && info.code === 'pillar_disabled') return tc(FLOWS_PILLAR_DISABLED);
      return info.message && info.message !== 'Request failed' ? info.message : fallback;
    },
    [tc],
  );

  const applyFlowDetail = useCallback((detail: FlowDetailView) => {
    setSelectedFlow(detail.flow);
    setSelectedFlowId(detail.flow.id);
    setDraftName(detail.flow.name);
    setDraftDesc(detail.flow.description);
    setDraftEnabled(detail.flow.enabled);
    setDraftDef(cloneDefinition(detail.flow.draft));
    setDraftRevision(detail.flow.revision);
    setGrantedProfileIds([...detail.grantedProfileIds]);
    setValidationErrors([]);
    setConflictBanner(false);
  }, []);

  const loadFlowDetailById = useCallback(
    async (flowId: number) => {
      if (!canView) return;
      const epoch = ++detailEpochRef.current;
      detailAbortRef.current?.abort();
      const ac = new AbortController();
      detailAbortRef.current = ac;
      setLoadingDetail(true);
      try {
        const detail = await fetchFlowDetail(flowId, ac.signal);
        if (!mountedRef.current || ac.signal.aborted || detailEpochRef.current !== epoch) return;
        applyFlowDetail(detail);
      } catch (err) {
        if (!mountedRef.current || isAbortError(err) || detailEpochRef.current !== epoch) return;
        setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_LOAD_ERROR)) });
      } finally {
        if (mountedRef.current && detailEpochRef.current === epoch) {
          setLoadingDetail(false);
        }
      }
    },
    [applyFlowDetail, canView, formatApiError, tc],
  );

  const loadAll = useCallback(async () => {
    if (!canView) return;
    const epoch = ++listsEpochRef.current;
    listsAbortRef.current?.abort();
    const ac = new AbortController();
    listsAbortRef.current = ac;
    setLoadingLists(true);
    setLoadError(null);

    try {
      const [agentsRes, flowsRes] = await Promise.all([
        fetchAgents(ac.signal),
        fetchFlows(ac.signal),
      ]);
      if (!mountedRef.current || ac.signal.aborted || listsEpochRef.current !== epoch) return;
      setAgents(agentsRes.agents);
      setFlows(flowsRes.flows);

      if (flowsRes.flows.length > 0) {
        setSelectedFlowId((prev) => {
          if (prev !== null && flowsRes.flows.some((f) => f.id === prev)) return prev;
          return flowsRes.flows[0].id;
        });
      } else {
        setSelectedFlowId(null);
        setSelectedFlow(null);
      }

      // Optional dropdown enrichment (best-effort)
      void fetchFlowProfileOptions(ac.signal)
        .then((list) => {
          if (mountedRef.current && !ac.signal.aborted) setProfiles(list);
        })
        .catch(() => {});
      void fetchFlowSupportTenantOptions(ac.signal)
        .then((list) => {
          if (mountedRef.current && !ac.signal.aborted) setTenants(list);
        })
        .catch(() => {});
      void fetchFlowModelOptions(ac.signal)
        .then((list) => {
          if (mountedRef.current && !ac.signal.aborted) setModelOptions(list);
        })
        .catch(() => {});
    } catch (err) {
      if (!mountedRef.current || isAbortError(err) || listsEpochRef.current !== epoch) return;
      setLoadError(formatApiError(err, tc(FLOWS_LOAD_ERROR)));
    } finally {
      if (mountedRef.current && listsEpochRef.current === epoch) {
        setLoadingLists(false);
      }
    }
  }, [canView, formatApiError, tc]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    if (canView) {
      queueMicrotask(() => {
        if (!cancelled) void loadAll();
      });
    }
    return () => {
      cancelled = true;
      mountedRef.current = false;
      listsEpochRef.current += 1;
      detailEpochRef.current += 1;
      listsAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      actionAbortRef.current?.abort();
      tryAbortRef.current?.abort();
    };
  }, [canView, loadAll]);

  useEffect(() => {
    if (!canView || selectedFlowId === null) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadFlowDetailById(selectedFlowId);
    });
    return () => {
      cancelled = true;
    };
  }, [canView, selectedFlowId, loadFlowDetailById]);

  // Client-side hard ceiling warnings for instant operator feedback
  const ceilingWarnings = useMemo(() => {
    const warnings: string[] = [];
    const { limits, approvalTtlHours } = draftDef;
    if (!Number.isInteger(limits.maxSteps) || limits.maxSteps < 1 || limits.maxSteps > FLOW_LIMITS.hardMaxSteps) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_LIMIT_STEPS),
          max: FLOW_LIMITS.hardMaxSteps,
        }),
      );
    }
    if (
      !Number.isInteger(limits.maxToolCalls) ||
      limits.maxToolCalls < 1 ||
      limits.maxToolCalls > FLOW_LIMITS.hardMaxToolCalls
    ) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_LIMIT_TOOL_CALLS),
          max: FLOW_LIMITS.hardMaxToolCalls,
        }),
      );
    }
    if (
      !Number.isInteger(limits.maxHandoffs) ||
      limits.maxHandoffs < 1 ||
      limits.maxHandoffs > FLOW_LIMITS.hardMaxHandoffs
    ) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_LIMIT_HANDOFFS),
          max: FLOW_LIMITS.hardMaxHandoffs,
        }),
      );
    }
    if (!Number.isInteger(limits.maxTokens) || limits.maxTokens < 1 || limits.maxTokens > FLOW_LIMITS.hardMaxTokens) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_LIMIT_TOKENS),
          max: FLOW_LIMITS.hardMaxTokens,
        }),
      );
    }
    if (
      !Number.isInteger(limits.maxSeconds) ||
      limits.maxSeconds < 1 ||
      limits.maxSeconds > FLOW_LIMITS.hardMaxSeconds
    ) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_LIMIT_SECONDS),
          max: FLOW_LIMITS.hardMaxSeconds,
        }),
      );
    }
    if (
      !Number.isInteger(approvalTtlHours) ||
      approvalTtlHours < 1 ||
      approvalTtlHours > FLOW_LIMITS.maxApprovalTtlHours
    ) {
      warnings.push(
        tc(FLOW_LIMIT_CEILING_EXCEEDED, {
          label: tc(FLOW_APPROVAL_TTL_LABEL),
          max: FLOW_LIMITS.maxApprovalTtlHours,
        }),
      );
    }
    return warnings;
  }, [draftDef, tc]);

  // ─── Agent handlers ─────────────────────────────────────────────────────────

  async function handleSaveAgent(e: React.FormEvent) {
    e.preventDefault();
    if (!agentForm || !canEdit || savingAgent) return;

    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setSavingAgent(true);
    setAgentBanner(null);
    setAgentInUseError(null);

    const parsedMaxTokens = agentForm.maxOutputTokens.trim()
      ? Number(agentForm.maxOutputTokens.trim())
      : null;
    const knowledgeKind: ScopeKind | null =
      agentForm.knowledgeScopeKind === 'profile' || agentForm.knowledgeScopeKind === 'support_tenant'
        ? agentForm.knowledgeScopeKind
        : null;
    const knowledgeId = knowledgeKind ? agentForm.knowledgeScopeId.trim() || null : null;
    const outputPolicyScope = agentForm.outputPolicyScope.trim() || null;

    try {
      if (agentForm.mode === 'create') {
        const input: AgentInput = {
          slug: agentForm.slug.trim(),
          name: agentForm.name.trim(),
          description: agentForm.description.trim(),
          model: agentForm.model.trim(),
          systemPrompt: agentForm.systemPrompt,
          knowledgeScopeKind: knowledgeKind,
          knowledgeScopeId: knowledgeId,
          outputPolicyScope,
          maxOutputTokens: parsedMaxTokens,
          enabled: agentForm.enabled,
        };
        const res = await createAgent(input, ac.signal);
        if (!mountedRef.current || ac.signal.aborted) return;
        setAgents((prev) => [...prev, res.agent]);
      } else if (agentForm.editingId !== null) {
        const patch: AgentPatchInput = {
          revision: agentForm.revision,
          name: agentForm.name.trim(),
          description: agentForm.description.trim(),
          model: agentForm.model.trim(),
          systemPrompt: agentForm.systemPrompt,
          knowledgeScopeKind: knowledgeKind,
          knowledgeScopeId: knowledgeId,
          outputPolicyScope,
          maxOutputTokens: parsedMaxTokens,
          enabled: agentForm.enabled,
        };
        const res = await updateAgent(agentForm.editingId, patch, ac.signal);
        if (!mountedRef.current || ac.signal.aborted) return;
        setAgents((prev) => prev.map((a) => (a.id === res.agent.id ? res.agent : a)));
      }
      setAgentForm(null);
      setAgentBanner({ kind: 'info', text: tc(AGENTS_SAVED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (info.status === 409 && info.code === 'revision_conflict') {
        setAgentBanner({ kind: 'error', text: tc(FLOWS_REVISION_CONFLICT) });
        if (canView) void loadAll();
      } else {
        setAgentBanner({ kind: 'error', text: formatApiError(err, tc(AGENTS_SAVE_ERROR)) });
      }
    } finally {
      if (mountedRef.current) setSavingAgent(false);
    }
  }

  async function handleDeleteAgent(agent: AgentView) {
    if (!canEdit) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setAgentBanner(null);
    setAgentInUseError(null);

    try {
      await deleteAgent(agent.id, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      setAgents((prev) => prev.filter((a) => a.id !== agent.id));
      setAgentBanner({ kind: 'info', text: tc(AGENTS_DELETED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (info.status === 409 && (info.code === 'in_use' || info.code === 'conflict_error')) {
        setAgentInUseError({
          agentName: agent.slug,
          flows: info.referencingFlows,
          message: info.message,
        });
      } else {
        setAgentBanner({ kind: 'error', text: formatApiError(err, tc(AGENTS_DELETE_ERROR)) });
      }
    }
  }

  // ─── Flow CRUD & Draft handlers ─────────────────────────────────────────────

  async function handleCreateFlow(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || creatingFlow) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setCreatingFlow(true);
    setFlowBanner(null);
    setValidationErrors([]);

    const entry = newFlowEntry || agents.find((a) => a.enabled)?.slug || agents[0]?.slug || '';
    const initialDraft: FlowDefinition = {
      kind: newFlowKind,
      entryAgent: entry,
      agents: entry ? [entry] : [],
      handoffs: entry ? { [entry]: [] } : {},
      limits: { ...DEFAULT_FLOW_LIMITS },
      awaitingApprovalText: FLOW_LIMITS.defaultAwaitingApprovalText,
      approvalTtlHours: FLOW_LIMITS.defaultApprovalTtlHours,
    };

    try {
      const res = await createFlow(
        {
          slug: newFlowSlug.trim(),
          name: newFlowName.trim(),
          description: newFlowDesc.trim(),
          enabled: true,
          draft: initialDraft,
        },
        ac.signal,
      );
      if (!mountedRef.current || ac.signal.aborted) return;
      setFlows((prev) => [...prev, res.flow]);
      applyFlowDetail({
        flow: res.flow,
        grantedProfileIds: res.grantedProfileIds ?? [],
      });
      setShowCreateFlow(false);
      setNewFlowSlug('');
      setNewFlowName('');
      setNewFlowDesc('');
      setFlowBanner({ kind: 'info', text: tc(FLOWS_CREATED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (info.status === 422 && info.issues.length > 0) {
        setValidationErrors(info.issues);
      }
      setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_SAVE_ERROR)) });
    } finally {
      if (mountedRef.current) setCreatingFlow(false);
    }
  }

  async function handleDeleteFlow(flow: FlowView) {
    if (!canEdit) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setFlowBanner(null);
    try {
      await deleteFlow(flow.id, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      const remaining = flows.filter((f) => f.id !== flow.id);
      setFlows(remaining);
      if (selectedFlowId === flow.id) {
        const nextId = remaining[0]?.id ?? null;
        setSelectedFlowId(nextId);
        if (nextId === null) setSelectedFlow(null);
      }
      setFlowBanner({ kind: 'info', text: tc(FLOWS_DELETED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_DELETE_ERROR)) });
    }
  }

  function handleKindChange(nextKind: FlowKind) {
    setDraftDef((prev) => {
      if (nextKind === 'single') {
        const emptyHandoffs: Record<string, string[]> = {};
        for (const a of prev.agents) emptyHandoffs[a] = [];
        return { ...prev, kind: 'single', handoffs: emptyHandoffs };
      }
      return { ...prev, kind: 'handoff' };
    });
  }

  function handleToggleFlowAgent(slug: string) {
    setDraftDef((prev) => {
      const exists = prev.agents.includes(slug);
      const nextAgents = exists ? prev.agents.filter((a) => a !== slug) : [...prev.agents, slug];
      const nextEntry = nextAgents.includes(prev.entryAgent)
        ? prev.entryAgent
        : (nextAgents[0] ?? '');
      const nextHandoffs: Record<string, string[]> = {};
      for (const a of nextAgents) {
        const currentTargets = prev.handoffs[a] ?? [];
        nextHandoffs[a] = currentTargets.filter((t) => nextAgents.includes(t) && t !== a);
      }
      return {
        ...prev,
        agents: nextAgents,
        entryAgent: nextEntry,
        handoffs: nextHandoffs,
      };
    });
  }

  function handleToggleHandoffEdge(fromAgent: string, toAgent: string) {
    setDraftDef((prev) => {
      const existing = prev.handoffs[fromAgent] ?? [];
      const hasEdge = existing.includes(toAgent);
      const updated = hasEdge
        ? existing.filter((t) => t !== toAgent)
        : [...existing, toAgent];
      return {
        ...prev,
        handoffs: {
          ...prev.handoffs,
          [fromAgent]: updated,
        },
      };
    });
  }

  function updateLimitField(field: keyof FlowLimitsConfig, raw: string) {
    const parsed = raw.trim() === '' ? 0 : Number(raw);
    setDraftDef((prev) => ({
      ...prev,
      limits: {
        ...prev.limits,
        [field]: Number.isFinite(parsed) ? parsed : 0,
      },
    }));
  }

  async function handleSaveDraft(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || !selectedFlow || savingDraft) return;

    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setSavingDraft(true);
    setValidationErrors([]);
    setConflictBanner(false);
    setFlowBanner(null);

    try {
      const res = await updateFlowDraft(
        selectedFlow.id,
        {
          revision: draftRevision,
          name: draftName.trim(),
          description: draftDesc.trim(),
          enabled: draftEnabled,
          draft: draftDef,
        },
        ac.signal,
      );
      if (!mountedRef.current || ac.signal.aborted) return;
      setFlows((prev) => prev.map((f) => (f.id === res.flow.id ? res.flow : f)));
      applyFlowDetail({
        flow: res.flow,
        grantedProfileIds: res.grantedProfileIds ?? grantedProfileIds,
      });
      setFlowBanner({ kind: 'info', text: tc(FLOWS_DRAFT_SAVED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (info.status === 422) {
        setValidationErrors(
          info.issues.length > 0 ? info.issues : [{ field: 'draft', message: info.message }],
        );
      } else if (info.status === 409 && (info.code === 'revision_conflict' || info.code === 'conflict_error')) {
        setConflictBanner(true);
      } else {
        setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_SAVE_ERROR)) });
      }
    } finally {
      if (mountedRef.current) setSavingDraft(false);
    }
  }

  async function handlePublishFlow() {
    if (!canPublish || !selectedFlow || publishing) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setPublishing(true);
    setValidationErrors([]);
    setConflictBanner(false);
    setFlowBanner(null);

    try {
      const res = await publishFlow(selectedFlow.id, draftRevision, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      setFlows((prev) => prev.map((f) => (f.id === res.flow.id ? res.flow : f)));
      applyFlowDetail({
        flow: res.flow,
        grantedProfileIds: res.grantedProfileIds ?? grantedProfileIds,
      });
      setFlowBanner({ kind: 'info', text: tc(FLOWS_PUBLISHED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      const info = extractFlowErrorInfo(err);
      if (info.status === 422) {
        setValidationErrors(
          info.issues.length > 0 ? info.issues : [{ field: 'draft', message: info.message }],
        );
      } else if (info.status === 409 && (info.code === 'revision_conflict' || info.code === 'conflict_error')) {
        setConflictBanner(true);
      } else {
        setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_PUBLISH_ERROR)) });
      }
    } finally {
      if (mountedRef.current) setPublishing(false);
    }
  }

  async function handleSaveGrants() {
    if (!canPublish || !selectedFlow || savingGrants) return;
    actionAbortRef.current?.abort();
    const ac = new AbortController();
    actionAbortRef.current = ac;
    setSavingGrants(true);
    setFlowBanner(null);

    try {
      const res = await setFlowGrants(selectedFlow.id, grantedProfileIds, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      setGrantedProfileIds([...res.grantedProfileIds]);
      if (res.flow) {
        setSelectedFlow(res.flow);
        setFlows((prev) => prev.map((f) => (f.id === res.flow!.id ? res.flow! : f)));
      }
      setFlowBanner({ kind: 'info', text: tc(FLOWS_GRANTS_SAVED) });
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      setFlowBanner({ kind: 'error', text: formatApiError(err, tc(FLOWS_GRANTS_ERROR)) });
    } finally {
      if (mountedRef.current) setSavingGrants(false);
    }
  }

  async function handleTryFlow(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || !selectedFlow || trying || !tryMessage.trim()) return;
    tryAbortRef.current?.abort();
    const ac = new AbortController();
    tryAbortRef.current = ac;
    setTrying(true);
    setTryError(null);
    setTryResult(null);

    try {
      const res = await tryFlow(selectedFlow.id, { message: tryMessage.trim() }, ac.signal);
      if (!mountedRef.current || ac.signal.aborted) return;
      setTryResult(res);
    } catch (err) {
      if (!mountedRef.current || isAbortError(err)) return;
      setTryError(formatApiError(err, tc(FLOW_TRY_ERROR)));
    } finally {
      if (mountedRef.current) setTrying(false);
    }
  }

  const availableAgentsForDraft = useMemo(() => {
    const slugs = new Set(agents.map((a) => a.slug));
    for (const s of draftDef.agents) slugs.add(s);
    return [...slugs].map((slug) => {
      const found = agents.find((a) => a.slug === slug);
      return found ?? { slug, name: slug, enabled: true };
    });
  }, [agents, draftDef.agents]);

  return (
    <div className="space-y-6" data-testid="flows-page">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{tc(FLOWS_PAGE_TITLE)}</h2>
          <p className="text-sm text-muted-foreground mt-0.5">{tc(FLOWS_PAGE_SUBTITLE)}</p>
        </div>
        {canView && (
          <button
            type="button"
            data-testid="flows-refresh-btn"
            onClick={() => void loadAll()}
            className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
          >
            {tc(FLOWS_REFRESH)}
          </button>
        )}
      </header>

      {!canView && (canEdit || canPublish) && (
        <div
          data-testid="flows-editor-only-notice"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {tc(FLOWS_EDITOR_ONLY_NOTICE)}
        </div>
      )}

      {canView && !canEdit && !canPublish && (
        <div
          data-testid="flows-view-only-notice"
          className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {tc(FLOWS_VIEW_ONLY_NOTICE)}
        </div>
      )}

      {canEdit && !canPublish && (
        <div
          data-testid="flows-no-publish-notice"
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          {tc(FLOWS_NO_PUBLISH_NOTICE)}
        </div>
      )}

      {loadError && (
        <div
          data-testid="flows-load-error"
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {loadError}
        </div>
      )}

      {/* ─── Section 1: Agents ─────────────────────────────────────────────── */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="agents-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">{tc(AGENTS_HEADING)}</h2>
            <p className="text-xs text-muted-foreground">{tc(AGENTS_SUBTITLE)}</p>
          </div>
          {canEdit && (
            <button
              type="button"
              data-testid="agent-add-btn"
              onClick={() => {
                setAgentBanner(null);
                setAgentInUseError(null);
                setAgentForm(emptyAgentForm());
              }}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
            >
              {tc(AGENTS_ADD_BTN)}
            </button>
          )}
        </div>

        {agentBanner && (
          <div
            role={agentBanner.kind === 'error' ? 'alert' : 'status'}
            data-testid="agent-banner"
            className={`rounded border px-3 py-2 text-xs ${
              agentBanner.kind === 'error'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {agentBanner.text}
          </div>
        )}

        {agentInUseError && (
          <div
            role="alert"
            data-testid="agent-in-use-error"
            className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive space-y-1"
          >
            <div className="font-semibold">
              {tc(AGENTS_IN_USE_TITLE)} ({agentInUseError.agentName})
            </div>
            {agentInUseError.flows.length > 0 ? (
              <div>
                {tc(AGENTS_IN_USE_FLOWS, { flows: agentInUseError.flows.join(', ') })}
              </div>
            ) : (
              <div>{agentInUseError.message}</div>
            )}
          </div>
        )}

        {agentForm && (
          <form
            onSubmit={handleSaveAgent}
            data-testid="agent-form"
            className="rounded border bg-background p-4 space-y-3"
          >
            <h3 className="text-sm font-medium">
              {agentForm.mode === 'create' ? tc(AGENTS_CREATE_HEADING) : tc(AGENTS_EDIT_HEADING)}
            </h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(AGENTS_FIELD_SLUG)}</span>
                <input
                  type="text"
                  required
                  disabled={agentForm.mode === 'edit'}
                  data-testid="agent-input-slug"
                  value={agentForm.slug}
                  onChange={(e) => setAgentForm({ ...agentForm, slug: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono disabled:opacity-60"
                />
                <span className="text-[11px] text-muted-foreground block">
                  {tc(AGENTS_FIELD_SLUG_HINT)}
                </span>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(AGENTS_FIELD_NAME)}</span>
                <input
                  type="text"
                  required
                  data-testid="agent-input-name"
                  value={agentForm.name}
                  onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="font-medium block">{tc(AGENTS_FIELD_DESCRIPTION)}</span>
                <input
                  type="text"
                  data-testid="agent-input-description"
                  value={agentForm.description}
                  onChange={(e) => setAgentForm({ ...agentForm, description: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              <div className="space-y-1 text-xs sm:col-span-2">
                <label className="block space-y-1">
                  <span className="font-medium block">{tc(AGENTS_FIELD_MODEL)}</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      required
                      list="flow-agent-model-options"
                      data-testid="agent-input-model"
                      value={agentForm.model}
                      onChange={(e) => setAgentForm({ ...agentForm, model: e.target.value })}
                      className="flex-1 min-w-[200px] rounded border bg-background px-2 py-1.5 text-sm font-mono"
                    />
                    <button
                      type="button"
                      data-testid="agent-model-preset-auto"
                      onClick={() => setAgentForm({ ...agentForm, model: 'auto' })}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      auto
                    </button>
                    <button
                      type="button"
                      data-testid="agent-model-preset-fusion"
                      onClick={() => setAgentForm({ ...agentForm, model: 'fusion' })}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                    >
                      fusion
                    </button>
                  </div>
                </label>
                <datalist id="flow-agent-model-options">
                  {modelOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <span className="text-[11px] text-muted-foreground block">
                  {tc(AGENTS_FIELD_MODEL_HINT)}
                </span>
              </div>

              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="font-medium block">{tc(AGENTS_FIELD_PROMPT)}</span>
                <textarea
                  rows={3}
                  data-testid="agent-input-prompt"
                  placeholder={tc(AGENTS_FIELD_PROMPT_PLACEHOLDER)}
                  value={agentForm.systemPrompt}
                  onChange={(e) => setAgentForm({ ...agentForm, systemPrompt: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(AGENTS_FIELD_KNOWLEDGE_KIND)}</span>
                <select
                  data-testid="agent-input-knowledge-kind"
                  value={agentForm.knowledgeScopeKind}
                  onChange={(e) =>
                    setAgentForm({
                      ...agentForm,
                      knowledgeScopeKind: e.target.value as '' | 'profile' | 'support_tenant',
                      knowledgeScopeId: '',
                    })
                  }
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="">{tc(AGENTS_SCOPE_NONE)}</option>
                  <option value="profile">{tc(AGENTS_SCOPE_PROFILE)}</option>
                  <option value="support_tenant">{tc(AGENTS_SCOPE_SUPPORT_TENANT)}</option>
                </select>
              </label>

              {agentForm.knowledgeScopeKind !== '' && (
                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(AGENTS_FIELD_KNOWLEDGE_ID)}</span>
                  {agentForm.knowledgeScopeKind === 'profile' && profiles.length > 0 ? (
                    <select
                      data-testid="agent-input-knowledge-id"
                      value={agentForm.knowledgeScopeId}
                      onChange={(e) =>
                        setAgentForm({ ...agentForm, knowledgeScopeId: e.target.value })
                      }
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">--</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {p.name} (#{p.id})
                        </option>
                      ))}
                    </select>
                  ) : agentForm.knowledgeScopeKind === 'support_tenant' && tenants.length > 0 ? (
                    <select
                      data-testid="agent-input-knowledge-id"
                      value={agentForm.knowledgeScopeId}
                      onChange={(e) =>
                        setAgentForm({ ...agentForm, knowledgeScopeId: e.target.value })
                      }
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">--</option>
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      data-testid="agent-input-knowledge-id"
                      value={agentForm.knowledgeScopeId}
                      onChange={(e) =>
                        setAgentForm({ ...agentForm, knowledgeScopeId: e.target.value })
                      }
                      className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                    />
                  )}
                </label>
              )}

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(AGENTS_FIELD_OUTPUT_POLICY)}</span>
                <input
                  type="text"
                  data-testid="agent-input-output-policy"
                  value={agentForm.outputPolicyScope}
                  onChange={(e) =>
                    setAgentForm({ ...agentForm, outputPolicyScope: e.target.value })
                  }
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                />
                <span className="text-[11px] text-muted-foreground block">
                  {tc(AGENTS_FIELD_OUTPUT_POLICY_HINT)}
                </span>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(AGENTS_FIELD_MAX_TOKENS)}</span>
                <input
                  type="number"
                  min={1}
                  data-testid="agent-input-max-tokens"
                  placeholder={tc(AGENTS_FIELD_MAX_TOKENS_PLACEHOLDER)}
                  value={agentForm.maxOutputTokens}
                  onChange={(e) => setAgentForm({ ...agentForm, maxOutputTokens: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input
                  type="checkbox"
                  data-testid="agent-input-enabled"
                  checked={agentForm.enabled}
                  onChange={(e) => setAgentForm({ ...agentForm, enabled: e.target.checked })}
                />
                <span>{tc(FLOWS_ENABLED)}</span>
              </label>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="agent-save-btn"
                disabled={savingAgent}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {savingAgent ? tc(FLOWS_SAVING) : tc(FLOWS_SAVE)}
              </button>
              <button
                type="button"
                onClick={() => setAgentForm(null)}
                className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
              >
                {tc(FLOWS_CANCEL)}
              </button>
            </div>
          </form>
        )}

        {loadingLists ? (
          <p className="text-sm text-muted-foreground">{tc(FLOWS_LOADING)}</p>
        ) : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="agents-empty">
            {tc(AGENTS_EMPTY)}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse" data-testid="agents-table">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3">{tc(AGENTS_FIELD_SLUG)}</th>
                  <th className="py-2 pr-3">{tc(AGENTS_FIELD_NAME)}</th>
                  <th className="py-2 pr-3">{tc(AGENTS_FIELD_MODEL)}</th>
                  <th className="py-2 pr-3">{tc(AGENTS_FIELD_PROMPT)}</th>
                  <th className="py-2 pr-3">{tc(FLOWS_ENABLED)}</th>
                  <th className="py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {agents.map((ag) => (
                  <tr key={ag.id} className="border-b last:border-b-0" data-testid={`agent-row-${ag.slug}`}>
                    <td className="py-2 pr-3 font-mono text-xs">{ag.slug}</td>
                    <td className="py-2 pr-3">{ag.name}</td>
                    <td className="py-2 pr-3 font-mono text-xs">{ag.model}</td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {ag.publishedPromptVersion !== null
                        ? tc(AGENTS_PROMPT_VERSION, { version: ag.publishedPromptVersion })
                        : tc(AGENTS_NO_PROMPT_VERSION)}
                    </td>
                    <td className="py-2 pr-3 text-xs">
                      <span
                        className={`rounded px-2 py-0.5 ${
                          ag.enabled
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {ag.enabled ? tc(FLOWS_ENABLED) : tc(FLOWS_DISABLED)}
                      </span>
                    </td>
                    <td className="py-2 text-right space-x-2">
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            data-testid={`agent-edit-${ag.slug}`}
                            onClick={() => {
                              setAgentBanner(null);
                              setAgentInUseError(null);
                              setAgentForm(agentToForm(ag));
                            }}
                            className="rounded border px-2 py-1 text-xs hover:bg-muted"
                          >
                            {tc(FLOWS_EDIT)}
                          </button>
                          <button
                            type="button"
                            data-testid={`agent-delete-${ag.slug}`}
                            onClick={() => void handleDeleteAgent(ag)}
                            className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                          >
                            {tc(FLOWS_DELETE)}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ─── Section 2: Flows List & Create ────────────────────────────────── */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="flows-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{tc(FLOWS_LIST_HEADING)}</h2>
          {canEdit && (
            <button
              type="button"
              data-testid="flow-add-btn"
              onClick={() => {
                setShowCreateFlow((v) => !v);
                setNewFlowEntry(agents.find((a) => a.enabled)?.slug ?? agents[0]?.slug ?? '');
              }}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
            >
              {tc(FLOWS_ADD_BTN)}
            </button>
          )}
        </div>

        {flowBanner && (
          <div
            role={flowBanner.kind === 'error' ? 'alert' : 'status'}
            data-testid="flow-banner"
            className={`rounded border px-3 py-2 text-xs ${
              flowBanner.kind === 'error'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
            }`}
          >
            {flowBanner.text}
          </div>
        )}

        {showCreateFlow && canEdit && (
          <form
            onSubmit={handleCreateFlow}
            data-testid="flow-create-form"
            className="rounded border bg-background p-4 space-y-3"
          >
            <h3 className="text-sm font-medium">{tc(FLOWS_CREATE_HEADING)}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOWS_FIELD_SLUG)}</span>
                <input
                  type="text"
                  required
                  data-testid="flow-create-slug"
                  value={newFlowSlug}
                  onChange={(e) => setNewFlowSlug(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                />
                <span className="text-[11px] text-muted-foreground block">
                  {tc(FLOWS_FIELD_SLUG_HINT)}
                </span>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOWS_FIELD_NAME)}</span>
                <input
                  type="text"
                  required
                  data-testid="flow-create-name"
                  value={newFlowName}
                  onChange={(e) => setNewFlowName(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="font-medium block">{tc(FLOWS_FIELD_DESCRIPTION)}</span>
                <input
                  type="text"
                  data-testid="flow-create-description"
                  value={newFlowDesc}
                  onChange={(e) => setNewFlowDesc(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOW_KIND_LABEL)}</span>
                <select
                  data-testid="flow-create-kind"
                  value={newFlowKind}
                  onChange={(e) => setNewFlowKind(e.target.value as FlowKind)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm"
                >
                  <option value="single">{tc(FLOW_KIND_SINGLE)}</option>
                  <option value="handoff">{tc(FLOW_KIND_HANDOFF)}</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOW_ENTRY_AGENT)}</span>
                <select
                  data-testid="flow-create-entry-agent"
                  value={newFlowEntry}
                  onChange={(e) => setNewFlowEntry(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
                >
                  {agents.length === 0 && <option value="">--</option>}
                  {agents.map((a) => (
                    <option key={a.id} value={a.slug}>
                      {a.slug}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                data-testid="flow-create-submit"
                disabled={creatingFlow}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {creatingFlow ? tc(FLOWS_SAVING) : tc(FLOWS_SAVE)}
              </button>
              <button
                type="button"
                onClick={() => setShowCreateFlow(false)}
                className="rounded border px-3 py-1.5 text-xs hover:bg-muted"
              >
                {tc(FLOWS_CANCEL)}
              </button>
            </div>
          </form>
        )}

        {flows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="flows-empty">
            {tc(FLOWS_EMPTY)}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2" data-testid="flows-list">
            {flows.map((f) => {
              const isSelected = f.id === selectedFlowId;
              return (
                <div
                  key={f.id}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${
                    isSelected ? 'border-primary bg-primary/5' : 'bg-background'
                  }`}
                >
                  <button
                    type="button"
                    data-testid={`flow-select-${f.slug}`}
                    onClick={() => setSelectedFlowId(f.id)}
                    className="text-left space-y-0.5"
                  >
                    <div className="font-medium">
                      {f.name}{' '}
                      <span className="font-mono text-muted-foreground">({f.slug})</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {f.publishedVersion > 0
                        ? tc(FLOWS_PUBLISHED_VERSION, { version: f.publishedVersion })
                        : tc(FLOWS_UNPUBLISHED)}{' '}
                      · {tc(FLOWS_REVISION, { revision: f.revision })}
                    </div>
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      data-testid={`flow-delete-${f.slug}`}
                      onClick={() => void handleDeleteFlow(f)}
                      className="rounded border border-destructive/30 px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                    >
                      {tc(FLOWS_DELETE)}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ─── Section 3: Flow Draft Editor, Publish, Grants & Try ───────────── */}
      {loadingDetail && !selectedFlow ? (
        <p className="text-sm text-muted-foreground">{tc(FLOWS_LOADING)}</p>
      ) : !selectedFlow ? (
        <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          {tc(FLOW_SELECT_HINT)}
        </div>
      ) : (
        <div className="space-y-6" data-testid="flow-draft-editor">
          {conflictBanner && (
            <div
              role="alert"
              data-testid="flow-conflict-banner"
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/50 bg-amber-500/10 p-3 text-xs"
            >
              <span>{tc(FLOWS_REVISION_CONFLICT)}</span>
              <button
                type="button"
                data-testid="flow-conflict-reload-btn"
                onClick={() => void loadFlowDetailById(selectedFlow.id)}
                className="rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white"
              >
                {tc(FLOWS_RELOAD_LATEST)}
              </button>
            </div>
          )}

          {validationErrors.length > 0 && (
            <div
              role="alert"
              data-testid="flow-validation-errors"
              className="rounded border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive space-y-1"
            >
              <div className="font-semibold">{tc(FLOW_VALIDATION_HEADING)}</div>
              <ul className="list-disc pl-4 space-y-0.5">
                {validationErrors.map((issue, idx) => (
                  <li key={`${issue.field}-${idx}`}>
                    {issue.field ? <span className="font-mono">{issue.field}: </span> : null}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <form
            noValidate
            onSubmit={handleSaveDraft}
            className="rounded-lg border bg-card p-4 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">
                  {tc(FLOW_EDITOR_HEADING)}: {selectedFlow.slug}
                </h2>
                <div className="text-xs text-muted-foreground flex flex-wrap gap-3 mt-0.5">
                  <span>
                    {selectedFlow.publishedVersion > 0
                      ? tc(FLOWS_PUBLISHED_VERSION, { version: selectedFlow.publishedVersion })
                      : tc(FLOWS_UNPUBLISHED)}
                  </span>
                  <span data-testid="flow-revision-badge">
                    {tc(FLOWS_REVISION, { revision: draftRevision })}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  data-testid="flow-save-draft-btn"
                  disabled={!canEdit || savingDraft}
                  className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                >
                  {savingDraft ? tc(FLOW_SAVING_DRAFT_BTN) : tc(FLOW_SAVE_DRAFT_BTN)}
                </button>
                <button
                  type="button"
                  data-testid="flow-publish-btn"
                  disabled={!canPublish || publishing}
                  onClick={() => void handlePublishFlow()}
                  className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50"
                >
                  {publishing ? tc(FLOW_PUBLISHING_BTN) : tc(FLOW_PUBLISH_BTN)}
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOWS_FIELD_NAME)}</span>
                <input
                  type="text"
                  required
                  disabled={!canEdit}
                  data-testid="flow-draft-name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOW_KIND_LABEL)}</span>
                <select
                  disabled={!canEdit}
                  data-testid="flow-kind-select"
                  value={draftDef.kind}
                  onChange={(e) => handleKindChange(e.target.value as FlowKind)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                >
                  <option value="single">{tc(FLOW_KIND_SINGLE)}</option>
                  <option value="handoff">{tc(FLOW_KIND_HANDOFF)}</option>
                </select>
              </label>

              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="font-medium block">{tc(FLOWS_FIELD_DESCRIPTION)}</span>
                <input
                  type="text"
                  disabled={!canEdit}
                  data-testid="flow-draft-description"
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOW_ENTRY_AGENT)}</span>
                <select
                  disabled={!canEdit}
                  data-testid="flow-entry-agent-select"
                  value={draftDef.entryAgent}
                  onChange={(e) => setDraftDef({ ...draftDef, entryAgent: e.target.value })}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono disabled:opacity-60"
                >
                  {draftDef.agents.length === 0 && <option value="">--</option>}
                  {draftDef.agents.map((slug) => (
                    <option key={slug} value={slug}>
                      {slug}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs self-end pb-1.5">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  data-testid="flow-draft-enabled"
                  checked={draftEnabled}
                  onChange={(e) => setDraftEnabled(e.target.checked)}
                />
                <span>{tc(FLOWS_ENABLED)}</span>
              </label>
            </div>

            {/* Participating agents */}
            <div className="space-y-2">
              <div className="text-xs font-medium">{tc(FLOW_PARTICIPATING_AGENTS)}</div>
              {availableAgentsForDraft.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc(FLOW_NO_AGENTS_HINT)}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableAgentsForDraft.map((ag) => {
                    const checked = draftDef.agents.includes(ag.slug);
                    return (
                      <label
                        key={ag.slug}
                        className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs"
                      >
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          data-testid={`flow-agent-toggle-${ag.slug}`}
                          checked={checked}
                          onChange={() => handleToggleFlowAgent(ag.slug)}
                        />
                        <span className="font-mono">{ag.slug}</span>
                        {!ag.enabled && (
                          <span className="text-[10px] text-muted-foreground">
                            ({tc(FLOWS_DISABLED)})
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Handoff routing matrix */}
            <div className="space-y-2" data-testid="flow-handoffs-matrix">
              <div className="text-xs font-medium">{tc(FLOW_HANDOFFS_HEADING)}</div>
              {draftDef.kind === 'single' ? (
                <p className="text-xs text-muted-foreground" data-testid="flow-handoffs-single-note">
                  {tc(FLOW_HANDOFFS_SINGLE_NOTE)}
                </p>
              ) : (
                <div className="space-y-2">
                  {draftDef.agents.map((fromAgent) => {
                    const targets = draftDef.handoffs[fromAgent] ?? [];
                    const candidates = draftDef.agents.filter((a) => a !== fromAgent);
                    return (
                      <div key={fromAgent} className="rounded border p-2.5 space-y-1.5 text-xs">
                        <div className="font-mono font-medium">
                          {tc(FLOW_HANDOFFS_FROM, { agent: fromAgent })}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {candidates.map((toAgent) => (
                            <label key={toAgent} className="inline-flex items-center gap-1.5">
                              <input
                                type="checkbox"
                                disabled={!canEdit}
                                data-testid={`flow-handoff-${fromAgent}-${toAgent}`}
                                checked={targets.includes(toAgent)}
                                onChange={() => handleToggleHandoffEdge(fromAgent, toAgent)}
                              />
                              <span className="font-mono">{toAgent}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Execution limits & hard ceilings */}
            <div className="space-y-2">
              <div className="text-xs font-medium">{tc(FLOW_LIMITS_HEADING)}</div>
              <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(FLOW_LIMIT_STEPS)}</span>
                  <input
                    type="number"
                    min={1}
                    max={FLOW_LIMITS.hardMaxSteps}
                    disabled={!canEdit}
                    data-testid="flow-limit-steps"
                    value={draftDef.limits.maxSteps}
                    onChange={(e) => updateLimitField('maxSteps', e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                  <span className="text-[11px] text-muted-foreground block">
                    {tc(FLOW_LIMIT_STEPS_HINT)}
                  </span>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(FLOW_LIMIT_TOOL_CALLS)}</span>
                  <input
                    type="number"
                    min={1}
                    max={FLOW_LIMITS.hardMaxToolCalls}
                    disabled={!canEdit}
                    data-testid="flow-limit-tool-calls"
                    value={draftDef.limits.maxToolCalls}
                    onChange={(e) => updateLimitField('maxToolCalls', e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                  <span className="text-[11px] text-muted-foreground block">
                    {tc(FLOW_LIMIT_TOOL_CALLS_HINT)}
                  </span>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(FLOW_LIMIT_HANDOFFS)}</span>
                  <input
                    type="number"
                    min={1}
                    max={FLOW_LIMITS.hardMaxHandoffs}
                    disabled={!canEdit}
                    data-testid="flow-limit-handoffs"
                    value={draftDef.limits.maxHandoffs}
                    onChange={(e) => updateLimitField('maxHandoffs', e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                  <span className="text-[11px] text-muted-foreground block">
                    {tc(FLOW_LIMIT_HANDOFFS_HINT)}
                  </span>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(FLOW_LIMIT_TOKENS)}</span>
                  <input
                    type="number"
                    min={1}
                    max={FLOW_LIMITS.hardMaxTokens}
                    disabled={!canEdit}
                    data-testid="flow-limit-tokens"
                    value={draftDef.limits.maxTokens}
                    onChange={(e) => updateLimitField('maxTokens', e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                  <span className="text-[11px] text-muted-foreground block">
                    {tc(FLOW_LIMIT_TOKENS_HINT)}
                  </span>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="font-medium block">{tc(FLOW_LIMIT_SECONDS)}</span>
                  <input
                    type="number"
                    min={1}
                    max={FLOW_LIMITS.hardMaxSeconds}
                    disabled={!canEdit}
                    data-testid="flow-limit-seconds"
                    value={draftDef.limits.maxSeconds}
                    onChange={(e) => updateLimitField('maxSeconds', e.target.value)}
                    className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                  />
                  <span className="text-[11px] text-muted-foreground block">
                    {tc(FLOW_LIMIT_SECONDS_HINT)}
                  </span>
                </label>
              </div>

              {ceilingWarnings.length > 0 && (
                <div
                  data-testid="flow-limits-ceiling-errors"
                  role="alert"
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 space-y-0.5"
                >
                  {ceilingWarnings.map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              )}
            </div>

            {/* Approval pause text & TTL */}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs sm:col-span-2">
                <span className="font-medium block">{tc(FLOW_APPROVAL_TEXT_LABEL)}</span>
                <input
                  type="text"
                  disabled={!canEdit}
                  data-testid="flow-approval-text-input"
                  value={draftDef.awaitingApprovalText}
                  onChange={(e) =>
                    setDraftDef({ ...draftDef, awaitingApprovalText: e.target.value })
                  }
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="font-medium block">{tc(FLOW_APPROVAL_TTL_LABEL)}</span>
                <input
                  type="number"
                  min={1}
                  max={FLOW_LIMITS.maxApprovalTtlHours}
                  disabled={!canEdit}
                  data-testid="flow-approval-ttl-input"
                  value={draftDef.approvalTtlHours}
                  onChange={(e) =>
                    setDraftDef({ ...draftDef, approvalTtlHours: Number(e.target.value) })
                  }
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                />
                <span className="text-[11px] text-muted-foreground block">
                  {tc(FLOW_APPROVAL_TTL_HINT)}
                </span>
              </label>
            </div>
          </form>

          {/* ─── Client Profile Grants ─────────────────────────────────────── */}
          <section
            className="rounded-lg border bg-card p-4 space-y-3"
            data-testid="flow-grants-section"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{tc(FLOW_GRANTS_HEADING)}</h3>
                <p className="text-xs text-muted-foreground">
                  {tc(FLOW_GRANTS_SUBTITLE, { slug: selectedFlow.slug })}
                </p>
              </div>
              <button
                type="button"
                data-testid="flow-save-grants-btn"
                disabled={!canPublish || savingGrants}
                onClick={() => void handleSaveGrants()}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {savingGrants ? tc(FLOW_GRANTS_SAVING_BTN) : tc(FLOW_GRANTS_SAVE_BTN)}
              </button>
            </div>

            {profiles.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tc(FLOW_GRANTS_EMPTY)}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {profiles.map((p) => {
                  const granted = grantedProfileIds.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className="inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs"
                    >
                      <input
                        type="checkbox"
                        disabled={!canPublish}
                        data-testid={`flow-grant-profile-${p.id}`}
                        checked={granted}
                        onChange={() => {
                          setGrantedProfileIds((prev) =>
                            prev.includes(p.id)
                              ? prev.filter((id) => id !== p.id)
                              : [...prev, p.id],
                          );
                        }}
                      />
                      <span>
                        {p.name} (#{p.id})
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          {/* ─── Dry-run Try Draft ─────────────────────────────────────────── */}
          <section
            className="rounded-lg border bg-card p-4 space-y-3"
            data-testid="flow-try-section"
          >
            <div>
              <h3 className="text-sm font-semibold">{tc(FLOW_TRY_HEADING)}</h3>
              <p className="text-xs text-muted-foreground">{tc(FLOW_TRY_NOTE)}</p>
            </div>

            <form onSubmit={handleTryFlow} className="space-y-3">
              <label className="space-y-1 text-xs block">
                <span className="font-medium block">{tc(FLOW_TRY_MESSAGE_LABEL)}</span>
                <textarea
                  rows={2}
                  disabled={!canEdit}
                  data-testid="flow-try-message-input"
                  placeholder={tc(FLOW_TRY_MESSAGE_PLACEHOLDER)}
                  value={tryMessage}
                  onChange={(e) => setTryMessage(e.target.value)}
                  className="w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-60"
                />
              </label>

              <button
                type="submit"
                data-testid="flow-try-btn"
                disabled={!canEdit || trying || !tryMessage.trim()}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {trying ? tc(FLOW_TRYING_BTN) : tc(FLOW_TRY_BTN)}
              </button>
            </form>

            {tryError && (
              <div
                role="alert"
                data-testid="flow-try-error"
                className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {tryError}
              </div>
            )}

            {tryResult && (
              <div className="space-y-3" data-testid="flow-try-result">
                {(tryResult.outputText ?? tryResult.result ?? tryResult.run.finalTextMasked) && (
                  <div className="text-xs space-y-1" data-testid="flow-try-output">
                    <span className="font-medium text-muted-foreground">
                      {tc(FLOW_TRY_OUTPUT_LABEL)}:
                    </span>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-muted/50 p-2 font-mono text-[11px]">
                      {tryResult.outputText ?? tryResult.result ?? tryResult.run.finalTextMasked}
                    </pre>
                  </div>
                )}
                <div data-testid="flow-try-trace">
                  <RunTrace run={tryResult.run} steps={tryResult.steps} />
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
