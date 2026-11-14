/**
 * fake-mcp-server.ts
 *
 * In-process MCP fake server for unit/integration tests.
 * Does NOT start any real HTTP server or network socket.
 * Synthetic types are defined here because the real modules do not exist yet.
 */

// ---------------------------------------------------------------------------
// Synthetic types (replace with real imports once the modules exist)
// ---------------------------------------------------------------------------

export interface McpToolDescriptor {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export class McpTransportError extends Error {
  constructor(
    public readonly transport: string,
    message?: string,
  ) {
    super(message ?? `McpTransportError(${transport})`);
    this.name = 'McpTransportError';
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface McpCallResult {
  content: string;
  isError: boolean;
  bytes: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// FakeMcpServer interface
// ---------------------------------------------------------------------------

export interface FakeMcpServer {
  /** The tool descriptors list (what mcpListTools would return). */
  tools: McpToolDescriptor[];
  /** Handle a tool call; returns a result for the given tool name. */
  handleCall(name: string, args: unknown): McpCallResult;
  /** Control mode for testing error paths. */
  setMode(mode: 'normal' | 'hang' | 'huge_response' | 'redirect' | 'desc_change'): void;
  /** Reset to normal mode. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Mode type
// ---------------------------------------------------------------------------

type Mode = 'normal' | 'hang' | 'huge_response' | 'redirect' | 'desc_change';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONE_MB_STRING: string = 'x'.repeat(1024 * 1024);

function makeResult(content: string, isError = false): McpCallResult {
  const bytes = Buffer.byteLength(content, 'utf8');
  return { content, isError, bytes, truncated: false };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function handleLookupOrder(args: unknown): McpCallResult {
  const { order_id } = args as { order_id: string };
  const payload = JSON.stringify({
    order_id,
    status: 'shipped',
    total: 99.99,
    currency: 'USD',
    created_at: '2024-01-15T10:00:00Z',
    items: [{ sku: 'ACME-001', qty: 1, price: 99.99 }],
  });
  return makeResult(payload);
}

function handleRefundOrder(args: unknown): McpCallResult {
  const { order_id, amount } = args as { order_id: string; amount: number };
  const payload = JSON.stringify({
    refund_id: `rfnd-${order_id}-${Date.now()}`,
    order_id,
    amount,
    currency: 'USD',
    status: 'approved',
    processed_at: new Date().toISOString(),
  });
  return makeResult(payload);
}

// ---------------------------------------------------------------------------
// Base tool descriptors
// ---------------------------------------------------------------------------

function buildBaseTools(): McpToolDescriptor[] {
  return [
    {
      name: 'lookup_order',
      description: 'Retrieve order information by order ID.',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'The unique order identifier.' },
        },
        required: ['order_id'],
      },
    },
    {
      name: 'refund_order',
      description: 'Issue a refund for a specified order.',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: 'The unique order identifier.' },
          amount: { type: 'number', description: 'Amount to refund in the order currency.' },
        },
        required: ['order_id', 'amount'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createFakeMcpServer(): FakeMcpServer {
  let mode: Mode = 'normal';
  let descCallCount = 0;
  let tools: McpToolDescriptor[] = buildBaseTools();

  const server: FakeMcpServer = {
    get tools(): McpToolDescriptor[] {
      return tools;
    },

    handleCall(name: string, args: unknown): McpCallResult {
      // --- hang mode: return a promise that never settles ---
      if (mode === 'hang') {
        // The return type is synchronous, so we simulate a hang by throwing a
        // special sentinel. Tests that need to test hang behaviour should wrap
        // the call in a timeout / Promise.race.  Alternatively we block by
        // returning a never-settling promise cast to the return type for
        // async-aware callers.
        //
        // Because the interface requires a synchronous return value we throw,
        // which surfaces the same problem to callers.
        throw new Error('McpHang: tool call intentionally hung for testing');
      }

      // --- huge_response mode ---
      if (mode === 'huge_response') {
        return {
          content: ONE_MB_STRING,
          isError: false,
          bytes: ONE_MB_STRING.length,
          truncated: true,
        };
      }

      // --- redirect mode ---
      if (mode === 'redirect') {
        throw new McpTransportError('http', 'Unexpected HTTP status 302 during tool call');
      }

      // --- desc_change mode ---
      if (mode === 'desc_change') {
        descCallCount += 1;
        // Mutate the lookup_order description on every call to simulate a
        // server that changes its tool descriptors between calls.
        tools = tools.map((t) =>
          t.name === 'lookup_order'
            ? { ...t, description: `Retrieve order info (rev ${descCallCount}).` }
            : t,
        );
      }

      // --- normal / desc_change dispatch ---
      switch (name) {
        case 'lookup_order':
          return handleLookupOrder(args);
        case 'refund_order':
          return handleRefundOrder(args);
        default:
          return makeResult(
            JSON.stringify({ error: `Unknown tool: ${name}` }),
            true,
          );
      }
    },

    setMode(newMode: Mode): void {
      mode = newMode;
    },

    reset(): void {
      mode = 'normal';
      descCallCount = 0;
      tools = buildBaseTools();
    },
  };

  return server;
}
