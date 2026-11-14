import {
  MCP_LIMITS,
  MCP_SLUG_REGEX,
  type BoundTool,
  type McpAuthKind,
  type McpDeleteServerResponse,
  type McpInUseErrorDetails,
  type McpServerInput,
  type McpServerPatch,
  type McpServerView,
  type McpSyncServerResponse,
  type McpTestServerResponse,
  type McpToolDescriptor,
  type McpToolReviewPatch,
  type McpToolView,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import { decrypt, encrypt } from '../../../lib/crypto.js';
import { isPillarEnabled } from '../flags.js';
import {
  McpConflictError,
  McpNotFoundError,
  McpPillarDisabledError,
  McpServiceError,
  McpValidationError,
  buildExposedToolName,
  computeSchemaHash,
  getAllowedInternalOrigins,
  hasTable,
  safeJsonParse,
  setAllowedInternalOrigins,
  toServerView,
  toToolView,
  type McpServerRow,
  type McpToolRow,
  type McpTransportClient,
  type McpTransportConfig,
} from './store.js';

export { getAllowedInternalOrigins, setAllowedInternalOrigins };
export type { McpTransportConfig, McpTransportClient };

const VALID_AUTH_KINDS = new Set<McpAuthKind>(['none', 'bearer', 'header']);

function sanitizeErrorMessage(err: unknown, secret?: string | null): string {
  let msg = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (secret && secret.length > 0) {
    msg = msg.split(secret).join('[redacted]');
  }
  msg = msg.replace(/\bBearer\s+[A-Za-z0-9._-]{6,}\b/gi, 'Bearer [redacted]');
  return msg.slice(0, 500);
}

function validateSlug(slug: string): string {
  const trimmed = String(slug ?? '').trim();
  if (!MCP_SLUG_REGEX.test(trimmed)) {
    throw new McpValidationError(
      'slug must match ^[a-z0-9-]{1,32}$.',
      'invalid_slug',
      400,
    );
  }
  return trimmed;
}

function validateName(name: string): string {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || trimmed.length > MCP_LIMITS.nameMaxChars) {
    throw new McpValidationError(
      `name must be between 1 and ${MCP_LIMITS.nameMaxChars} characters.`,
      'invalid_name',
      400,
    );
  }
  return trimmed;
}

function validateServerUrl(rawUrl: string): string {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed || trimmed.length > MCP_LIMITS.urlMaxChars) {
    throw new McpValidationError('Invalid server URL.', 'unsafe_url', 422);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError('Invalid server URL format.', 'unsafe_url', 422);
  }
  if (parsed.username || parsed.password) {
    throw new McpValidationError('URL must not contain embedded credentials.', 'unsafe_url', 422);
  }
  if (parsed.protocol === 'https:') {
    return parsed.toString();
  }
  if (parsed.protocol === 'http:') {
    const allowed = getAllowedInternalOrigins();
    if (!allowed.includes(parsed.origin)) {
      throw new McpValidationError(
        'HTTP MCP servers require an exact origin in allowed-internal-hosts.',
        'unsafe_url',
        422,
      );
    }
    return parsed.toString();
  }
  throw new McpValidationError('URL protocol must be https (or allowlisted http).', 'unsafe_url', 422);
}

function validateAuth(
  authKind: McpAuthKind,
  authHeaderName: string | null | undefined,
): { authKind: McpAuthKind; authHeaderName: string | null } {
  if (!VALID_AUTH_KINDS.has(authKind)) {
    throw new McpValidationError("authKind must be 'none', 'bearer', or 'header'.", 'invalid_auth', 400);
  }
  if (authKind === 'header') {
    const header = String(authHeaderName ?? '').trim();
    if (!header || header.length > MCP_LIMITS.headerNameMaxChars || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
      throw new McpValidationError('Valid authHeaderName is required when authKind is header.', 'invalid_auth', 400);
    }
    return { authKind, authHeaderName: header };
  }
  return { authKind, authHeaderName: null };
}

function validateBoundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new McpValidationError(`${field} must be an integer between ${min} and ${max}.`, 'invalid_request', 400);
  }
  return value;
}

function getServerRowOrThrow(id: number): McpServerRow {
  const row = getDb().prepare('SELECT * FROM custom_ai_mcp_servers WHERE id = ?').get(id) as
    | McpServerRow
    | undefined;
  if (!row) {
    throw new McpNotFoundError(`MCP server ${id} not found.`);
  }
  return row;
}

async function resolveTransportClient(injected?: McpTransportClient): Promise<McpTransportClient> {
  if (injected) return injected;
  const transportModulePath = './transport.js';
  try {
    const mod = (await import(transportModulePath)) as Partial<McpTransportClient>;
    if (typeof mod.mcpInitialize === 'function' && typeof mod.mcpListTools === 'function') {
      return mod as McpTransportClient;
    }
  } catch {
    // Fall through to structured error
  }
  throw new McpServiceError(
    501,
    'transport_unavailable',
    'MCP HTTP transport module is not installed.',
  );
}

// ── Public Registry Functions ────────────────────────────────────────────────

export function listServers(): McpServerView[] {
  const rows = getDb()
    .prepare('SELECT * FROM custom_ai_mcp_servers ORDER BY id ASC LIMIT ?')
    .all(MCP_LIMITS.maxListLimit) as McpServerRow[];
  return rows.map(toServerView);
}

export async function createServer(
  input: McpServerInput,
  actorId: number | null,
): Promise<McpServerView> {
  const slug = validateSlug(input.slug);
  const name = validateName(input.name);
  const url = validateServerUrl(input.url);
  const { authKind, authHeaderName } = validateAuth(input.authKind, input.authHeaderName);
  const enabled = input.enabled === false ? 0 : 1;
  const timeoutMs = validateBoundedInt(
    input.timeoutMs,
    MCP_LIMITS.defaultTimeoutMs,
    MCP_LIMITS.minTimeoutMs,
    MCP_LIMITS.maxTimeoutMs,
    'timeoutMs',
  );
  const maxResultBytes = validateBoundedInt(
    input.maxResultBytes,
    MCP_LIMITS.defaultMaxResultBytes,
    MCP_LIMITS.minResultBytes,
    MCP_LIMITS.maxResultBytes,
    'maxResultBytes',
  );
  const maxConcurrency = validateBoundedInt(
    input.maxConcurrency,
    MCP_LIMITS.defaultMaxConcurrency,
    MCP_LIMITS.minConcurrency,
    MCP_LIMITS.maxConcurrency,
    'maxConcurrency',
  );

  let authCiphertext: string | null = null;
  let authIv: string | null = null;
  let authTag: string | null = null;
  if (typeof input.secret === 'string' && input.secret.length > 0) {
    if (input.secret.length > MCP_LIMITS.secretMaxChars) {
      throw new McpValidationError('secret exceeds maximum length.', 'invalid_auth', 400);
    }
    const enc = encrypt(input.secret);
    authCiphertext = enc.encrypted;
    authIv = enc.iv;
    authTag = enc.authTag;
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM custom_ai_mcp_servers WHERE slug = ?').get(slug);
  if (existing) {
    throw new McpConflictError('slug_conflict', `MCP server slug '${slug}' already exists.`);
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO custom_ai_mcp_servers (
        slug, name, url, auth_kind, auth_header_name,
        auth_ciphertext, auth_iv, auth_tag,
        enabled, timeout_ms, max_result_bytes, max_concurrency,
        status, created_by, created_at, updated_at, revision, credential_generation
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, 1, 1)`,
    )
    .run(
      slug,
      name,
      url,
      authKind,
      authHeaderName,
      authCiphertext,
      authIv,
      authTag,
      enabled,
      timeoutMs,
      maxResultBytes,
      maxConcurrency,
      actorId,
      now,
      now,
    );

  return toServerView(getServerRowOrThrow(Number(result.lastInsertRowid)));
}

export async function updateServer(
  id: number,
  patch: McpServerPatch,
  _actorId: number | null,
): Promise<McpServerView> {
  if (!Number.isInteger(patch.revision) || patch.revision < 1) {
    throw new McpValidationError('revision must be a positive integer.', 'invalid_revision', 400);
  }

  const current = getServerRowOrThrow(id);
  if (current.revision !== patch.revision) {
    throw new McpConflictError('revision_conflict', 'Server revision conflict.', {
      current: toServerView(current),
    });
  }

  const nextSlug = patch.slug !== undefined ? validateSlug(patch.slug) : current.slug;
  const nextName = patch.name !== undefined ? validateName(patch.name) : current.name;
  const nextUrl = patch.url !== undefined ? validateServerUrl(patch.url) : current.url;
  const nextAuthKind = patch.authKind ?? current.auth_kind;
  const nextHeaderCandidate =
    patch.authHeaderName !== undefined ? patch.authHeaderName : current.auth_header_name;
  const { authKind, authHeaderName } = validateAuth(nextAuthKind, nextHeaderCandidate);

  const nextEnabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
  const nextTimeoutMs = validateBoundedInt(
    patch.timeoutMs,
    current.timeout_ms,
    MCP_LIMITS.minTimeoutMs,
    MCP_LIMITS.maxTimeoutMs,
    'timeoutMs',
  );
  const nextMaxResultBytes = validateBoundedInt(
    patch.maxResultBytes,
    current.max_result_bytes,
    MCP_LIMITS.minResultBytes,
    MCP_LIMITS.maxResultBytes,
    'maxResultBytes',
  );
  const nextMaxConcurrency = validateBoundedInt(
    patch.maxConcurrency,
    current.max_concurrency,
    MCP_LIMITS.minConcurrency,
    MCP_LIMITS.maxConcurrency,
    'maxConcurrency',
  );

  let nextCiphertext = current.auth_ciphertext;
  let nextIv = current.auth_iv;
  let nextTag = current.auth_tag;
  let credentialChanged =
    nextUrl !== current.url ||
    authKind !== current.auth_kind ||
    authHeaderName !== current.auth_header_name;

  if (patch.secret === null) {
    nextCiphertext = null;
    nextIv = null;
    nextTag = null;
    credentialChanged = true;
  } else if (typeof patch.secret === 'string') {
    if (patch.secret.length > MCP_LIMITS.secretMaxChars) {
      throw new McpValidationError('secret exceeds maximum length.', 'invalid_auth', 400);
    }
    if (patch.secret.length === 0) {
      nextCiphertext = null;
      nextIv = null;
      nextTag = null;
    } else {
      const enc = encrypt(patch.secret);
      nextCiphertext = enc.encrypted;
      nextIv = enc.iv;
      nextTag = enc.authTag;
    }
    credentialChanged = true;
  }

  const db = getDb();
  if (nextSlug !== current.slug) {
    const dup = db
      .prepare('SELECT id FROM custom_ai_mcp_servers WHERE slug = ? AND id != ?')
      .get(nextSlug, id);
    if (dup) {
      throw new McpConflictError('slug_conflict', `MCP server slug '${nextSlug}' already exists.`);
    }
  }

  const nextGeneration = credentialChanged
    ? current.credential_generation + 1
    : current.credential_generation;
  const now = new Date().toISOString();

  const updateRes = db
    .prepare(
      `UPDATE custom_ai_mcp_servers
          SET slug = ?,
              name = ?,
              url = ?,
              auth_kind = ?,
              auth_header_name = ?,
              auth_ciphertext = ?,
              auth_iv = ?,
              auth_tag = ?,
              enabled = ?,
              timeout_ms = ?,
              max_result_bytes = ?,
              max_concurrency = ?,
              updated_at = ?,
              revision = revision + 1,
              credential_generation = ?
        WHERE id = ? AND revision = ?`,
    )
    .run(
      nextSlug,
      nextName,
      nextUrl,
      authKind,
      authHeaderName,
      nextCiphertext,
      nextIv,
      nextTag,
      nextEnabled,
      nextTimeoutMs,
      nextMaxResultBytes,
      nextMaxConcurrency,
      now,
      nextGeneration,
      id,
      patch.revision,
    );

  if (updateRes.changes === 0) {
    const latest = getServerRowOrThrow(id);
    throw new McpConflictError('revision_conflict', 'Server revision conflict.', {
      current: toServerView(latest),
    });
  }

  return toServerView(getServerRowOrThrow(id));
}

export function deleteServer(
  id: number,
  opts?: { force?: boolean },
): McpDeleteServerResponse {
  getServerRowOrThrow(id);
  const db = getDb();

  if (!opts?.force) {
    const boundScopes = db
      .prepare(
        `SELECT DISTINCT b.scope_kind, b.scope_id
           FROM custom_ai_tool_bindings b
           JOIN custom_ai_mcp_tools t ON t.id = b.tool_id
          WHERE t.server_id = ?`,
      )
      .all(id) as Array<{ scope_kind: string; scope_id: string }>;

    if (boundScopes.length > 0) {
      const details: McpInUseErrorDetails = {
        profiles: [],
        supportTenants: [],
        agents: [],
      };
      const hasProfiles = hasTable(db, 'client_profiles');
      for (const s of boundScopes) {
        if (s.scope_kind === 'profile') {
          const pid = Number(s.scope_id);
          const pRow = hasProfiles
            ? (db.prepare('SELECT id, name FROM client_profiles WHERE id = ?').get(pid) as
                | { id: number; name: string }
                | undefined)
            : undefined;
          details.profiles.push({ id: pid, name: pRow?.name ?? `profile:${s.scope_id}` });
        } else if (s.scope_kind === 'support_tenant') {
          details.supportTenants.push({ id: s.scope_id });
        } else if (s.scope_kind === 'agent') {
          details.agents.push({ id: s.scope_id });
        }
      }
      throw new McpConflictError(
        'in_use',
        'MCP server has tools currently bound to one or more scopes.',
        details,
      );
    }
  }

  db.prepare('DELETE FROM custom_ai_mcp_servers WHERE id = ?').run(id);
  return { ok: true };
}

export function getServerTransportConfig(serverId: number): McpTransportConfig {
  const row = getServerRowOrThrow(serverId);
  let secret: string | null = null;
  if (row.auth_ciphertext && row.auth_iv && row.auth_tag) {
    secret = decrypt(row.auth_ciphertext, row.auth_iv, row.auth_tag);
  }
  return {
    serverId: row.id,
    slug: row.slug,
    url: row.url,
    authKind: row.auth_kind,
    authHeaderName: row.auth_header_name,
    secret,
    timeoutMs: row.timeout_ms,
    maxResultBytes: row.max_result_bytes,
    maxConcurrency: row.max_concurrency,
    revision: row.revision,
    credentialGeneration: row.credential_generation,
  };
}

export function recordServerOutcome(
  serverId: number,
  outcome:
    | { ok: true; protocolVersion?: string; serverInfo?: Record<string, unknown> }
    | { ok: false; error: string },
): McpServerView {
  const row = getServerRowOrThrow(serverId);
  const db = getDb();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (outcome.ok) {
    db.prepare(
      `UPDATE custom_ai_mcp_servers
          SET status = 'ok',
              last_error = NULL,
              last_connected_at = ?,
              fail_count = 0,
              paused_until = NULL,
              protocol_version = COALESCE(?, protocol_version),
              server_info_json = COALESCE(?, server_info_json),
              updated_at = ?
        WHERE id = ?`,
    ).run(
      nowIso,
      outcome.protocolVersion ?? null,
      outcome.serverInfo ? JSON.stringify(outcome.serverInfo) : null,
      nowIso,
      serverId,
    );
    return toServerView(getServerRowOrThrow(serverId));
  }

  const nextFailCount = row.fail_count + 1;
  let nextStatus: McpServerRow['status'] = 'error';
  let nextPausedUntil: string | null = null;
  if (nextFailCount >= MCP_LIMITS.circuitBreakerThreshold) {
    nextStatus = 'paused';
    const exponent = nextFailCount - MCP_LIMITS.circuitBreakerThreshold;
    const backoffMs = Math.min(
      MCP_LIMITS.circuitBreakerMaxMs,
      MCP_LIMITS.circuitBreakerBaseMs * Math.pow(2, exponent),
    );
    nextPausedUntil = new Date(nowMs + backoffMs).toISOString();
  }

  db.prepare(
    `UPDATE custom_ai_mcp_servers
        SET status = ?,
            last_error = ?,
            fail_count = ?,
            paused_until = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(nextStatus, sanitizeErrorMessage(outcome.error), nextFailCount, nextPausedUntil, nowIso, serverId);

  return toServerView(getServerRowOrThrow(serverId));
}

export async function testServer(
  id: number,
  signal?: AbortSignal,
  transport?: McpTransportClient,
): Promise<McpTestServerResponse> {
  if (!isPillarEnabled('mcpClient')) {
    throw new McpPillarDisabledError();
  }
  const config = getServerTransportConfig(id);
  const client = await resolveTransportClient(transport);
  const controller = new AbortController();
  const effectiveSignal = signal ?? controller.signal;

  try {
    const session = await client.mcpInitialize(config, effectiveSignal);
    const tools = await client.mcpListTools(config, session, effectiveSignal);
    recordServerOutcome(id, {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
    });
    return {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
      toolCount: tools.length,
    };
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err, config.secret);
    recordServerOutcome(id, { ok: false, error: sanitized });
    return {
      ok: false,
      error: sanitized,
    };
  }
}

export async function syncServerTools(
  id: number,
  _actorId: number | null,
  signal?: AbortSignal,
  transport?: McpTransportClient,
): Promise<McpSyncServerResponse> {
  if (!isPillarEnabled('mcpClient')) {
    throw new McpPillarDisabledError();
  }
  const config = getServerTransportConfig(id);
  const client = await resolveTransportClient(transport);
  const controller = new AbortController();
  const effectiveSignal = signal ?? controller.signal;

  let descriptors: McpToolDescriptor[];
  try {
    const session = await client.mcpInitialize(config, effectiveSignal);
    descriptors = await client.mcpListTools(config, session, effectiveSignal);
    recordServerOutcome(id, {
      ok: true,
      protocolVersion: session.protocolVersion,
      serverInfo: session.serverInfo ?? undefined,
    });
  } catch (err) {
    const sanitized = sanitizeErrorMessage(err, config.secret);
    recordServerOutcome(id, { ok: false, error: sanitized });
    throw err;
  }

  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(() => {
    const existingRows = db
      .prepare('SELECT * FROM custom_ai_mcp_tools WHERE server_id = ?')
      .all(id) as McpToolRow[];
    const existingByName = new Map(existingRows.map((r) => [r.name, r]));

    const takenExposed = new Set<string>(
      (
        db.prepare('SELECT exposed_name FROM custom_ai_mcp_tools').all() as Array<{
          exposed_name: string;
        }>
      ).map((r) => r.exposed_name),
    );

    let added = 0;
    let changed = 0;
    let unchanged = 0;
    const seenNames = new Set<string>();

    for (const desc of descriptors) {
      if (!desc.name || seenNames.has(desc.name)) continue;
      seenNames.add(desc.name);

      const inputSchema = desc.inputSchema ?? {};
      const outputSchema = desc.outputSchema ?? null;
      const schemaHash = computeSchemaHash(desc.name, desc.description, inputSchema, outputSchema);
      const existing = existingByName.get(desc.name);

      if (!existing) {
        const exposedName = buildExposedToolName(config.slug, desc.name, takenExposed);
        takenExposed.add(exposedName);
        db.prepare(
          `INSERT INTO custom_ai_mcp_tools (
            server_id, name, description, input_schema_json, output_schema_json,
            schema_hash, exposed_name, state, effect, missing_since, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'write', NULL, ?, ?)`,
        ).run(
          id,
          desc.name,
          desc.description ?? null,
          JSON.stringify(inputSchema),
          outputSchema ? JSON.stringify(outputSchema) : null,
          schemaHash,
          exposedName,
          now,
          now,
        );
        added++;
      } else if (existing.schema_hash !== schemaHash) {
        db.prepare(
          `UPDATE custom_ai_mcp_tools
              SET description = ?,
                  input_schema_json = ?,
                  output_schema_json = ?,
                  schema_hash = ?,
                  state = 'pending',
                  reviewed_by = NULL,
                  reviewed_at = NULL,
                  missing_since = NULL,
                  updated_at = ?
            WHERE id = ?`,
        ).run(
          desc.description ?? null,
          JSON.stringify(inputSchema),
          outputSchema ? JSON.stringify(outputSchema) : null,
          schemaHash,
          now,
          existing.id,
        );
        changed++;
      } else {
        if (existing.missing_since !== null) {
          db.prepare(
            'UPDATE custom_ai_mcp_tools SET missing_since = NULL, updated_at = ? WHERE id = ?',
          ).run(now, existing.id);
        }
        unchanged++;
      }
    }

    let missing = 0;
    for (const existing of existingRows) {
      if (!seenNames.has(existing.name)) {
        if (existing.missing_since === null) {
          db.prepare(
            'UPDATE custom_ai_mcp_tools SET missing_since = ?, updated_at = ? WHERE id = ?',
          ).run(now, now, existing.id);
        }
        missing++;
      }
    }

    return { added, changed, missing, unchanged };
  })();
}

export function listServerTools(serverId: number): McpToolView[] {
  getServerRowOrThrow(serverId);
  const rows = getDb()
    .prepare('SELECT * FROM custom_ai_mcp_tools WHERE server_id = ? ORDER BY id ASC LIMIT ?')
    .all(serverId, MCP_LIMITS.maxListLimit) as McpToolRow[];
  return rows.map(toToolView);
}

export function reviewTool(
  toolId: number,
  patch: McpToolReviewPatch,
  actorId: number | null,
): McpToolView {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM custom_ai_mcp_tools WHERE id = ?').get(toolId) as
    | McpToolRow
    | undefined;
  if (!existing) {
    throw new McpNotFoundError(`MCP tool ${toolId} not found.`);
  }

  if (patch.state !== undefined && patch.state !== 'allowed' && patch.state !== 'blocked') {
    throw new McpValidationError("state must be 'allowed' or 'blocked'.", 'invalid_tool_state', 400);
  }
  if (patch.effect !== undefined && patch.effect !== 'read' && patch.effect !== 'write') {
    throw new McpValidationError("effect must be 'read' or 'write'.", 'invalid_tool_effect', 400);
  }

  const nextState = patch.state ?? existing.state;
  const nextEffect = patch.effect ?? existing.effect;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE custom_ai_mcp_tools
        SET state = ?,
            effect = ?,
            reviewed_by = ?,
            reviewed_at = ?,
            updated_at = ?
      WHERE id = ?`,
  ).run(nextState, nextEffect, actorId, now, now, toolId);

  const updated = db.prepare('SELECT * FROM custom_ai_mcp_tools WHERE id = ?').get(toolId) as McpToolRow;
  return toToolView(updated);
}

export function assertToolExecutable(
  toolId: number,
  expectedSchemaHash?: string,
): { tool: BoundTool; config: McpTransportConfig } {
  const db = getDb();
  const toolRow = db.prepare('SELECT * FROM custom_ai_mcp_tools WHERE id = ?').get(toolId) as
    | McpToolRow
    | undefined;
  if (!toolRow) {
    throw new McpNotFoundError(`MCP tool ${toolId} not found.`);
  }
  if (toolRow.missing_since !== null) {
    throw new McpConflictError('tool_missing', 'MCP tool is no longer advertised by the server.');
  }
  if (toolRow.state !== 'allowed') {
    throw new McpConflictError('tool_not_allowed', `MCP tool state is '${toolRow.state}'.`);
  }
  if (expectedSchemaHash && toolRow.schema_hash !== expectedSchemaHash) {
    throw new McpConflictError('tool_schema_changed', 'MCP tool schema changed since approval.');
  }

  const serverRow = getServerRowOrThrow(toolRow.server_id);
  if (serverRow.enabled !== 1) {
    throw new McpConflictError('server_disabled', 'MCP server is disabled.');
  }
  if (
    serverRow.status === 'paused' &&
    serverRow.paused_until &&
    Date.parse(serverRow.paused_until) > Date.now()
  ) {
    throw new McpConflictError('server_paused', 'MCP server is temporarily paused by circuit breaker.');
  }

  const config = getServerTransportConfig(serverRow.id);
  const tool: BoundTool = {
    toolId: toolRow.id,
    serverId: serverRow.id,
    serverSlug: serverRow.slug,
    name: toolRow.name,
    exposedName: toolRow.exposed_name,
    description: toolRow.description,
    inputSchema: safeJsonParse<Record<string, unknown>>(toolRow.input_schema_json, {}),
    outputSchema: safeJsonParse<Record<string, unknown> | null>(toolRow.output_schema_json, null),
    schemaHash: toolRow.schema_hash,
    effect: toolRow.effect,
    timeoutMs: serverRow.timeout_ms,
    maxResultBytes: serverRow.max_result_bytes,
    maxConcurrency: serverRow.max_concurrency,
  };

  return { tool, config };
}
