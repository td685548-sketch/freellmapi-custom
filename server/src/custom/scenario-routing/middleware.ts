import type { NextFunction, Request, Response } from 'express';
import { getClientContext, setRequestKeyRoutingPreset } from '../../lib/client-context.js';
import { classifyClaudeFamily } from '../../services/anthropic-map.js';
import type { ValidatedUserKey } from '../../services/user-keys.js';
import { routingModeToPreset } from '../customer-ai/store.js';
import { classifyScenarioRequest, detectScenarioWireSurface } from './classifier.js';
import {
  isRoutableScenarioTargetModel,
  recordScenarioRoutingHit,
  resolveEffectiveScenarioPolicy,
} from './store.js';

function isImplicitOrAutoModel(model: string): boolean {
  const clean = model.trim().toLowerCase();
  if (!clean || clean === 'auto' || clean.startsWith('auto:')) return true;
  return classifyClaudeFamily(clean) !== null;
}

function isSpecialVirtualModel(model: string): boolean {
  const clean = model.trim().toLowerCase();
  return clean === 'fusion' || clean.startsWith('fusion:') || clean.startsWith('flow:');
}

function parseRoutedModelHeader(raw: string | number | string[] | undefined): string | null {
  const text = Array.isArray(raw) ? raw[0] : typeof raw === 'string' ? raw : '';
  if (!text) return null;
  const idx = text.indexOf(':');
  return idx >= 0 ? text.slice(idx + 1).trim() || text.trim() : text.trim();
}

/**
 * Scenario-Based Auto-Routing Middleware for `/v1/chat/completions`, `/v1/messages`, and `/v1/responses`.
 *
 * Runs right after `userInferenceGate`, `playgroundAttribution`, and `customerAiSessionRoutingMiddleware`
 * so `req.user` (personal key) or `ClientContext.userId` (attributed Playground/AI Hub session) is already resolved.
 */
export function scenarioRoutingMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'POST') {
    next();
    return;
  }

  const wireSurface = detectScenarioWireSurface(req.path || req.originalUrl || '');
  if (!wireSurface) {
    next();
    return;
  }

  const userKey = (req as Request & { user?: ValidatedUserKey }).user;
  const ctx = getClientContext();
  const userId = userKey?.userId ?? ctx.userId;
  const keyId = userKey?.keyId ?? null;

  if (!userId) {
    next();
    return;
  }

  let policy;
  try {
    policy = resolveEffectiveScenarioPolicy(userId, keyId);
  } catch {
    next();
    return;
  }

  if (!policy || !policy.enabled) {
    next();
    return;
  }

  const classification = classifyScenarioRequest(req.body, {
    wireSurface,
    longContextThreshold: policy.longContextThreshold,
  });

  res.setHeader('X-FreeLLM-Scenario', classification.scenario);

  const rule = policy.rules[classification.scenario];
  let effectiveMode = rule?.enabled ? rule.targetMode : ('default' as const);

  if (rule?.enabled) {
    const preset = routingModeToPreset(rule.targetMode);
    if (preset) {
      setRequestKeyRoutingPreset(preset);
    }
    if (rule.targetMode !== 'default') {
      res.setHeader('X-FreeLLM-Scenario-Mode', rule.targetMode);
    }

    const bodyObj =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : null;

    if (bodyObj) {
      const currentModel = typeof bodyObj.model === 'string' ? bodyObj.model.trim() : '';
      const canRewriteModel =
        !isSpecialVirtualModel(currentModel) &&
        (isImplicitOrAutoModel(currentModel) || rule.overrideExplicitModel);

      if (canRewriteModel) {
        if (rule.targetModel) {
          const routable = isRoutableScenarioTargetModel(rule.targetModel, {
            requireVision: classification.scenario === 'vision',
            minContextTokens: classification.estimatedInputTokens,
          });
          if (routable) {
            bodyObj.model = rule.targetModel;
            res.setHeader('X-FreeLLM-Scenario-Target', rule.targetModel);
          } else {
            // Safe fallback: targetModel is disabled, missing, out of keys, or lacks vision/context;
            // fall back cleanly to the scenario's tier preset over the healthy pool!
            if (!isImplicitOrAutoModel(currentModel) && rule.overrideExplicitModel) {
              bodyObj.model = 'auto';
            }
            if (!preset) {
              setRequestKeyRoutingPreset('balanced');
              effectiveMode = 'balanced';
            }
            res.setHeader('X-FreeLLM-Scenario-Fallback', 'tier_preset');
          }
        } else if (
          !isImplicitOrAutoModel(currentModel) &&
          rule.overrideExplicitModel &&
          rule.targetMode !== 'default'
        ) {
          // Allow scenario tier preset (e.g. background -> eco) to steer even when the IDE sent a concrete model ID.
          bodyObj.model = 'auto';
        }
      }
    }
  }

  res.once('finish', () => {
    if (res.statusCode < 400) {
      const settledTokens = getClientContext().userTokens || classification.estimatedInputTokens;
      const servedModel = parseRoutedModelHeader(res.getHeader('X-Routed-Via'));
      const offloadedToEco = Boolean(
        rule?.enabled && rule.targetMode === 'eco' && classification.scenario !== 'think',
      );
      recordScenarioRoutingHit({
        userId,
        keyId,
        scenario: classification.scenario,
        routedMode: effectiveMode,
        routedModel: servedModel,
        totalTokens: settledTokens,
        offloadedToEco,
      });
    }
  });

  next();
}
