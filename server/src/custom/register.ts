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
import { adminUserRequestsRouter, profileRequestsRouter, selfRequestsRouter } from '../routes/recent-requests.js';
import { usageAlertSettingsRouter } from '../routes/usage-alert-settings.js';
import { endUsersRouter } from '../routes/end-users.js';
import { profileKnowledgeRouter } from '../routes/profile-knowledge.js';
import { profileConversationsRouter, storedConversationsRouter } from '../routes/profile-conversations.js';
import { contentFilterRouter } from '../routes/content-filter.js';
import { quickAnswersRouter } from '../routes/quick-answers.js';
import { feedbackIngestRouter, profileFeedbackRouter } from '../routes/feedback.js';
import { maybeRollUp } from '../services/usage-daily.js';
import { maybeSendWeeklyReport } from '../services/usage-report.js';
import { usageReportSettingsRouter } from '../routes/usage-report-settings.js';
import { auditMiddleware } from '../services/audit-log.js';
import { auditLogRouter } from '../routes/audit-log.js';
import { playgroundAttribution } from './playground-attribution.js';
import { guestAccessMiddleware } from '../services/guest-access.js';
import { guestAccessAdminRouter, guestInfoRouter } from '../routes/guest-access.js';
import { guestTrialRouter } from '../routes/guest-trial.js';
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
import { xSkillsPublicRouter } from './x-gateway/skills-router.js';
import { getConfigSnapshot } from './x-gateway/config.js';
import { providerAccountsRouter } from './provider-accounts/router.js';
import { autoPingRouter } from './provider-accounts/auto-ping.js';
import { consoleStreamRouter } from './x-gateway/console-stream-router.js';
import { geminiRouter } from './x-gateway/gemini-router.js';
import { xGatewayOllamaRouter } from './x-gateway/ollama-router.js';
import { proxyWebhookRouter } from './proxy-webhook/router.js';

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
  // Change history: every successful dashboard write is recorded once its response has gone out.
  app.use('/api', auditMiddleware);
  // Signed-out visitors: read-only access to the views an administrator opened, before any gate.
  app.use('/api', guestAccessMiddleware);
  app.use('/api/auth/guest', guestInfoRouter);
  // The chat signed-out visitors may try (guest permission try_playground; bounded, nothing stored).
  app.use('/api/guest', guestTrialRouter);
  app.use(['/v1', '/thruline/v1'], (_req, _res, next) => withRoutingSettingsScope(next));
  // When the X Gateway is off, answer 404 immediately before any auth checks
  // so an inactive gateway leaks nothing about its existence.
  app.use('/thruline/v1', (_req, res, next) => {
    if (!getConfigSnapshot().enabled) {
      res.status(404).json({ error: { message: 'Not found', type: 'not_found' } });
      return;
    }
    next();
  });
  // Rate-limiting and usage tracking gate for member personal API keys (/v1, /v1beta and /thruline/v1 inference)
  app.use(['/v1', '/v1beta', '/thruline/v1'], userInferenceGate);
  // Playground chats (unified key + the dashboard session) are attributed to the signed-in account.
  app.use('/v1', playgroundAttribution);
  // Roll finished days of the request log into the long-term daily table, after an inference
  // response has gone out (a time check per request; the work itself at most once a day).
  app.use(['/v1', '/v1beta'], (_req, res, next) => { res.once('finish', () => { maybeRollUp(); maybeSendWeeklyReport(); }); next(); });
  // A web app's own view of the conversations kept for its key; ahead of the profile gate so reading or
  // erasing them costs no allowance.
  app.use('/v1/stored-conversations', storedConversationsRouter);
  // Visitor votes on replies, reported by the web app's backend with its client key (no allowance used).
  app.use('/v1/feedback', feedbackIngestRouter);
  // Same for client-profile (`sk-cp-…`) keys: attribution plus the profile's own RPM cap.
  app.use(['/v1', '/v1beta'], profileInferenceGate);
  // Safe preference metadata is usable by cache editors without granting
  // unrelated system-settings reads. The dedicated router enforces its gates.
  app.use('/api/cache/preferences', requireAuth, cachePreferencesRouter);

  // MiProxy dynamic webhook endpoint for automated proxy updates. It authenticates with its own
  // token, so it is mounted ahead of the session gate that covers the rest of /api/x-gateway.
  app.use(['/api/proxy-webhook', '/api/x-gateway/proxy-webhook'], proxyWebhookRouter);

  // Granular route-level permission gates for upstream-mounted endpoints
  for (const gate of PERMISSION_GATES) installGate(app, gate);
  app.use(['/api/keys', '/api/embeddings', '/api/media', '/api/decisions'], guardKeyAddition);
  // Usage and request cap per client profile; the manage_settings gate for this prefix is installed just above.
  app.use('/api/client-profiles', profileAnalyticsRouter, profileQuotaRouter, profileRestrictionsRouter, profileTestRouter, profileKeyRotationRouter, profileRequestsRouter, endUsersRouter, profileKnowledgeRouter, profileConversationsRouter, contentFilterRouter, quickAnswersRouter, profileFeedbackRouter);
  // Where usage alerts go; the /api/settings gate above covers it (view_settings / edit_settings).
  app.use('/api/settings/usage-alerts', usageAlertSettingsRouter);
  // The weekly usage report; same gate (view_settings / edit_settings, see permission-actions.ts).
  app.use('/api/settings/usage-report', usageReportSettingsRouter);
  // Usage ranking of accounts and client keys; its view_usage gate is in PERMISSION_GATES.
  app.use('/api/usage', usageRouter);

  // Output-token savers (caveman/ponytail). The manage_settings gate above is
  // what makes a write need a settings permission; reads stay open so a
  // member-facing status view can show what is active.
  app.use('/api/savers', outputSaversRouter);

  // The /api/analytics gate above enforces auth + view_logs for this mount too.
  app.use('/api/analytics/provider-tiers', providerTiersRouter);

  // X Gateway (9Router integration): admin-only OpenAI-compatible surface at /thruline/v1.
  // Mounted after the personal-key gate so auth is already resolved.
  app.use('/thruline/v1', xGatewayRouter);
  // Google Gemini Native API Emulation (/v1beta/models/*:generateContent, :streamGenerateContent)
  app.use('/v1beta', geminiRouter);
  app.use('/thruline/v1beta', geminiRouter);
  // Ollama Native API Emulation (/thruline/api/tags, /thruline/api/version, /thruline/api/show)
  app.use('/thruline', xGatewayOllamaRouter);
  // Account logins manage shared credentials with the router's granular key permissions.
  app.use('/api/x-accounts', providerAccountsRouter);
  app.use('/api/x-accounts', autoPingRouter);
  // Real-time terminal log stream for console logs
  app.use('/api/translator', consoleStreamRouter);
  // Gateway switch and default savers. The manage_x_gateway gate above maps each
  // path to its leaf (edit_x_settings for writes, use_x_gateway for reads).
  app.use('/api/x-gateway', xGatewayConsoleRouter);
  // Public skills server for AI coding agents (Claude, Cursor, Codex, OpenCode, Cline)
  app.use('/x-skills', xSkillsPublicRouter);

  // Custom fork routes with their dedicated permission gates
  app.use('/api/auth', externalAuthRouter, customAuthRouter);
  app.use('/api/invites', requireAuth, requireActionPermission('manage_invites'), invitesRouter);
  app.use('/api/audit', requireAuth, requireActionPermission('view_logs'), auditLogRouter);
  app.use('/api/admin/guest-access', requireAuth, requireActionPermission('manage_users'), guestAccessAdminRouter);
  app.use('/api/admin/users', requireAuth, requireActionPermission('manage_users'), adminUsersRouter, adminUserAnalyticsRouter, adminUserQuotaRouter, adminUserRequestsRouter);
  app.use('/api/admin/registration-requests', requireAuth, requireActionPermission('manage_requests'), adminRegistrationRequestsRouter);
  app.use('/api/user', requireAuth, userKeysRouter, selfAnalyticsRouter, selfQuotaRouter, selfRequestsRouter);
}
