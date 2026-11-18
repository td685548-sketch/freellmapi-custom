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
 * Purges scope-owned AI platform state in `settings` (prefix `ai_platform_scope_<kind>_<id>_*`)
 * and output-guard scope tables (`custom_ai_output_policies`, `custom_ai_guard_events`).
 * Never deletes global flags/retention, MCP config, or other scopes, and checks table existence
 * before touching pillar tables.
 */
export function purgeScope(kind: ScopeKind, id: string): number {
  const norm = normalizeScope({ kind, id });
  const db = getDb();
  const prefix = `ai_platform_scope_${norm.kind}_${norm.id}_`;
  let total = db
    .prepare('DELETE FROM settings WHERE substr(key, 1, length(?)) = ?')
    .run(prefix, prefix).changes;

  for (const table of [
    'custom_ai_output_policies',
    'custom_ai_guard_events',
    'custom_ai_retrieval_settings',
    'custom_ai_chunk_embeddings',
    'custom_ai_index_jobs',
    'custom_ai_embedding_usage',
    'custom_ai_semantic_cache_settings',
    'custom_ai_semantic_cache_entries',
    'custom_ai_semantic_cache_metrics',
  ] as const) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists) {
      total += db
        .prepare(`DELETE FROM ${table} WHERE scope_kind = ? AND scope_id = ?`)
        .run(norm.kind, norm.id).changes;
    }
  }
  return total;
}
