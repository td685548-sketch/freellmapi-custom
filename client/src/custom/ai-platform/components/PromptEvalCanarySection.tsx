import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  EVAL_CANARY_LIMITS,
  abortPromptCanary,
  createDefaultCanaryConfig,
  createPromptEvalCase,
  deletePromptEvalCase,
  fetchPromptCanary,
  fetchPromptEvalCases,
  fetchPromptEvalRuns,
  promotePromptCanary,
  putPromptCanary,
  runPromptEvalSuite,
  type EvalAssertion,
  type EvalAssertionType,
  type PromptCanaryConfig,
  type PromptEvalCase,
  type PromptEvalRun,
  type Scope,
} from '../eval-canary-api';
import {
  CANARY_ABORTED_MSG,
  CANARY_ABORTING_BTN,
  CANARY_ABORT_BTN,
  CANARY_CANDIDATE_LABEL,
  CANARY_ENABLE_LABEL,
  CANARY_ERROR_MSG,
  CANARY_HEADER_HINT,
  CANARY_METRICS_CANDIDATE,
  CANARY_METRICS_PUBLISHED,
  CANARY_PROMOTED_MSG,
  CANARY_PROMOTING_BTN,
  CANARY_PROMOTE_BTN,
  CANARY_SAVED_MSG,
  CANARY_SAVING_BTN,
  CANARY_SAVE_BTN,
  CANARY_SECTION_HEADING,
  CANARY_SECTION_SUBTITLE,
  CANARY_SELECT_VERSION_PLACEHOLDER,
  CANARY_TRAFFIC_PERCENT_LABEL,
  EVAL_ADDING_CASE_BTN,
  EVAL_ADD_CASE_BTN,
  EVAL_ADD_CASE_HEADING,
  EVAL_ASSERTION_CONTAINS,
  EVAL_ASSERTION_JSON_SCHEMA,
  EVAL_ASSERTION_MAX_CHARS,
  EVAL_ASSERTION_NOT_CONTAINS,
  EVAL_ASSERTION_REGEX,
  EVAL_ASSERTION_SCHEMA_INVALID,
  EVAL_ASSERTION_TYPE_LABEL,
  EVAL_ASSERTION_VALUE_LABEL,
  EVAL_ASSERTION_VALUE_PLACEHOLDER,
  EVAL_CANDIDATE_DRAFT_OPT,
  EVAL_CANDIDATE_LABEL,
  EVAL_CANDIDATE_VER_OPT,
  EVAL_CASES_COUNT,
  EVAL_CASES_EMPTY,
  EVAL_CASE_DELETED,
  EVAL_CASE_ERROR,
  EVAL_CASE_FAIL_BADGE,
  EVAL_CASE_IMPROVED_TAG,
  EVAL_CASE_MESSAGE_LABEL,
  EVAL_CASE_MESSAGE_PLACEHOLDER,
  EVAL_CASE_PASS_BADGE,
  EVAL_CASE_REGRESSED_TAG,
  EVAL_CASE_SAVED,
  EVAL_CASE_TITLE_LABEL,
  EVAL_CASE_TITLE_PLACEHOLDER,
  EVAL_CASE_VARS_INVALID,
  EVAL_CASE_VARS_LABEL,
  EVAL_CASE_VARS_PLACEHOLDER,
  EVAL_DELETE_CASE_BTN,
  EVAL_IMPROVEMENTS_BADGE,
  EVAL_LATEST_RUN_HEADING,
  EVAL_LOADING,
  EVAL_LOAD_ERROR,
  EVAL_MODEL_LABEL,
  EVAL_MODEL_PLACEHOLDER,
  EVAL_NO_DRAFT_NOTICE,
  EVAL_NO_REGRESSIONS_BADGE,
  EVAL_REGRESSIONS_BADGE,
  EVAL_RUNNING_BTN,
  EVAL_RUN_BTN,
  EVAL_RUN_ERROR,
  EVAL_RUN_HEADING,
  EVAL_SECTION_HEADING,
  EVAL_SECTION_SUBTITLE,
  EVAL_SUMMARY_BASELINE,
  EVAL_SUMMARY_CANDIDATE,
} from '../eval-canary-strings';
import type { PromptScopeStateResponse } from '../prompts-api';

export interface PromptEvalCanarySectionProps {
  scope: Scope;
  sessionRevision: number;
  canView: boolean;
  canEdit: boolean;
  canPublish: boolean;
  scopeState: PromptScopeStateResponse | null;
  onScopeMutated?: () => void;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function errorMessageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message && err.message !== 'Request failed') {
    return err.message;
  }
  return fallback;
}

function describeAssertion(a: EvalAssertion): string {
  switch (a.type) {
    case 'contains':
      return `contains "${a.value}"`;
    case 'not_contains':
      return `not_contains "${a.value}"`;
    case 'regex':
      return `regex /${a.pattern}/${a.flags ?? ''}`;
    case 'max_chars':
      return `max_chars <= ${a.limit}`;
    case 'json_schema':
      return 'json_schema';
  }
}

export function PromptEvalCanarySection({
  scope,
  sessionRevision,
  canView,
  canEdit,
  canPublish,
  scopeState,
  onScopeMutated,
}: PromptEvalCanarySectionProps) {
  const tc = useCustomT();

  const [cases, setCases] = useState<PromptEvalCase[]>([]);
  const [runs, setRuns] = useState<PromptEvalRun[]>([]);
  const [canary, setCanary] = useState<PromptCanaryConfig>(() => createDefaultCanaryConfig(scope));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add case form
  const [caseTitle, setCaseTitle] = useState('');
  const [caseMessage, setCaseMessage] = useState('');
  const [caseVarsJson, setCaseVarsJson] = useState('');
  const [assertionType, setAssertionType] = useState<EvalAssertionType>('contains');
  const [assertionTarget, setAssertionTarget] = useState('');
  const [addingCase, setAddingCase] = useState(false);
  const [deletingCaseId, setDeletingCaseId] = useState<number | null>(null);
  const [caseFeedback, setCaseFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Eval run form
  const [selectedEvalCandidate, setSelectedEvalCandidate] = useState<string>('draft');
  const [evalModel, setEvalModel] = useState('');
  const [runningEval, setRunningEval] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  // Canary controls
  const [canaryEnabled, setCanaryEnabled] = useState(false);
  const [canaryVersionStr, setCanaryVersionStr] = useState('');
  const [canaryPercent, setCanaryPercent] = useState<number>(EVAL_CANARY_LIMITS.defaultTrafficPercent);
  const [savingCanary, setSavingCanary] = useState(false);
  const [promotingCanary, setPromotingCanary] = useState(false);
  const [abortingCanary, setAbortingCanary] = useState(false);
  const [canaryFeedback, setCanaryFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadEpochRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  const applyCanaryState = useCallback((cfg: PromptCanaryConfig) => {
    setCanary(cfg);
    setCanaryEnabled(cfg.enabled);
    setCanaryVersionStr(cfg.candidateVersion !== null ? String(cfg.candidateVersion) : '');
    setCanaryPercent(cfg.trafficPercent);
  }, []);

  const reloadData = useCallback(async () => {
    if (!canView || !scope.id) return;
    const epoch = ++loadEpochRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    setLoading(true);
    setLoadError(null);

    try {
      const [loadedCases, loadedRuns, loadedCanary] = await Promise.all([
        fetchPromptEvalCases(scope, controller.signal),
        fetchPromptEvalRuns(scope, 5, controller.signal),
        fetchPromptCanary(scope, controller.signal),
      ]);
      if (controller.signal.aborted || loadEpochRef.current !== epoch) return;
      setCases(loadedCases);
      setRuns(loadedRuns);
      applyCanaryState(loadedCanary);
    } catch (err) {
      if (isAbort(err) || controller.signal.aborted || loadEpochRef.current !== epoch) return;
      setLoadError(errorMessageOf(err, tc(EVAL_LOAD_ERROR)));
    } finally {
      if (!controller.signal.aborted && loadEpochRef.current === epoch) {
        setLoading(false);
      }
    }
  }, [applyCanaryState, canView, scope, tc]);

  useEffect(() => {
    if (!canView || !scope.id) {
      loadEpochRef.current += 1;
      loadAbortRef.current?.abort();
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCaseFeedback(null);
      setEvalError(null);
      setCanaryFeedback(null);
      void reloadData();
    });

    return () => {
      cancelled = true;
      loadEpochRef.current += 1;
      loadAbortRef.current?.abort();
    };
  }, [canView, scope, sessionRevision, scopeState?.head.revision, reloadData]);

  async function handleAddCase() {
    if (!canEdit || !scope.id || !caseTitle.trim() || !caseMessage.trim() || !assertionTarget.trim()) {
      return;
    }
    setCaseFeedback(null);

    let parsedVars: Record<string, string> | undefined;
    if (caseVarsJson.trim()) {
      try {
        const raw = JSON.parse(caseVarsJson.trim()) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          setCaseFeedback({ kind: 'err', text: tc(EVAL_CASE_VARS_INVALID) });
          return;
        }
        parsedVars = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
            setCaseFeedback({ kind: 'err', text: tc(EVAL_CASE_VARS_INVALID) });
            return;
          }
          parsedVars[k] = String(v);
        }
      } catch {
        setCaseFeedback({ kind: 'err', text: tc(EVAL_CASE_VARS_INVALID) });
        return;
      }
    }

    let builtAssertion: EvalAssertion;
    const rawTarget = assertionTarget.trim();
    if (assertionType === 'contains' || assertionType === 'not_contains') {
      builtAssertion = { type: assertionType, value: rawTarget };
    } else if (assertionType === 'regex') {
      builtAssertion = { type: 'regex', pattern: rawTarget };
    } else if (assertionType === 'max_chars') {
      const limit = Number.parseInt(rawTarget, 10);
      builtAssertion = { type: 'max_chars', limit: Number.isFinite(limit) && limit > 0 ? limit : 200 };
    } else {
      try {
        const parsedSchema = JSON.parse(rawTarget) as unknown;
        if (!parsedSchema || typeof parsedSchema !== 'object' || Array.isArray(parsedSchema)) {
          setCaseFeedback({ kind: 'err', text: tc(EVAL_ASSERTION_SCHEMA_INVALID) });
          return;
        }
        builtAssertion = {
          type: 'json_schema',
          schema: parsedSchema as Record<string, unknown>,
        };
      } catch {
        setCaseFeedback({ kind: 'err', text: tc(EVAL_ASSERTION_SCHEMA_INVALID) });
        return;
      }
    }

    setAddingCase(true);
    try {
      const created = await createPromptEvalCase(scope, {
        title: caseTitle.trim(),
        userMessage: caseMessage.trim(),
        ...(parsedVars ? { variables: parsedVars } : {}),
        assertions: [builtAssertion],
      });
      if (created) {
        setCases((prev) => [...prev, created]);
      } else {
        await reloadData();
      }
      setCaseTitle('');
      setCaseMessage('');
      setCaseVarsJson('');
      setAssertionTarget('');
      setCaseFeedback({ kind: 'ok', text: tc(EVAL_CASE_SAVED) });
    } catch (err) {
      if (!isAbort(err)) {
        setCaseFeedback({ kind: 'err', text: errorMessageOf(err, tc(EVAL_CASE_ERROR)) });
      }
    } finally {
      setAddingCase(false);
    }
  }

  async function handleDeleteCase(caseId: number) {
    if (!canEdit || !scope.id) return;
    setDeletingCaseId(caseId);
    setCaseFeedback(null);
    try {
      await deletePromptEvalCase(scope, caseId);
      setCases((prev) => prev.filter((c) => c.id !== caseId));
      setCaseFeedback({ kind: 'ok', text: tc(EVAL_CASE_DELETED) });
    } catch (err) {
      if (!isAbort(err)) {
        setCaseFeedback({ kind: 'err', text: errorMessageOf(err, tc(EVAL_CASE_ERROR)) });
      }
    } finally {
      setDeletingCaseId(null);
    }
  }

  async function handleRunEval() {
    if (!canEdit || !scope.id || cases.length === 0) return;
    setRunningEval(true);
    setEvalError(null);
    try {
      const candidateVersion =
        selectedEvalCandidate !== 'draft' && /^\d+$/.test(selectedEvalCandidate)
          ? Number(selectedEvalCandidate)
          : undefined;
      const run = await runPromptEvalSuite(scope, {
        ...(candidateVersion !== undefined ? { candidateVersion } : {}),
        ...(evalModel.trim() ? { model: evalModel.trim() } : {}),
      });
      if (run) {
        setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)].slice(0, 5));
      } else {
        await reloadData();
      }
    } catch (err) {
      if (!isAbort(err)) {
        setEvalError(errorMessageOf(err, tc(EVAL_RUN_ERROR)));
      }
    } finally {
      setRunningEval(false);
    }
  }

  async function handleSaveCanary() {
    if (!canPublish || !scope.id) return;
    setSavingCanary(true);
    setCanaryFeedback(null);
    try {
      const parsedVer = canaryVersionStr.trim() ? Number.parseInt(canaryVersionStr.trim(), 10) : null;
      const candidateVersion = parsedVer !== null && Number.isInteger(parsedVer) && parsedVer > 0 ? parsedVer : null;
      const clampedPct = Math.min(
        EVAL_CANARY_LIMITS.maxTrafficPercent,
        Math.max(EVAL_CANARY_LIMITS.minTrafficPercent, Math.round(canaryPercent || 10)),
      );
      const saved = await putPromptCanary(scope, {
        enabled: canaryEnabled,
        candidateVersion,
        trafficPercent: clampedPct,
      });
      applyCanaryState(saved);
      setCanaryFeedback({ kind: 'ok', text: tc(CANARY_SAVED_MSG) });
    } catch (err) {
      if (!isAbort(err)) {
        setCanaryFeedback({ kind: 'err', text: errorMessageOf(err, tc(CANARY_ERROR_MSG)) });
      }
    } finally {
      setSavingCanary(false);
    }
  }

  async function handlePromoteCanary() {
    if (!canPublish || !scope.id) return;
    setPromotingCanary(true);
    setCanaryFeedback(null);
    try {
      const res = await promotePromptCanary(scope, scopeState?.head.revision);
      if (res?.canary) {
        applyCanaryState(res.canary);
      }
      setCanaryFeedback({ kind: 'ok', text: tc(CANARY_PROMOTED_MSG) });
      onScopeMutated?.();
    } catch (err) {
      if (!isAbort(err)) {
        setCanaryFeedback({ kind: 'err', text: errorMessageOf(err, tc(CANARY_ERROR_MSG)) });
      }
    } finally {
      setPromotingCanary(false);
    }
  }

  async function handleAbortCanary() {
    if (!canPublish || !scope.id) return;
    setAbortingCanary(true);
    setCanaryFeedback(null);
    try {
      const res = await abortPromptCanary(scope);
      if (res?.canary) {
        applyCanaryState(res.canary);
      }
      setCanaryFeedback({ kind: 'ok', text: tc(CANARY_ABORTED_MSG) });
    } catch (err) {
      if (!isAbort(err)) {
        setCanaryFeedback({ kind: 'err', text: errorMessageOf(err, tc(CANARY_ERROR_MSG)) });
      }
    } finally {
      setAbortingCanary(false);
    }
  }

  const versions = scopeState?.versions ?? [];
  const publishedVer = scopeState?.head.publishedVersion ?? null;
  const draftVer = scopeState?.head.draftVersion ?? null;
  const candidateVersionsForCanary = versions.filter((v) => v.version !== publishedVer);
  const canExecuteEval =
    canEdit &&
    cases.length > 0 &&
    !runningEval &&
    (draftVer !== null || (selectedEvalCandidate !== 'draft' && /^\d+$/.test(selectedEvalCandidate)));
  const latestRun = runs[0] ?? null;

  return (
    <div className="space-y-6" data-testid="prompt-eval-canary-section">
      {/* 1. Golden Evaluation Harness */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="prompts-eval-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">{tc(EVAL_SECTION_HEADING)}</h2>
            <p className="text-xs text-muted-foreground">{tc(EVAL_SECTION_SUBTITLE)}</p>
          </div>
          <span className="rounded bg-muted px-2 py-0.5 text-xs font-mono" data-testid="eval-cases-count">
            {tc(EVAL_CASES_COUNT, {
              count: cases.length,
              max: EVAL_CANARY_LIMITS.maxCasesPerScope,
            })}
          </span>
        </div>

        {loading && (
          <p className="text-xs text-muted-foreground" data-testid="eval-loading">
            {tc(EVAL_LOADING)}
          </p>
        )}

        {loadError && (
          <div
            role="alert"
            data-testid="eval-load-error"
            className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {loadError}
          </div>
        )}

        {/* Existing Golden Cases List */}
        {cases.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="eval-cases-empty">
            {tc(EVAL_CASES_EMPTY)}
          </p>
        ) : (
          <div className="space-y-2" data-testid="eval-cases-list">
            {cases.map((c) => (
              <div
                key={c.id}
                data-testid={`eval-case-row-${c.id}`}
                className="flex flex-wrap items-start justify-between gap-2 rounded border p-2.5 text-xs"
              >
                <div className="space-y-1">
                  <div className="font-medium">{c.title}</div>
                  <div className="text-muted-foreground break-words">{c.userMessage}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.assertions.map((a, idx) => (
                      <span
                        key={idx}
                        className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary"
                      >
                        {describeAssertion(a)}
                      </span>
                    ))}
                  </div>
                </div>
                {canEdit && (
                  <button
                    type="button"
                    data-testid={`eval-delete-case-${c.id}`}
                    disabled={deletingCaseId === c.id}
                    onClick={() => void handleDeleteCase(c.id)}
                    className="rounded border px-2 py-1 text-xs text-destructive hover:bg-muted disabled:opacity-50"
                  >
                    {tc(EVAL_DELETE_CASE_BTN)}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Add Golden Case Form */}
        {canEdit && cases.length < EVAL_CANARY_LIMITS.maxCasesPerScope && (
          <div className="rounded border bg-muted/20 p-3 space-y-3" data-testid="eval-add-case-form">
            <h3 className="text-xs font-semibold">{tc(EVAL_ADD_CASE_HEADING)}</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="block space-y-1 text-xs">
                <span className="font-medium">{tc(EVAL_CASE_TITLE_LABEL)}</span>
                <input
                  type="text"
                  maxLength={EVAL_CANARY_LIMITS.maxTitleChars}
                  data-testid="eval-case-title-input"
                  placeholder={tc(EVAL_CASE_TITLE_PLACEHOLDER)}
                  value={caseTitle}
                  onChange={(e) => setCaseTitle(e.target.value)}
                  className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="font-medium">{tc(EVAL_CASE_VARS_LABEL)}</span>
                <input
                  type="text"
                  data-testid="eval-case-vars-input"
                  placeholder={tc(EVAL_CASE_VARS_PLACEHOLDER)}
                  value={caseVarsJson}
                  onChange={(e) => setCaseVarsJson(e.target.value)}
                  className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
                />
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="font-medium">{tc(EVAL_CASE_MESSAGE_LABEL)}</span>
              <textarea
                rows={2}
                maxLength={EVAL_CANARY_LIMITS.maxUserMessageChars}
                data-testid="eval-case-message-input"
                placeholder={tc(EVAL_CASE_MESSAGE_PLACEHOLDER)}
                value={caseMessage}
                onChange={(e) => setCaseMessage(e.target.value)}
                className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
              />
            </label>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="block space-y-1 text-xs">
                <span className="font-medium">{tc(EVAL_ASSERTION_TYPE_LABEL)}</span>
                <select
                  data-testid="eval-assertion-type-select"
                  value={assertionType}
                  onChange={(e) => setAssertionType(e.target.value as EvalAssertionType)}
                  className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
                >
                  <option value="contains">{tc(EVAL_ASSERTION_CONTAINS)}</option>
                  <option value="not_contains">{tc(EVAL_ASSERTION_NOT_CONTAINS)}</option>
                  <option value="regex">{tc(EVAL_ASSERTION_REGEX)}</option>
                  <option value="json_schema">{tc(EVAL_ASSERTION_JSON_SCHEMA)}</option>
                  <option value="max_chars">{tc(EVAL_ASSERTION_MAX_CHARS)}</option>
                </select>
              </label>

              <label className="block space-y-1 text-xs md:col-span-2">
                <span className="font-medium">{tc(EVAL_ASSERTION_VALUE_LABEL)}</span>
                <input
                  type="text"
                  data-testid="eval-assertion-target-input"
                  placeholder={tc(EVAL_ASSERTION_VALUE_PLACEHOLDER)}
                  value={assertionTarget}
                  onChange={(e) => setAssertionTarget(e.target.value)}
                  className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                data-testid="eval-add-case-btn"
                disabled={
                  addingCase ||
                  !caseTitle.trim() ||
                  !caseMessage.trim() ||
                  !assertionTarget.trim()
                }
                onClick={() => void handleAddCase()}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {addingCase ? tc(EVAL_ADDING_CASE_BTN) : tc(EVAL_ADD_CASE_BTN)}
              </button>

              {caseFeedback && (
                <span
                  role={caseFeedback.kind === 'err' ? 'alert' : undefined}
                  data-testid="eval-case-feedback"
                  className={
                    caseFeedback.kind === 'err'
                      ? 'text-xs text-destructive'
                      : 'text-xs text-emerald-700 dark:text-emerald-400'
                  }
                >
                  {caseFeedback.text}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Run Comparative Eval Suite */}
        <div className="border-t pt-3 space-y-3">
          <h3 className="text-xs font-semibold">{tc(EVAL_RUN_HEADING)}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <label className="block space-y-1 text-xs">
              <span className="font-medium">{tc(EVAL_CANDIDATE_LABEL)}</span>
              <select
                data-testid="eval-candidate-select"
                disabled={!canEdit}
                value={selectedEvalCandidate}
                onChange={(e) => setSelectedEvalCandidate(e.target.value)}
                className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
              >
                {draftVer !== null && (
                  <option value="draft">{tc(EVAL_CANDIDATE_DRAFT_OPT, { version: draftVer })}</option>
                )}
                {versions.map((v) => (
                  <option key={v.id} value={String(v.version)}>
                    {tc(EVAL_CANDIDATE_VER_OPT, { version: v.version, status: v.status })}
                  </option>
                ))}
              </select>
            </label>

            <label className="block space-y-1 text-xs">
              <span className="font-medium">{tc(EVAL_MODEL_LABEL)}</span>
              <input
                type="text"
                data-testid="eval-model-input"
                disabled={!canEdit}
                placeholder={tc(EVAL_MODEL_PLACEHOLDER)}
                value={evalModel}
                onChange={(e) => setEvalModel(e.target.value)}
                className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
              />
            </label>

            <div>
              <button
                type="button"
                data-testid="eval-run-btn"
                disabled={!canExecuteEval}
                onClick={() => void handleRunEval()}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {runningEval ? tc(EVAL_RUNNING_BTN) : tc(EVAL_RUN_BTN)}
              </button>
            </div>
          </div>

          {draftVer === null && versions.length === 0 && (
            <p className="text-xs text-muted-foreground">{tc(EVAL_NO_DRAFT_NOTICE)}</p>
          )}

          {evalError && (
            <div
              role="alert"
              data-testid="eval-run-error"
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {evalError}
            </div>
          )}

          {/* Latest Run Comparison Summary */}
          {latestRun && (
            <div className="rounded border bg-muted/20 p-3 space-y-2.5" data-testid="eval-latest-run">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">{tc(EVAL_LATEST_RUN_HEADING)}</span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    data-testid="eval-regressions-badge"
                    className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                      latestRun.regressions > 0
                        ? 'bg-destructive/15 text-destructive'
                        : 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                    }`}
                  >
                    {latestRun.regressions > 0
                      ? tc(EVAL_REGRESSIONS_BADGE, { count: latestRun.regressions })
                      : tc(EVAL_NO_REGRESSIONS_BADGE)}
                  </span>
                  {latestRun.improvements > 0 && (
                    <span
                      data-testid="eval-improvements-badge"
                      className="rounded bg-blue-600/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-400"
                    >
                      {tc(EVAL_IMPROVEMENTS_BADGE, { count: latestRun.improvements })}
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-1 text-xs font-mono">
                {latestRun.baselineSummary && (
                  <div data-testid="eval-baseline-summary" className="text-muted-foreground">
                    {tc(EVAL_SUMMARY_BASELINE, {
                      version: latestRun.baselineSummary.version ?? '-',
                      passed: latestRun.baselineSummary.passedCases,
                      total: latestRun.baselineSummary.totalCases,
                      rate: Math.round(latestRun.baselineSummary.passRate * 100),
                      latency: latestRun.baselineSummary.avgLatencyMs,
                      tokens: latestRun.baselineSummary.totalTokens,
                    })}
                  </div>
                )}
                <div data-testid="eval-candidate-summary">
                  {tc(EVAL_SUMMARY_CANDIDATE, {
                    version: latestRun.candidateSummary.version ?? latestRun.candidateVersion,
                    passed: latestRun.candidateSummary.passedCases,
                    total: latestRun.candidateSummary.totalCases,
                    rate: Math.round(latestRun.candidateSummary.passRate * 100),
                    latency: latestRun.candidateSummary.avgLatencyMs,
                    tokens: latestRun.candidateSummary.totalTokens,
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                {latestRun.cases.map((item) => (
                  <div
                    key={item.caseId}
                    data-testid={`eval-run-case-${item.caseId}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border bg-background px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-medium">{item.title}</span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
                          item.candidate.passed
                            ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                            : 'bg-destructive/15 text-destructive'
                        }`}
                      >
                        {item.candidate.passed ? tc(EVAL_CASE_PASS_BADGE) : tc(EVAL_CASE_FAIL_BADGE)}
                      </span>
                      {item.regressed && (
                        <span className="rounded bg-destructive/15 px-1.5 py-0.5 text-[11px] text-destructive">
                          {tc(EVAL_CASE_REGRESSED_TAG)}
                        </span>
                      )}
                      {item.improved && (
                        <span className="rounded bg-blue-600/15 px-1.5 py-0.5 text-[11px] text-blue-700 dark:text-blue-400">
                          {tc(EVAL_CASE_IMPROVED_TAG)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 2. Weighted Canary Traffic Split */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="prompts-canary-section">
        <div>
          <h2 className="text-base font-semibold">{tc(CANARY_SECTION_HEADING)}</h2>
          <p className="text-xs text-muted-foreground">{tc(CANARY_SECTION_SUBTITLE)}</p>
        </div>

        <label className="flex items-center gap-2 text-xs font-medium">
          <input
            type="checkbox"
            data-testid="canary-enable-toggle"
            disabled={!canPublish}
            checked={canaryEnabled}
            onChange={(e) => setCanaryEnabled(e.target.checked)}
          />
          <span>{tc(CANARY_ENABLE_LABEL)}</span>
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block space-y-1 text-xs">
            <span className="font-medium">{tc(CANARY_CANDIDATE_LABEL)}</span>
            <select
              data-testid="canary-candidate-select"
              disabled={!canPublish}
              value={canaryVersionStr}
              onChange={(e) => setCanaryVersionStr(e.target.value)}
              className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
            >
              <option value="">{tc(CANARY_SELECT_VERSION_PLACEHOLDER)}</option>
              {candidateVersionsForCanary.map((v) => (
                <option key={v.id} value={String(v.version)}>
                  {`v${v.version} (${v.status})`}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-xs">
            <span className="font-medium">{tc(CANARY_TRAFFIC_PERCENT_LABEL)}</span>
            <input
              type="number"
              min={EVAL_CANARY_LIMITS.minTrafficPercent}
              max={EVAL_CANARY_LIMITS.maxTrafficPercent}
              data-testid="canary-traffic-percent-input"
              disabled={!canPublish}
              value={canaryPercent}
              onChange={(e) => setCanaryPercent(Number(e.target.value) || 1)}
              className="block w-full rounded border bg-background px-2.5 py-1.5 text-xs"
            />
          </label>
        </div>

        {/* Live Telemetry Counters */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded border bg-muted/20 p-3 text-xs font-mono">
          <div data-testid="canary-metrics-published">
            {tc(CANARY_METRICS_PUBLISHED, {
              impressions: canary.publishedImpressions,
              errors: canary.publishedErrors,
              latency: canary.publishedAvgLatencyMs,
            })}
          </div>
          <div data-testid="canary-metrics-candidate">
            {tc(CANARY_METRICS_CANDIDATE, {
              impressions: canary.canaryImpressions,
              errors: canary.canaryErrors,
              latency: canary.canaryAvgLatencyMs,
            })}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">{tc(CANARY_HEADER_HINT)}</p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="canary-save-btn"
            disabled={!canPublish || savingCanary || promotingCanary || abortingCanary}
            onClick={() => void handleSaveCanary()}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {savingCanary ? tc(CANARY_SAVING_BTN) : tc(CANARY_SAVE_BTN)}
          </button>

          <button
            type="button"
            data-testid="canary-promote-btn"
            disabled={
              !canPublish ||
              canary.candidateVersion === null ||
              savingCanary ||
              promotingCanary ||
              abortingCanary
            }
            onClick={() => void handlePromoteCanary()}
            className="rounded border bg-emerald-600/15 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400 hover:bg-emerald-600/25 disabled:opacity-50"
          >
            {promotingCanary ? tc(CANARY_PROMOTING_BTN) : tc(CANARY_PROMOTE_BTN)}
          </button>

          <button
            type="button"
            data-testid="canary-abort-btn"
            disabled={
              !canPublish ||
              !canary.enabled ||
              savingCanary ||
              promotingCanary ||
              abortingCanary
            }
            onClick={() => void handleAbortCanary()}
            className="rounded border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/20 disabled:opacity-50"
          >
            {abortingCanary ? tc(CANARY_ABORTING_BTN) : tc(CANARY_ABORT_BTN)}
          </button>
        </div>

        {canaryFeedback && (
          <div
            role={canaryFeedback.kind === 'err' ? 'alert' : undefined}
            data-testid="canary-feedback"
            className={`rounded border px-3 py-2 text-xs ${
              canaryFeedback.kind === 'err'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-emerald-600/30 bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
            }`}
          >
            {canaryFeedback.text}
          </div>
        )}
      </section>
    </div>
  );
}
