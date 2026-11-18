// Gemini Web chat: cookie normalization, session-token extraction, cookie
// rotation, stream parsing, and session validation.
//
// `proxyFetch` is mocked at the module boundary and the URL guard is stubbed
// to a no-op (it would otherwise do a real DNS lookup for google hosts),
// following server/src/__tests__/custom/chatgpt-web-sentinel.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

vi.mock('../../lib/url-guard.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  assertProviderUrlAllowed: vi.fn(async () => {}),
}));

import {
  clearGeminiWebCaches,
  extractGeminiImages,
  extractGeminiSessionTokens,
  extractGeminiStreamText,
  geminiWebChatErrorStatus,
  mergeResponseCookies,
  normalizeGeminiWebCookie,
  rotateGeminiCookies,
  stripGeminiPlaceholders,
  validateGeminiWebSession,
} from '../../custom/provider-accounts/gemini-web-chat.js';

const COOKIE = '__Secure-1PSID=psid-value; __Secure-1PSIDTS=ts-value';
const APP_HTML = '<html><body>{"SNlM0e": "snl-token", "cfb2h": "bl-label", "FdrFJe": "sid-value"}</body></html>';

function appResponse(status: number, html: string): Response {
  return new Response(html, { status, headers: { 'content-type': 'text/html' } });
}

describe('geminiWebChatErrorStatus', () => {
  it('passes 4xx/5xx statuses through and rejects everything else', () => {
    expect(geminiWebChatErrorStatus({ status: 401 })).toBe(401);
    expect(geminiWebChatErrorStatus({ status: 599 })).toBe(599);
    expect(geminiWebChatErrorStatus({ status: 399 })).toBeUndefined();
    expect(geminiWebChatErrorStatus({ status: 600 })).toBeUndefined();
    expect(geminiWebChatErrorStatus({ status: '401' })).toBeUndefined();
    expect(geminiWebChatErrorStatus(null)).toBeUndefined();
    expect(geminiWebChatErrorStatus(new Error('boom'))).toBeUndefined();
  });
});

describe('normalizeGeminiWebCookie', () => {
  it('maps a bare token to __Secure-1PSID', () => {
    expect(normalizeGeminiWebCookie('raw-token-value')).toBe('__Secure-1PSID=raw-token-value');
  });

  it('passes a Cookie header through and strips a Cookie: prefix', () => {
    expect(normalizeGeminiWebCookie(COOKIE)).toBe(COOKIE);
    expect(normalizeGeminiWebCookie(`Cookie: ${COOKIE}`)).toBe(COOKIE);
  });

  it('strips a Bearer prefix', () => {
    expect(normalizeGeminiWebCookie('Bearer raw-token-value')).toBe('__Secure-1PSID=raw-token-value');
  });

  it('parses cookie-editor JSON, drops non-Google domains and expired non-PSID cookies', () => {
    const json = JSON.stringify([
      { name: '__Secure-1PSID', value: 'psid-1', domain: '.google.com' },
      { name: '__Secure-1PSIDTS', value: 'ts-1', domain: '.google.com' },
      { name: 'NID', value: 'stale', domain: '.google.com', expirationDate: 1 },
      { name: 'evil', value: 'x', domain: '.evil.com' },
    ]);
    expect(normalizeGeminiWebCookie(json)).toBe('__Secure-1PSID=psid-1; __Secure-1PSIDTS=ts-1');
  });

  it('keeps an expired __Secure-1PSID (rotation can revive it) but dedupes by specificity', () => {
    const json = JSON.stringify([
      { name: '__Secure-1PSID', value: 'old', domain: '.google.com', expirationDate: 1 },
      { name: '__Secure-1PSID', value: 'new', domain: 'google.com', expirationDate: 1 },
    ]);
    expect(normalizeGeminiWebCookie(json)).toBe('__Secure-1PSID=new');
  });

  it('accepts a flat { name: value } object', () => {
    expect(normalizeGeminiWebCookie(JSON.stringify({ '__Secure-1PSID': 'psid-1', '__Secure-1PSIDTS': 'ts-1' })))
      .toBe('__Secure-1PSID=psid-1; __Secure-1PSIDTS=ts-1');
  });

  it('throws 401 on an empty credential and 400 on invalid JSON', () => {
    expect(() => normalizeGeminiWebCookie('   ')).toThrow('empty');
    expect(() => normalizeGeminiWebCookie('{not json')).toThrow('invalid');
    expect(() => normalizeGeminiWebCookie(JSON.stringify({ nested: { a: 1 } }))).toThrow('no cookies');
  });
});

describe('extractGeminiSessionTokens', () => {
  it('extracts SNlM0e, cfb2h and FdrFJe from /app HTML', () => {
    expect(extractGeminiSessionTokens(APP_HTML)).toEqual({
      snlm0e: 'snl-token',
      cfb2h: 'bl-label',
      fdrfje: 'sid-value',
    });
  });

  it('returns null when SNlM0e is missing (signed-out page)', () => {
    expect(extractGeminiSessionTokens('<html>{"cfb2h": "bl"}</html>')).toBeNull();
    expect(extractGeminiSessionTokens('')).toBeNull();
  });

  it('keeps optional tokens undefined when absent', () => {
    expect(extractGeminiSessionTokens('<html>{"SNlM0e": "only-snl"}</html>')).toEqual({
      snlm0e: 'only-snl',
      cfb2h: undefined,
      fdrfje: undefined,
    });
  });
});

describe('mergeResponseCookies', () => {
  it('merges a rotated 1PSIDTS from Set-Cookie and reports changed', () => {
    const headers = new Headers();
    headers.append('set-cookie', '__Secure-1PSIDTS=new-ts; Path=/; Domain=.google.com; Secure; HttpOnly');
    const { nextHeader, changed } = mergeResponseCookies(COOKIE, { headers } as unknown as Response);
    expect(changed).toBe(true);
    expect(nextHeader).toBe('__Secure-1PSID=psid-value; __Secure-1PSIDTS=new-ts');
  });

  it('reports unchanged when the response sets no cookies', () => {
    const { nextHeader, changed } = mergeResponseCookies(COOKIE, { headers: new Headers() } as unknown as Response);
    expect(changed).toBe(false);
    expect(nextHeader).toBe(COOKIE);
  });
});

describe('stripGeminiPlaceholders', () => {
  it('drops unfetchable googleusercontent placeholder links and collapses blank lines', () => {
    const text = 'Here is the image: https://googleusercontent.com/image/abc123\n\n\nAnd the caption.';
    expect(stripGeminiPlaceholders(text)).toBe('Here is the image:\n\nAnd the caption.');
  });

  it('leaves ordinary text and real links alone', () => {
    expect(stripGeminiPlaceholders('See https://example.com/pic.png for details.')).toBe(
      'See https://example.com/pic.png for details.',
    );
    expect(stripGeminiPlaceholders('')).toBe('');
  });
});

describe('extractGeminiStreamText', () => {
  it('extracts cumulative text from a wrb.fr frame', () => {
    const inner = [null, null, null, null, [[null, ['Hello world']]]];
    const line = JSON.stringify([['wrb.fr', null, JSON.stringify(inner)]]);
    expect(extractGeminiStreamText(line)).toEqual({ text: 'Hello world' });
  });

  it('reports the error code from a null-payload frame', () => {
    const line = JSON.stringify([['wrb.fr', null, null, null, null, [404]]]);
    expect(extractGeminiStreamText(line)).toEqual({ errorCode: 404 });
  });

  it('ignores the )]} anti-XSSI prefix, bare numbers, garbage, and non-wrb frames', () => {
    expect(extractGeminiStreamText(")]}'")).toEqual({});
    expect(extractGeminiStreamText('123')).toEqual({});
    expect(extractGeminiStreamText('not json at all')).toEqual({});
    expect(extractGeminiStreamText(JSON.stringify([['other.frame', null, 'x']]))).toEqual({});
    expect(extractGeminiStreamText('')).toEqual({});
  });
});

describe('extractGeminiImages', () => {
  function candidateWith(generated: unknown, web: unknown): unknown {
    const rich: unknown[] = [];
    rich[1] = web;
    rich[7] = generated;
    const candidate: unknown[] = [];
    candidate[12] = rich;
    return candidate;
  }

  it('reads generated images from rich-content field 7 and web images from field 1', () => {
    const generated = [[[[null, null, null, [null, null, 'a cat', 'https://cdn.example/cat.png']]]]];
    const web = [[[ ['https://example.com/pic.jpg'], null, null, null, 'web pic' ]]];
    expect(extractGeminiImages(candidateWith(generated, web))).toEqual([
      { url: 'https://cdn.example/cat.png', alt: 'a cat' },
      { url: 'https://example.com/pic.jpg', alt: 'web pic' },
    ]);
  });

  it('dedupes repeated URLs and drops non-http URLs', () => {
    const generated = [[[[null, null, null, [null, null, '', 'https://cdn.example/same.png']]]]];
    const web = [
      [[ ['https://cdn.example/same.png'], null, null, null, '' ]],
      [[ ['data:image/png;base64,xxx'], null, null, null, '' ]],
    ];
    expect(extractGeminiImages(candidateWith(generated, web))).toEqual([
      { url: 'https://cdn.example/same.png' },
    ]);
  });

  it('returns empty for candidates without a rich-content block', () => {
    expect(extractGeminiImages(null)).toEqual([]);
    expect(extractGeminiImages({})).toEqual([]);
    expect(extractGeminiImages([])).toEqual([]);
  });
});

describe('rotateGeminiCookies', () => {
  beforeEach(() => {
    clearGeminiWebCaches();
    mockProxyFetch.mockReset();
  });

  it('rotates 1PSIDTS from the RotateCookies response and reports rotated', async () => {
    const headers = new Headers();
    headers.append('set-cookie', '__Secure-1PSIDTS=fresh-ts; Path=/; Domain=.google.com; Secure');
    mockProxyFetch.mockResolvedValueOnce(new Response('', { status: 200, headers }));

    const result = await rotateGeminiCookies('__Secure-1PSID=psid-a; __Secure-1PSIDTS=old-ts');

    expect(result.rotated).toBe(true);
    expect(result.cookieHeader).toContain('__Secure-1PSIDTS=fresh-ts');
    expect(result.cookieHeader).toContain('__Secure-1PSID=psid-a');
    const [url, init] = mockProxyFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://accounts.google.com/RotateCookies');
    expect((init['headers'] as Record<string, string>)['Cookie']).toContain('__Secure-1PSID=psid-a');
  });

  it('cools down after a failed rotation and does not refetch within the window', async () => {
    mockProxyFetch.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    const first = await rotateGeminiCookies('__Secure-1PSID=psid-b; __Secure-1PSIDTS=old-ts');
    expect(first.rotated).toBe(false);
    expect(first.status).toBe(500);

    const second = await rotateGeminiCookies('__Secure-1PSID=psid-b; __Secure-1PSIDTS=old-ts');
    expect(second.rotated).toBe(false);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent rotations for the same account', async () => {
    const headers = new Headers();
    headers.append('set-cookie', '__Secure-1PSIDTS=fresh-ts; Path=/');
    mockProxyFetch.mockResolvedValueOnce(new Response('', { status: 200, headers }));

    const [a, b] = await Promise.all([
      rotateGeminiCookies('__Secure-1PSID=psid-c; __Secure-1PSIDTS=old-ts'),
      rotateGeminiCookies('__Secure-1PSID=psid-c; __Secure-1PSIDTS=old-ts'),
    ]);

    expect(a.rotated).toBe(true);
    expect(b.rotated).toBe(true);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
  });
});

describe('validateGeminiWebSession', () => {
  beforeEach(() => {
    clearGeminiWebCaches();
    mockProxyFetch.mockReset();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u === 'https://accounts.google.com/RotateCookies') {
        return new Response('rotate failed', { status: 401 });
      }
      if (u === 'https://gemini.google.com/app') {
        return appResponse(200, APP_HTML);
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  });

  it('returns true when /app yields SNlM0e', async () => {
    await expect(validateGeminiWebSession(COOKIE)).resolves.toBe(true);
    expect(mockProxyFetch).toHaveBeenCalledTimes(1);
    expect(String(mockProxyFetch.mock.calls[0][0])).toBe('https://gemini.google.com/app');
  });

  it('returns valid:false without fetching for an empty credential', async () => {
    const result = await validateGeminiWebSession('   ');
    expect(result).toEqual({ valid: false, error: expect.stringContaining('empty') });
    expect(mockProxyFetch).not.toHaveBeenCalled();
  });

  it('returns valid:false when /app is 401 even after a rotation retry', async () => {
    mockProxyFetch.mockReset();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u === 'https://accounts.google.com/RotateCookies') return new Response('', { status: 401 });
      if (u === 'https://gemini.google.com/app') return appResponse(401, 'denied');
      throw new Error(`unexpected fetch: ${u}`);
    });

    const result = await validateGeminiWebSession(COOKIE);

    expect(result).toEqual({ valid: false, error: expect.stringContaining('not signed in') });
    // One /app attempt, one forced rotation, no second /app attempt (rotation failed).
    expect(mockProxyFetch.mock.calls.filter(([u]) => String(u).endsWith('/app'))).toHaveLength(1);
    expect(mockProxyFetch.mock.calls.filter(([u]) => String(u).includes('RotateCookies'))).toHaveLength(1);
  });

  it('returns valid:false when /app has no SNlM0e token', async () => {
    mockProxyFetch.mockReset();
    mockProxyFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u === 'https://accounts.google.com/RotateCookies') return new Response('', { status: 401 });
      if (u === 'https://gemini.google.com/app') return appResponse(200, '<html>signed out</html>');
      throw new Error(`unexpected fetch: ${u}`);
    });

    const result = await validateGeminiWebSession(COOKIE);

    expect(result).toEqual({ valid: false, error: expect.stringContaining('SNlM0e') });
    // One /app attempt plus one forced rotation; the rotation fails, so the
    // loop throws instead of retrying /app a second time.
    expect(mockProxyFetch.mock.calls.filter(([u]) => String(u).endsWith('/app'))).toHaveLength(1);
    expect(mockProxyFetch.mock.calls.filter(([u]) => String(u).includes('RotateCookies'))).toHaveLength(1);
  });
});
