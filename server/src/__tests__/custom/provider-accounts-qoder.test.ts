import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QoderProvider,
  qoderEncodeBody,
  buildCosyHeaders,
  deriveMachineId,
} from '../../custom/provider-accounts/qoder.js';
import { resolveXGatewayProvider } from '../../custom/provider-accounts/catalog.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const sseStream = (lines: string[]) => {
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(new TextEncoder().encode(line + '\n'));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
};

describe('Qoder COSY and WAF utilities', () => {
  it('correctly encodes plaintext using WAF bypass', () => {
    const raw = JSON.stringify({ test: 'hello world' });
    const encoded = qoderEncodeBody(raw);
    expect(encoded).toBeTruthy();
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toBe(raw);
  });

  it('builds valid COSY headers with required properties', () => {
    const headers = buildCosyHeaders(Buffer.from('test-body'), 'https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation', {
      userId: 'test-user-123',
      authToken: 'jt-mock-token',
    });

    expect(headers['Authorization']).toMatch(/^Bearer COSY\./);
    expect(headers['Cosy-Key']).toBeTruthy();
    expect(headers['Cosy-User']).toBe('test-user-123');
    expect(headers['Cosy-Machineid']).toBeTruthy();
    expect(headers['Cosy-Version']).toBe('1.0.0');
    expect(headers['Login-Version']).toBe('v2');
  });

  it('derives a deterministic machineId from userId', () => {
    const id1 = deriveMachineId('user-abc');
    const id2 = deriveMachineId('user-abc');
    const id3 = deriveMachineId('user-xyz');
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });
});

describe('QoderProvider integration', () => {
  let requests: { url: string; init?: RequestInit }[] = [];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  beforeEach(() => {
    requests = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });

      if (url.includes('/api/v1/jobToken/exchange')) {
        const body = JSON.parse(String(init?.body || '{}'));
        if (body.personal_token === 'pt-invalid') {
          return json({ error: 'invalid token' }, 401);
        }
        return json({ token: 'jt-valid-token-123', expires_in: 86400 });
      }

      if (url.includes('/api/v1/userinfo')) {
        const auth = String(new Headers(init?.headers).get('Authorization') || '');
        if (auth.includes('invalid')) {
          return json({ error: 'unauthorized' }, 401);
        }
        return json({ id: 'u-12345', name: 'Test Qoder User' });
      }

      if (url.includes('/agent_chat_generation')) {
        const lines = [
          'data: {"statusCodeValue":200,"body":"{\\"id\\":\\"q-1\\",\\"choices\\":[{\\"delta\\":{\\"content\\":\\"Xin chào!\\"}}]}"}',
          'data: {"statusCodeValue":200,"body":"{\\"choices\\":[{\\"delta\\":{\\"content\\":\\" Tôi là Qoder.\\"},\\"finish_reason\\":\\"stop\\"}],\\"usage\\":{\\"prompt_tokens\\":10,\\"completion_tokens\\":8}}"}',
          'data: [DONE]',
        ];
        return sseStream(lines);
      }

      if (url.includes('/algo/api/v2/image/upload')) {
        return json({ result: { imageUrl: 'https://oss.qoder.example/uploaded-1.png' } });
      }

      if (url.includes('/algo/api/v2/model/list')) {
        return json({
          chat: [
            {
              key: 'qfmodel',
              display_name: 'Qwen3.8-Flash',
              is_vl: true,
              is_reasoning: true,
            },
          ],
        });
      }

      throw new Error(`Unmocked URL: ${url}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is resolved by resolveXGatewayProvider for qoder and qoder-cn', () => {
    const intl = resolveXGatewayProvider('qoder');
    expect(intl).toBeInstanceOf(QoderProvider);
    expect((intl as QoderProvider).region).toBe('intl');

    const cn = resolveXGatewayProvider('qoder-cn');
    expect(cn).toBeInstanceOf(QoderProvider);
    expect((cn as QoderProvider).region).toBe('cn');
  });

  it('validates a valid PAT by exchanging to job token and calling userinfo', async () => {
    const provider = new QoderProvider('qoder');
    const result = await provider.validateKey('pt-valid-credential');
    expect(result).toBe(true);
    expect(requests.some(r => r.url.includes('/api/v1/jobToken/exchange'))).toBe(true);
    expect(requests.some(r => r.url.includes('/api/v1/userinfo'))).toBe(true);
  });

  it('rejects an invalid PAT when exchange fails', async () => {
    const provider = new QoderProvider('qoder');
    const result = await provider.validateKey('pt-invalid');
    expect(result).toEqual({ valid: false, error: expect.stringContaining('PAT exchange failed') });
  });

  it('successfully streams chat completions with COSY headers and unwraps SSE chunks', async () => {
    const provider = new QoderProvider('qoder');
    const chunks: string[] = [];

    for await (const chunk of provider.streamChatCompletion(
      'pt-valid-credential',
      [{ role: 'user', content: 'xin chào' }],
      'qd/qfmodel',
    )) {
      if (chunk.choices?.[0]?.delta?.content) {
        chunks.push(chunk.choices[0].delta.content);
      }
    }

    expect(chunks.join('')).toBe('Xin chào! Tôi là Qoder.');
    const chatReq = requests.find(r => r.url.includes('/agent_chat_generation'));
    expect(chatReq).toBeDefined();
    // Headers must include COSY authorization
    const authHeader = String(new Headers(chatReq!.init?.headers).get('Authorization') || '');
    expect(authHeader).toMatch(/^Bearer COSY\./);
  });

  it('successfully returns non-streaming chatCompletion response', async () => {
    const provider = new QoderProvider('qoder');
    const res = await provider.chatCompletion(
      'pt-valid-credential',
      [{ role: 'user', content: 'xin chào' }],
      'qfmodel',
    );

    expect(res.choices[0].message.content).toBe('Xin chào! Tôi là Qoder.');
    expect(res.choices[0].finish_reason).toBe('stop');
    expect(res.usage?.completion_tokens).toBe(8);
  });

  it('uploads inline base64 images via /algo/api/v2/image/upload before chat generation', async () => {
    const provider = new QoderProvider('qoder');
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await provider.chatCompletion(
      'pt-valid-credential',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Mô tả ảnh này' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
        ],
      }],
      'qfmodel',
    );

    expect(res.choices[0].message.content).toBe('Xin chào! Tôi là Qoder.');
    const uploadReq = requests.find(r => r.url.includes('/algo/api/v2/image/upload'));
    expect(uploadReq).toBeDefined();
    expect(uploadReq!.init?.method).toBe('PUT');
    const authHeader = String(new Headers(uploadReq!.init?.headers).get('Authorization') || '');
    expect(authHeader).toMatch(/^Bearer COSY\./);
  });
});
