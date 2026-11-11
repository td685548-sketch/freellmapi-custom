import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { proxyFetch } from '../../lib/proxy.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { invalidateConfigCache, setConfigValue, setEnabled, createCombo } from '../../custom/x-gateway/config.js';
import { invalidateXGatewayKeyCache, setProviderModelConfig } from '../../custom/provider-accounts/store.js';
import { parseModelThinkingSuffix, resolveCandidateRoutes } from '../../custom/x-gateway/router.js';
import { getXGatewayProvider } from '../../custom/provider-accounts/catalog.js';
import { mintXGatewayClientKey, updateXGatewayClientKeyAccess } from '../../custom/x-gateway/client-keys.js';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../../custom/provider-accounts/execution.js', async importOriginal => ({
  ...await importOriginal<object>(), resolveAccountProvider: () => ({ chatCompletion: complete }),
}));
vi.mock('../../lib/proxy.js', async importOriginal => ({
  ...await importOriginal<object>(), proxyFetch: vi.fn(),
}));

const upstream = vi.mocked(proxyFetch);
let server: Server;
let base: string;
let apiKey: string;
let session: string;

function seed(provider = 'xai', model = 'grok-imagine-video'): number {
  const secret = encrypt(`sk-test-${provider}-credential`);
  const row = getDb().prepare(`INSERT INTO x_gateway_keys
    (provider, label, auth_method, encrypted_key, iv, auth_tag, base_url, models_json, status, enabled)
    VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, 'healthy', 1)`)
    .run(provider, provider, secret.encrypted, secret.iv, secret.authTag,
      `https://${provider}.example/v1`, JSON.stringify([{ id: model, name: model }]));
  invalidateXGatewayKeyCache();
  return Number(row.lastInsertRowid);
}

function call(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/x/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function dashboard(path: string, body?: unknown) {
  return fetch(`${base}/api/x-gateway${path}`, {
    method: body === undefined ? 'GET' : path === '/media/config' ? 'PUT' : 'POST',
    headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  await new Promise<void>(resolve => {
    server = createApp().listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  initDb(':memory:');
  invalidateConfigCache();
  invalidateXGatewayKeyCache();
  const owner = createUser('agent4@example.com', 'Agent4TestPassword!');
  apiKey = mintUserApiKey(owner.userId, '9router tests').key;
  session = createSession(owner.userId);
  setEnabled(true);
  upstream.mockReset();
  complete.mockReset().mockResolvedValue({ choices: [{ message: { role: 'assistant', content: 'Compressed context' } }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } });
});

describe('thinking suffix and per-provider rotation', () => {
  it('authorizes suffixed models against the clean allowlist without widening access', async () => {
    const owner = getDb().prepare('SELECT id FROM users WHERE email = ?').get('agent4@example.com') as { id: number };
    const key = mintXGatewayClientKey(owner.id);
    updateXGatewayClientKeyAccess(key.id, { restricted: true, allowedModels: ['openai/o4-mini'] });
    seed('openai', 'o4-mini');
    const headers = { Authorization: `Bearer ${key.key}` };
    expect((await call('/chat/completions', { model: 'openai/o4-mini(high)', messages: [{ role: 'user', content: 'hi' }] }, headers)).status).toBe(200);
    expect((await call('/chat/completions', { model: 'openai/other(high)', messages: [{ role: 'user', content: 'hi' }] }, headers)).status).toBe(403);
  });
  it.each(['low', 'medium', 'high', 'max', 'minimal', 'none'] as const)('parses and forwards %s', async effort => {
    expect(parseModelThinkingSuffix(`openai/o4-mini(${effort})`)).toEqual({ cleanModel: 'openai/o4-mini', thinkingEffort: effort });
    seed('openai', 'o4-mini');
    const response = await call('/chat/completions', { model: `openai/o4-mini(${effort})`, messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(200);
    expect(complete.mock.calls[0][2]).toBe('o4-mini');
    expect(complete.mock.calls[0][3].reasoning_effort).toBe(effort);
  });
  it('handles auto, Claude, whitespace, and leaves unknown suffixes intact', () => {
    expect(parseModelThinkingSuffix(' auto(low) ')).toEqual({ cleanModel: 'auto', thinkingEffort: 'low' });
    expect(parseModelThinkingSuffix('claude/claude-sonnet-4-5-20250929(medium)').cleanModel).toBe('claude/claude-sonnet-4-5-20250929');
    expect(parseModelThinkingSuffix('model(custom)').cleanModel).toBe('model(custom)');
    expect(parseModelThinkingSuffix(undefined).cleanModel).toBe('auto');
    seed('openai', 'o4-mini');
    expect(resolveCandidateRoutes('auto(low)').candidates[0].modelId).toBe('o4-mini');
  });
  it('rotates after stickyLimit calls, independently by provider, and resets on membership changes', () => {
    const a = seed('openai', 'o4-mini');
    const b = seed('openai', 'o4-mini');
    seed('xai', 'grok-imagine-video');
    setConfigValue('provider_settings', JSON.stringify({ openai: { strategy: 'round-robin', stickyLimit: 2 } }));
    const first = () => resolveCandidateRoutes('openai/o4-mini').candidates[0].account.id;
    expect(first()).toBe(a);
    resolveCandidateRoutes('xai/grok-imagine-video');
    expect(first()).toBe(a);
    expect(first()).toBe(b);
    expect(first()).toBe(b);
    expect(first()).toBe(a);
    getDb().prepare('UPDATE x_gateway_keys SET enabled = 0 WHERE id = ?').run(a);
    invalidateXGatewayKeyCache();
    expect(first()).toBe(b);
  });
  it('keeps fallback order, supports auto and combo routes and skips disabled models', () => {
    const a = seed('openai', 'o4-mini'); seed('openai', 'o4-mini');
    expect(resolveCandidateRoutes('auto').candidates[0].account.id).toBe(a);
    expect(resolveCandidateRoutes('auto').candidates[0].account.id).toBe(a);
    setConfigValue('provider_settings', JSON.stringify({ openai: { strategy: 'round-robin', stickyLimit: 1 } }));
    createCombo('video-test', [{ platform: 'openai', modelId: 'o4-mini' }]);
    expect(resolveCandidateRoutes('combo:video-test').candidates[0].account.id).toBe(a);
    expect(resolveCandidateRoutes('combo:video-test').candidates[0].account.id).not.toBe(a);
    setProviderModelConfig('openai', { disabledModels: ['o4-mini'] });
    expect(resolveCandidateRoutes('openai/o4-mini(high)').candidates).toEqual([]);
  });
});

describe('metadata, fetch compatibility, and context compaction', () => {
  it('serves model info and slash-containing detail IDs', async () => {
    seed('openai', 'tts-1'); seed('replicate', 'owner/video-model');
    for (const path of ['/models/info?id=openai/tts-1&kind=tts', '/models/openai/tts-1']) {
      const response = await call(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'openai/tts-1', kind: 'tts', endpoint: '/x/v1/audio/speech', voicesUrl: '/x/v1/audio/voices?provider=openai' });
    }
    expect((await call('/models/replicate/owner/video-model')).status).toBe(200);
    expect((await call('/models/info')).status).toBe(400);
    expect((await call('/models/info?id=openai/missing')).status).toBe(404);
    expect((await call('/models/info?id=openai/tts-1&kind=image')).status).toBe(404);
    seed('elevenlabs', 'eleven_multilingual_v2');
    const tts = await call('/models/info?id=elevenlabs/eleven_multilingual_v2&kind=tts');
    expect(tts.status).toBe(200);
    expect(await tts.json()).toMatchObject({ kind: 'tts', voicesUrl: '/x/v1/audio/voices?provider=elevenlabs' });
  });
  it('mounts web/fetch with the same SSRF guard', async () => {
    expect((await call('/web/fetch', { url: 'http://127.0.0.1/secrets' })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => String(url).startsWith('https://93.184.216.34')
      ? Promise.resolve(new Response('<h1>Hello</h1>', { headers: { 'Content-Type': 'text/html' } })) : originalFetch(url, init));
    try {
      expect((await call('/web/fetch', { url: 'https://93.184.216.34/' })).status).toBe(200);
    } finally { fetchSpy.mockRestore(); }
  });
  it.each(['input', 'messages', 'instructions'])('compacts %s through the selected model', async field => {
    seed('openai', 'o4-mini');
    const response = await call('/responses/compact', { model: 'openai/o4-mini', [field]: field === 'messages' ? [{ role: 'user', content: 'Keep this decision' }] : 'Keep this decision', stream: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'response', status: 'completed', output_text: 'Compressed context', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Compressed context' }] }], usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } });
    expect(JSON.stringify(complete.mock.calls[0][1])).toContain('Keep this decision');
    expect(JSON.stringify(complete.mock.calls[0][1])).toContain('Compress');
  });
  it('rejects empty compact requests and reports missing accounts', async () => {
    expect((await call('/responses/compact', {})).status).toBe(400);
    expect((await call('/responses/compact', { input: 'history' })).status).toBe(503);
  });
});

describe('voice catalogs', () => {
  it('uses the chosen voice and strips the provider prefix in both speech surfaces', async () => {
    seed('openai', 'tts-1');
    for (const invoke of [
      () => call('/audio/speech', { model: 'openai/tts-1', input: 'Hello', voice: 'nova' }),
      () => dashboard('/media/test/tts', { model: 'openai/tts-1', input: 'Hello', voice: 'nova' }),
    ]) {
      upstream.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'audio/mpeg' } }));
      expect((await invoke()).status).toBe(200);
      expect(JSON.parse(String(upstream.mock.calls.at(-1)![1]?.body))).toMatchObject({ model: 'tts-1', voice: 'nova' });
    }
  });
  it('serves dashboard voices using the session without requiring a stored raw gateway key', async () => {
    const response = await dashboard('/media/voices?provider=openai');
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].id).toBe('alloy');
  });
  it.each(['openai', 'gemini', 'deepgram'])('lists built-in voices for %s', async provider => {
    const response = await call(`/audio/voices?provider=${provider}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].model).toBe(`${getXGatewayProvider(provider)?.alias}/${body.data[0].id}`);
    expect((await (await call(`/audio/voices?provider=${provider}&lang=zz`)).json()).data.length).toBe(provider === 'gemini' ? body.data.length : 0);
  });
  it.each(['elevenlabs', 'cartesia', 'fish-audio'])('loads authenticated %s catalogs', async provider => {
    seed(provider, 'tts');
    upstream.mockResolvedValueOnce(json({ voices: [{ voice_id: 'demo', name: 'Demo', language: 'vi-VN', gender: 'female' }] }));
    const response = await call(`/audio/voices?provider=${provider}&lang=vi`);
    expect(response.status).toBe(200);
    expect((await response.json()).data[0]).toMatchObject({ id: 'demo', lang: 'vi-VN', gender: 'female' });
  });
  it('loads Edge voices and handles unsupported providers and upstream failure', async () => {
    upstream.mockResolvedValueOnce(json([{ ShortName: 'vi-VN-HoaiMyNeural', FriendlyName: 'Hoai My', Locale: 'vi-VN', Gender: 'Female' }]));
    expect((await (await call('/audio/voices?provider=edge-tts&lang=vi')).json()).data[0].id).toBe('vi-VN-HoaiMyNeural');
    expect((await call('/audio/voices?provider=invalid')).status).toBe(400);
    expect((await call('/audio/voices?provider=elevenlabs')).status).toBe(503);
    upstream.mockRejectedValueOnce(new Error('private failure'));
    expect((await call('/audio/voices?provider=edge-tts')).status).toBe(502);
  });
});

describe('video generation and media configuration', () => {
  it('creates and polls using a pinned account and stripped model prefix', async () => {
    seed(); const second = seed();
    upstream.mockResolvedValueOnce(json({ request_id: 'job-1', status: 'pending' }, 202));
    const created = await call('/videos/generations', { model: 'xai/grok-imagine-video', prompt: 'sunrise' }, { 'x-9router-connection-id': String(second) });
    expect(created.status).toBe(202);
    expect(created.headers.get('x-9router-connection-id')).toBe(String(second));
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://xai.example/v1/videos/generations');
    expect(JSON.parse(String(init?.body)).model).toBe('grok-imagine-video');
    expect(new Headers(init?.headers).get('x-9router-connection-id')).toBe(String(second));
    upstream.mockResolvedValueOnce(json({ id: 'job-1', status: 'completed', url: 'https://cdn.example/video.mp4' }));
    const polled = await call('/videos/job-1?provider=xai', undefined, { 'x-connection-id': String(second) });
    expect(polled.status).toBe(200);
    expect(upstream.mock.calls[1][0]).toBe('https://xai.example/v1/videos/job-1');
    expect(new Headers(upstream.mock.calls[1][1]?.headers).get('x-9router-connection-id')).toBe(String(second));
  });
  it('uses native OpenAI multipart, Replicate predictions, and Gemini operations', async () => {
    for (const [provider, model, path] of [['openai', 'sora-2', '/videos'], ['replicate', 'owner/video', '/models/owner/video/predictions'], ['gemini', 'veo-3', '/models/veo-3:predictLongRunning']]) {
      seed(provider, model);
      upstream.mockResolvedValueOnce(json({ id: 'job' }));
      expect((await call('/videos/generations', { model: `${provider}/${model}`, prompt: 'lake', aspect_ratio: '9:16' })).status).toBe(200);
      const [url, init] = upstream.mock.calls.at(-1)!;
      expect(url).toBe(`https://${provider}.example/v1${path}`);
      if (provider === 'openai') expect((init?.body as FormData).get('model')).toBe('sora-2');
    }
  });
  it('uses Fal queue authentication and Together video endpoints', async () => {
    const fal = seed('fal-ai', 'fal-ai/veo3');
    seed('together', 'Wan-AI/Wan2.2-T2V-A14B');
    upstream.mockResolvedValueOnce(json({ request_id: 'fal-job' }, 202));
    expect((await call('/videos/generations', { model: 'fal-ai/fal-ai/veo3', prompt: 'lake' })).status).toBe(202);
    expect(upstream.mock.calls[0][0]).toBe('https://fal-ai.example/v1/fal-ai/veo3');
    expect(new Headers(upstream.mock.calls[0][1]?.headers).get('authorization')).toMatch(/^Key /);
    upstream.mockResolvedValueOnce(json({ status: 'IN_PROGRESS' }));
    expect((await call('/videos/fal-job?model=fal-ai/fal-ai/veo3', undefined, { 'x-connection-id': String(fal) })).status).toBe(200);
    expect(upstream.mock.calls[1][0]).toBe('https://fal-ai.example/v1/fal-ai/veo3/requests/fal-job/status');
    upstream.mockResolvedValueOnce(json({ id: 'together-job' }));
    expect((await call('/videos/generations', { model: 'together/Wan-AI/Wan2.2-T2V-A14B', prompt: 'lake' })).status).toBe(200);
    expect(upstream.mock.calls[2][0]).toBe('https://together.example/v1/videos');
  });
  it('corrects legacy catalog origins for native video APIs', async () => {
    for (const [provider, model, target] of [
      ['gemini', 'veo-3', 'https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning'],
      ['fal-ai', 'fal-ai/veo3', 'https://queue.fal.run/fal-ai/veo3'],
      ['together', 'Wan-AI/video', 'https://api.together.xyz/v2/videos'],
    ]) {
      const id = seed(provider, model);
      getDb().prepare('UPDATE x_gateway_keys SET base_url = ? WHERE id = ?').run(getXGatewayProvider(provider)!.baseUrl, id);
      invalidateXGatewayKeyCache();
      upstream.mockResolvedValueOnce(json({ id: 'native-job' }));
      expect((await call('/videos/generations', { model: `${provider}/${model}`, prompt: 'lake' })).status).toBe(200);
      expect(upstream.mock.calls.at(-1)![0]).toBe(target);
    }
  });
  it('does not rotate poll accounts and redacts upstream credentials in JSON errors', async () => {
    const account = seed(); seed();
    upstream.mockResolvedValueOnce(json({ error: 'sk-test-xai-credential was rejected' }, 401));
    const response = await call('/videos/job', undefined, { 'x-connection-id': String(account) });
    expect(response.status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(1);
    const error = await response.json();
    expect(error.error.type).toBe('upstream_error');
    expect(error.error.message).not.toContain('sk-test-xai-credential');
  });
  it('retries rejected creates, but never duplicates jobs on 5xx or network errors', async () => {
    seed(); seed();
    upstream.mockResolvedValueOnce(json({ error: 'quota' }, 429)).mockResolvedValueOnce(json({ id: 'fallback' }));
    expect((await call('/videos/generations', { model: 'xai/grok-imagine-video', prompt: 'lake' })).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(2);
    upstream.mockClear().mockResolvedValueOnce(json({ error: 'unavailable' }, 503));
    expect((await call('/videos/generations', { model: 'xai/grok-imagine-video', prompt: 'lake' })).status).toBe(503);
    expect(upstream).toHaveBeenCalledTimes(1);
    upstream.mockClear().mockRejectedValueOnce(new Error('disconnect'));
    expect((await call('/videos/generations', { model: 'xai/grok-imagine-video', prompt: 'lake' })).status).toBe(502);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it('validates requests, excludes chat-only providers, and refuses unavailable pins', async () => {
    seed('groq', 'llama');
    expect((await call('/videos/generations', { prompt: '' })).status).toBe(400);
    expect((await call('/videos/generations', { prompt: 'lake', model: 'groq/llama' })).status).toBe(503);
    expect((await call('/videos/job?provider=invalid')).status).toBe(400);
    expect((await call('/videos/job', undefined, { 'x-connection-id': 'bad' })).status).toBe(400);
    seed();
    expect((await call('/videos/job', undefined, { 'x-connection-id': '99999' })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('adds video providers and persists defaults across unrelated saves', async () => {
    const config = await (await dashboard('/media/config')).json();
    expect(config.kinds.video).toMatchObject({ label: 'Text to Video', endpoint: '/x/v1/videos/generations' });
    expect(config.kinds.video.defaultProviders).toEqual(expect.arrayContaining(['xai', 'openai', 'gemini', 'replicate', 'fal-ai', 'together', 'siliconflow', 'minimax', 'kling', 'luma']));
    expect((await dashboard('/media/config', { video: { defaultModel: 'xai/grok-imagine-video', aspectRatio: '9:16' } })).status).toBe(200);
    await dashboard('/media/config', { tts: { defaultVoice: 'nova' } });
    expect((await (await dashboard('/media/config')).json()).defaults.video).toMatchObject({ defaultModel: 'xai/grok-imagine-video', aspectRatio: '9:16' });
    seed();
    upstream.mockResolvedValueOnce(json({ id: 'dashboard-job', status: 'queued' }));
    expect((await dashboard('/media/test/video', { prompt: 'lake' })).status).toBe(200);
    expect(JSON.parse(String(upstream.mock.calls[0][1]?.body))).toMatchObject({ model: 'grok-imagine-video', aspect_ratio: '9:16' });
    expect((await dashboard('/media/test/video', { prompt: 'lake', aspect_ratio: 'bad' })).status).toBe(400);
  });
  it.each(['/audio/voices?provider=openai', '/models/info?id=openai/tts-1', '/videos/job'])('requires gateway auth for %s', async path => {
    const response = await fetch(`${base}/x/v1${path}`, { headers: { Authorization: 'Bearer invalid' } });
    expect(response.status).toBe(401);
  });
});
