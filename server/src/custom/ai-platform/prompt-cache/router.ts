import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  PROMPT_CACHE_LIMITS,
  type PromptCacheCapabilitiesResponse,
  type PromptCacheCapabilityDeleteResponse,
  type PromptCacheCapabilityResponse,
  type PromptCacheGroupBy,
  type PromptCacheSettingsResponse,
} from '@freellmapi/shared/ai-platform-prompt-cache.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../../../middleware/requirePermission.js';
import type { SessionUser } from '../../../services/auth.js';
import {
  PromptCacheStoreError,
  deleteCacheCapabilityOverride,
  getPromptCacheSettings,
  listCacheCapabilities,
  promptCacheCapabilityInputSchema,
  promptCacheSettingsPatchSchema,
  setPromptCacheSettings,
  upsertCacheCapabilityOverride,
} from './capabilities.js';
import { getCacheStats } from './stats.js';

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

function sendPromptCacheError(res: Response, err: unknown): void {
  if (err instanceof PromptCacheStoreError) {
    const errorType =
      err.status === 422 ? 'unprocessable_entity' : 'invalid_request_error';
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
      code: 'prompt_cache_error',
      message: err instanceof Error ? err.message : 'Prompt cache operation failed.',
    },
  });
}

const deleteCapabilitySchema = z
  .object({
    platform: z.string().trim().min(1).max(PROMPT_CACHE_LIMITS.platformMaxChars),
    modelPattern: z.string().trim().min(1).max(PROMPT_CACHE_LIMITS.modelPatternMaxChars),
  })
  .strict();

export const promptCacheAdminRouter = Router();

promptCacheAdminRouter.get(
  '/prompt-cache/settings',
  requirePerm('view_prompt_cache'),
  (_req, res) => {
    try {
      const payload: PromptCacheSettingsResponse = {
        settings: getPromptCacheSettings(),
      };
      res.json(payload);
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);

promptCacheAdminRouter.put(
  '/prompt-cache/settings',
  requirePerm('edit_prompt_cache'),
  (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
        throw new PromptCacheStoreError(
          'Invalid settings body: expected JSON object.',
          'validation_error',
          400,
        );
      }
      const parsed = promptCacheSettingsPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PromptCacheStoreError(
          `Invalid prompt cache settings: ${issue?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const payload: PromptCacheSettingsResponse = {
        settings: setPromptCacheSettings(parsed.data),
      };
      res.json(payload);
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);

promptCacheAdminRouter.get(
  '/prompt-cache/capabilities',
  requirePerm('view_prompt_cache'),
  (_req, res) => {
    try {
      const payload: PromptCacheCapabilitiesResponse = {
        capabilities: listCacheCapabilities(),
      };
      res.json(payload);
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);

promptCacheAdminRouter.put(
  '/prompt-cache/capabilities',
  requirePerm('edit_prompt_cache'),
  (req, res) => {
    try {
      const parsed = promptCacheCapabilityInputSchema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') || 'capability';
        throw new PromptCacheStoreError(
          `Invalid capability (${field}): ${issue?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const payload: PromptCacheCapabilityResponse = {
        capability: upsertCacheCapabilityOverride(parsed.data),
      };
      res.json(payload);
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);

promptCacheAdminRouter.delete(
  '/prompt-cache/capabilities',
  requirePerm('edit_prompt_cache'),
  (req, res) => {
    try {
      const rawBody =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length > 0
          ? req.body
          : req.query.platform !== undefined || req.query.modelPattern !== undefined
            ? { platform: req.query.platform, modelPattern: req.query.modelPattern }
            : req.body;
      const parsed = deleteCapabilitySchema.safeParse(rawBody);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const field = issue?.path.join('.') || 'capability';
        throw new PromptCacheStoreError(
          `Invalid capability delete payload (${field}): ${issue?.message ?? 'validation failed'}`,
          'validation_error',
          400,
        );
      }
      const payload: PromptCacheCapabilityDeleteResponse = {
        deleted: deleteCacheCapabilityOverride(parsed.data.platform, parsed.data.modelPattern),
      };
      res.json(payload);
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);

promptCacheAdminRouter.get(
  '/prompt-cache/stats',
  requirePerm('view_prompt_cache'),
  (req, res) => {
    try {
      let days: number = PROMPT_CACHE_LIMITS.defaultStatsDays;
      const rawDays = req.query.days;
      if (rawDays !== undefined && rawDays !== '') {
        const str = Array.isArray(rawDays) ? String(rawDays[0] ?? '') : String(rawDays);
        if (!/^\d+$/.test(str)) {
          throw new PromptCacheStoreError(
            `days must be an integer between 1 and ${PROMPT_CACHE_LIMITS.maxStatsDays}.`,
            'invalid_days',
            400,
          );
        }
        const n = Number(str);
        if (!Number.isInteger(n) || n < 1 || n > PROMPT_CACHE_LIMITS.maxStatsDays) {
          throw new PromptCacheStoreError(
            `days must be an integer between 1 and ${PROMPT_CACHE_LIMITS.maxStatsDays}.`,
            'invalid_days',
            400,
          );
        }
        days = n;
      }

      let groupBy: PromptCacheGroupBy = 'day';
      const rawGroupBy = req.query.groupBy;
      if (rawGroupBy !== undefined && rawGroupBy !== '') {
        const str = Array.isArray(rawGroupBy) ? String(rawGroupBy[0] ?? '') : String(rawGroupBy);
        if (str !== 'day' && str !== 'profile' && str !== 'model') {
          throw new PromptCacheStoreError(
            "groupBy must be 'day', 'profile', or 'model'.",
            'invalid_group_by',
            400,
          );
        }
        groupBy = str;
      }

      res.json(getCacheStats({ days, groupBy }));
    } catch (err) {
      sendPromptCacheError(res, err);
    }
  },
);
