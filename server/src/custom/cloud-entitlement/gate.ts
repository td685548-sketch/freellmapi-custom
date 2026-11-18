import type { NextFunction, Request, Response } from 'express';
import type { CloudEntitlementScope } from '@freellmapi/shared/cloud-entitlement.js';
import { ensureCloudEntitlementActive } from './service.js';

/**
 * Express middleware gating AI Chat & AI Support endpoints behind an active,
 * Ed25519-verified Cloud Entitlement lease issued by the repository owner.
 */
export function requireCloudAiEntitlement(scope: CloudEntitlementScope) {
  return async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const active = await ensureCloudEntitlementActive(scope);
      if (active) {
        next();
        return;
      }
      res.status(403).json({
        error: {
          code: 'ai_activation_required',
          type: 'entitlement_error',
          scope,
          message:
            'AI Chat & Support modules require owner approval. Submit an activation request or enter a valid activation token in the dashboard.',
        },
      });
    } catch (err) {
      next(err);
    }
  };
}
