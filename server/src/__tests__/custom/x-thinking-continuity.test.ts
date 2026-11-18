import http from 'node:http';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { createUser, createSession } from '../../services/auth.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { GoogleProvider } from '../../providers/google.js';
import { createApiKeyAccount, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { mintXGatewayClientKey } from '../../custom/x-gateway/client-keys.js';
import { createCombo, invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { resetRouteHealth, resetSessionPins } from '../../custom/x-gateway/router.js';
import {
  CLAUDE_THINKING_MEMORY_TTL_MS,
  GEMINI_THOUGHT_SIG_PERSISTED_MAX,
  MAX_CLAUDE_THINKING_TURN_BYTES,
  clearThinkingContinuityMemory,
  clearThinkingContinuityStore,
  getThinkingContinuityDiagnostics,
  getThinkingContinuityMode,
  getThinkingContinuitySnapshot,
  prunePersistedGeminiThoughtSignatures,
  recallGeminiThoughtSignature,
  restoreClaudeThinkingBlocks,
  setThinkingContinuityMode,
  storeClaudeThinkingBlocks,
  storeClaudeThinkingFromResponse,
  storeGeminiThoughtSignature,
} from '../../custom/x-gateway/thinking-store.js';
import {
  budgetTokensToEffort,
  effortToBudgetTokens,
  getThoughtSignatureModelFamily,
  normalizeClaudeThinkingModel,
  normalizeThinkingBudget,
  sanitizeForeignThinkingBlocks,
  spliceClaudeThinkingSegmentsIntoContent,
} from '../../custom/x-gateway/thinking-normalize.js';

function jsonRequest(
  port: number,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  pathname: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            json: parsed,
            raw,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('Spec 031: Cross-Turn Reasoning & Thought-Signature Continuity Store', () => {
  let server: Server;
  let port = 0;
  let adminSessionToken = '';
  let gatewayClientKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    adminSessionToken = mintDashboardToken('thinking-admin@example.com');

    const adminRow = getDb()
      .prepare('SELECT id FROM users WHERE email = ?')
      .get('thinking-admin@example.com') as { id: number };
    setEnabled(true, adminRow.id);
    const minted = mintXGatewayClientKey(adminRow.id, 'Thinking Test Key');
    gatewayClientKey = minted.key;

    const app = createApp();
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    setThinkingContinuityMode('enabled');
    clearThinkingContinuityStore({ resetDiagnostics: true });
    getDb().prepare('DELETE FROM x_gateway_keys').run();
    getDb().prepare('DELETE FROM x_gateway_combos').run();
    invalidateXGatewayKeyCache();
    invalidateConfigCache();
    resetRouteHealth();
    resetSessionPins();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. SQLite Persistence Across In-Memory Cache Clear & Bounds
  // ───────────────────────────────────────────────────────────────────────────

  it('persists Gemini thought signatures to SQLite and restores across memory cache clears', async () => {
    const stored = storeGeminiThoughtSignature({
      namespace: 'acct:11',
      model: 'gemini-2.5-pro',
      provider: 'google',
      toolCallId: 'call_weather_1',
      signature: 'R2VtaW5pU2lnbmF0dXJlXzAx',
      name: 'get_weather',
      callArgs: '{"city":"Hanoi","unit":"celsius"}',
    });
    expect(stored).toBe(true);

    const beforeClear = getThinkingContinuitySnapshot();
    expect(beforeClear.diagnostics.geminiStored).toBe(1);
    expect(beforeClear.diagnostics.memoryEntries).toBe(2); // id key + call fingerprint key
    expect(beforeClear.persistedEntries).toBe(2);

    // Simulate process restart: clear in-memory LRU while keeping SQLite rows intact
    clearThinkingContinuityMemory();
    expect(getThinkingContinuityDiagnostics().memoryEntries).toBe(0);
    expect(getThinkingContinuitySnapshot().persistedEntries).toBe(2);

    // Recall by exact toolCallId -> hits SQLite and warms memory
    const hitById = recallGeminiThoughtSignature({
      namespace: 'acct:11',
      model: 'gemini-2.5-flash',
      provider: 'google',
      toolCallId: 'call_weather_1',
    });
    expect(hitById).toBe('R2VtaW5pU2lnbmF0dXJlXzAx');

    const afterIdRecall = getThinkingContinuityDiagnostics();
    expect(afterIdRecall.geminiPersistedHits).toBe(1);
    expect(afterIdRecall.geminiRestored).toBe(1);
    expect(afterIdRecall.memoryEntries).toBe(1);

    // Clear memory again and recall via rewritten tool ID using canonical args (reordered JSON keys)
    clearThinkingContinuityMemory();
    const hitByFingerprint = recallGeminiThoughtSignature({
      namespace: 'acct:11',
      model: 'gemini-3-pro',
      provider: 'google',
      toolCallId: 'toolu_rewritten_999',
      name: 'get_weather',
      callArgs: { unit: 'celsius', city: 'Hanoi' },
    });
    expect(hitByFingerprint).toBe('R2VtaW5pU2lnbmF0dXJlXzAx');
    expect(getThinkingContinuityDiagnostics().geminiPersistedHits).toBe(2);
    expect(getThinkingContinuityDiagnostics().geminiRestored).toBe(2);
  });

  it('recovers GoogleProvider thought_signature from SQLite after in-memory cache clear', async () => {
    const google = new GoogleProvider();
    const capturedBodies: any[] = [];

    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBodies.push(JSON.parse((init as RequestInit).body as string));
      if (capturedBodies.length === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      thoughtSignature: 'R29vZ2xlUHJvdmlkZXJPersistedSig==',
                      functionCall: {
                        id: 'gcall_77',
                        name: 'lookup_order',
                        args: { orderId: 'ORD-77' },
                      },
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Order ORD-77 is shipped.' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 6, totalTokenCount: 21 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    // Turn 1: GoogleProvider emits tool call + thoughtSignature -> persisted to SQLite
    await google.chatCompletion(
      'google-api-key-alpha',
      [{ role: 'user', content: 'Check ORD-77' }],
      'gemini-2.5-pro',
    );
    expect(getThinkingContinuityDiagnostics().geminiStored).toBe(1);

    // Wipe in-memory LRU cache to simulate server restart
    clearThinkingContinuityMemory();
    expect(getThinkingContinuityDiagnostics().memoryEntries).toBe(0);

    // Turn 2: OpenAI client echoes tool_calls WITHOUT thought_signature
    await google.chatCompletion(
      'google-api-key-alpha',
      [
        { role: 'user', content: 'Check ORD-77' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'gcall_77',
              type: 'function',
              function: { name: 'lookup_order', arguments: '{"orderId":"ORD-77"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'gcall_77', content: '{"status":"shipped"}' },
      ],
      'gemini-2.5-pro',
    );

    const modelTurn = capturedBodies[1].contents.find((c: any) => c.role === 'model');
    expect(modelTurn.parts[0].thoughtSignature).toBe('R29vZ2xlUHJvdmlkZXJPersistedSig==');
    expect(getThinkingContinuityDiagnostics().geminiPersistedHits).toBe(1);
  });

  it('prunes expired SQLite rows and enforces the 2,000-row persisted cap', () => {
    const baseNow = 1_700_000_000_000;

    // Insert 2,010 distinct toolCallIds into custom_x_thought_signatures
    for (let i = 0; i < GEMINI_THOUGHT_SIG_PERSISTED_MAX + 10; i += 1) {
      storeGeminiThoughtSignature({
        namespace: 'acct:cap',
        model: 'gemini-2.5-flash',
        toolCallId: `call_cap_${i}`,
        signature: `sig_cap_${i}`,
        now: baseNow + i,
      });
    }

    const countRow = getDb()
      .prepare('SELECT COUNT(*) AS cnt FROM custom_x_thought_signatures')
      .get() as { cnt: number };
    expect(countRow.cnt).toBeLessThanOrEqual(GEMINI_THOUGHT_SIG_PERSISTED_MAX);

    // Oldest entry (`call_cap_0`) should be evicted while newest (`call_cap_2009`) survives
    clearThinkingContinuityMemory();
    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:cap',
        model: 'gemini-2.5-flash',
        toolCallId: 'call_cap_0',
        now: baseNow + 5_000,
      }),
    ).toBeNull();
    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:cap',
        model: 'gemini-2.5-flash',
        toolCallId: `call_cap_${GEMINI_THOUGHT_SIG_PERSISTED_MAX + 9}`,
        now: baseNow + 5_000,
      }),
    ).toBe(`sig_cap_${GEMINI_THOUGHT_SIG_PERSISTED_MAX + 9}`);

    // Advance clock past 30-day persisted TTL -> prune removes all expired rows
    const deleted = prunePersistedGeminiThoughtSignatures(baseNow + 31 * 24 * 60 * 60 * 1_000);
    expect(deleted).toBeGreaterThan(0);
    expect(getThinkingContinuitySnapshot(baseNow + 31 * 24 * 60 * 60 * 1_000).persistedEntries).toBe(0);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Family-Mismatch Protection (`claude` vs `gemini`)
  // ───────────────────────────────────────────────────────────────────────────

  it('never replays a claude-family signature to gemini or vice versa (memory & SQLite)', async () => {
    expect(getThoughtSignatureModelFamily('claude-sonnet-4-5-20250929', 'antigravity')).toBe('claude');
    expect(getThoughtSignatureModelFamily('gemini-2.5-pro', 'antigravity')).toBe('gemini');

    storeGeminiThoughtSignature({
      namespace: 'acct:shared-ag',
      model: 'claude-sonnet-4-5',
      provider: 'antigravity',
      toolCallId: 'call_shared_42',
      signature: 'ClaudeFamilySig_DoNotSendToGemini',
      name: 'run_sql',
      callArgs: '{"query":"SELECT 1"}',
    });

    // Memory lookup from Gemini family on same connection + toolCallId + args -> MUST miss
    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:shared-ag',
        model: 'gemini-2.5-pro',
        provider: 'antigravity',
        toolCallId: 'call_shared_42',
        name: 'run_sql',
        callArgs: '{"query":"SELECT 1"}',
      }),
    ).toBeNull();

    // SQLite lookup after memory clear from Gemini family -> MUST also miss
    clearThinkingContinuityMemory();
    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:shared-ag',
        model: 'gemini-2.5-pro',
        provider: 'antigravity',
        toolCallId: 'call_shared_42',
        name: 'run_sql',
        callArgs: '{"query":"SELECT 1"}',
      }),
    ).toBeNull();

    // Same-family (`claude`) lookup on same connection -> hits SQLite cleanly
    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:shared-ag',
        model: 'claude-opus-4-6',
        provider: 'antigravity',
        toolCallId: 'call_shared_42',
      }),
    ).toBe('ClaudeFamilySig_DoNotSendToGemini');

    // If a client explicitly echoes a claude-minted thought_signature into GoogleProvider,
    // GoogleProvider strips the foreign signature and falls back to the skip-validation sentinel.
    const google = new GoogleProvider();
    let sentBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      sentBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    await google.chatCompletion(
      'google-key',
      [
        { role: 'user', content: 'Run query' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_shared_42',
              type: 'function',
              function: { name: 'run_sql', arguments: '{"query":"SELECT 1"}' },
              thought_signature: 'ClaudeFamilySig_DoNotSendToGemini',
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_shared_42', content: '{"ok":true}' },
      ],
      'gemini-2.5-pro',
    );

    const modelMsg = sentBody.contents.find((c: any) => c.role === 'model');
    expect(modelMsg.parts[0].thoughtSignature).toBe('context_engineering_is_the_way_to_go');
    expect(getThinkingContinuityDiagnostics().foreignSignaturesStripped).toBeGreaterThanOrEqual(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Claude Signed-Thinking Store: Org/Connection Binding & Alias Normalization
  // ───────────────────────────────────────────────────────────────────────────

  it('binds Claude signed thinking + redacted_thinking strictly to (provider, normalizedModel, connectionId) in memory only', () => {
    expect(normalizeClaudeThinkingModel('claude/claude-sonnet-4-5-20250929(high)')).toBe(
      'claude-sonnet-4-5',
    );
    expect(normalizeClaudeThinkingModel('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5');

    const stored = storeClaudeThinkingFromResponse(
      {
        id: 'msg_turn_1',
        model: 'claude-sonnet-4-5-20250929',
        content: [
          {
            type: 'thinking',
            thinking: 'First inspect repository layout.',
            signature: 'ErkBCkY_claude_orgA_sig_1',
          },
          {
            type: 'redacted_thinking',
            data: 'EmwK_encrypted_redacted_1',
          },
          {
            type: 'text',
            text: 'Checking files now.',
          },
          {
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'read_file',
            input: { path: 'README.md' },
          },
          {
            type: 'thinking',
            thinking: 'Also check package.json.',
            signature: 'ErkBCkY_claude_orgA_sig_2',
          },
          {
            type: 'tool_use',
            id: 'toolu_read_2',
            name: 'read_file',
            input: { path: 'package.json' },
          },
        ],
      },
      {
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: 'conn-org-a',
      },
    );
    expect(stored).toBe(true);
    expect(getThinkingContinuityDiagnostics().claudeTurnsStored).toBe(1);

    // Memory-only invariant: zero Claude thinking entries ever touch SQLite!
    expect(getThinkingContinuitySnapshot().persistedEntries).toBe(0);

    // 1. Undated alias (`claude-sonnet-4-5`) on SAME provider + connection restores exact segments
    const restored = restoreClaudeThinkingBlocks({
      toolUseIds: ['toolu_read_1', 'toolu_read_2'],
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      connectionId: 'conn-org-a',
    });
    expect(restored).toEqual([
      {
        toolUseId: 'toolu_read_1',
        blocks: [
          {
            type: 'thinking',
            thinking: 'First inspect repository layout.',
            signature: 'ErkBCkY_claude_orgA_sig_1',
          },
          {
            type: 'redacted_thinking',
            data: 'EmwK_encrypted_redacted_1',
          },
        ],
      },
      {
        toolUseId: 'toolu_read_2',
        blocks: [
          {
            type: 'thinking',
            thinking: 'Also check package.json.',
            signature: 'ErkBCkY_claude_orgA_sig_2',
          },
        ],
      },
    ]);
    expect(getThinkingContinuityDiagnostics().claudeTurnsRestored).toBe(1);

    // Verify exact segment splicing order ahead of each corresponding tool_use block
    const spliced = spliceClaudeThinkingSegmentsIntoContent(
      [
        { type: 'text', text: 'Checking files now.' },
        { type: 'tool_use', id: 'toolu_read_1', name: 'read_file', input: { path: 'README.md' } },
        { type: 'tool_use', id: 'toolu_read_2', name: 'read_file', input: { path: 'package.json' } },
      ],
      restored,
    );
    expect(spliced.map(b => b.type)).toEqual([
      'text',
      'thinking',
      'redacted_thinking',
      'tool_use',
      'thinking',
      'tool_use',
    ]);

    // 2. Different OAuth org / connectionId MUST NOT restore
    expect(
      restoreClaudeThinkingBlocks({
        toolUseIds: ['toolu_read_1'],
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: 'conn-org-b',
      }),
    ).toBeNull();

    // 3. Different Claude model family/tier MUST NOT restore
    expect(
      restoreClaudeThinkingBlocks({
        toolUseIds: ['toolu_read_1'],
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
        connectionId: 'conn-org-a',
      }),
    ).toBeNull();

    // 4. Different provider MUST NOT restore
    expect(
      restoreClaudeThinkingBlocks({
        toolUseIds: ['toolu_read_1'],
        provider: 'bedrock',
        model: 'claude-sonnet-4-5',
        connectionId: 'conn-org-a',
      }),
    ).toBeNull();

    // 5. Missing connectionId MUST refuse to store or restore
    expect(
      storeClaudeThinkingBlocks({
        content: [
          { type: 'thinking', thinking: 'x', signature: 'sig' },
          { type: 'tool_use', id: 'toolu_unbound', name: 'fn', input: {} },
        ],
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: '',
      }),
    ).toBe(false);

    // 6. Oversized >2MB single turn is rejected
    expect(
      storeClaudeThinkingBlocks({
        content: [
          {
            type: 'thinking',
            thinking: 'a'.repeat(MAX_CLAUDE_THINKING_TURN_BYTES + 128),
            signature: 'sig_oversized',
          },
          { type: 'tool_use', id: 'toolu_huge', name: 'fn', input: {} },
        ],
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: 'conn-org-a',
      }),
    ).toBe(false);

    // 7. Expired entry after 1h TTL is pruned
    const future = Date.now() + CLAUDE_THINKING_MEMORY_TTL_MS + 1_000;
    expect(
      restoreClaudeThinkingBlocks({
        toolUseIds: ['toolu_read_1'],
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: 'conn-org-a',
        now: future,
      }),
    ).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Foreign Block Stripping on Failover & Budget Normalization
  // ───────────────────────────────────────────────────────────────────────────

  it('strips incompatible thinking/redacted_thinking blocks and foreign thoughtSignature fields on failover', () => {
    storeClaudeThinkingBlocks({
      content: [
        { type: 'thinking', thinking: 'org1 thought', signature: 'sig_claude_org1' },
        { type: 'redacted_thinking', data: 'redacted_org1' },
        { type: 'tool_use', id: 'toolu_f1', name: 'search', input: { q: 'test' } },
      ],
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      connectionId: '10',
    });

    storeGeminiThoughtSignature({
      accountId: 20,
      model: 'gemini-2.5-pro',
      provider: 'gemini',
      toolCallId: 'call_g1',
      signature: 'GeminiSig_Acct20',
      name: 'search',
      callArgs: '{"q":"test"}',
    });

    const mixedHistory = [
      { role: 'user', content: 'Search test' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'org1 thought', signature: 'sig_claude_org1' },
          { type: 'redacted_thinking', data: 'redacted_org1' },
          { type: 'text', text: 'Searching...' },
          {
            type: 'tool_use',
            id: 'toolu_f1',
            name: 'search',
            input: { q: 'test' },
            thoughtSignature: 'GeminiSig_Acct20',
          },
        ],
        tool_calls: [
          {
            id: 'toolu_f1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"test"}' },
            thought_signature: 'GeminiSig_Acct20',
          },
        ],
      },
    ];

    // Failover to OpenAI (`gpt-4o`): strips BOTH Claude thinking blocks AND Gemini thoughtSignature fields
    const forOpenAi = sanitizeForeignThinkingBlocks(mixedHistory, {
      provider: 'openai',
      model: 'gpt-4o',
      connectionId: '30',
      isFailover: true,
    });
    expect(forOpenAi.strippedCount).toBe(4);
    expect((forOpenAi.messages[1]!.content as any[]).map(b => b.type)).toEqual(['text', 'tool_use']);
    expect((forOpenAi.messages[1]!.content as any[])[1].thoughtSignature).toBeUndefined();
    expect((forOpenAi.messages[1]!.tool_calls as any[])[0].thought_signature).toBeUndefined();

    // Failover from Claude Account #10 to Claude Account #99: strips Account #10's org-bound thinking blocks
    const forOtherClaudeOrg = sanitizeForeignThinkingBlocks(mixedHistory, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      connectionId: '99',
      isFailover: true,
    });
    expect((forOtherClaudeOrg.messages[1]!.content as any[]).map(b => b.type)).toEqual([
      'text',
      'tool_use',
    ]);
    expect(getThinkingContinuityDiagnostics().foreignSignaturesStripped).toBeGreaterThanOrEqual(6);
  });

  it('normalizes reasoning_effort <-> thinking.budget_tokens while enforcing budget_tokens < max_tokens', () => {
    expect(effortToBudgetTokens('minimal')).toBe(512);
    expect(effortToBudgetTokens('low')).toBe(1024);
    expect(effortToBudgetTokens('medium')).toBe(8192);
    expect(effortToBudgetTokens('high')).toBe(24576);
    expect(effortToBudgetTokens('xhigh')).toBe(32768);
    expect(effortToBudgetTokens('max')).toBe(128000);

    expect(budgetTokensToEffort(0)).toBe('none');
    expect(budgetTokensToEffort(-1)).toBe('auto');
    expect(budgetTokensToEffort(1024)).toBe('low');
    expect(budgetTokensToEffort(8192)).toBe('medium');
    expect(budgetTokensToEffort(24576)).toBe('high');

    // High effort (24,576) with maxTokens=4,096 MUST clamp budget_tokens strictly < max_tokens (4,095 < 4,096)
    const clampedHigh = normalizeThinkingBudget({
      effort: 'high',
      maxTokens: 4096,
      targetFamily: 'claude',
    });
    expect(clampedHigh.budgetTokens).toBe(4095);
    expect(clampedHigh.maxTokens).toBe(4096);
    expect(clampedHigh.budgetTokens!).toBeLessThan(clampedHigh.maxTokens!);
    expect(clampedHigh.clampedBudget).toBe(true);
    expect(clampedHigh.anthropicThinking).toEqual({
      type: 'enabled',
      budget_tokens: 4095,
    });

    // Explicit thinking.budget_tokens >= max_tokens clamps to max_tokens - 1
    const clampedExplicit = normalizeThinkingBudget({
      thinking: { type: 'enabled', budget_tokens: 8000 },
      maxTokens: 4000,
      targetFamily: 'claude',
    });
    expect(clampedExplicit.budgetTokens).toBe(3999);
    expect(clampedExplicit.budgetTokens!).toBeLessThan(clampedExplicit.maxTokens!);

    // Tight max_tokens (< 1025 on Claude) disables manual budget thinking cleanly instead of 400ing
    const tooSmallForClaude = normalizeThinkingBudget({
      effort: 'medium',
      maxTokens: 512,
      targetFamily: 'claude',
    });
    expect(tooSmallForClaude.mode).toBe('none');
    expect(tooSmallForClaude.budgetTokens).toBe(0);
    expect(tooSmallForClaude.anthropicThinking).toEqual({ type: 'disabled' });

    // Omitted max_tokens allocates headroom so budget_tokens < max_tokens still holds
    const withHeadroom = normalizeThinkingBudget({
      effort: 'medium',
      targetFamily: 'claude',
    });
    expect(withHeadroom.budgetTokens).toBe(8192);
    expect(withHeadroom.maxTokens).toBe(12288);
    expect(withHeadroom.budgetTokens!).toBeLessThan(withHeadroom.maxTokens!);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. End-to-End Thruline Protocol Continuity (`/chat/completions`, `/responses`, `/messages`)
  // ───────────────────────────────────────────────────────────────────────────

  it('restores Claude signed thinking across multi-turn tool loops on /thruline/v1/chat/completions and /thruline/v1/responses', async () => {
    createApiKeyAccount({
      provider: 'anthropic',
      key: 'sk-ant-continuity-key',
      label: 'Claude Continuity',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    });

    const anthropicUpstreamBodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      const reqBody = JSON.parse((init as RequestInit).body as string);
      anthropicUpstreamBodies.push(reqBody);

      if (anthropicUpstreamBodies.length === 1 || anthropicUpstreamBodies.length === 3) {
        const callId = anthropicUpstreamBodies.length === 1 ? 'toolu_chat_1' : 'toolu_resp_1';
        return new Response(
          JSON.stringify({
            id: `msg_${anthropicUpstreamBodies.length}`,
            type: 'message',
            role: 'assistant',
            // Echo dated snapshot ID while client requested undated alias!
            model: 'claude-sonnet-4-5-20250929',
            content: [
              {
                type: 'thinking',
                thinking: 'Need to call get_server_status first.',
                signature: `Sig_Turn_${anthropicUpstreamBodies.length}`,
              },
              {
                type: 'redacted_thinking',
                data: `Redacted_Turn_${anthropicUpstreamBodies.length}`,
              },
              {
                type: 'tool_use',
                id: callId,
                name: 'get_server_status',
                input: { region: 'ap-southeast-1' },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 25, output_tokens: 18 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify({
          id: `msg_${anthropicUpstreamBodies.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5-20250929',
          content: [{ type: 'text', text: 'All systems operational.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 40, output_tokens: 10 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const authHeaders = { Authorization: `Bearer ${gatewayClientKey}` };

    // A. OpenAI Chat Completions (/thruline/v1/chat/completions) Turn 1 -> Turn 2
    const chatTurn1 = await jsonRequest(port, 'POST', '/thruline/v1/chat/completions', {
      headers: authHeaders,
      body: {
        model: 'claude-sonnet-4-5',
        reasoning_effort: 'high',
        max_tokens: 4096,
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_server_status',
              parameters: { type: 'object', properties: { region: { type: 'string' } } },
            },
          },
        ],
        messages: [{ role: 'user', content: 'Check ap-southeast-1 status' }],
      },
    });
    expect(chatTurn1.status).toBe(200);
    // Verify outbound Turn 1 normalized budget_tokens < max_tokens (4095 < 4096)
    expect(anthropicUpstreamBodies[0].thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4095,
    });
    expect(anthropicUpstreamBodies[0].max_tokens).toBe(4096);

    const chatTurn2 = await jsonRequest(port, 'POST', '/thruline/v1/chat/completions', {
      headers: authHeaders,
      body: {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Check ap-southeast-1 status' },
          {
            role: 'assistant',
            content: null,
            tool_calls: chatTurn1.json.choices[0].message.tool_calls,
          },
          {
            role: 'tool',
            tool_call_id: 'toolu_chat_1',
            content: '{"healthy":true}',
          },
        ],
      },
    });
    expect(chatTurn2.status).toBe(200);
    const sentAssistantTurn = anthropicUpstreamBodies[1].messages.find(
      (m: any) => m.role === 'assistant',
    );
    expect(sentAssistantTurn.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Need to call get_server_status first.',
        signature: 'Sig_Turn_1',
      },
      {
        type: 'redacted_thinking',
        data: 'Redacted_Turn_1',
      },
      {
        type: 'tool_use',
        id: 'toolu_chat_1',
        name: 'get_server_status',
        input: { region: 'ap-southeast-1' },
      },
    ]);

    // B. OpenAI Responses API (/thruline/v1/responses) Turn 1 -> Turn 2
    const respTurn1 = await jsonRequest(port, 'POST', '/thruline/v1/responses', {
      headers: authHeaders,
      body: {
        model: 'claude-sonnet-4-5',
        reasoning: { effort: 'medium' },
        max_output_tokens: 4096,
        tools: [
          {
            type: 'function',
            name: 'get_server_status',
            parameters: { type: 'object', properties: { region: { type: 'string' } } },
          },
        ],
        input: 'Check ap-southeast-1 status',
      },
    });
    expect(respTurn1.status).toBe(200);

    const respTurn2 = await jsonRequest(port, 'POST', '/thruline/v1/responses', {
      headers: authHeaders,
      body: {
        model: 'claude-sonnet-4-5',
        input: [
          { role: 'user', content: 'Check ap-southeast-1 status' },
          {
            type: 'function_call',
            call_id: 'toolu_resp_1',
            name: 'get_server_status',
            arguments: '{"region":"ap-southeast-1"}',
          },
          {
            type: 'function_call_output',
            call_id: 'toolu_resp_1',
            output: '{"healthy":true}',
          },
        ],
      },
    });
    expect(respTurn2.status).toBe(200);
    const respAssistantTurn = anthropicUpstreamBodies[3].messages.find(
      (m: any) => m.role === 'assistant',
    );
    expect(respAssistantTurn.content[0]).toEqual({
      type: 'thinking',
      thinking: 'Need to call get_server_status first.',
      signature: 'Sig_Turn_3',
    });
    expect(respAssistantTurn.content[1]).toEqual({
      type: 'redacted_thinking',
      data: 'Redacted_Turn_3',
    });
    expect(getThinkingContinuityDiagnostics().claudeTurnsStored).toBe(2);
    expect(getThinkingContinuityDiagnostics().claudeTurnsRestored).toBe(2);
  });

  it('strips foreign Claude thinking blocks on cross-family failover in /thruline/v1/messages', async () => {
    createApiKeyAccount({
      provider: 'anthropic',
      key: 'sk-ant-fail-primary',
      label: 'Anthropic Primary',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }],
    });
    createApiKeyAccount({
      provider: 'gemini',
      key: 'AIza-gemini-fallback',
      label: 'Gemini Fallback',
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    });
    createCombo('resilient-agent', [
      { platform: 'anthropic', modelId: 'claude-sonnet-4-5' },
      { platform: 'gemini', modelId: 'gemini-2.5-pro' },
    ]);
    invalidateConfigCache();

    let geminiReceivedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('api.anthropic.com')) {
        return new Response(JSON.stringify({ error: { message: 'Overloaded' } }), {
          status: 529,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      geminiReceivedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: 'Recovered seamlessly on Gemini!' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await jsonRequest(port, 'POST', '/thruline/v1/messages', {
      headers: { Authorization: `Bearer ${gatewayClientKey}` },
      body: {
        model: 'combo:resilient-agent',
        max_tokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 4096 },
        messages: [
          { role: 'user', content: 'Deploy service' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Claude internal thought', signature: 'ErkB_ClaudeOnly' },
              { type: 'redacted_thinking', data: 'EmwK_ClaudeRedacted' },
              {
                type: 'tool_use',
                id: 'toolu_deploy_1',
                name: 'deploy',
                input: { env: 'staging' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_deploy_1',
                content: '{"deployed":true}',
              },
            ],
          },
        ],
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-routed-via']).toBe('gemini/gemini-2.5-pro');
    expect(res.json.content).toEqual([{ type: 'text', text: 'Recovered seamlessly on Gemini!' }]);
    expect(geminiReceivedBody).not.toBeNull();
    // Gemini received skip-validation sentinel on functionCall and zero Claude thinking blocks
    const geminiModelPart = geminiReceivedBody.contents.find((c: any) => c.role === 'model');
    expect(geminiModelPart.parts[0].thoughtSignature).toBe('context_engineering_is_the_way_to_go');
    expect(getThinkingContinuityDiagnostics().foreignSignaturesStripped).toBeGreaterThanOrEqual(2);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Console Diagnostics Endpoints (`GET/PUT/POST-clear /api/thruline/thinking-continuity`)
  // ───────────────────────────────────────────────────────────────────────────

  it('exposes GET/PUT/POST-clear /api/thruline/thinking-continuity with RBAC and zero secret leakage', async () => {
    // Unauthenticated -> 401
    const unauth = await jsonRequest(port, 'GET', '/api/thruline/thinking-continuity');
    expect(unauth.status).toBe(401);

    // Member without `edit_x_settings` -> 403 on PUT & POST /clear
    const limitedMember = createUser('viewer-only@example.com', 'password123', 'member');
    getDb()
      .prepare('UPDATE users SET permissions = ? WHERE id = ?')
      .run(JSON.stringify(['use_x_gateway']), limitedMember.userId);
    const viewerToken = createSession(limitedMember.userId);

    const viewerGet = await jsonRequest(port, 'GET', '/api/thruline/thinking-continuity', {
      headers: { Authorization: `Bearer ${viewerToken}` },
    });
    expect(viewerGet.status).toBe(200);

    const viewerPut = await jsonRequest(port, 'PUT', '/api/thruline/thinking-continuity', {
      headers: { Authorization: `Bearer ${viewerToken}` },
      body: { mode: 'bypass' },
    });
    expect(viewerPut.status).toBe(403);

    // Seed both stores and verify snapshot exposes ONLY counters & mode (never raw signatures/thoughts)
    const secretSignature = 'TopSecretSignatureBlob_NeverLeak';
    const secretThought = 'TopSecretReasoningChain_NeverLeak';
    storeGeminiThoughtSignature({
      namespace: 'acct:1',
      model: 'gemini-2.5-pro',
      toolCallId: 'call_diag_1',
      signature: secretSignature,
    });
    storeClaudeThinkingBlocks({
      content: [
        { type: 'thinking', thinking: secretThought, signature: secretSignature },
        { type: 'tool_use', id: 'toolu_diag_1', name: 'fn', input: {} },
      ],
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      connectionId: '1',
    });

    const adminHeaders = { Authorization: `Bearer ${adminSessionToken}` };
    const statusRes = await jsonRequest(port, 'GET', '/api/thruline/thinking-continuity', {
      headers: adminHeaders,
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.json).toEqual({
      mode: 'enabled',
      diagnostics: {
        geminiStored: 1,
        geminiRestored: 0,
        geminiPersistedHits: 0,
        claudeTurnsStored: 1,
        claudeTurnsRestored: 0,
        foreignSignaturesStripped: 0,
        memoryEntries: 2,
      },
      persistedEntries: 1,
    });
    expect(statusRes.raw).not.toContain(secretSignature);
    expect(statusRes.raw).not.toContain(secretThought);

    // Invalid mode -> 400
    const badPut = await jsonRequest(port, 'PUT', '/api/thruline/thinking-continuity', {
      headers: adminHeaders,
      body: { mode: 'invalid-mode' },
    });
    expect(badPut.status).toBe(400);

    // Switch to `bypass` mode -> store & recall become no-ops
    const bypassPut = await jsonRequest(port, 'PUT', '/api/thruline/thinking-continuity', {
      headers: adminHeaders,
      body: { mode: 'bypass' },
    });
    expect(bypassPut.status).toBe(200);
    expect(bypassPut.json.mode).toBe('bypass');
    expect(getThinkingContinuityMode()).toBe('bypass');

    expect(
      recallGeminiThoughtSignature({
        namespace: 'acct:1',
        model: 'gemini-2.5-pro',
        toolCallId: 'call_diag_1',
      }),
    ).toBeNull();
    expect(
      restoreClaudeThinkingBlocks({
        toolUseIds: ['toolu_diag_1'],
        provider: 'claude',
        model: 'claude-sonnet-4-5',
        connectionId: '1',
      }),
    ).toBeNull();

    // Clear all continuity stores & reset diagnostics via POST /clear
    const clearRes = await jsonRequest(port, 'POST', '/api/thruline/thinking-continuity/clear', {
      headers: adminHeaders,
      body: {},
    });
    expect(clearRes.status).toBe(200);
    expect(clearRes.json.ok).toBe(true);
    expect(clearRes.json.clearedMemoryEntries).toBe(2);
    expect(clearRes.json.clearedPersistedEntries).toBe(1);
    expect(clearRes.json.snapshot.diagnostics.memoryEntries).toBe(0);
    expect(clearRes.json.snapshot.persistedEntries).toBe(0);
    expect(clearRes.json.snapshot.diagnostics.geminiStored).toBe(0);
    expect(clearRes.json.snapshot.diagnostics.claudeTurnsStored).toBe(0);
  });
});
