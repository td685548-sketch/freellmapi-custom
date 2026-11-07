import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/proxy.js', () => ({ proxyFetch: vi.fn() }));

import { proxyFetch } from '../../lib/proxy.js';
import {
  generateChatGptWebImages,
  normalizeChatGptWebCookie,
} from '../../custom/provider-accounts/chatgpt-web-image.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ChatGPT Web image generation (9Router picture_v2 parity)', () => {
  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation') && method === 'POST') {
        const sse = [
          'data: {"conversation_id":"11111111-1111-1111-1111-111111111111"}',
          'data: {"message":{"content":{"parts":["file-service://file-abc"]}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (target.endsWith('/backend-api/files/file-abc/download')) {
        return json({ download_url: 'https://files.example.test/image.png' });
      }
      if (target.startsWith('https://files.example.test/')) {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });
  });

  it('normalizes raw tokens, cookie headers, cookie-editor JSON and storage-state JSON', () => {
    expect(normalizeChatGptWebCookie('  eyJhbGciOiJkaXIi  ')).toBe(
      '__Secure-next-auth.session-token=eyJhbGciOiJkaXIi',
    );
    expect(normalizeChatGptWebCookie('Cookie: __Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b')).toBe(
      '__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b',
    );
    expect(normalizeChatGptWebCookie(JSON.stringify([
      { name: '__Secure-next-auth.session-token', value: 'raw' },
    ]))).toBe('__Secure-next-auth.session-token=raw');
    expect(normalizeChatGptWebCookie(JSON.stringify({
      cookies: [
        { name: '__Secure-next-auth.session-token.0', value: 'a' },
        { name: '__Secure-next-auth.session-token.1', value: 'b' },
      ],
    }))).toBe('__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b');
  });

  it('exchanges the cookie, solves Sentinel, runs picture_v2 and returns b64_json', async () => {
    const result = await generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b',
      prompt: 'a red cube',
      size: '1024x1024',
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.b64_json).toBe(PNG.toString('base64'));
    expect(result.data[0]?.mime_type).toBe('image/png');

    const calls = vi.mocked(proxyFetch).mock.calls;
    const sessionCall = calls.find(([url]) => String(url).endsWith('/api/auth/session'));
    const sessionHeaders = sessionCall?.[1]?.headers as Record<string, string>;
    expect(sessionHeaders.Cookie).toBe(
      '__Secure-next-auth.session-token.0=a; __Secure-next-auth.session-token.1=b',
    );

    const prepareCall = calls.find(([url]) => String(url).endsWith('/backend-api/f/conversation/prepare'));
    const prepareHeaders = prepareCall?.[1]?.headers as Record<string, string>;
    expect(prepareHeaders.Authorization).toBe('Bearer access-token');
    expect(prepareHeaders['OpenAI-Sentinel-Chat-Requirements-Token']).toBe('requirements-token');
    expect(prepareHeaders.Cookie).toContain('__Secure-next-auth.session-token.1=b');
    const prepareBody = JSON.parse(String(prepareCall?.[1]?.body)) as Record<string, unknown>;
    expect(prepareBody.system_hints).toEqual(['picture_v2']);

    const conversationCall = calls.find(([url, init]) =>
      String(url).endsWith('/backend-api/f/conversation') && init?.method === 'POST',
    );
    const conversationBody = JSON.parse(String(conversationCall?.[1]?.body)) as {
      messages: Array<{ content: { parts: string[] } }>;
    };
    expect(conversationBody.messages[0]?.content.parts[0]).toBe('a red cube (aspect ratio 1024x1024)');
    const conversationHeaders = conversationCall?.[1]?.headers as Record<string, string>;
    expect(conversationHeaders['X-Conduit-Token']).toBe('conduit-token');
  });

  it('surfaces an expired session as a 401 instead of a Cloudflare HTML 403', async () => {
    vi.mocked(proxyFetch).mockImplementation(async (url) => {
      if (String(url).endsWith('/api/auth/session')) {
        return new Response('<html>blocked</html>', { status: 403 });
      }
      return new Response('unexpected', { status: 500 });
    });

    await expect(generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token=expired',
      prompt: 'a red cube',
    })).rejects.toMatchObject({ status: 401 });
  });

  it('ignores file_upload placeholder in SSE and polls conversation for real file id', async () => {
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation') && method === 'POST') {
        const sse = [
          'data: {"conversation_id":"22222222-2222-2222-2222-222222222222"}',
          'data: {"message":{"content":{"parts":["file-service://file_upload"]}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (target.includes('/backend-api/conversation/22222222-2222-2222-2222-222222222222')) {
        return json({
          mapping: {
            node1: {
              message: {
                author: { role: 'assistant' },
                content: { parts: ['file-service://file-real1234567890123456'] },
              },
            },
          },
        });
      }
      if (target.endsWith('/backend-api/files/file-real1234567890123456/download')) {
        return json({ download_url: 'https://files.example.test/real.png' });
      }
      if (target === 'https://files.example.test/real.png') {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token=valid',
      prompt: 'a blue sphere',
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.b64_json).toBe(PNG.toString('base64'));
  }, 15_000);

  it('handles 307 redirect from files download endpoint', async () => {
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation') && method === 'POST') {
        const sse = [
          'data: {"conversation_id":"33333333-3333-3333-3333-333333333333"}',
          'data: {"message":{"content":{"parts":["file-service://file-redirect12345678"]}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (target.endsWith('/backend-api/files/file-redirect12345678/download')) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://files.oaiusercontent.com/file-redirect12345678.png' },
        });
      }
      if (target === 'https://files.oaiusercontent.com/file-redirect12345678.png') {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token=valid',
      prompt: 'a yellow triangle',
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.b64_json).toBe(PNG.toString('base64'));
  }, 15_000);

  it('downloads directly from oaiusercontent CDN url discovered in conversation stream', async () => {
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation') && method === 'POST') {
        const sse = [
          'data: {"conversation_id":"44444444-4444-4444-4444-444444444444"}',
          'data: {"message":{"content":{"parts":["Check image https:\\/\\/files.oaiusercontent.com\\/file-direct123456789.png"]}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (target === 'https://files.oaiusercontent.com/file-direct123456789.png') {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token=valid',
      prompt: 'a green star',
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.b64_json).toBe(PNG.toString('base64'));
  }, 15_000);

  it('downloads directly if files download endpoint answers 200 with image binary', async () => {
    let cdnUserAgent = '';
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      const method = init?.method ?? 'GET';
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation') && method === 'POST') {
        const sse = [
          'data: {"conversation_id":"55555555-5555-5555-5555-555555555555"}',
          'data: {"message":{"content":{"parts":["file-service://file-binary12345678"]}}}',
          '',
        ].join('\n');
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (target.endsWith('/backend-api/files/file-binary12345678/download')) {
        const headers = init?.headers as Record<string, string> | undefined;
        cdnUserAgent = headers?.['User-Agent'] ?? '';
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('not found', { status: 404 });
    });

    const result = await generateChatGptWebImages({
      credential: '__Secure-next-auth.session-token=valid',
      prompt: 'a purple hexagon',
      userAgent: 'CustomBrowser/1.0',
      n: 1,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.b64_json).toBe(PNG.toString('base64'));
    expect(cdnUserAgent).toBe('CustomBrowser/1.0');
  }, 15_000);
});
