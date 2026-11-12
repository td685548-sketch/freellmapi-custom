import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_ECOMMERCE_SANDBOX_SQL,
  DEFAULT_ECOMMERCE_TABLE_POLICIES,
  SupportConnectorError,
  buildAllowedToolsForContext,
  executeSupportDbQuery,
  executeSupportWebhookTool,
  isRoleAllowed,
  validateAndRewriteSupportSql,
  type SupportDbSource,
  type SupportUserContext,
  type SupportWebhookTool,
} from '../../custom/x-gateway/support-connectors.js';

const ctx = (role: string, userId = 'cust_101'): SupportUserContext => ({
  tenantId: 1, userId, role, permissions: [], verified: true,
});

const source: SupportDbSource = {
  id: 7, tenantId: 1, name: 'shop', driver: 'sqlite-sandbox', connectionUrl: '',
  authTokenMasked: '', schemaSql: '', tablePolicies: DEFAULT_ECOMMERCE_TABLE_POLICIES,
  maxRows: 50, enabled: true, createdAt: '', updatedAt: '',
};

const tool: SupportWebhookTool = {
  id: 3, tenantId: 1, name: 'get_orders', description: 'Orders', method: 'POST',
  endpointUrl: 'https://partner.example.com/orders', headers: {},
  parametersSchema: { type: 'object', properties: { userId: { type: 'string' }, status: { type: 'string' } }, required: ['userId'] },
  allowedRoles: ['customer', 'staff', 'admin'], lockUserIdParam: 'userId',
  bypassUserLockRoles: ['admin', 'staff'], enabled: true, createdAt: '', updatedAt: '',
};

afterEach(() => vi.unstubAllGlobals());

const query = (role: string, sql: string, userId?: string) =>
  executeSupportDbQuery({ source, context: ctx(role, userId), sql });

describe('role discovery', () => {
  it('matches roles case-insensitively and with wildcard', () => {
    expect(isRoleAllowed(['Customer'], 'customer')).toBe(true);
    expect(isRoleAllowed(['*'], 'x')).toBe(true);
    expect(isRoleAllowed(['admin'], 'guest')).toBe(false);
    expect(isRoleAllowed(undefined, 'guest')).toBe(false);
  });

  it('guest sees only products DB, no webhook; customer sees webhook and orders', () => {
    const guest = buildAllowedToolsForContext(ctx('guest'), [tool], [source]);
    expect(guest.map((t) => t.functionName)).toEqual(['db__source_7']);
    expect(guest[0].description).toContain('products');
    expect(guest[0].description).not.toContain('orders');

    const customer = buildAllowedToolsForContext(ctx('customer'), [tool], [source]);
    expect(customer.map((t) => t.functionName)).toEqual(['webhook__get_orders', 'db__source_7']);
    expect(customer[1].description).toContain('orders');
    expect(customer[1].description).toContain('restricted to current user');
    expect(customer[1].description).toContain('except password_hash, secret_note');

    const admin = buildAllowedToolsForContext(ctx('admin'), [tool], [source]);
    expect(admin[1].description).toContain('all rows');
  });

  it('skips disabled tools and sources', () => {
    expect(buildAllowedToolsForContext(ctx('admin'), [{ ...tool, enabled: false }], [{ ...source, enabled: false }])).toEqual([]);
  });
});

describe('webhook executor', () => {
  it('overrides locked userId and signs with HMAC', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ orders: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await executeSupportWebhookTool({
      tool, context: ctx('customer'), args: { userId: 'cust_102', status: 'shipped' }, signingSecret: 's3cret',
    });
    expect(r.ok).toBe(true);
    expect(r.effectiveArgs).toEqual({ userId: 'cust_101', status: 'shipped' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(JSON.parse(init.body as string).userId).toBe('cust_101');
    const expected = createHmac('sha256', 's3cret').update(`${h['X-Support-Timestamp']}.${init.body}`).digest('hex');
    expect(h['X-Support-Signature']).toBe(`sha256=${expected}`);
    expect(h['X-Support-User-Id']).toBe('cust_101');
    expect(h['X-Support-User-Role']).toBe('customer');
  });

  it('lets admin bypass the lock and rejects disallowed roles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const r = await executeSupportWebhookTool({
      tool, context: ctx('admin', 'adm_1'), args: { userId: 'cust_102' }, signingSecret: 'k',
    });
    expect(r.effectiveArgs.userId).toBe('cust_102');
    await expect(
      executeSupportWebhookTool({ tool, context: ctx('guest'), args: {}, signingSecret: 'k' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('sends GET args in the query string', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await executeSupportWebhookTool({
      tool: { ...tool, method: 'GET' }, context: ctx('customer'), args: { userId: 'evil' }, signingSecret: 'k',
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('userId')).toBe('cust_101');
  });

  it('requires a non-empty signing secret', async () => {
    await expect(
      executeSupportWebhookTool({
        tool,
        context: ctx('customer'),
        args: {},
        signingSecret: '',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('includes stable Idempotency-Key header when supplied', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await executeSupportWebhookTool({
      tool,
      context: ctx('customer'),
      args: {},
      signingSecret: 'sec_123',
      idempotencyKey: 'act_idempotent_123',
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('act_idempotent_123');
  });

  it('blocks SSRF private target URL unless server-owned trusted origin is configured', async () => {
    const privateTool: SupportWebhookTool = {
      ...tool,
      endpointUrl: 'http://192.168.1.50:8080/hook',
    };

    // By default, private URL is rejected
    await expect(
      executeSupportWebhookTool({
        tool: privateTool,
        context: ctx('customer'),
        args: {},
        signingSecret: 'sec_123',
      }),
    ).rejects.toMatchObject({ status: 403 });

    // With server-owned exact origin allowlist, it is permitted
    process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS = 'http://192.168.1.50:8080';
    try {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const res = await executeSupportWebhookTool({
        tool: privateTool,
        context: ctx('customer'),
        args: {},
        signingSecret: 'sec_123',
      });
      expect(res.ok).toBe(true);
    } finally {
      delete process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS;
    }
  });
});

describe('SQL validation', () => {
  const v = (sql: string, role = 'customer') => () => validateAndRewriteSupportSql(sql, ctx(role), source);

  it.each([
    'DELETE FROM orders',
    'SELECT * FROM products; DROP TABLE products',
    'SELECT * FROM products -- hi',
    'SELECT * FROM products /* x */',
    'INSERT INTO products VALUES (1)',
    'PRAGMA table_info(products)',
    'SELECT * FROM products WHERE 1=1 UNION SELECT * FROM sqlite_master',
    'SELECT * FROM products, customers',
    'SELECT * FROM main.customers',
    'SELECT * FROM "customers"',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ])('rejects %s', (sql) => {
    expect(v(sql)).toThrow(SupportConnectorError);
  });

  it('blocks tables outside the role and unknown tables', () => {
    expect(v('SELECT * FROM orders', 'guest')).toThrow(/not accessible/);
    expect(v('SELECT * FROM secrets')).toThrow(SupportConnectorError);
  });

  it('blocks explicit denied columns, even in WHERE', () => {
    expect(v('SELECT password_hash FROM customers')).toThrow(SupportConnectorError);
    expect(v("SELECT id FROM customers WHERE secret_note LIKE 'V%'", 'admin')).toThrow(SupportConnectorError);
  });

  it('wraps locked tables and caps LIMIT', () => {
    const r = validateAndRewriteSupportSql('SELECT * FROM orders o WHERE o.status = \'shipped\' LIMIT 9999;', ctx('customer'), source);
    expect(r.rewrittenSql).toContain('(SELECT * FROM orders WHERE user_id = $__support_user_id) AS o');
    expect(r.rewrittenSql).toMatch(/LIMIT 50$/);
    expect(r.params).toEqual({ __support_user_id: 'cust_101' });
    expect(r.referencedTables).toEqual(['orders']);
    const a = validateAndRewriteSupportSql('SELECT * FROM orders', ctx('admin'), source);
    expect(a.rewrittenSql).toBe('SELECT * FROM orders LIMIT 50');
  });

  it('does not treat string literals as SQL', () => {
    const r = validateAndRewriteSupportSql("SELECT * FROM products WHERE name = 'drop; -- from orders'", ctx('guest'), source);
    expect(r.referencedTables).toEqual(['products']);
    expect(r.rewrittenSql).toContain("'drop; -- from orders'");
  });
});

describe('sqlite sandbox execution', () => {
  it('has seed data', () => {
    expect(DEFAULT_ECOMMERCE_SANDBOX_SQL).toContain('cust_102');
  });

  it('isolates rows per customer', async () => {
    const r = await query('customer', 'SELECT id, user_id FROM orders ORDER BY id');
    expect(r.rows.every((x) => x.user_id === 'cust_101')).toBe(true);
    expect(r.rowCount).toBe(2);
    const probe = await query('customer', "SELECT * FROM orders WHERE user_id = 'cust_102' OR 1=1");
    expect(probe.rows.every((x) => x.user_id === 'cust_101')).toBe(true);
    const other = await query('customer', 'SELECT * FROM orders', 'cust_102');
    expect(other.rowCount).toBe(2);
    expect(other.rows.every((x) => x.user_id === 'cust_102')).toBe(true);
  });

  it('isolation applies through JOINs', async () => {
    const r = await query('customer', 'SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.user_id');
    expect(r.rows.map((x) => x.name)).toEqual(['Alice Nguyen', 'Alice Nguyen']);
  });

  it('staff/admin see all rows; guest sees products only', async () => {
    expect((await query('admin', 'SELECT * FROM orders')).rowCount).toBe(4);
    expect((await query('staff', 'SELECT * FROM orders')).rowCount).toBe(4);
    expect((await query('guest', 'SELECT * FROM products')).rowCount).toBe(4);
    await expect(query('guest', 'SELECT * FROM orders')).rejects.toMatchObject({ status: 403 });
  });

  it('strips deniedColumns from SELECT *', async () => {
    const r = await query('admin', 'SELECT * FROM customers');
    expect(r.rowCount).toBe(2);
    for (const row of r.rows) {
      expect(row).not.toHaveProperty('password_hash');
      expect(row).not.toHaveProperty('secret_note');
      expect(row).toHaveProperty('email');
    }
  });

  it('caps rows to maxRows', async () => {
    const r = await executeSupportDbQuery({
      source: { ...source, maxRows: 1 }, context: ctx('admin'), sql: 'SELECT * FROM orders LIMIT 100',
    });
    expect(r.rowCount).toBe(1);
  });
});

describe('sql-http driver', () => {
  it('posts rewritten SQL and strips denied columns', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ rows: [{ id: 'cust_101', email: 'a@x', password_hash: 'h' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await executeSupportDbQuery({
      source: { ...source, driver: 'sql-http', connectionUrl: 'https://db.example.com/q' },
      context: ctx('customer'), sql: 'SELECT * FROM customers', authToken: 'tok',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://db.example.com/q');
    const body = JSON.parse(init.body as string);
    expect(body.params).toEqual({ __support_user_id: 'cust_101' });
    expect(body.sql).toContain('WHERE id = $__support_user_id');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(r.rows).toEqual([{ id: 'cust_101', email: 'a@x' }]);
  });
});
