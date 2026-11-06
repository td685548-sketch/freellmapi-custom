import type { Request, Response, NextFunction } from 'express';
import { getConfigSnapshot } from './config.js';
import { permissionGranted } from '@freellmapi/shared/permissions.js';
import { extractInferenceToken } from '../../middleware/user-rate-limit.js';
import { validateUserApiKey, getMemoizedUserKey, type ValidatedUserKey } from '../../services/user-keys.js';

/**
 * Auth middleware for the X gateway. Checks:
 * 1. Gateway is enabled (else 404 to leak nothing)
 * 2. User is authenticated via personal key (already validated by userInferenceGate or validated here)
 * 3. User holds use_x_gateway permission
 * Never caches the permission across requests.
 */
export function xGatewayAuth(req: Request, res: Response, next: NextFunction): void {
  const config = getConfigSnapshot();
  if (!config.enabled) {
    res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
    return;
  }

  const token = extractInferenceToken(req);
  const user = token ? validateUserApiKey(token) : getMemoizedUserKey();
  if (!user) {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }

  if (!permissionGranted(user, 'use_x_gateway')) {
    res.status(403).json({ error: { message: 'Permission denied: use_x_gateway required', type: 'permission_error' } });
    return;
  }

  (req as Request & { user?: ValidatedUserKey }).user = user;
  next();
}
