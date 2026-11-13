import crypto from 'node:crypto';
import { z } from 'zod';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt, maskKey } from '../../lib/crypto.js';

export class SupportStoreError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface SupportRoleConfig {
  role: string;
  label: string;
  description?: string;
  permissions: string[];
}
export interface SupportTenant {
  id: number;
  name: string;
  slug: string;
  publicKey: string;
  signingSecretMasked: string;
  defaultModel: string;
  systemPrompt: string;
  allowedOrigins: string[];
  allowGuest: boolean;
  rolesConfig: SupportRoleConfig[];
  enabled: boolean;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface SupportUserContext {
  tenantId: number;
  userId: string;
  name?: string;
  email?: string;
  role: string;
  permissions: string[];
  metadata?: Record<string, unknown>;
  verified: boolean;
  expiresAt?: number;
}
export interface SupportWebhookTool {
  id: number;
  tenantId: number;
  name: string;
  description: string;
  method: 'GET' | 'POST';
  endpointUrl: string;
  headers: Record<string, string>;
  parametersSchema: Record<string, unknown>;
  allowedRoles: string[];
  lockUserIdParam: string | null;
  bypassUserLockRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SupportTablePolicy {
  tableName: string;
  description?: string;
  allowedRoles: string[];
  allowedColumns?: string[];
  deniedColumns?: string[];
  rowOwnerColumn?: string | null;
  bypassRowLockRoles?: string[];
}
export interface SupportDbSource {
  id: number;
  tenantId: number;
  name: string;
  driver: 'sqlite-sandbox' | 'sql-http';
  connectionUrl: string;
  authTokenMasked: string;
  schemaSql: string;
  tablePolicies: SupportTablePolicy[];
  maxRows: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export const DEFAULT_SUPPORT_ROLES: SupportRoleConfig[] = [
  { role: 'guest', label: 'Guest', permissions: ['products:read'] },
  { role: 'customer', label: 'Customer', permissions: ['products:read', 'orders:read_own'] },
  { role: 'staff', label: 'Staff', permissions: ['products:read', 'orders:read', 'customers:read'] },
  { role: 'admin', label: 'Admin', permissions: ['*'] },
];

let supportDb: Db | undefined;
export function ensureSupportTables(): Db {
  const db = getDb();
  if (supportDb === db) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_support_tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
      public_key TEXT NOT NULL UNIQUE, secret_encrypted TEXT NOT NULL, secret_iv TEXT NOT NULL,
      secret_auth_tag TEXT NOT NULL, default_model TEXT NOT NULL DEFAULT 'auto',
      system_prompt TEXT NOT NULL DEFAULT '', allowed_origins_json TEXT NOT NULL DEFAULT '[]',
      allow_guest INTEGER NOT NULL DEFAULT 1, roles_config_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1, created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS x_support_tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', method TEXT NOT NULL DEFAULT 'POST',
      endpoint_url TEXT NOT NULL, headers_json TEXT NOT NULL DEFAULT '{}',
      parameters_schema_json TEXT NOT NULL DEFAULT '{}', allowed_roles_json TEXT NOT NULL DEFAULT '[]',
      lock_user_id_param TEXT, bypass_user_lock_roles_json TEXT NOT NULL DEFAULT '["admin","staff"]',
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(tenant_id, name)
    );
    CREATE TABLE IF NOT EXISTS x_support_db_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES x_support_tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL, driver TEXT NOT NULL DEFAULT 'sqlite-sandbox', connection_url TEXT NOT NULL DEFAULT '',
      token_encrypted TEXT, token_iv TEXT, token_auth_tag TEXT, schema_sql TEXT NOT NULL DEFAULT '',
      table_policies_json TEXT NOT NULL DEFAULT '[]', max_rows INTEGER NOT NULL DEFAULT 50,
      enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  supportDb = db;
  return db;
}

const text = z.string().trim().min(1);
const strings = z.array(text);
const roleSchema = z.object({ role: text, label: text, description: z.string().optional(), permissions: strings });
const tenantSchema = z.object({
  name: text, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), defaultModel: text.default('auto'),
  systemPrompt: z.string().default(''), allowedOrigins: strings.default([]), allowGuest: z.boolean().default(true),
  rolesConfig: z.array(roleSchema).refine(roles => new Set(roles.map(r => r.role)).size === roles.length,
    'Role names must be unique.').default(DEFAULT_SUPPORT_ROLES), enabled: z.boolean().default(true),
});
const toolSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), description: z.string().default(''),
  method: z.enum(['GET', 'POST']).default('POST'),
  endpointUrl: z.string().url().refine(url => ['http:', 'https:'].includes(new URL(url).protocol)),
  headers: z.record(z.string(), z.string()).default({}), parametersSchema: z.record(z.string(), z.unknown()).default({}),
  allowedRoles: strings.default([]), lockUserIdParam: text.nullable().default(null),
  bypassUserLockRoles: strings.default(['admin', 'staff']), enabled: z.boolean().default(true),
});
const policySchema = z.object({
  tableName: text, description: z.string().optional(), allowedRoles: strings,
  allowedColumns: strings.optional(), deniedColumns: strings.optional(),
  rowOwnerColumn: text.nullable().optional(), bypassRowLockRoles: strings.optional(),
});
const sourceSchema = z.object({
  name: text, driver: z.enum(['sqlite-sandbox', 'sql-http']).default('sqlite-sandbox'),
  connectionUrl: z.string().default(''), authToken: z.string().default(''), schemaSql: z.string().default(''),
  tablePolicies: z.array(policySchema).default([]), maxRows: z.number().int().positive().default(50),
  enabled: z.boolean().default(true),
});
export type SupportTenantInput = Omit<z.input<typeof tenantSchema>, 'slug' | 'enabled'> & {
  slug?: string; createdBy?: number | null;
};
export type SupportWebhookToolInput = z.input<typeof toolSchema>;
export type SupportDbSourceInput = z.input<typeof sourceSchema>;

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new SupportStoreError(400, result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

// Column names passed to these helpers are fixed internally, never supplied by callers.
type Table = 'x_support_tenants' | 'x_support_tools' | 'x_support_db_sources';
function write(table: Table, values: Record<string, unknown>, id?: number, tenantId?: number): number {
  const db = ensureSupportTables();
  const columns = Object.keys(values);
  try {
    if (id !== undefined) {
      db.prepare(`UPDATE ${table} SET ${columns.map(c => `${c} = ?`).join(', ')} WHERE id = ?${tenantId === undefined ? '' : ' AND tenant_id = ?'}`)
        .run(...Object.values(values), id, ...(tenantId === undefined ? [] : [tenantId]));
      return id;
    }
    const result = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
      .run(...Object.values(values));
    return Number(result.lastInsertRowid);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new SupportStoreError(409, 'A support configuration with this slug or name already exists.');
    }
    throw error;
  }
}
type Row = Record<string, string | number | null>;
function row(table: Table, id: number, tenantId?: number): Row {
  const result = ensureSupportTables().prepare(`SELECT * FROM ${table} WHERE id = ?${tenantId === undefined ? '' : ' AND tenant_id = ?'}`)
    .get(id, ...(tenantId === undefined ? [] : [tenantId])) as Row | undefined;
  if (!result) throw new SupportStoreError(404, 'Support configuration not found.');
  return result;
}
function decode<T>(value: Row[string]): T { return JSON.parse(String(value)) as T; }
function secret(row: Row, prefix: 'secret' | 'token'): string {
  return row[`${prefix}_encrypted`] === null ? '' : decrypt(
    String(row[`${prefix}_encrypted`]), String(row[`${prefix}_iv`]), String(row[`${prefix}_auth_tag`]),
  );
}
function encryptedColumns(value: string, prefix: 'secret' | 'token'): Record<string, string> {
  const encrypted = encrypt(value);
  return { [`${prefix}_encrypted`]: encrypted.encrypted, [`${prefix}_iv`]: encrypted.iv, [`${prefix}_auth_tag`]: encrypted.authTag };
}
function timestamps(row: Row) {
  return { id: Number(row.id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function tenantFromRow(row: Row): SupportTenant {
  return {
    ...timestamps(row), name: String(row.name), slug: String(row.slug), publicKey: String(row.public_key),
    signingSecretMasked: maskKey(secret(row, 'secret')), defaultModel: String(row.default_model),
    systemPrompt: String(row.system_prompt), allowedOrigins: decode(row.allowed_origins_json),
    allowGuest: Boolean(row.allow_guest), rolesConfig: decode(row.roles_config_json), enabled: Boolean(row.enabled),
    createdBy: row.created_by === null ? null : Number(row.created_by),
  };
}
function tenantColumns(input: z.output<typeof tenantSchema>) {
  return {
    name: input.name, slug: input.slug, default_model: input.defaultModel, system_prompt: input.systemPrompt,
    allowed_origins_json: JSON.stringify(input.allowedOrigins), allow_guest: Number(input.allowGuest),
    roles_config_json: JSON.stringify(input.rolesConfig), enabled: Number(input.enabled),
  };
}
export function listSupportTenants(): SupportTenant[] {
  return (ensureSupportTables().prepare('SELECT * FROM x_support_tenants ORDER BY id').all() as Row[]).map(tenantFromRow);
}
export function getSupportTenant(id: number): SupportTenant { return tenantFromRow(row('x_support_tenants', id)); }
export function getSupportTenantByPublicKey(publicKey: string): SupportTenant {
  const result = ensureSupportTables().prepare('SELECT * FROM x_support_tenants WHERE public_key = ?').get(publicKey) as Row | undefined;
  if (!result) throw new SupportStoreError(404, 'Support tenant not found.');
  return tenantFromRow(result);
}
export function getSupportTenantSigningSecret(id: number): string { return secret(row('x_support_tenants', id), 'secret'); }
export function createSupportTenant(input: SupportTenantInput): { tenant: SupportTenant; signingSecret: string } {
  const name = parse(text, input.name);
  const slug = input.slug ?? (name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `tenant-${crypto.randomBytes(6).toString('hex')}`);
  const data = parse(tenantSchema, { ...input, slug });
  const signingSecret = `sk_sup_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date().toISOString();
  const id = write('x_support_tenants', {
    ...tenantColumns(data), public_key: `pk_sup_${crypto.randomBytes(24).toString('hex')}`,
    ...encryptedColumns(signingSecret, 'secret'), created_by: parse(z.number().int().nullable(), input.createdBy ?? null),
    created_at: now, updated_at: now,
  });
  return { tenant: getSupportTenant(id), signingSecret };
}
export function updateSupportTenant(id: number, patch: Partial<z.input<typeof tenantSchema>>): SupportTenant {
  const current = getSupportTenant(id);
  const validatedPatch = parse(tenantSchema.partial(), patch);
  const data = parse(tenantSchema, { ...current, ...validatedPatch });
  write('x_support_tenants', { ...tenantColumns(data), updated_at: new Date().toISOString() }, id);
  return getSupportTenant(id);
}
export function rotateSupportTenantSecret(id: number): { tenant: SupportTenant; signingSecret: string } {
  getSupportTenant(id);
  const signingSecret = `sk_sup_${crypto.randomBytes(32).toString('hex')}`;
  write('x_support_tenants', { ...encryptedColumns(signingSecret, 'secret'), updated_at: new Date().toISOString() }, id);
  return { tenant: getSupportTenant(id), signingSecret };
}
export function deleteSupportTenant(id: number): boolean {
  const db = ensureSupportTables();
  return db.transaction(() => {
    db.prepare('DELETE FROM x_support_tools WHERE tenant_id = ?').run(id);
    db.prepare('DELETE FROM x_support_db_sources WHERE tenant_id = ?').run(id);
    return db.prepare('DELETE FROM x_support_tenants WHERE id = ?').run(id).changes > 0;
  })();
}

const identitySchema = z.object({
  userId: text, name: z.string().optional(), email: z.string().optional(), role: text,
  permissions: strings.default([]), metadata: z.record(z.string(), z.unknown()).optional(),
});
const tokenSchema = identitySchema.extend({
  iat: z.number().int().nonnegative(), exp: z.number().int().nonnegative(), tenantId: z.number().int().positive().optional(),
});
export type SupportUserTokenInput = z.input<typeof identitySchema> & { ttlSeconds?: number };
export function mintSupportUserToken(tenantIdOrSecret: number | string, payload: SupportUserTokenInput): string {
  const identity = parse(identitySchema, payload);
  const ttl = parse(z.number().int().positive().max(Number.MAX_SAFE_INTEGER), payload.ttlSeconds ?? 3600);
  const signingSecret = typeof tenantIdOrSecret === 'number' ? getSupportTenantSigningSecret(tenantIdOrSecret) : tenantIdOrSecret;
  if (!signingSecret) throw new SupportStoreError(400, 'A signing secret is required.');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  if (!Number.isSafeInteger(exp)) throw new SupportStoreError(400, 'Invalid token expiry.');
  const encoded = Buffer.from(JSON.stringify({ ...identity, iat, exp,
    ...(typeof tenantIdOrSecret === 'number' ? { tenantId: tenantIdOrSecret } : {}),
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', signingSecret).update(encoded).digest('base64url');
  return `sup_ctx_${encoded}.${signature}`;
}
export function verifySupportUserToken(tenantId: number, token: string | undefined | null): SupportUserContext {
  const tenant = getSupportTenant(tenantId);
  if (!tenant.enabled) throw new SupportStoreError(403, 'Support tenant is disabled.');
  if (!token) {
    if (!tenant.allowGuest) throw new SupportStoreError(401, 'Support context token is required.');
    return { tenantId, userId: 'guest', name: 'Guest', role: 'guest',
      permissions: tenant.rolesConfig.find(r => r.role === 'guest')?.permissions ?? [], verified: false };
  }
  const invalid = () => new SupportStoreError(401, 'Invalid or expired support context token.');
  const match = /^sup_ctx_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw invalid();
  const [, encoded, signature] = match;
  const expected = crypto.createHmac('sha256', getSupportTenantSigningSecret(tenantId)).update(encoded).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || supplied.toString('base64url') !== signature || !crypto.timingSafeEqual(expected, supplied)) throw invalid();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw invalid(); }
  const result = tokenSchema.safeParse(value);
  if (!result.success) throw invalid();
  const data = result.data;
  const now = Math.floor(Date.now() / 1000);
  if (data.exp <= now || data.iat > now || data.exp <= data.iat || (data.tenantId !== undefined && data.tenantId !== tenantId)) throw invalid();
  return { tenantId, userId: data.userId, name: data.name, email: data.email, role: data.role,
    permissions: [...new Set([...(tenant.rolesConfig.find(r => r.role === data.role)?.permissions ?? []), ...data.permissions])],
    metadata: data.metadata, verified: true, expiresAt: data.exp };
}

function toolFromRow(row: Row): SupportWebhookTool {
  return { ...timestamps(row), tenantId: Number(row.tenant_id), name: String(row.name), description: String(row.description),
    method: row.method as 'GET' | 'POST', endpointUrl: String(row.endpoint_url), headers: decode(row.headers_json),
    parametersSchema: decode(row.parameters_schema_json), allowedRoles: decode(row.allowed_roles_json),
    lockUserIdParam: row.lock_user_id_param === null ? null : String(row.lock_user_id_param),
    bypassUserLockRoles: decode(row.bypass_user_lock_roles_json), enabled: Boolean(row.enabled) };
}
function toolColumns(data: z.output<typeof toolSchema>) {
  return { name: data.name, description: data.description, method: data.method, endpoint_url: data.endpointUrl,
    headers_json: JSON.stringify(data.headers), parameters_schema_json: JSON.stringify(data.parametersSchema),
    allowed_roles_json: JSON.stringify(data.allowedRoles), lock_user_id_param: data.lockUserIdParam,
    bypass_user_lock_roles_json: JSON.stringify(data.bypassUserLockRoles), enabled: Number(data.enabled) };
}
export function listSupportTools(tenantId: number): SupportWebhookTool[] {
  getSupportTenant(tenantId);
  return (ensureSupportTables().prepare('SELECT * FROM x_support_tools WHERE tenant_id = ? ORDER BY id').all(tenantId) as Row[]).map(toolFromRow);
}
export function getSupportTool(tenantId: number, toolId: number): SupportWebhookTool {
  return toolFromRow(row('x_support_tools', toolId, tenantId));
}
export function createSupportTool(tenantId: number, input: SupportWebhookToolInput): SupportWebhookTool {
  getSupportTenant(tenantId);
  const data = parse(toolSchema, input);
  const now = new Date().toISOString();
  const id = write('x_support_tools', { ...toolColumns(data), tenant_id: tenantId, created_at: now, updated_at: now });
  return getSupportTool(tenantId, id);
}
export function updateSupportTool(tenantId: number, toolId: number, patch: Partial<SupportWebhookToolInput>): SupportWebhookTool {
  const current = getSupportTool(tenantId, toolId);
  const data = parse(toolSchema, { ...current, ...parse(toolSchema.partial(), patch) });
  write('x_support_tools', { ...toolColumns(data), updated_at: new Date().toISOString() }, toolId, tenantId);
  return getSupportTool(tenantId, toolId);
}
export function deleteSupportTool(tenantId: number, toolId: number): boolean {
  return ensureSupportTables().prepare('DELETE FROM x_support_tools WHERE id = ? AND tenant_id = ?').run(toolId, tenantId).changes > 0;
}
function sourceFromRow(row: Row): SupportDbSource {
  const authToken = secret(row, 'token');
  return { ...timestamps(row), tenantId: Number(row.tenant_id), name: String(row.name),
    driver: row.driver as SupportDbSource['driver'], connectionUrl: String(row.connection_url),
    authTokenMasked: authToken ? maskKey(authToken) : '', schemaSql: String(row.schema_sql),
    tablePolicies: decode(row.table_policies_json), maxRows: Number(row.max_rows), enabled: Boolean(row.enabled) };
}
function sourceColumns(data: z.output<typeof sourceSchema>) {
  return { name: data.name, driver: data.driver, connection_url: data.connectionUrl, schema_sql: data.schemaSql,
    table_policies_json: JSON.stringify(data.tablePolicies), max_rows: data.maxRows, enabled: Number(data.enabled) };
}
export function listSupportDbSources(tenantId: number): SupportDbSource[] {
  getSupportTenant(tenantId);
  return (ensureSupportTables().prepare('SELECT * FROM x_support_db_sources WHERE tenant_id = ? ORDER BY id').all(tenantId) as Row[]).map(sourceFromRow);
}
export function getSupportDbSource(tenantId: number, sourceId: number): SupportDbSource {
  return sourceFromRow(row('x_support_db_sources', sourceId, tenantId));
}
export function getSupportDbSourceAuthToken(tenantId: number, sourceId: number): string {
  return secret(row('x_support_db_sources', sourceId, tenantId), 'token');
}
export function createSupportDbSource(tenantId: number, input: SupportDbSourceInput): SupportDbSource {
  getSupportTenant(tenantId);
  const data = parse(sourceSchema, input);
  const now = new Date().toISOString();
  const id = write('x_support_db_sources', { ...sourceColumns(data), ...encryptedColumns(data.authToken, 'token'),
    tenant_id: tenantId, created_at: now, updated_at: now });
  return getSupportDbSource(tenantId, id);
}
export function updateSupportDbSource(tenantId: number, sourceId: number, patch: Partial<SupportDbSourceInput>): SupportDbSource {
  const current = getSupportDbSource(tenantId, sourceId);
  const validatedPatch = parse(sourceSchema.partial(), patch);
  const data = parse(sourceSchema, { ...current, ...validatedPatch });
  write('x_support_db_sources', { ...sourceColumns(data),
    ...(validatedPatch.authToken === undefined ? {} : encryptedColumns(validatedPatch.authToken, 'token')),
    updated_at: new Date().toISOString() }, sourceId, tenantId);
  return getSupportDbSource(tenantId, sourceId);
}
export function deleteSupportDbSource(tenantId: number, sourceId: number): boolean {
  return ensureSupportTables().prepare('DELETE FROM x_support_db_sources WHERE id = ? AND tenant_id = ?').run(sourceId, tenantId).changes > 0;
}
