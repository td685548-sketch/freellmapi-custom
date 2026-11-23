import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARD_DETECTORS,
  DEFAULT_GUARD_POLICY_BASE,
} from '@freellmapi/shared/ai-platform-output-guard.js';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { generatePkceS256Pair } from '../../../custom/ai-platform/mcp-client/oauth.js';
import {
  computeNextCronRunAt,
  isFlowSchedulerRunning,
  parseCronExpression,
  stopFlowScheduler,
  tickFlowSchedules,
} from '../../../custom/ai-platform/orchestrator/scheduler.js';
import { extractInboundTraceIdentity } from '../../../custom/ai-platform/tracing/collector.js';
import { pruneExpiredTraces } from '../../../custom/ai-platform/tracing/store.js';
import { purgeScope } from '../../../custom/ai-platform/scope.js';
import { getDb, initDb } from '../../../db/index.js';
import { createSession, createUser } from '../../../services/auth.js';
import { dashboardSessionHeaders } from '../../helpers/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { resetQuotaCaches } from '../../../services/usage-quotas.js';

interface FakeUpstreamState {
  delayMs: number;
  mode: 'plain' | 'read_tool' | 'write_approval';
  calls: Array<{ messages: Array<Record<string, unknown>>; headers: http.IncomingHttpHeaders }>;
}

interface FakeOAuthMcpState {
  requireBearer: boolean;
  expectedClientId: string;
  expectedClientSecret: string;
  activeAccessToken: string;
  activeRefreshToken: string;
  issuedCodes: Map<string, { codeChallenge: string; redirectUri: string }>;
  refreshCallCount: number;
  revokedTokens: string[];
  mcpAuthHeaders: string[];
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

const FAKE_UPSTREAM_SECRET = ['sk', 'proj', 'secrettoken1234567890abcdef'].join('-');

function readJsonBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildMockRequest(
  headers: Record<string, string>,
  opts?: { method?: string; url?: string; body?: unknown },
): Request {
  const url = opts?.url ?? '/v1/chat/completions';
  return {
    method: opts?.method ?? 'POST',
    url,
    originalUrl: url,
    path: url,
    headers,
    body: opts?.body ?? {},
  } as unknown as Request;
}

let upstreamServer: http.Server;
let upstreamBaseUrl = '';
const upstreamState: FakeUpstreamState = {
  delayMs: 0,
  mode: 'plain',
  calls: [],
};

let oauthMcpServer: http.Server;
let oauthMcpOrigin = '';
const oauthMcpState: FakeOAuthMcpState = {
  requireBearer: false,
  expectedClientId: 'mcp-client-035',
  expectedClientSecret: 'super-secret-oauth-client-035',
  activeAccessToken: 'tok_initial_access_secret_035',
  activeRefreshToken: 'tok_initial_refresh_secret_035',
  issuedCodes: new Map(),
  refreshCallCount: 0,
  revokedTokens: [],
  mcpAuthHeaders: [],
  toolCalls: [],
};

let appServer: http.Server | null = null;
let baseUrl = '';
let primaryToken = '';
let viewerOnlyToken = '';
let profileId = 0;
let profileKey = '';
let secondProfileId = 0;

async function apiCall(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.token ?? primaryToken ? dashboardSessionHeaders(opts.token ?? primaryToken) : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, headers: res.headers, body: json };
}

async function enableOutputMaskingForProfile(targetProfileId: number): Promise<void> {
  const getRes = await apiCall(`/api/ai-platform/output-guard/profile/${targetProfileId}`);
  expect(getRes.status).toBe(200);
  const current = getRes.body!.policy as { revision: number };
  const putRes = await apiCall(`/api/ai-platform/output-guard/profile/${targetProfileId}`, {
    method: 'PUT',
    body: {
      ...DEFAULT_GUARD_POLICY_BASE,
      mode: 'block',
      revision: current.revision,
      detectors: {
        ...DEFAULT_GUARD_DETECTORS,
        promptLeak: { enabled: false, minShingles: 2 },
        pii: { enabled: true, action: 'mask' },
      },
    },
  });
  expect(putRes.status).toBe(200);
}

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  process.env.PROXY_RATE_LIMIT_RPM = '0';

  upstreamServer = http.createServer(async (req, res) => {
    const raw = await readJsonBody(req);
    const parsed = (raw ? JSON.parse(raw) : {}) as {
      model?: string;
      messages?: Array<Record<string, unknown>>;
      stream?: boolean;
    };
    upstreamState.calls.push({
      messages: parsed.messages ?? [],
      headers: req.headers,
    });

    if (upstreamState.delayMs > 0) {
      await new Promise((r) => setTimeout(r, upstreamState.delayMs));
    }

    const messages = parsed.messages ?? [];
    const hasToolResult = messages.some((m) => m.role === 'tool');

    if (!hasToolResult && (upstreamState.mode === 'read_tool' || upstreamState.mode === 'write_approval')) {
      const toolName =
        upstreamState.mode === 'read_tool' ? 'mcp__orders__lookup_order' : 'mcp__orders__refund_order';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-tool-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: parsed.model ?? 'spec035-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_spec035_1',
                    type: 'function',
                    function: {
                      name: toolName,
                      arguments: JSON.stringify({ order_id: 'ORD-035' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 },
        }),
      );
      return;
    }

    const replyText = hasToolResult
      ? `Completed action for ORD-035 (contact ops-secret@example.com, token ${FAKE_UPSTREAM_SECRET}).`
      : 'Direct response from spec035-model.';

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-final-1',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.model ?? 'spec035-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: replyText },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 30,
          completion_tokens: 15,
          total_tokens: 45,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      }),
    );
  });
  upstreamServer.listen(0, '127.0.0.1');
  await new Promise<void>((r) => upstreamServer.once('listening', () => r()));
  upstreamBaseUrl = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}/v1`;

  oauthMcpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer: oauthMcpOrigin,
          authorization_endpoint: `${oauthMcpOrigin}/oauth/authorize`,
          token_endpoint: `${oauthMcpOrigin}/oauth/token`,
          revocation_endpoint: `${oauthMcpOrigin}/oauth/revoke`,
          code_challenge_methods_supported: ['S256'],
        }),
      );
      return;
    }

    if (url.pathname === '/oauth/redirect-trap/.well-known/oauth-authorization-server') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const raw = await readJsonBody(req);
      const params = new URLSearchParams(raw);
      const grantType = params.get('grant_type');
      const clientId = params.get('client_id');
      const clientSecret = params.get('client_secret');

      if (clientId !== oauthMcpState.expectedClientId || clientSecret !== oauthMcpState.expectedClientSecret) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }

      if (grantType === 'authorization_code') {
        const code = params.get('code') ?? '';
        const verifier = params.get('code_verifier') ?? '';
        const redirectUri = params.get('redirect_uri') ?? '';
        const issued = oauthMcpState.issuedCodes.get(code);
        if (!issued || issued.redirectUri !== redirectUri) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const computedChallenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
        if (computedChallenge !== issued.codeChallenge) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_pkce_verifier' }));
          return;
        }
        oauthMcpState.issuedCodes.delete(code);
        oauthMcpState.activeAccessToken = 'tok_pkce_access_secret_live_035';
        oauthMcpState.activeRefreshToken = 'tok_pkce_refresh_secret_live_035';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: oauthMcpState.activeAccessToken,
            refresh_token: oauthMcpState.activeRefreshToken,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'mcp:tools mcp:read',
          }),
        );
        return;
      }

      if (grantType === 'refresh_token') {
        const refreshToken = params.get('refresh_token') ?? '';
        if (refreshToken !== oauthMcpState.activeRefreshToken) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_refresh_token' }));
          return;
        }
        oauthMcpState.refreshCallCount += 1;
        await new Promise((r) => setTimeout(r, 40));
        oauthMcpState.activeAccessToken = `tok_rotated_access_${oauthMcpState.refreshCallCount}`;
        oauthMcpState.activeRefreshToken = `tok_rotated_refresh_${oauthMcpState.refreshCallCount}`;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: oauthMcpState.activeAccessToken,
            refresh_token: oauthMcpState.activeRefreshToken,
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        );
        return;
      }

      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      const raw = await readJsonBody(req);
      const params = new URLSearchParams(raw);
      oauthMcpState.revokedTokens.push(params.get('token') ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/mcp' && req.method === 'POST') {
      const authHeader = String(req.headers.authorization ?? '');
      oauthMcpState.mcpAuthHeaders.push(authHeader);
      if (oauthMcpState.requireBearer && authHeader !== `Bearer ${oauthMcpState.activeAccessToken}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const raw = await readJsonBody(req);
      const rpc = JSON.parse(raw) as { id?: number | string; method?: string; params?: Record<string, unknown> };
      if (rpc.method === 'notifications/initialized' || rpc.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (rpc.method === 'initialize') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'sess-035',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'fake-oauth-mcp', version: '1.0.0' },
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              tools: [
                {
                  name: 'lookup_order',
                  description: 'Read order status by ID',
                  inputSchema: {
                    type: 'object',
                    properties: { order_id: { type: 'string' } },
                    required: ['order_id'],
                  },
                  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
                },
                {
                  name: 'refund_order',
                  description: 'Issue refund for an order',
                  inputSchema: {
                    type: 'object',
                    properties: { order_id: { type: 'string' } },
                    required: ['order_id'],
                  },
                  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
                },
              ],
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name ?? '');
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        oauthMcpState.toolCalls.push({ name, args });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ tool: name, orderId: args.order_id ?? null, ok: true }),
                },
              ],
              isError: false,
            },
          }),
        );
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });
  oauthMcpServer.listen(0, '127.0.0.1');
  await new Promise<void>((r) => oauthMcpServer.once('listening', () => r()));
  oauthMcpOrigin = `http://127.0.0.1:${(oauthMcpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  stopFlowScheduler();
  await new Promise<void>((r) => upstreamServer.close(() => r()));
  await new Promise<void>((r) => oauthMcpServer.close(() => r()));
});

beforeEach(async () => {
  stopFlowScheduler();
  upstreamState.delayMs = 0;
  upstreamState.mode = 'plain';
  upstreamState.calls = [];

  oauthMcpState.requireBearer = false;
  oauthMcpState.activeAccessToken = 'tok_initial_access_secret_035';
  oauthMcpState.activeRefreshToken = 'tok_initial_refresh_secret_035';
  oauthMcpState.issuedCodes.clear();
  oauthMcpState.refreshCallCount = 0;
  oauthMcpState.revokedTokens = [];
  oauthMcpState.mcpAuthHeaders = [];
  oauthMcpState.toolCalls = [];

  initDb(':memory:');
  resetFlagsCacheForTests();
  resetKnowledgeIndexes();
  resetQuotaCaches();
  setKeyCacheTestOverride(true);
  getDb().prepare("DELETE FROM settings WHERE key = 'active_profile_id'").run();

  const app = createApp();
  appServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => appServer!.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;

  const owner = createUser('owner-035@example.com', 'Password123!');
  primaryToken = createSession(owner.userId);

  const nonAdmin = createUser('member-035@example.com', 'Password123!');
  viewerOnlyToken = createSession(nonAdmin.userId);

  // Register custom OpenAI-compatible upstream model with tool support
  const regRes = await apiCall('/api/keys/custom', {
    method: 'POST',
    body: {
      baseUrl: upstreamBaseUrl,
      model: 'spec035-model',
      displayName: 'Spec 035 Model',
      apiKey: 'sk-custom-upstream-key',
    },
  });
  expect(regRes.status).toBe(201);
  getDb().prepare("UPDATE models SET supports_tools = 1 WHERE model_id = 'spec035-model'").run();

  const p1 = await apiCall('/api/client-profiles', {
    method: 'POST',
    body: { name: 'trace-profile-alpha' },
  });
  expect(p1.status).toBe(201);
  profileId = p1.body!.id as number;
  profileKey = p1.body!.key as string;
  getDb()
    .prepare('UPDATE client_profiles SET ai_tools_enabled = 1, ai_tool_max_rounds = 6 WHERE id = ?')
    .run(profileId);

  const p2 = await apiCall('/api/client-profiles', {
    method: 'POST',
    body: { name: 'trace-profile-beta' },
  });
  expect(p2.status).toBe(201);
  secondProfileId = p2.body!.id as number;

  setFlags({
    prompts: true,
    retrieval: true,
    mcpClient: true,
    orchestrator: true,
    outputGuard: true,
    promptCache: true,
  });

  const allowRes = await apiCall('/api/ai-platform/mcp/allowed-internal-hosts', {
    method: 'PUT',
    body: { origins: [oauthMcpOrigin] },
  });
  expect(allowRes.status).toBe(200);
});

afterEach(async () => {
  stopFlowScheduler();
  if (appServer) {
    await new Promise<void>((r) => appServer!.close(() => r()));
    appServer = null;
  }
});

describe('Spec 035 — Hierarchical Request Span Tracing', () => {
  it('extracts traceId and threadId across AxonHub, Sentry, W3C, OpenCode, Codex, and Claude Code conventions', () => {
    const sentry = extractInboundTraceIdentity(
      buildMockRequest({ 'sentry-trace': '0123456789abcdef0123456789abcdef-89abcdef01234567-1' }),
    );
    expect(sentry.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(sentry.traceSource).toBe('sentry-trace');

    const w3c = extractInboundTraceIdentity(
      buildMockRequest({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }),
    );
    expect(w3c.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(w3c.traceSource).toBe('traceparent');

    const claudeCode = extractInboundTraceIdentity(
      buildMockRequest(
        {},
        {
          url: '/v1/messages',
          body: {
            metadata: {
              user_id:
                'user_9c4e0f_account_1234_session_550e8400-e29b-41d4-a716-446655440000',
            },
          },
        },
      ),
    );
    expect(claudeCode.traceId).toBe('cc-550e8400-e29b-41d4-a716-446655440000');
    expect(claudeCode.traceSource).toBe('claude-code');

    const codex = extractInboundTraceIdentity(
      buildMockRequest({ session_id: 'codex-sess-777', 'x-thread-id': 'thread-abc' }),
    );
    expect(codex.traceId).toBe('codex-sess-777');
    expect(codex.threadId).toBe('thread-abc');
    expect(codex.traceSource).toBe('codex');

    const opencode = extractInboundTraceIdentity(
      buildMockRequest({ 'x-opencode-session': 'opencode-run-999' }),
    );
    expect(opencode.traceId).toBe('opencode-run-999');
    expect(opencode.traceSource).toBe('opencode');
  });

  it('records hierarchical waterfall spans across prompt_render, retrieval, context_budget, mcp_tool_call, upstream_attempt, and output_guard with secret redaction', async () => {
    // Configure prompt + knowledge + output guard + read-only MCP tool for profileId
    getDb()
      .prepare('UPDATE client_profiles SET system_prompt = ?, kb_enabled = 1 WHERE id = ?')
      .run('You are a helpful order assistant for {{company}}.', profileId);
    addDoc(profileId, 'Shipping Policy', 'Order ORD-035 ships via priority courier.');

    await enableOutputMaskingForProfile(profileId);

    // Register & sync MCP server + approve read-only lookup_order + bind to profileId
    const srvRes = await apiCall('/api/ai-platform/mcp/servers', {
      method: 'POST',
      body: {
        slug: 'orders',
        name: 'Orders MCP',
        url: `${oauthMcpOrigin}/mcp`,
        authKind: 'bearer',
        secret: 'sk-static-mcp-secret-should-never-leak',
      },
    });
    expect(srvRes.status).toBe(201);
    const serverId = (srvRes.body!.server as { id: number }).id;

    const syncRes = await apiCall(`/api/ai-platform/mcp/servers/${serverId}/sync`, {
      method: 'POST',
    });
    expect(syncRes.status).toBe(200);

    const toolsRes = await apiCall(`/api/ai-platform/mcp/servers/${serverId}/tools`);
    const tools = toolsRes.body!.tools as Array<{ id: number; name: string }>;
    const lookupTool = tools.find((t) => t.name === 'lookup_order')!;
    expect(lookupTool).toBeDefined();

    const revRes = await apiCall(`/api/ai-platform/mcp/tools/${lookupTool.id}`, {
      method: 'PATCH',
      body: {
        state: 'allowed',
        effect: 'read',
      },
    });
    expect(revRes.status).toBe(200);

    const bindRes = await apiCall(`/api/ai-platform/mcp/bindings/profile/${profileId}`, {
      method: 'PUT',
      body: { toolIds: [lookupTool.id], enabled: true, maxRounds: 6 },
    });
    expect(bindRes.status).toBe(200);

    upstreamState.mode = 'read_tool';

    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profileKey}`,
        'content-type': 'application/json',
        'x-trace-id': 'axon-trace-035-waterfall',
        'x-thread-id': 'thread-orders-035',
        'x-freellm-vars': JSON.stringify({ company: 'AcmeCorp' }),
      },
      body: JSON.stringify({
        model: 'spec035-model',
        messages: [{ role: 'user', content: 'Where is order ORD-035?' }],
      }),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get('x-freellm-trace-id')).toBe('axon-trace-035-waterfall');
    const chatJson = (await chatRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    // PII email inside upstream completion was masked by output guard
    expect(chatJson.choices[0]?.message.content).not.toContain('ops-secret@example.com');

    // Non-admin user without view_ai_platform gets 403
    const forbiddenRes = await apiCall('/api/ai-platform/traces', { token: viewerOnlyToken });
    expect(forbiddenRes.status).toBe(403);

    // List traces scoped to profileId vs secondProfileId (isolation check)
    const otherScopeList = await apiCall(`/api/ai-platform/traces?scope=profile:${secondProfileId}`);
    expect(otherScopeList.status).toBe(200);
    expect((otherScopeList.body!.traces as unknown[]).length).toBe(0);

    const listRes = await apiCall(`/api/ai-platform/traces?scope=profile:${profileId}`);
    expect(listRes.status).toBe(200);
    const traces = listRes.body!.traces as Array<{
      traceId: string;
      threadId: string;
      traceSource: string;
      spansCount: number;
    }>;
    expect(traces.some((t) => t.traceId === 'axon-trace-035-waterfall')).toBe(true);

    const detailRes = await apiCall('/api/ai-platform/traces/axon-trace-035-waterfall');
    expect(detailRes.status).toBe(200);
    const trace = detailRes.body!.trace as {
      traceId: string;
      threadId: string;
      traceSource: string;
      rootSpan: {
        kind: string;
        durationMs: number;
        children: Array<{ kind: string; children: Array<{ kind: string }> }>;
      };
    };
    expect(trace.traceId).toBe('axon-trace-035-waterfall');
    expect(trace.threadId).toBe('thread-orders-035');
    expect(trace.traceSource).toBe('x-trace-id');
    expect(trace.rootSpan.kind).toBe('request');

    // Flatten all span kinds in the waterfall tree
    const kinds = new Set<string>();
    const walk = (node: { kind: string; children?: unknown[] }) => {
      kinds.add(node.kind);
      for (const child of (node.children ?? []) as Array<{ kind: string; children?: unknown[] }>) {
        walk(child);
      }
    };
    walk(trace.rootSpan);

    expect(kinds.has('request')).toBe(true);
    expect(kinds.has('prompt_render')).toBe(true);
    expect(kinds.has('retrieval')).toBe(true);
    expect(kinds.has('context_budget')).toBe(true);
    expect(kinds.has('mcp_tool_call')).toBe(true);
    expect(kinds.has('upstream_attempt')).toBe(true);
    expect(kinds.has('output_guard')).toBe(true);

    // Ensure no raw secrets appear anywhere in serialized trace JSON
    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain('sk-static-mcp-secret-should-never-leak');
    expect(serialized).not.toContain('sk-custom-upstream-key');
    expect(serialized).not.toContain(FAKE_UPSTREAM_SECRET);

    // Retention pruning removes expired traces matching AiPlatformRetention.runsDays
    getDb()
      .prepare("UPDATE custom_ai_request_traces SET started_at = datetime('now', '-45 days') WHERE trace_id = ?")
      .run('axon-trace-035-waterfall');
    const pruned = pruneExpiredTraces();
    expect(pruned).toBeGreaterThanOrEqual(1);

    const afterPrune = await apiCall('/api/ai-platform/traces/axon-trace-035-waterfall');
    expect(afterPrune.status).toBe(404);
  });
});

describe('Spec 035 — Remote MCP OAuth 2.1 + PKCE (S256)', () => {
  it('enforces SSRF guards on OAuth endpoints, encrypts tokens at rest, prevents PKCE state replay, and performs single-flight refresh', async () => {
    const pkce = generatePkceS256Pair();
    expect(pkce.codeChallengeMethod).toBe('S256');
    expect(pkce.codeChallenge).toBe(
      crypto.createHash('sha256').update(pkce.codeVerifier, 'ascii').digest('base64url'),
    );

    oauthMcpState.requireBearer = true;
    const srvRes = await apiCall('/api/ai-platform/mcp/servers', {
      method: 'POST',
      body: {
        slug: 'remote-oauth',
        name: 'Remote OAuth MCP',
        url: `${oauthMcpOrigin}/mcp`,
        authKind: 'oauth2',
        maxConcurrency: 8,
      },
    });
    expect(srvRes.status).toBe(201);
    const server = srvRes.body!.server as { id: number; oauthStatus?: string };
    expect(server.oauthStatus).toBe('unconfigured');

    // 1. SSRF checks: cloud metadata IPs/hosts & unallowlisted private/HTTP origins rejected with 422
    const ssrfMeta = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/config`, {
      method: 'PUT',
      body: {
        clientId: 'client-1',
        authorizationEndpoint: 'https://169.254.169.254/oauth/authorize',
        tokenEndpoint: 'https://169.254.169.254/oauth/token',
        redirectUri: 'https://app.example.com/callback',
      },
    });
    expect(ssrfMeta.status).toBe(422);

    const ssrfGcp = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/discover`, {
      method: 'POST',
      body: { issuerUrl: 'https://metadata.google.internal' },
    });
    expect(ssrfGcp.status).toBe(422);

    const ssrfPrivate = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/config`, {
      method: 'PUT',
      body: {
        clientId: 'client-1',
        authorizationEndpoint: 'https://10.20.30.40/oauth/authorize',
        tokenEndpoint: 'https://10.20.30.40/oauth/token',
        redirectUri: 'https://app.example.com/callback',
      },
    });
    expect(ssrfPrivate.status).toBe(422);

    // Redirect trap on discovery is blocked (redirect: 'manual')
    const ssrfRedirect = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/discover`, {
      method: 'POST',
      body: { issuerUrl: `${oauthMcpOrigin}/oauth/redirect-trap` },
    });
    expect(ssrfRedirect.status).toBe(422);

    // 2. Configure via RFC 8414 issuer discovery + encrypted clientSecret
    const redirectUri = 'https://console.example.com/ai-platform/mcp/callback';
    const cfgRes = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/config`, {
      method: 'PUT',
      body: {
        issuerUrl: oauthMcpOrigin,
        clientId: oauthMcpState.expectedClientId,
        clientSecret: oauthMcpState.expectedClientSecret,
        scopes: ['mcp:tools', 'mcp:read'],
        redirectUri,
      },
    });
    expect(cfgRes.status).toBe(200);
    const cfgView = cfgRes.body!.oauth as Record<string, unknown>;
    expect(cfgView.connectionStatus).toBe('unconfigured');
    expect(cfgView.hasClientSecret).toBe(true);
    expect(cfgView.authorizationEndpoint).toBe(`${oauthMcpOrigin}/oauth/authorize`);
    expect(cfgView.tokenEndpoint).toBe(`${oauthMcpOrigin}/oauth/token`);
    expect(JSON.stringify(cfgRes.body)).not.toContain(oauthMcpState.expectedClientSecret);

    // 3. Start PKCE S256 authorization
    const startRes = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/start`, {
      method: 'POST',
      body: {},
    });
    expect(startRes.status).toBe(200);
    const authUrl = new URL(String(startRes.body!.authorizationUrl));
    const state = String(startRes.body!.state);
    const codeChallenge = authUrl.searchParams.get('code_challenge')!;
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBe(state);

    // Verify PKCE state & code_verifier are NOT stored in plaintext in SQLite
    const rawPkceRows = JSON.stringify(
      getDb().prepare('SELECT * FROM custom_ai_mcp_oauth_pkce_states').all(),
    );
    expect(rawPkceRows).not.toContain(state);

    // Simulate authorization server issuing one-time auth code bound to code_challenge
    oauthMcpState.issuedCodes.set('auth_code_035_valid', {
      codeChallenge,
      redirectUri,
    });

    // 4. Complete callback -> exchanges code + decrypted PKCE code_verifier
    const cbRes = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/callback`, {
      method: 'POST',
      body: { code: 'auth_code_035_valid', state },
    });
    expect(cbRes.status).toBe(200);
    expect((cbRes.body!.oauth as { connectionStatus: string }).connectionStatus).toBe('connected');
    expect(JSON.stringify(cbRes.body)).not.toContain('tok_pkce_access_secret_live_035');
    expect(JSON.stringify(cbRes.body)).not.toContain('tok_pkce_refresh_secret_live_035');

    // Replaying the consumed PKCE state must fail immediately
    const replayRes = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/callback`, {
      method: 'POST',
      body: { code: 'auth_code_035_valid', state },
    });
    expect(replayRes.status).toBe(400);

    // Verify tokens & client_secret are AES-GCM encrypted at rest in SQLite
    const rawCredRow = JSON.stringify(
      getDb().prepare('SELECT * FROM custom_ai_mcp_oauth_credentials WHERE server_id = ?').get(server.id),
    );
    expect(rawCredRow).not.toContain(oauthMcpState.expectedClientSecret);
    expect(rawCredRow).not.toContain('tok_pkce_access_secret_live_035');
    expect(rawCredRow).not.toContain('tok_pkce_refresh_secret_live_035');

    // 5. Single-flight automatic refresh in transport.ts when token is expired
    getDb()
      .prepare("UPDATE custom_ai_mcp_oauth_credentials SET expires_at = datetime('now', '-5 minutes') WHERE server_id = ?")
      .run(server.id);

    const statusExpired = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/status`);
    expect((statusExpired.body!.oauth as { connectionStatus: string }).connectionStatus).toBe('expired');

    const concurrentTests = await Promise.all(
      Array.from({ length: 5 }, () =>
        apiCall(`/api/ai-platform/mcp/servers/${server.id}/test`, { method: 'POST' }),
      ),
    );
    for (const r of concurrentTests) {
      expect(r.status).toBe(200);
      expect(r.body!.ok).toBe(true);
      expect(r.body!.toolCount).toBe(2);
    }
    // Single-flight guarantee: 5 concurrent expired-token MCP requests triggered ONLY 1 token refresh!
    expect(oauthMcpState.refreshCallCount).toBe(1);
    expect(oauthMcpState.mcpAuthHeaders.every((h) => h === 'Bearer tok_rotated_access_1')).toBe(true);

    // 6. Revoke credentials -> calls revocation endpoint and resets to unconfigured
    const revokeRes = await apiCall(`/api/ai-platform/mcp/servers/${server.id}/oauth/revoke`, {
      method: 'POST',
    });
    expect(revokeRes.status).toBe(200);
    expect((revokeRes.body!.oauth as { connectionStatus: string }).connectionStatus).toBe('unconfigured');
    expect(oauthMcpState.revokedTokens.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Spec 035 — Async/Scheduled Orchestrator & Outer-Chat Approval Auto-Resume', () => {
  it('triggers 202 async background flow runs, executes due interval/cron schedules without running in tests by default, and records orchestrator_step spans', async () => {
    // Scheduler background timer must be OFF by default in Vitest
    expect(isFlowSchedulerRunning()).toBe(false);

    // Cron parser sanity check
    parseCronExpression('*/15 9-17 * * 1-5');
    const nextUtc = computeNextCronRunAt('*/15 9-17 * * 1-5', new Date('2026-11-18T09:02:00.000Z'));
    expect(nextUtc.toISOString()).toBe('2026-11-18T09:15:00.000Z');

    // Create specialist agent + flow + publish + grant to profileId
    const agentRes = await apiCall('/api/ai-platform/agents', {
      method: 'POST',
      body: {
        slug: 'digest-agent',
        name: 'Digest Specialist',
        description: 'Summarizes daily operations',
        model: 'spec035-model',
        systemPrompt: 'Provide concise operational summaries.',
        enabled: true,
      },
    });
    expect(agentRes.status).toBe(201);

    const flowRes = await apiCall('/api/ai-platform/flows', {
      method: 'POST',
      body: {
        slug: 'daily-digest',
        name: 'Daily Digest Flow',
        description: 'Async & scheduled flow',
        enabled: true,
        draft: {
          kind: 'single',
          entryAgent: 'digest-agent',
          agents: ['digest-agent'],
          handoffs: { 'digest-agent': [] },
          limits: {
            maxSteps: 6,
            maxToolCalls: 4,
            maxHandoffs: 2,
            maxTokens: 20_000,
            maxSeconds: 60,
          },
          awaitingApprovalText: 'Awaiting operator approval.',
          approvalTtlHours: 24,
        },
      },
    });
    expect(flowRes.status).toBe(201);
    const flow = flowRes.body!.flow as { id: number; revision: number };

    const pubRes = await apiCall(`/api/ai-platform/flows/${flow.id}/publish`, {
      method: 'POST',
      body: { revision: flow.revision },
    });
    expect(pubRes.status).toBe(200);

    const grantRes = await apiCall(`/api/ai-platform/flows/${flow.id}/grants`, {
      method: 'PUT',
      body: { profileIds: [profileId] },
    });
    expect(grantRes.status).toBe(200);

    // Add 120ms upstream latency so POST /runs/async demonstrably returns 202 while 'running'
    upstreamState.delayMs = 120;
    const asyncRes = await apiCall(`/api/ai-platform/flows/${flow.id}/runs/async`, {
      method: 'POST',
      body: {
        message: 'Generate async digest now',
        profileId,
      },
    });
    expect(asyncRes.status).toBe(202);
    const runId = String(asyncRes.body!.runId);
    const statusUrl = String(asyncRes.body!.statusUrl);
    expect(runId).toMatch(/^run_/);
    expect(statusUrl).toBe(`/api/ai-platform/runs/${runId}`);

    // Poll statusUrl until completed
    let runStatus = 'running';
    for (let i = 0; i < 30 && runStatus === 'running'; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      const poll = await apiCall(statusUrl);
      expect(poll.status).toBe(200);
      runStatus = (poll.body!.run as { status: string }).status;
    }
    expect(runStatus).toBe('completed');

    // Verify orchestrator_step span was captured in request traces
    const tracesList = await apiCall('/api/ai-platform/traces');
    expect((tracesList.body!.traces as unknown[]).length).toBeGreaterThanOrEqual(1);

    // Configure recurring cron schedule & tick explicitly
    upstreamState.delayMs = 0;
    const schedPut = await apiCall(`/api/ai-platform/flows/${flow.id}/schedule`, {
      method: 'PUT',
      body: {
        enabled: true,
        scheduleKind: 'cron',
        cronExpr: '*/5 * * * *',
        profileId,
        inputMessage: 'Scheduled 5-minute check',
      },
    });
    expect(schedPut.status).toBe(200);
    expect((schedPut.body!.schedule as { scheduleKind: string }).scheduleKind).toBe('cron');

    // Force schedule due now and tick once
    getDb()
      .prepare("UPDATE custom_ai_flow_schedules SET next_run_at = datetime('now', '-1 minute') WHERE flow_id = ?")
      .run(flow.id);

    const tick1 = await tickFlowSchedules();
    expect(tick1.triggeredRunIds).toHaveLength(1);

    // Wait briefly for background scheduled run to complete
    const schedRunId = tick1.triggeredRunIds[0]!;
    for (let i = 0; i < 20; i += 1) {
      const poll = await apiCall(`/api/ai-platform/runs/${schedRunId}`);
      if ((poll.body!.run as { status: string }).status === 'completed') break;
      await new Promise((r) => setTimeout(r, 30));
    }

    // Immediate second tick must NOT double-trigger because next_run_at advanced into the future
    const tick2 = await tickFlowSchedules();
    expect(tick2.triggeredRunIds).toHaveLength(0);

    const schedGet = await apiCall(`/api/ai-platform/flows/${flow.id}/schedule`);
    expect((schedGet.body!.schedule as { lastRunId: string }).lastRunId).toBe(schedRunId);
  });

  it('persists encrypted outer-chat continuation state on write-tool approval and auto-resumes assistant completion on approve (and marks rejected on reject)', async () => {
    await enableOutputMaskingForProfile(profileId);

    // Register MCP server, sync, approve write-classified refund_order tool, bind to profileId
    const srvRes = await apiCall('/api/ai-platform/mcp/servers', {
      method: 'POST',
      body: {
        slug: 'orders',
        name: 'Orders MCP',
        url: `${oauthMcpOrigin}/mcp`,
        authKind: 'none',
      },
    });
    expect(srvRes.status).toBe(201);
    const serverId = (srvRes.body!.server as { id: number }).id;

    const syncRes = await apiCall(`/api/ai-platform/mcp/servers/${serverId}/sync`, { method: 'POST' });
    expect(syncRes.status).toBe(200);

    const toolsRes = await apiCall(`/api/ai-platform/mcp/servers/${serverId}/tools`);
    const tools = toolsRes.body!.tools as Array<{ id: number; name: string }>;
    const refundTool = tools.find((t) => t.name === 'refund_order')!;
    expect(refundTool).toBeDefined();

    const revRes = await apiCall(`/api/ai-platform/mcp/tools/${refundTool.id}`, {
      method: 'PATCH',
      body: {
        state: 'allowed',
        effect: 'write',
      },
    });
    expect(revRes.status).toBe(200);

    const bindRes = await apiCall(`/api/ai-platform/mcp/bindings/profile/${profileId}`, {
      method: 'PUT',
      body: { toolIds: [refundTool.id], enabled: true, maxRounds: 6 },
    });
    expect(bindRes.status).toBe(200);

    upstreamState.mode = 'write_approval';

    // 1. Outer chat call triggers write-tool approval and pauses
    const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profileKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'spec035-model',
        messages: [{ role: 'user', content: 'Please refund order ORD-035 with VIP note.' }],
      }),
    });
    expect(chatRes.status).toBe(200);
    const pausedJson = (await chatRes.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(pausedJson.choices[0]?.message.content.toLowerCase()).toContain('approval');
    expect(oauthMcpState.toolCalls).toHaveLength(0);

    // Find pending approval
    const pendingRes = await apiCall('/api/ai-platform/approvals?status=pending');
    const approvals = pendingRes.body!.approvals as Array<{ id: number }>;
    expect(approvals).toHaveLength(1);
    const approvalId = approvals[0]!.id;

    // Verify paused conversation payload is encrypted at rest in custom_ai_chat_continuations
    const rawContRow = JSON.stringify(
      getDb().prepare('SELECT * FROM custom_ai_chat_continuations WHERE approval_id = ?').get(approvalId),
    );
    expect(rawContRow).not.toContain('Please refund order ORD-035 with VIP note.');

    const beforeCont = await apiCall(`/api/ai-platform/mcp/approvals/${approvalId}/continuation`);
    expect(beforeCont.status).toBe(200);
    expect((beforeCont.body!.continuation as { status: string }).status).toBe('awaiting_approval');

    // 2. Operator approves -> executes refund_order once AND auto-resumes assistant completion!
    const approveRes = await apiCall(`/api/ai-platform/approvals/${approvalId}/approve`, {
      method: 'POST',
      body: { note: 'Approved refund ORD-035' },
    });
    expect(approveRes.status).toBe(200);
    expect(oauthMcpState.toolCalls).toHaveLength(1);
    expect(oauthMcpState.toolCalls[0]?.name).toBe('refund_order');

    const approvedView = approveRes.body!.approval as {
      status: string;
      continuation?: { status: string; assistantMessageMasked: string | null };
    };
    expect(approvedView.status).toBe('succeeded');
    expect(approvedView.continuation?.status).toBe('completed');
    expect(approvedView.continuation?.assistantMessageMasked).toContain('Completed action for ORD-035');
    expect(approvedView.continuation?.assistantMessageMasked).not.toContain('ops-secret@example.com');
    expect(approvedView.continuation?.assistantMessageMasked).not.toContain(FAKE_UPSTREAM_SECRET);

    // 3. Poll GET /api/ai-platform/mcp/approvals/:id/continuation directly
    const contRes = await apiCall(`/api/ai-platform/mcp/approvals/${approvalId}/continuation`);
    expect(contRes.status).toBe(200);
    const cont = contRes.body!.continuation as {
      status: string;
      assistantMessageMasked: string;
      totalTokens: number;
    };
    expect(cont.status).toBe('completed');
    expect(cont.assistantMessageMasked).toContain('Completed action for ORD-035');
    expect(cont.assistantMessageMasked).not.toContain('ops-secret@example.com');
    expect(cont.assistantMessageMasked).not.toContain(FAKE_UPSTREAM_SECRET);
    expect(cont.totalTokens).toBeGreaterThan(0);

    // 4. Rejection path marks continuation as 'rejected' without executing write tool
    const chatRes2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profileKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'spec035-model',
        messages: [{ role: 'user', content: 'Refund second order ORD-036' }],
      }),
    });
    expect(chatRes2.status).toBe(200);
    const pending2 = await apiCall('/api/ai-platform/approvals?status=pending');
    const approvalId2 = (pending2.body!.approvals as Array<{ id: number }>)[0]!.id;

    const rejectRes = await apiCall(`/api/ai-platform/approvals/${approvalId2}/reject`, {
      method: 'POST',
      body: { note: 'Denied' },
    });
    expect(rejectRes.status).toBe(200);
    expect(oauthMcpState.toolCalls).toHaveLength(1); // still 1 — not executed!

    const rejectedCont = await apiCall(`/api/ai-platform/mcp/approvals/${approvalId2}/continuation`);
    expect((rejectedCont.body!.continuation as { status: string }).status).toBe('rejected');

    // 5. purgeScope cleans up custom_ai_request_traces and custom_ai_chat_continuations for profileId
    const purgedCount = purgeScope('profile', String(profileId));
    expect(purgedCount).toBeGreaterThanOrEqual(2);
    const afterPurgeCont = await apiCall(`/api/ai-platform/mcp/approvals/${approvalId}/continuation`);
    expect(afterPurgeCont.body!.continuation).toBeNull();
  });
});
