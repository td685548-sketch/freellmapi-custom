import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractGeminiSessionTokens,
  extractGeminiStreamText,
  normalizeGeminiWebCookie,
} from '../../custom/provider-accounts/gemini-web-chat.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';

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
});
