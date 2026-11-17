import type { Request, Response, NextFunction } from 'express';
import type { SessionUser } from '../services/auth.js';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { normalizeBaseUrl } from '../lib/endpoint-scope.js';
import { resolveProvider } from '../providers/index.js';
import { isAnonymousCredential } from '../providers/openai-compat.js';
import { hasPermission } from '../middleware/requirePermission.js';
import type { Permission } from '@freellmapi/shared/user-access.js';

/** Some legacy add flows intentionally upsert. A new add-only grant must not
 * silently inherit their edit/model-management powers. Never expose old secrets. */
export function guardKeyAddition(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  const user = (req as Request & { user?: SessionUser }).user;
  const needs = (permission: Permission): boolean => {
    if (hasPermission(user, permission)) return false;
    res.status(403).json({ error: { type: 'forbidden', message: `Permission denied: '${permission}' required for this existing credential or model operation.` } });
    return true;
  };
  if (req.method === 'DELETE' && /^\/api\/(embeddings|media|decisions)\/custom\//.test(path)) {
    if (needs('delete_keys')) return;
    next(); return;
  }
  if (req.method !== 'POST') { next(); return; }
  const custom = /^\/api\/(keys|embeddings|media|decisions)\/custom$/.test(path);
  if (path !== '/api/keys' && !custom) { next(); return; }
  if (custom && needs('add_keys')) return;
  const body = req.body ?? {};
  if (custom && (body.model || (Array.isArray(body.models) && body.models.length)) && needs('manage_key_models')) return;
  if (hasPermission(user, 'edit_keys')) { next(); return; }
  const platform = typeof body.platform === 'string' ? body.platform : '';
  if (!custom && !resolveProvider(platform)?.keyless) { next(); return; }

  let rows: unknown[] = [];
  if (custom) {
    let targetBaseUrl: string | null = null;
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      targetBaseUrl = normalizeBaseUrl(body.baseUrl);
    } else if (
      (typeof body.keyId === 'number' && Number.isSafeInteger(body.keyId) && body.keyId > 0) ||
      (typeof body.keyId === 'string' && /^[1-9]\d*$/.test(body.keyId.trim()))
    ) {
      const refRow = getDb()
        .prepare("SELECT base_url FROM api_keys WHERE id = ? AND platform = 'custom'")
        .get(Number(body.keyId)) as { base_url: string | null } | undefined;
      targetBaseUrl = refRow?.base_url ?? null;
    }
    if (!targetBaseUrl) { next(); return; }
    rows = getDb()
      .prepare("SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ?")
      .all(targetBaseUrl);
  } else {
    rows = getDb().prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys WHERE platform = ?').all(platform);
  }

  const secrets = (rows as { encrypted_key: string; iv: string; auth_tag: string }[]).map(r => {
    try { return decrypt(r.encrypted_key, r.iv, r.auth_tag); } catch { return null; }
  });
  const submitted = custom ? body.apiKey : body.key;
  const value = typeof submitted === 'string' ? submitted.trim() : '';
  const changesExisting = custom
    ? secrets.length > 0 && (!value || secrets.includes(value) || secrets.every(s => s === 'no-key') || body.groupLabel !== undefined || body.label !== undefined)
    : secrets.length > 0 && (!value || secrets.some(s => isAnonymousCredential(s)));
  if (changesExisting && needs('edit_keys')) return;
  next();
}
