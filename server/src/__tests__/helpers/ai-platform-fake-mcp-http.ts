import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import {
  MCP_PROTOCOL_VERSION,
  type McpToolDescriptor,
} from '@freellmapi/shared/ai-platform-mcp.js';

export interface RecordedMcpHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
  bodyJson: unknown;
  timestamp: number;
}

export interface FakeMcpHttpConfig {
  protocolVersion?: string;
  serverInfo?: Record<string, unknown>;
  sessionId?: string | null;
  requireSession?: boolean;
  responseMode?: 'json' | 'sse';
  sseIncludeNoiseNotification?: boolean;
  sseHangAfterHeaders?: boolean;
  sseOversizedFrameBytes?: number;
  pageSize?: number;
  cursorMode?: 'normal' | 'cycle' | 'infinite';
  delayMs?: number;
  disconnectOnMethod?: string | null;
  httpErrorOnMethod?: Record<string, { status: number; body?: string }>;
  redirect?: { status: number; location: string; remaining?: number } | null;
  tools?: McpToolDescriptor[];
  onToolCall?: (
    name: string,
    args: unknown,
    req: RecordedMcpHttpRequest,
  ) => {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
}

export interface FakeMcpHttpServer {
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  readonly requests: RecordedMcpHttpRequest[];
  getDispatchCount(method?: string): number;
  setConfig(patch: Partial<FakeMcpHttpConfig>): void;
  expireSession(): void;
  reset(): void;
  close(): Promise<void>;
}

function defaultTools(): McpToolDescriptor[] {
  return [
    {
      name: 'lookup_order',
      description: 'Retrieve order information by order ID.',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'Order identifier' },
        },
        required: ['order_id'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'refund_order',
      description: 'Issue a refund for an order.',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['order_id', 'amount'],
      },
      annotations: { readOnlyHint: false },
    },
  ];
}

export async function startFakeMcpHttpServer(
  initialConfig: Partial<FakeMcpHttpConfig> = {},
): Promise<FakeMcpHttpServer> {
  let config: FakeMcpHttpConfig = {
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverInfo: { name: 'fake-mcp-http', version: '1.0.0' },
    sessionId: 'sess-initial-1',
    requireSession: false,
    responseMode: 'json',
    sseIncludeNoiseNotification: false,
    sseHangAfterHeaders: false,
    pageSize: 100,
    cursorMode: 'normal',
    delayMs: 0,
    disconnectOnMethod: null,
    httpErrorOnMethod: {},
    redirect: null,
    tools: defaultTools(),
    ...initialConfig,
  };

  let sessionCounter = 1;
  let activeSessionId: string | null = config.sessionId ?? null;
  const requests: RecordedMcpHttpRequest[] = [];
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      let bodyJson: unknown = null;
      if (bodyText.trim().length > 0) {
        try {
          bodyJson = JSON.parse(bodyText);
        } catch {
          bodyJson = null;
        }
      }

      const recorded: RecordedMcpHttpRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: { ...req.headers },
        bodyText,
        bodyJson,
        timestamp: Date.now(),
      };
      requests.push(recorded);

      if (config.delayMs && config.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.delayMs));
        if (res.destroyed) return;
      }

      if (config.redirect && (config.redirect.remaining === undefined || config.redirect.remaining > 0)) {
        if (config.redirect.remaining !== undefined) {
          config.redirect.remaining -= 1;
        }
        res.writeHead(config.redirect.status, {
          Location: config.redirect.location,
        });
        res.end();
        return;
      }

      const rpc = (bodyJson && typeof bodyJson === 'object' ? bodyJson : {}) as {
        id?: string | number | null;
        method?: string;
        params?: Record<string, unknown>;
      };
      const rpcMethod = rpc.method ?? '';

      if (config.disconnectOnMethod && rpcMethod === config.disconnectOnMethod) {
        req.socket.destroy();
        return;
      }

      const errOverride = config.httpErrorOnMethod?.[rpcMethod];
      if (errOverride) {
        res.writeHead(errOverride.status, { 'Content-Type': 'application/json' });
        res.end(errOverride.body ?? JSON.stringify({ error: `HTTP ${errOverride.status}` }));
        return;
      }

      if (rpcMethod === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
        return;
      }

      if (rpcMethod !== 'initialize' && config.requireSession) {
        const headerSid = req.headers['mcp-session-id'];
        if (!activeSessionId || headerSid !== activeSessionId) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id ?? null,
              error: { code: -32001, message: 'Session not found' },
            }),
          );
          return;
        }
      }

      const sendJsonRpc = (payload: unknown, extraHeaders: Record<string, string> = {}) => {
        if (config.responseMode === 'sse') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...extraHeaders,
          });
          if (config.sseHangAfterHeaders) {
            return;
          }
          if (config.sseOversizedFrameBytes && config.sseOversizedFrameBytes > 0) {
            res.write(`data: ${'a'.repeat(config.sseOversizedFrameBytes)}\n\n`);
            res.end();
            return;
          }
          if (config.sseIncludeNoiseNotification) {
            res.write(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`,
            );
          }
          res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          res.end();
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          ...extraHeaders,
        });
        res.end(JSON.stringify(payload));
      };

      if (rpcMethod === 'initialize') {
        if (config.sessionId !== null) {
          sessionCounter += 1;
          activeSessionId =
            config.sessionId === undefined
              ? `sess-${sessionCounter}`
              : activeSessionId ?? `${config.sessionId}-${sessionCounter}`;
        }
        const headers: Record<string, string> = {};
        if (activeSessionId) {
          headers['Mcp-Session-Id'] = activeSessionId;
        }
        sendJsonRpc(
          {
            jsonrpc: '2.0',
            id: rpc.id ?? 1,
            result: {
              protocolVersion: config.protocolVersion ?? MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: config.serverInfo ?? { name: 'fake-mcp-http', version: '1.0.0' },
            },
          },
          headers,
        );
        return;
      }

      if (rpcMethod === 'tools/list') {
        const allTools = config.tools ?? [];
        const pageSize = Math.max(1, config.pageSize ?? 100);
        const cursorRaw = typeof rpc.params?.cursor === 'string' ? rpc.params.cursor : '0';

        if (config.cursorMode === 'cycle') {
          const nextCursor = cursorRaw === '0' ? 'c1' : 'c1';
          sendJsonRpc({
            jsonrpc: '2.0',
            id: rpc.id ?? 2,
            result: {
              tools: allTools.slice(0, 1),
              nextCursor,
            },
          });
          return;
        }

        if (config.cursorMode === 'infinite') {
          const idx = Number.parseInt(cursorRaw, 10) || 0;
          sendJsonRpc({
            jsonrpc: '2.0',
            id: rpc.id ?? 2,
            result: {
              tools: allTools.slice(0, 1),
              nextCursor: String(idx + 1),
            },
          });
          return;
        }

        const offset = Number.parseInt(cursorRaw, 10) || 0;
        const page = allTools.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        const nextCursor = nextOffset < allTools.length ? String(nextOffset) : undefined;
        sendJsonRpc({
          jsonrpc: '2.0',
          id: rpc.id ?? 2,
          result: {
            tools: page,
            ...(nextCursor ? { nextCursor } : {}),
          },
        });
        return;
      }

      if (rpcMethod === 'tools/call') {
        const toolName = String(rpc.params?.name ?? '');
        const toolArgs = rpc.params?.arguments ?? {};
        if (config.onToolCall) {
          const custom = config.onToolCall(toolName, toolArgs, recorded);
          sendJsonRpc({
            jsonrpc: '2.0',
            id: rpc.id ?? 3,
            result: {
              content: custom.content ?? [],
              ...(custom.structuredContent !== undefined
                ? { structuredContent: custom.structuredContent }
                : {}),
              isError: Boolean(custom.isError),
            },
          });
          return;
        }

        if (toolName === 'lookup_order') {
          const orderId = (toolArgs as { order_id?: string }).order_id ?? 'unknown';
          sendJsonRpc({
            jsonrpc: '2.0',
            id: rpc.id ?? 3,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ order_id: orderId, status: 'shipped', total: 42 }),
                },
              ],
              isError: false,
            },
          });
          return;
        }

        if (toolName === 'refund_order') {
          const { order_id, amount } = toolArgs as { order_id?: string; amount?: number };
          sendJsonRpc({
            jsonrpc: '2.0',
            id: rpc.id ?? 3,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ refund_id: `rfnd-${order_id}`, amount, status: 'approved' }),
                },
              ],
              isError: false,
            },
          });
          return;
        }

        sendJsonRpc({
          jsonrpc: '2.0',
          id: rpc.id ?? 3,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }],
            isError: true,
          },
        });
        return;
      }

      sendJsonRpc({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: -32601, message: `Method not found: ${rpcMethod}` },
      });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    url: `${origin}/mcp`,
    origin,
    port: addr.port,
    requests,
    getDispatchCount(method?: string): number {
      if (!method) return requests.length;
      return requests.filter((r) => {
        const rpc = r.bodyJson as { method?: string } | null;
        return rpc?.method === method;
      }).length;
    },
    setConfig(patch: Partial<FakeMcpHttpConfig>): void {
      config = { ...config, ...patch };
      if (patch.sessionId !== undefined) {
        activeSessionId = patch.sessionId;
      }
    },
    expireSession(): void {
      activeSessionId = `expired-${Date.now()}`;
    },
    reset(): void {
      requests.length = 0;
      sessionCounter = 1;
      activeSessionId = 'sess-initial-1';
      config = {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'fake-mcp-http', version: '1.0.0' },
        sessionId: 'sess-initial-1',
        requireSession: false,
        responseMode: 'json',
        sseIncludeNoiseNotification: false,
        sseHangAfterHeaders: false,
        pageSize: 100,
        cursorMode: 'normal',
        delayMs: 0,
        disconnectOnMethod: null,
        httpErrorOnMethod: {},
        redirect: null,
        tools: defaultTools(),
        ...initialConfig,
      };
    },
    async close(): Promise<void> {
      for (const s of sockets) {
        s.destroy();
      }
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
