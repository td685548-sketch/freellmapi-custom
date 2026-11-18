import {
  PROMPT_LIMITS,
  type PromptEvalCase,
  type PromptEvalCaseComparison,
  type PromptEvalCaseInput,
  type PromptEvalRun,
  type PromptEvalVariantMetrics,
  type PromptEvalVariantOutcome,
  type PromptEvaluateRequest,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';
import type { Scope, ScopeKind } from '@freellmapi/shared/ai-platform.js';
import { getDb, type Db } from '../../../db/index.js';
import { evaluatePatternInWorker, validatePatternRule } from '../output-guard/pattern-validator.js';
import { normalizeScope } from '../scope.js';
import { PromptNotFoundError, PromptStoreError, getPromptScopeState } from './store.js';
import { renderWith, sanitizeVariableValue, validateTemplate } from './template.js';

export interface EvalCallResult {
  reply: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export type EvalModelCaller = (args: {
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  model?: string;
  signal?: AbortSignal;
}) => Promise<EvalCallResult>;

interface EvalCaseRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  name: string;
  user_message: string;
  variables_json: string;
  must_contain_json: string;
  must_not_contain_json: string;
  expected_regex: string | null;
  judge_rubric: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface EvalRunRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  baseline_version: number | null;
  candidate_version: number | null;
  model: string;
  use_judge: number;
  summary_json: string;
  results_json: string;
  created_by: number | null;
  created_at: string;
}

interface VariantSource {
  version: number | null;
  body: string;
  variables: PromptVariable[];
}

const MAX_RETAINED_RUNS = 30;
const MAX_ASSERTION_LIST = 20;
const MAX_ASSERTION_ITEM_CHARS = 200;
const MAX_CASE_VARIABLES = 32;
const NESTED_QUANTIFIER_RE = /\([^)]*(?:[+*]|\{\d+,?\d*\})[^)]*\)\s*(?:[+*]|\{\d+,?\d*\})/;

function tryNormalizeScope(scope: Scope): Scope {
  try {
    return normalizeScope(scope);
  } catch (err) {
    throw new PromptStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function assertEvalTables(db: Db): void {
  const casesOk = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_prompt_eval_cases'")
    .get();
  const runsOk = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_prompt_eval_runs'")
    .get();
  if (!casesOk || !runsOk) {
    throw new PromptStoreError(
      'Prompt evaluation tables are unavailable; run pending migrations.',
      'migration_required',
      500,
    );
  }
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

function parseJsonStringMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function rowToEvalCase(row: EvalCaseRow): PromptEvalCase {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    name: row.name,
    userMessage: row.user_message,
    variables: parseJsonStringMap(row.variables_json),
    mustContain: parseJsonStringArray(row.must_contain_json),
    mustNotContain: parseJsonStringArray(row.must_not_contain_json),
    expectedRegex: row.expected_regex,
    judgeRubric: row.judge_rubric,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvalRun(row: EvalRunRow): PromptEvalRun {
  let summary: {
    baselineMetrics?: PromptEvalVariantMetrics | null;
    candidateMetrics?: PromptEvalVariantMetrics | null;
  } = {};
  let results: PromptEvalCaseComparison[] = [];
  try {
    summary = JSON.parse(row.summary_json) as typeof summary;
  } catch {
    summary = {};
  }
  try {
    const parsed = JSON.parse(row.results_json) as unknown;
    if (Array.isArray(parsed)) results = parsed as PromptEvalCaseComparison[];
  } catch {
    results = [];
  }
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    baselineVersion: row.baseline_version,
    candidateVersion: row.candidate_version,
    model: row.model,
    useJudge: Boolean(row.use_judge),
    baselineMetrics: summary.baselineMetrics ?? null,
    candidateMetrics: summary.candidateMetrics ?? null,
    results,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function sanitizeStringList(list: string[] | undefined, label: string): string[] {
  if (!list) return [];
  if (list.length > MAX_ASSERTION_LIST) {
    throw new PromptStoreError(
      `${label} cannot exceed ${MAX_ASSERTION_LIST} items.`,
      'validation_error',
      400,
    );
  }
  const out: string[] = [];
  for (const item of list) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ASSERTION_ITEM_CHARS) {
      throw new PromptStoreError(
        `${label} entries cannot exceed ${MAX_ASSERTION_ITEM_CHARS} characters.`,
        'validation_error',
        400,
      );
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function sanitizeVariablesMap(vars: Record<string, string> | undefined): Record<string, string> {
  if (!vars) return {};
  const entries = Object.entries(vars);
  if (entries.length > MAX_CASE_VARIABLES) {
    throw new PromptStoreError(
      `At most ${MAX_CASE_VARIABLES} variables are allowed per eval case.`,
      'validation_error',
      400,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const key = k.trim();
    if (!key) continue;
    out[key] = sanitizeVariableValue(String(v));
  }
  return out;
}

async function validateExpectedRegex(raw: string | null | undefined): Promise<string | null> {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > PROMPT_LIMITS.maxEvalRegexChars) {
    throw new PromptStoreError(
      `Expected regex exceeds ${PROMPT_LIMITS.maxEvalRegexChars} characters.`,
      'validation_error',
      400,
    );
  }
  try {
    new RegExp(trimmed, 'i');
  } catch (err) {
    throw new PromptStoreError(
      `Invalid expected regex: ${err instanceof Error ? err.message : 'syntax error'}`,
      'validation_error',
      422,
    );
  }
  if (NESTED_QUANTIFIER_RE.test(trimmed)) {
    throw new PromptStoreError(
      'Unsafe regex pattern detected (nested quantifiers may cause catastrophic backtracking).',
      'unsafe_pattern',
      422,
    );
  }
  const check = await validatePatternRule({
    id: 'eval_expected',
    name: 'expectedRegex',
    pattern: trimmed,
    flags: 'i',
  });
  if (!check.ok) {
    throw new PromptStoreError(check.reason, check.code, 422);
  }
  return trimmed;
}

export function listEvalCases(scope: Scope): PromptEvalCase[] {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  assertEvalTables(db);

  const rows = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_eval_cases WHERE scope_kind = ? AND scope_id = ? ORDER BY id ASC',
    )
    .all(norm.kind, norm.id) as EvalCaseRow[];
  return rows.map(rowToEvalCase);
}

export async function createEvalCase(
  scope: Scope,
  input: PromptEvalCaseInput,
): Promise<PromptEvalCase> {
  const norm = tryNormalizeScope(scope);
  const name = input.name.trim();
  const userMessage = input.userMessage.trim();
  if (!name || name.length > 120) {
    throw new PromptStoreError('Eval case name must be 1–120 characters.', 'validation_error', 400);
  }
  if (!userMessage || userMessage.length > PROMPT_LIMITS.maxTryMessageChars) {
    throw new PromptStoreError(
      `User message must be 1–${PROMPT_LIMITS.maxTryMessageChars} characters.`,
      'validation_error',
      400,
    );
  }
  const variables = sanitizeVariablesMap(input.variables);
  const mustContain = sanitizeStringList(input.mustContain, 'mustContain');
  const mustNotContain = sanitizeStringList(input.mustNotContain, 'mustNotContain');
  const expectedRegex = await validateExpectedRegex(input.expectedRegex);
  const judgeRubric =
    typeof input.judgeRubric === 'string' && input.judgeRubric.trim().length > 0
      ? input.judgeRubric.trim()
      : null;
  if (judgeRubric && judgeRubric.length > PROMPT_LIMITS.maxEvalRubricChars) {
    throw new PromptStoreError(
      `Judge rubric exceeds ${PROMPT_LIMITS.maxEvalRubricChars} characters.`,
      'validation_error',
      400,
    );
  }
  const enabled = input.enabled === false ? 0 : 1;

  const db = getDb();
  assertEvalTables(db);
  const countRow = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM custom_ai_prompt_eval_cases WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as { cnt: number };
  if (countRow.cnt >= PROMPT_LIMITS.maxEvalCasesPerScope) {
    throw new PromptStoreError(
      `Maximum ${PROMPT_LIMITS.maxEvalCasesPerScope} eval cases per scope reached.`,
      'eval_case_limit',
      409,
    );
  }

  const info = db
    .prepare(
      `INSERT INTO custom_ai_prompt_eval_cases
         (scope_kind, scope_id, name, user_message, variables_json, must_contain_json, must_not_contain_json, expected_regex, judge_rubric, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      norm.kind,
      norm.id,
      name,
      userMessage,
      JSON.stringify(variables),
      JSON.stringify(mustContain),
      JSON.stringify(mustNotContain),
      expectedRegex,
      judgeRubric,
      enabled,
    );

  const created = db
    .prepare('SELECT * FROM custom_ai_prompt_eval_cases WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as EvalCaseRow;
  return rowToEvalCase(created);
}

export async function updateEvalCase(
  scope: Scope,
  caseId: number,
  input: Partial<PromptEvalCaseInput>,
): Promise<PromptEvalCase> {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  assertEvalTables(db);

  const existing = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_eval_cases WHERE id = ? AND scope_kind = ? AND scope_id = ?',
    )
    .get(caseId, norm.kind, norm.id) as EvalCaseRow | undefined;
  if (!existing) {
    throw new PromptNotFoundError(`Eval case ${caseId} not found.`);
  }

  const name = input.name !== undefined ? input.name.trim() : existing.name;
  const userMessage =
    input.userMessage !== undefined ? input.userMessage.trim() : existing.user_message;
  if (!name || name.length > 120) {
    throw new PromptStoreError('Eval case name must be 1–120 characters.', 'validation_error', 400);
  }
  if (!userMessage || userMessage.length > PROMPT_LIMITS.maxTryMessageChars) {
    throw new PromptStoreError(
      `User message must be 1–${PROMPT_LIMITS.maxTryMessageChars} characters.`,
      'validation_error',
      400,
    );
  }

  const variables =
    input.variables !== undefined
      ? sanitizeVariablesMap(input.variables)
      : parseJsonStringMap(existing.variables_json);
  const mustContain =
    input.mustContain !== undefined
      ? sanitizeStringList(input.mustContain, 'mustContain')
      : parseJsonStringArray(existing.must_contain_json);
  const mustNotContain =
    input.mustNotContain !== undefined
      ? sanitizeStringList(input.mustNotContain, 'mustNotContain')
      : parseJsonStringArray(existing.must_not_contain_json);
  const expectedRegex =
    input.expectedRegex !== undefined
      ? await validateExpectedRegex(input.expectedRegex)
      : existing.expected_regex;
  const judgeRubric =
    input.judgeRubric !== undefined
      ? input.judgeRubric && input.judgeRubric.trim().length > 0
        ? input.judgeRubric.trim()
        : null
      : existing.judge_rubric;
  if (judgeRubric && judgeRubric.length > PROMPT_LIMITS.maxEvalRubricChars) {
    throw new PromptStoreError(
      `Judge rubric exceeds ${PROMPT_LIMITS.maxEvalRubricChars} characters.`,
      'validation_error',
      400,
    );
  }
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

  db.prepare(
    `UPDATE custom_ai_prompt_eval_cases
        SET name = ?,
            user_message = ?,
            variables_json = ?,
            must_contain_json = ?,
            must_not_contain_json = ?,
            expected_regex = ?,
            judge_rubric = ?,
            enabled = ?,
            updated_at = datetime('now')
      WHERE id = ? AND scope_kind = ? AND scope_id = ?`,
  ).run(
    name,
    userMessage,
    JSON.stringify(variables),
    JSON.stringify(mustContain),
    JSON.stringify(mustNotContain),
    expectedRegex,
    judgeRubric,
    enabled,
    caseId,
    norm.kind,
    norm.id,
  );

  const updated = db
    .prepare('SELECT * FROM custom_ai_prompt_eval_cases WHERE id = ?')
    .get(caseId) as EvalCaseRow;
  return rowToEvalCase(updated);
}

export function deleteEvalCase(scope: Scope, caseId: number): boolean {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  assertEvalTables(db);
  const res = db
    .prepare('DELETE FROM custom_ai_prompt_eval_cases WHERE id = ? AND scope_kind = ? AND scope_id = ?')
    .run(caseId, norm.kind, norm.id);
  if (res.changes === 0) {
    throw new PromptNotFoundError(`Eval case ${caseId} not found.`);
  }
  return true;
}

export function listEvalRuns(scope: Scope, limit = 10): PromptEvalRun[] {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  assertEvalTables(db);
  const safeLimit = Math.max(1, Math.min(30, Math.trunc(limit)));
  const rows = db
    .prepare(
      'SELECT * FROM custom_ai_prompt_eval_runs WHERE scope_kind = ? AND scope_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(norm.kind, norm.id, safeLimit) as EvalRunRow[];
  return rows.map(rowToEvalRun);
}

function parseJudgeResponse(raw: string): { score: number | null; reason: string | null } {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = /\{[\s\S]*\}/.exec(stripped);
  if (!match) {
    return { score: null, reason: 'Judge response was not valid JSON.' };
  }
  try {
    const parsed = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
    const rawScore = Number(parsed.score);
    const score =
      Number.isFinite(rawScore) ? Math.max(1, Math.min(5, Math.round(rawScore))) : null;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason.trim().slice(0, 300)
        : null;
    return { score, reason };
  } catch {
    return { score: null, reason: 'Judge response could not be parsed.' };
  }
}

async function evaluateVariantCase(
  variant: VariantSource,
  evalCase: PromptEvalCase,
  baseValues: Record<string, string>,
  model: string | undefined,
  useJudge: boolean,
  callModel: EvalModelCaller,
  signal?: AbortSignal,
): Promise<{ outcome: PromptEvalVariantOutcome; servedModel: string }> {
  const rendered = renderWith(
    variant.body,
    { ...baseValues, ...evalCase.variables },
    variant.variables,
  ).rendered;

  const messages: Array<{ role: 'system' | 'user'; content: string }> =
    rendered.trim().length > 0
      ? [
          { role: 'system', content: rendered },
          { role: 'user', content: evalCase.userMessage },
        ]
      : [{ role: 'user', content: evalCase.userMessage }];

  const result = await callModel({ messages, model, signal });
  const replyLower = result.reply.toLowerCase();
  const failures: string[] = [];

  for (const needle of evalCase.mustContain) {
    if (!replyLower.includes(needle.toLowerCase())) {
      failures.push(`Missing required text: "${needle}"`);
    }
  }
  for (const banned of evalCase.mustNotContain) {
    if (replyLower.includes(banned.toLowerCase())) {
      failures.push(`Contains forbidden text: "${banned}"`);
    }
  }
  if (evalCase.expectedRegex) {
    const rxResult = await evaluatePatternInWorker(
      {
        id: `eval_case_${evalCase.id}`,
        name: evalCase.name,
        pattern: evalCase.expectedRegex,
        flags: 'i',
      },
      result.reply,
    );
    if (rxResult.timedOut) {
      failures.push('Expected regex evaluation timed out.');
    } else if (!rxResult.matched) {
      failures.push(`Reply did not match regex /${evalCase.expectedRegex}/i`);
    }
  }

  let judgeScore: number | null = null;
  let judgeReason: string | null = null;
  if (useJudge) {
    const rubric =
      evalCase.judgeRubric?.trim() ||
      'Accuracy, helpfulness, and strict adherence to system prompt instructions.';
    try {
      const judgeRes = await callModel({
        messages: [
          {
            role: 'system',
            content:
              'You are a strict prompt evaluator. Reply with ONLY valid JSON: {"score": <integer 1-5>, "reason": "<one concise sentence>"}.',
          },
          {
            role: 'user',
            content: [
              `System Prompt:\n${rendered || '(empty)'}`,
              `User Prompt:\n${evalCase.userMessage}`,
              `Rubric:\n${rubric}`,
              `Model Reply:\n${result.reply}`,
            ].join('\n\n'),
          },
        ],
        model,
        signal,
      });
      const parsedJudge = parseJudgeResponse(judgeRes.reply);
      judgeScore = parsedJudge.score;
      judgeReason = parsedJudge.reason;
    } catch (err) {
      judgeScore = null;
      judgeReason =
        err instanceof Error ? `Judge failed: ${err.message.slice(0, 200)}` : 'Judge failed.';
    }
  }

  return {
    servedModel: result.model,
    outcome: {
      version: variant.version,
      reply: result.reply,
      latencyMs: result.latencyMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      passed: failures.length === 0,
      failures,
      judgeScore,
      judgeReason,
    },
  };
}

function summarizeMetrics(
  version: number | null,
  outcomes: Array<PromptEvalVariantOutcome | null>,
): PromptEvalVariantMetrics | null {
  const valid = outcomes.filter((o): o is PromptEvalVariantOutcome => o !== null);
  if (valid.length === 0) return null;
  const passedCases = valid.filter((o) => o.passed).length;
  const totalLatency = valid.reduce((sum, o) => sum + o.latencyMs, 0);
  const totalTokens = valid.reduce((sum, o) => sum + o.totalTokens, 0);
  const judgeScores = valid
    .map((o) => o.judgeScore)
    .filter((s): s is number => typeof s === 'number');

  return {
    version,
    totalCases: valid.length,
    passedCases,
    passRatePct: Math.round((passedCases / valid.length) * 1000) / 10,
    avgLatencyMs: Math.round(totalLatency / valid.length),
    avgTokens: Math.round(totalTokens / valid.length),
    avgJudgeScore:
      judgeScores.length > 0
        ? Math.round((judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length) * 100) / 100
        : null,
  };
}

export async function runPromptEvaluation(
  scope: Scope,
  input: PromptEvaluateRequest,
  baseValues: Record<string, string>,
  actorId: number | null,
  callModel: EvalModelCaller,
  signal?: AbortSignal,
): Promise<PromptEvalRun> {
  const norm = tryNormalizeScope(scope);
  const db = getDb();
  assertEvalTables(db);

  const state = getPromptScopeState(norm);
  const baseline: VariantSource | null = state.published
    ? {
        version: state.published.version,
        body: state.published.body,
        variables: state.published.variables,
      }
    : null;

  let candidate: VariantSource | null = null;
  if (input.candidateBody !== undefined) {
    const candidateVars = input.candidateVariables ?? state.draft?.variables ?? [];
    const check = validateTemplate(input.candidateBody, candidateVars);
    if (!check.ok) {
      throw new PromptStoreError(check.reason, 'invalid_template', 422);
    }
    candidate = {
      version: null,
      body: input.candidateBody,
      variables: candidateVars,
    };
  } else if (state.draft) {
    candidate = {
      version: state.draft.version,
      body: state.draft.body,
      variables: state.draft.variables,
    };
  }

  if (!baseline && !candidate) {
    throw new PromptStoreError('No published or draft prompt exists to evaluate.', 'no_prompt', 409);
  }

  let selectedCases: PromptEvalCase[];
  if (input.caseIds && input.caseIds.length > 0) {
    if (input.caseIds.length > PROMPT_LIMITS.maxEvalCasesPerRun) {
      throw new PromptStoreError(
        `At most ${PROMPT_LIMITS.maxEvalCasesPerRun} eval cases can run at once.`,
        'validation_error',
        400,
      );
    }
    const placeholders = input.caseIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT * FROM custom_ai_prompt_eval_cases
          WHERE scope_kind = ? AND scope_id = ? AND id IN (${placeholders})
          ORDER BY id ASC`,
      )
      .all(norm.kind, norm.id, ...input.caseIds) as EvalCaseRow[];
    selectedCases = rows.map(rowToEvalCase);
    if (selectedCases.length === 0) {
      throw new PromptNotFoundError('No matching eval cases found for this scope.');
    }
  } else {
    const rows = db
      .prepare(
        `SELECT * FROM custom_ai_prompt_eval_cases
          WHERE scope_kind = ? AND scope_id = ? AND enabled = 1
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(norm.kind, norm.id, PROMPT_LIMITS.maxEvalCasesPerRun) as EvalCaseRow[];
    selectedCases = rows.map(rowToEvalCase);
    if (selectedCases.length === 0) {
      throw new PromptStoreError(
        'Create and enable at least one golden eval case before running evaluations.',
        'no_eval_cases',
        409,
      );
    }
  }

  const useJudge = Boolean(input.useJudge);
  let observedModel = input.model?.trim() || 'auto';
  const results: PromptEvalCaseComparison[] = [];

  for (const evalCase of selectedCases) {
    if (signal?.aborted) {
      throw new PromptStoreError('Evaluation aborted.', 'aborted', 499);
    }
    const [baseRes, candRes] = await Promise.all([
      baseline
        ? evaluateVariantCase(baseline, evalCase, baseValues, input.model, useJudge, callModel, signal)
        : Promise.resolve(null),
      candidate
        ? evaluateVariantCase(candidate, evalCase, baseValues, input.model, useJudge, callModel, signal)
        : Promise.resolve(null),
    ]);
    if (candRes?.servedModel) observedModel = candRes.servedModel;
    else if (baseRes?.servedModel) observedModel = baseRes.servedModel;

    results.push({
      caseId: evalCase.id,
      name: evalCase.name,
      userMessage: evalCase.userMessage,
      baseline: baseRes?.outcome ?? null,
      candidate: candRes?.outcome ?? null,
    });
  }

  const baselineMetrics = summarizeMetrics(
    baseline?.version ?? null,
    results.map((r) => r.baseline),
  );
  const candidateMetrics = summarizeMetrics(
    candidate?.version ?? null,
    results.map((r) => r.candidate),
  );

  const insertedId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO custom_ai_prompt_eval_runs
           (scope_kind, scope_id, baseline_version, candidate_version, model, use_judge, summary_json, results_json, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        norm.kind,
        norm.id,
        baseline?.version ?? null,
        candidate?.version ?? null,
        observedModel,
        useJudge ? 1 : 0,
        JSON.stringify({ baselineMetrics, candidateMetrics }),
        JSON.stringify(results),
        actorId,
      );

    db.prepare(
      `DELETE FROM custom_ai_prompt_eval_runs
        WHERE scope_kind = ? AND scope_id = ?
          AND id NOT IN (
            SELECT id FROM custom_ai_prompt_eval_runs
             WHERE scope_kind = ? AND scope_id = ?
             ORDER BY id DESC
             LIMIT ?
          )`,
    ).run(norm.kind, norm.id, norm.kind, norm.id, MAX_RETAINED_RUNS);

    return Number(info.lastInsertRowid);
  })();

  const runRow = db
    .prepare('SELECT * FROM custom_ai_prompt_eval_runs WHERE id = ?')
    .get(insertedId) as EvalRunRow;
  return rowToEvalRun(runRow);
}
