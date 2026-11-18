import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  TRACING_LIMITS,
  type TraceStatus,
} from '@freellmapi/shared/ai-platform-tracing-oauth.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import { parseScopeParam } from '../scope.js';
import {
  deleteTraces,
  getTraceById,
  listTraces,
  maybePruneTraces,
} from './store.js';

const VALID_TRACE_STATUSES = new Set<TraceStatus>([
  'ok',
  'error',
  'awaiting_approval',
  'cancelled',
]);

function getUser(req: Request): SessionUser | undefined {
  return (req as Request & { user?: SessionUser }).user;
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = getUser(req);
    if (hasPermission(user, permission)) {
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

function parseScopeQuery(raw: unknown): Scope | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  const sep = trimmed.includes('/') ? '/' : trimmed.includes(':') ? ':' : null;
  if (!sep) {
    throw new Error('Invalid scope query parameter; expected <kind>:<id>.');
  }
  const idx = trimmed.indexOf(sep);
  return parseScopeParam(trimmed.slice(0, idx), trimmed.slice(idx + 1));
}

function parseLimitQuery(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    throw new Error('limit must be a positive integer.');
  }
  return Math.min(TRACING_LIMITS.maxListLimit, num);
}

export const tracingAdminRouter = Router();

tracingAdminRouter.get('/traces', requirePerm('view_ai_platform'), (req, res) => {
  try {
    const scope = parseScopeQuery(req.query.scope);
    let status: TraceStatus | undefined;
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      const candidate = req.query.status.trim() as TraceStatus;
      if (!VALID_TRACE_STATUSES.has(candidate)) {
        res.status(400).json({
          error: {
            type: 'invalid_request_error',
            code: 'invalid_status',
            message: `Invalid trace status '${candidate}'.`,
          },
        });
        return;
      }
      status = candidate;
    }

    const model =
      typeof req.query.model === 'string' && req.query.model.trim()
        ? req.query.model.trim()
        : undefined;
    const threadId =
      typeof req.query.threadId === 'string' && req.query.threadId.trim()
        ? req.query.threadId.trim()
        : undefined;
    const search =
      typeof req.query.q === 'string' && req.query.q.trim()
        ? req.query.q.trim()
        : undefined;
    const before =
      typeof req.query.before === 'string' && req.query.before.trim()
        ? req.query.before.trim()
        : undefined;
    const limit = parseLimitQuery(req.query.limit);

    maybePruneTraces();
    const payload = listTraces({
      scope,
      status,
      model,
      threadId,
      search,
      before,
      limit,
    });
    res.json(payload);
  } catch (err) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_query',
        message: err instanceof Error ? err.message : 'Invalid traces query.',
      },
    });
  }
});

tracingAdminRouter.get('/traces/:traceId', requirePerm('view_ai_platform'), (req, res) => {
  try {
    const rawId = Array.isArray(req.params.traceId) ? req.params.traceId[0] : req.params.traceId;
    const traceId = typeof rawId === 'string' ? rawId.trim() : '';
    const scope = parseScopeQuery(req.query.scope);
    const trace = getTraceById(traceId, scope);
    if (!trace) {
      res.status(404).json({
        error: {
          type: 'not_found_error',
          code: 'trace_not_found',
          message: `Trace '${traceId}' not found.`,
        },
      });
      return;
    }
    res.json({ trace });
  } catch (err) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_query',
        message: err instanceof Error ? err.message : 'Invalid trace lookup request.',
      },
    });
  }
});

tracingAdminRouter.delete('/traces', requirePerm('edit_ai_flags'), (req, res) => {
  try {
    const scope = parseScopeQuery(req.query.scope);
    const before =
      typeof req.query.before === 'string' && req.query.before.trim()
        ? req.query.before.trim()
        : undefined;
    const deleted = deleteTraces({ scope, before });
    res.json({ deleted });
  } catch (err) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_query',
        message: err instanceof Error ? err.message : 'Invalid trace delete filter.',
      },
    });
  }
});
