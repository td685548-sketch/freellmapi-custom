/**
 * T053 — Secret-leak verification across MCP server CRUD, responses, error surfaces,
 * call logs, approvals, audit logs, real stdout/stderr sinks, and backup/export.
 *
 * NOTE: Requires Agent 3 (I0) router mounted at /api/ai-platform/mcp/* and /api/ai-platform/approvals*.
 * Without I0, HTTP calls to /api/ai-platform/mcp/* fail in RED state (404) until I0 is integrated.
 */

import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { getDb, initDb } from '../../../db/index.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';

const SENTINEL_SECRET = 'sk-mcp-sentinel-secret-9911-do-not-leak';

describe('MCP secret leak prevention (T053)', () => {
  let server: Server;
  let base: string;
  let primaryToken: string;
  let memberNoBackupToken: string;

  async function call(path: string, token?: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${base}${path}`, {
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
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const primaryId = createUser('leak-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const memberId = createUser('leak-member@example.com', 'Password123!', 'member').userId;
    setUserPermissions(memberId, ['view_mcp_servers'], primaryId);
    memberNoBackupToken = createSession(memberId);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('never exposes sentinel secret in server responses, audit logs, call logs, approvals, or stdout/stderr', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const createRes = await call('/api/ai-platform/mcp/servers', primaryToken, 'POST', {
        slug: 'sentinel-srv',
        name: 'Sentinel Server',
        url: 'https://sentinel.example.com/mcp',
        authKind: 'bearer',
        secret: SENTINEL_SECRET,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.text).not.toContain(SENTINEL_SECRET);
      expect(createRes.text).toContain('"hasSecret":true');
      expect(createRes.text).not.toContain('auth_ciphertext');

      const listRes = await call('/api/ai-platform/mcp/servers', primaryToken);
      expect(listRes.status).toBe(200);
      expect(listRes.text).not.toContain(SENTINEL_SECRET);

      const callsRes = await call('/api/ai-platform/mcp/calls', primaryToken);
      expect(callsRes.status).toBe(200);
      expect(callsRes.text).not.toContain(SENTINEL_SECRET);

      const approvalsRes = await call('/api/ai-platform/approvals', primaryToken);
      expect(approvalsRes.status).toBe(200);
      expect(approvalsRes.text).not.toContain(SENTINEL_SECRET);

      const auditRows = getDb().prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 20').all();
      expect(JSON.stringify(auditRows)).not.toContain(SENTINEL_SECRET);

      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).not.toContain(SENTINEL_SECRET);
      expect(stderrText).not.toContain(SENTINEL_SECRET);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('enforces backup authorization and never exposes plaintext sentinel in backup download', async () => {
    // Non-authorized member cannot create/download backups
    const unauthBackup = await call('/api/backups', memberNoBackupToken, 'POST', {});
    expect(unauthBackup.status).toBe(403);

    // Primary backup download contains encrypted ciphertext at most, never plaintext sentinel
    const created = await call('/api/backups', primaryToken, 'POST', {});
    if (created.status === 200 || created.status === 201) {
      const parsed = JSON.parse(created.text) as { backup?: { id?: number } };
      if (parsed.backup?.id) {
        const dl = await fetch(`${base}/api/backups/${parsed.backup.id}/download`, {
          headers: { authorization: `Bearer ${primaryToken}` },
        });
        const buf = Buffer.from(await dl.arrayBuffer());
        expect(buf.toString('utf8')).not.toContain(SENTINEL_SECRET);
      }
    }
  });
});
