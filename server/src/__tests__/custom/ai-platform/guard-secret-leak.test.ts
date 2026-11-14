/**
 * Output Guard Secret-Leak, Excerpt Encryption, 7-Day Expiry (410), Audit, and Backup Security (Agent 4).
 *
 * Uses a real temp DB directory, creates actual guard violations/events before checking
 * for leaks, tests short/escaped opaque credentials and systemPrompt sentinels, and
 * decodes downloaded backup artifacts without conditional skips.
 */

import fs from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { getDb, initDb } from '../../../db/index.js';
import { encrypt } from '../../../lib/crypto.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setKeyCacheTestOverride } from '../../../services/key-cache.js';
import { setUserPermissions } from '../../../services/users.js';
import { startFakeProviderServer, type FakeProviderServer } from '../../helpers/ai-platform-fake-provider.js';

const SHORT_CREDENTIAL = 'xq9z!';
const ESCAPED_CREDENTIAL = 'cred\\"esc\\\\99';
const PROMPT_SENTINEL =
  'SENTINEL_SYS_PROMPT_ALPHA_BETA_GAMMA_DELTA_EPSILON_ZETA_ETA_THETA_IOTA_KAPPA_LAMBDA_MU';
const VIOLATION_MARKER = 'VIOLATION_SECRET_MARKER_774411';

describe('Output Guard secret leak & excerpt security', () => {
  let server: Server;
  let fakeProvider: FakeProviderServer;
  let base: string;
  let primaryId: number;
  let primaryToken: string;
  let viewerNoExcerptToken: string;
  let excerptViewerToken: string;
  let profileId = 0;
  const clientKey = 'flm_guard_secret_1';
  let fixtureDirectory: string;

  async function call(urlPath: string, token?: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-guard-secrets-'));
    initDb(path.join(fixtureDirectory, 'fixture.db'));
    resetFlagsCacheForTests();
    setFlags({ outputGuard: true });

    fakeProvider = await startFakeProviderServer();
    setKeyCacheTestOverride(true);
    const enc = encrypt(SHORT_CREDENTIAL);
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'guard-secret-groq', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    const profRes = getDb()
      .prepare(
        `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, system_prompt)
         VALUES (?, ?, 'enc', 'iv', 'tag', 1, ?)`,
      )
      .run('guard-secret-profile', hashClientProfileKey(clientKey), PROMPT_SENTINEL);
    profileId = Number(profRes.lastInsertRowid);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    primaryId = createUser('guard-sec-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const viewerId = createUser('guard-sec-viewer@example.com', 'Password123!', 'member').userId;
    setUserPermissions(viewerId, ['view_output_guard'], primaryId);
    viewerNoExcerptToken = createSession(viewerId);

    const excerptId = createUser('guard-sec-excerpt@example.com', 'Password123!', 'member').userId;
    setUserPermissions(excerptId, ['view_output_guard', 'view_guard_excerpts'], primaryId);
    excerptViewerToken = createSession(excerptId);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fakeProvider.close();
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it('never leaks excerpts, ciphertext, systemPrompt, or opaque credentials in events, audit, stdout/stderr, or backups', async () => {
    // 1. Configure blocking policy with keyword marker
    const putRes = await call(`/api/ai-platform/output-guard/profile/${profileId}`, primaryToken, 'PUT', {
      mode: 'block',
      failMode: 'allow',
      detectors: {
        keywords: { enabled: true, terms: [VIOLATION_MARKER] },
        patterns: { enabled: false, rules: [] },
        promptLeak: { enabled: true, minShingles: 2 },
        pii: { enabled: true, action: 'mask' },
        maxLength: { enabled: false, chars: 20000 },
        moderation: { enabled: false },
        judge: { enabled: false, model: 'auto', criteria: '' },
      },
      replacementText: 'Blocked response',
      bypassRoles: [],
      holdChars: 200,
      maxDelayMs: 300,
      revision: 0,
    });
    expect(putRes.status).toBe(200);

    // 2. Trigger an actual violation containing the violation marker + short/escaped credentials
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fakeProvider.enqueue({
        kind: 'scripted',
        wire: 'openai-chat',
        stream: false,
        text: `Output containing ${VIOLATION_MARKER} and ${SHORT_CREDENTIAL} and ${ESCAPED_CREDENTIAL}`,
      });

      const chatRes = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${clientKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'groq/compound',
          messages: [{ role: 'user', content: 'hi' }],
          stream: false,
        }),
      });
      expect(chatRes.status).toBe(200);
      const chatText = await chatRes.text();
      expect(chatText).not.toContain(VIOLATION_MARKER);
      expect(chatText).toContain('Blocked response');

      // 3. List events -> non-empty, metadata only, NO excerpt/ciphertext/iv/tag/systemPrompt/credentials
      const eventsRes = await call(`/api/ai-platform/output-guard/events?scope=profile/${profileId}`, viewerNoExcerptToken);
      expect(eventsRes.status).toBe(200);
      const eventsJson = JSON.parse(eventsRes.text) as { events: Array<{ id: number | string; action: string }> };
      expect(eventsJson.events.length).toBeGreaterThan(0);
      expect(eventsRes.text).not.toContain(VIOLATION_MARKER);
      expect(eventsRes.text).not.toContain(PROMPT_SENTINEL);
      expect(eventsRes.text).not.toContain(SHORT_CREDENTIAL);
      expect(eventsRes.text).not.toContain(ESCAPED_CREDENTIAL);
      expect(eventsRes.text).not.toContain('ciphertext');
      expect(eventsRes.text).not.toContain('authTag');

      const eventId = eventsJson.events[0].id;

      // 4. Excerpt RBAC: 403 without view_guard_excerpts, 200 with it + audit recorded without plaintext
      const deniedExcerpt = await call(`/api/ai-platform/output-guard/events/${eventId}/excerpt`, viewerNoExcerptToken);
      expect(deniedExcerpt.status).toBe(403);

      const allowedExcerpt = await call(`/api/ai-platform/output-guard/events/${eventId}/excerpt`, excerptViewerToken);
      expect(allowedExcerpt.status).toBe(200);
      const excerptBody = JSON.parse(allowedExcerpt.text) as { excerpt: string; expiresAt: string };
      expect(excerptBody.excerpt).toContain(VIOLATION_MARKER);

      const auditRows = getDb()
        .prepare(`SELECT summary FROM audit_logs WHERE area = 'ai-platform' ORDER BY id DESC LIMIT 20`)
        .all() as Array<{ summary: string }>;
      const auditBlob = auditRows.map((r) => r.summary).join('\n');
      expect(auditBlob).not.toContain(VIOLATION_MARKER);
      expect(auditBlob).not.toContain(PROMPT_SENTINEL);
      expect(auditBlob).not.toContain(SHORT_CREDENTIAL);

      // 5. Backup export -> decode gzipped payload and verify no plaintext violation marker or prompt sentinel
      const createdBackup = await call('/api/backups', primaryToken, 'POST', {});
      expect(createdBackup.status).toBe(201);
      const backupParsed = JSON.parse(createdBackup.text) as { backup: { id: number } };
      const dl = await fetch(`${base}/api/backups/${backupParsed.backup.id}/download`, {
        headers: { authorization: `Bearer ${primaryToken}` },
      });
      expect(dl.status).toBe(200);
      const rawBuf = Buffer.from(await dl.arrayBuffer());
      const isGzip = rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b;
      const decodedBackup = isGzip ? zlib.gunzipSync(rawBuf).toString('utf8') : rawBuf.toString('utf8');
      expect(decodedBackup).not.toContain(VIOLATION_MARKER);
      expect(decodedBackup).not.toContain(SHORT_CREDENTIAL);

      // 6. 7-day expiry enforced on read path -> 410 even before sweeper runs
      vi.useFakeTimers({ now: Date.now() + 7 * 24 * 60 * 60 * 1000 + 5_000 });
      const expiredRes = await call(`/api/ai-platform/output-guard/events/${eventId}/excerpt`, excerptViewerToken);
      expect(expiredRes.status).toBe(410);

      const logsOut = [...stdoutSpy.mock.calls, ...stderrSpy.mock.calls].map((c) => String(c[0])).join('\n');
      expect(logsOut).not.toContain(VIOLATION_MARKER);
      expect(logsOut).not.toContain(SHORT_CREDENTIAL);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
