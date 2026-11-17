import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { looksLikeCookieHeader } from '../../custom/provider-accounts/cookie-format.js';
import {
  clearGeminiWebCaches,
  extractGeminiImages,
  extractGeminiSessionTokens,
  extractGeminiStreamText,
  mergeResponseCookies,
  normalizeGeminiWebCookie,
  rotateGeminiCookies,
  streamGeminiWebChat,
  stripGeminiPlaceholders,
  validateGeminiWebSession,
} from '../../custom/provider-accounts/gemini-web-chat.js';
import { rotateGeminiWebAccountsOnce } from '../../custom/provider-accounts/gemini-web-keepalive.js';
import { resolveAccountProvider } from '../../custom/provider-accounts/execution.js';
import { accountRow, createApiKeyAccount } from '../../custom/provider-accounts/store.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';
import { readPlaygroundMedia } from '../../custom/x-gateway/playground-media.js';
import { initDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';

/** Minimal PNG payload; only the byte round-trip matters here. */
const IMAGE_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function streamFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

describe('gemini-web executor', () => {
  beforeEach(() => {
    // The image rewrite persists bytes, so every test gets its own database.
    clearGeminiWebCaches();
    initDb(':memory:');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes raw token, Cookie header, Cookie-Editor JSON, and storage-state JSON', () => {
    expect(normalizeGeminiWebCookie('g.a000token')).toBe('__Secure-1PSID=g.a000token');
    expect(normalizeGeminiWebCookie('Cookie: __Secure-1PSID=abc; __Secure-1PSIDTS=def')).toBe(
      '__Secure-1PSID=abc; __Secure-1PSIDTS=def',
    );
    expect(
      normalizeGeminiWebCookie(
        JSON.stringify([
          { name: '__Secure-1PSID', value: 'psid_val' },
          { name: '__Secure-1PSIDTS', value: 'psidts_val' },
        ]),
      ),
    ).toBe('__Secure-1PSID=psid_val; __Secure-1PSIDTS=psidts_val');
    expect(
      normalizeGeminiWebCookie(
        JSON.stringify({
          cookies: [{ name: '__Secure-1PSID', value: 'state_psid' }],
        }),
      ),
    ).toBe('__Secure-1PSID=state_psid');
    expect(() => normalizeGeminiWebCookie('   ')).toThrow(/empty/i);
  });

  it('extracts SNlM0e, cfb2h, and FdrFJe from Gemini /app HTML', () => {
    const html = `<script>window.WIZ_global_data = {"cfb2h":"boq_assistant-bard-web-server_20261114.00_p0","FdrFJe":"1234567890","SNlM0e":"AJv123:456"};</script>`;
    expect(extractGeminiSessionTokens(html)).toEqual({
      snlm0e: 'AJv123:456',
      cfb2h: 'boq_assistant-bard-web-server_20261114.00_p0',
      fdrfje: '1234567890',
    });
    expect(extractGeminiSessionTokens('<html><body>Sign in</body></html>')).toBeNull();
  });

  it('parses wrb.fr cumulative candidate chunks and RPC error frames', () => {
    expect(extractGeminiStreamText(")]}'")).toEqual({});
    expect(extractGeminiStreamText('1234')).toEqual({});

    const inner = JSON.stringify([null, null, null, null, [['rc_1', ['Xin chào']]]]);
    const frame = JSON.stringify([['wrb.fr', null, inner]]);
    expect(extractGeminiStreamText(frame)).toEqual({ text: 'Xin chào' });

    const errFrame = JSON.stringify([['wrb.fr', null, null, null, null, [16]]]);
    expect(extractGeminiStreamText(errFrame)).toEqual({ errorCode: 16 });
  });

  it('streams and completes gemini-web via /app -> StreamGenerate instead of /v1/chat/completions', async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);

      if (url === 'https://gemini.google.com/app') {
        return new Response(
          '<script>{"SNlM0e":"snl_tok_1","cfb2h":"boq_bl_1","FdrFJe":"998877"}</script>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }

      if (url.startsWith('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        const inner1 = JSON.stringify([null, null, null, null, [['rc_1', ['Xin chào']]]]);
        const inner2 = JSON.stringify([null, null, null, null, [['rc_1', ['Xin chào bạn!']]]]);
        return new Response(
          streamFromLines([
            ")]}'",
            '100',
            JSON.stringify([['wrb.fr', null, inner1]]),
            '120',
            JSON.stringify([['wrb.fr', null, inner2]]),
            '20',
            JSON.stringify([['di', 10]]),
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const deltas: string[] = [];
    let finishReason: string | null = null;
    for await (const chunk of provider.streamChatCompletion(
      '__Secure-1PSID=test_psid_stream',
      [{ role: 'user', content: 'Xin chào gemini' }],
      'gemini-3.1-pro',
    )) {
      if (chunk.choices[0]?.delta?.content) deltas.push(chunk.choices[0].delta.content);
      if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
    }

    expect(deltas).toEqual(['Xin chào', ' bạn!']);
    expect(finishReason).toBe('stop');
    expect(calls.some(u => u.includes('/v1/chat/completions'))).toBe(false);

    const completion = await provider.chatCompletion(
      '__Secure-1PSID=test_psid_stream',
      [{ role: 'user', content: 'Xin chào gemini' }],
      'gemini-3.1-pro',
    );
    expect(completion.choices[0]?.message?.content).toBe('Xin chào bạn!');
  });

  it('extracts generated images and strips googleusercontent placeholders', () => {
    const entry = [
      [null, null, null, [null, null, 'Argon', 'https://lh3.googleusercontent.com/gen-1']],
      ['image-id-1'],
    ];
    const candidate = [
      'rc_1',
      ['Đây là ảnh:\nhttp://googleusercontent.com/image_generation_content/0_973\n'],
      null, null, null, null, null, null, null, null, null, null,
      // rich content block: field 7 (generated images) holds [entries]
      [null, null, null, null, null, null, null, [[entry]]],
    ];
    const frame = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [candidate]])]]);

    const parsed = extractGeminiStreamText(frame);
    expect(parsed.text).toContain('http://googleusercontent.com');
    expect(parsed.images).toEqual([{ url: 'https://lh3.googleusercontent.com/gen-1', alt: 'Argon' }]);
    expect(stripGeminiPlaceholders(parsed.text ?? '')).toBe('Đây là ảnh:');
  });

  it('reads generated images from the sparse bundle key', () => {
    const entry = [[null, null, null, [null, null, '', 'https://lh3.googleusercontent.com/gen-2']], ['image-id-2']];
    const candidate = [
      'rc_1',
      [''],
      null, null, null, null, null, null, null, null, null, null,
      // richer fields land in the trailing dict, keyed by 1-based field number
      [null, { '8': [[entry]] }],
    ];
    expect(extractGeminiImages(candidate)).toEqual([{ url: 'https://lh3.googleusercontent.com/gen-2' }]);
    const frame = JSON.stringify([['wrb.fr', null, JSON.stringify([null, null, null, null, [candidate]])]]);

    expect(extractGeminiStreamText(frame).images).toEqual([
      { url: 'https://lh3.googleusercontent.com/gen-2' },
    ]);
  });

  it('returns the generated image as markdown instead of the placeholder link', async () => {
    const entry = [
      [null, null, null, [null, null, 'Argon', 'https://lh3.googleusercontent.com/gen-1']],
      ['image-id-1'],
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response(
          '<script>{"SNlM0e":"snl_tok_1","cfb2h":"boq_bl_1","FdrFJe":"998877"}</script>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      if (url.startsWith('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        const candidate = [
          'rc_1',
          ['Đây là ảnh:\nhttp://googleusercontent.com/image_generation_content/0_973\n'],
          null, null, null, null, null, null, null, null, null, null,
          [null, null, null, null, null, null, null, [[entry]]],
        ];
        const inner = JSON.stringify([null, null, null, null, [candidate]]);
        return new Response(
          streamFromLines([
            ")]}'",
            '100',
            JSON.stringify([['wrb.fr', null, inner]]),
            '20',
            JSON.stringify([['di', 10]]),
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      if (url === 'https://lh3.googleusercontent.com/gen-1') {
        return new Response(IMAGE_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const completion = await provider.chatCompletion(
      '__Secure-1PSID=test_psid_image',
      [{ role: 'user', content: 'Tạo cho tôi 1 bức ảnh về gemini' }],
      'gemini-image',
    );

    const content = completion.choices[0]?.message?.content ?? '';
    expect(content).not.toContain('http://googleusercontent.com');
    expect(content).toContain('Đây là ảnh:');
    const mediaUrl = /!\[Argon\]\((\/api\/thruline\/playground\/media\/[a-f0-9]{32})\)/.exec(content);
    expect(mediaUrl).not.toBeNull();
    const stored = readPlaygroundMedia(mediaUrl![1].split('/').pop()!);
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.bytes.equals(IMAGE_BYTES)).toBe(true);
  });

  it('accepts an image-only reply with no text', async () => {
    const entry = [[null, null, null, [null, null, '', 'https://lh3.googleusercontent.com/gen-3']], ['image-id-3']];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_tok_1"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.startsWith('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        const candidate = [
          'rc_1',
          ['http://googleusercontent.com/image_generation_content/0_1\n'],
          null, null, null, null, null, null, null, null, null, null,
          [null, null, null, null, null, null, null, [[entry]]],
        ];
        const inner = JSON.stringify([null, null, null, null, [candidate]]);
        return new Response(streamFromLines([")]}'", '90', JSON.stringify([['wrb.fr', null, inner]])]), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (url === 'https://lh3.googleusercontent.com/gen-3') {
        return new Response(IMAGE_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const completion = await provider.chatCompletion(
      '__Secure-1PSID=test_psid_image_only',
      [{ role: 'user', content: 'Tạo ảnh' }],
      'gemini-image',
    );
    const content = completion.choices[0]?.message?.content ?? '';
    expect(content).toMatch(/!\[Generated image\]\(\/api\/thruline\/playground\/media\/[a-f0-9]{32}\)/);
  });

  it('falls back to a plain link when the image cannot be downloaded', async () => {
    const entry = [
      [null, null, null, [null, null, 'Argon', 'https://lh3.googleusercontent.com/gen-9']],
      ['image-id-9'],
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_tok_1"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.startsWith('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        const candidate = [
          'rc_1',
          ['Đây là ảnh:\nhttp://googleusercontent.com/image_generation_content/0_9\n'],
          null, null, null, null, null, null, null, null, null, null,
          [null, null, null, null, null, null, null, [[entry]]],
        ];
        const inner = JSON.stringify([null, null, null, null, [candidate]]);
        return new Response(streamFromLines([")]}'", '90', JSON.stringify([['wrb.fr', null, inner]])]), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (url === 'https://lh3.googleusercontent.com/gen-9') {
        return new Response('nope', { status: 403 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const completion = await provider.chatCompletion(
      '__Secure-1PSID=test_psid_image_fail',
      [{ role: 'user', content: 'Tạo ảnh' }],
      'gemini-image',
    );
    const content = completion.choices[0]?.message?.content ?? '';
    expect(content).toContain('[Argon](https://lh3.googleusercontent.com/gen-9)');
    expect(content).not.toContain('/playground/media/');
  });

  it('throws 401 when Gemini /app redirects to accounts.google.com', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const res = new Response('<html>Sign in</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
      Object.defineProperty(res, 'url', { value: 'https://accounts.google.com/v3/signin' });
      return res;
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    await expect(
      provider.chatCompletion(
        '__Secure-1PSID=expired_psid',
        [{ role: 'user', content: 'Xin chào' }],
        'gemini-3.1-pro',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('uploads base64 images to content-push and attaches them in StreamGenerate', async () => {
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let capturedFreq = '';

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url.startsWith('https://gemini.google.com/app')) {
        return new Response(
          '"SNlM0e":"csrf_img_token","cfb2h":"bl_img","FdrFJe":"sid_img"',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }

      if (url === 'https://push.clients6.google.com/upload/') {
        expect(init?.method).toBe('POST');
        return new Response('/contrib_service/ttl_1d/uploaded_img_1.png', { status: 200 });
      }

      if (url.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        capturedFreq = new URLSearchParams(String(init?.body ?? '')).get('f.req') ?? '';
        const frame = [null, ['c_1', 'r_1'], null, null, [['rc_1', ['Đây là ảnh 1x1 pixel.']]]];
        const payload = JSON.stringify([['wrb.fr', null, JSON.stringify(frame)]]);
        return new Response(
          `)]}'\n\n${payload.length}\n${payload}\n`,
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const completion = await provider.chatCompletion(
      '__Secure-1PSID=test_psid_img',
      [{
        role: 'user',
        content: [
          { type: 'text', text: 'Mô tả ảnh' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${pngBase64}` } },
        ],
      }],
      'gemini-3.1-pro',
    );

    expect(completion.choices[0]?.message?.content).toBe('Đây là ảnh 1x1 pixel.');
    const outer = JSON.parse(capturedFreq) as [null, string];
    const inner = JSON.parse(outer[1]) as unknown[];
    expect(inner[0]).toEqual([
      'Mô tả ảnh',
      0,
      null,
      [[['/contrib_service/ttl_1d/uploaded_img_1.png', 1], 'image-1.png']],
    ]);
  });

  it('auto-rotates __Secure-1PSIDTS via RotateCookies when /app omits SNlM0e and persists the new cookie', async () => {
    let appCalls = 0;
    let rotateCalls = 0;
    const seenStreamCookies: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const cookie = new Headers(init?.headers).get('cookie') ?? '';

      if (url === 'https://gemini.google.com/app') {
        appCalls++;
        if (appCalls === 1) {
          // Stale __Secure-1PSIDTS: /app loads without SNlM0e.
          return new Response('<html><body>Sign in</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        expect(cookie).toContain('__Secure-1PSIDTS=fresh_ts_2');
        return new Response(
          '<script>{"SNlM0e":"snl_rotated","cfb2h":"boq_bl_2","FdrFJe":"554433"}</script>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }

      if (url === 'https://accounts.google.com/RotateCookies') {
        rotateCalls++;
        expect(cookie).toContain('__Secure-1PSID=psid_keep');
        return new Response(')]}\'\n[1]', {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Set-Cookie': '__Secure-1PSIDTS=fresh_ts_2; Path=/; HttpOnly; Secure',
          },
        });
      }

      if (url.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        seenStreamCookies.push(cookie);
        const frame = [null, ['c_1', 'r_1'], null, null, [['rc_1', ['Xoay cookie thành công!']]]];
        const payload = JSON.stringify([['wrb.fr', null, JSON.stringify(frame)]]);
        return new Response(
          `)]}'\n\n${payload.length}\n${payload}\n`,
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const persisted: string[] = [];
    const completion = await provider.chatCompletion(
      '__Secure-1PSID=psid_keep; __Secure-1PSIDTS=stale_ts_1',
      [{ role: 'user', content: 'ping' }],
      'auto',
      {
        onCredentialUpdate: next => persisted.push(next),
      },
    );

    expect(completion.choices[0]?.message?.content).toBe('Xoay cookie thành công!');
    expect(appCalls).toBe(2);
    expect(rotateCalls).toBe(1);
    expect(seenStreamCookies[0]).toContain('__Secure-1PSIDTS=fresh_ts_2');
    expect(persisted).toEqual(['__Secure-1PSID=psid_keep; __Secure-1PSIDTS=fresh_ts_2']);
  });

  it('recovers from StreamGenerate RPC error 16 by rotating cookies and retrying once', async () => {
    let streamCalls = 0;
    let rotateCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const cookie = new Headers(init?.headers).get('cookie') ?? '';

      if (url === 'https://gemini.google.com/app') {
        const snl = cookie.includes('ts_new') ? 'snl_fresh' : 'snl_old';
        return new Response(
          `<script>{"SNlM0e":"${snl}","cfb2h":"boq_bl","FdrFJe":"112233"}</script>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }

      if (url === 'https://accounts.google.com/RotateCookies') {
        rotateCalls++;
        return new Response(')]}\'\n[1]', {
          status: 200,
          headers: {
            'Set-Cookie': '__Secure-1PSIDTS=ts_new; Path=/; Secure',
          },
        });
      }

      if (url.includes('/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate')) {
        streamCalls++;
        if (streamCalls === 1) {
          const errPayload = JSON.stringify([['wrb.fr', null, null, null, null, [16]]]);
          return new Response(
            `)]}'\n\n${errPayload.length}\n${errPayload}\n`,
            { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
          );
        }
        expect(cookie).toContain('__Secure-1PSIDTS=ts_new');
        const okFrame = [null, ['c_1', 'r_1'], null, null, [['rc_1', ['Đã khôi phục phiên!']]]];
        const okPayload = JSON.stringify([['wrb.fr', null, JSON.stringify(okFrame)]]);
        return new Response(
          `)]}'\n\n${okPayload.length}\n${okPayload}\n`,
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const persisted: string[] = [];
    const completion = await provider.chatCompletion(
      '__Secure-1PSID=psid_rpc; __Secure-1PSIDTS=ts_old',
      [{ role: 'user', content: 'hello' }],
      'auto',
      { onCredentialUpdate: next => persisted.push(next) },
    );

    expect(completion.choices[0]?.message?.content).toBe('Đã khôi phục phiên!');
    expect(streamCalls).toBe(2);
    expect(rotateCalls).toBe(1);
    expect(persisted).toEqual(['__Secure-1PSID=psid_rpc; __Secure-1PSIDTS=ts_new']);
  });

  it('background keep-alive rotates enabled gemini-web accounts and persists updated cookies', async () => {
    const id = createApiKeyAccount({
      provider: 'gemini-web',
      label: 'My Gemini Web',
      key: '__Secure-1PSID=bg_psid; __Secure-1PSIDTS=bg_ts_1',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://accounts.google.com/RotateCookies') {
        return new Response(')]}\'\n[1]', {
          status: 200,
          headers: {
            'Set-Cookie': '__Secure-1PSIDTS=bg_ts_2; Path=/; Secure',
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const count = await rotateGeminiWebAccountsOnce();
    expect(count).toBe(1);

    const updated = accountRow(id);
    const decrypted = decrypt(updated.encrypted_key, updated.iv, updated.auth_tag);
    expect(decrypted).toBe('__Secure-1PSID=bg_psid; __Secure-1PSIDTS=bg_ts_2');
  });

  it('validateKey probes gemini-web /app, rotates stale cookies with Origin/Referer, and persists updated cookie', async () => {
    const id = createApiKeyAccount({
      provider: 'gemini-web',
      label: 'My Gemini Validate',
      key: '__Secure-1PSID=val_psid; __Secure-1PSIDTS=val_ts_1',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      if (url === 'https://gemini.google.com/app') {
        const cookie = headers.get('Cookie') ?? '';
        if (cookie.includes('__Secure-1PSIDTS=val_ts_2')) {
          return new Response('<script>{"SNlM0e":"snl_ok"}</script>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('<html>Sign in</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url === 'https://accounts.google.com/RotateCookies') {
        expect(headers.get('Origin')).toBe('https://accounts.google.com');
        expect(headers.get('Referer')).toBe('https://accounts.google.com/');
        return new Response(')]}\'\n[1]', {
          status: 200,
          headers: {
            'Set-Cookie': '__Secure-1PSIDTS=val_ts_2; Path=/; Secure',
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const row = accountRow(id);
    const provider = resolveAccountProvider(row);
    expect(provider).toBeDefined();
    const res = await provider!.validateKey('');
    expect(res).toBe(true);

    const updated = accountRow(id);
    const decrypted = decrypt(updated.encrypted_key, updated.iv, updated.auth_tag);
    expect(decrypted).toBe('__Secure-1PSID=val_psid; __Secure-1PSIDTS=val_ts_2');
  });

  it('validateKey returns invalid when gemini-web /app lacks SNlM0e even after RotateCookies', async () => {
    const id = createApiKeyAccount({
      provider: 'gemini-web',
      label: 'My Gemini Expired',
      key: '__Secure-1PSID=dead_psid; __Secure-1PSIDTS=dead_ts',
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<html>Sign in</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url === 'https://accounts.google.com/RotateCookies') {
        return new Response('Unauthorized', { status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const row = accountRow(id);
    const provider = resolveAccountProvider(row);
    expect(provider).toBeDefined();
    const res = await provider!.validateKey('');
    expect(res).toEqual({
      valid: false,
      error: expect.stringContaining('SNlM0e'),
    });
  });

  it('coalesces concurrent /app fetches and skips /app on warm turns', async () => {
    let appCalls = 0;
    let streamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        appCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        return new Response(
          '<script>{"SNlM0e":"snl_coalesced","cfb2h":"boq_bl_1","FdrFJe":"112233"}</script>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      if (url.includes('StreamGenerate')) {
        streamCalls += 1;
        const inner = JSON.stringify([null, null, null, null, [['rc_1', [`Reply ${streamCalls}`]]]]);
        return new Response(
          streamFromLines([")]}'", '80', JSON.stringify([['wrb.fr', null, inner]])]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    const [res1, res2] = await Promise.all([
      provider.chatCompletion('__Secure-1PSID=coalesce_psid', [{ role: 'user', content: 'Hi 1' }], 'gemini-3.1-pro'),
      provider.chatCompletion('__Secure-1PSID=coalesce_psid', [{ role: 'user', content: 'Hi 2' }], 'gemini-3.1-pro'),
    ]);
    expect(appCalls).toBe(1);
    expect(streamCalls).toBe(2);
    expect(res1.choices[0]?.message?.content).toMatch(/^Reply /);
    expect(res2.choices[0]?.message?.content).toMatch(/^Reply /);

    const res3 = await provider.chatCompletion(
      '__Secure-1PSID=coalesce_psid',
      [{ role: 'user', content: 'Hi 3' }],
      'gemini-3.1-pro',
    );
    expect(appCalls).toBe(1);
    expect(streamCalls).toBe(3);
    expect(res3.choices[0]?.message?.content).toBe('Reply 3');
  });

  it('invalidates cached /app tokens and retries once on auth/bootstrap error', async () => {
    let appCalls = 0;
    const seenAtTokens: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        appCalls += 1;
        const tok = appCalls === 1 ? 'snl_stale' : 'snl_fresh';
        return new Response(
          `<script>{"SNlM0e":"${tok}","cfb2h":"boq_bl_${appCalls}","FdrFJe":"9988"}</script>`,
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        );
      }
      if (url.includes('StreamGenerate')) {
        const at = new URLSearchParams(String(init?.body ?? '')).get('at') ?? '';
        seenAtTokens.push(at);
        if (at === 'snl_stale' && seenAtTokens.length === 2) {
          return new Response('Bad Request', { status: 400 });
        }
        const inner = JSON.stringify([null, null, null, null, [['rc_1', [`ok:${at}`]]]]);
        return new Response(
          streamFromLines([")]}'", '80', JSON.stringify([['wrb.fr', null, inner]])]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new WebCookieProvider({
      providerId: 'gemini-web',
      name: 'Gemini Web',
      baseUrl: 'https://gemini.google.com/app',
    });

    // Warm the cache on turn 1
    const first = await provider.chatCompletion(
      '__Secure-1PSID=retry_psid',
      [{ role: 'user', content: 'Turn 1' }],
      'gemini-3.1-pro',
    );
    expect(first.choices[0]?.message?.content).toBe('ok:snl_stale');
    expect(appCalls).toBe(1);

    // Turn 2 hits 400 with stale cached token, refreshes /app once, and retries with snl_fresh
    const second = await provider.chatCompletion(
      '__Secure-1PSID=retry_psid',
      [{ role: 'user', content: 'Turn 2' }],
      'gemini-3.1-pro',
    );
    expect(second.choices[0]?.message?.content).toBe('ok:snl_fresh');
    expect(appCalls).toBe(2);
    expect(seenAtTokens).toEqual(['snl_stale', 'snl_stale', 'snl_fresh']);
  });

  it('fails fast on StreamGenerate stall and respects caller abort signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_stall"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.includes('StreamGenerate')) {
        const encoder = new TextEncoder();
        const inner1 = JSON.stringify([null, null, null, null, [['rc_1', ['Partial']]]]);
        const hangingStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify([['wrb.fr', null, inner1]])}\n`));
            // Never closes -> stalls on second read
          },
        });
        return new Response(hangingStream, {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const deltas: string[] = [];
    await expect(async () => {
      for await (const delta of streamGeminiWebChat({
        credential: '__Secure-1PSID=stall_psid',
        messages: [{ role: 'user', content: 'Hang mid-stream' }],
        modelId: 'gemini-3.1-pro',
        options: { timeoutMs: 250 },
      })) {
        if (delta.content) deltas.push(delta.content);
      }
    }).rejects.toMatchObject({ status: 504 });
    expect(deltas).toEqual(['Partial']);

    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('client cancelled')), 30);
    await expect(async () => {
      for await (const _delta of streamGeminiWebChat({
        credential: '__Secure-1PSID=stall_psid',
        messages: [{ role: 'user', content: 'Abort mid-stream' }],
        modelId: 'gemini-3.1-pro',
        options: { signal: abortController.signal, timeoutMs: 5_000 },
      })) {
        // drain
      }
    }).rejects.toThrow(/client cancelled|abort/i);
  });

  it('bounds slow image fetches on text models and falls back to markdown link', async () => {
    const entry = [
      [null, null, null, [null, null, 'Chart', 'https://lh3.googleusercontent.com/slow-img']],
      ['image-id-slow'],
    ];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_img_fast"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.includes('StreamGenerate')) {
        const candidate = [
          'rc_1',
          ['Here is your answer:\nhttp://googleusercontent.com/image_generation_content/0_1\n'],
          null, null, null, null, null, null, null, null, null, null,
          [null, null, null, null, null, null, null, [[entry]]],
        ];
        const inner = JSON.stringify([null, null, null, null, [candidate]]);
        return new Response(streamFromLines([")]}'", '90', JSON.stringify([['wrb.fr', null, inner]])]), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
      if (url === 'https://lh3.googleusercontent.com/slow-img') {
        // Hang until signal aborts
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const deltas: string[] = [];
    for await (const delta of streamGeminiWebChat({
      credential: '__Secure-1PSID=slow_img_psid',
      messages: [{ role: 'user', content: 'Explain charts' }],
      modelId: 'gemini-3.1-flash-lite',
      options: { timeoutMs: 120 },
    })) {
      if (delta.content) deltas.push(delta.content);
    }

    expect(deltas[0]).toBe('Here is your answer:');
    expect(deltas[1]).toContain('[Chart](https://lh3.googleusercontent.com/slow-img)');
  });

  it('rejects bare tokens with dots and trailing = in looksLikeCookieHeader and wraps them cleanly', () => {
    expect(looksLikeCookieHeader('g.a000qAg-xyz.123=')).toBe(false);
    expect(looksLikeCookieHeader('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ==')).toBe(false);
    expect(looksLikeCookieHeader('__Secure-1PSID=g.a000qAg-xyz.123=')).toBe(true);
    expect(normalizeGeminiWebCookie('g.a000qAg-xyz.123=')).toBe('__Secure-1PSID=g.a000qAg-xyz.123=');
  });

  it('parses key-value JSON maps, filters Google domains/expiry, deduplicates, and strips newlines', () => {
    expect(
      normalizeGeminiWebCookie(
        JSON.stringify({
          __Secure_1PSID: 'ignore_wrong_name',
          '__Secure-1PSID': 'map_psid',
          '__Secure-1PSIDTS': 'map_ts',
        }),
      ),
    ).toBe('__Secure_1PSID=ignore_wrong_name; __Secure-1PSID=map_psid; __Secure-1PSIDTS=map_ts');

    const nowSec = Math.floor(Date.now() / 1000);
    const filtered = normalizeGeminiWebCookie(
      JSON.stringify([
        { name: '__Secure-1PSID', value: 'expired_but_kept\r\n', domain: '.google.com', expirationDate: 1_000 },
        { name: '__Secure-1PSIDTS', value: 'expired_ts', domain: '.google.com', expirationDate: 1_000 },
        { name: 'session', value: 'third_party', domain: '.chatgpt.com', expirationDate: nowSec + 3600 },
        { name: 'SIDCC', value: 'broad_sidcc', domain: '.google.com', expirationDate: nowSec + 3600 },
        { name: 'SIDCC', value: 'specific_sidcc', domain: 'gemini.google.com', expirationDate: nowSec + 3600 },
        { name: 'NID', value: 'first_nid', domain: '.google.com' },
        { name: 'NID', value: 'last_nid', domain: '.google.com' },
        { name: 'HSID', value: 'session_hsid', domain: 'accounts.google.com', expires: -1 },
      ]),
    );

    expect(filtered).toBe('__Secure-1PSID=expired_but_kept; SIDCC=specific_sidcc; NID=last_nid; HSID=session_hsid');
    expect(() => new Headers({ Cookie: filtered })).not.toThrow();

    expect(normalizeGeminiWebCookie('Cookie: __Secure-1PSID=old\r\n; __Secure-1PSID=new; SIDCC=s1')).toBe(
      '__Secure-1PSID=new; SIDCC=s1',
    );
  });

  it('extracts SNlM0e across whitespace, single-quoted, and escaped HTML variants', () => {
    expect(extractGeminiSessionTokens(`{"SNlM0e" : "tok_ws", "cfb2h" : "bl_ws"}`)).toEqual({
      snlm0e: 'tok_ws',
      cfb2h: 'bl_ws',
      fdrfje: undefined,
    });
    expect(extractGeminiSessionTokens(`{'SNlM0e': 'tok_sq', 'FdrFJe': 'sid_sq'}`)).toEqual({
      snlm0e: 'tok_sq',
      cfb2h: undefined,
      fdrfje: 'sid_sq',
    });
    expect(extractGeminiSessionTokens(`\\"SNlM0e\\":\\"tok_esc\\"`)).toEqual({
      snlm0e: 'tok_esc',
      cfb2h: undefined,
      fdrfje: undefined,
    });
  });

  it('parses comma-joined Set-Cookie with Expires commas and captures per-hop redirect cookies', async () => {
    const merged = mergeResponseCookies(
      '__Secure-1PSID=p1; __Secure-1PSIDTS=old_ts',
      new Response(null, {
        headers: {
          'Set-Cookie': '__Secure-1PSIDTS=new_ts; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; Secure, SIDCC=new_sidcc; Path=/',
        },
      }),
    );
    expect(merged).toEqual({
      nextHeader: '__Secure-1PSID=p1; __Secure-1PSIDTS=new_ts; SIDCC=new_sidcc',
      changed: true,
    });

    const updates: string[] = [];
    let streamCookieHeader = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://accounts.google.com/RotateCookies') {
        return new Response('[]', {
          status: 200,
          headers: {
            'Set-Cookie': '__Secure-1PSIDTS=rotated_ts_1; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; Secure, SIDCC=rot_sidcc; Path=/',
          },
        });
      }
      if (url === 'https://gemini.google.com/app') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/u/0/app',
            'Set-Cookie': '__Secure-1PSIDCC=hop_cc_1; Path=/; Secure',
          },
        });
      }
      if (url === 'https://gemini.google.com/u/0/app') {
        expect(new Headers(init?.headers).get('cookie')).toContain('__Secure-1PSIDCC=hop_cc_1');
        return new Response('<script>{"SNlM0e":"snl_redir_ok","cfb2h":"bl_r","FdrFJe":"sid_r"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.includes('StreamGenerate')) {
        streamCookieHeader = new Headers(init?.headers).get('cookie') ?? '';
        const inner = JSON.stringify([null, null, null, null, [['rc_1', ['Hello rotated!']]]]);
        const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
        headers.append('Set-Cookie', '__Secure-1PSIDTS=stream_ts_2; Path=/; Secure');
        return new Response(
          streamFromLines([")]}'", '80', JSON.stringify([['wrb.fr', null, inner]])]),
          { status: 200, headers },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const deltas: string[] = [];
    for await (const delta of streamGeminiWebChat({
      credential: '__Secure-1PSID=psid_rot_flow',
      messages: [{ role: 'user', content: 'Hi' }],
      modelId: 'gemini-3.1-pro',
      options: { onCredentialUpdate: (next) => updates.push(next) },
    })) {
      if (delta.content) deltas.push(delta.content);
    }

    expect(deltas).toEqual(['Hello rotated!']);
    expect(streamCookieHeader).toContain('__Secure-1PSIDTS=rotated_ts_1');
    expect(streamCookieHeader).toContain('__Secure-1PSIDCC=hop_cc_1');
    expect(updates).toHaveLength(3);
    expect(updates[0]).toContain('__Secure-1PSIDTS=rotated_ts_1');
    expect(updates[0]).toContain('SIDCC=rot_sidcc');
    expect(updates[1]).toContain('__Secure-1PSIDCC=hop_cc_1');
    expect(updates[2]).toContain('__Secure-1PSIDTS=stream_ts_2');
  });

  it('proactively rotates cookies after 9-minute cooldown and coalesces concurrent RotateCookies calls', async () => {
    let rotateCalls = 0;
    let fakeNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://accounts.google.com/RotateCookies') {
        rotateCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 15));
        const headers = new Headers();
        headers.append('Set-Cookie', `__Secure-1PSIDTS=ts_round_${rotateCalls}; Path=/; Secure`);
        return new Response('[]', { status: 200, headers });
      }
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_proactive"}</script>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.includes('StreamGenerate')) {
        const inner = JSON.stringify([null, null, null, null, [['rc_1', ['ok']]]]);
        return new Response(
          streamFromLines([")]}'", '80', JSON.stringify([['wrb.fr', null, inner]])]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const [r1, r2] = await Promise.all([
      rotateGeminiCookies('__Secure-1PSID=psid_proactive; __Secure-1PSIDTS=initial_ts'),
      rotateGeminiCookies('__Secure-1PSID=psid_proactive; __Secure-1PSIDTS=initial_ts'),
    ]);
    expect(rotateCalls).toBe(1);
    expect(r1.cookieHeader).toBe('__Secure-1PSID=psid_proactive; __Secure-1PSIDTS=ts_round_1');
    expect(r2.cookieHeader).toBe('__Secure-1PSID=psid_proactive; __Secure-1PSIDTS=ts_round_1');

    fakeNow += 5 * 60_000;
    const updates: string[] = [];
    for await (const _delta of streamGeminiWebChat({
      credential: r1.cookieHeader,
      messages: [{ role: 'user', content: 'Turn 1' }],
      options: { onCredentialUpdate: (next) => updates.push(next) },
    })) {
      // drain
    }
    expect(rotateCalls).toBe(1);
    expect(updates).toHaveLength(0);

    fakeNow += 5 * 60_000;
    for await (const _delta of streamGeminiWebChat({
      credential: r1.cookieHeader,
      messages: [{ role: 'user', content: 'Turn 2' }],
      options: { onCredentialUpdate: (next) => updates.push(next) },
    })) {
      // drain
    }
    expect(rotateCalls).toBe(2);
    expect(updates).toEqual(['__Secure-1PSID=psid_proactive; __Secure-1PSIDTS=ts_round_2']);
  });

  it('rejects untrusted/SSRF/excessive redirects and treats 302 to accounts.google.com as 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://accounts.google.com/v3/signin?continue=https://gemini.google.com/app' },
        });
      }
      if (url === 'https://accounts.google.com/RotateCookies') {
        return new Response('Unauthorized', { status: 401 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      streamGeminiWebChat({
        credential: '__Secure-1PSID=psid_302_auth; __Secure-1PSIDTS=ts_302',
        messages: [{ role: 'user', content: 'Hi' }],
      }).next(),
    ).rejects.toMatchObject({ status: 401 });

    // Non-Google /app redirect rejected before requesting target and Set-Cookie ignored
    clearGeminiWebCaches();
    let fetchedUntrusted = false;
    const updates: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        const headers = new Headers({ Location: 'https://evil.example/steal' });
        headers.append('Set-Cookie', '__Secure-1PSID=from_app; Path=/');
        return new Response(null, { status: 302, headers });
      }
      fetchedUntrusted = true;
      return new Response('nope', { status: 200 });
    });

    await expect(
      streamGeminiWebChat({
        credential: '__Secure-1PSID=secret_psid; __Secure-1PSIDTS=secret_ts',
        messages: [{ role: 'user', content: 'Hi' }],
        options: { onCredentialUpdate: (next) => updates.push(next) },
      }).next(),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchedUntrusted).toBe(false);

    // Metadata IP redirect blocked before requesting target
    clearGeminiWebCaches();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } }),
    );
    await expect(
      validateGeminiWebSession('__Secure-1PSID=psid_ssrf; __Secure-1PSIDTS=ts_ssrf'),
    ).resolves.toMatchObject({ valid: false, error: expect.stringMatching(/untrusted|blocked|metadata/i) });

    // Excessive redirects (>5 hops) fail with 502
    clearGeminiWebCaches();
    let hop = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      hop += 1;
      return new Response(null, { status: 302, headers: { Location: `https://gemini.google.com/u/${hop}/app` } });
    });
    await expect(
      streamGeminiWebChat({
        credential: '__Secure-1PSID=psid_loop; __Secure-1PSIDTS=ts_loop',
        messages: [{ role: 'user', content: 'Hi' }],
      }).next(),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('never sends cookies to non-Google webImages URLs', async () => {
    let fetchedEvilImage = false;
    const webImagesField = [
      [[['https://evil.example/direct.png'], null, null, null, 'Third party']],
    ];
    const candidate = [
      'rc_1',
      ['Ảnh đây'],
      null, null, null, null, null, null, null, null, null, null,
      [null, webImagesField],
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === 'https://gemini.google.com/app') {
        return new Response('<script>{"SNlM0e":"snl_img_safe"}</script>', { status: 200 });
      }
      if (url.includes('StreamGenerate')) {
        const inner = JSON.stringify([null, null, null, null, [candidate]]);
        return new Response(
          streamFromLines([")]}'", '90', JSON.stringify([['wrb.fr', null, inner]])]),
          { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
        );
      }
      if (url.includes('evil.example')) {
        fetchedEvilImage = true;
        return new Response(IMAGE_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const deltas: string[] = [];
    for await (const delta of streamGeminiWebChat({
      credential: '__Secure-1PSID=secret_psid; __Secure-1PSIDTS=secret_ts',
      messages: [{ role: 'user', content: 'Images' }],
      modelId: 'gemini-3.1-pro',
    })) {
      if (delta.content) deltas.push(delta.content);
    }

    expect(fetchedEvilImage).toBe(false);
    expect(deltas.join('')).toContain('[Third party](https://evil.example/direct.png)');
  });
});
