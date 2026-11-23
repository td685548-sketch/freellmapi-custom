import express from 'express';
import { describe, it, expect, beforeAll } from 'vitest';
import { initDb, regenerateUnifiedKey } from '../../db/index.js';
import { validateSession } from '../../services/auth.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { clientContextMiddleware, getClientContext } from '../../lib/client-context.js';
import { playgroundAttribution, PLAYGROUND_SESSION_HEADER } from '../../custom/playground-attribution.js';

// Playground attribution (Option B): the dashboard session is read
// cookie-first — the flm_session cookie is Path=/, so the browser sends it
// on same-origin /v1 calls — with a fallback to the X-FreeLLM-Session
// header for the server-side loopbacks (customer-ai chatWithAssistant,
// copilot Tier 2), which forward the caller's session as a header because
// a server-side fetch has no cookie jar. The first candidate that
// validates wins. Attribution is best effort and never auth: it only
// applies to unified-key requests, and a personal/profile key (or no key)
// attributes nothing.

function probeApp() {
  const app = express();
  app.use(clientContextMiddleware);
  app.use(playgroundAttribution);
  app.get('/probe', (_req, res) => {
    res.json({ userId: getClientContext().userId ?? null });
  });
  return app;
}

async function probe(
  app: ReturnType<typeof probeApp>,
  opts: { key?: string; cookie?: string; headerSession?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  try {
    const headers: Record<string, string> = {};
    if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.headerSession) headers[PLAYGROUND_SESSION_HEADER] = opts.headerSession;
    const res = await fetch(`http://127.0.0.1:${addr.port}/probe`, { headers });
    return (await res.json()) as { userId: number | null };
  } finally {
    server.close();
  }
}

describe('Playground attribution — cookie-first, header fallback', () => {
  let app: ReturnType<typeof probeApp>;
  let unifiedKey = '';
  let aliceToken = '';
  let bobToken = '';
  let aliceId = 0;
  let bobId = 0;
  let personalKey = '';

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    unifiedKey = regenerateUnifiedKey();
    aliceToken = mintDashboardToken('alice@example.com');
    bobToken = mintDashboardToken('bob@example.com');
    aliceId = validateSession(aliceToken)!.userId;
    bobId = validateSession(bobToken)!.userId;
    personalKey = mintUserApiKey(aliceId).key;
    app = probeApp();
  });

  it('unified key + valid cookie attributes the cookie account', async () => {
    const { userId } = await probe(app, { key: unifiedKey, cookie: `flm_session=${aliceToken}` });
    expect(userId).toBe(aliceId);
  });

  it('unified key + header session only attributes the header account (loopback case)', async () => {
    const { userId } = await probe(app, { key: unifiedKey, headerSession: aliceToken });
    expect(userId).toBe(aliceId);
  });

  it('an invalid cookie falls through to a valid header', async () => {
    const { userId } = await probe(app, {
      key: unifiedKey,
      cookie: 'flm_session=not-a-real-token',
      headerSession: aliceToken,
    });
    expect(userId).toBe(aliceId);
  });

  it('a valid cookie wins over a header for a different user', async () => {
    const { userId } = await probe(app, {
      key: unifiedKey,
      cookie: `flm_session=${aliceToken}`,
      headerSession: bobToken,
    });
    expect(userId).toBe(aliceId);
    expect(userId).not.toBe(bobId);
  });

  it('no cookie and no header attributes nothing', async () => {
    const { userId } = await probe(app, { key: unifiedKey });
    expect(userId).toBeNull();
  });

  it('a non-unified key + valid cookie attributes nothing', async () => {
    const { userId } = await probe(app, { key: personalKey, cookie: `flm_session=${aliceToken}` });
    expect(userId).toBeNull();
  });

  it('an invalid cookie session attributes nothing', async () => {
    const { userId } = await probe(app, { key: unifiedKey, cookie: 'flm_session=not-a-real-token' });
    expect(userId).toBeNull();
  });

  it('an invalid header session attributes nothing', async () => {
    const { userId } = await probe(app, { key: unifiedKey, headerSession: 'not-a-real-token' });
    expect(userId).toBeNull();
  });

  it('no key at all attributes nothing even with a valid cookie', async () => {
    const { userId } = await probe(app, { cookie: `flm_session=${aliceToken}` });
    expect(userId).toBeNull();
  });
});
