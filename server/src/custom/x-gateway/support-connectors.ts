import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { safeFetch, SafeHttpError } from './support-safe-http.js';

const runtimeRequire = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Structural types (mirror specs/013-ai-support-gateway/data-model.md)
// ---------------------------------------------------------------------------

export class SupportConnectorError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
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

export interface SupportAvailableToolDescriptor {
  kind: 'webhook' | 'db';
  id: number;
  functionName: string;
  displayName: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sample sandbox
// ---------------------------------------------------------------------------

export const DEFAULT_ECOMMERCE_SANDBOX_SQL = `
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL);
INSERT INTO products (id, name, category, price, stock) VALUES (1, 'Wireless Mouse', 'accessories', 19.99, 120);
INSERT INTO products (id, name, category, price, stock) VALUES (2, 'Mechanical Keyboard', 'accessories', 89.5, 45);
INSERT INTO products (id, name, category, price, stock) VALUES (3, '27in 4K Monitor', 'displays', 329.0, 12);
INSERT INTO products (id, name, category, price, stock) VALUES (4, 'USB-C Hub', 'accessories', 39.0, 0);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, product_name TEXT NOT NULL, status TEXT NOT NULL, total_usd REAL NOT NULL, tracking_code TEXT, created_at TEXT NOT NULL);
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (1, 'cust_101', 'Wireless Mouse', 'delivered', 19.99, 'TRK-1001', '2026-10-01T09:00:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (2, 'cust_101', 'Mechanical Keyboard', 'shipped', 89.5, 'TRK-1002', '2026-10-20T11:30:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (3, 'cust_102', '27in 4K Monitor', 'processing', 329.0, NULL, '2026-11-02T14:15:00Z');
INSERT INTO orders (id, user_id, product_name, status, total_usd, tracking_code, created_at) VALUES (4, 'cust_102', 'USB-C Hub', 'cancelled', 39.0, NULL, '2026-11-05T08:45:00Z');
CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tier TEXT NOT NULL, password_hash TEXT NOT NULL, secret_note TEXT);
INSERT INTO customers (id, name, email, tier, password_hash, secret_note) VALUES ('cust_101', 'Alice Nguyen', 'alice@example.com', 'gold', 'pbkdf2$alice-hash', 'VIP - internal only');
INSERT INTO customers (id, name, email, tier, password_hash, secret_note) VALUES ('cust_102', 'Bob Tran', 'bob@example.com', 'standard', 'pbkdf2$bob-hash', 'Chargeback risk');
`.trim();

export const DEFAULT_ECOMMERCE_TABLE_POLICIES: SupportTablePolicy[] = [
  {
    tableName: 'products',
    description: 'Product catalog',
    allowedRoles: ['guest', 'customer', 'staff', 'admin'],
  },
  {
    tableName: 'orders',
    description: 'Customer orders',
    allowedRoles: ['customer', 'staff', 'admin'],
    rowOwnerColumn: 'user_id',
    bypassRowLockRoles: ['admin', 'staff'],
  },
  {
    tableName: 'customers',
    description: 'Customer profiles',
    allowedRoles: ['customer', 'staff', 'admin'],
    rowOwnerColumn: 'id',
    bypassRowLockRoles: ['admin', 'staff'],
    deniedColumns: ['password_hash', 'secret_note'],
  },
];

// ---------------------------------------------------------------------------
// Role helpers & tool discovery
// ---------------------------------------------------------------------------

export function isRoleAllowed(allowedRoles: string[] | undefined, role: string): boolean {
  if (!Array.isArray(allowedRoles)) return false;
  const r = String(role ?? '').toLowerCase();
  return allowedRoles.some((a) => {
    const v = String(a).trim().toLowerCase();
    return v === '*' || v === r;
  });
}

function visibleColumnsLabel(policy: SupportTablePolicy): string {
  const parts: string[] = [];
  if (policy.allowedColumns?.length) parts.push(policy.allowedColumns.join(', '));
  else parts.push('all columns');
  if (policy.deniedColumns?.length) parts.push(`except ${policy.deniedColumns.join(', ')}`);
  return parts.join(' ');
}

export function buildAllowedToolsForContext(
  context: SupportUserContext,
  tools: SupportWebhookTool[],
  dbSources: SupportDbSource[],
): SupportAvailableToolDescriptor[] {
  const out: SupportAvailableToolDescriptor[] = [];
  for (const tool of tools) {
    if (!tool.enabled || !isRoleAllowed(tool.allowedRoles, context.role)) continue;
    const locked =
      tool.lockUserIdParam && !isRoleAllowed(tool.bypassUserLockRoles, context.role)
        ? tool.lockUserIdParam
        : null;
    const params = JSON.parse(JSON.stringify(tool.parametersSchema ?? { type: 'object', properties: {} })) as Record<string, unknown>;
    if (locked) {
      // The locked parameter is injected server-side; hide it from the model.
      const props = params.properties as Record<string, unknown> | undefined;
      if (props && typeof props === 'object') delete props[locked];
      if (Array.isArray(params.required)) {
        params.required = (params.required as unknown[]).filter((k) => k !== locked);
      }
    }
    out.push({
      kind: 'webhook',
      id: tool.id,
      functionName: `webhook__${tool.name}`,
      displayName: tool.name,
      description: tool.description,
      parameters: params,
    });
  }
  for (const src of dbSources) {
    if (!src.enabled) continue;
    const policies = (src.tablePolicies ?? []).filter((p) => isRoleAllowed(p.allowedRoles, context.role));
    if (policies.length === 0) continue;
    const lines = policies.map((p) => {
      const locked =
        p.rowOwnerColumn && !isRoleAllowed(p.bypassRowLockRoles ?? ['admin', 'staff'], context.role);
      const rule = locked ? `rows restricted to current user via ${p.rowOwnerColumn}` : 'all rows';
      return `- ${p.tableName} (${visibleColumnsLabel(p)}; ${rule})`;
    });
    out.push({
      kind: 'db',
      id: src.id,
      functionName: `db__source_${src.id}`,
      displayName: src.name,
      description: `Run a single read-only SQL SELECT on "${src.name}". Allowed tables:\n${lines.join('\n')}`,
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single SELECT statement' } },
        required: ['sql'],
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode A: webhook executor
// ---------------------------------------------------------------------------

export async function executeSupportWebhookTool(options: {
  tool: SupportWebhookTool;
  context: SupportUserContext;
  args: Record<string, unknown>;
  signingSecret: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}): Promise<{ ok: boolean; status: number; effectiveArgs: Record<string, unknown>; data: unknown }> {
  const { tool, context, signingSecret } = options;
  if (!signingSecret) {
    throw new SupportConnectorError(400, 'Signing secret is required to invoke webhook tool');
  }
  if (!isRoleAllowed(tool.allowedRoles, context.role)) {
    throw new SupportConnectorError(403, `Role "${context.role}" is not allowed to call tool "${tool.name}"`);
  }
  const effectiveArgs: Record<string, unknown> = { ...(options.args ?? {}) };
  if (tool.lockUserIdParam && !isRoleAllowed(tool.bypassUserLockRoles, context.role)) {
    effectiveArgs[tool.lockUserIdParam] = context.userId;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  let url = tool.endpointUrl;
  let bodyJson = '';
  const init: RequestInit = { method: tool.method };
  if (tool.method === 'GET') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(effectiveArgs)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    url = u.toString();
  } else {
    bodyJson = JSON.stringify(effectiveArgs);
    init.body = bodyJson;
  }
  const signature = createHmac('sha256', signingSecret).update(`${timestamp}.${bodyJson}`).digest('hex');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(tool.headers ?? {}),
    'X-Support-Signature': `sha256=${signature}`,
    'X-Support-Timestamp': timestamp,
    'X-Support-User-Id': context.userId,
    'X-Support-User-Role': context.role,
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }
  init.headers = headers;
  init.signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);

  let res: Response;
  try {
    res = await safeFetch(url, init);
  } catch (err) {
    if (err instanceof SafeHttpError) {
      throw new SupportConnectorError(err.status, `Webhook SSRF or transport check failed: ${err.message}`);
    }
    throw new SupportConnectorError(502, `Webhook request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text */
  }
  return { ok: res.ok, status: res.status, effectiveArgs, data };
}

// ---------------------------------------------------------------------------
// Mode B: role-scoped read-only SQL
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE',
  'TRUNCATE', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM',
];
const NON_ALIAS_WORDS = new Set([
  'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'ON', 'USING',
  'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'HAVING', 'AS',
]);
const USER_PARAM = '$__support_user_id';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateAndRewriteSupportSql(
  sql: string,
  context: SupportUserContext,
  source: Pick<SupportDbSource, 'tablePolicies' | 'maxRows'>,
): { rewrittenSql: string; referencedTables: string[]; params: Record<string, unknown> } {
  let text = String(sql ?? '').trim();
  if (text.endsWith(';')) text = text.slice(0, -1).trim();
  if (!text) throw new SupportConnectorError(400, 'SQL is empty');

  // Mask string literals so keyword/identifier scanning ignores their content.
  const literals: string[] = [];
  const masked = text.replace(/'(?:[^']|'')*'/g, (m) => {
    literals.push(m);
    return `'__LIT${literals.length - 1}__'`;
  });
  if (masked.replace(/'__LIT\d+__'/g, '').includes("'")) throw new SupportConnectorError(400, 'Unterminated string literal');

  if (masked.includes(';')) throw new SupportConnectorError(400, 'Multiple statements are not allowed');
  if (/--|\/\*|\*\//.test(masked)) throw new SupportConnectorError(400, 'SQL comments are not allowed');
  if (/["`[\]]/.test(masked)) throw new SupportConnectorError(400, 'Quoted identifiers are not allowed');
  if (/[$@?:]/.test(masked)) throw new SupportConnectorError(400, 'Bound parameters are not allowed');
  if (!/^select\b/i.test(masked)) throw new SupportConnectorError(400, 'Only SELECT queries are allowed');
  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(masked)) {
      throw new SupportConnectorError(403, `Keyword ${kw} is not allowed`);
    }
  }

  const policies = source.tablePolicies ?? [];
  const referenced: string[] = [];
  const refRe = /\b(FROM|JOIN)\s+([A-Za-z_]\w*)(\s*\.\s*\w+)?(\s+(?:AS\s+)?([A-Za-z_]\w*))?(\s*,)?/gi;

  const rewritten = masked.replace(
    refRe,
    (full, kw: string, table: string, dotPart: string | undefined, aliasPart: string | undefined, alias: string | undefined, comma: string | undefined) => {
      if (dotPart) throw new SupportConnectorError(403, 'Schema-qualified tables are not allowed');
      if (comma) throw new SupportConnectorError(400, 'Comma joins are not allowed; use explicit JOIN');
      const policy = policies.find((p) => p.tableName.toLowerCase() === table.toLowerCase());
      if (!policy || !isRoleAllowed(policy.allowedRoles, context.role)) {
        throw new SupportConnectorError(403, `Table "${table}" is not accessible for role "${context.role}"`);
      }
      if (!referenced.includes(policy.tableName)) referenced.push(policy.tableName);

      const realAlias = alias && !NON_ALIAS_WORDS.has(alias.toUpperCase()) ? alias : undefined;
      const tail = aliasPart && !realAlias ? aliasPart : '';
      const needsLock =
        policy.rowOwnerColumn && !isRoleAllowed(policy.bypassRowLockRoles ?? ['admin', 'staff'], context.role);
      if (!needsLock) return `${kw} ${table}${realAlias ? ` ${realAlias}` : ''}${tail}`;
      if (!/^[A-Za-z_]\w*$/.test(policy.rowOwnerColumn as string)) {
        throw new SupportConnectorError(500, 'Invalid rowOwnerColumn in policy');
      }
      return `${kw} (SELECT * FROM ${policy.tableName} WHERE ${policy.rowOwnerColumn} = ${USER_PARAM}) AS ${realAlias ?? table}${tail}`;
    },
  );

  // Denied columns must not be referenced explicitly.
  for (const table of referenced) {
    const policy = policies.find((p) => p.tableName === table)!;
    for (const col of policy.deniedColumns ?? []) {
      if (new RegExp(`\\b${escapeRegex(col)}\\b`, 'i').test(masked)) {
        throw new SupportConnectorError(403, `Column "${col}" is not accessible`);
      }
    }
  }
  if (referenced.length === 0) {
    throw new SupportConnectorError(400, 'Query must reference at least one table');
  }

  // Enforce LIMIT cap.
  const cap = source.maxRows && source.maxRows > 0 ? source.maxRows : 50;
  let finalSql = rewritten.trim();
  const limitRe = /\blimit\s+(\d+)(\s+offset\s+\d+)?\s*$/i;
  const m = limitRe.exec(finalSql);
  if (m) {
    const n = Math.min(Number(m[1]), cap);
    finalSql = finalSql.replace(limitRe, `LIMIT ${n}${m[2] ?? ''}`);
  } else if (/\blimit\b/i.test(finalSql)) {
    throw new SupportConnectorError(400, 'Unsupported LIMIT clause');
  } else {
    finalSql = `${finalSql} LIMIT ${cap}`;
  }

  finalSql = finalSql.replace(/'__LIT(\d+)__'/g, (_m, i: string) => literals[Number(i)]);
  return { rewrittenSql: finalSql, referencedTables: referenced, params: { __support_user_id: context.userId } };
}

function stripHiddenColumns(
  rows: Record<string, unknown>[],
  policies: SupportTablePolicy[],
  tables: string[],
): Record<string, unknown>[] {
  const denied = new Set<string>();
  for (const t of tables) {
    const p = policies.find((x) => x.tableName === t);
    for (const c of p?.deniedColumns ?? []) denied.add(c.toLowerCase());
  }
  // Whitelist applies only if every referenced table declares allowedColumns.
  const allowLists = tables.map((t) => policies.find((x) => x.tableName === t)?.allowedColumns);
  const allowed = allowLists.every((a) => a && a.length)
    ? new Set(allowLists.flatMap((a) => a!.map((c) => c.toLowerCase())))
    : null;
  return rows.map((row) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      const lk = k.toLowerCase();
      if (denied.has(lk)) continue;
      if (allowed && !allowed.has(lk)) continue;
      clean[k] = v;
    }
    return clean;
  });
}

export async function executeSupportDbQuery(options: {
  source: SupportDbSource;
  context: SupportUserContext;
  sql: string;
  authToken?: string;
}): Promise<{ rows: Record<string, unknown>[]; rowCount: number; rewrittenSql: string; referencedTables: string[] }> {
  const { source, context } = options;
  const { rewrittenSql, referencedTables, params } = validateAndRewriteSupportSql(options.sql, context, source);
  let rows: Record<string, unknown>[];

  if (source.driver === 'sqlite-sandbox') {
    const Database = runtimeRequire('better-sqlite3') as new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { all(params: Record<string, unknown>): unknown[] };
      close(): void;
    };
    const db = new Database(':memory:');
    try {
      db.exec(source.schemaSql?.trim() ? source.schemaSql : DEFAULT_ECOMMERCE_SANDBOX_SQL);
      try {
        rows = db.prepare(rewrittenSql).all(params) as Record<string, unknown>[];
      } catch (err) {
        throw new SupportConnectorError(400, `SQL execution failed: ${(err as Error).message}`);
      }
    } finally {
      db.close();
    }
  } else if (source.driver === 'sql-http') {
    let res: Response;
    try {
      res = await safeFetch(source.connectionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
        },
        body: JSON.stringify({ sql: rewrittenSql, params }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (err instanceof SafeHttpError) {
        throw new SupportConnectorError(err.status, `SQL HTTP SSRF check failed: ${err.message}`);
      }
      throw new SupportConnectorError(502, `SQL HTTP request failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new SupportConnectorError(502, `SQL HTTP endpoint returned ${res.status}`);
    const body = (await res.json().catch(() => null)) as { rows?: unknown } | unknown[] | null;
    const raw = Array.isArray(body) ? body : body && Array.isArray(body.rows) ? body.rows : null;
    if (!raw) throw new SupportConnectorError(502, 'SQL HTTP endpoint returned an invalid payload');
    rows = raw as Record<string, unknown>[];
  } else {
    throw new SupportConnectorError(400, `Unsupported driver "${String(source.driver)}"`);
  }

  const cleaned = stripHiddenColumns(rows, source.tablePolicies ?? [], referencedTables);
  return { rows: cleaned, rowCount: cleaned.length, rewrittenSql, referencedTables };
}
