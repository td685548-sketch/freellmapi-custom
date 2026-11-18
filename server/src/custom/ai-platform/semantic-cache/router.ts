import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  SEMANTIC_CACHE_LIMITS,
  type Scope,
  type SemanticCacheFlushResponse,
  type SemanticCacheSettingsResponse,
  type SemanticCacheStatsResponse,
} from '@freellmapi/shared/ai-platform-semantic-cache.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import { parseScopeParam } from '../scope.js';
import { runSemanticCacheLookupPreview } from './runtime.js';
import {
  SemanticCacheStoreError,
  assertSemanticCacheScopeExists,
  flushSemanticCacheScope,
  getSemanticCacheSettings,
  getSemanticCacheStats,
  setSemanticCacheSettings,
} from './store.js';

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
    throw new SemanticCacheStoreError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }
}

function sendSemanticCacheError(res: Response, err: unknown): void {
  if (err instanceof SemanticCacheStoreError) {
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
      code: 'semantic_cache_error',
      message: err instanceof Error ? err.message : 'Semantic cache operation failed.',
    },
  });
}

const flushRequestSchema = z
  .object({
    resetMetrics: z.boolean().optional(),
    model: z.string().trim().min(1).max(200).optional(),
    endUser: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const lookupPreviewSchema = z
  .object({
    query: z.string().max(SEMANTIC_CACHE_LIMITS.maxPreviewQueryChars).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.string().trim().min(1).max(32),
            content: z.unknown(),
          })
          .passthrough(),
      )
      .max(64)
      .optional(),
    model: z.string().trim().max(200).optional(),
    wire: z.enum(['openai-chat', 'anthropic', 'responses', 'gemini']).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    endUser: z.string().trim().max(200).optional(),
    vars: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    cacheHeader: z.string().trim().max(64).optional(),
    cacheControl: z.string().trim().max(128).optional(),
    tools: z.unknown().optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.unknown().optional(),
    reasoning_effort: z.unknown().optional(),
    thinking: z.unknown().optional(),
    seed: z.number().int().optional(),
    max_tokens: z.number().int().positive().optional(),
    stop: z.unknown().optional(),
    modalities: z.unknown().optional(),
  })
  .strict();

export const semanticCacheAdminRouter = Router();

semanticCacheAdminRouter.get(
  '/semantic-cache/:scopeKind/:scopeId/settings',
  requirePerm('view_prompt_cache'),
  (req, res) => {
    try {
      const scope = assertSemanticCacheScopeExists(parseRouteScope(req));
      const payload: SemanticCacheSettingsResponse = {
        scope,
        settings: getSemanticCacheSettings(scope),
      };
      res.json(payload);
    } catch (err) {
      sendSemanticCacheError(res, err);
    }
  },
);

semanticCacheAdminRouter.put(
  '/semantic-cache/:scopeKind/:scopeId/settings',
  requirePerm('edit_prompt_cache'),
  (req, res) => {
    try {
      const scope = assertSemanticCacheScopeExists(parseRouteScope(req));
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new SemanticCacheStoreError(
          'Invalid semantic cache settings body: expected JSON object.',
          'validation_error',
          400,
        );
      }
      const payload: SemanticCacheSettingsResponse = {
        scope,
        settings: setSemanticCacheSettings(scope, req.body),
      };
      res.json(payload);
    } catch (err) {
      sendSemanticCacheError(res, err);
    }
  },
);

semanticCacheAdminRouter.get(
  '/semantic-cache/:scopeKind/:scopeId/stats',
  requirePerm('view_prompt_cache'),
  (req, res) => {
    try {
      const scope = assertSemanticCacheScopeExists(parseRouteScope(req));
      const { stats, recentEntries } = getSemanticCacheStats(scope);
      const payload: SemanticCacheStatsResponse = {
        scope,
        stats,
        recentEntries,
      };
      res.json(payload);
    } catch (err) {
      sendSemanticCacheError(res, err);
    }
  },
);

semanticCacheAdminRouter.post(
  '/semantic-cache/:scopeKind/:scopeId/flush',
  requirePerm('edit_prompt_cache'),
  (req, res) => {
    try {
      const scope = assertSemanticCacheScopeExists(parseRouteScope(req));
      const rawBody =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const parsed = flushRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SemanticCacheStoreError(
          `Invalid flush payload: ${issue?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const result = flushSemanticCacheScope(scope, parsed.data);
      const payload: SemanticCacheFlushResponse = {
        ok: true,
        scope,
        deletedEntries: result.deletedEntries,
        metricsReset: result.metricsReset,
      };
      res.json(payload);
    } catch (err) {
      sendSemanticCacheError(res, err);
    }
  },
);

semanticCacheAdminRouter.post(
  '/semantic-cache/:scopeKind/:scopeId/lookup-preview',
  requirePerm('view_prompt_cache'),
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
      const scope = assertSemanticCacheScopeExists(parseRouteScope(req));
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new SemanticCacheStoreError(
          'Invalid lookup-preview body: expected JSON object.',
          'validation_error',
          400,
        );
      }
      const parsed = lookupPreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new SemanticCacheStoreError(
          `Invalid lookup-preview payload: ${issue?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const result = await runSemanticCacheLookupPreview(scope, parsed.data, ac.signal);
      res.json(result);
    } catch (err) {
      sendSemanticCacheError(res, err);
    } finally {
      cleanup();
    }
  },
);
