import crypto from 'node:crypto';
import {
  DEFAULT_AI_PLATFORM_RETENTION,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform.js';
import {
  MCP_LIMITS,
  type McpAuthKind,
  type McpCallView,
  type McpServerStatus,
  type McpServerView,
  type McpToolCallStatus,
  type McpToolDescriptor,
  type McpToolEffect,
  type McpToolState,
  type McpToolView,
} from '@freellmapi/shared/ai-platform-mcp.js';
import { getDb } from '../../../db/index.js';
import type { Db } from '../../../db/types.js';

// ── Private Server-Only Transport Types ──────────────────────────────────────

export interface McpTransportConfig {
  serverId: number;
  slug: string;
  url: string;
  authKind: McpAuthKind;
  authHeaderName: string | null;
  secret: string | null;
  timeoutMs: number;
  maxResultBytes: number;
  maxConcurrency: number;
  revision: number;
  credentialGeneration: number;
}

export interface McpSession {
  serverId: number;
  revision: number;
  credentialGeneration: number;
  origin: string;
  sessionId: string | null;
  protocolVersion: string;
  serverInfo: Record<string, unknown> | null;
}

export interface McpTransportClient {
  mcpInitialize(config: McpTransportConfig, signal: AbortSignal): Promise<McpSession>;
  mcpListTools(
    config: McpTransportConfig,
    session: McpSession,
    signal: AbortSignal,
  ): Promise<McpToolDescriptor[]>;
}

// ── SQL Row Types (never exported in public DTOs) ────────────────────────────

export interface McpServerRow {
  id: number;
  slug: string;
  name: string;
  url: string;
  auth_kind: McpAuthKind;
  auth_header_name: string | null;
  auth_ciphertext: string | null;
  auth_iv: string | null;
  auth_tag: string | null;
  enabled: number;
  timeout_ms: number;
  max_result_bytes: number;
  max_concurrency: number;
  status: McpServerStatus;
  last_error: string | null;
  last_connected_at: string | null;
  fail_count: number;
  paused_until: string | null;
  protocol_version: string | null;
  server_info_json: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  revision: number;
  credential_generation: number;
}

export interface McpToolRow {
  id: number;
  server_id: number;
  name: string;
  description: string | null;
  input_schema_json: string;
  output_schema_json: string | null;
  schema_hash: string;
  exposed_name: string;
  state: McpToolState;
  effect: McpToolEffect;
  reviewed_by: number | null;
  reviewed_at: string | null;
  missing_since: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpCallRow {
  id: number;
  run_id: string | null;
  execution_key: string | null;
  scope_kind: ScopeKind;
  scope_id: string;
  end_user: string | null;
  server_id: number;
  tool_name: string;
  args_masked: string | null;
  result_masked: string | null;
  status: McpToolCallStatus;
  duration_ms: number;
  result_bytes: number;
  created_at: string;
  server_slug?: string | null;
}

// ── Domain Errors ────────────────────────────────────────────────────────────

export class McpServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'McpServiceError';
  }
}

export class McpValidationError extends McpServiceError {
  constructor(message: string, code = 'invalid_request', status = 400, details?: unknown) {
    super(status, code, message, details);
    this.name = 'McpValidationError';
  }
}

export class McpNotFoundError extends McpServiceError {
  constructor(message: string, code = 'not_found') {
    super(404, code, message);
    this.name = 'McpNotFoundError';
  }
}

export class McpConflictError extends McpServiceError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
    this.name = 'McpConflictError';
  }
}

export class McpPillarDisabledError extends McpServiceError {
  constructor() {
    super(409, 'pillar_disabled', 'MCP client pillar is disabled.');
    this.name = 'McpPillarDisabledError';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function hasTable(db: Db, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function computeSchemaHash(
  name: string,
  description: string | null | undefined,
  inputSchema: Record<string, unknown>,
  outputSchema?: Record<string, unknown> | null,
): string {
  const payload = canonicalJson({
    name,
    description: description ?? null,
    inputSchema,
    outputSchema: outputSchema ?? null,
  });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function buildExposedToolName(
  slug: string,
  toolName: string,
  taken: ReadonlySet<string>,
): string {
  const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const prefix = `mcp__${slug}__`;
  const candidate = `${prefix}${sanitized}`;
  if (candidate.length <= MCP_LIMITS.exposedToolNameMaxChars && !taken.has(candidate)) {
    return candidate;
  }
  const hash = crypto.createHash('sha256').update(`${slug}\0${toolName}`, 'utf8').digest('hex');
  for (let salt = 0; salt < 16; salt++) {
    const suffix = `_${salt === 0 ? hash.slice(0, 8) : hash.slice(salt, salt + 8)}`;
    const maxBody = MCP_LIMITS.exposedToolNameMaxChars - prefix.length - suffix.length;
    const body = sanitized.slice(0, Math.max(1, maxBody));
    const hashed = `${prefix}${body}${suffix}`.slice(0, MCP_LIMITS.exposedToolNameMaxChars);
    if (!taken.has(hashed)) {
      return hashed;
    }
  }
  return `mcp__${hash.slice(0, MCP_LIMITS.exposedToolNameMaxChars - 5)}`;
}

// ── Public Projection Whitelists (NEVER spread SQL rows) ─────────────────────

export function toServerView(row: McpServerRow): McpServerView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    authKind: row.auth_kind,
    authHeaderName: row.auth_header_name,
    hasSecret: Boolean(row.auth_ciphertext && row.auth_iv && row.auth_tag),
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms,
    maxResultBytes: row.max_result_bytes,
    maxConcurrency: row.max_concurrency,
    status: row.status,
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at,
    failCount: row.fail_count,
    pausedUntil: row.paused_until,
    protocolVersion: row.protocol_version,
    serverInfo: safeJsonParse<Record<string, unknown> | null>(row.server_info_json, null),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export function toToolView(row: McpToolRow): McpToolView {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    description: row.description,
    inputSchema: safeJsonParse<Record<string, unknown>>(row.input_schema_json, {}),
    outputSchema: safeJsonParse<Record<string, unknown> | null>(row.output_schema_json, null),
    schemaHash: row.schema_hash,
    exposedName: row.exposed_name,
    state: row.state,
    effect: row.effect,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    missingSince: row.missing_since,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toCallView(row: McpCallRow): McpCallView {
  const view: McpCallView = {
    id: row.id,
    runId: row.run_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    endUser: row.end_user,
    serverId: row.server_id,
    toolName: row.tool_name,
    argsMasked: row.args_masked,
    resultMasked: row.result_masked,
    status: row.status,
    durationMs: row.duration_ms,
    resultBytes: row.result_bytes,
    createdAt: row.created_at,
  };
  if (row.server_slug) {
    view.serverSlug = row.server_slug;
  }
  return view;
}

// ── Allowed Internal Origins & Retention Settings ────────────────────────────

const ALLOWED_ORIGINS_KEY = 'ai_platform_mcp_allowed_origins_v1';
const RETENTION_KEY = 'ai_platform_retention_v1';

export function normalizeOriginStrict(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed || trimmed.includes('*') || trimmed.includes('/32') || /\s/.test(trimmed)) {
    throw new McpValidationError(`Invalid origin: '${raw}'`, 'invalid_origin', 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpValidationError(`Invalid origin URL: '${raw}'`, 'invalid_origin', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpValidationError(`Origin must use http or https: '${raw}'`, 'invalid_origin', 400);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new McpValidationError(`Origin must not contain credentials, query, or hash: '${raw}'`, 'invalid_origin', 400);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new McpValidationError(`Origin must not contain a path: '${raw}'`, 'invalid_origin', 400);
  }
  return parsed.origin;
}

export function getAllowedInternalOrigins(): string[] {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(ALLOWED_ORIGINS_KEY) as { value?: string } | undefined;
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function setAllowedInternalOrigins(origins: string[]): string[] {
  if (!Array.isArray(origins)) {
    throw new McpValidationError('origins must be an array of strings.', 'invalid_origin', 400);
  }
  if (origins.length > MCP_LIMITS.maxAllowedOrigins) {
    throw new McpValidationError(
      `At most ${MCP_LIMITS.maxAllowedOrigins} allowed origins are permitted.`,
      'invalid_origin',
      400,
    );
  }
  const normalized = Array.from(new Set(origins.map(normalizeOriginStrict)));
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(ALLOWED_ORIGINS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function getToolCallsRetentionDays(): number {
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(RETENTION_KEY) as { value?: string } | undefined;
    if (!row?.value) return DEFAULT_AI_PLATFORM_RETENTION.toolCallsDays;
    const parsed = JSON.parse(row.value) as { toolCallsDays?: unknown };
    if (
      typeof parsed?.toolCallsDays === 'number' &&
      Number.isInteger(parsed.toolCallsDays) &&
      parsed.toolCallsDays >= 1 &&
      parsed.toolCallsDays <= 3650
    ) {
      return parsed.toolCallsDays;
    }
    return DEFAULT_AI_PLATFORM_RETENTION.toolCallsDays;
  } catch {
    return DEFAULT_AI_PLATFORM_RETENTION.toolCallsDays;
  }
}

export function scopeBindingSettingsKey(scope: Scope): string {
  return `ai_platform_scope_${scope.kind}_${scope.id}_mcp_binding`;
}
