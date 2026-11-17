import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  CONTEXT_POLICY_DEFAULT,
  CONTEXT_POLICY_LIMITS,
  CONTEXT_PRESETS,
} from '@freellmapi/shared/context-budget.js';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser } from '../../services/auth.js';
import { clearContextPolicyCache } from '../../custom/context-budget/policy.js';
import { permissionForAction } from '../../custom/permission-actions.js';

describe('context policy admin API routes', () => {
  let server: Server;
  let base: string;
  const realFetch = global.fetch;

  let ownerId: number;
  let ownerToken: string;
  let memberId: number;
  let memberToken: string;
  let profileId: number;

  function grantMember(permissions: string[]): void {
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(permissions), memberId);
  }

  async function api(
    path: string,
    opts: { method?: string; token?: string; body?: unknown } = {},
  ) {
    const res = await realFetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  function insertRequestRow(
    id: number,
    opts: { inputTokens: number; createdAt?: string; platform?: string; modelId?: string } = { inputTokens: 100 },
  ): void {
    const createdAt = opts.createdAt ?? new Date().toISOString().slice(0, 19).replace('T', ' ');
    getDb()
      .prepare(
        `INSERT INTO requests (id, platform, model_id, profile_id, status, input_tokens, output_tokens, latency_ms, created_at)
         VALUES (?, ?, ?, ?, 'success', ?, 50, 120, ?)`,
      )
      .run(id, opts.platform ?? 'groq', opts.modelId ?? 'llama-3.3-70b', profileId, opts.inputTokens, createdAt);
  }

  function insertReportRow(
    requestId: number,
    opts: {
      profileId?: number;
      modelKey?: string;
      contextWindow?: number | null;
      budgetTokens?: number;
      mandatoryTokens?: number;
      summaryTokens?: number;
      knowledgeTokens?: number;
      historyTokens?: number;
      estimatedTokens?: number;
      heuristicTokens?: number;
      historySent?: number;
      historyDropped?: number;
      knowledgeSent?: number;
      knowledgeDropped?: number;
      summaryUsed?: number;
      clientHistoryDropped?: number;
      refits?: number;
      createdAt?: string;
    } = {},
  ): void {
    const createdAt = opts.createdAt ?? new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO custom_context_reports (
           request_id, profile_id, end_user, conversation_key, model_key, context_window,
           budget_tokens, mandatory_tokens, summary_tokens, knowledge_tokens, history_tokens,
           estimated_tokens, heuristic_tokens, history_sent, history_dropped,
           knowledge_sent, knowledge_dropped, summary_used, client_history_dropped, refits, created_at
         ) VALUES (?, ?, NULL, 'conv-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        requestId,
        opts.profileId ?? profileId,
        opts.modelKey ?? 'groq:llama-3.3-70b',
        opts.contextWindow === undefined ? 32768 : opts.contextWindow,
        opts.budgetTokens ?? 14400,
        opts.mandatoryTokens ?? 200,
        opts.summaryTokens ?? 100,
        opts.knowledgeTokens ?? 0,
        opts.historyTokens ?? 1000,
        opts.estimatedTokens ?? 1300,
        opts.heuristicTokens ?? 1200,
        opts.historySent ?? 4,
        opts.historyDropped ?? 0,
        opts.knowledgeSent ?? 0,
        opts.knowledgeDropped ?? 0,
        opts.summaryUsed ?? 0,
        opts.clientHistoryDropped ?? 0,
        opts.refits ?? 0,
        createdAt,
      );
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    ownerId = createUser('context-owner@example.com', 'OwnerPass123!').userId;
    ownerToken = createSession(ownerId);
    memberId = createUser('context-member@example.com', 'MemberPass123!', 'member').userId;
    memberToken = createSession(memberId);

    const created = await api('/api/client-profiles', {
      method: 'POST',
      token: ownerToken,
      body: { name: 'context-profile', systemPrompt: 'You are a concise assistant.' },
    });
    expect(created.status).toBe(201);
    profileId = created.body.id;

    // Seed an enabled API key so built-in models for groq & google are servable.
    const enc = encrypt('test-key');
    getDb()
      .prepare(
        `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
         VALUES ('groq', 'g1', ?, ?, ?, 'healthy', 1)`,
      )
      .run(enc.encrypted, enc.iv, enc.authTag);
  });

  afterAll(() => {
    server?.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    clearContextPolicyCache();
    grantMember([]);
    const db = getDb();
    db.prepare('DELETE FROM custom_context_policies').run();
    db.prepare('DELETE FROM custom_context_reports').run();
    db.prepare('DELETE FROM custom_conversation_messages').run();
    db.prepare('DELETE FROM custom_conversations').run();
    db.prepare('DELETE FROM requests').run();
    db.prepare("DELETE FROM settings WHERE key = 'context_policy_default'").run();
    db.prepare(
      'UPDATE client_profiles SET conv_enabled = 0, conv_max_messages = 20, conv_max_chars = 12000, conv_summarize = 0, allowed_models = NULL WHERE id = ?',
    ).run(profileId);
  });

  describe('per-profile context policy CRUD', () => {
    it('returns inherited default policy and suggested=null when conversations are disabled', async () => {
      const res = await api(`/api/client-profiles/${profileId}/context-policy`, { token: ownerToken });
      expect(res.status).toBe(200);
      expect(res.body.policy.inherited).toBe(true);
      expect(res.body.policy.enabled).toBe(false);
      expect(res.body.policy.preset).toBe('balanced');
      expect(res.body.policy.maxInputTokens).toBe(CONTEXT_PRESETS.balanced.maxInputTokens);
      expect(res.body.suggested).toBeNull();
      expect(res.body.presets).toEqual(CONTEXT_PRESETS);
      expect(res.body.limits).toEqual(CONTEXT_POLICY_LIMITS);
    });

    it('returns non-null suggested when inherited and server conversations are enabled', async () => {
      getDb()
        .prepare('UPDATE client_profiles SET conv_enabled = 1, conv_max_chars = 12000, conv_summarize = 1 WHERE id = ?')
        .run(profileId);

      const res = await api(`/api/client-profiles/${profileId}/context-policy`, { token: ownerToken });
      expect(res.status).toBe(200);
      expect(res.body.policy.inherited).toBe(true);
      expect(res.body.suggested).toEqual({ maxInputTokens: 4000, summarize: true });
    });

    it('returns 404 profile_not_found for missing profile', async () => {
      const getRes = await api('/api/client-profiles/999999/context-policy', { token: ownerToken });
      expect(getRes.status).toBe(404);
      expect(getRes.body.code).toBe('profile_not_found');

      const putRes = await api('/api/client-profiles/999999/context-policy', {
        method: 'PUT',
        token: ownerToken,
        body: { enabled: true },
      });
      expect(putRes.status).toBe(404);
      expect(putRes.body.code).toBe('profile_not_found');

      const delRes = await api('/api/client-profiles/999999/context-policy', {
        method: 'DELETE',
        token: ownerToken,
      });
      expect(delRes.status).toBe(404);
      expect(delRes.body.code).toBe('profile_not_found');
    });

    it('saves policy with PUT, clears suggested, and reverts on DELETE 204', async () => {
      getDb()
        .prepare('UPDATE client_profiles SET conv_enabled = 1, conv_max_chars = 12000, conv_summarize = 1 WHERE id = ?')
        .run(profileId);

      const putRes = await api(`/api/client-profiles/${profileId}/context-policy`, {
        method: 'PUT',
        token: ownerToken,
        body: {
          enabled: true,
          preset: 'custom',
          maxInputTokens: 10000,
          outputReserveTokens: 1024,
          safetyMarginPct: 10,
          summarySharePct: 15,
          knowledgeSharePct: 25,
          dropBlockTurns: 4,
          summarize: true,
          clientHistoryMode: 'trim_on_overflow',
          knowledgeMinScore: 0.4,
        },
      });
      expect(putRes.status).toBe(200);
      expect(putRes.body.policy.inherited).toBe(false);
      expect(putRes.body.policy.enabled).toBe(true);
      expect(putRes.body.policy.maxInputTokens).toBe(10000);
      expect(putRes.body.policy.clientHistoryMode).toBe('trim_on_overflow');
      expect(putRes.body.suggested).toBeNull();

      const delRes = await api(`/api/client-profiles/${profileId}/context-policy`, {
        method: 'DELETE',
        token: ownerToken,
      });
      expect(delRes.status).toBe(204);

      const after = await api(`/api/client-profiles/${profileId}/context-policy`, { token: ownerToken });
      expect(after.status).toBe(200);
      expect(after.body.policy.inherited).toBe(true);
      expect(after.body.suggested).toEqual({ maxInputTokens: 4000, summarize: true });
    });

    it('validates PUT payloads with exact 400 error codes', async () => {
      const cases: Array<[unknown, string]> = [
        [{ preset: 'custom', maxInputTokens: 1500 }, 'context_policy_budget_too_small'],
        [{ preset: 'custom', summarySharePct: 50, knowledgeSharePct: 40 }, 'context_policy_shares_too_large'],
        [{ preset: 'saver', maxInputTokens: 16000 }, 'context_policy_preset_mismatch'],
        [{ preset: 'custom', safetyMarginPct: 99 }, 'context_policy_invalid'],
        [{ unknownField: 123 }, 'context_policy_invalid'],
      ];

      for (const [payload, expectedCode] of cases) {
        const res = await api(`/api/client-profiles/${profileId}/context-policy`, {
          method: 'PUT',
          token: ownerToken,
          body: payload,
        });
        expect(res.status, expectedCode).toBe(400);
        expect(res.body.code).toBe(expectedCode);
      }
    });
  });

  describe('context stats', () => {
    it('rejects days outside [1, 90] with 400', async () => {
      for (const bad of ['0', '91', '-5', 'abc', '7.5']) {
        const res = await api(`/api/client-profiles/${profileId}/context-stats?days=${bad}`, {
          token: ownerToken,
        });
        expect(res.status, `days=${bad}`).toBe(400);
      }
    });

    it('aggregates stats and excludes rows without real provider usage from estimateError', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const oldDay = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);

      // Row 1: trimmed, real usage (input_tokens=1100 vs heuristic=1500, estimated=1000 -> error 9.09%)
      insertRequestRow(101, { inputTokens: 1100, createdAt: `${today} 10:00:00` });
      insertReportRow(101, {
        budgetTokens: 4000,
        historyTokens: 600,
        estimatedTokens: 1000,
        heuristicTokens: 1500,
        historySent: 3,
        historyDropped: 6,
        summaryUsed: 1,
        createdAt: `${today}T10:00:00.000Z`,
      });

      // Row 2: untrimmed, NO real usage (input_tokens == heuristic_tokens -> excluded from estimateError)
      insertRequestRow(102, { inputTokens: 800, createdAt: `${today} 11:00:00` });
      insertReportRow(102, {
        budgetTokens: 4000,
        historyTokens: 400,
        estimatedTokens: 2000,
        heuristicTokens: 800,
        historySent: 2,
        historyDropped: 0,
        summaryUsed: 0,
        createdAt: `${today}T11:00:00.000Z`,
      });

      // Row 3: real usage with larger error (input_tokens=1000, estimated=1200 -> error 20%)
      insertRequestRow(103, { inputTokens: 1000, createdAt: `${today} 12:00:00` });
      insertReportRow(103, {
        budgetTokens: 4000,
        historyTokens: 800,
        estimatedTokens: 1200,
        heuristicTokens: 900,
        historySent: 4,
        historyDropped: 2,
        summaryUsed: 1,
        createdAt: `${today}T12:00:00.000Z`,
      });

      // Row 4: outside 7-day window -> must be excluded
      insertRequestRow(104, { inputTokens: 500, createdAt: `${oldDay} 10:00:00` });
      insertReportRow(104, {
        budgetTokens: 4000,
        estimatedTokens: 500,
        heuristicTokens: 400,
        createdAt: `${oldDay}T10:00:00.000Z`,
      });

      const res = await api(`/api/client-profiles/${profileId}/context-stats?days=7`, {
        token: ownerToken,
      });
      expect(res.status).toBe(200);
      expect(res.body.days).toBe(7);
      expect(res.body.requests).toBe(3);
      expect(res.body.avgInputTokens).toBe(Math.round((1000 + 2000 + 1200) / 3));
      expect(res.body.avgBudgetTokens).toBe(4000);
      expect(res.body.trimmedRate).toBeCloseTo(2 / 3, 2);
      expect(res.body.avgHistoryDropped).toBeCloseTo(8 / 3, 2);
      // Row 1 saved: 6 * (600/3) = 1200; Row 3 saved: 2 * (800/4) = 400 => 1600
      expect(res.body.savedTokens).toBe(1600);
      expect(res.body.summaryUsedRate).toBeCloseTo(2 / 3, 2);

      // Only rows 101 (~9.09%) and 103 (20%) have real usage; row 102 had input_tokens === heuristic_tokens
      expect(res.body.estimateError.samples).toBe(2);
      expect(res.body.estimateError.within15PctRate).toBeCloseTo(0.5, 2);
      expect(res.body.estimateError.p50Pct).toBeCloseTo(9.09, 1);
      expect(res.body.estimateError.p95Pct).toBeCloseTo(20, 1);

      expect(res.body.byDay).toHaveLength(1);
      expect(res.body.byDay[0]).toMatchObject({
        day: today,
        requests: 3,
      });
    });
  });

  describe('context preview', () => {
    it('returns 409 context_policy_disabled when policy is off', async () => {
      const res = await api(`/api/client-profiles/${profileId}/conversations/conv-a/context-preview`, {
        token: ownerToken,
      });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('context_policy_disabled');
    });

    it('returns 404 conversation_not_found when conversation does not exist', async () => {
      await api(`/api/client-profiles/${profileId}/context-policy`, {
        method: 'PUT',
        token: ownerToken,
        body: { enabled: true, preset: 'saver' },
      });

      const res = await api(`/api/client-profiles/${profileId}/conversations/missing-conv/context-preview`, {
        token: ownerToken,
      });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('conversation_not_found');
    });

    it('returns segments with <=200 char previews, valid reasons, no provider calls, and no DB writes', async () => {
      const db = getDb();
      db.prepare('UPDATE client_profiles SET conv_enabled = 1, conv_max_messages = 8, conv_summarize = 1 WHERE id = ?').run(profileId);
      await api(`/api/client-profiles/${profileId}/context-policy`, {
        method: 'PUT',
        token: ownerToken,
        body: {
          enabled: true,
          preset: 'custom',
          maxInputTokens: 2000,
          outputReserveTokens: 512,
          safetyMarginPct: 10,
          summarySharePct: 15,
          knowledgeSharePct: 0,
          dropBlockTurns: 2,
          summarize: true,
        },
      });

      const nowIso = new Date().toISOString();
      const convInfo = db
        .prepare(
          `INSERT INTO custom_conversations (profile_id, conv_key, end_user, summary, summarized_through, message_count, chars, created_at, updated_at)
           VALUES (?, 'conv-preview', 'user-1', 'Customer Alice asked about order #99.', 2, 12, 5000, ?, ?)`,
        )
        .run(profileId, nowIso, nowIso);
      const convId = Number(convInfo.lastInsertRowid);

      const longUserText = `Tin nhắn dài ${'ế'.repeat(900)}`;
      const longAssistantText = `Trả lời dài ${'á'.repeat(900)}`;
      const msgIds: number[] = [];
      for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? 'user' : 'assistant';
        const content = role === 'user' ? `${i}:${longUserText}` : `${i}:${longAssistantText}`;
        const info = db
          .prepare(
            'INSERT INTO custom_conversation_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(convId, role, content, nowIso);
        msgIds.push(Number(info.lastInsertRowid));
      }
      // Mark first two as already summarized
      db.prepare('UPDATE custom_conversations SET summarized_through = ? WHERE id = ?').run(msgIds[1]!, convId);

      const fetchSpy = vi.spyOn(global, 'fetch');
      const res = await api(
        `/api/client-profiles/${profileId}/conversations/conv-preview/context-preview?endUser=user-1`,
        { token: ownerToken },
      );

      expect(res.status).toBe(200);
      // Zero external provider calls via global.fetch (our test helper uses realFetch directly).
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(res.body.model).toBeTruthy();
      expect(typeof res.body.model.key).toBe('string');
      expect(res.body.budget.effective).toBeLessThanOrEqual(2000);
      expect(res.body.budget.mandatory).toBeGreaterThan(0);
      expect(Array.isArray(res.body.segments)).toBe(true);
      expect(res.body.summary).toMatchObject({
        coversThroughMessageId: msgIds[1],
      });
      expect(res.body.summary.pendingFoldMessages).toBeGreaterThanOrEqual(2);
      expect(typeof res.body.knowledgeNote).toBe('string');

      const allowedReasons = new Set(['budget', 'block_alignment', 'leading_assistant', 'max_messages']);
      for (const seg of res.body.segments) {
        expect(seg.preview.length).toBeLessThanOrEqual(200);
        if (!seg.sent) {
          expect(allowedReasons.has(seg.reason)).toBe(true);
        }
      }
      expect(res.body.segments.some((s: any) => !s.sent && s.reason === 'max_messages')).toBe(true);
      expect(res.body.segments.some((s: any) => !s.sent && s.reason === 'budget')).toBe(true);

      // Explicit model query param selects that model's key & context window
      const explicitModelRes = await api(
        `/api/client-profiles/${profileId}/conversations/conv-preview/context-preview?endUser=user-1&model=groq:llama-3.3-70b-versatile`,
        { token: ownerToken },
      );
      expect(explicitModelRes.status).toBe(200);
      expect(explicitModelRes.body.model.key).toBe('groq:llama-3.3-70b-versatile');

      // Mismatched endUser returns 404 conversation_not_found
      const mismatchRes = await api(
        `/api/client-profiles/${profileId}/conversations/conv-preview/context-preview?endUser=other-user`,
        { token: ownerToken },
      );
      expect(mismatchRes.status).toBe(404);
      expect(mismatchRes.body.code).toBe('conversation_not_found');

      // Verify DB was not mutated (still 12 messages, same updated_at)
      const countRow = db
        .prepare('SELECT COUNT(*) AS n FROM custom_conversation_messages WHERE conversation_id = ?')
        .get(convId) as { n: number };
      expect(countRow.n).toBe(12);
    });
  });

  describe('system default context policy settings', () => {
    it('reads and updates /api/settings/context-policy and validates inputs', async () => {
      const initial = await api('/api/settings/context-policy', { token: ownerToken });
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual(CONTEXT_POLICY_DEFAULT);

      const updated = await api('/api/settings/context-policy', {
        method: 'PUT',
        token: ownerToken,
        body: { enabled: true, preset: 'saver', fallbackWindowTokens: 16384, imageTokens: 512 },
      });
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({
        enabled: true,
        preset: 'saver',
        fallbackWindowTokens: 16384,
        imageTokens: 512,
      });

      const inheritedProfile = await api(`/api/client-profiles/${profileId}/context-policy`, { token: ownerToken });
      expect(inheritedProfile.status).toBe(200);
      expect(inheritedProfile.body.policy.inherited).toBe(true);
      expect(inheritedProfile.body.policy.enabled).toBe(true);
      expect(inheritedProfile.body.policy.preset).toBe('saver');

      const bad = await api('/api/settings/context-policy', {
        method: 'PUT',
        token: ownerToken,
        body: { preset: 'custom' },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('context_policy_invalid');
    });
  });

  describe('per-request context report', () => {
    it('returns 404 context_report_not_found when absent and 200 ContextAssemblySummary when present', async () => {
      const missing = await api(`/api/client-profiles/${profileId}/requests/9999/context`, {
        token: ownerToken,
      });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('context_report_not_found');

      const createdAt = '2026-11-17T08:00:00.000Z';
      insertRequestRow(501, { inputTokens: 1350 });
      insertReportRow(501, {
        modelKey: 'groq:llama-3.3-70b',
        contextWindow: 32768,
        budgetTokens: 14400,
        mandatoryTokens: 310,
        summaryTokens: 402,
        knowledgeTokens: 180,
        historyTokens: 840,
        estimatedTokens: 1732,
        heuristicTokens: 1600,
        historySent: 6,
        historyDropped: 4,
        knowledgeSent: 2,
        knowledgeDropped: 1,
        summaryUsed: 1,
        clientHistoryDropped: 0,
        refits: 1,
        createdAt,
      });

      const found = await api(`/api/client-profiles/${profileId}/requests/501/context`, {
        token: ownerToken,
      });
      expect(found.status).toBe(200);
      expect(found.body).toEqual({
        budget: 14400,
        window: 32768,
        mandatory: 310,
        summary: 402,
        knowledge: 180,
        history: 840,
        histSent: 6,
        histDropped: 4,
        kbSent: 2,
        kbDropped: 1,
        clientDropped: 0,
        refits: 1,
        estimatedTokens: 1732,
        heuristicTokens: 1600,
        modelKey: 'groq:llama-3.3-70b',
        createdAt,
      });
    });
  });

  describe('RBAC permissions and audit log', () => {
    it('maps context-preview to edit_client_profiles and /api/settings/context-policy to view/edit_settings', () => {
      expect(permissionForAction('manage_settings', 'GET', `/api/client-profiles/${profileId}/context-policy`)).toBe('view_client_profiles');
      expect(permissionForAction('manage_settings', 'PUT', `/api/client-profiles/${profileId}/context-policy`)).toBe('edit_client_profiles');
      expect(permissionForAction('manage_settings', 'GET', `/api/client-profiles/${profileId}/context-stats`)).toBe('view_client_profiles');
      expect(permissionForAction('manage_settings', 'GET', `/api/client-profiles/${profileId}/requests/1/context`)).toBe('view_client_profiles');
      expect(permissionForAction('manage_settings', 'GET', `/api/client-profiles/${profileId}/conversations/c1/context-preview`)).toBe('edit_client_profiles');
      expect(permissionForAction('manage_settings', 'GET', '/api/settings/context-policy')).toBe('view_settings');
      expect(permissionForAction('manage_settings', 'PUT', '/api/settings/context-policy')).toBe('edit_settings');
    });

    it('allows view_client_profiles on policy/stats/report reads but denies PUT, DELETE, and preview with 403', async () => {
      grantMember(['view_client_profiles']);

      expect((await api(`/api/client-profiles/${profileId}/context-policy`, { token: memberToken })).status).toBe(200);
      expect((await api(`/api/client-profiles/${profileId}/context-stats`, { token: memberToken })).status).toBe(200);
      expect((await api(`/api/client-profiles/${profileId}/requests/999/context`, { token: memberToken })).status).toBe(404);

      expect(
        (await api(`/api/client-profiles/${profileId}/context-policy`, {
          method: 'PUT',
          token: memberToken,
          body: { enabled: true },
        })).status,
      ).toBe(403);

      expect(
        (await api(`/api/client-profiles/${profileId}/context-policy`, {
          method: 'DELETE',
          token: memberToken,
        })).status,
      ).toBe(403);

      expect(
        (await api(`/api/client-profiles/${profileId}/conversations/c1/context-preview`, {
          token: memberToken,
        })).status,
      ).toBe(403);
    });

    it('enforces view_settings vs edit_settings on /api/settings/context-policy', async () => {
      grantMember(['view_settings']);
      expect((await api('/api/settings/context-policy', { token: memberToken })).status).toBe(200);
      expect(
        (await api('/api/settings/context-policy', {
          method: 'PUT',
          token: memberToken,
          body: { enabled: true },
        })).status,
      ).toBe(403);

      grantMember(['edit_settings']);
      expect(
        (await api('/api/settings/context-policy', {
          method: 'PUT',
          token: memberToken,
          body: { enabled: true },
        })).status,
      ).toBe(200);
    });

    it('records policy and default changes in audit_log', async () => {
      const db = getDb();
      db.prepare('DELETE FROM custom_audit_log').run();

      await api(`/api/client-profiles/${profileId}/context-policy`, {
        method: 'PUT',
        token: ownerToken,
        body: { enabled: true, preset: 'saver' },
      });
      await api('/api/settings/context-policy', {
        method: 'PUT',
        token: ownerToken,
        body: { enabled: false },
      });

      const entries = db
        .prepare('SELECT method, route, status FROM custom_audit_log ORDER BY id ASC')
        .all() as Array<{ method: string; route: string; status: number }>;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'PUT',
            route: '/api/client-profiles/:id/context-policy',
            status: 200,
          }),
          expect.objectContaining({
            method: 'PUT',
            route: '/api/settings/context-policy',
            status: 200,
          }),
        ]),
      );
    });
  });
});
