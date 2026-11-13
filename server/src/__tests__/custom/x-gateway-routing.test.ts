import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { createCombo, invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import {
  applySessionStickiness,
  conversationFingerprint,
  htmlToMarkdown,
  htmlToText,
  recordRouteOutcome,
  resetRouteHealth,
  resetSessionPins,
  resolveCandidateRoutes,
} from '../../custom/x-gateway/router.js';
import {
  invalidateXGatewayKeyCache,
  setProviderModelConfig,
} from '../../custom/provider-accounts/store.js';

process.env.ENCRYPTION_KEY = '0'.repeat(64);

// The encryption key only exists after initDb(), so encrypt lazily.
let secret: { encrypted: string; iv: string; authTag: string } | null = null;

function seedAccount(provider: string, modelId: string, baseUrl?: string): number {
  secret ??= encrypt('sk-routing-test');
  const info = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider,label,auth_method,encrypted_key,iv,auth_tag,base_url,models_json,status,enabled)
    VALUES (?,?,?,?,?,?,?,?,'healthy',1)`)
    .run(
      provider,
      `${provider} account`,
      'api_key',
      secret.encrypted,
      secret.iv,
      secret.authTag,
      baseUrl ?? null,
      JSON.stringify([{ id: modelId, name: modelId }]),
    );
  invalidateXGatewayKeyCache();
  return Number(info.lastInsertRowid);
}

function resetGatewayState(): void {
  initDb(':memory:');
  invalidateConfigCache();
  invalidateXGatewayKeyCache();
  resetRouteHealth();
  resetSessionPins();
}

describe('runtime alias and disabled model routing', () => {
  beforeEach(resetGatewayState);

  it('resolves provider/model aliases to the real model', () => {
    const account = seedAccount('groq', 'llama-3.3-70b-versatile');
    setProviderModelConfig('groq', { modelAliases: { fast: 'llama-3.3-70b-versatile' } });

    const resolved = resolveCandidateRoutes('groq/fast');
    expect(resolved.notFoundError).toBeUndefined();
    expect(resolved.candidates.map(candidate => candidate.account.id)).toEqual([account]);
    expect(resolved.candidates.map(candidate => candidate.modelId)).toEqual(['llama-3.3-70b-versatile']);
  });

  it('skips disabled models on explicit routes and inside combos', () => {
    seedAccount('groq', 'llama-3.3-70b-versatile');
    const fallbackAccount = seedAccount('openai', 'gpt-5.4-mini');
    setProviderModelConfig('groq', {
      modelAliases: { fast: 'llama-3.3-70b-versatile' },
      disabledModels: ['llama-3.3-70b-versatile'],
    });

    const explicit = resolveCandidateRoutes('groq/fast');
    expect(explicit.candidates).toEqual([]);
    expect(explicit.notFoundError).toMatch(/disabled/);

    createCombo('alias-combo', [
      { platform: 'groq', modelId: 'fast' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'fallback' });

    const combo = resolveCandidateRoutes('combo:alias-combo');
    expect(combo.candidates.map(candidate => candidate.account.id)).toEqual([fallbackAccount]);
    expect(combo.candidates.every(candidate => candidate.modelId !== 'llama-3.3-70b-versatile')).toBe(true);
  });

  it('still applies aliases to enabled combo entries', () => {
    seedAccount('groq', 'llama-3.3-70b-versatile');
    setProviderModelConfig('groq', { modelAliases: { fast: 'llama-3.3-70b-versatile' }, disabledModels: [] });
    createCombo('alias-only', [{ platform: 'groq', modelId: 'fast' }], undefined, { strategy: 'fallback' });

    expect(resolveCandidateRoutes('combo:alias-only').candidates.map(candidate => candidate.modelId))
      .toEqual(['llama-3.3-70b-versatile']);
  });
});

describe('smart combo session stickiness', () => {
  beforeEach(resetGatewayState);

  const conversation = (firstUser = 'Explain prompt caching'): ChatMessage[] => [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: firstUser },
  ];

  it('pins the first route, keeps it while healthy, and releases it after an error', () => {
    const pinnedAccount = seedAccount('groq', 'llama-3.3-70b-versatile');
    const otherAccount = seedAccount('openai', 'gpt-5.4-mini');
    createCombo('sticky', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'smart', smartPolicy: 'smart', sessionSticky: true });

    const resolved = resolveCandidateRoutes('combo:sticky');
    expect(resolved.combo).toBeDefined();
    const combo = resolved.combo!;
    const first = applySessionStickiness(resolved.candidates, combo, conversation());
    expect(first[0].account.id).toBe(pinnedAccount);

    // The alternative is measurably better, but not by enough to lose the pin.
    recordRouteOutcome(`${pinnedAccount}:llama-3.3-70b-versatile`, { latencyMs: 500 });
    recordRouteOutcome(`${otherAccount}:gpt-5.4-mini`, { latencyMs: 150 });
    const second = applySessionStickiness(
      resolveCandidateRoutes('combo:sticky').candidates,
      combo,
      conversation(),
    );
    expect(second[0].account.id).toBe(pinnedAccount);

    // A recent error always releases the pin.
    recordRouteOutcome(`${pinnedAccount}:llama-3.3-70b-versatile`, { error: true });
    const third = applySessionStickiness(
      resolveCandidateRoutes('combo:sticky').candidates,
      combo,
      conversation(),
    );
    expect(third[0].account.id).toBe(otherAccount);
  });

  it('honours strict locks and per-turn policies', () => {
    const pinnedAccount = seedAccount('groq', 'llama-3.3-70b-versatile');
    const otherAccount = seedAccount('openai', 'gpt-5.4-mini');
    createCombo('strict-combo', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'smart', smartPolicy: 'strict', sessionSticky: true });

    const strict = resolveCandidateRoutes('combo:strict-combo');
    const strictCombo = strict.combo!;
    applySessionStickiness(strict.candidates, strictCombo, conversation());

    recordRouteOutcome(`${pinnedAccount}:llama-3.3-70b-versatile`, { error: true });
    recordRouteOutcome(`${otherAccount}:gpt-5.4-mini`, { latencyMs: 50 });
    const strictAgain = applySessionStickiness(
      resolveCandidateRoutes('combo:strict-combo').candidates,
      strictCombo,
      conversation(),
    );
    expect(strictAgain[0].account.id).toBe(pinnedAccount);

    createCombo('per-turn-combo', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'smart', smartPolicy: 'per-turn' });

    const perTurn = resolveCandidateRoutes('combo:per-turn-combo');
    const perTurnCombo = perTurn.combo!;
    // Health sorting already put the healthy route first; stickiness must not pin.
    const firstTurn = applySessionStickiness(perTurn.candidates, perTurnCombo, conversation());
    expect(firstTurn[0].account.id).toBe(otherAccount);
    recordRouteOutcome(`${pinnedAccount}:llama-3.3-70b-versatile`, { latencyMs: 40 });
    const secondTurn = applySessionStickiness(
      resolveCandidateRoutes('combo:per-turn-combo').candidates,
      perTurnCombo,
      conversation(),
    );
    expect(secondTurn[0].account.id).toBe(pinnedAccount);
  });

  it('fingerprints the system prompt and first user message only', () => {
    const base = conversation('First question');
    const sameConversation = [...base, { role: 'assistant' as const, content: 'Answer' }, { role: 'user' as const, content: 'Follow up' }];
    expect(conversationFingerprint(base)).toBe(conversationFingerprint(sameConversation));
    expect(conversationFingerprint(base)).not.toBe(conversationFingerprint(conversation('Another first question')));
    expect(conversationFingerprint([{ role: 'system', content: 'Only system' }])).toBeTruthy();
    expect(conversationFingerprint([])).toBeNull();

    const changedSystem: ChatMessage[] = [
      { role: 'system', content: 'A different system prompt.' },
      { role: 'user', content: 'First question' },
    ];
    expect(conversationFingerprint(changedSystem)).not.toBe(conversationFingerprint(base));
  });

  it('only applies stickiness to smart combos', () => {
    const first = seedAccount('groq', 'llama-3.3-70b-versatile');
    const second = seedAccount('openai', 'gpt-5.4-mini');
    createCombo('fallback-combo', [
      { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
      { platform: 'openai', modelId: 'gpt-5.4-mini' },
    ], undefined, { strategy: 'fallback' });

    const resolved = resolveCandidateRoutes('combo:fallback-combo');
    const ordered = applySessionStickiness(resolved.candidates, resolved.combo, conversation());
    expect(ordered.map(candidate => candidate.account.id)).toEqual([first, second]);
  });
});

describe('web search, fetch and HTML conversion', () => {
  let server: Server;
  let base: string;
  let apiKey: string;
  const realFetch = global.fetch;
  const upstream = vi.fn();

  beforeAll(async () => {
    initDb(':memory:');
    invalidateConfigCache();
    invalidateXGatewayKeyCache();

    const owner = createUser('routing-admin@example.test', 'AdminPass123!');
    createSession(owner.userId);
    apiKey = mintUserApiKey(owner.userId, 'routing test').key;

    seedAccount('tavily', 'default');
    seedAccount('openai', 'gpt-5.4-mini');
    setProviderModelConfig('groq', { disabledModels: [] });
    setEnabled(true);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    upstream.mockReset();
  });

  const call = (path: string, body: unknown) => fetch(`${base}/thruline/v1${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('searches through the native Tavily adapter', async () => {
    upstream.mockImplementationOnce(async (url, init) => {
      expect(String(url)).toBe('https://api.tavily.com/search');
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toMatch(/^Bearer sk-routing-test$/);
      expect(JSON.parse(String(init?.body))).toMatchObject({ query: 'express routing', max_results: 3 });
      return new Response(JSON.stringify({
        results: [
          { title: 'Express', url: 'https://expressjs.com', content: 'Fast, unopinionated web framework' },
          { title: 'Routing guide', url: 'https://expressjs.com/en/guide/routing.html', content: 'Routing basics' },
        ],
      }), { headers: { 'content-type': 'application/json' } });
    });

    const res = await call('/search', { query: 'express routing', model: 'tavily/default', max_results: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      query: 'express routing',
      model: 'default',
      provider: 'tavily',
      results: [
        { title: 'Express', url: 'https://expressjs.com', snippet: 'Fast, unopinionated web framework' },
        { title: 'Routing guide', url: 'https://expressjs.com/en/guide/routing.html', snippet: 'Routing basics' },
      ],
    });
  });

  it('falls back to searchViaChat and parses JSON from the model answer', async () => {
    upstream.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
      expect(body.model).toBe('gpt-5.4-mini');
      expect(body.messages.at(-1)?.content).toBe('web docs');
      return new Response(JSON.stringify({
        id: 'chat-search',
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '```json\n{"results":[{"title":"MDN","url":"https://developer.mozilla.org","snippet":"Web docs"}],"content":"Use MDN."}\n```',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
      }), { headers: { 'content-type': 'application/json' } });
    });

    const res = await call('/search', { query: 'web docs', model: 'openai/gpt-5.4-mini' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      results: [{ title: 'MDN', url: 'https://developer.mozilla.org', snippet: 'Web docs' }],
      content: 'Use MDN.',
    });
  });

  it('rejects an empty query and a disabled search model', async () => {
    expect((await call('/search', { query: '   ' })).status).toBe(400);

    setProviderModelConfig('tavily', { disabledModels: ['default'] });
    const disabled = await call('/search', { query: 'hello', model: 'tavily/default' });
    expect(disabled.status).toBe(404);
    expect((await disabled.json() as { error: { code: string } }).error.code).toBe('model_not_found');
    setProviderModelConfig('tavily', { disabledModels: [] });
  });

  it('blocks private, loopback and metadata targets before fetching', async () => {
    const blocked = [
      'http://localhost/',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00:ec2::254]/',
      'file:///etc/passwd',
    ];
    for (const url of blocked) {
      const res = await call('/fetch', { url });
      expect(res.status, url).toBe(400);
      expect((await res.json() as { error: { code: string } }).error.code, url).toBe('url_blocked');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fetches a public page and converts HTML to markdown', async () => {
    upstream.mockImplementationOnce(async () => new Response(
      '<!doctype html><html><head><title>Demo &amp; Co</title>'
      + '<script>bad()</script><style>.x{display:none}</style></head><body>'
      + '<h1>Hello</h1><p>Read <a href="https://example.com/docs">the docs</a>.</p>'
      + '<ul><li>One</li><li>Two</li></ul></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    ));

    const res = await call('/fetch', { url: 'https://93.184.216.34/page', format: 'markdown' });
    expect(res.status).toBe(200);
    const body = await res.json() as { title?: string; content: string; finalUrl: string; truncated: boolean };
    expect(body).toMatchObject({
      finalUrl: 'https://93.184.216.34/page',
      title: 'Demo & Co',
      truncated: false,
    });
    expect(body.content).toContain('# Hello');
    expect(body.content).toContain('[the docs](https://example.com/docs)');
    expect(body.content).toContain('- One');
    expect(body.content).not.toContain('bad()');
    expect(body.content).not.toContain('.x{display:none}');
  });

  it('returns plain text and truncates to max_characters', async () => {
    upstream.mockImplementationOnce(async () => new Response(
      '<html><head><title>T</title></head><body><p>Hello <b>world</b></p></body></html>',
      { headers: { 'content-type': 'text/html' } },
    ));

    const res = await call('/fetch', { url: 'https://93.184.216.34/text', format: 'text', max_characters: 5 });
    expect(res.status).toBe(200);
    const body = await res.json() as { content: string; truncated: boolean; format: string };
    expect(body).toMatchObject({ content: 'Hello', truncated: true, format: 'text' });
  });

  it('re-validates redirect targets and blocks a hop to metadata', async () => {
    upstream.mockImplementationOnce(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));

    const res = await call('/fetch', { url: 'https://93.184.216.34/redirect' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('url_blocked');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect and reports the final URL', async () => {
    upstream
      .mockImplementationOnce(async () => new Response(null, {
        status: 301,
        headers: { location: 'https://93.184.216.35/final' },
      }))
      .mockImplementationOnce(async () => new Response('<html><body><p>Moved</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      }));

    const res = await call('/fetch', { url: 'https://93.184.216.34/start' });
    expect(res.status).toBe(200);
    const body = await res.json() as { finalUrl: string; content: string };
    expect(body.finalUrl).toBe('https://93.184.216.35/final');
    expect(body.content).toContain('Moved');
  });

  it('converts HTML entities and inline markup safely', () => {
    expect(htmlToMarkdown('<h2>A &amp; B</h2><p><a href="/x?a=1&amp;b=2">link</a></p>'))
      .toContain('## A & B');
    expect(htmlToMarkdown('<h2>A &amp; B</h2><p><a href="/x?a=1&amp;b=2">link</a></p>'))
      .toContain('[link](/x?a=1&b=2)');
    expect(htmlToText('<p>One<br>Two</p><script>x()</script><p>Three</p>'))
      .toBe('One\nTwo\n\nThree');
  });
});
