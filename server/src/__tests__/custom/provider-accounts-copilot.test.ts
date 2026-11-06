import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotProvider, resolveCopilotToken, clearCopilotToken } from '../../custom/provider-accounts/copilot.js';
import { COPILOT_BASE_URL, COPILOT_PREFIX, COPILOT_TOKEN_URL } from '../../custom/provider-accounts/http.js';
import { resolveProvider } from '../../providers/index.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { initDb } from '../../db/index.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let now = Math.floor(Date.now() / 1000) * 1000;
let credential: string;
let exchanges: number;
let chatCalls: number;
let chatStatus: number;
let returnedExpiry: number;
let requests: { url: string; init?: RequestInit }[];

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});
beforeEach(() => {
  now += 10 * 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  credential = `${COPILOT_PREFIX}test-${now}`;
  exchanges = 0;
  chatCalls = 0;
  chatStatus = 200;
  returnedExpiry = now / 1000 + 3600;
  requests = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === COPILOT_TOKEN_URL) {
      exchanges++;
      return json({ token: `short-lived-${exchanges}`, expires_at: returnedExpiry, endpoints: { api: 'https://do-not-follow.invalid' } });
    }
    if (url === `${COPILOT_BASE_URL}/chat/completions`) {
      chatCalls++;
      if (chatStatus !== 200) return json({ error: { message: `SECRET ${credential}` } }, chatStatus);
      return json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    }
    if (url === `${COPILOT_BASE_URL}/models`) return json({ data: [{ id: 'chat-model', capabilities: { type: 'chat' }, supported_endpoints: ['/chat/completions'] }] });
    throw new Error('Unmocked outbound HTTP');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Copilot credential adapter', () => {
  it('caches per credential hash with single flight across independent provider instances', async () => {
    const resolved = await Promise.all(Array.from({ length: 8 }, () => resolveCopilotToken(credential)));
    expect(resolved).toEqual(Array(8).fill('short-lived-1'));
    expect(exchanges).toBe(1);
    const provider = new CopilotProvider();
    await provider.chatCompletion(credential, [{ role: 'user', content: 'hi' }], 'chat-model');
    await new CopilotProvider().chatCompletion(credential, [{ role: 'user', content: 'hi' }], 'chat-model');
    expect(exchanges).toBe(1);
    expect(requests.filter(r => r.url.endsWith('/chat/completions')).every(r => new Headers(r.init!.headers).get('Authorization') === 'Bearer short-lived-1')).toBe(true);
    expect(new Headers(requests[0].init!.headers).get('Authorization')).toBe(`token ${credential.slice(COPILOT_PREFIX.length)}`);
    expect(await resolveCopilotToken(`${credential}-second`)).toBe('short-lived-2');
    expect(requests.every(r => !r.url.includes('do-not-follow'))).toBe(true);
  });

  it('refreshes at the earlier of expiry skew and bounded cache TTL', async () => {
    returnedExpiry = now / 1000 + 60;
    expect(await resolveCopilotToken(credential)).toBe('short-lived-1');
    now += 29_000;
    expect(await resolveCopilotToken(credential)).toBe('short-lived-1');
    now += 1000;
    returnedExpiry = now / 1000 + 3600;
    expect(await resolveCopilotToken(credential)).toBe('short-lived-2');
    now += 5 * 60_000;
    expect(await resolveCopilotToken(credential)).toBe('short-lived-3');
    expect(exchanges).toBe(3);
  });

  it('drops a rejected token on 401, sanitizes errors, and never replays a stream', async () => {
    const provider = new CopilotProvider();
    chatStatus = 401;
    let error: unknown;
    try {
      for await (const _chunk of provider.streamChatCompletion(credential, [{ role: 'user', content: 'hi' }], 'chat-model')) { /* no successful chunks */ }
    } catch (err) { error = err; }
    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain('SECRET');
    expect(String(error)).not.toContain(credential);
    expect(chatCalls).toBe(1);
    expect(exchanges).toBe(1);
    chatStatus = 200;
    await provider.chatCompletion(credential, [{ role: 'user', content: 'hi' }], 'chat-model');
    expect(exchanges).toBe(2);
    expect(chatCalls).toBe(2);
  });

  it('rejects expired or malformed token payloads without caching a failure', async () => {
    returnedExpiry = now / 1000 - 1;
    await expect(resolveCopilotToken(credential)).rejects.toThrow('Copilot credential exchange failed.');
    returnedExpiry = now / 1000 + 3600;
    expect(await resolveCopilotToken(credential)).toBe('short-lived-2');
    clearCopilotToken(credential);
    expect(await resolveCopilotToken(credential)).toBe('short-lived-3');
  });

  it('preserves raw custom keys at the same URL and hooks only the exact base URL', async () => {
    const provider = resolveProvider('custom', COPILOT_BASE_URL)!;
    expect(provider).toBeInstanceOf(CopilotProvider);
    for (const url of [`${COPILOT_BASE_URL}/v1`, `${COPILOT_BASE_URL}/`, 'https://api.githubcopilot.com.evil.test']) {
      const other = resolveProvider('custom', url);
      expect(other).toBeInstanceOf(OpenAICompatProvider);
      expect(other).not.toBeInstanceOf(CopilotProvider);
    }
    expect(await resolveCopilotToken('raw-custom-key')).toBe('raw-custom-key');
    await provider.chatCompletion('raw-custom-key', [{ role: 'user', content: 'hi' }], 'chat-model');
    expect(await provider.validateKey('raw-custom-key')).toBe(true);
    expect(exchanges).toBe(0);
    expect(new Headers(requests[0].init!.headers).get('Authorization')).toBe('Bearer raw-custom-key');
    expect(requests[0].init!.redirect).not.toBe('error');
  });

  it('health validation exchanges credentials and rejects JSON-less or empty catalogs', async () => {
    const provider = new CopilotProvider();
    expect(await provider.validateKey(credential)).toBe(true);
    expect(exchanges).toBe(1);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('OK'));
    await expect(provider.validateKey(credential)).rejects.toThrow('Provider returned an invalid or unsuccessful response.');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(json({ data: [] }));
    await expect(provider.validateKey(credential)).rejects.toThrow('No eligible Copilot');
  });

  it('does not log or propagate credential-bearing transport errors', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error(`transport SECRET ${credential}`));
    await expect(resolveCopilotToken(credential)).rejects.toThrow('Copilot credential exchange failed.');
    expect(log.mock.calls.flat().join(' ')).not.toContain(credential);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(credential);
  });
});
