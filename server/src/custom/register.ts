import type { Express, NextFunction, Request, Response } from 'express';
import type { ParentPermission } from '@freellmapi/shared/permissions.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { adminUsersRouter } from '../routes/admin-users.js';
import { adminRegistrationRequestsRouter } from '../routes/admin-registration-requests.js';
import { invitesRouter } from '../routes/invites.js';
import { userKeysRouter } from '../routes/user-keys.js';
import { adminUserAnalyticsRouter, selfAnalyticsRouter } from '../routes/user-analytics.js';
import { externalAuthRouter } from '../routes/external-auth.js';
import { customAuthRouter } from './auth.js';
import { userInferenceGate } from '../middleware/user-rate-limit.js';
import { profileInferenceGate } from '../middleware/profile-gate.js';
import { profileAnalyticsRouter } from '../routes/profile-analytics.js';
import { usageRouter } from '../routes/usage.js';
import { profileRestrictionsRouter } from '../routes/profile-restrictions.js';
import { profileTestRouter } from '../routes/profile-test.js';
import { profileKeyRotationRouter } from '../routes/profile-key-rotation.js';
import { adminUserQuotaRouter, profileQuotaRouter, selfQuotaRouter } from '../routes/usage-quota.js';
import { withRoutingSettingsScope } from '../db/routing-settings-scope.js';
import { providerTiersRouter } from '../routes/provider-tiers.js';
import { requireActionPermission } from './permission-actions.js';
import { guardKeyAddition } from './key-addition-guard.js';
import { cachePreferencesRouter } from '../routes/cache-preferences.js';
import { outputSaversRouter } from './output-savers/router.js';
import { statusCache } from './status-cache.js';
import { xGatewayRouter } from './x-gateway/router.js';
import { xGatewayConsoleRouter } from './x-gateway/console-router.js';
import { getConfigSnapshot } from './x-gateway/config.js';
import { providerAccountsRouter } from './provider-accounts/router.js';

// Everything this fork adds to the HTTP surface is wired here, so upstream's
// app.ts keeps a handful of added lines instead of edited mount statements.
//
// The gates below are registered BEFORE upstream's own mounts in app.ts so that
// granular RBAC permissions (manage_keys, manage_settings, etc.) are strictly
// enforced before upstream route handlers run.

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** Methods that change server state. `GET` is never one of them. */
export const WRITE_METHODS: readonly HttpMethod[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

export interface PermissionGate {
  /** Mount prefix, matched the way `app.use` matches it. */
  path: string | string[];
  permission: ParentPermission;
  /** Restricted to these methods; omitted means every method, reads included. */
  methods?: readonly HttpMethod[];
}

/**
 * Gates on the upstream-mounted `/api/*` surfaces. A list that nothing consumes
 * is not a control, so `registerCustomRoutes` installs exactly these entries and
 * `__tests__/custom/surface.test.ts` keeps a frozen copy of them, demanding the
 * 403 independently — the failure mode being a merge that shrinks this file while
 * the app still boots and serves traffic.
 *
 * Reads stay open to any signed-in account where the member-facing dashboard needs
 * them: `PlaygroundPage` fetches `/api/profiles` for the chain picker and the
 * command palette fetches `/api/fallback`, so enforcement there is on the methods
 * that rewrite server-wide routing, catalog, or cache state. Reads whose payload
 * *is* provider-key material or install-wide quota are gated in full.
 */
export const PERMISSION_GATES: readonly PermissionGate[] = [
  { path: '/api/keys', permission: 'manage_keys' },
  { path: '/api/client-profiles', permission: 'manage_settings' },
  { path: '/api/settings', permission: 'manage_settings' },
  { path: '/api/update', permission: 'manage_settings' },
  { path: '/api/backups', permission: 'manage_backups' },
  { path: ['/api/logs', '/api/analytics'], permission: 'view_logs' },
  { path: '/api/usage', permission: 'view_usage' },

  // The key roster, its health errors, and endpoints that decrypt and spend a
  // stored provider key on demand.
  { path: '/api/health', permission: 'manage_keys' },
  { path: '/api/free-tier', permission: 'manage_keys' },
  { path: '/api/fallback/rate-limit-usage', permission: 'manage_keys' },
  { path: ['/api/fallback/token-usage', '/api/fallback/quota-forecast'], permission: 'view_logs' },

  // Server-wide configuration: writable methods only.
  { path: '/api/profiles', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/models', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/fallback', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/cache', permission: 'manage_settings' },
  { path: '/api/compression', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/savers', permission: 'manage_settings', methods: WRITE_METHODS },
  { path: '/api/premium', permission: 'manage_settings', methods: WRITE_METHODS },

  // Modality catalogs reach the same credential store as the Keys page — they can
  // create, delete, or probe a stored key — so their writes need manage_keys.
  { path: ['/api/embeddings', '/api/media', '/api/search', '/api/decisions'], permission: 'manage_keys', methods: WRITE_METHODS },

  // X Gateway (9Router integration): admin-only gateway console and API management.
  { path: '/api/x-gateway', permission: 'manage_x_gateway' },
];

function installGate(app: Express, gate: PermissionGate): void {
  const enforced = requireActionPermission(gate.permission);
  const methods = gate.methods;
  const scoped = (req: Request, res: Response, next: NextFunction): void => {
    if (methods && !methods.includes(req.method as HttpMethod)) {
      next();
      return;
    }
    enforced(req, res, next);
  };
  app.use(gate.path, requireAuth, scoped);
}

export function registerCustomRoutes(app: Express): void {
  // Public probes answer from a 5 s copy so anonymous callers cannot turn them into database load.
  app.use(['/livez', '/readyz'], statusCache);
  app.use('/api', (_req, _res, next) => withRoutingSettingsScope(next));
  app.use(['/v1', '/x/v1'], (_req, _res, next) => withRoutingSettingsScope(next));
  // When the X Gateway is off, answer 404 immediately before any auth checks
  // so an inactive gateway leaks nothing about its existence.
  app.use('/x/v1', (_req, res, next) => {
    if (!getConfigSnapshot().enabled) {
      res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
      return;
    }
    next();
  });
  // Rate-limiting and usage tracking gate for member personal API keys (/v1, /v1beta and /x/v1 inference)
  app.use(['/v1', '/v1beta', '/x/v1'], userInferenceGate);
  // Same for client-profile (`sk-cp-…`) keys: attribution plus the profile's own RPM cap.
  app.use(['/v1', '/v1beta'], profileInferenceGate);
  // Safe preference metadata is usable by cache editors without granting
  // unrelated system-settings reads. The dedicated router enforces its gates.
  app.use('/api/cache/preferences', requireAuth, cachePreferencesRouter);

  // Granular route-level permission gates for upstream-mounted endpoints
  for (const gate of PERMISSION_GATES) installGate(app, gate);
  app.use(['/api/keys', '/api/embeddings', '/api/media', '/api/decisions'], guardKeyAddition);
  // Usage and request cap per client profile; the manage_settings gate for this prefix is installed just above.
  app.use('/api/client-profiles', profileAnalyticsRouter, profileQuotaRouter, profileRestrictionsRouter, profileTestRouter, profileKeyRotationRouter);
  // Usage ranking of accounts and client keys; its view_usage gate is in PERMISSION_GATES.
  app.use('/api/usage', usageRouter);

  // Output-token savers (caveman/ponytail). The manage_settings gate above is
  // what makes a write need a settings permission; reads stay open so a
  // member-facing status view can show what is active.
  app.use('/api/savers', outputSaversRouter);

  // The /api/analytics gate above enforces auth + view_logs for this mount too.
  app.use('/api/analytics/provider-tiers', providerTiersRouter);

  // X Gateway (9Router integration): admin-only OpenAI-compatible surface at /x/v1.
  // Mounted after the personal-key gate so auth is already resolved.
  app.use('/x/v1', xGatewayRouter);
  // Account logins manage shared credentials with the router's granular key permissions.
  app.use('/api/x-accounts', providerAccountsRouter);
  // Gateway switch and default savers. The manage_x_gateway gate above maps each
  // path to its leaf (edit_x_settings for writes, use_x_gateway for reads).
  app.use('/api/x-gateway', xGatewayConsoleRouter);

  // Custom fork routes with their dedicated permission gates
  app.use('/api/auth', externalAuthRouter, customAuthRouter);
  app.use('/api/invites', requireAuth, requireActionPermission('manage_invites'), invitesRouter);
  app.use('/api/admin/users', requireAuth, requireActionPermission('manage_users'), adminUsersRouter, adminUserAnalyticsRouter, adminUserQuotaRouter);
  app.use('/api/admin/registration-requests', requireAuth, requireActionPermission('manage_requests'), adminRegistrationRequestsRouter);
  app.use('/api/user', requireAuth, userKeysRouter, selfAnalyticsRouter, selfQuotaRouter);
}
