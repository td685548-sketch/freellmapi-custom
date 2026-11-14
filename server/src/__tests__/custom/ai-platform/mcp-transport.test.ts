import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MCP_LIMITS,
  MCP_PROTOCOL_VERSION,
} from '@freellmapi/shared/ai-platform-mcp.js';
import type { McpTransportConfig } from '../../../custom/ai-platform/mcp-client/store.js';
import {
  McpTransportError,
  mcpCallTool,
  mcpInitialize,
  mcpListTools,
} from '../../../custom/ai-platform/mcp-client/transport.js';
import {
  startFakeMcpHttpServer,
  type FakeMcpHttpServer,
} from '../../helpers/ai-platform-fake-mcp-http.js';

function makeConfig(
  url: string,
  overrides: Partial<McpTransportConfig> = {},
): McpTransportConfig {
  return {
    serverId: 1,
    slug: 'fake-mcp',
    url,
    authKind: 'none',
    authHeaderName: null,
    secret: null,
    timeoutMs: MCP_LIMITS.defaultTimeoutMs,
    maxResultBytes: MCP_LIMITS.defaultMaxResultBytes,
    maxConcurrency: MCP_LIMITS.defaultMaxConcurrency,
    revision: 1,
    credentialGeneration: 1,
    ...overrides,
  };
}

describe('MCP HTTP Transport (T036 / T043)', () => {
  let fakeServer: FakeMcpHttpServer;

  beforeEach(async () => {
    fakeServer = await startFakeMcpHttpServer();
  });

  afterEach(async () => {
    await fakeServer.close();
    vi.restoreAllMocks();
  });

  it('requires explicit allowedInternalOrigins for http://127.0.0.1 and succeeds when allowlisted', async () => {
    const cfg = makeConfig(fakeServer.url);
    const ac = new AbortController();

    await expect(
      mcpInitialize(cfg, ac.signal, { allowedInternalOrigins: [] }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      code: 'unsafe_url',
    });

    const session = await mcpInitialize(cfg, ac.signal, {
      allowedInternalOrigins: [fakeServer.origin],
    });
    expect(session.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(session.sessionId).toBeTruthy();
    expect(fakeServer.getDispatchCount('initialize')).toBe(1);
    expect(fakeServer.getDispatchCount('notifications/initialized')).toBe(1);
    const initReq = fakeServer.requests[0];
    expect(String(initReq.headers['accept'])).toContain('application/json');
    expect(String(initReq.headers['accept'])).toContain('text/event-stream');
  });

  it('fails closed on unsupported negotiated protocolVersion', async () => {
    fakeServer.setConfig({ protocolVersion: '2026-07-28' });
    const cfg = makeConfig(fakeServer.url);
    const ac = new AbortController();

    await expect(
      mcpInitialize(cfg, ac.signal, { allowedInternalOrigins: [fakeServer.origin] }),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      code: 'protocol',
    });
  });

  it('supports SSE responses, ignores unrelated notifications, and correlates by JSON-RPC id', async () => {
    fakeServer.setConfig({
      responseMode: 'sse',
      sseIncludeNoiseNotification: true,
    });
    const cfg = makeConfig(fakeServer.url, {
      authKind: 'bearer',
      secret: 'top-secret-token',
    });
    const ac = new AbortController();
    const opts = { allowedInternalOrigins: [fakeServer.origin] };

    const session = await mcpInitialize(cfg, ac.signal, opts);
    const res = await mcpCallTool(cfg, session, 'lookup_order', { order_id: 'ORD-1' }, ac.signal, opts);

    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content)).toMatchObject({ order_id: 'ORD-1', status: 'shipped' });
    const callReq = fakeServer.requests.find((r) =>
      String(r.bodyText).includes('tools/call'),
    );
    expect(callReq?.headers['authorization']).toBe('Bearer top-secret-token');
    expect(callReq?.headers['mcp-session-id']).toBe(session.sessionId);
    expect(callReq?.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION);
  });

  it('paginates tools/list via cursor and rejects cursor cycles', async () => {
    fakeServer.setConfig({
      pageSize: 1,
      tools: [
        { name: 't1', description: 'd1', inputSchema: { type: 'object' } },
        { name: 't2', description: 'd2', inputSchema: { type: 'object' } },
        { name: 't3', description: 'd3', inputSchema: { type: 'object' } },
      ],
    });
    const cfg = makeConfig(fakeServer.url);
    const ac = new AbortController();
    const opts = { allowedInternalOrigins: [fakeServer.origin] };

    const session = await mcpInitialize(cfg, ac.signal, opts);
    const tools = await mcpListTools(cfg, session, ac.signal, opts);
    expect(tools.map((t) => t.name)).toEqual(['t1', 't2', 't3']);

    fakeServer.setConfig({ cursorMode: 'cycle' });
    await expect(mcpListTools(cfg, session, ac.signal, opts)).rejects.toMatchObject({
      name: 'McpTransportError',
      code: 'protocol',
    });
  });

  it('reinitializes once on 404 session for read-only calls, and NEVER retries write calls on 404 or disconnect', async () => {
    fakeServer.setConfig({ requireSession: true });
    const cfg = makeConfig(fakeServer.url);
    const ac = new AbortController();
    const opts = { allowedInternalOrigins: [fakeServer.origin] };

    const session = await mcpInitialize(cfg, ac.signal, opts);
    fakeServer.expireSession();

    // Read-only / retryOn404: true -> reinitializes once and succeeds
    const readRes = await mcpCallTool(
      cfg,
      session,
      'lookup_order',
      { order_id: 'ORD-2' },
      ac.signal,
      { ...opts, retryOn404: true },
    );
    expect(JSON.parse(readRes.content)).toMatchObject({ order_id: 'ORD-2' });
    expect(fakeServer.getDispatchCount('initialize')).toBe(2);

    // Write / retryOn404: false -> does NOT reinitialize or resend on 404
    fakeServer.expireSession();
    const beforeWrites = fakeServer.getDispatchCount('tools/call');
    await expect(
      mcpCallTool(
        cfg,
        session,
        'refund_order',
        { order_id: 'ORD-2', amount: 10 },
        ac.signal,
        { ...opts, retryOn404: false },
      ),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      uncertain: true,
    });
    expect(fakeServer.getDispatchCount('tools/call')).toBe(beforeWrites + 1);
    expect(fakeServer.getDispatchCount('initialize')).toBe(2);

    // Write disconnect after send -> uncertain, no retry
    fakeServer.setConfig({ requireSession: false, disconnectOnMethod: 'tools/call' });
    const beforeDisconnect = fakeServer.getDispatchCount('tools/call');
    await expect(
      mcpCallTool(
        cfg,
        session,
        'refund_order',
        { order_id: 'ORD-3', amount: 25 },
        ac.signal,
        { ...opts, retryOn404: false },
      ),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      uncertain: true,
    });
    expect(fakeServer.getDispatchCount('tools/call')).toBe(beforeDisconnect + 1);
  });

  it('truncates parsed tool content at maxResultBytes (262144) with marker without corrupting JSON-RPC', async () => {
    const bigText = 'A'.repeat(300_000);
    fakeServer.setConfig({
      onToolCall: () => ({
        content: [{ type: 'text', text: bigText }],
        isError: false,
      }),
    });
    const cfg = makeConfig(fakeServer.url, { maxResultBytes: 262_144 });
    const ac = new AbortController();
    const opts = { allowedInternalOrigins: [fakeServer.origin] };

    const session = await mcpInitialize(cfg, ac.signal, opts);
    const res = await mcpCallTool(cfg, session, 'lookup_order', { order_id: 'BIG' }, ac.signal, opts);

    expect(res.truncated).toBe(true);
    expect(res.bytes).toBeGreaterThan(262_144);
    expect(Buffer.byteLength(res.content, 'utf8')).toBeLessThanOrEqual(262_144);
    expect(res.content).toContain('[truncated]');
  });

  it('enforces per-server timeout deadline and maxConcurrency=4 with clean abort/slot release', async () => {
    fakeServer.setConfig({ delayMs: 250 });
    const cfg = makeConfig(fakeServer.url, { timeoutMs: 80, maxConcurrency: 4 });
    const opts = { allowedInternalOrigins: [fakeServer.origin] };

    await expect(
      mcpInitialize(cfg, new AbortController().signal, opts),
    ).rejects.toMatchObject({
      name: 'McpTransportError',
      code: 'timeout',
    });

    // Concurrency test: 6 parallel calls with maxConcurrency=2
    fakeServer.setConfig({ delayMs: 40 });
    const cfg2 = makeConfig(fakeServer.url, { timeoutMs: 5_000, maxConcurrency: 2 });
    const session = await mcpInitialize(cfg2, new AbortController().signal, opts);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mcpCallTool(cfg2, session, 'lookup_order', { order_id: `C-${i}` }, new AbortController().signal, opts),
      ),
    );
    expect(results).toHaveLength(6);
  }, 10_000);

  it('invalidates session when revision, credentialGeneration, or origin changes', async () => {
    const cfg = makeConfig(fakeServer.url, { revision: 1, credentialGeneration: 1 });
    const opts = { allowedInternalOrigins: [fakeServer.origin] };
    const session = await mcpInitialize(cfg, new AbortController().signal, opts);

    const staleCfg = makeConfig(fakeServer.url, { revision: 2, credentialGeneration: 1 });
    await expect(
      mcpListTools(staleCfg, session, new AbortController().signal, opts),
    ).rejects.toBeInstanceOf(McpTransportError);
  });
});
