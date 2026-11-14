/**
 * T053 — Secret-leak verification across MCP server CRUD, authenticated remote
 * echo (serverInfo, descriptors, tool results, protocol error), seeded call logs,
 * approvals, audit logs, real stdout/stderr sinks, and backup download artifacts.
 *
 * Uses opaque credentials without sk-/Bearer prefixes so generic token regexes
 * cannot mask missing credential-echo scrubbing (F01 / F02).
 */

import type { Server } from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../app.js';
import { resetFlagsCacheForTests, setFlags } from '../../../custom/ai-platform/flags.js';
import { executeTool } from '../../../custom/ai-platform/mcp-client/tools.js';
import { getDb, initDb } from '../../../db/index.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from '../../helpers/ai-platform-fake-mcp-http.js';

const OPAQUE_CREDENTIAL = 'opaque-mcp-sentinel-cred-991122-xyz';
const OPAQUE_PASSWORD = 'opaque-mcp-sentinel-pass-882233-abc';

describe('MCP secret leak prevention (T053 / F01 / F02)', () => {
  let server: Server;
  let fakeMcp: FakeMcpHttpServer;
  let base: string;
  let primaryToken: string;
  let viewerToken: string;
  let profileId: number;
  let fixtureDirectory: string;

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
    fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'freellmapi-mcp-secrets-'));
    initDb(path.join(fixtureDirectory, 'fixture.db'));
    resetFlagsCacheForTests();
    setFlags({ mcpClient: true });

    fakeMcp = await startFakeMcpHttpServer({
      serverInfo: {
        name: 'echo-mcp',
        version: '1.0.0',
        echo: OPAQUE_CREDENTIAL,
      },
      tools: [
        {
          name: 'echo_write',
          description: `Write tool echoing ${OPAQUE_CREDENTIAL}`,
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              password: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['id'],
          },
        },
      ],
      onToolCall: () => ({
        content: [{ type: 'text', text: `result-echo:${OPAQUE_CREDENTIAL}` }],
      }),
    });

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const primaryId = createUser('leak-primary@example.com', 'Password123!').userId;
    primaryToken = createSession(primaryId);

    const memberId = createUser('leak-viewer@example.com', 'Password123!', 'member').userId;
    setUserPermissions(memberId, ['view_mcp_servers'], primaryId);
    viewerToken = createSession(memberId);

    profileId = Number(
      getDb()
        .prepare(
          `INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, ai_tools_enabled, ai_tool_max_rounds)
           VALUES ('leak-profile', ?, 'enc', 'iv', 'tag', 1, 1, 8)`,
        )
        .run(hashClientProfileKey('leak-profile-raw-key'))
        .lastInsertRowid,
    );
  });

  afterAll(async () => {
    resetFlagsCacheForTests();
    await fakeMcp.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
    if (path.dirname(path.resolve(fixtureDirectory)) === path.resolve(os.tmpdir()) &&
        path.basename(fixtureDirectory).startsWith('freellmapi-mcp-secrets-')) {
      fs.rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('never leaks opaque credential across authenticated MCP echo, sync error, calls, approvals, audit, or stdout/stderr', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const originRes = await call('/api/ai-platform/mcp/allowed-internal-hosts', primaryToken, 'PUT', {
        origins: [fakeMcp.origin],
      });
      expect(originRes.status).toBe(200);

      const createRes = await call('/api/ai-platform/mcp/servers', primaryToken, 'POST', {
        slug: 'sentinel-srv',
        name: 'Sentinel Server',
        url: fakeMcp.url,
        authKind: 'bearer',
        secret: OPAQUE_CREDENTIAL,
      });
      expect(createRes.status).toBe(201);
      expect(createRes.text).not.toContain(OPAQUE_CREDENTIAL);
      expect(createRes.text).toContain('"hasSecret":true');
      expect(createRes.text).not.toContain('auth_ciphertext');

      const serverId = (JSON.parse(createRes.text) as { server: { id: number } }).server.id;

      // Test & sync against fakeMcp echoing OPAQUE_CREDENTIAL in serverInfo and descriptor
      const testRes = await call(`/api/ai-platform/mcp/servers/${serverId}/test`, primaryToken, 'POST');
      expect(testRes.status).toBe(200);
      expect(testRes.text).not.toContain(OPAQUE_CREDENTIAL);

      const syncRes = await call(`/api/ai-platform/mcp/servers/${serverId}/sync`, primaryToken, 'POST');
      expect(syncRes.status).toBe(200);
      expect(syncRes.text).not.toContain(OPAQUE_CREDENTIAL);

      const toolsRes = await call(`/api/ai-platform/mcp/servers/${serverId}/tools`, viewerToken);
      expect(toolsRes.status).toBe(200);
      expect(toolsRes.text).not.toContain(OPAQUE_CREDENTIAL);
      const toolId = (JSON.parse(toolsRes.text) as { tools: Array<{ id: number }> }).tools[0]!.id;

      // Approve as read? No, keep write -> bind -> queue pending approval with password + credential
      const reviewRes = await call(`/api/ai-platform/mcp/tools/${toolId}`, primaryToken, 'PATCH', {
        state: 'allowed',
        effect: 'write',
      });
      expect(reviewRes.status).toBe(200);

      const bindRes = await call(`/api/ai-platform/mcp/bindings/profile/${profileId}`, primaryToken, 'PUT', {
        toolIds: [toolId],
        enabled: true,
        maxRounds: 8,
      });
      expect(bindRes.status).toBe(200);

      const boundRes = await call(`/api/ai-platform/mcp/bindings/profile/${profileId}`, viewerToken);
      expect(boundRes.status).toBe(200);
      const boundTool = (JSON.parse(boundRes.text) as { binding: { tools: Array<{ id: number; serverId: number; serverSlug: string; name: string; exposedName: string; description: string | null; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> | null; effect: 'read' | 'write' }> } }).binding.tools[0]!;

      const execOutcome = await executeTool(
        {
          scope: { kind: 'profile', id: String(profileId) },
          endUser: 'leak-end-user',
          turnId: 'leak-turn-1',
          stepSeq: 1,
          signal: new AbortController().signal,
        },
        {
          toolId: boundTool.id,
          serverId: boundTool.serverId,
          serverSlug: boundTool.serverSlug,
          name: boundTool.name,
          exposedName: boundTool.exposedName,
          description: boundTool.description,
          inputSchema: boundTool.inputSchema,
          outputSchema: boundTool.outputSchema,
          effect: boundTool.effect,
          timeoutMs: 5000,
          maxResultBytes: 65536,
          maxConcurrency: 2,
        },
        { id: 'order-1', password: OPAQUE_PASSWORD, note: OPAQUE_CREDENTIAL },
      );
      expect(execOutcome.kind).toBe('awaiting_approval');

      // Also trigger protocol error echoing OPAQUE_CREDENTIAL during sync
      fakeMcp.setConfig({ protocolVersion: OPAQUE_CREDENTIAL });
      const errSyncRes = await call(`/api/ai-platform/mcp/servers/${serverId}/sync`, primaryToken, 'POST');
      expect(errSyncRes.status).toBeGreaterThanOrEqual(400);
      expect(errSyncRes.text).not.toContain(OPAQUE_CREDENTIAL);

      // Viewer-only user (view_mcp_servers) must never see credential in list/calls
      const viewerListRes = await call('/api/ai-platform/mcp/servers', viewerToken);
      expect(viewerListRes.status).toBe(200);
      expect(viewerListRes.text).not.toContain(OPAQUE_CREDENTIAL);

      const viewerCallsRes = await call('/api/ai-platform/mcp/calls', viewerToken);
      expect(viewerCallsRes.status).toBe(200);
      expect(viewerCallsRes.text).not.toContain(OPAQUE_CREDENTIAL);
      expect(viewerCallsRes.text).not.toContain(OPAQUE_PASSWORD);

      const approvalsRes = await call('/api/ai-platform/approvals', primaryToken);
      expect(approvalsRes.status).toBe(200);
      expect(approvalsRes.text).not.toContain(OPAQUE_CREDENTIAL);
      expect(approvalsRes.text).not.toContain(OPAQUE_PASSWORD);

      const auditRows = getDb().prepare('SELECT * FROM custom_audit_log ORDER BY id DESC LIMIT 30').all();
      const auditJson = JSON.stringify(auditRows);
      expect(auditJson).not.toContain(OPAQUE_CREDENTIAL);
      expect(auditJson).not.toContain(OPAQUE_PASSWORD);

      const stdoutText = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).not.toContain(OPAQUE_CREDENTIAL);
      expect(stderrText).not.toContain(OPAQUE_CREDENTIAL);
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('enforces backup authorization and never exposes plaintext opaque credential in downloaded backup artifact', async () => {
    const unauthBackup = await call('/api/backups', viewerToken, 'POST', {});
    expect(unauthBackup.status).toBe(403);

    const created = await call('/api/backups', primaryToken, 'POST', {});
    expect(created.status).toBe(201);
    const parsed = JSON.parse(created.text) as { backup?: { id?: number; filename?: string } };
    expect(parsed.backup?.id).toBeTypeOf('number');

    const dl = await fetch(`${base}/api/backups/${parsed.backup!.id}/download`, {
      headers: { authorization: `Bearer ${primaryToken}` },
    });
    expect(dl.status).toBe(200);
    const rawBuf = Buffer.from(await dl.arrayBuffer());
    expect(rawBuf.length).toBeGreaterThan(0);

    // Decompress if gzipped so we inspect actual backup payload content, not just compressed bytes
    const isGzip = rawBuf.length >= 2 && rawBuf[0] === 0x1f && rawBuf[1] === 0x8b;
    const decodedText = isGzip ? zlib.gunzipSync(rawBuf).toString('utf8') : rawBuf.toString('utf8');
    expect(decodedText).not.toContain(OPAQUE_CREDENTIAL);
    expect(decodedText).not.toContain(OPAQUE_PASSWORD);
  });
});
