// Web-cookie provider: credential normalization, per-provider payloads,
// response-shape extraction, and the generic (non-delegated) chat path.
//
// `proxyFetch` is mocked at the module boundary (no network, no DNS pinning),
// following server/src/__tests__/custom/chatgpt-web-sentinel.test.ts. The
// chatgpt-web / gemini-web / deepseek-web / uc-web delegates have their own
// coverage; this file covers the shared helpers plus the generic path
// (grok-web, perplexity-web, ...) that posts straight to the web origin.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

import {
  buildWebProviderPayload,
  buildWebSessionHeaders,
  extractWebResponseText,
  WebCookieProvider,
} from '../../custom/provider-accounts/web-cookie.js';

function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

describe('buildWebSessionHeaders', () => {
  it('maps a bare grok-web token to the sso cookie', () => {
    const headers = buildWebSessionHeaders('grok-web', 'abc123');
    expect(headers['Cookie']).toBe('sso=abc123');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Origin']).toBe('https://grok.com');
  });

  it('passes a full Cookie header through untouched', () => {
    const headers = buildWebSessionHeaders('grok-web', 'sso=abc; sso-rw=def');
    expect(headers['Cookie']).toBe('sso=abc; sso-rw=def');
  });

  it('strips a leading "Cookie:" prefix before normalizing', () => {
    const headers = buildWebSessionHeaders('grok-web', 'Cookie: sso=abc');
    expect(headers['Cookie']).toBe('sso=abc');
  });

  it('sends a Bearer token as Authorization, never as a cookie', () => {
    const headers = buildWebSessionHeaders('grok-web', 'Bearer eyJhbGciOiJIUzI1NiJ9');
    expect(headers['Authorization']).toBe('Bearer eyJhbGciOiJIUzI1NiJ9');
    expect(headers['Cookie']).toBeUndefined();
  });

  it('sends a Meta Llama key (LLM|app|secret) as Authorization', () => {
    const headers = buildWebSessionHeaders('grok-web', 'LLM|12345|secret-value');
    expect(headers['Authorization']).toBe('Bearer LLM|12345|secret-value');
    expect(headers['Cookie']).toBeUndefined();
  });

  it('deepseek-web sends both Bearer auth and the userToken cookie', () => {
    const headers = buildWebSessionHeaders('deepseek-web', 'tok-xyz');
    expect(headers['Authorization']).toBe('Bearer tok-xyz');
    expect(headers['Cookie']).toBe('userToken=tok-xyz');
  });

  it('chatgpt-web normalizes a bare value to the session-token cookie', () => {
    const headers = buildWebSessionHeaders('chatgpt-web', 'eyJ0b2tlbiI6MX0');
    expect(headers['Cookie']).toBe('__Secure-next-auth.session-token=eyJ0b2tlbiI6MX0');
  });

  it('an unknown provider falls back to the generic session cookie', () => {
    const headers = buildWebSessionHeaders('some-new-web', 'tok-xyz');
    expect(headers['Cookie']).toBe('session=tok-xyz');
  });

  it('a base64-padded blob is a token, not a name=value cookie pair', () => {
    const headers = buildWebSessionHeaders('grok-web', 'QUJDRA==');
    expect(headers['Cookie']).toBe('sso=QUJDRA==');
  });
});

describe('buildWebProviderPayload', () => {
  const messages = [{ role: 'user', content: 'Hello' }] as const;

  it('grok-web defaults to grok-3 and flags reasoning models', () => {
    const plain = buildWebProviderPayload('grok-web', [...messages], '', false);
    expect(plain.body['modelName']).toBe('grok-3');
    expect(plain.body['isReasoning']).toBe(false);
    const reasoning = buildWebProviderPayload('grok-web', [...messages], 'grok-3-reasoning', false);
    expect(reasoning.body['isReasoning']).toBe(true);
    expect(plain.body['message']).toBe('Hello');
  });

  it('perplexity-web sends query_str with the model preference', () => {
    const { body } = buildWebProviderPayload('perplexity-web', [...messages], 'sonar', false);
    expect(body['query_str']).toBe('Hello');
    expect((body['params'] as Record<string, unknown>)['model_preference']).toBe('sonar');
  });

  it('deepseek-web enables thinking for reasoner models and search for search models', () => {
    const reasoner = buildWebProviderPayload('deepseek-web', [...messages], 'deepseek-reasoner', false);
    expect(reasoner.body['thinking_enabled']).toBe(true);
    expect(reasoner.body['search_enabled']).toBe(false);
    const search = buildWebProviderPayload('deepseek-web', [...messages], 'deepseek-search', false);
    expect(search.body['thinking_enabled']).toBe(false);
    expect(search.body['search_enabled']).toBe(true);
  });

  it('chatgpt-web targets /backend-api/conversation with action next', () => {
    const { pathSuffix, body } = buildWebProviderPayload('chatgpt-web', [...messages], 'gpt-4o', false);
    expect(pathSuffix).toBe('/backend-api/conversation');
    expect(body['action']).toBe('next');
    expect(body['model']).toBe('gpt-4o');
  });

  it('unknown providers get an OpenAI-compatible passthrough with sampling options', () => {
    const { pathSuffix, body } = buildWebProviderPayload(
      'other-web',
      [...messages],
      'some-model',
      true,
      { temperature: 0.5, max_tokens: 100, top_p: 0.9 },
    );
    expect(pathSuffix).toBe('/v1/chat/completions');
    expect(body['model']).toBe('some-model');
    expect(body['stream']).toBe(true);
    expect(body['temperature']).toBe(0.5);
    expect(body['max_tokens']).toBe(100);
    expect(body['top_p']).toBe(0.9);
  });

  it('multi-turn messages are joined into one prompt with role markers', () => {
    const { body } = buildWebProviderPayload('grok-web', [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Bye' },
    ], '', false);
    expect(body['message']).toBe('[System]\nBe brief.\n\nHi\n\n[Assistant]\nHello\n\nBye');
  });
});

describe('extractWebResponseText', () => {
  it('passes a plain string through', () => {
    expect(extractWebResponseText('hello')).toBe('hello');
  });

  it('reads OpenAI delta, message, then text shapes in that order', () => {
    expect(extractWebResponseText({ choices: [{ delta: { content: 'delta-text' } }] })).toBe('delta-text');
    expect(extractWebResponseText({ choices: [{ message: { content: 'msg-text' } }] })).toBe('msg-text');
    expect(extractWebResponseText({ choices: [{ text: 'choice-text' }] })).toBe('choice-text');
  });

  it('reads Grok Web token and full-message shapes', () => {
    expect(extractWebResponseText({ result: { response: { token: 'tok' } } })).toBe('tok');
    expect(extractWebResponseText({ result: { response: { modelResponse: { message: 'full' } } } })).toBe('full');
  });

  it('joins ChatGPT Web message parts', () => {
    expect(extractWebResponseText({ message: { content: { parts: ['Hel', 'lo'] } } })).toBe('Hello');
  });

  it('reads Perplexity answer and DeepSeek v shapes', () => {
    expect(extractWebResponseText({ answer: 'perplexity' })).toBe('perplexity');
    expect(extractWebResponseText({ v: 'deepseek' })).toBe('deepseek');
  });

  it('returns empty for null, non-objects, and unknown shapes', () => {
    expect(extractWebResponseText(null)).toBe('');
    expect(extractWebResponseText(42)).toBe('');
    expect(extractWebResponseText({ unknown: 'shape' })).toBe('');
  });
});

describe('WebCookieProvider.chatCompletion (generic web path)', () => {
  const provider = () =>
    new WebCookieProvider({ providerId: 'grok-web', name: 'Grok Web', baseUrl: 'https://grok.com' });
  const messages = [{ role: 'user', content: 'Hi' }] as const;

  beforeEach(() => {
    mockProxyFetch.mockReset();
  });

  it('extracts text from a Grok-shaped JSON response', async () => {
    mockProxyFetch.mockResolvedValueOnce(
      jsonResponse(200, { result: { response: { modelResponse: { message: 'Grok says hi' } } } }),
    );

    const res = await provider().chatCompletion('sso=abc', [...messages], 'grok-3');

    expect(res.choices[0].message.content).toBe('Grok says hi');
    expect(res.model).toBe('grok-3');
    const [url, init] = mockProxyFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://grok.com');
    expect((init['headers'] as Record<string, string>)['Cookie']).toBe('sso=abc');
    expect(JSON.parse(String(init['body']))['modelName']).toBe('grok-3');
  });

  it('returns a standard OpenAI response untouched when the upstream already speaks it', async () => {
    mockProxyFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'grok-3',
        choices: [{ index: 0, message: { role: 'assistant', content: 'passthrough' }, finish_reason: 'stop' }],
      }),
    );

    const res = await provider().chatCompletion('sso=abc', [...messages], 'grok-3');

    expect(res.id).toBe('chatcmpl-1');
    expect(res.choices[0].message.content).toBe('passthrough');
  });

  it('combines SSE/NDJSON lines on a non-streaming endpoint', async () => {
    mockProxyFetch.mockResolvedValueOnce(
      jsonResponse(200, 'data: {"result":{"response":{"token":"Hel"}}}\n\ndata: {"result":{"response":{"token":"lo"}}}\n\ndata: [DONE]\n\n', 'text/event-stream'),
    );

    const res = await provider().chatCompletion('sso=abc', [...messages], 'grok-3');

    expect(res.choices[0].message.content).toBe('Hello');
  });

  it('throws a 401 provider error (not a generic failure) on auth rejection', async () => {
    mockProxyFetch.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));

    let caught: unknown;
    try {
      await provider().chatCompletion('sso=stale', [...messages], 'grok-3');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: unknown }).status).toBe(401);
    expect((caught as Error).message).toContain('401');
  });

  it('throws a 403 HTML-challenge error when the origin returns a challenge page', async () => {
    mockProxyFetch.mockResolvedValueOnce(
      jsonResponse(200, '<!doctype html><html><body>challenge</body></html>', 'text/html'),
    );

    let caught: unknown;
    try {
      await provider().chatCompletion('sso=abc', [...messages], 'grok-3');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: unknown }).status).toBe(403);
    expect((caught as Error).message).toContain('HTML challenge');
  });
});

describe('WebCookieProvider.validateKey', () => {
  beforeEach(() => {
    mockProxyFetch.mockReset();
  });

  it('rejects an empty credential without any fetch', async () => {
    const result = await new WebCookieProvider({ providerId: 'grok-web', name: 'Grok Web', baseUrl: 'https://grok.com' }).validateKey('  ');
    expect(result).toEqual({ valid: false, error: 'Empty web session cookie or token' });
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it('accepts a grok-web key without probing (no session endpoint exists)', async () => {
    const result = await new WebCookieProvider({ providerId: 'grok-web', name: 'Grok Web', baseUrl: 'https://grok.com' }).validateKey('sso=abc');
    expect(result).toBe(true);
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });
});
