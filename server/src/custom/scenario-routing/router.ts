import {
  IDE_PACKAGER_TOOLS,
  MAX_LONG_CONTEXT_THRESHOLD,
  MIN_LONG_CONTEXT_THRESHOLD,
  SCENARIO_IDS,
  SCENARIO_ROUTING_MODES,
  type ScenarioId,
  type ScenarioRuleConfig,
} from '@freellmapi/shared/scenario-routing.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/requireAuth.js';
import { extractInferenceToken } from '../../middleware/user-rate-limit.js';
import type { SessionUser } from '../../services/auth.js';
import { isGuestRequest } from '../../services/guest-access.js';
import { USER_KEY_PREFIX, validateUserApiKey } from '../../services/user-keys.js';
import { requireActionPermission } from '../permission-actions.js';
import { classifyScenarioRequest } from './classifier.js';
import { generateIdePackageBundle, sanitizeGatewayOrigin } from './ide-packager.js';
import {
  assertUserOwnsKey,
  deleteKeyScenarioPolicy,
  getAccountScenarioPolicy,
  getIdeConnectionStatus,
  getUserScenarioTelemetry,
  listKeyScenarioPolicies,
  listRoutableCatalogModelsForScenarioUi,
  recordVerifyPing,
  ScenarioRoutingError,
  upsertScenarioPolicy,
} from './store.js';

export const scenarioRoutingRouter = Router();

function requireSignedInAccount(req: Request, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (isGuestRequest(req) || !user || !user.userId) {
      res.status(401).json({
        error: {
          code: 'authentication_required',
          type: 'authentication_error',
          message: 'Signed-in account required.',
        },
      });
      return;
    }
    next();
  });
}

function inferGatewayOriginFromRequest(req: Request): string {
  const protoHeader = req.headers['x-forwarded-proto'];
  const firstProto = String(protoHeader ?? '').split(',')[0]!.trim().toLowerCase();
  const proto = firstProto === 'https' || req.secure ? 'https' : 'http';
  const host = req.get('host') || `127.0.0.1:${req.socket?.localPort || 3001}`;
  return sanitizeGatewayOrigin(`${proto}://${host}`);
}

const rulePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    targetMode: z.enum(SCENARIO_ROUTING_MODES).optional(),
    targetModel: z.string().trim().max(160).nullable().optional(),
    overrideExplicitModel: z.boolean().optional(),
  })
  .strict();

const upsertPolicySchema = z
  .object({
    keyId: z.number().int().positive().nullable().optional(),
    enabled: z.boolean(),
    longContextThreshold: z
      .number()
      .int()
      .min(MIN_LONG_CONTEXT_THRESHOLD)
      .max(MAX_LONG_CONTEXT_THRESHOLD)
      .optional(),
    rules: z
      .object({
        background: rulePatchSchema.optional(),
        think: rulePatchSchema.optional(),
        longContext: rulePatchSchema.optional(),
        vision: rulePatchSchema.optional(),
        webSearch: rulePatchSchema.optional(),
        default: rulePatchSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const classifyPreviewSchema = z
  .object({
    wireSurface: z
      .enum(['chat_completions', 'anthropic_messages', 'responses'])
      .optional(),
    longContextThreshold: z
      .number()
      .int()
      .min(MIN_LONG_CONTEXT_THRESHOLD)
      .max(MAX_LONG_CONTEXT_THRESHOLD)
      .optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const idePackageSchema = z
  .object({
    toolId: z.enum(IDE_PACKAGER_TOOLS),
    gatewayUrl: z.string().trim().max(300).optional(),
    keyId: z.number().int().positive().nullable().optional(),
    rawApiKey: z.string().trim().max(200).nullable().optional(),
    defaultModel: z.string().trim().max(160).nullable().optional(),
  })
  .strict();

const verifyPingBodySchema = z
  .object({
    keyId: z.number().int().positive().nullable().optional(),
    rawApiKey: z.string().trim().max(200).nullable().optional(),
  })
  .passthrough();

// POST /api/scenario-routing/verify-ping
// Dual-auth on purpose:
// 1. From terminal / IDE one-liner using a Personal API Key (`Authorization: Bearer sk-flm-...` or `x-api-key: sk-flm-...`)
// 2. From signed-in Dashboard UI (`requireSignedInAccount`) testing a newly minted/pasted key or checking live status
scenarioRoutingRouter.post(
  '/verify-ping',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const headerToken = extractInferenceToken(req);
      const parsedBody = verifyPingBodySchema.safeParse(req.body ?? {});
      const bodyRawKey = parsedBody.success ? parsedBody.data.rawApiKey : null;

      // Case 1: Caller authenticated directly with a Personal API Key (`sk-flm-...`) from terminal/IDE
      if (headerToken && headerToken.startsWith(USER_KEY_PREFIX)) {
        const validated = validateUserApiKey(headerToken);
        if (!validated) {
          res.status(401).json({
            error: {
              code: 'invalid_api_key',
              type: 'authentication_error',
              message: 'Invalid or revoked Personal API Key.',
            },
          });
          return;
        }
        const verifiedAt = recordVerifyPing(validated.userId, validated.keyId ?? null);
        const gatewayOrigin = inferGatewayOriginFromRequest(req);
        res.json({
          ok: true,
          status: getIdeConnectionStatus(
            validated.userId,
            gatewayOrigin,
            validated.keyId ?? null,
          ),
          verifiedAt,
        });
        return;
      }

      // Case 2: Dashboard session caller
      requireSignedInAccount(req, res, () => {
        try {
          const user = (req as Request & { user?: SessionUser }).user!;
          const gatewayOrigin = inferGatewayOriginFromRequest(req);

          if (!parsedBody.success) {
            throw new ScenarioRoutingError(400, 'invalid_input', 'Invalid verify-ping payload.');
          }

          const requestedKeyId = parsedBody.data.keyId ?? null;
          if (requestedKeyId !== null) {
            assertUserOwnsKey(user.userId, requestedKeyId);
          }

          // If the signed-in user supplied their raw key in the UI, verify it belongs to them and mark ping!
          if (bodyRawKey && bodyRawKey.startsWith(USER_KEY_PREFIX)) {
            const validated = validateUserApiKey(bodyRawKey);
            if (!validated || validated.userId !== user.userId) {
              throw new ScenarioRoutingError(
                400,
                'invalid_personal_key',
                'Provided Personal API Key is invalid, revoked, or belongs to another account.',
              );
            }
            recordVerifyPing(user.userId, validated.keyId ?? requestedKeyId);
            res.json({
              ok: true,
              status: getIdeConnectionStatus(
                user.userId,
                gatewayOrigin,
                validated.keyId ?? requestedKeyId,
              ),
            });
            return;
          }

          res.json({
            ok: true,
            status: getIdeConnectionStatus(user.userId, gatewayOrigin, requestedKeyId),
          });
        } catch (innerErr) {
          next(innerErr);
        }
      });
    } catch (err) {
      next(err);
    }
  },
);

// Every endpoint below strictly requires a signed-in non-guest dashboard session
scenarioRoutingRouter.use(requireSignedInAccount);

// GET /api/scenario-routing/config
scenarioRoutingRouter.get('/config', (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    const rawKeyId = typeof req.query.keyId === 'string' ? Number(req.query.keyId) : null;
    if (rawKeyId !== null && Number.isFinite(rawKeyId) && rawKeyId > 0) {
      assertUserOwnsKey(user.userId, rawKeyId);
    }

    res.json({
      accountPolicy: getAccountScenarioPolicy(user.userId),
      keyPolicies: listKeyScenarioPolicies(user.userId),
      telemetry: getUserScenarioTelemetry(
        user.userId,
        rawKeyId && rawKeyId > 0 ? rawKeyId : null,
      ),
      availableModels: listRoutableCatalogModelsForScenarioUi(),
    });
  } catch (err) {
    next(err);
  }
});

// PUT /api/scenario-routing/policy
scenarioRoutingRouter.put('/policy', (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as Request & { user?: SessionUser }).user!;
    const parsed = upsertPolicySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new ScenarioRoutingError(
        400,
        'invalid_input',
        parsed.error.issues.map((i) => i.message).join(', '),
      );
    }

    const rulesPatch: Partial<Record<ScenarioId, Partial<ScenarioRuleConfig>>> = {};
    if (parsed.data.rules) {
      for (const id of SCENARIO_IDS) {
        if (parsed.data.rules[id]) {
          rulesPatch[id] = parsed.data.rules[id];
        }
      }
    }

    const policy = upsertScenarioPolicy(user.userId, {
      keyId: parsed.data.keyId ?? null,
      enabled: parsed.data.enabled,
      longContextThreshold: parsed.data.longContextThreshold,
      rules: rulesPatch,
    });

    res.json({ ok: true, policy });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/scenario-routing/policy/:keyId
scenarioRoutingRouter.delete(
  '/policy/:keyId',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const keyId = Number(req.params.keyId);
      if (!Number.isInteger(keyId) || keyId <= 0) {
        throw new ScenarioRoutingError(400, 'invalid_key_id', 'Invalid personal API key ID.');
      }
      assertUserOwnsKey(user.userId, keyId);
      const deleted = deleteKeyScenarioPolicy(user.userId, keyId);
      res.json({ ok: true, deleted });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/scenario-routing/classify-preview
scenarioRoutingRouter.post(
  '/classify-preview',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const parsed = classifyPreviewSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ScenarioRoutingError(
          400,
          'invalid_input',
          parsed.error.issues.map((i) => i.message).join(', '),
        );
      }
      const policy = getAccountScenarioPolicy(user.userId);
      const result = classifyScenarioRequest(parsed.data.payload, {
        wireSurface: parsed.data.wireSurface ?? 'chat_completions',
        longContextThreshold: parsed.data.longContextThreshold ?? policy.longContextThreshold,
      });
      res.json({ ok: true, classification: result });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/scenario-routing/ide-package
scenarioRoutingRouter.post(
  '/ide-package',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const parsed = idePackageSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ScenarioRoutingError(
          400,
          'invalid_input',
          parsed.error.issues.map((i) => i.message).join(', '),
        );
      }

      let keyPrefix: string | null = null;
      if (parsed.data.keyId != null) {
        const owned = assertUserOwnsKey(user.userId, parsed.data.keyId);
        keyPrefix = owned.keyPrefix;
      }

      if (parsed.data.rawApiKey && parsed.data.rawApiKey.startsWith(USER_KEY_PREFIX)) {
        const validated = validateUserApiKey(parsed.data.rawApiKey);
        if (!validated || validated.userId !== user.userId) {
          throw new ScenarioRoutingError(
            403,
            'forbidden_key',
            'Cannot generate IDE config for an API key that does not belong to your account.',
          );
        }
      }

      const gatewayOrigin = parsed.data.gatewayUrl
        ? sanitizeGatewayOrigin(parsed.data.gatewayUrl)
        : inferGatewayOriginFromRequest(req);

      const bundle = generateIdePackageBundle({
        toolId: parsed.data.toolId,
        gatewayUrl: gatewayOrigin,
        rawApiKey: parsed.data.rawApiKey ?? null,
        keyPrefix,
        defaultModel: parsed.data.defaultModel ?? 'auto',
      });

      res.json({ ok: true, bundle });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/scenario-routing/connection-status
scenarioRoutingRouter.get(
  '/connection-status',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as Request & { user?: SessionUser }).user!;
      const rawKeyId = typeof req.query.keyId === 'string' ? Number(req.query.keyId) : null;
      if (rawKeyId !== null && Number.isFinite(rawKeyId) && rawKeyId > 0) {
        assertUserOwnsKey(user.userId, rawKeyId);
      }
      const gatewayOrigin = inferGatewayOriginFromRequest(req);
      res.json({
        ok: true,
        status: getIdeConnectionStatus(
          user.userId,
          gatewayOrigin,
          rawKeyId && rawKeyId > 0 ? rawKeyId : null,
        ),
      });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/scenario-routing/admin/user/:userId — Admin-only inspection of a member's scenario telemetry
scenarioRoutingRouter.get(
  '/admin/user/:userId',
  requireActionPermission('manage_users'),
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetUserId = Number(req.params.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        throw new ScenarioRoutingError(400, 'invalid_user_id', 'Invalid user ID.');
      }
      res.json({
        ok: true,
        accountPolicy: getAccountScenarioPolicy(targetUserId),
        telemetry: getUserScenarioTelemetry(targetUserId),
      });
    } catch (err) {
      next(err);
    }
  },
);

scenarioRoutingRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof ScenarioRoutingError) {
      res.status(err.status).json({
        error: {
          code: err.code,
          type: err.status === 403 ? 'forbidden' : err.code,
          message: err.message,
        },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'Scenario routing request failed.';
    res.status(500).json({
      error: { code: 'internal_error', type: 'internal_error', message },
    });
  },
);
