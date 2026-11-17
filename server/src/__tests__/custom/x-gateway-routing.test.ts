import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { createCombo, invalidateConfigCache, setEnabled, setRouteHealthTtlMinutes } from '../../custom/x-gateway/config.js';
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
  clearAccountCooldown,
  getAccountCooldown,
  setAccountCooldown,
} from '../../custom/provider-accounts/auto-ping.js';
import {
  applyQuotaRouting,
  defaultQuotaTier,
} from '../../custom/x-gateway/quota/store.js';
import {
  getAutoSessionRoute,
  resetAutoSessionCache,
} from '../../custom/x-gateway/auto-session-cache.js';
import {
  EmptyStreamError,
  peekStreamForContent,
  reconstructStream,
  setAutoStreamPeekTimeoutMs,
} from '../../custom/x-gateway/stream-peek.js';
import {
  compressWithHeadroom,
  invalidateHeadroomCache,
  setHeadroomConfig,
} from '../../custom/x-gateway/headroom.js';
import { setConfigValue } from '../../custom/x-gateway/config.js';
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

  it('expands provider/auto across enabled models and demotes failing subscription models', () => {
    secret ??= encrypt('sk-routing-test');
    const info = getDb().prepare(`INSERT INTO x_gateway_keys
      (provider,label,auth_method,encrypted_key,iv,auth_tag,base_url,models_json,status,enabled)
      VALUES (?,?,?,?,?,?,?,?,'healthy',1)`)
      .run(
        'codex',
        'codex account',
        'api_key',
        secret.encrypted,
        secret.iv,
        secret.authTag,
        null,
        JSON.stringify([
          { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' },
          { id: 'gpt-6-astra', name: 'GPT 6.0 Astra' },
          { id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol' },
        ]),
      );
    const codexId = Number(info.lastInsertRowid);
    invalidateXGatewayKeyCache();
    setProviderModelConfig('codex', { disabledModels: ['gpt-6-astra'] });

    const initial = resolveCandidateRoutes('cx/auto');
    expect(initial.notFoundError).toBeUndefined();
    expect(initial.candidates.map(c => c.modelId)).toEqual(['gpt-6.1-sol', 'gpt-5.6-sol']);

    // Simulate gpt-6.1-sol failing (e.g. not in subscription); gpt-5.6-sol should move first.
    recordRouteOutcome(`${codexId}:gpt-6.1-sol`, { error: true });
    const afterFailure = resolveCandidateRoutes('cx/auto');
    expect(afterFailure.candidates.map(c => c.modelId)).toEqual(['gpt-5.6-sol', 'gpt-6.1-sol']);

    // When penalty TTL is set to 0, failed routes remain deprioritized even if time advances.
    setRouteHealthTtlMinutes(0);
    const futureNow = Date.now() + 60 * 60_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(futureNow);
    try {
      const persistedOrder = resolveCandidateRoutes('cx/auto');
      expect(persistedOrder.candidates.map(c => c.modelId)).toEqual(['gpt-5.6-sol', 'gpt-6.1-sol']);
    } finally {
      nowSpy.mockRestore();
      setRouteHealthTtlMinutes(5);
    }
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

function seedModelsAccount(provider: string, models: string[], baseUrl?: string): number {
  secret ??= encrypt('sk-routing-test');
  const info = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider,label,auth_method,encrypted_key,iv,auth_tag,base_url,models_json,status,enabled)
    VALUES (?,?,?,?,?,?,?,?,'healthy',1)`)
    .run(
      provider,
      `${provider} account`,
      provider === 'gemini-web' ? 'cookie' : 'api_key',
      secret.encrypted,
      secret.iv,
      secret.authTag,
      baseUrl ?? null,
      JSON.stringify(models.map(id => ({ id, name: id }))),
    );
  invalidateXGatewayKeyCache();
  return Number(info.lastInsertRowid);
}

describe('auto routing modality, cooldown, health, tier ranking and hot-path caches', () => {
  beforeEach(() => {
    resetGatewayState();
    setHeadroomConfig({ enabled: false, url: '' });
    invalidateHeadroomCache();
  });

  it('filters out image, TTS, STT, embedding, and video models for chat auto routing', () => {
    const geminiWebId = seedModelsAccount('gemini-web', [
      'gemini-image',
      'tts-1',
      'whisper-1',
      'text-embedding-3-small',
      'sora-2',
      'gemini-3.1-flash-lite',
    ]);
    const imageOnlyId = seedModelsAccount('openai', ['gemini-image', 'dall-e-3']);

    const chatResolved = resolveCandidateRoutes('auto', 'chat');
    expect(chatResolved.candidates).toHaveLength(1);
    expect(chatResolved.candidates[0].account.id).toBe(geminiWebId);
    expect(chatResolved.candidates[0].modelId).toBe('gemini-3.1-flash-lite');

    // provider/auto for chat also excludes gemini-image
    const providerAuto = resolveCandidateRoutes('gemini-web/auto', 'chat');
    expect(providerAuto.candidates.map(c => c.modelId)).toEqual(['gemini-3.1-flash-lite']);

    // Image modality still picks the image model from the image-only account
    const imageResolved = resolveCandidateRoutes('auto', 'image');
    expect(imageResolved.candidates.some(c => c.account.id === imageOnlyId && c.modelId === 'gemini-image')).toBe(true);
  });

  it('filters out cooled-down accounts and models, sorts auto by health, and ranks API/OAuth ahead of webCookie', () => {
    const webId = seedModelsAccount('gemini-web', ['gemini-3.1-pro']);
    const groqId = seedModelsAccount('groq', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']);
    const openaiId = seedModelsAccount('openai', ['gpt-5.4-mini']);

    try {
      // webCookie is classified as free tier and sorts behind fast API/OAuth/free providers
      expect(defaultQuotaTier('gemini-web')).toBe('free');
      const quotaSorted = applyQuotaRouting(
        resolveCandidateRoutes('auto', 'chat').candidates.map(c => c.account),
        true,
      );
      expect(quotaSorted.at(-1)?.id).toBe(webId);

      // Even if groq has measured latency > UNKNOWN_LATENCY_MS (1200), healthy API stays ahead of untried webCookie
      recordRouteOutcome(`${groqId}:llama-3.3-70b-versatile`, { latencyMs: 1_500 });
      recordRouteOutcome(`${openaiId}:gpt-5.4-mini`, { latencyMs: 250 });
      expect(resolveCandidateRoutes('auto', 'chat').candidates.map(c => c.account.id))
        .toEqual([openaiId, groqId, webId]);

      // Failing openai route gets demoted behind healthy groq and webCookie
      recordRouteOutcome(`${openaiId}:gpt-5.4-mini`, { error: true });
      expect(resolveCandidateRoutes('auto', 'chat').candidates.map(c => c.account.id))
        .toEqual([groqId, webId, openaiId]);

      // Model-scoped cooldown on groq switches groq to its second healthy chat model
      setAccountCooldown(groqId, 30_000, 'llama-3.3-70b-versatile');
      const afterModelCooldown = resolveCandidateRoutes('auto', 'chat').candidates;
      const groqCandidate = afterModelCooldown.find(c => c.account.id === groqId);
      expect(groqCandidate?.modelId).toBe('llama-3.1-8b-instant');

      // Account-wide cooldown removes openai completely
      setAccountCooldown(openaiId, 30_000);
      expect(resolveCandidateRoutes('auto', 'chat').candidates.some(c => c.account.id === openaiId)).toBe(false);
    } finally {
      clearAccountCooldown(webId);
      clearAccountCooldown(groqId);
      clearAccountCooldown(openaiId);
    }
  });

  it('caches provider_settings in rotateProviderAccounts and invalidates immediately on config change', () => {
    const a = seedAccount('openai', 'gpt-5.4-mini');
    const b = seedAccount('openai', 'gpt-5.4-mini');
    const db = getDb();
    const prepareSpy = vi.spyOn(db, 'prepare');

    resolveCandidateRoutes('openai/gpt-5.4-mini');
    const firstQueryCount = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('provider_settings')).length;
    expect(firstQueryCount).toBe(1);

    // Second call hits the 5s provider_settings cache (0 additional DB queries)
    resolveCandidateRoutes('openai/gpt-5.4-mini');
    const secondQueryCount = prepareSpy.mock.calls.filter(([sql]) => String(sql).includes('provider_settings')).length;
    expect(secondQueryCount).toBe(1);

    // Updating config invalidates immediately and activates round-robin
    setConfigValue('provider_settings', JSON.stringify({ openai: { strategy: 'round-robin', stickyLimit: 1 } }));
    expect(resolveCandidateRoutes('openai/gpt-5.4-mini').candidates[0].account.id).toBe(a);
    expect(resolveCandidateRoutes('openai/gpt-5.4-mini').candidates[0].account.id).toBe(b);
    prepareSpy.mockRestore();
  });

  it('bypasses blocking headroom calls via unreachable cooldown after first failure', async () => {
    setHeadroomConfig({ enabled: true, url: 'http://127.0.0.1:9999', timeoutMs: 300 });
    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    try {
      const first = await compressWithHeadroom({ messages: [{ role: 'user', content: 'hello '.repeat(50) }] });
      expect(first).toBeNull();
      const callsAfterFirst = fetchSpy.mock.calls.length;

      const diagnostics: { reason?: string } = {};
      const second = await compressWithHeadroom(
        { messages: [{ role: 'user', content: 'hello '.repeat(50) }] },
        { diagnostics },
      );
      expect(second).toBeNull();
      expect(diagnostics.reason).toContain('cooldown:');
      expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst);
    } finally {
      fetchSpy.mockRestore();
      setHeadroomConfig({ enabled: false, url: '' });
    }
  });
});

describe('auto stream peek, fast failover, and session stickiness', () => {
  let server: Server;
  let base: string;
  let playgroundSession: string;
  let apiKey: string;
  const realFetch = global.fetch;
  const upstream = vi.fn();

  beforeAll(async () => {
    resetGatewayState();
    const owner = createUser('stream-peek-admin@example.test', 'AdminPass123!');
    playgroundSession = createSession(owner.userId);
    apiKey = mintUserApiKey(owner.userId, 'stream-peek-key').key;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    vi.spyOn(global, 'fetch').mockImplementation((url, init) =>
      String(url).startsWith(base) ? realFetch(url, init) : upstream(url, init));
  });

  afterAll(() => {
    setAutoStreamPeekTimeoutMs(null);
    server?.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    initDb(':memory:');
    invalidateConfigCache();
    invalidateXGatewayKeyCache();
    resetRouteHealth();
    resetSessionPins();
    resetAutoSessionCache();
    setAutoStreamPeekTimeoutMs(null);
    const owner = createUser('stream-peek-admin@example.test', 'AdminPass123!');
    playgroundSession = createSession(owner.userId);
    apiKey = mintUserApiKey(owner.userId, 'stream-peek-key').key;
    setEnabled(true);
    upstream.mockReset();
  });

  it('peekStreamForContent buffers head chunks until first non-empty content and reconstructs intact', async () => {
    async function* source() {
      yield { id: '1', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' as const }, finish_reason: null }] };
      yield { id: '1', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] };
      yield { id: '1', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] };
      yield { id: '1', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }] };
    }
    const peek = await peekStreamForContent(source(), { timeoutMs: 500 });
    expect(peek.headChunks).toHaveLength(3);
    const replayed: string[] = [];
    for await (const chunk of reconstructStream(peek)) {
      if (chunk.choices[0]?.delta?.content) replayed.push(chunk.choices[0].delta.content);
    }
    expect(replayed).toEqual(['Hello', ' world']);

    async function* emptySource() {
      yield { id: '1', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta: { role: 'assistant' as const, content: '' }, finish_reason: 'stop' }] };
    }
    await expect(peekStreamForContent(emptySource(), { timeoutMs: 500 })).rejects.toBeInstanceOf(EmptyStreamError);
  });

  it('pins winning auto route per playground session and evicts immediately on failure', async () => {
    const groqId = seedAccount('groq', 'llama-3.3-70b-versatile');
    const openaiId = seedAccount('openai', 'gpt-5.4-mini');

    upstream.mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes('groq.com')) {
        return new Response(
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{"content":"From groq"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{"content":"From openai"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const playCall = (sessionId: string, text: string) => fetch(`${base}/api/thruline/playground/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${playgroundSession}`,
        'Content-Type': 'application/json',
        'X-Session-Id': sessionId,
      },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: text }], sessionId }),
    });

    // Turn 1 pins groq
    const turn1 = await playCall('chat-sess-1', 'Hi');
    expect(turn1.status).toBe(200);
    expect(turn1.headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');
    expect(await turn1.text()).toContain('From groq');
    expect(getAutoSessionRoute('chat-sess-1', 'chat', getDb())?.accountId).toBe(groqId);

    // Even if openai looks faster in routeHealth, Turn 2 with the same sessionId stays pinned to groq
    recordRouteOutcome(`${groqId}:llama-3.3-70b-versatile`, { latencyMs: 900 });
    recordRouteOutcome(`${openaiId}:gpt-5.4-mini`, { latencyMs: 50 });
    const turn2 = await playCall('chat-sess-1', 'Follow up');
    expect(turn2.status).toBe(200);
    expect(turn2.headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');

    // If groq returns an empty stream on Turn 3, the pin is evicted and Turn 3 fails over to openai
    upstream.mockImplementation(async (url) => {
      if (String(url).includes('groq.com')) {
        return new Response(
          'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"llama-3.3-70b-versatile","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(
        'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{"content":"Recovered openai"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const turn3 = await playCall('chat-sess-1', 'Third turn');
    expect(turn3.status).toBe(200);
    expect(turn3.headers.get('x-routed-via')).toBe('openai/gpt-5.4-mini');
    expect(await turn3.text()).toContain('Recovered openai');
    expect(getAutoSessionRoute('chat-sess-1', 'chat', getDb())?.accountId).toBe(openaiId);
  });

  it('fails over fast when an auto stream candidate times out before emitting first content', async () => {
    const groqId = seedAccount('groq', 'llama-3.3-70b-versatile');
    const openaiId = seedAccount('openai', 'gpt-5.4-mini');
    setAutoStreamPeekTimeoutMs(60);

    upstream.mockImplementation(async (url, init) => {
      if (String(url).includes('groq.com')) {
        // Never emits content before the 60ms peek timeout aborts it
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        });
        throw new Error('Aborted');
      }
      return new Response(
        'data: {"id":"2","object":"chat.completion.chunk","created":1,"model":"gpt-5.4-mini","choices":[{"index":0,"delta":{"content":"Fast fallback"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const res = await fetch(`${base}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Session-Id': 'timeout-sess',
      },
      body: JSON.stringify({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'Hello' }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-routed-via')).toBe('openai/gpt-5.4-mini');
    expect(await res.text()).toContain('Fast fallback');
    // Timed-out candidate enters transient cooldown and is demoted in routeHealth once cooldown clears
    expect(getAccountCooldown(groqId, 'llama-3.3-70b-versatile').inCooldown).toBe(true);
    expect(resolveCandidateRoutes('auto', 'chat').candidates.map(c => c.account.id)).toEqual([openaiId]);
    clearAccountCooldown(groqId);
    expect(resolveCandidateRoutes('auto', 'chat').candidates.map(c => c.account.id)).toEqual([openaiId, groqId]);
  });
});
