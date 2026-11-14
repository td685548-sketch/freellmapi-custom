import type { Scope } from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type BoundTool,
  type ChatToolDefinition,
  type McpBindingPutInput,
  type McpBindingView,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';
import {
  McpConflictError,
  McpNotFoundError,
  McpValidationError,
  hasTable,
  safeJsonParse,
  scopeBindingSettingsKey,
  toToolView,
  type McpServerRow,
  type McpToolRow,
} from './store.js';

interface BoundToolJoinRow extends McpToolRow {
  server_slug: string;
  server_enabled: number;
  server_status: McpServerRow['status'];
  server_paused_until: string | null;
  server_timeout_ms: number;
  server_max_result_bytes: number;
  server_max_concurrency: number;
}

export function validateScope(scope: Scope): Scope {
  let normalized: Scope;
  try {
    normalized = normalizeScope(scope);
  } catch (err) {
    throw new McpValidationError(
      err instanceof Error ? err.message : 'Invalid scope.',
      'invalid_scope',
      400,
    );
  }

  const db = getDb();
  if (normalized.kind === 'profile') {
    const row = db
      .prepare('SELECT id FROM client_profiles WHERE id = ?')
      .get(Number(normalized.id));
    if (!row) {
      throw new McpNotFoundError(`Client profile ${normalized.id} not found.`, 'scope_not_found');
    }
    return normalized;
  }

  if (normalized.kind === 'support_tenant') {
    const exists =
      hasTable(db, 'x_support_tenants') &&
      Boolean(
        db
          .prepare('SELECT id FROM x_support_tenants WHERE id = ?')
          .get(Number(normalized.id)),
      );
    if (!exists) {
      throw new McpNotFoundError(
        `Support tenant ${normalized.id} not found.`,
        'scope_not_found',
      );
    }
    return normalized;
  }

  if (normalized.kind === 'agent') {
    if (!hasTable(db, 'custom_ai_agents')) {
      throw new McpConflictError(
        'scope_unavailable',
        'Agent scope is unavailable until orchestrator (US7) is installed.',
      );
    }
    const row = db
      .prepare('SELECT id FROM custom_ai_agents WHERE id = ?')
      .get(normalized.id);
    if (!row) {
      throw new McpNotFoundError(`Agent ${normalized.id} not found.`, 'scope_not_found');
    }
    return normalized;
  }

  throw new McpValidationError('Unsupported scope kind.', 'invalid_scope', 400);
}

function readScopeFlags(scope: Scope): {
  aiToolsEnabled: boolean;
  scopeActive: boolean;
  maxRounds: number | null;
} {
  const db = getDb();
  if (scope.kind === 'profile') {
    const row = db
      .prepare('SELECT enabled, ai_tools_enabled, ai_tool_max_rounds FROM client_profiles WHERE id = ?')
      .get(Number(scope.id)) as
      | { enabled: number; ai_tools_enabled: number; ai_tool_max_rounds: number | null }
      | undefined;
    return {
      aiToolsEnabled: row?.ai_tools_enabled === 1,
      scopeActive: row?.enabled === 1,
      maxRounds: row?.ai_tool_max_rounds ?? null,
    };
  }

  let scopeActive = false;
  if (scope.kind === 'support_tenant' && hasTable(db, 'x_support_tenants')) {
    const tenant = db
      .prepare('SELECT * FROM x_support_tenants WHERE id = ?')
      .get(Number(scope.id)) as Record<string, unknown> | undefined;
    if (tenant) {
      const enabledOk = tenant.enabled === undefined || tenant.enabled === 1 || tenant.enabled === true;
      const statusOk = tenant.status === undefined || (tenant.status !== 'disabled' && tenant.status !== 'archived');
      scopeActive = enabledOk && statusOk;
    }
  } else if (scope.kind === 'agent' && hasTable(db, 'custom_ai_agents')) {
    const agent = db
      .prepare('SELECT * FROM custom_ai_agents WHERE id = ?')
      .get(scope.id) as Record<string, unknown> | undefined;
    if (agent) {
      const enabledOk = agent.enabled === undefined || agent.enabled === 1 || agent.enabled === true;
      scopeActive = enabledOk;
    }
  }

  const setting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(scopeBindingSettingsKey(scope)) as { value?: string } | undefined;
  const parsed = safeJsonParse<{ enabled?: unknown; maxRounds?: unknown }>(setting?.value, {});
  return {
    aiToolsEnabled: parsed.enabled === true,
    scopeActive,
    maxRounds: typeof parsed.maxRounds === 'number' ? parsed.maxRounds : null,
  };
}

export function isScopeEffectiveSync(scope: Scope): boolean {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch {
    return false;
  }
  const { aiToolsEnabled, scopeActive } = readScopeFlags(norm);
  return aiToolsEnabled && scopeActive;
}

export function getBindings(scope: Scope): McpBindingView {
  const norm = validateScope(scope);
  const db = getDb();
  const { aiToolsEnabled, maxRounds } = readScopeFlags(norm);

  const toolRows = db
    .prepare(
      `SELECT t.*
         FROM custom_ai_tool_bindings b
         JOIN custom_ai_mcp_tools t ON t.id = b.tool_id
        WHERE b.scope_kind = ? AND b.scope_id = ?
        ORDER BY t.id ASC
        LIMIT ?`,
    )
    .all(norm.kind, norm.id, MCP_LIMITS.maxListLimit) as McpToolRow[];

  const tools = toolRows.map(toToolView);
  return {
    scope: norm,
    aiToolsEnabled,
    maxRounds,
    toolIds: tools.map((t) => t.id),
    tools,
  };
}

export function setBindings(scope: Scope, input: McpBindingPutInput): McpBindingView {
  const norm = validateScope(scope);
  if (!Array.isArray(input.toolIds)) {
    throw new McpValidationError('toolIds must be an array of numbers.', 'invalid_request', 400);
  }
  if (typeof input.enabled !== 'boolean') {
    throw new McpValidationError('enabled must be a boolean.', 'invalid_request', 400);
  }

  let maxRounds: number | null = null;
  if (input.maxRounds !== undefined && input.maxRounds !== null) {
    if (
      !Number.isInteger(input.maxRounds) ||
      input.maxRounds < MCP_LIMITS.minRounds ||
      input.maxRounds > MCP_LIMITS.maxRounds
    ) {
      throw new McpValidationError(
        `maxRounds must be an integer between ${MCP_LIMITS.minRounds} and ${MCP_LIMITS.maxRounds}.`,
        'invalid_request',
        400,
      );
    }
    maxRounds = input.maxRounds;
  }

  const uniqueToolIds = Array.from(
    new Set(
      input.toolIds.map((id) => {
        if (!Number.isInteger(id) || id <= 0) {
          throw new McpValidationError('toolIds must contain positive integers.', 'invalid_request', 400);
        }
        return id;
      }),
    ),
  );

  const db = getDb();
  if (uniqueToolIds.length > 0) {
    const placeholders = uniqueToolIds.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT id FROM custom_ai_mcp_tools WHERE id IN (${placeholders})`)
      .all(...uniqueToolIds) as Array<{ id: number }>;
    if (found.length !== uniqueToolIds.length) {
      throw new McpNotFoundError('One or more toolIds do not exist.', 'tool_not_found');
    }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM custom_ai_tool_bindings WHERE scope_kind = ? AND scope_id = ?').run(
      norm.kind,
      norm.id,
    );

    const insertStmt = db.prepare(
      'INSERT INTO custom_ai_tool_bindings (tool_id, scope_kind, scope_id) VALUES (?, ?, ?)',
    );
    for (const toolId of uniqueToolIds) {
      insertStmt.run(toolId, norm.kind, norm.id);
    }

    if (norm.kind === 'profile') {
      db.prepare(
        'UPDATE client_profiles SET ai_tools_enabled = ?, ai_tool_max_rounds = ? WHERE id = ?',
      ).run(input.enabled ? 1 : 0, maxRounds, Number(norm.id));
    } else {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(
        scopeBindingSettingsKey(norm),
        JSON.stringify({ enabled: input.enabled, maxRounds }),
      );
    }
  })();

  return getBindings(norm);
}

export function toolsForScope(
  scope: Scope,
  callerTools?: ChatToolDefinition[],
): BoundTool[] {
  let norm: Scope;
  try {
    norm = normalizeScope(scope);
  } catch {
    return [];
  }

  if (!isScopeEffectiveSync(norm)) {
    return [];
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.*,
              s.slug AS server_slug,
              s.enabled AS server_enabled,
              s.status AS server_status,
              s.paused_until AS server_paused_until,
              s.timeout_ms AS server_timeout_ms,
              s.max_result_bytes AS server_max_result_bytes,
              s.max_concurrency AS server_max_concurrency
         FROM custom_ai_tool_bindings b
         JOIN custom_ai_mcp_tools t ON t.id = b.tool_id
         JOIN custom_ai_mcp_servers s ON s.id = t.server_id
        WHERE b.scope_kind = ?
          AND b.scope_id = ?
          AND t.state = 'allowed'
          AND t.missing_since IS NULL
          AND s.enabled = 1
        ORDER BY t.id ASC
        LIMIT ?`,
    )
    .all(norm.kind, norm.id, MCP_LIMITS.maxListLimit) as BoundToolJoinRow[];

  const callerNames = new Set<string>();
  if (Array.isArray(callerTools)) {
    for (const ct of callerTools) {
      const fnName = ct?.function?.name;
      if (typeof fnName === 'string' && fnName.length > 0) {
        callerNames.add(fnName);
      }
    }
  }

  const nowMs = Date.now();
  const out: BoundTool[] = [];

  for (const r of rows) {
    if (
      r.server_status === 'paused' &&
      r.server_paused_until &&
      Date.parse(r.server_paused_until) > nowMs
    ) {
      continue;
    }
    if (callerNames.has(r.exposed_name)) {
      continue;
    }
    out.push({
      toolId: r.id,
      serverId: r.server_id,
      serverSlug: r.server_slug,
      name: r.name,
      exposedName: r.exposed_name,
      description: r.description,
      inputSchema: safeJsonParse<Record<string, unknown>>(r.input_schema_json, {}),
      outputSchema: safeJsonParse<Record<string, unknown> | null>(r.output_schema_json, null),
      schemaHash: r.schema_hash,
      effect: r.effect,
      timeoutMs: r.server_timeout_ms,
      maxResultBytes: r.server_max_result_bytes,
      maxConcurrency: r.server_max_concurrency,
    });
  }

  return out;
}
