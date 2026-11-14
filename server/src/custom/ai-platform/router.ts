import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  DEFAULT_AI_PLATFORM_RETENTION,
  PILLARS,
  type AiPlatformOverviewResponse,
  type AiPlatformRetention,
  type Pillar,
} from '@freellmapi/shared/ai-platform.js';
import type { Permission } from '@freellmapi/shared/permissions.js';
import { getDb } from '../../db/index.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import { getFlags, setFlags } from './flags.js';
import { mcpAdminRouter } from './mcp-client/router.js';

const RETENTION_KEY = 'ai_platform_retention_v1';

const flagsPatchSchema = z
  .object({
    prompts: z.boolean().optional(),
    retrieval: z.boolean().optional(),
    promptCache: z.boolean().optional(),
    mcpClient: z.boolean().optional(),
    outputGuard: z.boolean().optional(),
    orchestrator: z.boolean().optional(),
  })
  .strict();

const retentionSchema = z
  .object({
    runsDays: z.number().int().min(1).max(3650),
    toolCallsDays: z.number().int().min(1).max(3650),
    guardExcerptsDays: z.number().int().min(1).max(3650),
  })
  .strict();

function requirePerm(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
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

function readRetention(): AiPlatformRetention {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(RETENTION_KEY) as { value?: string } | undefined;
    if (!row?.value) return { ...DEFAULT_AI_PLATFORM_RETENTION };
    const parsed = retentionSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : { ...DEFAULT_AI_PLATFORM_RETENTION };
  } catch {
    return { ...DEFAULT_AI_PLATFORM_RETENTION };
  }
}

function writeRetention(retention: AiPlatformRetention): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(RETENTION_KEY, JSON.stringify(retention));
}

export const aiPlatformRouter = Router();

aiPlatformRouter.get('/overview', requirePerm('view_ai_platform'), (_req, res) => {
  const flags = getFlags();
  const retention = readRetention();
  const pillars = Object.fromEntries(
    PILLARS.map((pillar) => {
      const ready = pillar === 'mcpClient';
      const summary = ready
        ? flags[pillar]
          ? 'MCP client runtime active.'
          : 'MCP client ready (disabled by default).'
        : flags[pillar]
          ? 'Enabled in foundation mode (pillar engine not yet installed).'
          : 'Disabled by default.';
      return [pillar, { enabled: flags[pillar], ready, summary }];
    }),
  ) as AiPlatformOverviewResponse['pillars'];

  const payload: AiPlatformOverviewResponse = {
    flags,
    retention,
    pillars,
    warnings: [],
  };
  res.json(payload);
});

aiPlatformRouter.put('/flags', requirePerm('edit_ai_flags'), (req, res) => {
  const parsed = flagsPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_flags',
        message: 'Invalid flags payload; expected boolean values for known pillars.',
      },
    });
    return;
  }
  try {
    const patch: Partial<Record<Pillar, boolean>> = parsed.data;
    const flags = setFlags(patch);
    res.json({ flags });
  } catch (err) {
    res.status(500).json({
      error: {
        type: 'internal_error',
        code: 'flags_write_failed',
        message: err instanceof Error ? err.message : 'Failed to persist AI platform flags.',
      },
    });
  }
});

aiPlatformRouter.get('/retention', requirePerm('view_ai_platform'), (_req, res) => {
  res.json({ retention: readRetention() });
});

aiPlatformRouter.put('/retention', requirePerm('edit_ai_flags'), (req, res) => {
  const parsed = retentionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        type: 'invalid_request_error',
        code: 'invalid_retention',
        message: 'Retention days must be integers between 1 and 3650.',
      },
    });
    return;
  }
  try {
    writeRetention(parsed.data);
    res.json({ retention: parsed.data });
  } catch (err) {
    res.status(500).json({
      error: {
        type: 'internal_error',
        code: 'retention_write_failed',
        message: err instanceof Error ? err.message : 'Failed to persist retention settings.',
      },
    });
  }
});

aiPlatformRouter.use(mcpAdminRouter);
