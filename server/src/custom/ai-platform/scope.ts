import type { Scope, ScopeKind } from '@freellmapi/shared/ai-platform.js';
import { getDb } from '../../db/index.js';

export type { Scope, ScopeKind };

/**
 * Validates and normalizes a scope:
 * - `profile` and `support_tenant` must be positive integers, normalized to canonical string form.
 * - `agent` must be a non-empty trimmed string.
 */
export function normalizeScope(scope: Scope): Scope {
  const idTrimmed = String(scope.id ?? '').trim();
  if (scope.kind === 'profile' || scope.kind === 'support_tenant') {
    if (!/^\d+$/.test(idTrimmed)) {
      throw new Error(`Invalid ${scope.kind} scope id: '${scope.id}'`);
    }
    const num = Number(idTrimmed);
    if (!Number.isSafeInteger(num) || num <= 0) {
      throw new Error(`Invalid ${scope.kind} scope id: '${scope.id}'`);
    }
    return { kind: scope.kind, id: String(num) };
  }
  if (scope.kind === 'agent') {
    if (!idTrimmed) {
      throw new Error('Invalid agent scope id: empty');
    }
    return { kind: 'agent', id: idTrimmed };
  }
  throw new Error(`Unsupported scope kind: '${String(scope.kind)}'`);
}

/** Parses URL `:scope` segments (`profile`, `support-tenant` / `support_tenant`, `agent`). */
export function parseScopeParam(kindRaw: string, idRaw: string): Scope {
  const normalizedKind: ScopeKind =
    kindRaw === 'support-tenant' || kindRaw === 'support_tenant'
      ? 'support_tenant'
      : (kindRaw as ScopeKind);
  return normalizeScope({ kind: normalizedKind, id: idRaw });
}

/**
 * Purges scope-owned AI platform state in `settings` (prefix `ai_platform_scope_<kind>_<id>_*`).
 * Never deletes global flags/retention or other scopes, and does not reference unmigrated pillar tables.
 */
export function purgeScope(kind: ScopeKind, id: string): number {
  const norm = normalizeScope({ kind, id });
  const db = getDb();
  const prefix = `ai_platform_scope_${norm.kind}_${norm.id}_`;
  const result = db.prepare('DELETE FROM settings WHERE substr(key, 1, length(?)) = ?').run(prefix, prefix);
  return result.changes;
}
