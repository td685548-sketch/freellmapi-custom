import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { decrypt } from '../../lib/crypto.js';
import { getXGatewayProvider, resolveXGatewayProvider } from '../../custom/provider-accounts/catalog.js';
import {
  OpenCodeProvider,
  MIMO_SYSTEM_MARKER,
  OPENCODE_SESSION_RE,
  _resetOpenCodeStateForTests,
} from '../../custom/provider-accounts/opencode.js';
import { VertexProvider, _resetVertexCachesForTests } from '../../custom/provider-accounts/vertex.js';
import {
  BedrockProvider,
  encodeEventFrame,
  parseBedrockCredentials,
  signAwsRequest,
} from '../../custom/provider-accounts/bedrock.js';
import { CommandCodeProvider } from '../../custom/provider-accounts/commandcode.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

function makeSseResponse(lines: string[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const line of lines) controller.enqueue(enc.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function makeBinaryResponse(chunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'application/vnd.amazon.eventstream' },
  });
}

describe('Wave 1 catalog & cloud / zero-auth executors', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const owner = createUser(`wave1-admin-${Date.now()}@example.test`, 'TestPass#1234');
    adminToken = createSession(owner.userId);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetOpenCodeStateForTests();
    _resetVertexCachesForTests();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('includes synthetic, sensenova-intl, and updated xiaomi-tokenplan models in catalog', () => {
    const syn = getXGatewayProvider('synthetic');
    expect(syn).toBeDefined();
    expect(syn?.alias).toBe('syn');
    expect(syn?.models.some((m) => m.id === 'hf:zai-org/GLM-5.3')).toBe(true);

    const snIntl = getXGatewayProvider('sensenova-intl');
    expect(snIntl).toBeDefined();
    expect(snIntl?.baseUrl).toBe('https://token.sensenova.ai/v1');
    expect(snIntl?.models.some((m) => m.id === 'sensenova-6.8-flash')).toBe(true);

    const xmtp = getXGatewayProvider('xiaomi-tokenplan');
    expect(xmtp?.models.map((m) => m.id)).toEqual([
      'mimo-v2.6-pro',
      'mimo-v2.6-flash',
      'mimo-v2.5-asr',
      'mimo-v2.5-tts',
      'mimo-v2.5-tts-voiceclone',
      'mimo-v2.5-tts-voicedesign',
    ]);
  });

  it('validates Synthetic API keys against /v2/quotas', async () => {
    const seenUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url === 'https://api.synthetic.new/v2/quotas') {
        return new Response(JSON.stringify({ subscription: { limit: 100 } }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const syn = resolveXGatewayProvider('synthetic');
    expect(syn).toBeDefined();
    const ok = await syn!.validateKey('syn_live_test_key');
    expect(ok).toBe(true);
    expect(seenUrls).toEqual(['https://api.synthetic.new/v2/quotas']);
  });

  it('routes OpenCode Free with fingerprint cloaking, alias restoration, /responses & /messages, and overload retry', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let attempt = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, headers, body });

      if (url.endsWith('/inference/v1/chat/completions')) {
        attempt++;
        if (attempt === 1) {
          return new Response('{"error":"The inference service is overloaded. Please try again later."}', { status: 429 });
        }
        return makeSseResponse([
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"jev-1.13-free","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"run_command","arguments":"{}"}}]},"finish_reason":null}]}',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"jev-1.13-free","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ]);
      }

      if (url.endsWith('/inference/v1/responses')) {
        return makeSseResponse([
          'data: {"type":"response.output_text.delta","delta":"Spark"}',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":2}}}',
        ]);
      }

      if (url.endsWith('/inference/v1/messages')) {
        return makeSseResponse([
          'event: content_block_delta',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Union"}}',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
        ]);
      }

      return new Response('{}', { status: 404 });
    });

    const oc = resolveXGatewayProvider('opencode') as OpenCodeProvider;
    expect(oc).toBeInstanceOf(OpenCodeProvider);
    expect(oc.keyless).toBe(true);

    // Avoid real timers delaying 800ms during retry test by spying setTimeout? Keep real 800ms once is fine or spy!
    const chatRes = await oc.chatCompletion(
      'no-auth',
      [{ role: 'user', content: 'run ls' }],
      'jev-1.13-free',
      {
        tools: [
          { type: 'function', function: { name: 'terminal_exec', description: 'run terminal', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
        ],
      },
    );

    expect(attempt).toBe(2);
    expect(calls[1].headers.authorization).toBe('Bearer public');
    expect(calls[1].headers['x-opencode-session']).toMatch(OPENCODE_SESSION_RE);
    expect(JSON.stringify(calls[1].body.messages)).toContain('<env>');
    const sentNames = calls[1].body.tools.map((t: any) => t.function?.name ?? t.name);
    expect(sentNames).toContain('run_command');
    expect(sentNames).toContain('read');
    expect(sentNames).toContain('shell');
    expect(chatRes.choices[0].message.tool_calls?.[0].function.name).toBe('terminal_exec');

    const respRes = await oc.chatCompletion('no-auth', [{ role: 'user', content: 'hi' }], 'muse-spark-1.2-contributor-free');
    expect(respRes.choices[0].message.content).toBe('Spark');
    expect(calls[2].url).toBe('https://opencode.ai/inference/v1/responses');

    const msgRes = await oc.chatCompletion('no-auth', [{ role: 'user', content: 'hi' }], 'union-alpha');
    expect(msgRes.choices[0].message.content).toBe('Union');
    expect(calls[3].url).toBe('https://opencode.ai/inference/v1/messages');
  });

  it('handles MiMo Free bootstrap JWT cache, system marker, and 401 re-bootstrap retry', async () => {
    let bootstrapCount = 0;
    let chatAttempt = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/bootstrap')) {
        bootstrapCount++;
        return new Response(JSON.stringify({ jwt: `jwt-${bootstrapCount}` }), { status: 200 });
      }
      if (url.endsWith('/openai/chat')) {
        chatAttempt++;
        const headers = new Headers(init?.headers);
        const body = JSON.parse(String(init?.body));
        expect(headers.get('X-Mimo-Source')).toBe('mimocode-cli-free');
        expect(body.messages[0].content).toContain(MIMO_SYSTEM_MARKER);
        if (chatAttempt === 1) return new Response('Unauthorized', { status: 401 });
        expect(headers.get('Authorization')).toBe('Bearer jwt-2');
        return new Response(JSON.stringify({
          id: 'chatcmpl-mimo',
          object: 'chat.completion',
          created: 1,
          model: 'mimo-auto',
          choices: [{ index: 0, message: { role: 'assistant', content: 'MiMo OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const mimo = resolveXGatewayProvider('mimo-free') as OpenCodeProvider;
    const out = await mimo.chatCompletion('no-auth', [{ role: 'user', content: 'hi' }], 'mimo-auto');
    expect(out.choices[0].message.content).toBe('MiMo OK');
    expect(bootstrapCount).toBe(2);
    expect(chatAttempt).toBe(2);
  });

  it('handles Vertex AI SA JSON RS256 token minting, Gemini, Claude rawPredict, and Partner MaaS', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    const saCredential = JSON.stringify({
      type: 'service_account',
      project_id: 'demo-proj-1',
      private_key: privateKey,
      client_email: 'runner@demo-proj-1.iam.gserviceaccount.com',
    });

    let tokenCalls = 0;
    const visited: Array<{ url: string; auth: string | null; body: any }> = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls++;
        expect(String(init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
        return new Response(JSON.stringify({ access_token: 'vx-access-1', expires_in: 3600 }), { status: 200 });
      }
      const headers = new Headers(init?.headers);
      visited.push({ url, auth: headers.get('Authorization'), body: JSON.parse(String(init?.body || '{}')) });

      if (url.includes(':generateContent')) {
        return new Response(JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'Vertex Gemini' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
        }), { status: 200 });
      }
      if (url.includes(':rawPredict')) {
        return new Response(JSON.stringify({
          id: 'msg_1',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Vertex Claude' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 2 },
        }), { status: 200 });
      }
      if (url.includes('/endpoints/openapi/chat/completions')) {
        return new Response(JSON.stringify({
          id: 'maas-1',
          object: 'chat.completion',
          created: 1,
          model: 'zai-org/glm-5-maas',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Vertex Partner' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const vertex = resolveXGatewayProvider('vertex') as VertexProvider;
    const gem = await vertex.chatCompletion(saCredential, [{ role: 'user', content: 'hi' }], 'gemini-4-argon');
    expect(gem.choices[0].message.content).toBe('Vertex Gemini');

    const claude = await vertex.chatCompletion(saCredential, [{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6');
    expect(claude.choices[0].message.content).toBe('Vertex Claude');

    const partner = resolveXGatewayProvider('vertex-partner') as VertexProvider;
    const maas = await partner.chatCompletion(saCredential, [{ role: 'user', content: 'hi' }], 'zai-org/glm-5-maas');
    expect(maas.choices[0].message.content).toBe('Vertex Partner');

    expect(tokenCalls).toBe(1); // SA token cached across vertex & vertex-partner calls
    expect(visited[0].url).toContain('/projects/demo-proj-1/locations/global/publishers/google/models/gemini-4-argon:generateContent');
    expect(visited[1].url).toContain('/projects/demo-proj-1/locations/us-central1/publishers/anthropic/models/claude-sonnet-4-6:rawPredict');
    expect(visited[1].body.anthropic_version).toBe('vertex-2023-10-16');
    expect(visited[2].url).toContain('/projects/demo-proj-1/locations/global/endpoints/openapi/chat/completions');
  });

  it('signs Bedrock SigV4 requests, unwraps EventStream binary frames, and validates via control plane', async () => {
    const parsedCreds = parseBedrockCredentials('ASIA123456:secretABC:us-west-2:tokXYZ');
    expect(parsedCreds).toEqual({
      accessKeyId: 'ASIA123456',
      secretAccessKey: 'secretABC',
      region: 'us-west-2',
      sessionToken: 'tokXYZ',
    });

    const signed = signAwsRequest({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-20250514-v1%3A0/invoke',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
      region: 'us-east-1',
      service: 'bedrock',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'SECRETEXAMPLE' },
      date: new Date('2026-11-18T00:00:00Z'),
    });
    expect(signed.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261118\/us-east-1\/bedrock\/aws4_request/);

    const chunk1 = encodeEventFrame(
      { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
      { bytes: Buffer.from(JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Bedrock ' } })).toString('base64') },
    );
    const chunk2 = encodeEventFrame(
      { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
      { bytes: Buffer.from(JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } })).toString('base64') },
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.includes('/foundation-models')) {
        expect(headers.get('Authorization')).toContain('AWS4-HMAC-SHA256');
        return new Response(JSON.stringify({ modelSummaries: [] }), { status: 200 });
      }
      if (url.includes('/invoke-with-response-stream')) {
        expect(headers.get('x-amz-security-token')).toBe('tokXYZ');
        const body = JSON.parse(String(init?.body));
        expect(body.anthropic_version).toBe('bedrock-2023-05-31');
        expect(body.model).toBeUndefined();
        return makeBinaryResponse([chunk1, chunk2]);
      }
      return new Response('{}', { status: 404 });
    });

    const bedrock = resolveXGatewayProvider('bedrock') as BedrockProvider;
    const chunks: string[] = [];
    for await (const c of bedrock.streamChatCompletion(
      'ASIA123456:secretABC:us-west-2:tokXYZ',
      [{ role: 'user', content: 'hi' }],
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
    )) {
      if (c.choices[0]?.delta?.content) chunks.push(c.choices[0].delta.content);
    }
    expect(chunks.join('')).toBe('Bedrock ');
    expect(await bedrock.validateKey('AKIAEXAMPLE:SECRETEXAMPLE:us-east-1')).toBe(true);
  });

  it('translates CommandCode NDJSON streams, retries initial 503 error frames, and validates keys', async () => {
    let postCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === 'https://api.commandcode.ai/provider/v1/models?view=client') {
        expect(headers.get('x-command-code-version')).toBe('1.88.5');
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url === 'https://api.commandcode.ai/alpha/generate') {
        postCount++;
        const payload = JSON.parse(String(init?.body));
        expect(payload.params.stream).toBe(true);
        expect(headers.get('x-project-slug')).toBeTruthy();
        if (postCount === 1) {
          return makeSseResponse([
            JSON.stringify({ type: 'error', error: { statusCode: 503, message: 'temporarily busy' } }),
          ]);
        }
        return makeSseResponse([
          JSON.stringify({ type: 'reasoning-delta', text: 'Plan: ' }),
          JSON.stringify({ type: 'text-delta', text: 'Done!' }),
          JSON.stringify({ type: 'finish-step', finishReason: 'stop', usage: { inputTokens: 8, outputTokens: 3 } }),
          JSON.stringify({ type: 'finish' }),
        ]);
      }
      return new Response('{}', { status: 404 });
    });

    const cc = resolveXGatewayProvider('commandcode') as CommandCodeProvider;
    const out = await cc.chatCompletion('user_cc_key', [{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-pro');
    expect(postCount).toBe(2);
    expect(out.choices[0].message.content).toBe('Done!');
    expect((out.choices[0].message as any).reasoning_content).toBe('Plan: ');
    expect(out.usage?.total_tokens).toBe(11);
    expect(await cc.validateKey('user_cc_key')).toBe(true);
  });

  it('supports POST /api/thruline-accounts/connect-free for keyless free providers and rejects non-free providers', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) return REAL_FETCH(input, init);
      if (url === 'https://opencode.ai/zen/v1/models') {
        return new Response(JSON.stringify({
          data: [{ id: 'muse-spark-1.2-contributor-free' }, { id: 'live-free-extra' }],
        }), { status: 200 });
      }
      return REAL_FETCH(input, init);
    });

    const createRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/connect-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: 'opencode', label: 'My Free OpenCode' }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: number; provider: string; modelsCount: number };
    expect(created.provider).toBe('opencode');
    expect(created.modelsCount).toBeGreaterThanOrEqual(5);

    const row = getDb().prepare('SELECT * FROM x_gateway_keys WHERE id = ?').get(created.id) as {
      provider: string;
      encrypted_key: string;
      iv: string;
      auth_tag: string;
    };
    expect(row.provider).toBe('opencode');
    expect(decrypt(row.encrypted_key, row.iv, row.auth_tag)).toBe('no-auth');

    const badRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/connect-free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ provider: 'groq' }),
    });
    expect(badRes.status).toBe(400);
  });
});
