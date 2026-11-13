import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KiroProvider } from '../../custom/provider-accounts/kiro.js';
import { crc32 } from '../../custom/provider-accounts/kiro-wire.js';
import type { OAuthCredential } from '../../custom/provider-accounts/oauth-credentials.js';

interface Transport {
  fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<Response>;
}

function responseEvent(): Response {
  const headers = Buffer.concat(Object.entries({ ':message-type': 'event', ':event-type': 'assistantResponseEvent' }).map(([name, value]) => {
    const size = Buffer.alloc(2);
    size.writeUInt16BE(Buffer.byteLength(value));
    return Buffer.concat([Buffer.from([name.length]), Buffer.from(name), Buffer.from([7]), size, Buffer.from(value)]);
  }));
  const body = Buffer.from(JSON.stringify({ content: 'OK' }));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return new Response(frame, { headers: { 'Content-Type': 'application/vnd.amazon.eventstream' } });
}

function credential(accessToken = 'fixture-access-token', profileArn?: string): string {
  const auth: OAuthCredential = { v: 1, kind: 'kiro', accessToken, refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 86_400_000, region: 'us-east-1', profileArn };
  return JSON.stringify(auth);
}

afterEach(() => vi.restoreAllMocks());

describe('Kiro client version compatibility', () => {
  it('advertises the supported client version in both headers during connection validation', async () => {
    const provider = new KiroProvider();
    const transport = vi.spyOn(provider as unknown as Transport, 'fetchWithTimeout').mockResolvedValue(responseEvent());

    await expect(provider.validateKey(credential())).resolves.toBe(true);

    const [url, init, timeout] = transport.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(url).toBe('https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse');
    expect(headers.get('user-agent')).toMatch(/KiroIDE-1\.4\.178-[a-f0-9]{64}/);
    expect(headers.get('x-amz-user-agent')).toMatch(/KiroIDE-1\.4\.178-[a-f0-9]{64}/);
    expect(headers.get('user-agent')).not.toContain('kiro-ide/1.0.0');
    expect(headers.get('user-agent')).not.toContain('fixture-access-token');
    expect(headers.get('x-amz-user-agent')).not.toContain('fixture-access-token');
    expect(headers.get('authorization')).toBe('Bearer fixture-access-token');
    expect(timeout).toBe(20_000);
    expect(JSON.parse(String(init.body))).not.toHaveProperty('inferenceConfig');
  });

  it('keeps the profile fingerprint stable when the access token refreshes', async () => {
    const provider = new KiroProvider();
    const profileArn = 'arn:aws:codewhisperer:us-east-1:123456789012:profile/fixture';
    const transport = vi.spyOn(provider as unknown as Transport, 'fetchWithTimeout').mockImplementation(async () => responseEvent());

    await provider.chatCompletion(credential('first-token', profileArn), [{ role: 'user', content: 'Hello' }], 'claude-sonnet-4.5');
    await provider.chatCompletion(credential('refreshed-token', profileArn), [{ role: 'user', content: 'Hello' }], 'claude-sonnet-4.5');

    const first = new Headers(transport.mock.calls[0][1].headers);
    const second = new Headers(transport.mock.calls[1][1].headers);
    expect(first.get('x-amz-user-agent')).toBe(second.get('x-amz-user-agent'));
    expect(first.get('user-agent')).not.toContain(profileArn);
    expect(first.get('user-agent')).toContain(createHash('sha256').update(profileArn).digest('hex'));
    expect(second.get('authorization')).toBe('Bearer refreshed-token');
  });

  it('supports accounts without a profile ARN without exposing the token in the client signature', async () => {
    const provider = new KiroProvider();
    const transport = vi.spyOn(provider as unknown as Transport, 'fetchWithTimeout').mockResolvedValue(responseEvent());
    const result = await provider.chatCompletion(credential(), [{ role: 'user', content: 'Hello' }], 'claude-sonnet-4.5');

    expect(result.choices[0].message.content).toBe('OK');
    const headers = new Headers(transport.mock.calls[0][1].headers);
    expect(headers.get('x-amz-user-agent')).toContain(createHash('sha256').update('fixture-access-token').digest('hex'));
    expect(headers.get('x-amz-user-agent')).not.toContain('fixture-access-token');
    expect(JSON.parse(String(transport.mock.calls[0][1].body))).not.toHaveProperty('profileArn');
  });

  it('uses the same client headers for streaming inference', async () => {
    const provider = new KiroProvider();
    const transport = vi.spyOn(provider as unknown as Transport, 'fetchWithTimeout').mockResolvedValue(responseEvent());
    const chunks = [];
    for await (const chunk of provider.streamChatCompletion(credential(), [{ role: 'user', content: 'Hello' }], 'claude-sonnet-4.5')) chunks.push(chunk);

    expect(chunks[0].choices[0].delta.content).toBe('OK');
    expect(new Headers(transport.mock.calls[0][1].headers).get('x-amz-user-agent')).toMatch(/KiroIDE-1\.4\.178-/);
  });

  it('keeps an upstream version rejection visible instead of reporting connection success', async () => {
    const provider = new KiroProvider();
    vi.spyOn(provider as unknown as Transport, 'fetchWithTimeout').mockResolvedValue(new Response(JSON.stringify({
      message: 'This version of Kiro is no longer supported. Please update to the latest version of Kiro to continue.',
    }), { status: 400 }));

    await expect(provider.validateKey(credential())).rejects.toThrow('This version of Kiro is no longer supported');
  });
});
