import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  OUTPUT_GUARD_LIMITS,
  type GuardDetectorId,
  type GuardEventAction,
  type GuardTestRequest,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { getDb } from '../../../db/index.js';
import type { SessionUser } from '../../../services/auth.js';
import { parseScopeParam } from '../scope.js';
import {
  getCredentialScrubSettings,
  setCredentialScrubSettings,
} from './credential-stream-scrubber.js';
import { getGuardExcerpt, listGuardEvents } from './events.js';
import { maybeRunGuardMaintenance } from './maintenance.js';
import { getPolicy, setPolicy, testPolicy } from './policy.js';
import { GuardStoreError } from './store.js';

function getUser(req: Request): SessionUser | undefined {
  return (req as Request & { user?: SessionUser }).user;
}

function hasExactChildPermission(user: SessionUser | undefined, permission: Permission): boolean {
  if (!user) return false;
  if (user.isPrimary || (user.role === 'admin' && user.permissions === undefined) || user.permissions?.includes('*')) {
    return true;
  }
  return Boolean(user.permissions?.includes(permission));
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getUser(req);
    if (hasExactChildPermission(user, permission)) {
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

function parsePositiveId(raw: string | string[] | undefined, label: string): number {
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str || !/^\d+$/.test(str)) {
    throw new GuardStoreError(`Invalid ${label} id.`, 'validation_error', 400);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new GuardStoreError(`Invalid ${label} id.`, 'validation_error', 400);
  }
  return num;
}

function parseRouteScope(req: Request) {
  const kindRaw = String(req.params.scopeKind ?? '');
  const idRaw = String(req.params.scopeId ?? '');
  try {
    return parseScopeParam(kindRaw, idRaw);
  } catch (err) {
    throw new GuardStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function sendGuardError(res: Response, err: unknown): void {
  if (err instanceof GuardStoreError) {
    const detailsObj =
      err.details && typeof err.details === 'object' && !Array.isArray(err.details)
        ? (err.details as Record<string, unknown>)
        : undefined;
    const current = detailsObj?.current;
    const errorType =
      err.status === 404
        ? 'not_found'
        : err.status === 409
          ? 'conflict'
          : err.status === 410
            ? 'gone'
            : 'invalid_request_error';
    res.status(err.status).json({
      error: {
        type: errorType,
        code: err.code,
        message: err.message,
        ...(current !== undefined ? { current } : {}),
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'output_guard_error',
      message: err instanceof Error ? err.message : 'Output guard operation failed.',
    },
  });
}

function recordExcerptViewAudit(req: Request, eventId: number): void {
  try {
    const user = getUser(req);
    if (!user) return;
    const path = req.originalUrl.split('?')[0] ?? '/api/ai-platform/output-guard/events/:id/excerpt';
    getDb()
      .prepare(
        `INSERT INTO custom_audit_log
          (created_at, actor_id, actor_email, ip, method, path, route, area, target_id, status, summary)
         VALUES (?, ?, ?, ?, 'GET', ?, '/api/ai-platform/output-guard/events/:id/excerpt', 'ai-platform', ?, 200, ?)`,
      )
      .run(
        new Date().toISOString(),
        user.userId,
        user.email,
        (req.ip ?? '').replace(/^::ffff:/, '') || null,
        path.slice(0, 300),
        eventId,
        JSON.stringify({ eventId, action: 'view_guard_excerpt' }),
      );
  } catch {
    /* audit failure should not crash authorized read, though DB is local SQLite */
  }
}

const detectorEnum = z.enum([
  'keywords',
  'patterns',
  'promptLeak',
  'pii',
  'maxLength',
  'moderation',
  'judge',
]);

const actionEnum = z.enum(['logged', 'blocked', 'masked', 'bypassed', 'check_failed']);

const testRequestSchema = z
  .object({
    text: z.string().max(OUTPUT_GUARD_LIMITS.maxTestTextChars),
    role: z.string().trim().max(OUTPUT_GUARD_LIMITS.bypassRoleMaxChars).optional(),
    policy: z.unknown().optional(),
    includeExternal: z.boolean().optional(),
  })
  .strict();

export const outputGuardAdminRouter = Router();

// Static event routes MUST be registered before dynamic /:scopeKind/:scopeId routes
outputGuardAdminRouter.get(
  '/output-guard/events',
  requirePerm('view_output_guard'),
  (req, res) => {
    try {
      maybeRunGuardMaintenance();

      const rawDetector = typeof req.query.detector === 'string' ? req.query.detector : undefined;
      let detector: GuardDetectorId | undefined;
      if (rawDetector) {
        const parsed = detectorEnum.safeParse(rawDetector);
        if (!parsed.success) {
          throw new GuardStoreError('Invalid detector filter.', 'validation_error', 400);
        }
        detector = parsed.data;
      }

      const rawAction = typeof req.query.action === 'string' ? req.query.action : undefined;
      let action: GuardEventAction | undefined;
      if (rawAction) {
        const parsed = actionEnum.safeParse(rawAction);
        if (!parsed.success) {
          throw new GuardStoreError('Invalid action filter.', 'validation_error', 400);
        }
        action = parsed.data;
      }

      let limit: number | undefined;
      if (req.query.limit !== undefined && req.query.limit !== '') {
        const num = Number(req.query.limit);
        if (!Number.isInteger(num) || num <= 0) {
          throw new GuardStoreError('limit must be a positive integer.', 'invalid_limit', 400);
        }
        limit = num;
      }

      const result = listGuardEvents({
        scope: typeof req.query.scope === 'string' ? req.query.scope : undefined,
        detector,
        action,
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
        limit,
      });
      res.json(result);
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

outputGuardAdminRouter.get(
  '/output-guard/events/:id/excerpt',
  requirePerm('view_guard_excerpts'),
  (req, res) => {
    try {
      const id = parsePositiveId(req.params.id, 'event');
      const result = getGuardExcerpt(id);
      recordExcerptViewAudit(req, id);
      res.json(result);
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

outputGuardAdminRouter.get(
  '/output-guard/:scopeKind/:scopeId',
  requirePerm('view_output_guard'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const policy = getPolicy(scope);
      res.json({ policy });
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

outputGuardAdminRouter.put(
  '/output-guard/:scopeKind/:scopeId',
  requirePerm('edit_output_guard'),
  async (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const user = getUser(req);
      const policy = await setPolicy(scope, req.body, user?.userId ?? null);
      res.json({ policy });
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

outputGuardAdminRouter.post(
  '/output-guard/:scopeKind/:scopeId/test',
  requirePerm('view_output_guard'),
  async (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = testRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new GuardStoreError(
          `Invalid test payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
          'validation_error',
          422,
        );
      }
      const ac = new AbortController();
      req.once('close', () => ac.abort());
      const result = await testPolicy(scope, parsed.data as GuardTestRequest, {
        req,
        signal: ac.signal,
        systemPrompt: null,
        canCallGateway: false,
      });
      res.json(result);
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

const credentialScrubSchema = z
  .object({
    credentialStreamScrubEnabled: z.boolean(),
  })
  .strict();

outputGuardAdminRouter.get(
  '/output-guard/:scopeKind/:scopeId/credential-scrub',
  requirePerm('view_output_guard'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const settings = getCredentialScrubSettings(scope);
      res.json({ settings });
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);

outputGuardAdminRouter.put(
  '/output-guard/:scopeKind/:scopeId/credential-scrub',
  requirePerm('edit_output_guard'),
  (req, res) => {
    try {
      const scope = parseRouteScope(req);
      const parsed = credentialScrubSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new GuardStoreError(
          `Invalid credential scrub payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
          'validation_error',
          422,
        );
      }
      const user = getUser(req);
      const settings = setCredentialScrubSettings(scope, parsed.data, user?.userId ?? null);
      res.json({ settings });
    } catch (err) {
      sendGuardError(res, err);
    }
  },
);
