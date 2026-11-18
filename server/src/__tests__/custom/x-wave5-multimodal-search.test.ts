import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import { createApiKeyAccount } from '../../custom/provider-accounts/store.js';
import { isMetaLlamaKey, looksLikeCookieHeader, normalizeCookieInput } from '../../custom/provider-accounts/cookie-format.js';
import { buildWebSessionHeaders } from '../../custom/provider-accounts/web-cookie.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

describe('Wave 5 Multimodal Parity, Search Adapters, and Cookie Normalization', () => {
  let server: Server;
  let baseUrl = '';
  let gatewayKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'e'.repeat(64);
    initDb(':memory:');
    setEnabled(true);
    const owner = createUser(`wave5-admin-${Date.now()}@example.test`, 'TestPass#1234');
    createSession(owner.userId);
    gatewayKey = mintXGatewayClientKey(owner.userId, 'wave5-test').key;

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>(r => server?.close(() => r()));
  });

  const gatewayPost = (path: string, body: unknown, isForm = false) =>
    REAL_FETCH(`${baseUrl}/thruline/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${gatewayKey}`,
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      },
      body: isForm ? (body as FormData) : JSON.stringify(body),
    });

  const gatewayGet = (path: string) =>
    REAL_FETCH(`${baseUrl}/thruline/v1${path}`, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
    });

  it('normalizes Cookie-Editor JSON exports while preserving LLM|id|secret keys', () => {
    const metaKey = 'LLM|9876543210|secret_abc_xyz';
    expect(isMetaLlamaKey(metaKey)).toBe(true);
    expect(looksLikeCookieHeader(metaKey)).toBe(false);
    expect(normalizeCookieInput(metaKey)).toBe(metaKey);
    expect(buildWebSessionHeaders('grok-web', metaKey).Authorization).toBe(`Bearer ${metaKey}`);
    expect(buildWebSessionHeaders('grok-web', metaKey).Cookie).toBeUndefined();

    const cookieEditorJson = JSON.stringify([
      { name: 'sso', value: 'tok_1', domain: '.grok.com' },
      { name: 'sso-rw', value: 'tok_2', domain: '.grok.com' },
    ]);
    expect(normalizeCookieInput(cookieEditorJson)).toBe('sso=tok_1; sso-rw=tok_2');
    expect(buildWebSessionHeaders('grok-web', cookieEditorJson).Cookie).toBe('sso=tok_1; sso-rw=tok_2');
  });

  it('routes /images/generations and /images/edits across codex, fal-ai, black-forest-labs, stability-ai, cloudflare-ai, huggingface, and multipart upload', async () => {
    createApiKeyAccount({
      provider: 'codex',
      key: JSON.stringify({ kind: 'codex', accessToken: 'cx-oat', refreshToken: 'cx-ref', accountId: 'acct_cx', expiresAt: Date.now() + 3_600_000 }),
      label: 'Codex Img',
      authMethod: 'oauth_pkce',
      models: [{ id: 'gpt-image-1.5', name: 'GPT Image 1.5' }],
    });
    createApiKeyAccount({
      provider: 'fal-ai',
      key: 'fal-secret',
      label: 'Fal Img',
      models: [{ id: 'fal-ai/flux/dev', name: 'Flux Dev' }],
    });
    createApiKeyAccount({
      provider: 'black-forest-labs',
      key: 'bfl-secret',
      label: 'BFL Img',
      models: [{ id: 'flux-pro-1.1', name: 'Flux Pro 1.1' }],
    });
    createApiKeyAccount({
      provider: 'stability-ai',
      key: 'stab-secret',
      label: 'Stability Img',
      models: [{ id: 'sd3.5-large', name: 'SD 3.5' }],
    });
    createApiKeyAccount({
      provider: 'huggingface',
      key: 'hf-secret',
      label: 'HF Img',
      models: [{ id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX Schnell' }],
    });
    createApiKeyAccount({
      provider: 'openai',
      key: 'oa-img-key',
      label: 'OpenAI Img',
      models: [{ id: 'gpt-image-1', name: 'GPT Image 1' }],
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      if (url === 'https://chatgpt.com/backend-api/codex/images/generations') {
        const hdrs = new Headers(init?.headers);
        expect(hdrs.get('originator')).toBe('codex_cli_rs');
        expect(hdrs.get('ChatGPT-Account-Id')).toBe('acct_cx');
        return new Response(JSON.stringify({ data: [{ b64_json: 'Y29kZXg=' }] }), { status: 200 });
      }
      if (url === 'https://chatgpt.com/backend-api/codex/images/edits') {
        const body = JSON.parse(String(init?.body)) as { images: Array<{ image_url: string }> };
        expect(body.images[0]?.image_url).toContain('data:image/png;base64,');
        return new Response(JSON.stringify({ data: [{ b64_json: 'ZWRpdGVk' }] }), { status: 200 });
      }
      if (url === 'https://queue.fal.run/fal-ai/flux/dev') {
        return new Response(JSON.stringify({ status_url: 'https://queue.fal.run/status/1', response_url: 'https://queue.fal.run/resp/1' }), { status: 200 });
      }
      if (url === 'https://queue.fal.run/status/1') {
        return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200 });
      }
      if (url === 'https://queue.fal.run/resp/1') {
        return new Response(JSON.stringify({ images: [{ url: 'https://cdn.fal.test/out.png' }] }), { status: 200 });
      }
      if (url === 'https://api.bfl.ai/v1/flux-pro-1.1') {
        return new Response(JSON.stringify({ polling_url: 'https://api.bfl.ai/poll/42' }), { status: 200 });
      }
      if (url === 'https://api.bfl.ai/poll/42') {
        return new Response(JSON.stringify({ status: 'Ready', result: { sample: 'https://cdn.bfl.test/flux.png' } }), { status: 200 });
      }
      if (url === 'https://api.stability.ai/v2beta/stable-image/generate/sd3') {
        return new Response(JSON.stringify({ image: 'c3RhYg==' }), { status: 200 });
      }
      if (url === 'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell') {
        return new Response(Uint8Array.from([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      if (url.endsWith('/images/edits')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.oa.test/edit.png' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    const cxGen = await gatewayPost('/images/generations', { model: 'codex/gpt-image-1.5', prompt: 'astronaut' });
    expect(cxGen.status).toBe(200);
    expect(((await cxGen.json()) as any).data[0].b64_json).toBe('Y29kZXg=');

    const cxEdit = await gatewayPost('/images/edits', {
      model: 'codex/gpt-image-1.5',
      prompt: 'add hat',
      image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAY=',
    });
    expect(cxEdit.status).toBe(200);
    expect(((await cxEdit.json()) as any).data[0].b64_json).toBe('ZWRpdGVk');

    const fal = await gatewayPost('/images/generations', { model: 'fal-ai/fal-ai/flux/dev', prompt: 'cat' });
    expect(fal.status).toBe(200);
    expect(((await fal.json()) as any).data[0].url).toBe('https://cdn.fal.test/out.png');

    const bfl = await gatewayPost('/images/generations', { model: 'black-forest-labs/flux-pro-1.1', prompt: 'dog', size: '1024x1024' });
    expect(bfl.status).toBe(200);
    expect(((await bfl.json()) as any).data[0].url).toBe('https://cdn.bfl.test/flux.png');

    const stab = await gatewayPost('/images/generations', { model: 'stability-ai/sd3.5-large', prompt: 'tree' });
    expect(stab.status).toBe(200);
    expect(((await stab.json()) as any).data[0].b64_json).toBe('c3RhYg==');

    const hf = await gatewayPost('/images/generations', { model: 'huggingface/black-forest-labs/FLUX.1-schnell', prompt: 'sunset' });
    expect(hf.status, await hf.clone().text()).toBe(200);
    expect(((await hf.json()) as any).data[0].b64_json).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'));

    const form = new FormData();
    form.append('model', 'openai/gpt-image-1');
    form.append('prompt', 'add clouds');
    form.append('image', new Blob([Uint8Array.from([1, 2, 3])], { type: 'image/png' }), 'tiny.png');
    const mpEdit = await gatewayPost('/images/edits', form, true);
    expect(mpEdit.status).toBe(200);
    expect(((await mpEdit.json()) as any).data[0].url).toBe('https://cdn.oa.test/edit.png');
  });

  it('handles STT, TTS, Embeddings, Vertex/OpenRouter Video, and Search adapters + credentialFallback', async () => {
    createApiKeyAccount({
      provider: 'deepgram',
      key: 'dg-key',
      label: 'Deepgram',
      models: [{ id: 'nova-2', name: 'Nova 2' }, { id: 'aura-asteria-en', name: 'Asteria' }],
    });
    createApiKeyAccount({
      provider: 'gemini',
      key: 'gem-key',
      label: 'Gemini Media',
      models: [
        { id: 'gemini-embedding-001', name: 'Gemini Embed' },
        { id: 'gemini-2.5-flash-preview-tts', name: 'Gemini TTS' },
      ],
    });
    createApiKeyAccount({
      provider: 'xiaomi-mimo',
      key: 'mimo-key',
      label: 'MiMo TTS',
      models: [{ id: 'mimo-v2.5-tts', name: 'MiMo TTS' }],
    });
    createApiKeyAccount({
      provider: 'selfhosted-embedding',
      key: 'no-auth',
      label: 'SelfHosted Embed Missing',
      models: [{ id: 'nomic-embed-text', name: 'Nomic' }],
    });

    createApiKeyAccount({
      provider: 'vertex',
      key: JSON.stringify({ accessToken: 'vx-tok', projectId: 'proj-1', location: 'us-central1' }),
      label: 'Vertex Video',
      models: [{ id: 'veo-3.1-generate-preview', name: 'Veo 3.1' }],
    });
    createApiKeyAccount({
      provider: 'openrouter',
      key: 'or-vid-key',
      label: 'OR Video',
      models: [{ id: 'veo-2', name: 'Veo 2' }],
    });

    createApiKeyAccount({ provider: 'tavily', key: 'tvly-1', label: 'Tavily Fail', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({ provider: 'brave-search', key: 'brv-1', label: 'Brave Backup', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({ provider: 'tinyfish', key: 'tf-1', label: 'TinyFish', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({ provider: 'xquik', key: 'xq-1', label: 'Xquik', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({ provider: 'ollama-search', key: 'no-auth', label: 'Ollama Search', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({ provider: 'glm', key: 'glm-1', label: 'GLM Search', models: [{ id: 'default', name: 'Default' }] });
    createApiKeyAccount({
      provider: 'searxng',
      key: 'no-auth',
      label: 'SearXNG Local',
      baseUrl: 'https://93.184.216.34',
      models: [{ id: 'default', name: 'Default' }],
    });

    const seenTargets: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      seenTargets.push(url);

      if (url.startsWith('https://api.deepgram.com/v1/listen')) {
        return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'hello dg' }] }] } }), { status: 200 });
      }
      if (url.includes(':generateContent?key=gem-key')) {
        const pcm = Buffer.alloc(16, 1).toString('base64');
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/L16' } }] } }] }), { status: 200 });
      }
      if (url === 'https://api.xiaomimimo.com/v1/chat/completions') {
        return new Response(JSON.stringify({ choices: [{ message: { audio: { data: Buffer.from('RIFFmimo').toString('base64'), format: 'wav' } } }] }), { status: 200 });
      }
      if (url.includes(':embedContent?key=gem-key')) {
        return new Response(JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }), { status: 200 });
      }
      if (url.includes('aiplatform.googleapis.com') && url.endsWith(':predictLongRunning')) {
        return new Response(JSON.stringify({ name: 'projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-generate-preview/operations/op-77' }), { status: 200 });
      }
      if (url.includes('aiplatform.googleapis.com') && url.endsWith(':fetchPredictOperation')) {
        return new Response(JSON.stringify({
          name: 'projects/proj-1/locations/us-central1/publishers/google/models/veo-3.1-generate-preview/operations/op-77',
          done: true,
          response: { videos: [{ gcsUri: 'gs://bucket/veo.mp4', mimeType: 'video/mp4' }] },
        }), { status: 200 });
      }
      if (url === 'https://api.tavily.com/search') {
        return new Response('rate limited', { status: 429 });
      }
      if (url.startsWith('https://api.search.brave.com/res/v1/web/search')) {
        return new Response(JSON.stringify({ web: { results: [{ title: 'Brave Hit', url: 'https://brave.test', description: 'Fallback hit' }] } }), { status: 200 });
      }
      if (url.startsWith('https://api.tinyfish.ai/v1/search')) {
        return new Response(JSON.stringify({ results: [{ title: 'TF Hit', url: 'https://tf.test', snippet: 'tf snippet' }] }), { status: 200 });
      }
      if (url.startsWith('https://api.xquik.com/api/v1/x/tweets/search')) {
        return new Response(JSON.stringify({ tweets: [{ id: '999', text: 'tweet body', author: { username: 'dev' } }] }), { status: 200 });
      }
      if (url === 'https://ollama.com/api/web_search') {
        return new Response(JSON.stringify({ results: [{ title: 'Ollama Hit', url: 'https://ollama.test', content: 'ol snippet' }] }), { status: 200 });
      }
      if (url === 'https://api.z.ai/api/mcp/web_search_prime/mcp') {
        return new Response(JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify([{ title: 'GLM Hit', link: 'https://glm.test', content: 'glm snippet' }]) }] } }), { status: 200 });
      }
      if (url.startsWith('https://93.184.216.34/search')) {
        expect(new Headers(init?.headers).get('authorization')).toBeNull();
        return new Response(JSON.stringify({ results: [{ title: 'SX Hit', url: 'https://sx.test', content: 'sx snippet' }] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });

    // STT deepgram
    const sttForm = new FormData();
    sttForm.append('model', 'deepgram/nova-2');
    sttForm.append('file', new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'audio/wav' }), 'test.wav');
    const sttRes = await gatewayPost('/audio/transcriptions', sttForm, true);
    expect(sttRes.status).toBe(200);
    expect(((await sttRes.json()) as any).text).toBe('hello dg');

    // TTS gemini WAV header + xiaomi-mimo
    const gemTts = await gatewayPost('/audio/speech', { model: 'gemini/gemini-2.5-flash-preview-tts', input: 'Hello world' });
    expect(gemTts.status).toBe(200);
    const wavBuf = Buffer.from(await gemTts.arrayBuffer());
    expect(wavBuf.subarray(0, 4).toString('ascii')).toBe('RIFF');

    const mimoTts = await gatewayPost('/audio/speech', { model: 'xiaomi-mimo/mimo-v2.5-tts', input: 'Ni hao' });
    expect(mimoTts.status).toBe(200);

    // Embeddings: Gemini + selfhosted missing baseUrl -> 400 with 0 api.openai.com requests
    const gemEmb = await gatewayPost('/embeddings', { model: 'gemini/gemini-embedding-001', input: 'vector' });
    expect(gemEmb.status).toBe(200);
    expect(((await gemEmb.json()) as any).data[0].embedding).toEqual([0.1, 0.2, 0.3]);

    const shFail = await gatewayPost('/embeddings', { model: 'selfhosted-embedding/nomic-embed-text', input: 'vector' });
    expect(shFail.status).toBe(400);
    expect(seenTargets.some(u => u.includes('api.openai.com'))).toBe(false);

    // Video: Vertex create + poll, invalid job id rejected, OpenRouter edits rejected
    const vxCreate = await gatewayPost('/videos/generations', { model: 'vertex/veo-3.1-generate-preview', prompt: 'ocean waves' });
    expect(vxCreate.status).toBe(200);
    const vxJob = (await vxCreate.json()) as { id: string; status: string };
    expect(vxJob.status).toBe('pending');
    const vxPoll = await gatewayGet(`/videos/${vxJob.id}?model=vertex/veo-3.1-generate-preview`);
    expect(vxPoll.status).toBe(200);
    expect(((await vxPoll.json()) as any).videos[0].url).toBe('gs://bucket/veo.mp4');

    const vxBad = await gatewayGet('/videos/invalid_job!id?model=vertex/veo-3.1-generate-preview&provider=vertex');
    expect(vxBad.status).toBe(400);

    const orEdit = await gatewayPost('/videos/edits', { model: 'openrouter/veo-2', prompt: 'edit me' });
    expect(orEdit.status).toBe(400);

    // Search adapters + credentialFallback (Tavily 429 -> Brave)
    const fallbackSearch = await gatewayPost('/search', { query: 'test fallback', model: 'tavily/default' });
    expect(fallbackSearch.status).toBe(200);
    expect(((await fallbackSearch.json()) as any).provider).toBe('brave-search');

    for (const [model, expectedProvider] of [
      ['tinyfish/default', 'tinyfish'],
      ['xquik/default', 'xquik'],
      ['ollama-search/default', 'ollama-search'],
      ['glm/default', 'glm'],
      ['searxng/default', 'searxng'],
    ] as const) {
      const r = await gatewayPost('/search', { query: 'query', model });
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).provider).toBe(expectedProvider);
    }
  });
});
