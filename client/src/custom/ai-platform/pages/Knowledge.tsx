import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import {
  RETRIEVAL_LIMITS,
  createDefaultRetrievalStatus,
  fetchRetrievalScope,
  fetchRetrievalUsage,
  getKnowledgeErrorInfo,
  runRetrievalTestQuery,
  triggerRetrievalReindex,
  updateRetrievalSettings,
  type IndexJobReason,
  type IndexJobStatus,
  type RetrievalDegradedReason,
  type RetrievalIndexJobView,
  type RetrievalMode,
  type RetrievalQueryRequest,
  type RetrievalQueryResponse,
  type RetrievalScopeStatusResponse,
  type RetrievalUsageResponse,
  type Scope,
  type ScopeKind,
} from '../knowledge-api';
import {
  KNOWLEDGE_ACTIVE_JOB,
  KNOWLEDGE_CITATIONS_LABEL,
  KNOWLEDGE_DEGRADED_EMBEDDING_ERROR,
  KNOWLEDGE_DEGRADED_INDEX_NOT_READY,
  KNOWLEDGE_DEGRADED_NO_MODEL,
  KNOWLEDGE_DEGRADED_PILLAR_DISABLED,
  KNOWLEDGE_DEGRADED_TIMEOUT,
  KNOWLEDGE_DIMENSIONS_LABEL,
  KNOWLEDGE_FORBIDDEN_ERROR,
  KNOWLEDGE_INDEXED_DIMS,
  KNOWLEDGE_INDEXED_MODEL,
  KNOWLEDGE_INDEX_ERROR_CHUNKS,
  KNOWLEDGE_INDEX_GENERATION,
  KNOWLEDGE_INDEX_HEADING,
  KNOWLEDGE_INDEX_PENDING_CHUNKS,
  KNOWLEDGE_INDEX_PROGRESS,
  KNOWLEDGE_INDEX_READY_CHUNKS,
  KNOWLEDGE_INDEX_STALE_CHUNKS,
  KNOWLEDGE_INDEX_STATUS_BUILDING,
  KNOWLEDGE_INDEX_STATUS_READY,
  KNOWLEDGE_INDEX_TOTAL_CHUNKS,
  KNOWLEDGE_JOB_LAST_ERROR,
  KNOWLEDGE_JOB_PROGRESS,
  KNOWLEDGE_JOB_REASON_DOC_ADD,
  KNOWLEDGE_JOB_REASON_DOC_DELETE,
  KNOWLEDGE_JOB_REASON_DOC_EDIT,
  KNOWLEDGE_JOB_REASON_MODEL_CHANGE,
  KNOWLEDGE_JOB_REASON_REINDEX,
  KNOWLEDGE_JOB_RETRY_AFTER,
  KNOWLEDGE_JOB_STATUS_FAILED,
  KNOWLEDGE_JOB_STATUS_QUEUED,
  KNOWLEDGE_JOB_STATUS_RUNNING,
  KNOWLEDGE_JOB_STATUS_SUCCEEDED,
  KNOWLEDGE_LOADING_SCOPE,
  KNOWLEDGE_LOAD_SCOPE,
  KNOWLEDGE_LOAD_SCOPE_ERROR,
  KNOWLEDGE_MIN_SCORE_LABEL,
  KNOWLEDGE_MODEL_AUTO,
  KNOWLEDGE_MODEL_LABEL,
  KNOWLEDGE_MODE_HYBRID,
  KNOWLEDGE_MODE_KEYWORD,
  KNOWLEDGE_MODE_LABEL,
  KNOWLEDGE_MODE_SEMANTIC,
  KNOWLEDGE_NONE_VALUE,
  KNOWLEDGE_NO_PERMISSION,
  KNOWLEDGE_NO_RECENT_JOBS,
  KNOWLEDGE_PAGE_SUBTITLE,
  KNOWLEDGE_PAGE_TITLE,
  KNOWLEDGE_PURPOSE_INDEX,
  KNOWLEDGE_PURPOSE_QUERY,
  KNOWLEDGE_QUERY_CITATIONS_HEADING,
  KNOWLEDGE_QUERY_DEGRADED_BANNER,
  KNOWLEDGE_QUERY_ERROR,
  KNOWLEDGE_QUERY_HEADING,
  KNOWLEDGE_QUERY_HITS_HEADING,
  KNOWLEDGE_QUERY_HIT_CHUNK,
  KNOWLEDGE_QUERY_HIT_DOC,
  KNOWLEDGE_QUERY_HIT_KW_RANK,
  KNOWLEDGE_QUERY_HIT_SCORE,
  KNOWLEDGE_QUERY_HIT_VEC_RANK,
  KNOWLEDGE_QUERY_INPUT_LABEL,
  KNOWLEDGE_QUERY_INPUT_PLACEHOLDER,
  KNOWLEDGE_QUERY_META_GEN,
  KNOWLEDGE_QUERY_META_LATENCY,
  KNOWLEDGE_QUERY_META_MODE,
  KNOWLEDGE_QUERY_MODE_OVERRIDE,
  KNOWLEDGE_QUERY_MODE_SCOPE_DEFAULT,
  KNOWLEDGE_QUERY_NO_CITATIONS,
  KNOWLEDGE_QUERY_NO_HITS,
  KNOWLEDGE_QUERY_PILLAR_DISABLED,
  KNOWLEDGE_QUERY_RUNNING_BTN,
  KNOWLEDGE_QUERY_RUN_BTN,
  KNOWLEDGE_QUERY_SOURCE_KEYWORD,
  KNOWLEDGE_QUERY_SOURCE_SEMANTIC,
  KNOWLEDGE_QUERY_SUBTITLE,
  KNOWLEDGE_QUERY_TOPK_OVERRIDE,
  KNOWLEDGE_RECENT_JOBS,
  KNOWLEDGE_REINDEXING_BTN,
  KNOWLEDGE_REINDEX_BTN,
  KNOWLEDGE_REINDEX_CONFLICT,
  KNOWLEDGE_REINDEX_ERROR,
  KNOWLEDGE_REINDEX_STARTED,
  KNOWLEDGE_SAVE_ERROR,
  KNOWLEDGE_SAVE_SETTINGS,
  KNOWLEDGE_SAVING_SETTINGS,
  KNOWLEDGE_SCOPE_AGENT,
  KNOWLEDGE_SCOPE_ID,
  KNOWLEDGE_SCOPE_ID_PLACEHOLDER,
  KNOWLEDGE_SCOPE_ID_REQUIRED,
  KNOWLEDGE_SCOPE_KIND,
  KNOWLEDGE_SCOPE_PROFILE,
  KNOWLEDGE_SCOPE_SUPPORT_TENANT,
  KNOWLEDGE_SETTINGS_HEADING,
  KNOWLEDGE_SETTINGS_SAVED,
  KNOWLEDGE_SETTINGS_UPDATED_AT,
  KNOWLEDGE_TOP_K_LABEL,
  KNOWLEDGE_USAGE_COL_DAY,
  KNOWLEDGE_USAGE_COL_MODEL,
  KNOWLEDGE_USAGE_COL_PURPOSE,
  KNOWLEDGE_USAGE_COL_REQUESTS,
  KNOWLEDGE_USAGE_COL_SCOPE,
  KNOWLEDGE_USAGE_COL_TOKENS,
  KNOWLEDGE_USAGE_DAYS_OPTION,
  KNOWLEDGE_USAGE_EMPTY,
  KNOWLEDGE_USAGE_ERROR,
  KNOWLEDGE_USAGE_HEADING,
  KNOWLEDGE_USAGE_INDEX_TOKENS,
  KNOWLEDGE_USAGE_LOADING,
  KNOWLEDGE_USAGE_QUERY_TOKENS,
  KNOWLEDGE_USAGE_REFRESH,
  KNOWLEDGE_USAGE_SCOPE_FILTER,
  KNOWLEDGE_USAGE_TOTAL_REQUESTS,
  KNOWLEDGE_USAGE_TOTAL_TOKENS,
  KNOWLEDGE_USAGE_WINDOW_LABEL,
  KNOWLEDGE_VIEW_ONLY_NOTICE,
  KNOWLEDGE_VIEW_REQUIRED,
} from '../knowledge-strings';

export interface KnowledgeProps {
  canView?: boolean;
  canEdit?: boolean;
  canReindex?: boolean;
  canQuery?: boolean;
}

const JOB_STATUS_LABEL_KEY: Record<IndexJobStatus, string> = {
  queued: KNOWLEDGE_JOB_STATUS_QUEUED,
  running: KNOWLEDGE_JOB_STATUS_RUNNING,
  succeeded: KNOWLEDGE_JOB_STATUS_SUCCEEDED,
  failed: KNOWLEDGE_JOB_STATUS_FAILED,
};

const JOB_REASON_LABEL_KEY: Record<IndexJobReason, string> = {
  doc_add: KNOWLEDGE_JOB_REASON_DOC_ADD,
  doc_edit: KNOWLEDGE_JOB_REASON_DOC_EDIT,
  doc_delete: KNOWLEDGE_JOB_REASON_DOC_DELETE,
  reindex: KNOWLEDGE_JOB_REASON_REINDEX,
  model_change: KNOWLEDGE_JOB_REASON_MODEL_CHANGE,
};

const DEGRADED_REASON_LABEL_KEY: Record<RetrievalDegradedReason, string> = {
  pillar_disabled: KNOWLEDGE_DEGRADED_PILLAR_DISABLED,
  no_model: KNOWLEDGE_DEGRADED_NO_MODEL,
  index_not_ready: KNOWLEDGE_DEGRADED_INDEX_NOT_READY,
  timeout: KNOWLEDGE_DEGRADED_TIMEOUT,
  embedding_error: KNOWLEDGE_DEGRADED_EMBEDDING_ERROR,
};

function clampNumber(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, val));
}

export function Knowledge(props: KnowledgeProps = {}) {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();

  const canView = props.canView ?? (isPrimary || can('view_retrieval'));
  const canEdit = props.canEdit ?? (isPrimary || can('edit_retrieval'));
  const canReindex = props.canReindex ?? canEdit;
  const canQuery = props.canQuery ?? canView;

  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    return uid * 1000 + identity.length;
  }, [session?.userId, identity]);

  // Scope selector state
  const [draftScopeKind, setDraftScopeKind] = useState<ScopeKind>('profile');
  const [draftScopeId, setDraftScopeId] = useState('1');
  const [activeScope, setActiveScope] = useState<Scope>({ kind: 'profile', id: '1' });
  const [scopeValidationError, setScopeValidationError] = useState<string | null>(null);

  // Scope status & settings draft state
  const [scopeStatus, setScopeStatus] = useState<RetrievalScopeStatusResponse>(() =>
    createDefaultRetrievalStatus('profile', '1'),
  );
  const [mode, setMode] = useState<RetrievalMode>('keyword');
  const [embeddingModel, setEmbeddingModel] = useState<string>('auto');
  const [dimensions, setDimensions] = useState<number>(RETRIEVAL_LIMITS.defaultDimensions);
  const [topK, setTopK] = useState<number>(RETRIEVAL_LIMITS.defaultTopK);
  const [minScore, setMinScore] = useState<number>(RETRIEVAL_LIMITS.defaultMinScore);
  const [citationsEnabled, setCitationsEnabled] = useState<boolean>(
    RETRIEVAL_LIMITS.defaultCitationsEnabled,
  );

  // Loading & mutation feedback state
  const [loadingScope, setLoadingScope] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexError, setReindexError] = useState<string | null>(null);
  const [reindexMessage, setReindexMessage] = useState<string | null>(null);

  // Test query state
  const [queryText, setQueryText] = useState('');
  const [queryModeOverride, setQueryModeOverride] = useState<RetrievalMode | ''>('');
  const [queryTopKOverride, setQueryTopKOverride] = useState('');
  const [querying, setQuerying] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<RetrievalQueryResponse | null>(null);

  // Embedding usage state
  const [usageDays, setUsageDays] = useState<number>(30);
  const [usageCurrentScopeOnly, setUsageCurrentScopeOnly] = useState(false);
  const [usageData, setUsageData] = useState<RetrievalUsageResponse | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  // Monotonic master epoch & per-operation request guards
  const requestEpochRef = useRef(0);
  const scopeSeqRef = useRef(0);
  const saveSeqRef = useRef(0);
  const reindexSeqRef = useRef(0);
  const querySeqRef = useRef(0);
  const usageSeqRef = useRef(0);

  const scopeAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const reindexAbortRef = useRef<AbortController | null>(null);
  const queryAbortRef = useRef<AbortController | null>(null);
  const usageAbortRef = useRef<AbortController | null>(null);

  const abortAllInFlight = useCallback(() => {
    requestEpochRef.current += 1;
    scopeAbortRef.current?.abort();
    scopeAbortRef.current = null;
    saveAbortRef.current?.abort();
    saveAbortRef.current = null;
    reindexAbortRef.current?.abort();
    reindexAbortRef.current = null;
    queryAbortRef.current?.abort();
    queryAbortRef.current = null;
    usageAbortRef.current?.abort();
    usageAbortRef.current = null;
  }, []);

  const applyScopeStatus = useCallback((res: RetrievalScopeStatusResponse) => {
    setScopeStatus(res);
    setMode(res.settings.mode);
    setEmbeddingModel(res.settings.embeddingModel || 'auto');
    setDimensions(res.settings.dimensions);
    setTopK(res.settings.topK);
    setMinScore(res.settings.minScore);
    setCitationsEnabled(res.settings.citationsEnabled);
  }, []);

  const loadScope = useCallback(
    async (target: Scope) => {
      if (!canView || !target.id) return;
      const masterEpoch = requestEpochRef.current;
      const seq = ++scopeSeqRef.current;
      scopeAbortRef.current?.abort();
      const controller = new AbortController();
      scopeAbortRef.current = controller;

      setLoadingScope(true);
      setLoadError(null);

      try {
        const res = await fetchRetrievalScope(target.kind, target.id, controller.signal);
        if (
          controller.signal.aborted ||
          requestEpochRef.current !== masterEpoch ||
          scopeSeqRef.current !== seq
        ) {
          return;
        }
        applyScopeStatus(res);
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestEpochRef.current !== masterEpoch ||
          scopeSeqRef.current !== seq
        ) {
          return;
        }
        const info = getKnowledgeErrorInfo(err);
        setLoadError(
          info.status === 403
            ? tc(KNOWLEDGE_FORBIDDEN_ERROR)
            : info.message || tc(KNOWLEDGE_LOAD_SCOPE_ERROR),
        );
      } finally {
        if (requestEpochRef.current === masterEpoch && scopeSeqRef.current === seq) {
          setLoadingScope(false);
        }
      }
    },
    [applyScopeStatus, canView, tc],
  );

  const loadUsage = useCallback(
    async (opts: { days: number; scopeOnly: boolean; scope: Scope }) => {
      if (!canView) return;
      const masterEpoch = requestEpochRef.current;
      const seq = ++usageSeqRef.current;
      usageAbortRef.current?.abort();
      const controller = new AbortController();
      usageAbortRef.current = controller;

      setLoadingUsage(true);
      setUsageError(null);

      try {
        const res = await fetchRetrievalUsage(
          {
            days: opts.days,
            ...(opts.scopeOnly && opts.scope.id
              ? { scopeKind: opts.scope.kind, scopeId: opts.scope.id }
              : {}),
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          requestEpochRef.current !== masterEpoch ||
          usageSeqRef.current !== seq
        ) {
          return;
        }
        setUsageData(res);
      } catch (err) {
        if (
          controller.signal.aborted ||
          requestEpochRef.current !== masterEpoch ||
          usageSeqRef.current !== seq
        ) {
          return;
        }
        const info = getKnowledgeErrorInfo(err);
        setUsageError(
          info.status === 403
            ? tc(KNOWLEDGE_FORBIDDEN_ERROR)
            : info.message || tc(KNOWLEDGE_USAGE_ERROR),
        );
      } finally {
        if (requestEpochRef.current === masterEpoch && usageSeqRef.current === seq) {
          setLoadingUsage(false);
        }
      }
    },
    [canView, tc],
  );

  // Load scope status when activeScope, sessionRevision, or canView changes.
  useEffect(() => {
    abortAllInFlight();
    if (!canView || !activeScope.id) {
      return () => abortAllInFlight();
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadScope(activeScope);
      }
    });
    return () => {
      cancelled = true;
      abortAllInFlight();
    };
  }, [abortAllInFlight, activeScope, canView, loadScope, sessionRevision]);

  // Load usage when usage filter, activeScope (if filtered), sessionRevision, or canView changes.
  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadUsage({
          days: usageDays,
          scopeOnly: usageCurrentScopeOnly,
          scope: activeScope,
        });
      }
    });
    return () => {
      cancelled = true;
      usageAbortRef.current?.abort();
      usageAbortRef.current = null;
    };
  }, [activeScope, canView, loadUsage, sessionRevision, usageCurrentScopeOnly, usageDays]);

  function resetTransientStateForScope(nextScope: Scope) {
    abortAllInFlight();
    setScopeValidationError(null);
    setLoadError(null);
    setSaveError(null);
    setSavedMessage(null);
    setSavingSettings(false);
    setReindexError(null);
    setReindexMessage(null);
    setReindexing(false);
    setQueryError(null);
    setQueryResult(null);
    setQuerying(false);
    applyScopeStatus(createDefaultRetrievalStatus(nextScope.kind, nextScope.id));
  }

  function commitScope(nextKind: ScopeKind, nextIdRaw: string, forceReload = false) {
    const trimmed = nextIdRaw.trim();
    if (!trimmed) {
      setScopeValidationError(tc(KNOWLEDGE_SCOPE_ID_REQUIRED));
      return;
    }
    const nextScope: Scope = { kind: nextKind, id: trimmed };
    const sameScope =
      nextScope.kind === activeScope.kind && nextScope.id === activeScope.id;
    resetTransientStateForScope(nextScope);
    if (sameScope && forceReload) {
      void loadScope(nextScope);
    } else if (!sameScope) {
      setActiveScope(nextScope);
    }
  }

  function handleScopeSubmit(e: React.FormEvent) {
    e.preventDefault();
    commitScope(draftScopeKind, draftScopeId, true);
  }

  function handleScopeKindChange(nextKind: ScopeKind) {
    setDraftScopeKind(nextKind);
    setScopeValidationError(null);
    if (draftScopeId.trim()) {
      commitScope(nextKind, draftScopeId);
    }
  }

  function handleModelChange(nextModel: string) {
    setEmbeddingModel(nextModel);
    const matched = scopeStatus.availableModels.find((m) => m.modelId === nextModel);
    if (
      matched &&
      matched.dimensions >= RETRIEVAL_LIMITS.minDimensions &&
      matched.dimensions <= RETRIEVAL_LIMITS.maxDimensions
    ) {
      setDimensions(matched.dimensions);
    }
  }

  async function handleSaveSettings() {
    if (!canEdit || !activeScope.id || savingSettings) return;
    const masterEpoch = requestEpochRef.current;
    const seq = ++saveSeqRef.current;
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;

    setSavingSettings(true);
    setSaveError(null);
    setSavedMessage(null);

    try {
      const res = await updateRetrievalSettings(
        activeScope.kind,
        activeScope.id,
        {
          mode,
          embeddingModel: embeddingModel === 'auto' ? null : embeddingModel,
          dimensions: clampNumber(
            Math.round(dimensions),
            RETRIEVAL_LIMITS.minDimensions,
            RETRIEVAL_LIMITS.maxDimensions,
          ),
          topK: clampNumber(Math.round(topK), 1, RETRIEVAL_LIMITS.maxTopK),
          minScore: clampNumber(minScore, 0, 1),
          citationsEnabled,
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        saveSeqRef.current !== seq
      ) {
        return;
      }
      applyScopeStatus(res);
      setSavedMessage(tc(KNOWLEDGE_SETTINGS_SAVED));
    } catch (err) {
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        saveSeqRef.current !== seq
      ) {
        return;
      }
      const info = getKnowledgeErrorInfo(err);
      setSaveError(
        info.status === 403
          ? tc(KNOWLEDGE_FORBIDDEN_ERROR)
          : info.message || tc(KNOWLEDGE_SAVE_ERROR),
      );
    } finally {
      if (requestEpochRef.current === masterEpoch && saveSeqRef.current === seq) {
        setSavingSettings(false);
      }
    }
  }

  async function handleReindex() {
    if (!canReindex || !activeScope.id || reindexing) return;
    const masterEpoch = requestEpochRef.current;
    const seq = ++reindexSeqRef.current;
    reindexAbortRef.current?.abort();
    const controller = new AbortController();
    reindexAbortRef.current = controller;

    setReindexing(true);
    setReindexError(null);
    setReindexMessage(null);

    try {
      const res = await triggerRetrievalReindex(
        activeScope.kind,
        activeScope.id,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        reindexSeqRef.current !== seq
      ) {
        return;
      }
      setScopeStatus((prev) => ({
        ...prev,
        activeJob: res.job,
        recentJobs: [res.job, ...prev.recentJobs.filter((j) => j.id !== res.job.id)],
      }));
      setReindexMessage(tc(KNOWLEDGE_REINDEX_STARTED, { id: res.job.id }));
    } catch (err) {
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        reindexSeqRef.current !== seq
      ) {
        return;
      }
      const info = getKnowledgeErrorInfo(err);
      if (info.status === 403) {
        setReindexError(tc(KNOWLEDGE_FORBIDDEN_ERROR));
      } else if (info.status === 409 && info.code === 'job_already_running') {
        setReindexError(tc(KNOWLEDGE_REINDEX_CONFLICT));
      } else {
        setReindexError(info.message || tc(KNOWLEDGE_REINDEX_ERROR));
      }
    } finally {
      if (requestEpochRef.current === masterEpoch && reindexSeqRef.current === seq) {
        setReindexing(false);
      }
    }
  }

  async function handleRunQuery() {
    if (!canQuery || !activeScope.id || !queryText.trim() || querying) return;
    const masterEpoch = requestEpochRef.current;
    const seq = ++querySeqRef.current;
    queryAbortRef.current?.abort();
    const controller = new AbortController();
    queryAbortRef.current = controller;

    setQuerying(true);
    setQueryError(null);

    const parsedTopK = queryTopKOverride.trim() ? Number(queryTopKOverride) : undefined;
    const payload: RetrievalQueryRequest = {
      query: queryText.trim(),
      ...(queryModeOverride ? { mode: queryModeOverride } : {}),
      ...(parsedTopK !== undefined && Number.isFinite(parsedTopK) && parsedTopK > 0
        ? { topK: clampNumber(Math.round(parsedTopK), 1, RETRIEVAL_LIMITS.maxTopK) }
        : {}),
    };

    try {
      const res = await runRetrievalTestQuery(
        activeScope.kind,
        activeScope.id,
        payload,
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        querySeqRef.current !== seq
      ) {
        return;
      }
      setQueryResult(res);
    } catch (err) {
      if (
        controller.signal.aborted ||
        requestEpochRef.current !== masterEpoch ||
        querySeqRef.current !== seq
      ) {
        return;
      }
      const info = getKnowledgeErrorInfo(err);
      if (
        info.status === 409 &&
        (info.code === 'pillar_disabled' || info.code === undefined || info.code === 'conflict')
      ) {
        setQueryError(tc(KNOWLEDGE_QUERY_PILLAR_DISABLED));
      } else if (info.status === 403) {
        setQueryError(tc(KNOWLEDGE_FORBIDDEN_ERROR));
      } else {
        setQueryError(info.message || tc(KNOWLEDGE_QUERY_ERROR));
      }
    } finally {
      if (requestEpochRef.current === masterEpoch && querySeqRef.current === seq) {
        setQuerying(false);
      }
    }
  }

  if (!canView && !canEdit && !canReindex && !canQuery) {
    return (
      <div className="p-6" data-testid="knowledge-no-permission">
        <p className="text-sm text-muted-foreground">{tc(KNOWLEDGE_NO_PERMISSION)}</p>
      </div>
    );
  }

  const { index, activeJob, recentJobs, availableModels } = scopeStatus;
  const clampedPercent = clampNumber(Math.round(index.percentComplete), 0, 100);
  const jobRunning =
    activeJob?.status === 'queued' || activeJob?.status === 'running';
  const hasUnknownModelOption =
    embeddingModel !== 'auto' &&
    !availableModels.some((m) => m.modelId === embeddingModel);

  const renderJobRow = (job: RetrievalIndexJobView) => (
    <div
      key={job.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded border px-3 py-2 text-xs"
      data-testid={`knowledge-job-${job.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono">#{job.id}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 font-medium">
          {tc(JOB_STATUS_LABEL_KEY[job.status])}
        </span>
        <span className="text-muted-foreground">
          {tc(JOB_REASON_LABEL_KEY[job.reason])}
        </span>
        {job.model && <span className="font-mono text-muted-foreground">{job.model}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
        <span>
          {tc(KNOWLEDGE_JOB_PROGRESS, {
            processed: job.processedChunks,
            total: job.totalChunks,
          })}
        </span>
        {job.lastError && (
          <span className="text-red-600">
            {tc(KNOWLEDGE_JOB_LAST_ERROR, { error: job.lastError })}
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="p-6 space-y-6 max-w-5xl" data-testid="knowledge-page">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{tc(KNOWLEDGE_PAGE_TITLE)}</h1>
        <p className="text-sm text-muted-foreground">{tc(KNOWLEDGE_PAGE_SUBTITLE)}</p>
      </header>

      {!canView && (
        <div
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="knowledge-view-required-notice"
        >
          {tc(KNOWLEDGE_VIEW_REQUIRED)}
        </div>
      )}

      {canView && !canEdit && (
        <div
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="knowledge-view-only-notice"
        >
          {tc(KNOWLEDGE_VIEW_ONLY_NOTICE)}
        </div>
      )}

      {/* Scope selector */}
      <form
        onSubmit={handleScopeSubmit}
        className="flex flex-wrap items-end gap-4 rounded-lg border p-3"
        data-testid="knowledge-scope-form"
      >
        <label className="space-y-1 text-xs">
          <span className="font-medium">{tc(KNOWLEDGE_SCOPE_KIND)}</span>
          <select
            className="block rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="knowledge-scope-kind-select"
            aria-label={tc(KNOWLEDGE_SCOPE_KIND)}
            value={draftScopeKind}
            onChange={(e) => handleScopeKindChange(e.target.value as ScopeKind)}
          >
            <option value="profile">{tc(KNOWLEDGE_SCOPE_PROFILE)}</option>
            <option value="support_tenant">{tc(KNOWLEDGE_SCOPE_SUPPORT_TENANT)}</option>
            <option value="agent">{tc(KNOWLEDGE_SCOPE_AGENT)}</option>
          </select>
        </label>

        <label className="space-y-1 text-xs flex-1 min-w-[200px]">
          <span className="font-medium">{tc(KNOWLEDGE_SCOPE_ID)}</span>
          <input
            type="text"
            className="block w-full rounded border px-2 py-1.5 text-sm bg-background"
            data-testid="knowledge-scope-id-input"
            aria-label={tc(KNOWLEDGE_SCOPE_ID)}
            placeholder={tc(KNOWLEDGE_SCOPE_ID_PLACEHOLDER)}
            value={draftScopeId}
            onChange={(e) => {
              setDraftScopeId(e.target.value);
              setScopeValidationError(null);
            }}
          />
        </label>

        <button
          type="submit"
          className="rounded bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground disabled:opacity-50"
          data-testid="knowledge-load-scope-btn"
          disabled={loadingScope}
        >
          {tc(KNOWLEDGE_LOAD_SCOPE)}
        </button>
      </form>

      {scopeValidationError && (
        <div
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
          role="alert"
          data-testid="knowledge-scope-validation-error"
        >
          {scopeValidationError}
        </div>
      )}

      {loadingScope && (
        <p className="text-sm text-muted-foreground" data-testid="knowledge-loading">
          {tc(KNOWLEDGE_LOADING_SCOPE)}
        </p>
      )}

      {loadError && (
        <div
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
          role="alert"
          data-testid="knowledge-load-error"
        >
          {loadError}
        </div>
      )}

      {/* Retrieval Settings Card */}
      <section className="rounded-lg border p-4 space-y-4" data-testid="knowledge-settings-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{tc(KNOWLEDGE_SETTINGS_HEADING)}</h2>
          {scopeStatus.settings.updatedAt && (
            <span className="text-xs text-muted-foreground">
              {tc(KNOWLEDGE_SETTINGS_UPDATED_AT, { time: scopeStatus.settings.updatedAt })}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_MODE_LABEL)}</span>
            <select
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-mode-select"
              aria-label={tc(KNOWLEDGE_MODE_LABEL)}
              disabled={!canEdit}
              value={mode}
              onChange={(e) => setMode(e.target.value as RetrievalMode)}
            >
              <option value="keyword">{tc(KNOWLEDGE_MODE_KEYWORD)}</option>
              <option value="semantic">{tc(KNOWLEDGE_MODE_SEMANTIC)}</option>
              <option value="hybrid">{tc(KNOWLEDGE_MODE_HYBRID)}</option>
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_MODEL_LABEL)}</span>
            <select
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-model-select"
              aria-label={tc(KNOWLEDGE_MODEL_LABEL)}
              disabled={!canEdit}
              value={embeddingModel}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <option value="auto">{tc(KNOWLEDGE_MODEL_AUTO)}</option>
              {hasUnknownModelOption && (
                <option value={embeddingModel}>{embeddingModel}</option>
              )}
              {availableModels.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.displayName} ({m.platform} · {m.dimensions}d)
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_DIMENSIONS_LABEL)}</span>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-dimensions-input"
              aria-label={tc(KNOWLEDGE_DIMENSIONS_LABEL)}
              min={RETRIEVAL_LIMITS.minDimensions}
              max={RETRIEVAL_LIMITS.maxDimensions}
              disabled={!canEdit}
              value={dimensions}
              onChange={(e) => setDimensions(Number(e.target.value))}
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_TOP_K_LABEL)}</span>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-topk-input"
              aria-label={tc(KNOWLEDGE_TOP_K_LABEL)}
              min={1}
              max={RETRIEVAL_LIMITS.maxTopK}
              disabled={!canEdit}
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_MIN_SCORE_LABEL)}</span>
            <input
              type="number"
              step="0.05"
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-minscore-input"
              aria-label={tc(KNOWLEDGE_MIN_SCORE_LABEL)}
              min={0}
              max={1}
              disabled={!canEdit}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            />
          </label>

          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="knowledge-citations-checkbox"
                disabled={!canEdit}
                checked={citationsEnabled}
                onChange={(e) => setCitationsEnabled(e.target.checked)}
              />
              <span>{tc(KNOWLEDGE_CITATIONS_LABEL)}</span>
            </label>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            {saveError && (
              <p className="text-xs text-red-600" role="alert" data-testid="knowledge-save-error">
                {saveError}
              </p>
            )}
            {savedMessage && (
              <p className="text-xs text-emerald-700" data-testid="knowledge-save-success">
                {savedMessage}
              </p>
            )}
          </div>
          <button
            type="button"
            className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid="knowledge-save-settings-btn"
            disabled={!canEdit || savingSettings || !activeScope.id}
            onClick={() => void handleSaveSettings()}
          >
            {savingSettings ? tc(KNOWLEDGE_SAVING_SETTINGS) : tc(KNOWLEDGE_SAVE_SETTINGS)}
          </button>
        </div>
      </section>

      {/* Vector Index Health Card */}
      <section className="rounded-lg border p-4 space-y-4" data-testid="knowledge-index-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">{tc(KNOWLEDGE_INDEX_HEADING)}</h2>
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                index.ready
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-800'
              }`}
              data-testid="knowledge-index-ready"
            >
              {index.ready ? tc(KNOWLEDGE_INDEX_STATUS_READY) : tc(KNOWLEDGE_INDEX_STATUS_BUILDING)}
            </span>
          </div>

          <button
            type="button"
            className="rounded bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground disabled:opacity-50"
            data-testid="knowledge-reindex-btn"
            disabled={!canReindex || reindexing || !activeScope.id || jobRunning}
            onClick={() => void handleReindex()}
          >
            {reindexing ? tc(KNOWLEDGE_REINDEXING_BTN) : tc(KNOWLEDGE_REINDEX_BTN)}
          </button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{tc(KNOWLEDGE_INDEX_PROGRESS)}</span>
            <span data-testid="knowledge-index-percent">{clampedPercent}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={clampedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={tc(KNOWLEDGE_INDEX_PROGRESS)}
            data-testid="knowledge-index-progress-bar"
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${clampedPercent}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_GENERATION)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-generation">
              {index.generation}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_TOTAL_CHUNKS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-total">
              {index.totalChunks}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_READY_CHUNKS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-ready-chunks">
              {index.readyChunks}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_PENDING_CHUNKS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-pending-chunks">
              {index.pendingChunks}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_ERROR_CHUNKS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-error-chunks">
              {index.errorChunks}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEX_STALE_CHUNKS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-index-stale-chunks">
              {index.staleChunks}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEXED_MODEL)}</div>
            <div className="font-mono text-sm font-semibold truncate" data-testid="knowledge-indexed-model">
              {index.indexedModel ?? tc(KNOWLEDGE_NONE_VALUE)}
            </div>
          </div>
          <div className="rounded border p-2">
            <div className="text-muted-foreground">{tc(KNOWLEDGE_INDEXED_DIMS)}</div>
            <div className="font-mono text-sm font-semibold" data-testid="knowledge-indexed-dims">
              {index.indexedDimensions ?? tc(KNOWLEDGE_NONE_VALUE)}
            </div>
          </div>
        </div>

        {reindexMessage && (
          <p className="text-xs text-emerald-700" data-testid="knowledge-reindex-success">
            {reindexMessage}
          </p>
        )}
        {reindexError && (
          <div
            className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
            data-testid="knowledge-reindex-error"
          >
            {reindexError}
          </div>
        )}

        {activeJob && (
          <div
            className="rounded border border-amber-300 bg-amber-50/70 p-3 space-y-1 text-xs"
            data-testid="knowledge-active-job"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
              <span>
                {tc(KNOWLEDGE_ACTIVE_JOB)} #{activeJob.id} — {tc(JOB_STATUS_LABEL_KEY[activeJob.status])}
              </span>
              <span>
                {tc(KNOWLEDGE_JOB_PROGRESS, {
                  processed: activeJob.processedChunks,
                  total: activeJob.totalChunks,
                })}
              </span>
            </div>
            {activeJob.lastError && (
              <p className="text-red-700" data-testid="knowledge-active-job-error">
                {tc(KNOWLEDGE_JOB_LAST_ERROR, { error: activeJob.lastError })}
              </p>
            )}
            {activeJob.retryAfter && (
              <p className="text-amber-800" data-testid="knowledge-active-job-retry">
                {tc(KNOWLEDGE_JOB_RETRY_AFTER, { time: activeJob.retryAfter })}
              </p>
            )}
          </div>
        )}

        <div className="space-y-2" data-testid="knowledge-recent-jobs">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {tc(KNOWLEDGE_RECENT_JOBS)}
          </h3>
          {recentJobs.length === 0 ? (
            <p className="text-xs text-muted-foreground">{tc(KNOWLEDGE_NO_RECENT_JOBS)}</p>
          ) : (
            <div className="space-y-1.5">{recentJobs.map(renderJobRow)}</div>
          )}
        </div>
      </section>

      {/* Semantic Test Query Card */}
      <section className="rounded-lg border p-4 space-y-4" data-testid="knowledge-query-card">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tc(KNOWLEDGE_QUERY_HEADING)}</h2>
          <p className="text-xs text-muted-foreground">{tc(KNOWLEDGE_QUERY_SUBTITLE)}</p>
        </div>

        <label className="block space-y-1 text-sm">
          <span className="font-medium">{tc(KNOWLEDGE_QUERY_INPUT_LABEL)}</span>
          <textarea
            rows={3}
            className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
            data-testid="knowledge-query-input"
            aria-label={tc(KNOWLEDGE_QUERY_INPUT_LABEL)}
            placeholder={tc(KNOWLEDGE_QUERY_INPUT_PLACEHOLDER)}
            disabled={!canQuery}
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_QUERY_MODE_OVERRIDE)}</span>
            <select
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-query-mode-select"
              aria-label={tc(KNOWLEDGE_QUERY_MODE_OVERRIDE)}
              disabled={!canQuery}
              value={queryModeOverride}
              onChange={(e) => setQueryModeOverride(e.target.value as RetrievalMode | '')}
            >
              <option value="">{tc(KNOWLEDGE_QUERY_MODE_SCOPE_DEFAULT)}</option>
              <option value="keyword">{tc(KNOWLEDGE_MODE_KEYWORD)}</option>
              <option value="semantic">{tc(KNOWLEDGE_MODE_SEMANTIC)}</option>
              <option value="hybrid">{tc(KNOWLEDGE_MODE_HYBRID)}</option>
            </select>
          </label>

          <label className="block space-y-1 text-sm">
            <span className="font-medium">{tc(KNOWLEDGE_QUERY_TOPK_OVERRIDE)}</span>
            <input
              type="number"
              className="w-full rounded border px-2 py-1.5 text-sm bg-background disabled:opacity-50"
              data-testid="knowledge-query-topk-input"
              aria-label={tc(KNOWLEDGE_QUERY_TOPK_OVERRIDE)}
              min={1}
              max={RETRIEVAL_LIMITS.maxTopK}
              disabled={!canQuery}
              value={queryTopKOverride}
              onChange={(e) => setQueryTopKOverride(e.target.value)}
            />
          </label>

          <div className="flex justify-end">
            <button
              type="button"
              className="rounded bg-secondary px-4 py-1.5 text-sm font-medium text-secondary-foreground disabled:opacity-50"
              data-testid="knowledge-query-run-btn"
              disabled={!canQuery || querying || !queryText.trim() || !activeScope.id}
              onClick={() => void handleRunQuery()}
            >
              {querying ? tc(KNOWLEDGE_QUERY_RUNNING_BTN) : tc(KNOWLEDGE_QUERY_RUN_BTN)}
            </button>
          </div>
        </div>

        {queryError && (
          <div
            className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
            data-testid="knowledge-query-error"
          >
            {queryError}
          </div>
        )}

        {queryResult && (
          <div className="rounded border bg-muted/20 p-3 space-y-3" data-testid="knowledge-query-results">
            {queryResult.degraded && (
              <div
                className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
                data-testid="knowledge-query-degraded"
              >
                {tc(KNOWLEDGE_QUERY_DEGRADED_BANNER, {
                  mode: queryResult.modeUsed,
                  reason: queryResult.degradedReason
                    ? tc(DEGRADED_REASON_LABEL_KEY[queryResult.degradedReason])
                    : queryResult.modeUsed,
                })}
              </div>
            )}

            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span className="rounded bg-muted px-2 py-0.5 font-mono" data-testid="knowledge-query-mode-used">
                {tc(KNOWLEDGE_QUERY_META_MODE, { mode: queryResult.modeUsed })}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 font-mono" data-testid="knowledge-query-latency">
                {tc(KNOWLEDGE_QUERY_META_LATENCY, { ms: queryResult.latencyMs })}
              </span>
              <span className="rounded bg-muted px-2 py-0.5 font-mono">
                {tc(KNOWLEDGE_QUERY_META_GEN, { gen: queryResult.indexGeneration })}
              </span>
            </div>

            <div className="space-y-2" data-testid="knowledge-query-hits">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tc(KNOWLEDGE_QUERY_HITS_HEADING, { count: queryResult.hits.length })}
              </h3>
              {queryResult.hits.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc(KNOWLEDGE_QUERY_NO_HITS)}</p>
              ) : (
                <div className="space-y-2">
                  {queryResult.hits.map((hit) => (
                    <div
                      key={`${hit.docId}-${hit.chunkId}-${hit.ord}`}
                      className="rounded border bg-background p-2.5 space-y-1.5 text-xs"
                      data-testid={`knowledge-hit-${hit.docId}-${hit.chunkId}`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          <span>{hit.title}</span>
                          <span className="font-mono text-muted-foreground">
                            {tc(KNOWLEDGE_QUERY_HIT_DOC, { docId: hit.docId })}
                          </span>
                          <span className="font-mono text-muted-foreground">
                            {tc(KNOWLEDGE_QUERY_HIT_CHUNK, { ord: hit.ord })}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                            {tc(KNOWLEDGE_QUERY_HIT_SCORE, { score: hit.score.toFixed(4) })}
                          </span>
                          {hit.keywordRank !== undefined && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                              {tc(KNOWLEDGE_QUERY_HIT_KW_RANK, { rank: hit.keywordRank })}
                            </span>
                          )}
                          {hit.semanticRank !== undefined && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                              {tc(KNOWLEDGE_QUERY_HIT_VEC_RANK, { rank: hit.semanticRank })}
                            </span>
                          )}
                          {hit.sources.map((src) => (
                            <span
                              key={src}
                              className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary"
                            >
                              {src === 'keyword'
                                ? tc(KNOWLEDGE_QUERY_SOURCE_KEYWORD)
                                : tc(KNOWLEDGE_QUERY_SOURCE_SEMANTIC)}
                            </span>
                          ))}
                        </div>
                      </div>
                      <p className="whitespace-pre-wrap text-muted-foreground">
                        {hit.snippet || hit.text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2" data-testid="knowledge-query-citations">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {tc(KNOWLEDGE_QUERY_CITATIONS_HEADING, { count: queryResult.citations.length })}
              </h3>
              {queryResult.citations.length === 0 ? (
                <p className="text-xs text-muted-foreground">{tc(KNOWLEDGE_QUERY_NO_CITATIONS)}</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {queryResult.citations.map((cit) => (
                    <li
                      key={`${cit.docId}-${cit.chunkId}`}
                      className="rounded border bg-background px-2.5 py-1.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
                        <span>
                          {cit.title} ({cit.docId}#{cit.chunkId})
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {tc(KNOWLEDGE_QUERY_HIT_SCORE, { score: cit.score.toFixed(4) })}
                        </span>
                      </div>
                      <p className="text-muted-foreground mt-0.5">{cit.snippet}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Embedding Usage Card */}
      <section className="rounded-lg border p-4 space-y-4" data-testid="knowledge-usage-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{tc(KNOWLEDGE_USAGE_HEADING)}</h2>
          {canView && (
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                <span className="text-muted-foreground">{tc(KNOWLEDGE_USAGE_WINDOW_LABEL)}</span>
                <select
                  className="rounded border px-2 py-1 bg-background"
                  data-testid="knowledge-usage-days-select"
                  aria-label={tc(KNOWLEDGE_USAGE_WINDOW_LABEL)}
                  value={usageDays}
                  onChange={(e) => setUsageDays(Number(e.target.value))}
                >
                  <option value={7}>{tc(KNOWLEDGE_USAGE_DAYS_OPTION, { days: 7 })}</option>
                  <option value={30}>{tc(KNOWLEDGE_USAGE_DAYS_OPTION, { days: 30 })}</option>
                  <option value={90}>{tc(KNOWLEDGE_USAGE_DAYS_OPTION, { days: 90 })}</option>
                </select>
              </label>

              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="knowledge-usage-scope-filter"
                  checked={usageCurrentScopeOnly}
                  onChange={(e) => setUsageCurrentScopeOnly(e.target.checked)}
                />
                <span>{tc(KNOWLEDGE_USAGE_SCOPE_FILTER)}</span>
              </label>

              <button
                type="button"
                className="rounded border px-2.5 py-1 hover:bg-muted disabled:opacity-50"
                data-testid="knowledge-usage-refresh-btn"
                disabled={loadingUsage}
                onClick={() =>
                  void loadUsage({
                    days: usageDays,
                    scopeOnly: usageCurrentScopeOnly,
                    scope: activeScope,
                  })
                }
              >
                {tc(KNOWLEDGE_USAGE_REFRESH)}
              </button>
            </div>
          )}
        </div>

        {!canView ? (
          <p className="text-xs text-muted-foreground">{tc(KNOWLEDGE_VIEW_REQUIRED)}</p>
        ) : loadingUsage ? (
          <p className="text-xs text-muted-foreground" data-testid="knowledge-usage-loading">
            {tc(KNOWLEDGE_USAGE_LOADING)}
          </p>
        ) : usageError ? (
          <div
            className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
            role="alert"
            data-testid="knowledge-usage-error"
          >
            {usageError}
          </div>
        ) : usageData ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs" data-testid="knowledge-usage-totals">
              <div className="rounded border p-2">
                <div className="text-muted-foreground">{tc(KNOWLEDGE_USAGE_TOTAL_TOKENS)}</div>
                <div className="font-mono text-sm font-semibold" data-testid="knowledge-usage-total-tokens">
                  {usageData.totals.inputTokens}
                </div>
              </div>
              <div className="rounded border p-2">
                <div className="text-muted-foreground">{tc(KNOWLEDGE_USAGE_TOTAL_REQUESTS)}</div>
                <div className="font-mono text-sm font-semibold" data-testid="knowledge-usage-total-requests">
                  {usageData.totals.requests}
                </div>
              </div>
              <div className="rounded border p-2">
                <div className="text-muted-foreground">{tc(KNOWLEDGE_USAGE_INDEX_TOKENS)}</div>
                <div className="font-mono text-sm font-semibold" data-testid="knowledge-usage-index-tokens">
                  {usageData.totals.indexTokens}
                </div>
              </div>
              <div className="rounded border p-2">
                <div className="text-muted-foreground">{tc(KNOWLEDGE_USAGE_QUERY_TOKENS)}</div>
                <div className="font-mono text-sm font-semibold" data-testid="knowledge-usage-query-tokens">
                  {usageData.totals.queryTokens}
                </div>
              </div>
            </div>

            {usageData.rows.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="knowledge-usage-empty">
                {tc(KNOWLEDGE_USAGE_EMPTY)}
              </p>
            ) : (
              <div className="overflow-x-auto" data-testid="knowledge-usage-rows">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      <th className="py-1.5 pr-3">{tc(KNOWLEDGE_USAGE_COL_DAY)}</th>
                      <th className="py-1.5 pr-3">{tc(KNOWLEDGE_USAGE_COL_SCOPE)}</th>
                      <th className="py-1.5 pr-3">{tc(KNOWLEDGE_USAGE_COL_MODEL)}</th>
                      <th className="py-1.5 pr-3">{tc(KNOWLEDGE_USAGE_COL_PURPOSE)}</th>
                      <th className="py-1.5 pr-3">{tc(KNOWLEDGE_USAGE_COL_TOKENS)}</th>
                      <th className="py-1.5">{tc(KNOWLEDGE_USAGE_COL_REQUESTS)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usageData.rows.map((row, idx) => (
                      <tr
                        key={`${row.day}-${row.scopeKind}-${row.scopeId}-${row.model}-${row.purpose}-${idx}`}
                        className="border-b last:border-b-0"
                      >
                        <td className="py-1.5 pr-3 font-mono">{row.day}</td>
                        <td className="py-1.5 pr-3 font-mono">
                          {row.scopeKind}:{row.scopeId}
                        </td>
                        <td className="py-1.5 pr-3 font-mono">{row.model}</td>
                        <td className="py-1.5 pr-3">
                          {row.purpose === 'index'
                            ? tc(KNOWLEDGE_PURPOSE_INDEX)
                            : tc(KNOWLEDGE_PURPOSE_QUERY)}
                        </td>
                        <td className="py-1.5 pr-3 font-mono">{row.inputTokens}</td>
                        <td className="py-1.5 font-mono">{row.requests}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
