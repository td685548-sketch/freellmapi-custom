import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { SupportOutputPolicy } from '@freellmapi/shared/support-output.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import type { SessionUser } from '../../services/auth.js';
import { resolveTenant } from './support-router.js';
import { SupportStoreError, type SupportTenant } from './support-store.js';
import {
  getSupportOutputPolicy,
  listSupportOutputEvents,
  saveSupportOutputPolicy,
  SupportOutputError,
} from './support-output-store.js';
import { evaluateSupportOutput } from './support-output-engine.js';

export const xSupportOutputConsoleRouter = Router();

import { parseSupportOutputJson as enforceBoundedJsonBody } from './support-output-body-limit.js';
const MAX_RULES = 50;
const MIN_OUTPUT_CHARS = 256;
const MAX_OUTPUT_CHARS = 64_000;
const MAX_RULE_TEXT_CHARS = 100;
const MAX_EVENT_LIMIT = 100;
const DEFAULT_EVENT_LIMIT = 50;
const MAX_CURSOR_CHARS = 512;
const MAX_PREVIEW_RAW_CHARS = 128_000;
const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;


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

function requireOutputEditor(req: Request, res: Response, next: NextFunction): void {
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
}

function resolveOutputTenant(req: Request, res: Response): SupportTenant | null {
  try {
    return resolveTenant(paramStr(req.params.id));
  } catch (err) {
    const status = err instanceof SupportStoreError ? err.status : 404;
    res.status(status === 400 ? 400 : 404).json({
      error: {
        code: status === 400 ? 'invalid_input' : 'support_tenant_not_found',
        message: status === 400 ? 'Tenant key or slug is required.' : 'Support tenant not found.',
      },
    });
    return null;
  }
}

function sendOutputError(res: Response, err: unknown, fallbackMessage: string): void {
  if (err instanceof SupportOutputError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message },
    });
    return;
  }
  if (err instanceof SupportStoreError) {
    res.status(err.status).json({
      error: {
        code: err.status === 404 ? 'support_tenant_not_found' : 'invalid_input',
        message: err.status === 404 ? 'Support tenant not found.' : err.message,
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
    const safeMessage = maybeErr.status >= 500 ? fallbackMessage : maybeErr.message;
    res.status(maybeErr.status).json({
      error: { code: maybeErr.code, message: safeMessage },
    });
    return;
  }
  res.status(500).json({
    error: { code: 'internal_error', message: fallbackMessage },
  });
}

function normalizeRuleTerm(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const ruleSchema = z
  .object({
    id: z.string().regex(RULE_ID_RE, 'Rule id must match [A-Za-z0-9_-]{1,64}.'),
    text: z.string(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const normalized = normalizeRuleTerm(rule.text);
    if (normalized.length < 1 || normalized.length > MAX_RULE_TEXT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: `Normalized rule text must be 1..${MAX_RULE_TEXT_CHARS} code units.`,
      });
    }
  });

const policyMutableSchema = z
  .object({
    mode: z.enum(['off', 'log', 'enforce']),
    blockedTerms: z.array(ruleSchema).max(MAX_RULES),
    maxOutputChars: z.number().int().min(MIN_OUTPUT_CHARS).max(MAX_OUTPUT_CHARS),
    redactCredentials: z.boolean(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seenIds = new Set<string>();
    const seenTerms = new Set<string>();
    for (let i = 0; i < policy.blockedTerms.length; i += 1) {
      const rule = policy.blockedTerms[i]!;
      if (seenIds.has(rule.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blockedTerms', i, 'id'],
          message: 'Rule ids must be unique.',
        });
      }
      seenIds.add(rule.id);

      const normalized = normalizeRuleTerm(rule.text);
      if (seenTerms.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['blockedTerms', i, 'text'],
          message: 'Normalized blocked terms must be unique.',
        });
      }
      seenTerms.add(normalized);
    }
  });

const putPolicySchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    policy: policyMutableSchema,
  })
  .strict();

const previewPolicySchema = z
  .object({
    policy: policyMutableSchema,
    text: z.string(),
  })
  .strict();

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

function parseEventsQuery(
  query: Request['query'],
  res: Response,
): { limit: number; before?: string } | null {
  const allowedKeys = new Set(['limit', 'before']);
  for (const key of Object.keys(query)) {
    if (!allowedKeys.has(key)) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'Unexpected query parameter.' },
      });
      return null;
    }
  }

  let limit = DEFAULT_EVENT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'limit must be an integer between 1 and 100.' },
      });
      return null;
    }
    const parsedLimit = Number(query.limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_EVENT_LIMIT) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'limit must be an integer between 1 and 100.' },
      });
      return null;
    }
    limit = parsedLimit;
  }

  let before: string | undefined;
  if (query.before !== undefined) {
    if (typeof query.before !== 'string' || query.before.length === 0 || query.before.length > MAX_CURSOR_CHARS) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'before cursor is invalid.' },
      });
      return null;
    }
    before = query.before;
  }

  return before !== undefined ? { limit, before } : { limit };
}

xSupportOutputConsoleRouter.use('/tenants/:id/output-policy', requireAuth, requireOutputEditor);
xSupportOutputConsoleRouter.use('/tenants/:id/output-events', requireAuth, requireOutputEditor);

xSupportOutputConsoleRouter.get('/tenants/:id/output-policy', (req, res) => {
  const tenant = resolveOutputTenant(req, res);
  if (!tenant) return;
  try {
    const policy = getSupportOutputPolicy(tenant.id);
    res.json({ ok: true, policy });
  } catch (err) {
    sendOutputError(res, err, 'Failed to load support output policy.');
  }
});

xSupportOutputConsoleRouter.put(
  '/tenants/:id/output-policy',
  enforceBoundedJsonBody,
  (req, res) => {
    const tenant = resolveOutputTenant(req, res);
    if (!tenant) return;
    const body = parseBody(putPolicySchema, req.body, res);
    if (!body) return;
    try {
      const policy = saveSupportOutputPolicy({
        tenantId: tenant.id,
        expectedVersion: body.expectedVersion,
        policy: body.policy,
      });
      res.json({ ok: true, policy });
    } catch (err) {
      sendOutputError(res, err, 'Failed to save support output policy.');
    }
  },
);

xSupportOutputConsoleRouter.post(
  '/tenants/:id/output-policy/preview',
  enforceBoundedJsonBody,
  (req, res) => {
    const tenant = resolveOutputTenant(req, res);
    if (!tenant) return;
    const body = parseBody(previewPolicySchema, req.body, res);
    if (!body) return;

    if (body.text.length > MAX_PREVIEW_RAW_CHARS && body.policy.mode !== 'enforce') {
      res.status(503).json({
        error: {
          code: 'output_inspection_limit',
          message: 'Output preview text exceeds the inspection limit.',
        },
      });
      return;
    }

    const previewPolicy: SupportOutputPolicy = {
      tenantId: tenant.id,
      version: 0,
      mode: body.policy.mode,
      blockedTerms: body.policy.blockedTerms,
      maxOutputChars: body.policy.maxOutputChars,
      redactCredentials: body.policy.redactCredentials,
      updatedAt: '1970-01-01T00:00:00.000Z',
    };

    try {
      const decision = evaluateSupportOutput({
        policy: previewPolicy,
        leaves: [{ path: 'reply', text: body.text }],
      });
      res.json({ ok: true, decision });
    } catch (err) {
      sendOutputError(res, err, 'Failed to evaluate output preview.');
    }
  },
);

xSupportOutputConsoleRouter.get('/tenants/:id/output-events', (req, res) => {
  const tenant = resolveOutputTenant(req, res);
  if (!tenant) return;
  const query = parseEventsQuery(req.query, res);
  if (!query) return;
  try {
    const result = listSupportOutputEvents({
      tenantId: tenant.id,
      limit: query.limit,
      before: query.before,
    });
    res.json({
      ok: true,
      items: result.items,
      ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    });
  } catch (err) {
    sendOutputError(res, err, 'Failed to list support output events.');
  }
});
