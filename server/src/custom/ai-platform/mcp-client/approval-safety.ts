import type { ScopeKind } from '@freellmapi/shared/ai-platform.js';
import type {
  McpApprovalSnapshot,
  McpSafetyCheckResult,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { isScopeEffectiveSync } from './bindings.js';
import {
  McpConflictError,
  McpServiceError,
  type McpServerRow,
  type McpToolRow,
} from './store.js';

export async function isScopeEffective(scopeKind: ScopeKind, scopeId: string): Promise<boolean> {
  return isScopeEffectiveSync({ kind: scopeKind, id: scopeId });
}

export async function assertScopeEffective(scopeKind: ScopeKind, scopeId: string): Promise<void> {
  const effective = await isScopeEffective(scopeKind, scopeId);
  if (!effective) {
    throw new McpServiceError(
      403,
      'scope_not_effective',
      `Scope ${scopeKind}:${scopeId} is disabled or AI tools are not enabled.`,
    );
  }
}

export async function captureApprovalSnapshot(params: {
  toolId: number;
  scopeKind: ScopeKind;
  scopeId: string;
}): Promise<McpApprovalSnapshot | null> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT t.*,
              s.slug AS server_slug,
              s.url AS server_url,
              s.revision AS server_revision,
              s.credential_generation AS credential_generation
         FROM custom_ai_mcp_tools t
         JOIN custom_ai_mcp_servers s ON s.id = t.server_id
        WHERE t.id = ?`,
    )
    .get(params.toolId) as
    | (McpToolRow & {
        server_slug: string;
        server_url: string;
        server_revision: number;
        credential_generation: number;
      })
    | undefined;

  if (!row) return null;

  return {
    toolId: row.id,
    toolName: row.name,
    serverId: row.server_id,
    serverSlug: row.server_slug,
    serverUrl: row.server_url,
    schemaHash: row.schema_hash,
    serverRevision: row.server_revision,
    credentialGeneration: row.credential_generation,
    effect: row.effect,
    scopeKind: params.scopeKind,
    scopeId: params.scopeId,
    capturedAt: new Date().toISOString(),
  };
}

export function parseApprovalSnapshot(
  snapshotJson: string | null | undefined,
): McpApprovalSnapshot | null {
  if (!snapshotJson || !snapshotJson.trim()) return null;
  try {
    const parsed = JSON.parse(snapshotJson) as Partial<McpApprovalSnapshot>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Number.isInteger(parsed.toolId) ||
      !Number.isInteger(parsed.serverId) ||
      typeof parsed.serverUrl !== 'string' ||
      typeof parsed.schemaHash !== 'string' ||
      typeof parsed.serverRevision !== 'number' ||
      typeof parsed.credentialGeneration !== 'number' ||
      typeof parsed.scopeKind !== 'string' ||
      typeof parsed.scopeId !== 'string'
    ) {
      return null;
    }
    return parsed as McpApprovalSnapshot;
  } catch {
    return null;
  }
}

export async function validateApprovalSnapshot(
  snapshot: McpApprovalSnapshot | null | undefined,
): Promise<McpSafetyCheckResult> {
  if (snapshot === null || snapshot === undefined) {
    return {
      ok: false,
      code: 'legacy_missing_snapshot',
      reason: 'Approval record has no immutable execution snapshot.',
    };
  }

  if (
    !Number.isInteger(snapshot.toolId) ||
    !Number.isInteger(snapshot.serverId) ||
    !snapshot.serverUrl ||
    !snapshot.schemaHash
  ) {
    return {
      ok: false,
      code: 'invalid_snapshot',
      reason: 'Approval execution snapshot is malformed.',
    };
  }

  const db = getDb();
  const server = db
    .prepare('SELECT * FROM custom_ai_mcp_servers WHERE id = ?')
    .get(snapshot.serverId) as McpServerRow | undefined;
  if (!server) {
    return {
      ok: false,
      code: 'server_not_found',
      reason: `MCP server ${snapshot.serverId} no longer exists.`,
    };
  }

  if (
    server.enabled !== 1 ||
    server.status === 'paused' ||
    (server.paused_until && Date.parse(server.paused_until) > Date.now())
  ) {
    return {
      ok: false,
      code: 'server_paused',
      reason: `MCP server ${server.slug} is disabled or paused.`,
    };
  }

  if (server.url !== snapshot.serverUrl) {
    return {
      ok: false,
      code: 'server_url_changed',
      reason: 'MCP server URL changed after approval was requested.',
    };
  }

  if (server.credential_generation !== snapshot.credentialGeneration) {
    return {
      ok: false,
      code: 'credential_changed',
      reason: 'MCP server credentials changed after approval was requested.',
    };
  }

  const tool = db
    .prepare('SELECT * FROM custom_ai_mcp_tools WHERE id = ?')
    .get(snapshot.toolId) as McpToolRow | undefined;
  if (!tool || tool.server_id !== snapshot.serverId) {
    return {
      ok: false,
      code: 'tool_not_found',
      reason: `MCP tool ${snapshot.toolId} no longer exists on server ${snapshot.serverId}.`,
    };
  }

  if (tool.state !== 'allowed' || tool.missing_since !== null) {
    return {
      ok: false,
      code: 'tool_not_allowed',
      reason: `MCP tool ${tool.name} is no longer allowed or is missing.`,
    };
  }

  if (tool.schema_hash !== snapshot.schemaHash) {
    return {
      ok: false,
      code: 'schema_changed',
      reason: `MCP tool ${tool.name} schema changed after approval was requested.`,
    };
  }

  const effective = await isScopeEffective(snapshot.scopeKind, snapshot.scopeId);
  if (!effective) {
    return {
      ok: false,
      code: 'scope_not_effective',
      reason: `Scope ${snapshot.scopeKind}:${snapshot.scopeId} is no longer active.`,
    };
  }

  const binding = db
    .prepare(
      `SELECT 1 FROM custom_ai_tool_bindings
        WHERE scope_kind = ? AND scope_id = ? AND tool_id = ?`,
    )
    .get(snapshot.scopeKind, snapshot.scopeId, snapshot.toolId);
  if (!binding) {
    return {
      ok: false,
      code: 'binding_missing',
      reason: `Tool ${tool.name} is no longer bound to ${snapshot.scopeKind}:${snapshot.scopeId}.`,
    };
  }

  return { ok: true, code: 'ok' };
}

export async function assertApprovalExecutable(
  snapshotJson: string | null | undefined,
): Promise<McpApprovalSnapshot> {
  if (!snapshotJson || !snapshotJson.trim()) {
    throw new McpConflictError(
      'legacy_missing_snapshot',
      'Approval record has no immutable execution snapshot.',
    );
  }
  const parsed = parseApprovalSnapshot(snapshotJson);
  if (!parsed) {
    throw new McpConflictError(
      'invalid_snapshot',
      'Approval execution snapshot is malformed.',
    );
  }
  const check = await validateApprovalSnapshot(parsed);
  if (!check.ok) {
    throw new McpConflictError(
      check.code,
      check.reason ?? 'Approval snapshot failed safety validation.',
    );
  }
  return parsed;
}
