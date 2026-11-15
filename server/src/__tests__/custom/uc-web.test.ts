import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/proxy.js')>();
  return {
    ...actual,
    proxyFetch: vi.fn(),
  };
});

import { proxyFetch } from '../../lib/proxy.js';
import {
  generateUcWebImages,
  mintUcSession,
  normalizeUcWebCookie,
} from '../../custom/provider-accounts/uc-web.js';
import { WebCookieProvider } from '../../custom/provider-accounts/web-cookie.js';
import {
  executeImageGeneration,
  isUnsupportedWebImageProvider,
} from '../../custom/x-gateway/image-generation.js';
import type { AccountRow } from '../../custom/provider-accounts/store.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function makeAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 42,
    provider: 'uc-web',
    label: 'uc-test',
    platform: 'custom',
    auth_type: 'web_cookie',
    encrypted_key: 'cipher-1',
    key_hint: 'uc-***',
    base_url: 'https://internal.chatuncensored.ai',
    models: ['seedream-v4.5', 'sora-2'],
    status: 'active',
    priority: 1,
    weight: 1,
    rate_limit_until: null,
    consecutive_failures: 0,
    last_error: null,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('UC Web executor and provider integration', () => {
  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
  });

  it('normalizes raw __client, Cookie header, and Cookie-Editor JSON', () => {
    const token = makeJwt({ id: 'client_1' });
    expect(normalizeUcWebCookie(token)).toBe(`__client=${token}`);
    expect(normalizeUcWebCookie(`foo=1; __client=${token}; bar=2`)).toBe(
      `foo=1; __client=${token}; bar=2`,
    );
    expect(
      normalizeUcWebCookie(JSON.stringify([{ name: '__client', value: token }, { name: 'a', value: 'b' }])),
    ).toBe(`__client=${token}; a=b`);
  });

  it('mints Clerk __session via /v1/client and persists rotated __client cookie', async () => {
    const initialClient = makeJwt({ id: 'client_init' });
    const rotatedClient = makeJwt({ id: 'client_rot' });
    const sessionJwt = makeJwt({ sub: 'user_abc' });
    const updated: string[] = [];

    vi.mocked(proxyFetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            response: {
              last_active_session_id: 'sess_123',
              sessions: [{ id: 'sess_123', status: 'active', user: { id: 'user_abc' } }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: sessionJwt }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': `__client=${rotatedClient}; Path=/; HttpOnly`,
          },
        }),
      );

    const session = await mintUcSession({
      credential: initialClient,
      onCredentialUpdate: (next) => updated.push(next),
    });

    expect(session.jwt).toBe(sessionJwt);
    expect(session.uid).toBe('user_abc');
    expect(updated).toHaveLength(1);
    expect(updated[0]).toContain(`__client=${rotatedClient}`);
  });

  it('mints Clerk __session directly when __client JWT embeds sid', async () => {
    const clientWithSid = makeJwt({ sid: 'sess_direct', uid: 'user_direct' });
    const sessionJwt = makeJwt({ sub: 'user_direct' });

    vi.mocked(proxyFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ jwt: sessionJwt }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const session = await mintUcSession({ credential: clientWithSid });
    expect(session.jwt).toBe(sessionJwt);
    expect(session.uid).toBe('user_direct');
    expect(vi.mocked(proxyFetch)).toHaveBeenCalledTimes(1);
  });

  it('generates images via /v2/image-gen, HEAD poll, and binary download', async () => {
    const clientWithSid = makeJwt({ sid: 'sess_img', uid: 'user_img' });
    const sessionJwt = makeJwt({ sub: 'user_img' });
    const pngBytes = Buffer.from('fake-png-bytes');

    vi.mocked(proxyFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: sessionJwt }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: 'https://cdn.example.com/uc/out.png',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(pngBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );

    const result = await generateUcWebImages({
      credential: clientWithSid,
      prompt: 'a glowing lantern in rain',
      modelId: 'seedream-v4.5',
      size: '1024x1792',
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].mimeType).toBe('image/png');
    expect(result.data[0].b64_json).toBe(pngBytes.toString('base64'));

    const genCall = vi.mocked(proxyFetch).mock.calls[1];
    expect(genCall?.[0]).toBe('https://internal.chatuncensored.ai/v2/image-gen');
    const genBody = JSON.parse(String((genCall?.[1] as RequestInit).body));
    expect(genBody.aspect_ratio).toBe('9:16');
    expect(genBody.model_version).toBe('seedream-v4.5');
    expect((genCall?.[1] as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(
      `Bearer ${sessionJwt}`,
    );
  });

  it('rejects video-only UC Web models with a clear 400 error', async () => {
    const clientWithSid = makeJwt({ sid: 'sess_vid', uid: 'user_vid' });
    await expect(
      generateUcWebImages({
        credential: clientWithSid,
        prompt: 'animate this',
        modelId: 'sora-2',
      }),
    ).rejects.toMatchObject({
      name: 'UcWebError',
      status: 400,
    });
  });

  it('streams UC Web image markdown from WebCookieProvider instead of 404ing on /v1/chat/completions', async () => {
    const clientWithSid = makeJwt({ sid: 'sess_stream', uid: 'user_stream' });
    const sessionJwt = makeJwt({ sub: 'user_stream' });
    const pngBytes = Buffer.from('stream-png');

    vi.mocked(proxyFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: sessionJwt }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://cdn.example.com/uc/stream.png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      );

    const provider = new WebCookieProvider({
      providerId: 'uc-web',
      name: 'UC Web',
      baseUrl: 'https://internal.chatuncensored.ai',
    });

    const chunks = [];
    for await (const chunk of provider.streamChatCompletion(
      clientWithSid,
      [{ role: 'user', content: 'draw a mountain' }],
      'seedream-v4.5',
    )) {
      chunks.push(chunk);
    }

    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(content).toContain('![Generated image](');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
  });

  it('validates UC Web __client cookie in WebCookieProvider.validateKey', async () => {
    const clientWithSid = makeJwt({ sid: 'sess_val', uid: 'user_val' });
    vi.mocked(proxyFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    );

    const provider = new WebCookieProvider({
      providerId: 'uc-web',
      name: 'UC Web',
      baseUrl: 'https://internal.chatuncensored.ai',
    });

    const invalid = await provider.validateKey(clientWithSid);
    expect(invalid).toMatchObject({ valid: false });
  });

  it('allows uc-web in isUnsupportedWebImageProvider and executes image generation', async () => {
    expect(isUnsupportedWebImageProvider('uc-web')).toBe(false);

    const clientWithSid = makeJwt({ sid: 'sess_exec', uid: 'user_exec' });
    const sessionJwt = makeJwt({ sub: 'user_exec' });
    const pngBytes = Buffer.from('exec-png');

    vi.mocked(proxyFetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jwt: sessionJwt }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ url: 'https://cdn.example.com/uc/exec.png' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      );

    const out = await executeImageGeneration({
      account: makeAccount(),
      baseUrl: 'https://internal.chatuncensored.ai',
      credential: clientWithSid,
      modelId: 'seedream-v4.5',
      requestedModel: 'uc-web/seedream-v4.5',
      prompt: 'sunset over sea',
      n: 1,
      size: '1024x1024',
    });

    expect(out.usageUnits).toBe(1);
    expect(out.result.data[0].b64_json).toBe(pngBytes.toString('base64'));
  });
});
