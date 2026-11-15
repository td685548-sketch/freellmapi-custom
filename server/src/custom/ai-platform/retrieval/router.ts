import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  RETRIEVAL_LIMITS,
  type RetrievalQueryRequest,
  type RetrievalReindexResponse,
  type RetrievalScopeStatusResponse,
  type RetrievalSettingsInput,
  type Scope,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import { isPillarEnabled } from '../flags.js';
import { parseScopeParam } from '../scope.js';
import { retrieve } from './hybrid.js';
import { enqueueReindexJob, getScopeIndexSnapshot } from './indexer.js';
import {
  RetrievalStoreError,
  assertScopeExists,
  getRetrievalSettings,
  getRetrievalUsage,
  listAvailableRetrievalModels,
  setRetrievalSettings,
} from './settings.js';

function getUser(req: Request): SessionUser | undefined {
  return (req as Request & { user?: SessionUser }).user;
}

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasPermission(getUser(req), permission)) {
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
    throw new RetrievalStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function sendRetrievalError(res: Response, err: unknown): void {
  if (err instanceof RetrievalStoreError) {
    const errorType =
      err.status === 404
        ? 'not_found'
        : err.status === 409
          ? 'conflict'
          : err.status === 422
            ? 'unprocessable_entity'
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

  res.status(500).json({
    error: {
      type: 'internal_error',
      code: 'retrieval_error',
      message: err instanceof Error ? err.message : 'Retrieval operation failed.',
    },
  });
}

const queryRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(RETRIEVAL_LIMITS.maxQueryChars),
    topK: z.number().int().min(1).max(RETRIEVAL_LIMITS.maxTopK).optional(),
    minScore: z.number().finite().min(0).max(1).optional(),
    mode: z.enum(['keyword', 'semantic', 'hybrid']).optional(),
    roles: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  })
  .strict();

export const retrievalAdminRouter = Router();

// Static usage route MUST be registered before dynamic /:scopeKind/:scopeId routes.
retrievalAdminRouter.get(
  '/retrieval/usage',
  requirePerm('view_retrieval'),
  (req, res) => {
    try {
      let days = 30;
      const rawDays = req.query.days;
      if (rawDays !== undefined && rawDays !== '') {
        const str = Array.isArray(rawDays) ? String(rawDays[0] ?? '') : String(rawDays);
        if (!/^\d+$/.test(str)) {
          throw new RetrievalStoreError(
            'days must be an integer between 1 and 365.',
            'invalid_days',
            400,
          );
        }
        const n = Number(str);
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          throw new RetrievalStoreError(
            'days must be an integer between 1 and 365.',
            'invalid_days',
            400,
          );
        }
        days = n;
      }

      const rawKind = typeof req.query.scopeKind === 'string' ? req.query.scopeKind.trim() : '';
      const rawId = typeof req.query.scopeId === 'string' ? req.query.scopeId.trim() : '';
      if ((rawKind && !rawId) || (!rawKind && rawId)) {
        throw new RetrievalStoreError(
          'Both scopeKind and scopeId must be provided together.',
          'invalid_scope',
          400,
        );
      }

      let scope: Scope | undefined;
      if (rawKind && rawId) {
        try {
          scope = parseScopeParam(rawKind, rawId);
        } catch (err) {
          throw new RetrievalStoreError(
            err instanceof Error ? err.message : 'Invalid scope.',
            'invalid_scope',
            400,
          );
        }
      }

      res.json(getRetrievalUsage({ days, ...(scope ? { scope } : {}) }));
    } catch (err) {
      sendRetrievalError(res, err);
    }
  },
);

retrievalAdminRouter.get(
  '/retrieval/:scopeKind/:scopeId',
  requirePerm('view_retrieval'),
  (req, res) => {
    try {
      const scope = assertScopeExists(parseRouteScope(req));
      const settings = getRetrievalSettings(scope);
      const snapshot = getScopeIndexSnapshot(scope);
      const payload: RetrievalScopeStatusResponse = {
        scope,
        settings,
        index: snapshot.status,
        activeJob: snapshot.activeJob,
        recentJobs: snapshot.recentJobs,
        availableModels: listAvailableRetrievalModels(),
      };
      res.json(payload);
    } catch (err) {
      sendRetrievalError(res, err);
    }
  },
);

retrievalAdminRouter.put(
  '/retrieval/:scopeKind/:scopeId',
  requirePerm('edit_retrieval'),
  (req, res) => {
    try {
      const scope = assertScopeExists(parseRouteScope(req));
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new RetrievalStoreError(
          'Invalid retrieval settings body: expected JSON object.',
          'validation_error',
          400,
        );
      }
      const saved = setRetrievalSettings(scope, req.body as RetrievalSettingsInput);
      let snapshot = getScopeIndexSnapshot(scope);
      if (saved.modelOrDimsChanged) {
        enqueueReindexJob(scope, 'model_change', { throwOnActive: false });
        snapshot = getScopeIndexSnapshot(scope);
      } else if (
        saved.previousSettings.mode === 'keyword' &&
        saved.settings.mode !== 'keyword' &&
        snapshot.status.totalChunks > 0 &&
        !snapshot.status.ready
      ) {
        enqueueReindexJob(scope, 'reindex', { throwOnActive: false });
        snapshot = getScopeIndexSnapshot(scope);
      }

      const payload: RetrievalScopeStatusResponse = {
        scope,
        settings: saved.settings,
        index: snapshot.status,
        activeJob: snapshot.activeJob,
        recentJobs: snapshot.recentJobs,
        availableModels: listAvailableRetrievalModels(),
      };
      res.json(payload);
    } catch (err) {
      sendRetrievalError(res, err);
    }
  },
);

retrievalAdminRouter.post(
  '/retrieval/:scopeKind/:scopeId/reindex',
  requirePerm('edit_retrieval'),
  (req, res) => {
    try {
      const scope = assertScopeExists(parseRouteScope(req));
      const job = enqueueReindexJob(scope, 'reindex', { throwOnActive: true });
      const payload: RetrievalReindexResponse = {
        ok: true,
        job,
      };
      res.json(payload);
    } catch (err) {
      sendRetrievalError(res, err);
    }
  },
);

retrievalAdminRouter.post(
  '/retrieval/:scopeKind/:scopeId/query',
  requirePerm('view_retrieval'),
  async (req, res) => {
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

    try {
      const scope = assertScopeExists(parseRouteScope(req));
      if (!isPillarEnabled('retrieval')) {
        throw new RetrievalStoreError(
          'Retrieval pillar is disabled.',
          'pillar_disabled',
          409,
        );
      }
      const parsed = queryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new RetrievalStoreError(
          `Invalid query payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const data: RetrievalQueryRequest = parsed.data;
      const result = await retrieve(scope, data.query, {
        topK: data.topK,
        minScore: data.minScore,
        mode: data.mode,
        roles: data.roles,
        signal: ac.signal,
        respectPillarFlag: true,
      });
      res.json(result);
    } catch (err) {
      sendRetrievalError(res, err);
    } finally {
      cleanup();
    }
  },
);
