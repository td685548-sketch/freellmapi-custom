import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/proxy.js', () => ({ proxyFetch: vi.fn() }));

import { proxyFetch } from '../../lib/proxy.js';
import { runChatGptWebChat } from '../../custom/provider-accounts/chatgpt-web-chat.js';
import { normalizeChatGptWebCookie } from '../../custom/provider-accounts/chatgpt-web-image.js';
import { looksLikeCookieHeader } from '../../custom/provider-accounts/cookie-format.js';

const CONVERSATION_ID = '11111111-1111-1111-1111-111111111111';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sse(lines: string[]): Response {
  return new Response(lines.map(line => `data: ${line}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function conversationDocument(complete: boolean, text: string): Response {
  return json({
    mapping: {
      node: {
        message: {
          author: { role: 'assistant' },
          metadata: { is_complete: complete },
          content: { content_type: 'text', parts: [text] },
        },
      },
    },
  });
}

describe('ChatGPT Web chat over plain HTTP', () => {
  beforeEach(() => {
    vi.mocked(proxyFetch).mockReset();
  });

  it('runs session -> sentinel -> prepare -> conversation SSE -> is_complete poll', async () => {
    let polls = 0;
    vi.mocked(proxyFetch).mockImplementation(async (url, init) => {
      const target = String(url);
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      if (target.endsWith('/backend-api/f/conversation')) {
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer access-token',
          'OpenAI-Sentinel-Chat-Requirements-Token': 'requirements-token',
          'X-Conduit-Token': 'conduit-token',
        });
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe('auto');
        return sse([
          JSON.stringify({ conversation_id: CONVERSATION_ID, message: { content: { parts: ['Hel'] } } }),
          JSON.stringify({ conversation_id: CONVERSATION_ID, message: { content: { parts: ['Hello world'] } } }),
        ]);
      }
      if (target.endsWith(`/backend-api/conversation/${CONVERSATION_ID}`)) {
        polls += 1;
        return polls === 1 ? conversationDocument(false, 'Hello') : conversationDocument(true, 'Hello world');
      }
      return new Response('unexpected', { status: 500 });
    });

    await expect(runChatGptWebChat({
      credential: '__Secure-next-auth.session-token=test-cookie',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Say hello' },
      ],
    })).resolves.toBe('Hello world');

    expect(polls).toBe(2);
  });

  it('reports an auth redirect from the session probe as a 401', async () => {
    vi.mocked(proxyFetch).mockRejectedValue(new Error(
      'Custom provider URL blocked: upstream redirected (302) to /auth/login; redirects are not followed for custom providers',
    ));

    await expect(runChatGptWebChat({
      credential: '__Secure-next-auth.session-token=expired',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an HTML challenge page instead of returning it as the answer', async () => {
    vi.mocked(proxyFetch).mockImplementation(async (url) => {
      const target = String(url);
      if (target.endsWith('/api/auth/session')) return json({ accessToken: 'access-token' });
      if (target.endsWith('/sentinel/chat-requirements/prepare')) return json({ prepare_token: 'prepare-token' });
      if (target.endsWith('/sentinel/chat-requirements')) return json({ token: 'requirements-token' });
      if (target.endsWith('/backend-api/f/conversation/prepare')) return json({ conduit_token: 'conduit-token' });
      return new Response('<!DOCTYPE html><html><body>Verify you are human</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    await expect(runChatGptWebChat({
      credential: '__Secure-next-auth.session-token=test-cookie',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toMatchObject({ status: 403 });
  });

  it('keeps base64 padding out of the cookie-pair heuristic', () => {
    expect(looksLikeCookieHeader('sso=abc')).toBe(true);
    expect(looksLikeCookieHeader('sso=abc; sso-rw=def')).toBe(true);
    expect(looksLikeCookieHeader('QUJDRA==')).toBe(false);
    expect(normalizeChatGptWebCookie('QUJDRA==')).toBe('__Secure-next-auth.session-token=QUJDRA==');
    expect(normalizeChatGptWebCookie('sso=abc; sso-rw=def')).toBe('sso=abc; sso-rw=def');
  });
});
