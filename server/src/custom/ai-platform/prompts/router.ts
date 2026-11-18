import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  PROMPT_LIMITS,
  SYSTEM_PROMPT_VARIABLES,
  type PromptPreviewResponse,
  type PromptTryResponse,
  type PromptVariable,
} from '@freellmapi/shared/ai-platform-prompts.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { getDb, getUnifiedApiKey } from '../../../db/index.js';
import type { SessionUser } from '../../../services/auth.js';
import { isPillarEnabled } from '../flags.js';
import { GatewayCallError, callGateway } from '../loopback.js';
import { parseScopeParam } from '../scope.js';
import {
  createEvalCase,
  deleteEvalCase,
  listEvalCases,
  listEvalRuns,
  runPromptEvaluation,
  updateEvalCase,
  type EvalCallResult,
} from './eval.js';
import {
  PromptNotFoundError,
  PromptStoreError,
  PromptValidationError,
  RevisionConflictError,
  diffPromptVersions,
  discardDraft,
  getPromptScopeState,
  getPromptVersion,
  publish,
  restore,
  saveDraft,
  setPromptAbSplit,
} from './store.js';
import { renderWith, sanitizeVariableValue, validateTemplate } from './template.js';

class RouterPromptError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extras?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RouterPromptError';
  }
}

function getUser(req: Request): SessionUser | undefined {
  return (req as Request & { user?: SessionUser }).user;
}

function hasExactChildPermission(user: SessionUser | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (
    user.isPrimary ||
    (user.role === 'admin' && user.permissions === undefined) ||
    user.permissions?.includes('*')
  ) {
    return true;
  }
  return Boolean(user.permissions?.includes(permission));
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasExactChildPermission(getUser(req), permission)) {
      next();
      return;
    }
    res.status(403).json({
      error: {
        type: 'forbidden',
        code: 'missing_permission',
        permission,
        message: `Permission denied: '${permission}' access required.`,
      },
    });
  };
}

function parseRouteScope(req: Request): Scope {
  const kindRaw = String(req.params.scopeKind ?? '');
  const idRaw = String(req.params.scopeId ?? '');
  try {
    return parseScopeParam(kindRaw, idRaw);
  } catch (err) {
    throw new RouterPromptError(
      400,
      'invalid_scope',
      err instanceof Error ? err.message : 'Invalid scope.',
    );
  }
}

function parsePositiveInt(raw: unknown, label: string): number {
  const str = Array.isArray(raw) ? String(raw[0] ?? '') : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(str)) {
    throw new RouterPromptError(400, 'validation_error', `Invalid ${label}.`);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new RouterPromptError(400, 'validation_error', `Invalid ${label}.`);
  }
  return num;
}

function parseOptionalRevision(req: Request): number | undefined {
  const rawQuery = req.query.revision;
  const rawBody =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>).revision
      : undefined;
  const raw = rawQuery !== undefined && rawQuery !== '' ? rawQuery : rawBody;
  if (raw === undefined || raw === null || raw === '') return undefined;

  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new RouterPromptError(400, 'validation_error', 'Invalid revision.');
    }
    return raw;
  }
  const str = Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
  if (!/^\d+$/.test(str)) {
    throw new RouterPromptError(400, 'validation_error', 'Invalid revision.');
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new RouterPromptError(400, 'validation_error', 'Invalid revision.');
  }
  return num;
}

function resolveScopeDisplayName(scope: Scope): string {
  try {
    const db = getDb();
    if (scope.kind === 'profile') {
      const row = db
        .prepare('SELECT name FROM client_profiles WHERE id = ?')
        .get(Number(scope.id)) as { name?: string } | undefined;
      if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim();
    } else if (scope.kind === 'support_tenant') {
      const table = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'x_support_tenants'")
        .get();
      if (table) {
        const row = db
          .prepare('SELECT name FROM x_support_tenants WHERE id = ?')
          .get(Number(scope.id)) as { name?: string } | undefined;
        if (typeof row?.name === 'string' && row.name.trim()) return row.name.trim();
      }
    }
  } catch {
    /* ignore lookup errors and fall back to scope id */
  }
  return scope.id;
}

function buildRenderValues(
  scope: Scope,
  explicitValues?: Record<string, string | number | boolean>,
): Record<string, string> {
  const scopeName = sanitizeVariableValue(resolveScopeDisplayName(scope));
  const out: Record<string, string> = {
    date: new Date().toISOString().slice(0, 10),
    ...(scopeName ? { profile_name: scopeName } : {}),
  };
  if (explicitValues) {
    for (const [k, v] of Object.entries(explicitValues)) {
      const s = sanitizeVariableValue(String(v));
      if (s.length > 0) {
        out[k] = s;
      }
    }
  }
  return out;
}

function extractReplyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (
        block &&
        typeof block === 'object' &&
        'text' in block &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        return (block as { text: string }).text;
      }
      return '';
    })
    .join('');
}

function sendPromptsError(res: Response, err: unknown): void {
  if (err instanceof RouterPromptError) {
    const errorType =
      err.status === 404
        ? 'not_found'
        : err.status === 409
          ? 'conflict'
          : 'invalid_request_error';
    res.status(err.status).json({
      error: {
        type: errorType,
        code: err.code,
        message: err.message,
        ...(err.extras ?? {}),
      },
      ...(err.extras ?? {}),
    });
    return;
  }

  if (err instanceof RevisionConflictError) {
    res.status(409).json({
      error: {
        type: 'conflict',
        code: 'revision_conflict',
        message: err.message,
        current: err.current,
      },
    });
    return;
  }

  if (err instanceof PromptValidationError) {
    res.status(422).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_template',
        message: err.message,
        line: err.line,
        column: err.column,
        reason: err.reason,
      },
      line: err.line,
      column: err.column,
      reason: err.reason,
    });
    return;
  }

  if (err instanceof PromptNotFoundError) {
    res.status(404).json({
      error: {
        type: 'not_found',
        code: err.code || 'not_found',
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof PromptStoreError) {
    const errorType =
      err.status === 404
        ? 'not_found'
        : err.status === 409
          ? 'conflict'
          : 'invalid_request_error';
    res.status(err.status).json({
      error: {
        type: errorType,
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  if (err instanceof GatewayCallError) {
    const status = err.status >= 400 && err.status !== 499 ? err.status : 502;
    res.status(status).json({
      error: {
        type: 'api_error',
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'prompts_error',
      message: err instanceof Error ? err.message : 'Prompts operation failed.',
    },
  });
}

const promptVariableSchema = z
  .object({
    name: z.string().min(1).max(PROMPT_LIMITS.maxVarNameChars),
    source: z.enum(['system', 'caller', 'custom']),
    default: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();

const draftBodySchema = z
  .object({
    body: z.string().max(PROMPT_LIMITS.maxBodyChars),
    variables: z.array(promptVariableSchema).optional(),
    note: z.string().max(PROMPT_LIMITS.maxNoteChars).optional(),
    revision: z.number().int().min(0),
  })
  .strict();

const valuesMapSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const previewBodySchema = z
  .object({
    version: z.number().int().positive().optional(),
    body: z.string().max(PROMPT_LIMITS.maxBodyChars).optional(),
    variables: z.array(promptVariableSchema).optional(),
    values: valuesMapSchema.optional(),
  })
  .strict();

const tryBodySchema = z
  .object({
    version: z.number().int().positive().optional(),
    body: z.string().max(PROMPT_LIMITS.maxBodyChars).optional(),
    variables: z.array(promptVariableSchema).optional(),
    values: valuesMapSchema.optional(),
    message: z.string().trim().min(1).max(PROMPT_LIMITS.maxTryMessageChars),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const publishBodySchema = z
  .object({
    revision: z.number().int().min(0),
  })
  .strict();

const restoreBodySchema = z
  .object({
    version: z.number().int().positive(),
    revision: z.number().int().min(0),
  })
  .strict();

const abBodySchema = z
  .object({
    abDraftWeightPct: z.number().int().min(0).max(100),
    revision: z.number().int().min(0),
  })
  .strict();

const evalCaseBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    userMessage: z.string().trim().min(1).max(PROMPT_LIMITS.maxTryMessageChars),
    variables: z.record(z.string(), z.string()).optional(),
    mustContain: z.array(z.string()).max(20).optional(),
    mustNotContain: z.array(z.string()).max(20).optional(),
    expectedRegex: z.string().max(PROMPT_LIMITS.maxEvalRegexChars).nullable().optional(),
    judgeRubric: z.string().max(PROMPT_LIMITS.maxEvalRubricChars).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const evalCaseUpdateSchema = evalCaseBodySchema.partial().strict();

const evaluateBodySchema = z
  .object({
    model: z.string().trim().min(1).max(200).optional(),
    useJudge: z.boolean().optional(),
    caseIds: z.array(z.number().int().positive()).max(PROMPT_LIMITS.maxEvalCasesPerRun).optional(),
    candidateBody: z.string().max(PROMPT_LIMITS.maxBodyChars).optional(),
    candidateVariables: z.array(promptVariableSchema).optional(),
  })
  .strict();

function attachDisconnectAbort(res: Response): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const cleanup = () => {
    res.off('close', onClose);
    res.off('finish', cleanup);
  };
  const onClose = () => {
    if (!res.writableFinished) ac.abort();
    cleanup();
  };
  res.once('close', onClose);
  res.once('finish', cleanup);
  return { signal: ac.signal, cleanup };
}

async function callPromptModel(
  req: Request,
  args: {
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    model?: string;
    signal?: AbortSignal;
  },
): Promise<EvalCallResult> {
  // Synthetic loopback request authenticated ONLY with unified key (never client profile key),
  // so test/eval runs never touch client_profiles quotas or request/token usage tables.
  const syntheticReq = {
    headers: {
      authorization: `Bearer ${getUnifiedApiKey()}`,
    },
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
    path: '/v1/chat/completions',
    query: {},
    body: {},
    socket: {
      localAddress: req.socket?.localAddress ?? '127.0.0.1',
      localPort: req.socket?.localPort ?? 80,
    },
  } as unknown as Request;

  const startedAt = Date.now();
  const gwResult = await callGateway(syntheticReq, {
    messages: args.messages,
    model: args.model ?? 'auto',
    skipEnrichment: false,
    depth: 0,
    signal: args.signal ?? new AbortController().signal,
  });

  return {
    reply: extractReplyText(gwResult.message.content),
    model: gwResult.servedModel,
    promptTokens: gwResult.usage.prompt_tokens ?? 0,
    completionTokens: gwResult.usage.completion_tokens ?? 0,
    totalTokens: gwResult.usage.total_tokens ?? 0,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function resolveTemplateTarget(
  scope: Scope,
  input: { version?: number; body?: string; variables?: PromptVariable[] },
  allowFallbackToScopeState: boolean,
): { body: string; variables: PromptVariable[] } {
  if (input.version !== undefined) {
    const found = getPromptVersion(scope, input.version);
    return { body: found.body, variables: found.variables };
  }
  if (input.body !== undefined) {
    const variables = input.variables ?? [];
    const check = validateTemplate(input.body, variables);
    if (!check.ok) {
      throw new RouterPromptError(422, 'invalid_template', check.reason, {
        line: check.line,
        column: check.column,
        reason: check.reason,
      });
    }
    return { body: input.body, variables };
  }
  if (allowFallbackToScopeState) {
    const state = getPromptScopeState(scope);
    const active = state.draft ?? state.published;
    if (active) {
      return { body: active.body, variables: active.variables };
    }
    return { body: '', variables: [] };
  }
  throw new RouterPromptError(
    400,
    'validation_error',
    'Either version or body must be provided for preview.',
  );
}

export const promptsAdminRouter = Router();

// Static catalog route MUST be registered before dynamic /:scopeKind/:scopeId routes.
promptsAdminRouter.get('/prompts/variables', requirePerm('view_prompts'), (_req, res) => {
  res.json({ variables: SYSTEM_PROMPT_VARIABLES });
});

promptsAdminRouter.get(
  '/prompts/:scopeKind/:scopeId',
  requirePerm('view_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      res.json(getPromptScopeState(scope));
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.get(
  '/prompts/:scopeKind/:scopeId/versions/:version',
  requirePerm('view_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const version = parsePositiveInt(req.params.version, 'version');
      res.json({ version: getPromptVersion(scope, version) });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.get(
  '/prompts/:scopeKind/:scopeId/diff',
  requirePerm('view_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const fromVersion = parsePositiveInt(req.query.from, 'from version');
      const toVersion = parsePositiveInt(req.query.to, 'to version');
      res.json(diffPromptVersions(scope, fromVersion, toVersion));
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.put(
  '/prompts/:scopeKind/:scopeId/draft',
  requirePerm('edit_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = draftBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid draft payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const user = getUser(req);
      const saved = saveDraft(scope, parsed.data, user?.userId ?? null);
      const state = getPromptScopeState(scope);
      res.json({ version: saved, head: state.head });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.delete(
  '/prompts/:scopeKind/:scopeId/draft',
  requirePerm('edit_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const revision = parseOptionalRevision(req);
      const head = discardDraft(scope, revision);
      res.json({ head });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/preview',
  requirePerm('edit_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = previewBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid preview payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const target = resolveTemplateTarget(scope, parsed.data, false);
      const values = buildRenderValues(scope, parsed.data.values);
      const result: PromptPreviewResponse = renderWith(target.body, values, target.variables);
      res.json(result);
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/try',
  requirePerm('edit_prompts'),
  async (req, res) => {
    const { signal, cleanup } = attachDisconnectAbort(res);

    try {
      const scope = parseRouteScope(req);
      if (!isPillarEnabled('prompts')) {
        throw new RouterPromptError(409, 'pillar_disabled', 'Prompts pillar is disabled.');
      }

      const parsed = tryBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid try payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }

      const target = resolveTemplateTarget(scope, parsed.data, true);
      const values = buildRenderValues(scope, parsed.data.values);
      const { rendered, missing } = renderWith(target.body, values, target.variables);

      const messages =
        rendered.trim().length > 0
          ? [
              { role: 'system' as const, content: rendered },
              { role: 'user' as const, content: parsed.data.message },
            ]
          : [{ role: 'user' as const, content: parsed.data.message }];

      const callRes = await callPromptModel(req, {
        messages,
        model: parsed.data.model,
        signal,
      });

      const response: PromptTryResponse = {
        reply: callRes.reply,
        rendered,
        missing,
        model: callRes.model,
        usage: {
          prompt_tokens: callRes.promptTokens,
          completion_tokens: callRes.completionTokens,
          total_tokens: callRes.totalTokens,
        },
      };
      res.json(response);
    } catch (err) {
      sendPromptsError(res, err);
    } finally {
      cleanup();
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/publish',
  requirePerm('publish_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = publishBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid publish payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const user = getUser(req);
      const head = publish(scope, parsed.data.revision, user?.userId ?? null);
      res.json({ head });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/restore',
  requirePerm('publish_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = restoreBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid restore payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const user = getUser(req);
      const head = restore(scope, parsed.data.version, parsed.data.revision, user?.userId ?? null);
      res.json({ head });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.put(
  '/prompts/:scopeKind/:scopeId/ab',
  requirePerm('publish_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = abBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid A/B rollout payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const head = setPromptAbSplit(scope, parsed.data.abDraftWeightPct, parsed.data.revision);
      res.json({ head });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.get(
  '/prompts/:scopeKind/:scopeId/eval-cases',
  requirePerm('view_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      res.json({ cases: listEvalCases(scope) });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/eval-cases',
  requirePerm('edit_prompts'),
  async (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = evalCaseBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid eval case payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const created = await createEvalCase(scope, parsed.data);
      res.status(201).json({ case: created });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.put(
  '/prompts/:scopeKind/:scopeId/eval-cases/:caseId',
  requirePerm('edit_prompts'),
  async (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const caseId = parsePositiveInt(req.params.caseId, 'eval case id');
      const parsed = evalCaseUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid eval case payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const updated = await updateEvalCase(scope, caseId, parsed.data);
      res.json({ case: updated });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.delete(
  '/prompts/:scopeKind/:scopeId/eval-cases/:caseId',
  requirePerm('edit_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const caseId = parsePositiveInt(req.params.caseId, 'eval case id');
      const deleted = deleteEvalCase(scope, caseId);
      res.json({ deleted });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.get(
  '/prompts/:scopeKind/:scopeId/eval-runs',
  requirePerm('view_prompts'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const limitRaw = req.query.limit;
      const limit =
        limitRaw !== undefined && limitRaw !== ''
          ? parsePositiveInt(limitRaw, 'limit')
          : undefined;
      res.json({ runs: listEvalRuns(scope, limit) });
    } catch (err) {
      sendPromptsError(res, err);
    }
  },
);

promptsAdminRouter.post(
  '/prompts/:scopeKind/:scopeId/evaluate',
  requirePerm('edit_prompts'),
  async (req, res) => {
    const { signal, cleanup } = attachDisconnectAbort(res);
    try {
      const scope = parseRouteScope(req);
      const parsed = evaluateBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RouterPromptError(
          400,
          'validation_error',
          `Invalid evaluate payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        );
      }
      const user = getUser(req);
      const baseValues = buildRenderValues(scope);
      const run = await runPromptEvaluation(
        scope,
        parsed.data,
        baseValues,
        user?.userId ?? null,
        (args) => callPromptModel(req, args),
        signal,
      );
      res.json({ run });
    } catch (err) {
      sendPromptsError(res, err);
    } finally {
      cleanup();
    }
  },
);
