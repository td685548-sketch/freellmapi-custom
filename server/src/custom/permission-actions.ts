import type { Request, Response, NextFunction } from 'express';
import type { Permission } from '@freellmapi/shared/user-access.js';
import type { ParentPermission } from '@freellmapi/shared/permissions.js';
import { hasPermission } from '../middleware/requirePermission.js';
import type { SessionUser } from '../services/auth.js';

/** Resolve known operations only. New/unrecognized endpoints require the old
 * parent capability, so a leaf cannot accidentally unlock future features. */
export function permissionForAction(parent: ParentPermission, method: string, url: string): Permission {
  const path = url.split('?')[0]!.replace(/\/+$/, '');
  const read = method === 'GET' || method === 'HEAD';
  if (parent === 'manage_keys') {
    if (/^\/api\/(health|free-tier)(\/|$)/.test(path) || path === '/api/fallback/rate-limit-usage') return read ? 'view_keys' : 'test_keys';
    if (path === '/api/keys' || path === '/api/keys/providers') return read ? 'view_keys' : method === 'POST' && path === '/api/keys' ? 'add_keys' : parent;
    if (path === '/api/keys/export' && read) return 'export_keys';
    if (/^\/api\/keys\/\d+\/reveal$/.test(path) && method === 'POST') return 'reveal_keys';
    if (/^\/api\/keys\/\d+\/cooldowns$/.test(path) && method === 'DELETE') return 'test_keys';
    if (/^\/api\/keys\/\d+$/.test(path)) return method === 'DELETE' ? 'delete_keys' : method === 'PATCH' ? 'edit_keys' : parent;
    if (/^\/api\/keys\/platform\/[^/]+$/.test(path) && method === 'PATCH') return 'edit_keys';
    if (['/api/keys/import', '/api/keys/import-selected', '/api/keys/preview'].includes(path) && method === 'POST') return 'import_keys';
    if (path === '/api/keys/custom' && method === 'POST') return 'add_keys';
    if (['/api/keys/custom/discover-models', '/api/keys/discovered-models'].includes(path) && method === 'POST') return 'manage_key_models';
    if (path === '/api/keys/custom/probe' && method === 'POST') return 'test_keys';
    if (/^\/api\/(embeddings|media|search|decisions)(\/|$)/.test(path)) return 'manage_key_models';
  }
  if (parent === 'manage_users' && path.startsWith('/api/admin/users')) {
    if (read && ['/api/admin/users', '/api/admin/users/usage'].includes(path)) return 'view_users';
    if (read && /^\/api\/admin\/users\/\d+\/analytics$/.test(path)) return 'view_users';
    if (/^\/api\/admin\/users\/\d+\/role$/.test(path) && method === 'PATCH') return 'edit_user_roles';
    if (/^\/api\/admin\/users\/\d+\/permissions$/.test(path) && method === 'PUT') return 'edit_user_permissions';
    if (/^\/api\/admin\/users\/\d+\/quota$/.test(path) && method === 'PUT') return 'edit_user_quotas';
    if (/^\/api\/admin\/users\/\d+\/revoke-sessions$/.test(path) && method === 'POST') return 'revoke_user_sessions';
    if (/^\/api\/admin\/users\/\d+\/revoke-keys$/.test(path) && method === 'POST') return 'revoke_user_keys';
  }
  if (parent === 'manage_invites') {
    if (path === '/api/invites') return read ? 'view_invites' : method === 'POST' ? 'create_invites' : parent;
    if (/^\/api\/invites\/\d+$/.test(path) && method === 'DELETE') return 'revoke_invites';
  }
  if (parent === 'manage_requests') {
    if (path === '/api/admin/registration-requests' && read) return 'view_requests';
    if (/^\/api\/admin\/registration-requests\/\d+\/approve$/.test(path) && method === 'POST') return 'approve_requests';
    if (/^\/api\/admin\/registration-requests\/\d+\/reject$/.test(path) && method === 'POST') return 'reject_requests';
  }
  if (parent === 'manage_backups') {
    if (read && ['/api/backups', '/api/backups/tables', '/api/backups/schedule'].includes(path)) return 'view_backups';
    if (/^\/api\/backups\/\d+\/download$/.test(path) && read) return 'download_backups';
    if (path === '/api/backups' && method === 'POST') return 'create_backups';
    if (path === '/api/backups/schedule' && method === 'PUT') return 'schedule_backups';
    if (/^\/api\/backups\/\d+\/restore$/.test(path) && method === 'POST') return 'restore_backups';
    if (/^\/api\/backups\/\d+$/.test(path) && method === 'DELETE') return 'delete_backups';
  }
  if (parent === 'view_logs') {
    if (path === '/api/logs' && read) return 'view_server_logs';
    if (path === '/api/logs/clear' && method === 'POST') return 'clear_server_logs';
    if ((path.startsWith('/api/analytics/') || ['/api/analytics', '/api/fallback/token-usage', '/api/fallback/quota-forecast'].includes(path)) && read) return 'view_analytics';
  }
  if (parent === 'view_usage' && read) {
    if (path === '/api/usage/accounts') return 'view_usage_accounts';
    if (path === '/api/usage/profiles') return 'view_usage_profiles';
  }
  if (parent === 'manage_settings') {
    if (path === '/api/cache/stats' && read) return 'view_cache';
    if (['/api/cache/config', '/api/cache/preferences'].includes(path) && method === 'PUT') return 'edit_cache';
    if (path === '/api/cache' && method === 'DELETE') return 'clear_cache';
    if (path === '/api/settings/api-key' && read) return 'reveal_gateway_key';
    if (path === '/api/settings/proxy' && read) return 'reveal_proxy_credentials';
    if (path === '/api/settings/api-key/regenerate' && method === 'POST') return 'rotate_gateway_key';
    if (/^\/api\/settings\/url-tokens(?:\/[^/]+)?$/.test(path)) return read ? 'reveal_gateway_key' : 'rotate_gateway_key';
    if (path.startsWith('/api/client-profiles')) return read ? 'view_client_profiles' : 'edit_client_profiles';
    if (path.startsWith('/api/update')) return 'manage_updates';
    if (path.startsWith('/api/compression') || path === '/api/settings/compression') return read ? 'view_settings' : 'manage_compression';
    if (path.startsWith('/api/savers')) return read ? 'view_settings' : 'manage_compression';
    if (/^\/api\/(models|profiles|fallback|premium)(\/|$)/.test(path)) return 'manage_routing';
    if (['version', 'update-check', 'unify', 'fusion', 'enable-mcp', 'anthropic-map', 'gemini-map', 'agent-compatibility', 'output-limit', 'min-context-window', 'guardrails', 'headroom', 'task-weight-share', 'min-reliability-floor', 'provider-moment-attribution', 'proxy', 'proxy/test'].some(name => path === `/api/settings/${name}`)) return read ? 'view_settings' : 'edit_settings';
  }
  return parent;
}

export function requireActionPermission(parent: ParentPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const permission = permissionForAction(parent, req.method, req.originalUrl);
    const user = (req as Request & { user?: SessionUser }).user;
    if ((req.method === 'GET' || req.method === 'HEAD') && req.originalUrl.split('?')[0] === '/api/cache/stats' && hasPermission(user, 'view_analytics')) { next(); return; }
    if ((req.method === 'GET' || req.method === 'HEAD') && ['/api/settings/version', '/api/settings/update-check'].includes(req.originalUrl.split('?')[0]!) && hasPermission(user, 'manage_updates')) { next(); return; }
    if (hasPermission(user, permission)) { next(); return; }
    res.status(403).json({ error: { type: 'forbidden', message: `Permission denied: '${permission}' access required (or parent '${parent}').` } });
  };
}
