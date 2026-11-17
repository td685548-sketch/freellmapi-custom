import { Router, type NextFunction, type Request, type Response } from 'express';
import type {
  SupportLiveTestOriginCheckResponse,
  SupportLiveTestPersonaSessionResponse,
} from '@freellmapi/shared/support-service-desk-live-test.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import type { SessionUser } from '../../services/auth.js';
import {
  resolveTenant,
  xSupportPublicRouter,
} from './support-router.js';
import {
  mintSupportUserToken,
  SupportStoreError,
  verifySupportUserToken,
  type SupportTenant,
} from './support-store.js';
import { xSupportServiceDeskPublicRouter } from './support-service-desk-router.js';
import { xSupportEnterprisePublicRouter } from './support-enterprise-router.js';
import { xSupportGovernancePublicRouter } from './support-governance-router.js';

function paramStr(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0] ?? '' : val ?? '';
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const proto = Object.getPrototypeOf(val);
  return proto === Object.prototype || proto === null;
}

function assertAllowedKeys(obj: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !allowed.includes(key)) {
      return key;
    }
  }
  return null;
}

function hasEditorAccess(user: SessionUser | undefined): boolean {
  if (!user) return false;
  if (
    user.isPrimary ||
    user.role === 'admin' ||
    user.permissions?.includes('*') ||
    user.permissions?.includes('manage_x_gateway')
  ) {
    return true;
  }
  const hasGateway = Boolean(user.permissions?.includes('use_x_gateway'));
  const hasEdit = Boolean(user.permissions?.includes('edit_x_settings'));
  return hasGateway && hasEdit;
}

function resolveNumericConsoleTenant(req: Request, res: Response): SupportTenant | null {
  const rawId = paramStr(req.params.id).trim();
  if (!/^[1-9]\d*$/.test(rawId)) {
    res.status(400).json({ error: { code: 'invalid_input', message: 'Tenant ID must be a positive integer.' } });
    return null;
  }
  try {
    return resolveTenant(rawId);
  } catch (err) {
    const status = err instanceof SupportStoreError ? err.status : 404;
    res.status(status === 400 ? 400 : 404).json({
      error: {
        code: status === 400 ? 'invalid_input' : 'tenant_not_found',
        message: err instanceof Error ? err.message : 'Support tenant not found.',
      },
    });
    return null;
  }
}

export function evaluateTenantOrigin(tenant: SupportTenant, rawOrigin: string): SupportLiveTestOriginCheckResponse {
  const allowedOrigins = tenant.allowedOrigins ?? [];
  const trimmed = rawOrigin.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: true, origin: trimmed, allowed: false, reason: 'invalid_origin', allowedOrigins };
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    trimmed.endsWith('/') ||
    parsed.search ||
    parsed.hash
  ) {
    return { ok: true, origin: trimmed, allowed: false, reason: 'invalid_origin', allowedOrigins };
  }

  const normalized = parsed.origin;
  if (allowedOrigins.length === 0) {
    return { ok: true, origin: normalized, allowed: true, reason: 'unrestricted', allowedOrigins };
  }
  if (allowedOrigins.includes('*')) {
    return { ok: true, origin: normalized, allowed: true, reason: 'wildcard', allowedOrigins };
  }
  if (allowedOrigins.includes(normalized)) {
    return { ok: true, origin: normalized, allowed: true, reason: 'matched', allowedOrigins };
  }
  return { ok: true, origin: normalized, allowed: false, reason: 'not_in_allowlist', allowedOrigins };
}

function isAllowedRuntimeBridgeRoute(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  if (upper === 'GET' && path === '/widget/config') return true;
  if (upper === 'POST' && path === '/widget/intake') return true;
  if (upper === 'POST' && path === '/guest-session') return true;
  if (upper === 'POST' && path === '/chat') return true;
  if (upper === 'GET' && /^\/conversations\/[^/]+$/.test(path)) return true;
  if (upper === 'POST' && path === '/escalate') return true;
  if (upper === 'POST' && path === '/csat') return true;
  return false;
}

const liveTestPublicBridge = Router();
liveTestPublicBridge.use(xSupportPublicRouter);
liveTestPublicBridge.use(xSupportServiceDeskPublicRouter);
liveTestPublicBridge.use(xSupportEnterprisePublicRouter);
liveTestPublicBridge.use(xSupportGovernancePublicRouter);

export const xSupportServiceDeskLiveTestRouter = Router();

xSupportServiceDeskLiveTestRouter.use('/tenants/:id/service-desk/live-test', requireAuth);
xSupportServiceDeskLiveTestRouter.use(
  '/tenants/:id/service-desk/live-test',
  (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: SessionUser }).user;
    if (!hasEditorAccess(user)) {
      res.status(403).json({
        error: {
          code: 'permission_denied',
          message: "Permission denied: 'use_x_gateway' and 'edit_x_settings' permissions required.",
        },
      });
      return;
    }
    next();
  },
);

xSupportServiceDeskLiveTestRouter.post(
  '/tenants/:id/service-desk/live-test/persona-session',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Request body must be a JSON object.' } });
      return;
    }
    const unknownKey = assertAllowedKeys(req.body, [
      'mode',
      'userId',
      'role',
      'name',
      'email',
      'permissions',
      'ttlSeconds',
    ]);
    if (unknownKey) {
      res.status(400).json({ error: { code: 'invalid_input', message: `Unsupported field "${unknownKey}".` } });
      return;
    }

    const mode = req.body.mode;
    if (mode !== 'guest' && mode !== 'authenticated') {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'mode must be "guest" or "authenticated".' },
      });
      return;
    }

    if (mode === 'guest') {
      const response: SupportLiveTestPersonaSessionResponse = {
        ok: true,
        mode: 'guest',
        contextToken: null,
        allowGuest: tenant.allowGuest,
      };
      res.json(response);
      return;
    }

    const userId = typeof req.body.userId === 'string' ? req.body.userId.trim() : '';
    if (!userId || userId.length > 128) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'userId must be 1..128 characters for authenticated mode.' },
      });
      return;
    }

    const role = typeof req.body.role === 'string' ? req.body.role.trim() : '';
    if (!role || role.length > 64) {
      res.status(400).json({
        error: { code: 'invalid_input', message: 'role must be 1..64 characters for authenticated mode.' },
      });
      return;
    }

    let name: string | undefined;
    if (req.body.name !== undefined) {
      if (typeof req.body.name !== 'string' || req.body.name.trim().length > 128) {
        res.status(400).json({ error: { code: 'invalid_input', message: 'name must be at most 128 characters.' } });
        return;
      }
      name = req.body.name.trim() || undefined;
    }

    let email: string | undefined;
    if (req.body.email !== undefined) {
      if (typeof req.body.email !== 'string' || req.body.email.trim().length > 254) {
        res.status(400).json({ error: { code: 'invalid_input', message: 'email must be at most 254 characters.' } });
        return;
      }
      email = req.body.email.trim() || undefined;
    }

    let extraPermissions: string[] = [];
    if (req.body.permissions !== undefined) {
      if (
        !Array.isArray(req.body.permissions) ||
        req.body.permissions.length > 50 ||
        !req.body.permissions.every((p) => typeof p === 'string' && p.trim().length > 0 && p.trim().length <= 128)
      ) {
        res.status(400).json({
          error: {
            code: 'invalid_input',
            message: 'permissions must be an array of at most 50 non-empty strings.',
          },
        });
        return;
      }
      extraPermissions = req.body.permissions.map((p) => p.trim());
    }

    let ttlSeconds = 3600;
    if (req.body.ttlSeconds !== undefined) {
      if (
        typeof req.body.ttlSeconds !== 'number' ||
        !Number.isInteger(req.body.ttlSeconds) ||
        req.body.ttlSeconds < 60 ||
        req.body.ttlSeconds > 86400
      ) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'ttlSeconds must be an integer between 60 and 86400.' },
        });
        return;
      }
      ttlSeconds = req.body.ttlSeconds;
    }

    const roleCfg = tenant.rolesConfig.find((r) => r.role === role);
    const mergedPermissions = [...new Set([...(roleCfg?.permissions ?? []), ...extraPermissions])];

    const contextToken = mintSupportUserToken(tenant.id, {
      userId,
      name,
      email,
      role,
      permissions: mergedPermissions,
      ttlSeconds,
    });
    const verified = verifySupportUserToken(tenant.id, contextToken);

    const response: SupportLiveTestPersonaSessionResponse = {
      ok: true,
      mode: 'authenticated',
      contextToken,
      expiresIn: ttlSeconds,
      allowGuest: tenant.allowGuest,
      userContext: {
        tenantId: verified.tenantId,
        userId: verified.userId,
        role: verified.role,
        ...(verified.name ? { name: verified.name } : {}),
        ...(verified.email ? { email: verified.email } : {}),
        permissions: verified.permissions,
        verified: verified.verified,
      },
    };
    res.json(response);
  },
);

xSupportServiceDeskLiveTestRouter.post(
  '/tenants/:id/service-desk/live-test/origin-check',
  (req: Request, res: Response): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;

    if (!isPlainObject(req.body)) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Request body must be a JSON object.' } });
      return;
    }
    const unknownKey = assertAllowedKeys(req.body, ['origin']);
    if (unknownKey) {
      res.status(400).json({ error: { code: 'invalid_input', message: `Unsupported field "${unknownKey}".` } });
      return;
    }
    if (typeof req.body.origin !== 'string' || !req.body.origin.trim() || req.body.origin.trim().length > 512) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'origin must be a non-empty string.' } });
      return;
    }

    res.json(evaluateTenantOrigin(tenant, req.body.origin));
  },
);

xSupportServiceDeskLiveTestRouter.use(
  '/tenants/:id/service-desk/live-test',
  (req: Request, res: Response, next: NextFunction): void => {
    const tenant = resolveNumericConsoleTenant(req, res);
    if (!tenant) return;

    if (!isAllowedRuntimeBridgeRoute(req.method, req.path)) {
      res.status(404).json({
        error: { code: 'not_found', message: 'Live test endpoint not available.' },
      });
      return;
    }

    const headerTenantKey =
      typeof req.headers['x-support-tenant-key'] === 'string'
        ? req.headers['x-support-tenant-key'].trim()
        : undefined;
    const bodyTenantKey =
      isPlainObject(req.body) && typeof req.body.tenantKey === 'string'
        ? req.body.tenantKey.trim()
        : undefined;
    const queryTenantKey =
      typeof req.query?.tenantKey === 'string' ? req.query.tenantKey.trim() : undefined;

    for (const supplied of [headerTenantKey, bodyTenantKey, queryTenantKey]) {
      if (supplied && supplied !== tenant.publicKey && supplied !== tenant.slug && supplied !== String(tenant.id)) {
        res.status(403).json({
          error: {
            code: 'tenant_mismatch',
            message: 'Cross-tenant request denied in live test session.',
          },
        });
        return;
      }
    }

    req.headers['x-support-tenant-key'] = tenant.publicKey;
    delete req.headers.authorization;

    const simOriginHeader = req.headers['x-support-simulated-origin'];
    const rawSimOrigin = Array.isArray(simOriginHeader) ? simOriginHeader[0] : simOriginHeader;
    if (typeof rawSimOrigin === 'string' && rawSimOrigin.trim().length > 0) {
      const check = evaluateTenantOrigin(tenant, rawSimOrigin);
      if (check.reason === 'invalid_origin') {
        res.status(400).json({
          error: {
            code: 'invalid_input',
            message: 'Simulated origin must be a valid http or https origin.',
          },
        });
        return;
      }
      req.headers.origin = check.origin;
    } else {
      delete req.headers.origin;
    }

    next();
  },
  liveTestPublicBridge,
);
