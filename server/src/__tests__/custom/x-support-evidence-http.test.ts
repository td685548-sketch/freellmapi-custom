import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http, { type Server } from 'node:http';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { setEnabled } from '../../custom/x-gateway/config.js';
import {
  createSupportTenant,
  mintSupportUserToken,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import * as routes from '../../custom/x-gateway/router.js';
import * as providers from '../../custom/provider-accounts/execution.js';
import type { BaseProvider } from '../../providers/base.js';

vi.mock('../../custom/x-gateway/quota/tracking.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../custom/x-gateway/quota/tracking.js')>(),
  withQuotaTracking: async (
    _account: unknown,
    _model: unknown,
    _proxy: unknown,
    call: () => Promise<unknown>,
  ) => call(),
}));

describe('Support Evidence HTTP Integration (Spec 018)', () => {
  let server: Server | undefined;
  let base: string;
  let tenantA: SupportTenant;
  let tenantB: SupportTenant;
  let editorToken: string;
  let viewerToken: string;
  let customerTokenA: string;
  let guestTokenA: string;
  const completion = vi.fn();

  const providerReply = (content: string, prompt = 20, output = 10) => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output },
  });

  function createConsoleUserToken(email: string, permissions: string[]): string {
    const created = createUser(email, 'Pass123456!', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(permissions), created.userId);
    return createSession(created.userId);
  }

  beforeEach(async () => {
    server = undefined;
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    setEnabled(true);

    // Seed primary admin first so subsequent users are created as 'member'
    createUser('admin@evidence.test', 'AdminPass123!');
    editorToken = createConsoleUserToken('editor_018@evidence.test', ['use_x_gateway', 'edit_x_settings']);
    viewerToken = createConsoleUserToken('viewer_018@evidence.test', ['use_x_gateway']);

    tenantA = createSupportTenant({
      name: 'Tenant A',
      defaultModel: 'test-model',
      allowedOrigins: ['https://partner.example'],
      allowGuest: true,
    }).tenant;
    tenantB = createSupportTenant({
      name: 'Tenant B',
      defaultModel: 'test-model',
      allowedOrigins: ['https://other.example'],
    }).tenant;

    customerTokenA = mintSupportUserToken(tenantA.id, {
      userId: 'cust-http-1',
      role: 'customer',
      permissions: [],
    });
    guestTokenA = mintSupportUserToken(tenantA.id, {
      userId: 'guest-http-1',
      role: 'guest',
      permissions: [],
    });

    const secret = encrypt('test-only-provider-key');
    vi.spyOn(routes, 'resolveCandidateRoutes').mockReturnValue({
      candidates: [
        {
          account: {
            id: 1,
            provider: 'test',
            platform: 'test',
            encrypted_key: secret.encrypted,
            iv: secret.iv,
            auth_tag: secret.authTag,
          },
          modelId: 'test-model',
        },
      ],
    } as ReturnType<typeof routes.resolveCandidateRoutes>);
    vi.spyOn(providers, 'resolveAccountProvider').mockReturnValue({
      chatCompletion: completion,
    } as unknown as BaseProvider);
    completion.mockReset();

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    try {
      if (server && server.listening) {
        await new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        );
      }
    } finally {
      server = undefined;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });

  const consoleReq = (
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}/api/thruline/support/tenants/${tenantA.id}/knowledge-library${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

  it('enforces editor permissions (use_x_gateway + edit_x_settings) on ALL reads and writes including preview and evals', async () => {
    // Unauthenticated -> 401
    const unauth = await consoleReq('/sources');
    expect(unauth.status).toBe(401);

    // Viewer without edit_x_settings -> 403 even on GET/preview/suites/runs
    for (const [method, path, body] of [
      ['GET', '/sources'],
      ['GET', '/policy'],
      ['POST', '/preview', { query: 'refund', role: 'customer' }],
      ['GET', '/suites'],
      ['GET', '/runs'],
    ] as Array<[string, string, unknown?]>) {
      const res = await consoleReq(path, { method, token: viewerToken, body });
      expect(res.status).toBe(403);
    }

    // Editor -> 200
    const okSources = await consoleReq('/sources', { token: editorToken });
    expect(okSources.status).toBe(200);
    expect(await okSources.json()).toEqual({ ok: true, sources: [] });
  });

  it('enforces OCC, cross-tenant 404 isolation, and role-safe retrieval preview', async () => {
    // Create source on tenantA
    const createRes = await consoleReq('/sources', {
      method: 'POST',
      token: editorToken,
      body: { name: 'Refunds', kind: 'markdown', allowedRoles: ['customer'] },
    });
    expect(createRes.status).toBe(201);
    const { source } = (await createRes.json()) as { source: { id: string; version: number } };

    // Cross-tenant GET revisions under tenantB -> 404
    const crossTenant = await fetch(
      `${base}/api/thruline/support/tenants/${tenantB.id}/knowledge-library/sources/${source.id}/revisions`,
      { headers: { Authorization: `Bearer ${editorToken}` } },
    );
    expect(crossTenant.status).toBe(404);

    // Import draft revision
    const importRes = await consoleReq(`/sources/${source.id}/revisions`, {
      method: 'POST',
      token: editorToken,
      body: {
        expectedVersion: source.version,
        title: 'Refund Policy',
        format: 'markdown',
        content: 'Full refunds are available within 14 days of purchase.',
      },
    });
    expect(importRes.status).toBe(201);
    const importData = (await importRes.json()) as {
      source: { version: number };
      revision: { id: string };
    };

    // Stale OCC version on publish -> 409 source_conflict
    const stalePublish = await consoleReq(`/sources/${source.id}/publish`, {
      method: 'POST',
      token: editorToken,
      body: { expectedVersion: source.version, revisionId: importData.revision.id },
    });
    expect(stalePublish.status).toBe(409);

    // Valid publish -> 200
    const publishRes = await consoleReq(`/sources/${source.id}/publish`, {
      method: 'POST',
      token: editorToken,
      body: { expectedVersion: importData.source.version, revisionId: importData.revision.id },
    });
    expect(publishRes.status).toBe(200);

    // Preview for customer -> finds candidate even while policy.mode is off
    const previewCust = await consoleReq('/preview', {
      method: 'POST',
      token: editorToken,
      body: { query: 'refunds 14 days', role: 'customer' },
    });
    expect(previewCust.status).toBe(200);
    const previewCustData = (await previewCust.json()) as {
      ok: true;
      preview: { candidates: Array<{ id: string; sourceId: string }>; willAbstain: boolean };
    };
    expect(previewCustData.preview.willAbstain).toBe(false);
    expect(previewCustData.preview.candidates[0].sourceId).toBe(source.id);

    // Preview for guest -> hidden customer source not leaked
    const previewGuest = await consoleReq('/preview', {
      method: 'POST',
      token: editorToken,
      body: { query: 'refunds 14 days', role: 'guest' },
    });
    expect(previewGuest.status).toBe(200);
    const previewGuestData = (await previewGuest.json()) as {
      ok: true;
      preview: { candidates: unknown[]; willAbstain: boolean };
    };
    expect(previewGuestData.preview.willAbstain).toBe(true);
    expect(previewGuestData.preview.candidates).toEqual([]);
  });

  it('runs end-to-end source -> publish -> strict chat -> cited history -> replay 409 -> escalation', async () => {
    // 1. Create & publish source
    const createRes = await consoleReq('/sources', {
      method: 'POST',
      token: editorToken,
      body: { name: 'Shipping', kind: 'text', allowedRoles: ['customer'] },
    });
    const { source } = (await createRes.json()) as { source: { id: string; version: number } };

    const importRes = await consoleReq(`/sources/${source.id}/revisions`, {
      method: 'POST',
      token: editorToken,
      body: {
        expectedVersion: source.version,
        title: 'Express Shipping',
        format: 'text',
        content: 'Express shipping delivers in 24 hours for domestic orders.',
      },
    });
    const { source: afterImport, revision } = (await importRes.json()) as {
      source: { version: number };
      revision: { id: string };
    };

    await consoleReq(`/sources/${source.id}/publish`, {
      method: 'POST',
      token: editorToken,
      body: { expectedVersion: afterImport.version, revisionId: revision.id },
    });

    // 2. Enable required mode
    const policyRes = await consoleReq('/policy', {
      method: 'PUT',
      token: editorToken,
      body: { expectedVersion: 1, mode: 'required', includeLegacyDocs: false, minCoverage: 0.25 },
    });
    expect(policyRes.status).toBe(200);

    // 3. Reject client-supplied evidence/citations/policy on /chat
    const spoofed = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Express shipping?' }],
        evidence: { status: 'cited', citations: [] },
      }),
    });
    expect(spoofed.status).toBe(400);

    // 4. Origin denied -> 403
    const badOrigin = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Express shipping?' }],
      }),
    });
    expect(badOrigin.status).toBe(403);

    // 5. Cited chat
    completion.mockImplementationOnce(async (_cred, msgs: Array<{ role: string; content: string }>) => {
      const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
      const match = /\[cite:(cit_[A-Za-z0-9_-]+)\]/.exec(sys);
      expect(match).not.toBeNull();
      return providerReply(`Express shipping delivers in 24 hours [cite:${match![1]}].`);
    });

    const chatRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        requestId: 'http-cited-1',
        messages: [{ role: 'user', content: 'How fast is express shipping?' }],
      }),
    });
    expect(chatRes.status).toBe(200);
    const chatData = (await chatRes.json()) as {
      model: string | null;
      reply: string;
      runtime: {
        conversationId: string;
        replySource: string;
        evidence: { status: string; citations: Array<{ sourceId: string; ordinal: number }> };
      };
    };
    expect(chatData.model).toBe('test-model');
    expect(chatData.reply).toBe('Express shipping delivers in 24 hours [1].');
    expect(chatData.runtime.replySource).toBe('model');
    expect(chatData.runtime.evidence.status).toBe('cited');
    expect(chatData.runtime.evidence.citations[0].sourceId).toBe(source.id);

    // 5b. Signed guest cannot access customer-only source -> zero-model no_matches abstention
    const guestChatRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': guestTokenA,
      },
      body: JSON.stringify({
        requestId: 'http-guest-deny-1',
        messages: [{ role: 'user', content: 'How fast is express shipping?' }],
      }),
    });
    expect(guestChatRes.status).toBe(200);
    const guestChatData = (await guestChatRes.json()) as {
      model: string | null;
      runtime: { replySource: string; evidence: { reason: string } };
    };
    expect(guestChatData.model).toBeNull();
    expect(guestChatData.runtime.replySource).toBe('knowledge_abstention');
    expect(guestChatData.runtime.evidence.reason).toBe('no_matches');

    // 6. No-match abstention + escalation
    const abstainRes = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        requestId: 'http-abstain-1',
        conversationId: chatData.runtime.conversationId,
        messages: [{ role: 'user', content: 'Unmatched topic qqq999' }],
      }),
    });
    expect(abstainRes.status).toBe(200);
    const abstainData = (await abstainRes.json()) as {
      model: string | null;
      runtime: { replySource: string; evidence: { status: string; reason: string } };
    };
    expect(abstainData.model).toBeNull();
    expect(abstainData.runtime.replySource).toBe('knowledge_abstention');
    expect(abstainData.runtime.evidence.reason).toBe('no_matches');

    // Escalate with returned conversationId
    const escRes = await fetch(`${base}/thruline/v1/support/escalate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        conversationId: chatData.runtime.conversationId,
        subject: 'Need human help',
        reason: 'Bot abstained',
      }),
    });
    expect(escRes.status).toBe(201);

    // 7. Archive source -> replay of http-cited-1 returns 409 knowledge_context_changed without calling provider
    const patchRes = await consoleReq(`/sources/${source.id}`, {
      method: 'PATCH',
      token: editorToken,
      body: { expectedVersion: afterImport.version + 1, status: 'archived' },
    });
    expect(patchRes.status).toBe(200);

    const callsBeforeReplay = completion.mock.calls.length;
    const staleReplay = await fetch(`${base}/thruline/v1/support/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://partner.example',
        'X-Support-Tenant-Key': tenantA.publicKey,
        'X-Support-Context-Token': customerTokenA,
      },
      body: JSON.stringify({
        requestId: 'http-cited-1',
        messages: [{ role: 'user', content: 'How fast is express shipping?' }],
      }),
    });
    expect(staleReplay.status).toBe(409);
    const staleErr = (await staleReplay.json()) as { error: { code: string } };
    expect(staleErr.error.code).toBe('knowledge_context_changed');
    expect(completion.mock.calls.length).toBe(callsBeforeReplay);

    // 8. History GET redacts revoked cited answer
    const histRes = await fetch(
      `${base}/thruline/v1/support/conversations/${chatData.runtime.conversationId}`,
      {
        headers: {
          Origin: 'https://partner.example',
          'X-Support-Tenant-Key': tenantA.publicKey,
          'X-Support-Context-Token': customerTokenA,
        },
      },
    );
    expect(histRes.status).toBe(200);
    const histData = (await histRes.json()) as {
      conversation: { messages: Array<{ evidence?: { status: string; citations: unknown[] } }> };
    };
    expect(histData.conversation.messages[1].evidence?.status).toBe('redacted');
    expect(histData.conversation.messages[1].evidence?.citations).toEqual([]);
  });

  it('exposes evaluation suites and runs with zero provider/quota side effects', async () => {
    const createSuite = await consoleReq('/suites', {
      method: 'POST',
      token: editorToken,
      body: {
        name: 'Smoke Suite',
        cases: [
          {
            id: 'case-1',
            query: 'unknown topic',
            role: 'guest',
            expectedSourceIds: [],
            forbiddenSourceIds: [],
            expectAbstention: true,
          },
        ],
      },
    });
    expect(createSuite.status).toBe(201);
    const { suite } = (await createSuite.json()) as { suite: { id: string; version: number } };

    // Reject non-empty body on /runs
    const badRun = await consoleReq(`/suites/${suite.id}/runs`, {
      method: 'POST',
      token: editorToken,
      body: { model: 'gpt-4o' },
    });
    expect(badRun.status).toBe(400);

    // Run with empty body -> 201
    const runRes = await consoleReq(`/suites/${suite.id}/runs`, {
      method: 'POST',
      token: editorToken,
      body: {},
    });
    expect(runRes.status).toBe(201);
    const { run } = (await runRes.json()) as { run: { id: string; status: string; allPassed: boolean } };
    expect(run.status).toBe('completed');
    expect(run.allPassed).toBe(true);
    expect(completion).not.toHaveBeenCalled();

    const runsList = await consoleReq('/runs', { token: editorToken });
    expect(runsList.status).toBe(200);
    const { runs } = (await runsList.json()) as { runs: Array<{ id: string }> };
    expect(runs.some((r) => r.id === run.id)).toBe(true);
  });

  it('survives normal POST close during delayed remote import, and aborts on actual client disconnect (F07)', async () => {
    let delayMs = 50;
    const exportServer = http.createServer((_req, res) => {
      setTimeout(() => {
        if (!res.writableEnded) {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Remote exported knowledge body for delayed import test.');
        }
      }, delayMs);
    });
    await new Promise<void>((resolve) => exportServer.listen(0, '127.0.0.1', resolve));
    const exportOrigin = `http://127.0.0.1:${(exportServer.address() as { port: number }).port}`;
    vi.stubEnv('SUPPORT_TRUSTED_PARTNER_ORIGINS', exportOrigin);

    try {
      const createRes = await consoleReq('/sources', {
        method: 'POST',
        token: editorToken,
        body: { name: 'Remote Source', kind: 'url', allowedRoles: ['customer'] },
      });
      expect(createRes.status).toBe(201);
      const { source } = (await createRes.json()) as { source: { id: string; version: number } };

      // 1. Normal POST completes body before export finishes -> must succeed 201 (not falsely aborted by req close)
      const okImport = await consoleReq(`/sources/${source.id}/revisions`, {
        method: 'POST',
        token: editorToken,
        body: {
          expectedVersion: source.version,
          title: 'Delayed Export',
          format: 'text',
          url: `${exportOrigin}/doc.txt`,
        },
      });
      expect(okImport.status).toBe(201);
      const okData = (await okImport.json()) as { source: { version: number }; revision: { id: string } };
      expect(okData.source.version).toBe(source.version + 1);

      // 2. Actual client disconnect aborts delayed import and prevents late commit
      delayMs = 150;
      const ac = new AbortController();
      const abortTimer = setTimeout(() => ac.abort(), 30);
      await expect(
        fetch(
          `${base}/api/thruline/support/tenants/${tenantA.id}/knowledge-library/sources/${source.id}/revisions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${editorToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              expectedVersion: okData.source.version,
              title: 'Aborted Export',
              format: 'text',
              url: `${exportOrigin}/aborted.txt`,
            }),
            signal: ac.signal,
          },
        ),
      ).rejects.toThrow();
      clearTimeout(abortTimer);

      // Wait past exportServer delay and verify no late revision was committed
      await new Promise((r) => setTimeout(r, 200));
      const revsRes = await consoleReq(`/sources/${source.id}/revisions`, { token: editorToken });
      expect(revsRes.status).toBe(200);
      const { revisions } = (await revsRes.json()) as { revisions: Array<{ id: string }> };
      expect(revisions).toHaveLength(1);
      expect(revisions[0].id).toBe(okData.revision.id);
    } finally {
      await new Promise<void>((resolve, reject) =>
        exportServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
