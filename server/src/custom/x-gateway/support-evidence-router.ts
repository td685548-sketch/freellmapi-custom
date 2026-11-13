import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth.js';
import type { SessionUser } from '../../services/auth.js';
import {
  EVIDENCE_POLICY_BOUNDS,
  SUPPORT_EVIDENCE_LIMITS,
  type SupportEvidenceRole,
} from '@freellmapi/shared/support-evidence.js';
import {
  getSupportEvidencePolicy,
  updateSupportEvidencePolicy,
  listSupportEvidenceSources,
  createSupportEvidenceSource,
  updateSupportEvidenceSource,
  listSupportEvidenceRevisions,
  getSupportEvidenceRevision,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  saveSupportEvidenceSuite,
  listSupportEvidenceSuites,
  getSupportEvidenceSuite,
  listSupportEvidenceRuns,
  getSupportEvidenceRun,
  SupportEvidenceError,
} from './support-evidence-store.js';
import { retrieveSupportEvidence } from './support-evidence-retrieval.js';
import { runSupportEvidenceSuite } from './support-evidence-evaluations.js';
import { SupportStoreError, type SupportTenant } from './support-store.js';
import { resolveTenant } from './support-router.js';
import { getSupportRuntimePolicy } from './support-runtime-store.js';
import { maskSupportSensitiveText } from './support-knowledge.js';

export const xSupportEvidenceConsoleRouter = Router();

function paramStr(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] ?? '' : val ?? '';
}

function hasEditorAccess(user: SessionUser | undefined): boolean {
  if (!user) return false;
  if (
    user.isPrimary ||
    user.role === 'admin' ||
    user.permissions?.includes('*') ||
    user.permissions?.includes('manage_x_gateway')
  ) {
    return true;
  }
  const hasGateway = Boolean(user.permissions?.includes('use_x_gateway'));
  const hasEdit = Boolean(user.permissions?.includes('edit_x_settings'));
  return hasGateway && hasEdit;
}

xSupportEvidenceConsoleRouter.use('/tenants/:id/knowledge-library', requireAuth);
xSupportEvidenceConsoleRouter.use(
  '/tenants/:id/knowledge-library',
  (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!hasEditorAccess(user)) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: "Permission denied: 'use_x_gateway' and 'edit_x_settings' permissions required.",
        },
      });
      return;
    }
    next();
  },
);

function resolveKnowledgeTenant(req: Request, res: Response): SupportTenant | null {
  try {
    return resolveTenant(paramStr(req.params.id));
  } catch (err) {
    const status = err instanceof SupportStoreError ? err.status : 404;
    res.status(status === 400 ? 400 : 404).json({
      error: {
        code: status === 400 ? 'invalid_input' : 'knowledge_source_not_found',
        message: err instanceof Error ? err.message : 'Support tenant not found.',
      },
    });
    return null;
  }
}

function sendEvidenceError(res: Response, err: unknown, fallbackMessage: string): void {
  if (err instanceof SupportEvidenceError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof SupportStoreError) {
    res.status(err.status).json({
      error: {
        code: err.status === 404 ? 'knowledge_source_not_found' : 'invalid_input',
        message: err.message,
      },
    });
    return;
  }
  const maybeErr = err as { status?: unknown; code?: unknown; message?: unknown };
  if (
    typeof maybeErr?.status === 'number' &&
    typeof maybeErr?.code === 'string' &&
    typeof maybeErr?.message === 'string'
  ) {
    res.status(maybeErr.status).json({
      error: { code: maybeErr.code, message: maybeErr.message },
    });
    return;
  }
  res.status(500).json({ error: { code: 'internal_error', message: fallbackMessage } });
}

function parseBody<T>(schema: z.ZodType<T>, input: unknown, res: Response): T | null {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    res.status(400).json({
      error: {
        code: 'invalid_input',
        message: issue ? `Invalid input: ${issue.path.join('.') || 'body'} ${issue.message}` : 'Invalid input.',
      },
    });
    return null;
  }
  return result.data;
}

const roleSchema = z.enum(['guest', 'customer', 'staff', 'admin']);
const sourceKindSchema = z.enum(['text', 'markdown', 'faq_json', 'url']);
const sourceStatusSchema = z.enum(['active', 'archived']);
const revisionFormatSchema = z.enum(['text', 'markdown', 'faq_json']);

const createSourceSchema = z
  .object({
    name: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars),
    kind: sourceKindSchema,
    allowedRoles: z.array(roleSchema).min(1).max(4).optional(),
  })
  .strict();

const updateSourceSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars).optional(),
    allowedRoles: z.array(roleSchema).min(1).max(4).optional(),
    status: sourceStatusSchema.optional(),
  })
  .strict();

const importRevisionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxTitleChars),
    category: z.string().trim().max(SUPPORT_EVIDENCE_LIMITS.maxCategoryChars).optional(),
    tags: z
      .array(z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxTagChars))
      .max(SUPPORT_EVIDENCE_LIMITS.maxTagsCount)
      .optional(),
    format: revisionFormatSchema,
    content: z.string().optional(),
    url: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine((v) => (v.content !== undefined) !== (v.url !== undefined), {
    message: 'Provide exactly one of content or url.',
  });

const publishRevisionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    revisionId: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxIdChars),
  })
  .strict();

const updatePolicySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    mode: z.enum(['off', 'required']).optional(),
    includeLegacyDocs: z.boolean().optional(),
    topK: z
      .number()
      .int()
      .min(EVIDENCE_POLICY_BOUNDS.topK.min)
      .max(EVIDENCE_POLICY_BOUNDS.topK.max)
      .optional(),
    minCoverage: z
      .number()
      .min(EVIDENCE_POLICY_BOUNDS.minCoverage.min)
      .max(EVIDENCE_POLICY_BOUNDS.minCoverage.max)
      .optional(),
    maxEvidenceChars: z
      .number()
      .int()
      .min(EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.min)
      .max(EVIDENCE_POLICY_BOUNDS.maxEvidenceChars.max)
      .optional(),
  })
  .strict();

const previewSchema = z
  .object({
    query: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxConsoleQueryChars),
    role: roleSchema,
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    query: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxConsoleQueryChars),
    role: roleSchema,
    expectedSourceIds: z
      .array(z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxIdChars))
      .max(SUPPORT_EVIDENCE_LIMITS.maxExpectedSourceIdsPerCase),
    forbiddenSourceIds: z
      .array(z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxIdChars))
      .max(SUPPORT_EVIDENCE_LIMITS.maxForbiddenSourceIdsPerCase),
    expectAbstention: z.boolean(),
  })
  .strict();

const createSuiteSchema = z
  .object({
    name: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars),
    cases: z.array(caseSchema).min(1).max(SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite),
  })
  .strict();

const updateSuiteSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    name: z.string().trim().min(1).max(SUPPORT_EVIDENCE_LIMITS.maxSourceNameChars),
    cases: z.array(caseSchema).min(1).max(SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite),
  })
  .strict();

// ---------------------------------------------------------------------------
// Sources & Revisions
// ---------------------------------------------------------------------------

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/sources',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const sources = listSupportEvidenceSources(tenant.id);
      res.json({ ok: true, sources });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to list knowledge sources.');
    }
  },
);

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/sources',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(createSourceSchema, req.body, res);
    if (!body) return;
    try {
      const source = createSupportEvidenceSource(tenant.id, body);
      res.status(201).json({ ok: true, source });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to create knowledge source.');
    }
  },
);

xSupportEvidenceConsoleRouter.patch(
  '/tenants/:id/knowledge-library/sources/:sourceId',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(updateSourceSchema, req.body, res);
    if (!body) return;
    const { expectedVersion, ...patch } = body;
    try {
      const source = updateSupportEvidenceSource(
        tenant.id,
        paramStr(req.params.sourceId),
        patch,
        expectedVersion,
      );
      res.json({ ok: true, source });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to update knowledge source.');
    }
  },
);

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/sources/:sourceId/revisions',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const revisions = listSupportEvidenceRevisions(tenant.id, paramStr(req.params.sourceId));
      res.json({ ok: true, revisions });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to list source revisions.');
    }
  },
);

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/sources/:sourceId/revisions/:revisionId',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const revision = getSupportEvidenceRevision(
        tenant.id,
        paramStr(req.params.sourceId),
        paramStr(req.params.revisionId),
      );
      res.json({ ok: true, revision });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to read source revision.');
    }
  },
);

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/sources/:sourceId/revisions',
  async (req: Request, res: Response): Promise<void> => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(importRevisionSchema, req.body, res);
    if (!body) return;

    const ac = new AbortController();
    const onDisconnect = (): void => {
      if (!res.writableEnded) ac.abort();
    };
    req.on('aborted', onDisconnect);
    res.on('close', onDisconnect);

    try {
      const result = await importSupportEvidenceRevision({
        tenantId: tenant.id,
        sourceId: paramStr(req.params.sourceId),
        expectedVersion: body.expectedVersion,
        title: body.title,
        category: body.category,
        tags: body.tags,
        format: body.format,
        content: body.content,
        url: body.url,
        signal: ac.signal,
      });
      if (ac.signal.aborted || res.writableEnded) return;
      res.status(result.deduplicated ? 200 : 201).json({
        ok: true,
        source: result.source,
        revision: result.revision,
        deduplicated: result.deduplicated,
      });
    } catch (err) {
      if (!res.headersSent && !res.writableEnded) {
        sendEvidenceError(res, err, 'Failed to import source revision.');
      }
    } finally {
      req.off('aborted', onDisconnect);
      res.off('close', onDisconnect);
    }
  },
);

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/sources/:sourceId/publish',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(publishRevisionSchema, req.body, res);
    if (!body) return;
    try {
      const source = publishSupportEvidenceRevision(
        tenant.id,
        paramStr(req.params.sourceId),
        body.revisionId,
        body.expectedVersion,
      );
      res.json({ ok: true, source });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to publish source revision.');
    }
  },
);

// ---------------------------------------------------------------------------
// Policy & Retrieval Preview
// ---------------------------------------------------------------------------

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/policy',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const policy = getSupportEvidencePolicy(tenant.id);
      res.json({ ok: true, policy });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to load evidence policy.');
    }
  },
);

xSupportEvidenceConsoleRouter.put(
  '/tenants/:id/knowledge-library/policy',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(updatePolicySchema, req.body, res);
    if (!body) return;
    const { expectedVersion, ...patch } = body;
    try {
      const policy = updateSupportEvidencePolicy(tenant.id, patch, expectedVersion);
      res.json({ ok: true, policy });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to update evidence policy.');
    }
  },
);

function clipMaskedExcerpt(tenantId: number, text: string, role: SupportEvidenceRole): string {
  const masked = maskSupportSensitiveText(String(tenantId), text, role).masked;
  const max = SUPPORT_EVIDENCE_LIMITS.maxExcerptChars;
  if (masked.length <= max) return masked;
  return masked.slice(0, max);
}

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/preview',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(previewSchema, req.body, res);
    if (!body) return;
    try {
      const policy = getSupportEvidencePolicy(tenant.id);
      const runtimePolicy = getSupportRuntimePolicy(tenant.id);
      const pack = retrieveSupportEvidence({
        tenantId: tenant.id,
        role: body.role,
        query: body.query,
        policy,
        maxContextChars: runtimePolicy.maxContextChars,
      });
      const candidates = pack.candidates.map((c) => ({
        id: c.citationId,
        sourceId: c.sourceId,
        revisionId: c.revisionId,
        title: maskSupportSensitiveText(String(tenant.id), c.title, body.role).masked,
        startLine: c.startLine,
        endLine: c.endLine,
        excerpt: clipMaskedExcerpt(tenant.id, c.providedText, body.role),
        lexicalCoverage: c.lexicalCoverage,
        score: c.score,
      }));
      res.json({
        ok: true,
        preview: {
          snapshotId: pack.snapshotId,
          policyVersion: pack.policyVersion,
          candidates,
          contextChars: pack.contextPrompt.length,
          willAbstain: candidates.length === 0,
        },
      });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to run retrieval preview.');
    }
  },
);

// ---------------------------------------------------------------------------
// Evaluation Suites & Runs
// ---------------------------------------------------------------------------

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/suites',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const suites = listSupportEvidenceSuites(tenant.id);
      res.json({ ok: true, suites });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to list evaluation suites.');
    }
  },
);

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/suites',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(createSuiteSchema, req.body, res);
    if (!body) return;
    try {
      const suite = saveSupportEvidenceSuite(tenant.id, body);
      res.status(201).json({ ok: true, suite });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to create evaluation suite.');
    }
  },
);

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/suites/:suiteId',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const suite = getSupportEvidenceSuite(tenant.id, paramStr(req.params.suiteId));
      res.json({ ok: true, suite });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to get evaluation suite.');
    }
  },
);

xSupportEvidenceConsoleRouter.put(
  '/tenants/:id/knowledge-library/suites/:suiteId',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    const body = parseBody(updateSuiteSchema, req.body, res);
    if (!body) return;
    try {
      const suite = saveSupportEvidenceSuite(
        tenant.id,
        { id: paramStr(req.params.suiteId), name: body.name, cases: body.cases },
        body.expectedVersion,
      );
      res.json({ ok: true, suite });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to update evaluation suite.');
    }
  },
);

xSupportEvidenceConsoleRouter.post(
  '/tenants/:id/knowledge-library/suites/:suiteId/runs',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    if (
      req.body !== undefined &&
      req.body !== null &&
      (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length > 0)
    ) {
      res.status(400).json({
        error: {
          code: 'invalid_input',
          message: 'Evaluation run body must be empty.',
        },
      });
      return;
    }
    try {
      const run = runSupportEvidenceSuite({
        tenantId: tenant.id,
        suiteId: paramStr(req.params.suiteId),
      });
      res.status(201).json({ ok: true, run });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to run evaluation suite.');
    }
  },
);

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/runs',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const runs = listSupportEvidenceRuns(tenant.id);
      res.json({ ok: true, runs });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to list evaluation runs.');
    }
  },
);

xSupportEvidenceConsoleRouter.get(
  '/tenants/:id/knowledge-library/runs/:runId',
  (req: Request, res: Response): void => {
    const tenant = resolveKnowledgeTenant(req, res);
    if (!tenant) return;
    try {
      const run = getSupportEvidenceRun(tenant.id, paramStr(req.params.runId));
      res.json({ ok: true, run });
    } catch (err) {
      sendEvidenceError(res, err, 'Failed to get evaluation run.');
    }
  },
);
