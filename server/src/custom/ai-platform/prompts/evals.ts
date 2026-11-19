import { performance } from 'node:perf_hooks';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Request } from 'express';
import {
  EVAL_CANARY_LIMITS,
  type EvalAssertion,
  type EvalAssertionResult,
  type EvalCaseComparison,
  type EvalVariantCaseOutcome,
  type EvalVariantSummary,
  type PromptEvalCase,
  type PromptEvalCaseInput,
  type PromptEvalRun,
  type RunPromptEvalRequest,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-eval-canary.js';
import {
  PROMPT_VAR_NAME_REGEX,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';
import { GUARD_ALLOWED_PATTERN_FLAGS } from '@freellmapi/shared/ai-platform-output-guard.js';
import { getDb, getInternalLoopbackToken, type Db } from '../../../db/index.js';
import { isPillarEnabled } from '../flags.js';
import { GatewayCallError, callGateway } from '../loopback.js';
import {
  evaluatePatternInWorker,
  validatePatternRule,
} from '../output-guard/pattern-validator.js';
import { normalizeScope } from '../scope.js';
import {
  PromptNotFoundError,
  PromptStoreError,
  getPromptScopeState,
  getPromptVersion,
} from './store.js';
import { renderWith, sanitizeVariableValue } from './template.js';

const ajv = new (Ajv2020 as unknown as typeof import('ajv').default)({
  strict: false,
  validateFormats: false,
});

const allowedRegexFlags = new Set<string>(GUARD_ALLOWED_PATTERN_FLAGS);

interface EvalCaseRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  title: string;
  user_message: string;
  variables_json: string;
  assertions_json: string;
  created_at: string;
  updated_at: string;
}

interface EvalRunRow {
  id: number;
  scope_kind: ScopeKind;
  scope_id: string;
  model: string;
  baseline_version: number | null;
  candidate_version: number;
  candidate_label: 'draft' | 'version';
  baseline_summary_json: string | null;
  candidate_summary_json: string;
  regressions: number;
  improvements: number;
  cases_json: string;
  actor_id: number | null;
  created_at: string;
}

export type EvalGatewayCaller = typeof callGateway;

function tryNormalizeEvalScope(scope: Scope): Scope {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Fast static detector for catastrophic backtracking constructs (backreferences
 * and nested quantifiers like `(a+)+`, `(.*)*`, `([a-z]+){2,}`), complementing
 * `validatePatternRule`'s isolated worker benchmark.
 */
export function hasUnsafeEvalRegexConstruct(pattern: string): string | null {
  let inClass = false;
  let escaped = false;
  const groupHasQuantifier: boolean[] = [];

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (escaped) {
      escaped = false;
      if (!inClass && ((ch >= '1' && ch <= '9') || ch === 'k')) {
        return 'Backreferences are not allowed in eval regex assertions.';
      }
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      groupHasQuantifier.push(false);
      continue;
    }
    if (ch === ')') {
      const hadInnerQuantifier = groupHasQuantifier.pop() ?? false;
      const next = pattern[i + 1];
      const outerQuantified = next === '+' || next === '*' || next === '{';
      if (hadInnerQuantifier && outerQuantified) {
        return 'Nested quantifiers (ReDoS risk) are not allowed in eval regex assertions.';
      }
      if (hadInnerQuantifier && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if (ch === '+' || ch === '*') {
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i + 1);
      if (close !== -1) {
        const inner = pattern.slice(i + 1, close);
        if (/^\d+,\d*$/.test(inner) || /^\d+$/.test(inner)) {
          const [, maxPart] = inner.split(',');
          if (maxPart === '' || Number(maxPart ?? inner) > 1) {
            if (groupHasQuantifier.length > 0) {
              groupHasQuantifier[groupHasQuantifier.length - 1] = true;
            }
          }
          i = close;
        }
      }
    }
  }
  return null;
}

function compileJsonSchemaValidator(schema: Record<string, unknown>): ValidateFunction {
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > EVAL_CANARY_LIMITS.maxJsonSchemaBytes) {
    throw new PromptStoreError(
      `JSON schema exceeds ${EVAL_CANARY_LIMITS.maxJsonSchemaBytes} bytes.`,
      'invalid_json_schema',
      422,
    );
  }
  const clone: Record<string, unknown> = { ...schema };
  delete clone.$schema;
  try {
    return ajv.compile(clone);
  } catch (err) {
    throw new PromptStoreError(
      `Invalid JSON schema: ${err instanceof Error ? err.message : 'compilation failed'}`,
      'invalid_json_schema',
      422,
    );
  }
}

async function validateEvalAssertion(assertion: unknown, idx: number): Promise<EvalAssertion> {
  if (!isPlainObject(assertion) || typeof assertion.type !== 'string') {
    throw new PromptStoreError(
      `Assertion #${idx + 1} must be an object with a valid type.`,
      'validation_error',
      422,
    );
  }

  switch (assertion.type) {
    case 'contains':
    case 'not_contains': {
      if (
        typeof assertion.value !== 'string' ||
        assertion.value.length === 0 ||
        assertion.value.length > EVAL_CANARY_LIMITS.maxAssertionValueChars
      ) {
        throw new PromptStoreError(
          `Assertion #${idx + 1} (${assertion.type}) value must be 1..${EVAL_CANARY_LIMITS.maxAssertionValueChars} characters.`,
          'validation_error',
          422,
        );
      }
      if (assertion.caseSensitive !== undefined && typeof assertion.caseSensitive !== 'boolean') {
        throw new PromptStoreError(
          `Assertion #${idx + 1} caseSensitive must be a boolean.`,
          'validation_error',
          422,
        );
      }
      return {
        type: assertion.type,
        value: assertion.value,
        ...(assertion.caseSensitive !== undefined ? { caseSensitive: assertion.caseSensitive } : {}),
      };
    }

    case 'max_chars': {
      if (
        typeof assertion.limit !== 'number' ||
        !Number.isInteger(assertion.limit) ||
        assertion.limit < 1 ||
        assertion.limit > 100_000
      ) {
        throw new PromptStoreError(
          `Assertion #${idx + 1} (max_chars) limit must be an integer between 1 and 100000.`,
          'validation_error',
          422,
        );
      }
      return { type: 'max_chars', limit: assertion.limit };
    }

    case 'regex': {
      if (
        typeof assertion.pattern !== 'string' ||
        assertion.pattern.length === 0 ||
        assertion.pattern.length > EVAL_CANARY_LIMITS.maxRegexPatternChars
      ) {
        throw new PromptStoreError(
          `Assertion #${idx + 1} (regex) pattern must be 1..${EVAL_CANARY_LIMITS.maxRegexPatternChars} characters.`,
          'validation_error',
          422,
        );
      }
      const rawFlags = typeof assertion.flags === 'string' ? assertion.flags : '';
      const deduped: string[] = [];
      for (const ch of rawFlags) {
        if (!allowedRegexFlags.has(ch)) {
          throw new PromptStoreError(
            `Unsupported regex flag '${ch}' in assertion #${idx + 1}. Allowed flags: i, m, u, s.`,
            'validation_error',
            422,
          );
        }
        if (!deduped.includes(ch)) deduped.push(ch);
      }
      const flags = deduped.join('');

      const staticUnsafe = hasUnsafeEvalRegexConstruct(assertion.pattern);
      if (staticUnsafe) {
        throw new PromptStoreError(staticUnsafe, 'unsafe_pattern', 422);
      }

      const workerCheck = await validatePatternRule({
        id: `eval-${idx}`,
        name: `assertion-${idx + 1}`,
        pattern: assertion.pattern,
        flags,
      });
      if (!workerCheck.ok) {
        throw new PromptStoreError(workerCheck.reason, workerCheck.code, 422);
      }

      return {
        type: 'regex',
        pattern: assertion.pattern,
        ...(flags ? { flags } : {}),
      };
    }

    case 'json_schema': {
      if (!isPlainObject(assertion.schema)) {
        throw new PromptStoreError(
          `Assertion #${idx + 1} (json_schema) schema must be a JSON object.`,
          'invalid_json_schema',
          422,
        );
      }
      compileJsonSchemaValidator(assertion.schema);
      return { type: 'json_schema', schema: assertion.schema };
    }

    default:
      throw new PromptStoreError(
        `Unsupported assertion type '${String(assertion.type)}' at #${idx + 1}.`,
        'validation_error',
        422,
      );
  }
}

async function validateEvalCaseInput(input: PromptEvalCaseInput): Promise<{
  title: string;
  userMessage: string;
  variables: Record<string, string>;
  assertions: EvalAssertion[];
}> {
  if (!isPlainObject(input)) {
    throw new PromptStoreError('Eval case payload must be an object.', 'validation_error', 422);
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > EVAL_CANARY_LIMITS.maxTitleChars) {
    throw new PromptStoreError(
      `Eval case title must be 1..${EVAL_CANARY_LIMITS.maxTitleChars} characters.`,
      'validation_error',
      422,
    );
  }

  const userMessage = typeof input.userMessage === 'string' ? input.userMessage.trim() : '';
  if (!userMessage || userMessage.length > EVAL_CANARY_LIMITS.maxUserMessageChars) {
    throw new PromptStoreError(
      `Eval case userMessage must be 1..${EVAL_CANARY_LIMITS.maxUserMessageChars} characters.`,
      'validation_error',
      422,
    );
  }

  const variables: Record<string, string> = {};
  if (input.variables !== undefined) {
    if (!isPlainObject(input.variables)) {
      throw new PromptStoreError('Eval case variables must be a string map.', 'validation_error', 422);
    }
    for (const [k, v] of Object.entries(input.variables)) {
      if (!PROMPT_VAR_NAME_REGEX.test(k)) {
        throw new PromptStoreError(
          `Invalid variable name '${k}' in eval case.`,
          'validation_error',
          422,
        );
      }
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        throw new PromptStoreError(
          `Variable '${k}' value must be a string, number, or boolean.`,
          'validation_error',
          422,
        );
      }
      variables[k] = sanitizeVariableValue(String(v));
    }
  }

  if (
    !Array.isArray(input.assertions) ||
    input.assertions.length === 0 ||
    input.assertions.length > EVAL_CANARY_LIMITS.maxAssertionsPerCase
  ) {
    throw new PromptStoreError(
      `Eval case must define 1..${EVAL_CANARY_LIMITS.maxAssertionsPerCase} assertions.`,
      'validation_error',
      422,
    );
  }

  const assertions: EvalAssertion[] = [];
  for (let i = 0; i < input.assertions.length; i += 1) {
    assertions.push(await validateEvalAssertion(input.assertions[i], i));
  }

  return { title, userMessage, variables, assertions };
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToEvalCase(row: EvalCaseRow): PromptEvalCase {
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    title: row.title,
    userMessage: row.user_message,
    variables: parseJsonSafe<Record<string, string>>(row.variables_json, {}),
    assertions: parseJsonSafe<EvalAssertion[]>(row.assertions_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEvalRun(row: EvalRunRow): PromptEvalRun {
  const defaultSummary: EvalVariantSummary = {
    label: row.candidate_label,
    version: row.candidate_version,
    totalCases: 0,
    passedCases: 0,
    passRate: 0,
    avgLatencyMs: 0,
    totalTokens: 0,
  };
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    model: row.model,
    baselineVersion: row.baseline_version,
    candidateVersion: row.candidate_version,
    candidateLabel: row.candidate_label,
    baselineSummary: row.baseline_summary_json
      ? parseJsonSafe<EvalVariantSummary | null>(row.baseline_summary_json, null)
      : null,
    candidateSummary: parseJsonSafe<EvalVariantSummary>(row.candidate_summary_json, defaultSummary),
    regressions: row.regressions,
    improvements: row.improvements,
    cases: parseJsonSafe<EvalCaseComparison[]>(row.cases_json, []),
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

export function listEvalCases(scope: Scope): PromptEvalCase[] {
  const norm = tryNormalizeEvalScope(scope);
  const rows = getDb()
    .prepare(
      'SELECT * FROM custom_ai_prompt_golden_cases WHERE scope_kind = ? AND scope_id = ? ORDER BY id ASC',
    )
    .all(norm.kind, norm.id) as EvalCaseRow[];
  return rows.map(rowToEvalCase);
}

export async function createEvalCase(
  scope: Scope,
  input: PromptEvalCaseInput,
): Promise<PromptEvalCase> {
  const norm = tryNormalizeEvalScope(scope);
  const valid = await validateEvalCaseInput(input);
  const db = getDb();
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const countRow = db
      .prepare(
        'SELECT COUNT(*) AS cnt FROM custom_ai_prompt_golden_cases WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as { cnt: number };

    if (countRow.cnt >= EVAL_CANARY_LIMITS.maxCasesPerScope) {
      throw new PromptStoreError(
        `Scope already has the maximum of ${EVAL_CANARY_LIMITS.maxCasesPerScope} golden eval cases.`,
        'max_eval_cases_exceeded',
        422,
      );
    }

    const res = db
      .prepare(
        `INSERT INTO custom_ai_prompt_golden_cases
           (scope_kind, scope_id, title, user_message, variables_json, assertions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        norm.kind,
        norm.id,
        valid.title,
        valid.userMessage,
        JSON.stringify(valid.variables),
        JSON.stringify(valid.assertions),
        nowIso,
        nowIso,
      );

    const created = db
      .prepare('SELECT * FROM custom_ai_prompt_golden_cases WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as EvalCaseRow;
    return rowToEvalCase(created);
  })();
}

export async function updateEvalCase(
  scope: Scope,
  caseId: number,
  input: PromptEvalCaseInput,
): Promise<PromptEvalCase> {
  const norm = tryNormalizeEvalScope(scope);
  if (!Number.isInteger(caseId) || caseId < 1) {
    throw new PromptNotFoundError('Eval case not found.');
  }
  const valid = await validateEvalCaseInput(input);
  const db = getDb();
  const nowIso = new Date().toISOString();

  const res = db
    .prepare(
      `UPDATE custom_ai_prompt_golden_cases
          SET title = ?,
              user_message = ?,
              variables_json = ?,
              assertions_json = ?,
              updated_at = ?
        WHERE id = ? AND scope_kind = ? AND scope_id = ?`,
    )
    .run(
      valid.title,
      valid.userMessage,
      JSON.stringify(valid.variables),
      JSON.stringify(valid.assertions),
      nowIso,
      caseId,
      norm.kind,
      norm.id,
    );

  if (res.changes === 0) {
    throw new PromptNotFoundError('Eval case not found.');
  }

  const updated = db
    .prepare('SELECT * FROM custom_ai_prompt_golden_cases WHERE id = ? AND scope_kind = ? AND scope_id = ?')
    .get(caseId, norm.kind, norm.id) as EvalCaseRow;
  return rowToEvalCase(updated);
}

export function deleteEvalCase(scope: Scope, caseId: number): void {
  const norm = tryNormalizeEvalScope(scope);
  if (!Number.isInteger(caseId) || caseId < 1) {
    throw new PromptNotFoundError('Eval case not found.');
  }
  const res = getDb()
    .prepare(
      'DELETE FROM custom_ai_prompt_golden_cases WHERE id = ? AND scope_kind = ? AND scope_id = ?',
    )
    .run(caseId, norm.kind, norm.id);
  if (res.changes === 0) {
    throw new PromptNotFoundError('Eval case not found.');
  }
}

export function listEvalRuns(scope: Scope, limit?: number): PromptEvalRun[] {
  const norm = tryNormalizeEvalScope(scope);
  const safeLimit = Math.min(
    EVAL_CANARY_LIMITS.maxRunsListLimit,
    Math.max(1, Math.floor(limit ?? EVAL_CANARY_LIMITS.defaultRunsListLimit)),
  );
  const rows = getDb()
    .prepare(
      `SELECT * FROM custom_ai_prompt_golden_runs
        WHERE scope_kind = ? AND scope_id = ?
        ORDER BY id DESC
        LIMIT ?`,
    )
    .all(norm.kind, norm.id, safeLimit) as EvalRunRow[];
  return rows.map(rowToEvalRun);
}

export function getEvalRun(scope: Scope, runId: number): PromptEvalRun {
  const norm = tryNormalizeEvalScope(scope);
  if (!Number.isInteger(runId) || runId < 1) {
    throw new PromptNotFoundError('Eval run not found.');
  }
  const row = getDb()
    .prepare(
      'SELECT * FROM custom_ai_prompt_golden_runs WHERE id = ? AND scope_kind = ? AND scope_id = ?',
    )
    .get(runId, norm.kind, norm.id) as EvalRunRow | undefined;
  if (!row) {
    throw new PromptNotFoundError('Eval run not found.');
  }
  return rowToEvalRun(row);
}

function parseJsonCandidate(reply: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = reply.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (fenced?.[1]) {
      try {
        return { ok: true, value: JSON.parse(fenced[1].trim()) };
      } catch {
        return { ok: false };
      }
    }
    return { ok: false };
  }
}

export async function gradeEvalAssertion(
  reply: string,
  assertion: EvalAssertion,
): Promise<EvalAssertionResult> {
  switch (assertion.type) {
    case 'contains': {
      const passed =
        assertion.caseSensitive === false
          ? reply.toLowerCase().includes(assertion.value.toLowerCase())
          : reply.includes(assertion.value);
      return {
        assertion,
        passed,
        ...(passed ? {} : { detail: `Expected reply to contain "${assertion.value}".` }),
      };
    }

    case 'not_contains': {
      const found =
        assertion.caseSensitive === false
          ? reply.toLowerCase().includes(assertion.value.toLowerCase())
          : reply.includes(assertion.value);
      const passed = !found;
      return {
        assertion,
        passed,
        ...(passed ? {} : { detail: `Reply contained forbidden substring "${assertion.value}".` }),
      };
    }

    case 'max_chars': {
      const passed = reply.length <= assertion.limit;
      return {
        assertion,
        passed,
        ...(passed
          ? {}
          : { detail: `Reply length ${reply.length} exceeded limit ${assertion.limit}.` }),
      };
    }

    case 'regex': {
      const staticUnsafe = hasUnsafeEvalRegexConstruct(assertion.pattern);
      if (staticUnsafe) {
        return { assertion, passed: false, detail: staticUnsafe };
      }
      const res = await evaluatePatternInWorker({
        id: 'eval-regex',
        name: 'eval-regex',
        pattern: assertion.pattern,
        flags: assertion.flags ?? '',
      }, reply);
      if (res.timedOut) {
        return {
          assertion,
          passed: false,
          detail: 'Regex evaluation exceeded safe execution budget.',
        };
      }
      return {
        assertion,
        passed: res.matched,
        ...(res.matched ? {} : { detail: `Reply did not match /${assertion.pattern}/${assertion.flags ?? ''}.` }),
      };
    }

    case 'json_schema': {
      const parsed = parseJsonCandidate(reply);
      if (!parsed.ok) {
        return { assertion, passed: false, detail: 'Reply is not valid JSON.' };
      }
      let validator: ValidateFunction;
      try {
        validator = compileJsonSchemaValidator(assertion.schema);
      } catch (err) {
        return {
          assertion,
          passed: false,
          detail: err instanceof Error ? err.message : 'Invalid JSON schema.',
        };
      }
      const ok = Boolean(validator(parsed.value));
      if (ok) {
        return { assertion, passed: true };
      }
      const firstErr = validator.errors?.[0];
      const pathStr = firstErr?.instancePath || '/';
      return {
        assertion,
        passed: false,
        detail: `JSON schema validation failed at ${pathStr}: ${firstErr?.message ?? 'invalid value'}.`,
      };
    }
  }
}

function resolveEvalScopeDisplayName(db: Db, scope: Scope): string {
  try {
    if (scope.kind === 'profile') {
      const row = db
        .prepare('SELECT name FROM client_profiles WHERE id = ?')
        .get(Number(scope.id)) as { name?: string } | undefined;
      if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim();
    } else if (scope.kind === 'support_tenant') {
      const hasTenants = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'x_support_tenants'")
        .get();
      if (hasTenants) {
        const row = db
          .prepare('SELECT name FROM x_support_tenants WHERE id = ?')
          .get(Number(scope.id)) as { name?: string } | undefined;
        if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim();
      }
    }
  } catch {
    /* fallback to scope id */
  }
  return scope.id;
}

function extractGatewayReplyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}

async function evaluateSingleVariantCase(opts: {
  promptBody: string;
  promptVariables: PromptVariable[];
  renderValues: Record<string, string>;
  evalCase: PromptEvalCase;
  model: string;
  syntheticReq: Request;
  signal: AbortSignal;
  gatewayCaller: EvalGatewayCaller;
}): Promise<EvalVariantCaseOutcome> {
  const { rendered } = renderWith(opts.promptBody, opts.renderValues, opts.promptVariables);
  const messages =
    rendered.trim().length > 0
      ? [
          { role: 'system' as const, content: rendered },
          { role: 'user' as const, content: opts.evalCase.userMessage },
        ]
      : [{ role: 'user' as const, content: opts.evalCase.userMessage }];

  const t0 = performance.now();
  try {
    const gw = await opts.gatewayCaller(opts.syntheticReq, {
      messages,
      model: opts.model,
      skipEnrichment: false,
      depth: 0,
      signal: opts.signal,
    });
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const reply = extractGatewayReplyText(gw.message.content);

    const assertionResults: EvalAssertionResult[] = [];
    for (const assertion of opts.evalCase.assertions) {
      assertionResults.push(await gradeEvalAssertion(reply, assertion));
    }
    const passed = assertionResults.every((r) => r.passed);

    return {
      reply,
      renderedPrompt: rendered,
      passed,
      latencyMs,
      usage: {
        promptTokens: gw.usage.prompt_tokens ?? 0,
        completionTokens: gw.usage.completion_tokens ?? 0,
        totalTokens: gw.usage.total_tokens ?? 0,
      },
      assertionResults,
    };
  } catch (err) {
    if (opts.signal.aborted || (err instanceof GatewayCallError && err.status === 499)) {
      throw err;
    }
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const errMsg = err instanceof Error ? err.message : 'Model execution failed.';
    return {
      reply: '',
      renderedPrompt: rendered,
      passed: false,
      latencyMs,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      assertionResults: opts.evalCase.assertions.map((assertion) => ({
        assertion,
        passed: false,
        detail: errMsg,
      })),
      error: errMsg,
    };
  }
}

function summarizeOutcomes(
  label: 'published' | 'draft' | 'version',
  version: number,
  outcomes: readonly EvalVariantCaseOutcome[],
): EvalVariantSummary {
  const totalCases = outcomes.length;
  const passedCases = outcomes.filter((o) => o.passed).length;
  const passRate = totalCases > 0 ? Number((passedCases / totalCases).toFixed(4)) : 0;
  const totalLatency = outcomes.reduce((sum, o) => sum + o.latencyMs, 0);
  const avgLatencyMs = totalCases > 0 ? Math.round(totalLatency / totalCases) : 0;
  const totalTokens = outcomes.reduce((sum, o) => sum + o.usage.totalTokens, 0);

  return {
    label,
    version,
    totalCases,
    passedCases,
    passRate,
    avgLatencyMs,
    totalTokens,
  };
}

function pruneEvalRuns(db: Db, norm: Scope): void {
  const countRow = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM custom_ai_prompt_golden_runs WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as { cnt: number };
  const excess = countRow.cnt - EVAL_CANARY_LIMITS.maxRunsRetainedPerScope;
  if (excess <= 0) return;

  db.prepare(
    `DELETE FROM custom_ai_prompt_golden_runs
      WHERE id IN (
        SELECT id
          FROM custom_ai_prompt_golden_runs
         WHERE scope_kind = ? AND scope_id = ?
         ORDER BY id ASC
         LIMIT ?
      )`,
  ).run(norm.kind, norm.id, excess);
}

/**
 * Executes the scope's golden dataset against `candidate` (`draft` or target version)
 * and compares pass rate, latency, token usage, and per-case regressions against
 * `baseline` (`published` or explicit version) via `callGateway`.
 */
export async function runPromptEvaluation(
  scope: Scope,
  request: RunPromptEvalRequest,
  opts: {
    req?: Request;
    actorId: number | null;
    signal?: AbortSignal;
    callGatewayFn?: EvalGatewayCaller;
  },
): Promise<PromptEvalRun> {
  const norm = tryNormalizeEvalScope(scope);
  if (!isPillarEnabled('prompts')) {
    throw new PromptStoreError('Prompts pillar is disabled.', 'pillar_disabled', 409);
  }

  const state = getPromptScopeState(norm);

  let candidate: { version: number; body: string; variables: PromptVariable[] };
  let candidateLabel: 'draft' | 'version';
  if (request.candidateVersion !== undefined) {
    const found = getPromptVersion(norm, request.candidateVersion);
    candidate = { version: found.version, body: found.body, variables: found.variables };
    candidateLabel = state.head.draftVersion === found.version ? 'draft' : 'version';
  } else if (state.draft) {
    candidate = {
      version: state.draft.version,
      body: state.draft.body,
      variables: state.draft.variables,
    };
    candidateLabel = 'draft';
  } else {
    throw new PromptStoreError(
      'No draft version exists to evaluate; save a draft or specify candidateVersion.',
      'no_draft',
      409,
    );
  }

  let baseline: { version: number; body: string; variables: PromptVariable[] } | null = null;
  if (request.baselineVersion === null) {
    baseline = null;
  } else if (request.baselineVersion !== undefined) {
    const found = getPromptVersion(norm, request.baselineVersion);
    baseline = { version: found.version, body: found.body, variables: found.variables };
  } else if (state.published && state.published.version !== candidate.version) {
    baseline = {
      version: state.published.version,
      body: state.published.body,
      variables: state.published.variables,
    };
  }

  const allCases = listEvalCases(norm);
  const selectedCases =
    request.caseIds && request.caseIds.length > 0
      ? allCases.filter((c) => request.caseIds!.includes(c.id))
      : allCases;

  if (selectedCases.length === 0) {
    throw new PromptStoreError(
      'Add at least one golden eval case before running an evaluation.',
      'no_eval_cases',
      422,
    );
  }

  const db = getDb();
  const displayName = sanitizeVariableValue(resolveEvalScopeDisplayName(db, norm));
  const model = request.model?.trim() || 'auto';
  const signal = opts.signal ?? new AbortController().signal;
  const gatewayCaller = opts.callGatewayFn ?? callGateway;

  const syntheticReq = {
    headers: {
      authorization: `Bearer ${getInternalLoopbackToken()}`,
    },
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    body: {},
    socket: {
      localAddress: opts.req?.socket?.localAddress ?? '127.0.0.1',
      localPort: opts.req?.socket?.localPort ?? 80,
    },
  } as unknown as Request;

  const baselineOutcomes: EvalVariantCaseOutcome[] = [];
  const candidateOutcomes: EvalVariantCaseOutcome[] = [];
  const comparisons: EvalCaseComparison[] = [];
  let regressions = 0;
  let improvements = 0;

  for (const evalCase of selectedCases) {
    const renderValues: Record<string, string> = {
      date: new Date().toISOString().slice(0, 10),
      ...(displayName ? { profile_name: displayName } : {}),
      ...evalCase.variables,
    };

    let baseOutcome: EvalVariantCaseOutcome | null = null;
    if (baseline) {
      baseOutcome = await evaluateSingleVariantCase({
        promptBody: baseline.body,
        promptVariables: baseline.variables,
        renderValues,
        evalCase,
        model,
        syntheticReq,
        signal,
        gatewayCaller,
      });
      baselineOutcomes.push(baseOutcome);
    }

    const candOutcome = await evaluateSingleVariantCase({
      promptBody: candidate.body,
      promptVariables: candidate.variables,
      renderValues,
      evalCase,
      model,
      syntheticReq,
      signal,
      gatewayCaller,
    });
    candidateOutcomes.push(candOutcome);

    const regressed = Boolean(baseOutcome && baseOutcome.passed && !candOutcome.passed);
    const improved = Boolean(baseOutcome && !baseOutcome.passed && candOutcome.passed);
    if (regressed) regressions += 1;
    if (improved) improvements += 1;

    comparisons.push({
      caseId: evalCase.id,
      title: evalCase.title,
      userMessage: evalCase.userMessage,
      baseline: baseOutcome,
      candidate: candOutcome,
      regressed,
      improved,
      latencyDeltaMs: baseOutcome ? candOutcome.latencyMs - baseOutcome.latencyMs : null,
      tokenDelta: baseOutcome ? candOutcome.usage.totalTokens - baseOutcome.usage.totalTokens : null,
    });
  }

  const baselineSummary = baseline
    ? summarizeOutcomes('published', baseline.version, baselineOutcomes)
    : null;
  const candidateSummary = summarizeOutcomes(candidateLabel, candidate.version, candidateOutcomes);
  const nowIso = new Date().toISOString();

  return db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO custom_ai_prompt_golden_runs (
           scope_kind, scope_id, model, baseline_version, candidate_version, candidate_label,
           baseline_summary_json, candidate_summary_json, regressions, improvements,
           cases_json, actor_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        norm.kind,
        norm.id,
        model,
        baseline?.version ?? null,
        candidate.version,
        candidateLabel,
        baselineSummary ? JSON.stringify(baselineSummary) : null,
        JSON.stringify(candidateSummary),
        regressions,
        improvements,
        JSON.stringify(comparisons),
        opts.actorId,
        nowIso,
      );

    pruneEvalRuns(db, norm);

    const saved = db
      .prepare('SELECT * FROM custom_ai_prompt_golden_runs WHERE id = ?')
      .get(Number(res.lastInsertRowid)) as EvalRunRow;
    return rowToEvalRun(saved);
  })();
}
