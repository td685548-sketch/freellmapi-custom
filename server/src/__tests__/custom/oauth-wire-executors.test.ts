// OAuth wire executors: bundle parsing, Cursor ConnectRPC framing, and the
// Cursor provider's stream path.
//
// `proxyFetch` is mocked at the module boundary (no network, no DNS pinning),
// following server/src/__tests__/custom/chatgpt-web-sentinel.test.ts.
// The Grok CLI / CodeBuddy / Cline / Zed / generic OAuth-compatible providers
// share the same fetch path but are much larger surfaces; this file covers
// the shared pure helpers plus Cursor end-to-end, which exercises the same
// `fetchWithTimeout` + quota-observation + ConnectRPC decode chain.
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockProxyFetch = vi.hoisted(() => vi.fn());

vi.mock('../../lib/proxy.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  proxyFetch: mockProxyFetch,
}));

import {
  _resetOAuthWireCachesForTests,
  buildCursorChatFrame,
  buildCursorHeaders,
  CursorProvider,
  decodeCursorResponsePayload,
  generateCursorChecksum,
  parseOAuthBundle,
  wrapConnectRPCFrame,
} from '../../custom/provider-accounts/oauth-wire-executors.js';

// Minimal protobuf length-delimited field encoder, mirroring the wire format
// the module itself produces (field header varint, length varint, bytes).
function pbVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

function pbField(num: number, bytes: Uint8Array): Uint8Array {
  const tag = pbVarint((num << 3) | 2);
  const len = pbVarint(bytes.length);
  return new Uint8Array([...tag, ...len, ...bytes]);
}

function pbConcat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A Cursor response payload: field 2 = inner { field 1 = text, field 25 = { field 1 = thinking } }. */
function cursorPayload(text?: string, thinking?: string): Uint8Array {
  const innerParts: Uint8Array[] = [];
  if (text !== undefined) innerParts.push(pbField(1, enc(text)));
  if (thinking !== undefined) innerParts.push(pbField(25, pbConcat(pbField(1, enc(thinking)))));
  return pbConcat(pbField(2, pbConcat(...innerParts)));
}

describe('parseOAuthBundle', () => {
  it('reads snake_case aliases and providerSpecificData fallbacks', () => {
    const bundle = parseOAuthBundle(JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_at: 123456,
      user_id: 'u-1',
      providerSpecificData: { machineId: 'm-1', baseUrl: 'https://x.example' },
    }));
    expect(bundle.accessToken).toBe('at-1');
    expect(bundle.refreshToken).toBe('rt-1');
    expect(bundle.expiresAt).toBe(123456);
    expect(bundle.userId).toBe('u-1');
    expect(bundle.machineId).toBe('m-1');
    expect(bundle.baseUrl).toBe('https://x.example');
  });

  it('reads camelCase fields and sk/apiKey aliases', () => {
    const bundle = parseOAuthBundle(JSON.stringify({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
      expiresAt: 999,
      organizationId: 'org-1',
      systemId: 'sys-1',
      apiKey: 'key-1',
    }));
    expect(bundle.accessToken).toBe('at-2');
    expect(bundle.refreshToken).toBe('rt-2');
    expect(bundle.expiresAt).toBe(999);
    expect(bundle.organizationId).toBe('org-1');
    expect(bundle.systemId).toBe('sys-1');
    expect(bundle.apiKey).toBe('key-1');
  });

  it('falls back to sk, then apiKey, then token for the access token', () => {
    expect(parseOAuthBundle(JSON.stringify({ sk: 'sk-live' })).accessToken).toBe('sk-live');
    expect(parseOAuthBundle(JSON.stringify({ apiKey: 'key-9' })).accessToken).toBe('key-9');
    expect(parseOAuthBundle(JSON.stringify({ token: 'tok-9' })).accessToken).toBe('tok-9');
  });

  it('treats a bare string as a raw access token', () => {
    const bundle = parseOAuthBundle('plain-token-value');
    expect(bundle.accessToken).toBe('plain-token-value');
    expect(bundle.raw).toEqual({});
  });

  it('falls back to the raw string when JSON is malformed', () => {
    expect(parseOAuthBundle('{"accessToken":}').accessToken).toBe('{"accessToken":}');
    expect(parseOAuthBundle('').accessToken).toBe('');
  });
});

describe('generateCursorChecksum', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is deterministic for a fixed clock and ends with the machine id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    const a = generateCursorChecksum('machine-1');
    const b = generateCursorChecksum('machine-1');
    expect(a).toBe(b);
    expect(a.endsWith('machine-1')).toBe(true);
    // Six encoded bytes before the machine id.
    const prefix = a.slice(0, a.length - 'machine-1'.length);
    expect(Buffer.from(prefix, 'base64url').length).toBe(6);
  });

  it('only the suffix changes across machine ids at the same instant', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
    const a = generateCursorChecksum('machine-1');
    const b = generateCursorChecksum('machine-2');
    expect(a.slice(0, a.length - 'machine-1'.length)).toBe(b.slice(0, b.length - 'machine-2'.length));
  });
});

describe('buildCursorHeaders', () => {
  it('sends Bearer auth, a sha256 client key, and the checksum for the machine', () => {
    const headers = buildCursorHeaders('tok-1', 'machine-1');
    expect(headers['authorization']).toBe('Bearer tok-1');
    expect(headers['x-client-key']).toBe(createHash('sha256').update('tok-1').digest('hex'));
    expect(headers['x-cursor-checksum']).toBe(generateCursorChecksum('machine-1'));
    expect(headers['x-cursor-client-version']).toBe('3.12.17');
    expect(headers['content-type']).toBe('application/connect+proto');
    expect(headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('strips a "prefix::token" bundle to the bare token', () => {
    const headers = buildCursorHeaders('cursor::tok-2', 'machine-1');
    expect(headers['authorization']).toBe('Bearer tok-2');
    expect(headers['x-client-key']).toBe(createHash('sha256').update('tok-2').digest('hex'));
  });

  it('derives the machine id from the token when none is given', () => {
    const derived = createHash('sha256').update('tok-3machineId').digest('hex');
    const headers = buildCursorHeaders('tok-3');
    expect(headers['x-cursor-checksum']).toBe(generateCursorChecksum(derived));
  });
});

describe('wrapConnectRPCFrame', () => {
  it('frames an uncompressed payload with a 0x00 flag and big-endian length', () => {
    const payload = enc('hello');
    const frame = wrapConnectRPCFrame(payload);
    expect(frame[0]).toBe(0x00);
    expect(frame[1]).toBe(0);
    expect(frame[2]).toBe(0);
    expect(frame[3]).toBe(0);
    expect(frame[4]).toBe(5);
    expect(frame.slice(5)).toEqual(payload);
  });

  it('frames a compressed payload with a 0x01 flag that gunzips back', () => {
    const payload = enc('hello compressed world');
    const frame = wrapConnectRPCFrame(payload, true);
    expect(frame[0]).toBe(0x01);
    expect(zlib.gunzipSync(Buffer.from(frame.slice(5))).toString()).toBe('hello compressed world');
  });

  it('frames an empty payload as a 5-byte header', () => {
    const frame = wrapConnectRPCFrame(new Uint8Array(0));
    expect(frame.length).toBe(5);
    expect(frame[4]).toBe(0);
  });
});

describe('buildCursorChatFrame', () => {
  it('produces an uncompressed frame carrying the model and message text', () => {
    const frame = buildCursorChatFrame(
      [{ role: 'user', content: 'Explain quantum computing' }],
      'gpt-5',
    );
    expect(frame[0]).toBe(0x00);
    const len = (frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4];
    expect(len).toBe(frame.length - 5);
    const body = Buffer.from(frame.slice(5));
    expect(body.includes('gpt-5')).toBe(true);
    expect(body.includes('Explain quantum computing')).toBe(true);
  });

  it('encodes assistant turns with a different role than user turns', () => {
    const userFrame = buildCursorChatFrame([{ role: 'user', content: 'same-text' }], 'm');
    const asstFrame = buildCursorChatFrame([{ role: 'assistant', content: 'same-text' }], 'm');
    expect(Buffer.from(userFrame)).not.toEqual(Buffer.from(asstFrame));
  });
});

describe('decodeCursorResponsePayload', () => {
  it('decodes text and thinking from a hand-built payload', () => {
    expect(decodeCursorResponsePayload(cursorPayload('Hello Cursor', 'deep thought'))).toEqual({
      text: 'Hello Cursor',
      thinking: 'deep thought',
    });
  });

  it('decodes text-only payloads with null thinking', () => {
    expect(decodeCursorResponsePayload(cursorPayload('only text'))).toEqual({
      text: 'only text',
      thinking: null,
    });
  });

  it('returns nulls for empty and unknown-field payloads', () => {
    expect(decodeCursorResponsePayload(new Uint8Array(0))).toEqual({ text: null, thinking: null });
    expect(decodeCursorResponsePayload(pbConcat(pbField(9, enc('zzz'))))).toEqual({ text: null, thinking: null });
  });
});

describe('CursorProvider.validateKey', () => {
  it('accepts a raw token and a JSON bundle with an access token', async () => {
    const provider = new CursorProvider();
    await expect(provider.validateKey('raw-token')).resolves.toBe(true);
    await expect(provider.validateKey(JSON.stringify({ accessToken: 'tok' }))).resolves.toBe(true);
  });

  it('rejects empty credentials and bundles without a token', async () => {
    const provider = new CursorProvider();
    await expect(provider.validateKey('')).resolves.toEqual({
      valid: false,
      error: 'Missing Cursor access token',
    });
    await expect(provider.validateKey('{}')).resolves.toEqual({
      valid: false,
      error: 'Missing Cursor access token',
    });
  });
});

describe('CursorProvider.chatCompletion', () => {
  beforeEach(() => {
    _resetOAuthWireCachesForTests();
    mockProxyFetch.mockReset();
  });

  it('streams one framed text payload and aggregates it into a completion', async () => {
    const frame = wrapConnectRPCFrame(cursorPayload('Hello from Cursor'));
    mockProxyFetch.mockResolvedValueOnce(
      new Response(frame as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/connect+proto' },
      }),
    );

    const res = await new CursorProvider().chatCompletion(
      JSON.stringify({ accessToken: 'tok-1', machineId: 'machine-1' }),
      [{ role: 'user', content: 'Hi' }],
      'gpt-5',
    );

    expect(res.choices[0].message.content).toBe('Hello from Cursor');
    expect(res.model).toBe('gpt-5');
    const [url, init] = mockProxyFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('https://api2.cursor.sh/aiserver.v1.ChatService/StreamUnifiedChatWithTools');
    const headers = init['headers'] as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-1');
    expect(headers['x-cursor-checksum']).toBe(generateCursorChecksum('machine-1'));
    expect((init['body'] as Uint8Array)[0]).toBe(0x00);
  });

  it('throws a 500 provider error when the upstream rejects', async () => {
    mockProxyFetch.mockResolvedValueOnce(new Response('boom', { status: 500 }));

    let caught: unknown;
    try {
      await new CursorProvider().chatCompletion('tok-1', [{ role: 'user', content: 'Hi' }], 'gpt-5');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { status?: unknown }).status).toBe(500);
    expect((caught as Error).message).toContain('500');
  });
});
