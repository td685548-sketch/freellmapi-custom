import { useEffect, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  createPromptEvalCase,
  deletePromptEvalCase,
  fetchPromptEvalCases,
  fetchPromptEvalRuns,
  getPromptErrorInfo,
  runPromptEvaluationApi,
  updatePromptEvalCase,
  type PromptEvalCase,
  type PromptEvalRun,
  type PromptEvalVariantMetrics,
  type PromptEvalVariantOutcome,
  type PromptVariable,
  type Scope,
} from '../prompts-api';
import {
  PROMPTS_EVAL_ADD_CASE_BTN,
  PROMPTS_EVAL_CANCEL_EDIT_BTN,
  PROMPTS_EVAL_CANDIDATE_COL,
  PROMPTS_EVAL_CASES_EMPTY,
  PROMPTS_EVAL_CASE_DELETE_BTN,
  PROMPTS_EVAL_CASE_EDIT_BTN,
  PROMPTS_EVAL_CASE_ENABLED_LABEL,
  PROMPTS_EVAL_CASE_MSG_LABEL,
  PROMPTS_EVAL_CASE_MSG_PLACEHOLDER,
  PROMPTS_EVAL_CASE_MUST_CONTAIN_LABEL,
  PROMPTS_EVAL_CASE_MUST_NOT_CONTAIN_LABEL,
  PROMPTS_EVAL_CASE_NAME_LABEL,
  PROMPTS_EVAL_CASE_NAME_PLACEHOLDER,
  PROMPTS_EVAL_CASE_REGEX_LABEL,
  PROMPTS_EVAL_CASE_RUBRIC_LABEL,
  PROMPTS_EVAL_CASE_SAVE_BTN,
  PROMPTS_EVAL_CASE_SAVING_BTN,
  PROMPTS_EVAL_CASE_VARS_INVALID,
  PROMPTS_EVAL_CASE_VARS_LABEL,
  PROMPTS_EVAL_ERROR,
  PROMPTS_EVAL_FAIL_BADGE,
  PROMPTS_EVAL_HEADING,
  PROMPTS_EVAL_JUDGE_SCORE,
  PROMPTS_EVAL_LATEST_RUN_HEADING,
  PROMPTS_EVAL_LOADING,
  PROMPTS_EVAL_LOAD_ERROR,
  PROMPTS_EVAL_METRICS_LINE,
  PROMPTS_EVAL_MODEL_LABEL,
  PROMPTS_EVAL_NO_RUNS,
  PROMPTS_EVAL_PASS_BADGE,
  PROMPTS_EVAL_PUBLISHED_COL,
  PROMPTS_EVAL_RUNS_HISTORY_HEADING,
  PROMPTS_EVAL_RUNNING_BTN,
  PROMPTS_EVAL_RUN_BTN,
  PROMPTS_EVAL_SUBTITLE,
  PROMPTS_EVAL_USE_JUDGE_LABEL,
  PROMPTS_EVAL_USE_UNSAVED_LABEL,
} from '../prompts-strings';

export interface PromptEvalSectionProps {
  scope: Scope;
  canView: boolean;
  canEdit: boolean;
  candidateBody: string;
  candidateVariables: PromptVariable[];
}

function splitLinesInput(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseVariablesJsonInput(raw: string): Record<string, string> | null {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (k.trim()) out[k.trim()] = String(v ?? '');
    }
    return out;
  } catch {
    return null;
  }
}

export function PromptEvalSection({
  scope,
  canView,
  canEdit,
  candidateBody,
  candidateVariables,
}: PromptEvalSectionProps) {
  const tc = useCustomT();
  const [cases, setCases] = useState<PromptEvalCase[]>([]);
  const [runs, setRuns] = useState<PromptEvalRun[]>([]);
  const [loading, setLoading] = useState(canView && Boolean(scope.id));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  const [editingCaseId, setEditingCaseId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [caseName, setCaseName] = useState('');
  const [userMessage, setUserMessage] = useState('');
  const [varsJson, setVarsJson] = useState('');
  const [mustContainText, setMustContainText] = useState('');
  const [mustNotContainText, setMustNotContainText] = useState('');
  const [expectedRegex, setExpectedRegex] = useState('');
  const [judgeRubric, setJudgeRubric] = useState('');
  const [caseEnabled, setCaseEnabled] = useState(true);
  const [savingCase, setSavingCase] = useState(false);

  const [evalModel, setEvalModel] = useState('');
  const [useJudge, setUseJudge] = useState(false);
  const [evaluateUnsaved, setEvaluateUnsaved] = useState(false);
  const [runningEval, setRunningEval] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!canView || !scope.id) return;
    const controller = new AbortController();
    void Promise.all([
      fetchPromptEvalCases(scope, controller.signal),
      fetchPromptEvalRuns(scope, controller.signal),
    ])
      .then(([casesRes, runsRes]) => {
        if (controller.signal.aborted) return;
        setCases(casesRes.cases ?? []);
        const nextRuns = runsRes.runs ?? [];
        setRuns(nextRuns);
        setSelectedRunId((prev) => prev ?? nextRuns[0]?.id ?? null);
        setLoadError(null);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoadError(getPromptErrorInfo(err).message || tc(PROMPTS_EVAL_LOAD_ERROR));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [canView, scope, tc]);

  function resetForm() {
    setEditingCaseId(null);
    setShowForm(false);
    setCaseName('');
    setUserMessage('');
    setVarsJson('');
    setMustContainText('');
    setMustNotContainText('');
    setExpectedRegex('');
    setJudgeRubric('');
    setCaseEnabled(true);
  }

  function startEditCase(c: PromptEvalCase) {
    setEditingCaseId(c.id);
    setShowForm(true);
    setActionError(null);
    setCaseName(c.name);
    setUserMessage(c.userMessage);
    setVarsJson(Object.keys(c.variables).length > 0 ? JSON.stringify(c.variables, null, 2) : '');
    setMustContainText(c.mustContain.join('\n'));
    setMustNotContainText(c.mustNotContain.join('\n'));
    setExpectedRegex(c.expectedRegex ?? '');
    setJudgeRubric(c.judgeRubric ?? '');
    setCaseEnabled(c.enabled);
  }

  async function handleSaveCase() {
    if (!canEdit || savingCase) return;
    const parsedVars = parseVariablesJsonInput(varsJson);
    if (parsedVars === null) {
      setActionError(tc(PROMPTS_EVAL_CASE_VARS_INVALID));
      return;
    }

    setSavingCase(true);
    setActionError(null);
    const payload = {
      name: caseName.trim(),
      userMessage: userMessage.trim(),
      variables: parsedVars,
      mustContain: splitLinesInput(mustContainText),
      mustNotContain: splitLinesInput(mustNotContainText),
      expectedRegex: expectedRegex.trim() ? expectedRegex.trim() : null,
      judgeRubric: judgeRubric.trim() ? judgeRubric.trim() : null,
      enabled: caseEnabled,
    };

    try {
      if (editingCaseId !== null) {
        const res = await updatePromptEvalCase(scope, editingCaseId, payload);
        setCases((prev) => prev.map((c) => (c.id === editingCaseId ? res.case : c)));
      } else {
        const res = await createPromptEvalCase(scope, payload);
        setCases((prev) => [...prev, res.case]);
      }
      resetForm();
    } catch (err) {
      setActionError(getPromptErrorInfo(err).message || tc(PROMPTS_EVAL_ERROR));
    } finally {
      setSavingCase(false);
    }
  }

  async function handleToggleEnabled(item: PromptEvalCase) {
    if (!canEdit || savingCase) return;
    setActionError(null);
    try {
      const res = await updatePromptEvalCase(scope, item.id, { enabled: !item.enabled });
      setCases((prev) => prev.map((c) => (c.id === item.id ? res.case : c)));
    } catch (err) {
      setActionError(getPromptErrorInfo(err).message || tc(PROMPTS_EVAL_ERROR));
    }
  }

  async function handleDeleteCase(caseId: number) {
    if (!canEdit || savingCase) return;
    setActionError(null);
    try {
      await deletePromptEvalCase(scope, caseId);
      setCases((prev) => prev.filter((c) => c.id !== caseId));
      if (editingCaseId === caseId) resetForm();
    } catch (err) {
      setActionError(getPromptErrorInfo(err).message || tc(PROMPTS_EVAL_ERROR));
    }
  }

  async function handleRunEval() {
    if (!canEdit || runningEval) return;
    setRunningEval(true);
    setActionError(null);
    try {
      const res = await runPromptEvaluationApi(scope, {
        ...(evalModel.trim() ? { model: evalModel.trim() } : {}),
        useJudge,
        ...(evaluateUnsaved ? { candidateBody, candidateVariables } : {}),
      });
      setRuns((prev) => [res.run, ...prev].slice(0, 10));
      setSelectedRunId(res.run.id);
    } catch (err) {
      setActionError(getPromptErrorInfo(err).message || tc(PROMPTS_EVAL_ERROR));
    } finally {
      setRunningEval(false);
    }
  }

  function renderMetricsSummary(title: string, metrics: PromptEvalVariantMetrics | null) {
    if (!metrics) return null;
    return (
      <div className="rounded border bg-muted/20 p-3 space-y-1 text-xs">
        <div className="flex items-center justify-between gap-2 font-semibold">
          <span>{title}</span>
          <span className="font-mono text-muted-foreground">
            {metrics.version !== null ? `v${metrics.version}` : 'unsaved'}
          </span>
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {tc(PROMPTS_EVAL_METRICS_LINE, {
            passed: metrics.passedCases,
            total: metrics.totalCases,
            rate: metrics.passRatePct,
            latency: metrics.avgLatencyMs,
            tokens: metrics.avgTokens,
          })}
        </div>
        {metrics.avgJudgeScore !== null && (
          <div className="text-[11px] font-medium text-primary">
            {tc(PROMPTS_EVAL_JUDGE_SCORE, { score: metrics.avgJudgeScore })}
          </div>
        )}
      </div>
    );
  }

  function renderOutcomeCell(outcome: PromptEvalVariantOutcome | null, label: string) {
    if (!outcome) {
      return <div className="rounded border bg-muted/10 p-2 text-xs text-muted-foreground">—</div>;
    }
    return (
      <div className="rounded border bg-background p-2.5 space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-muted-foreground">{label}</span>
          <div className="flex items-center gap-1.5">
            {outcome.judgeScore !== null && (
              <span className="rounded bg-blue-600/15 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-400">
                {tc(PROMPTS_EVAL_JUDGE_SCORE, { score: outcome.judgeScore })}
              </span>
            )}
            <span
              className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                outcome.passed
                  ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
                  : 'bg-destructive/15 text-destructive'
              }`}
            >
              {outcome.passed ? tc(PROMPTS_EVAL_PASS_BADGE) : tc(PROMPTS_EVAL_FAIL_BADGE)}
            </span>
          </div>
        </div>
        <pre className="whitespace-pre-wrap break-words rounded border bg-muted/20 p-2 text-[11px] max-h-40 overflow-auto">
          {outcome.reply}
        </pre>
        {outcome.failures.length > 0 && (
          <ul className="list-disc pl-4 text-[11px] text-destructive space-y-0.5">
            {outcome.failures.map((f, idx) => (
              <li key={idx}>{f}</li>
            ))}
          </ul>
        )}
        {outcome.judgeReason && (
          <p className="text-[11px] text-muted-foreground italic">{outcome.judgeReason}</p>
        )}
      </div>
    );
  }

  const activeRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null;

  return (
    <section
      className="rounded-lg border bg-card p-4 space-y-4"
      data-testid="prompts-eval-section"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{tc(PROMPTS_EVAL_HEADING)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{tc(PROMPTS_EVAL_SUBTITLE)}</p>
        </div>
        {canEdit && (
          <button
            type="button"
            data-testid="prompts-eval-add-case-btn"
            onClick={() => {
              if (showForm) {
                resetForm();
              } else {
                setShowForm(true);
                setActionError(null);
              }
            }}
            className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            {showForm ? tc(PROMPTS_EVAL_CANCEL_EDIT_BTN) : tc(PROMPTS_EVAL_ADD_CASE_BTN)}
          </button>
        )}
      </div>

      {loading && <p className="text-xs text-muted-foreground">{tc(PROMPTS_EVAL_LOADING)}</p>}
      {loadError && (
        <div
          role="alert"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {loadError}
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          data-testid="prompts-eval-action-error"
          className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {actionError}
        </div>
      )}

      {showForm && canEdit && (
        <div
          data-testid="prompts-eval-case-form"
          className="rounded border bg-muted/20 p-3 space-y-3"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_NAME_LABEL)}</span>
              <input
                type="text"
                data-testid="prompts-eval-case-name-input"
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                placeholder={tc(PROMPTS_EVAL_CASE_NAME_PLACEHOLDER)}
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_REGEX_LABEL)}</span>
              <input
                type="text"
                data-testid="prompts-eval-case-regex-input"
                value={expectedRegex}
                onChange={(e) => setExpectedRegex(e.target.value)}
                placeholder="^(ok|yes)"
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
              />
            </label>
          </div>

          <label className="block space-y-1 text-xs">
            <span className="font-medium">{tc(PROMPTS_EVAL_CASE_MSG_LABEL)}</span>
            <textarea
              rows={2}
              data-testid="prompts-eval-case-msg-input"
              value={userMessage}
              onChange={(e) => setUserMessage(e.target.value)}
              placeholder={tc(PROMPTS_EVAL_CASE_MSG_PLACEHOLDER)}
              className="w-full rounded border bg-background px-2.5 py-1.5 text-xs"
            />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_MUST_CONTAIN_LABEL)}</span>
              <textarea
                rows={2}
                data-testid="prompts-eval-must-contain-input"
                value={mustContainText}
                onChange={(e) => setMustContainText(e.target.value)}
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_MUST_NOT_CONTAIN_LABEL)}</span>
              <textarea
                rows={2}
                data-testid="prompts-eval-must-not-contain-input"
                value={mustNotContainText}
                onChange={(e) => setMustNotContainText(e.target.value)}
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_VARS_LABEL)}</span>
              <textarea
                rows={2}
                data-testid="prompts-eval-vars-input"
                value={varsJson}
                onChange={(e) => setVarsJson(e.target.value)}
                placeholder='{"language": "vi"}'
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs font-mono"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(PROMPTS_EVAL_CASE_RUBRIC_LABEL)}</span>
              <textarea
                rows={2}
                data-testid="prompts-eval-rubric-input"
                value={judgeRubric}
                onChange={(e) => setJudgeRubric(e.target.value)}
                className="w-full rounded border bg-background px-2.5 py-1.5 text-xs"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={caseEnabled}
                onChange={(e) => setCaseEnabled(e.target.checked)}
              />
              <span>{tc(PROMPTS_EVAL_CASE_ENABLED_LABEL)}</span>
            </label>
            <button
              type="button"
              data-testid="prompts-eval-save-case-btn"
              disabled={savingCase || !caseName.trim() || !userMessage.trim()}
              onClick={() => void handleSaveCase()}
              className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {savingCase ? tc(PROMPTS_EVAL_CASE_SAVING_BTN) : tc(PROMPTS_EVAL_CASE_SAVE_BTN)}
            </button>
          </div>
        </div>
      )}

      {cases.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="prompts-eval-cases-empty">
          {tc(PROMPTS_EVAL_CASES_EMPTY)}
        </p>
      ) : (
        <div className="space-y-2" data-testid="prompts-eval-cases-list">
          {cases.map((c) => (
            <div
              key={c.id}
              data-testid={`prompts-eval-case-row-${c.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-2.5 text-xs"
            >
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  {c.mustContain.length > 0 && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                      {`+contain: ${c.mustContain.length}`}
                    </span>
                  )}
                  {c.mustNotContain.length > 0 && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                      {`-forbid: ${c.mustNotContain.length}`}
                    </span>
                  )}
                  {c.expectedRegex && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {`/${c.expectedRegex}/i`}
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground line-clamp-1">{c.userMessage}</p>
              </div>
              {canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1 text-[11px]">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={() => void handleToggleEnabled(c)}
                    />
                    <span>{tc(PROMPTS_EVAL_CASE_ENABLED_LABEL)}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => startEditCase(c)}
                    className="rounded border px-2 py-1 text-xs hover:bg-muted"
                  >
                    {tc(PROMPTS_EVAL_CASE_EDIT_BTN)}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeleteCase(c.id)}
                    className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    {tc(PROMPTS_EVAL_CASE_DELETE_BTN)}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center gap-3 rounded border bg-muted/10 p-3 text-xs">
          <label className="flex items-center gap-1.5">
            <span className="font-medium">{tc(PROMPTS_EVAL_MODEL_LABEL)}</span>
            <input
              type="text"
              data-testid="prompts-eval-model-input"
              value={evalModel}
              onChange={(e) => setEvalModel(e.target.value)}
              placeholder="auto"
              className="rounded border bg-background px-2 py-1 text-xs w-44"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="prompts-eval-judge-checkbox"
              checked={useJudge}
              onChange={(e) => setUseJudge(e.target.checked)}
            />
            <span>{tc(PROMPTS_EVAL_USE_JUDGE_LABEL)}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="prompts-eval-unsaved-checkbox"
              checked={evaluateUnsaved}
              onChange={(e) => setEvaluateUnsaved(e.target.checked)}
            />
            <span>{tc(PROMPTS_EVAL_USE_UNSAVED_LABEL)}</span>
          </label>
          <button
            type="button"
            data-testid="prompts-eval-run-btn"
            disabled={runningEval || cases.every((c) => !c.enabled)}
            onClick={() => void handleRunEval()}
            className="ml-auto rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {runningEval ? tc(PROMPTS_EVAL_RUNNING_BTN) : tc(PROMPTS_EVAL_RUN_BTN)}
          </button>
        </div>
      )}

      {activeRun ? (
        <div className="space-y-3" data-testid="prompts-eval-latest-run">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{tc(PROMPTS_EVAL_LATEST_RUN_HEADING)}</h3>
            {runs.length > 1 && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">{tc(PROMPTS_EVAL_RUNS_HISTORY_HEADING)}</span>
                {runs.slice(0, 5).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedRunId(r.id)}
                    className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                      r.id === activeRun.id
                        ? 'border-primary bg-primary/10 text-primary font-semibold'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {`#${r.id}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {renderMetricsSummary(tc(PROMPTS_EVAL_PUBLISHED_COL), activeRun.baselineMetrics)}
            {renderMetricsSummary(tc(PROMPTS_EVAL_CANDIDATE_COL), activeRun.candidateMetrics)}
          </div>

          <div className="space-y-2.5">
            {activeRun.results.map((item) => (
              <div key={item.caseId} className="rounded border p-3 space-y-2">
                <div className="text-xs font-semibold">{item.name}</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {renderOutcomeCell(item.baseline, tc(PROMPTS_EVAL_PUBLISHED_COL))}
                  {renderOutcomeCell(item.candidate, tc(PROMPTS_EVAL_CANDIDATE_COL))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{tc(PROMPTS_EVAL_NO_RUNS)}</p>
      )}
    </section>
  );
}
