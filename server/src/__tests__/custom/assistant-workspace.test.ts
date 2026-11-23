import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  detectAssistantArtifacts,
  sanitizeArtifactHtml,
  sanitizeArtifactSvg,
} from '@freellmapi/shared/customer-ai.js';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { endpointScopeForBaseUrl } from '../../lib/endpoint-scope.js';
import { createSession, createUser } from '../../services/auth.js';
import { refreshStatsCache } from '../../services/router.js';
import { resetQuotaCaches } from '../../services/usage-quotas.js';
import { mintUserApiKey } from '../../services/user-keys.js';
import { addToActiveChain } from '../helpers/chain.js';

import { dashboardSessionHeaders } from '../helpers/auth.js';
interface CapturedUpstreamCall {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: unknown }>;
}

let upstreamServer: Server;
let upstreamBaseUrl: string;
let appServer: Server;
let base: string;

let forceUpstreamJsonOnStream = false;
let nextReplyChunks: string[] = ['Hello ', 'from ', 'stream!'];
const capturedCalls: CapturedUpstreamCall[] = [];

let userAId: number;
let userAToken: string;
let userBId: number;
let userBToken: string;

async function apiJson(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  extraHeaders?: Record<string, string>,
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { ...dashboardSessionHeaders(token) } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (await res.json().catch(() => null)) as Record<string, any> | null,
  };
}

describe('Spec 038: Personal AI Agent Workspace, Custom Assistants, Threads & Artifacts', () => {
  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);

    // 1. Spin up mock OpenAI-compatible upstream provider supporting both SSE and JSON
    upstreamServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
        let raw = '';
        req.on('data', chunk => {
          raw += String(chunk);
        });
        req.on('end', () => {
          const parsed = JSON.parse(raw || '{}') as {
            model?: string;
            stream?: boolean;
            messages?: Array<{ role: string; content: unknown }>;
          };
          const model = parsed.model ?? 'custom-mock';
          capturedCalls.push({
            model,
            stream: Boolean(parsed.stream),
            messages: Array.isArray(parsed.messages) ? parsed.messages : [],
          });

          if (parsed.stream && !forceUpstreamJsonOnStream) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            for (const piece of nextReplyChunks) {
              res.write(
                `data: ${JSON.stringify({
                  id: 'chatcmpl-stream-1',
                  object: 'chat.completion.chunk',
                  model,
                  choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
                })}\n\n`,
              );
            }
            res.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-stream-1',
                object: 'chat.completion.chunk',
                model,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
              })}\n\n`,
            );
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          const joined = nextReplyChunks.join('');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-json-1',
              object: 'chat.completion',
              model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: joined },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
            }),
          );
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    upstreamServer.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => upstreamServer.once('listening', () => resolve()));
    const upstreamPort = (upstreamServer.address() as { port: number }).port;
    upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;

    // 2. Initialize in-memory SQLite DB with all migrations
    initDb(':memory:');
    resetQuotaCaches();
    const db = getDb();

    // Disable default seeded models and random exploration so routing deterministically picks our 2 mock models
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enable_exploration', '0')").run();
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();

    const enc = encrypt('sk-upstream-mock-secret');
    const customKeyId = Number(
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, enabled, status)
        VALUES ('custom', 'mock-upstream-1', ?, ?, ?, ?, 1, 'healthy')
      `).run(enc.encrypted, enc.iv, enc.authTag, upstreamBaseUrl).lastInsertRowid,
    );
    // Second healthy key on the same custom endpoint so graceful JSON retry has an un-cooled key after a simulated stream reset
    const enc2 = encrypt('sk-upstream-mock-secret-2');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, enabled, status)
      VALUES ('custom', 'mock-upstream-2', ?, ?, ?, ?, 1, 'healthy')
    `).run(enc2.encrypted, enc2.iv, enc2.authTag, upstreamBaseUrl);
    const enc3 = encrypt('sk-upstream-mock-secret-3');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, base_url, enabled, status)
      VALUES ('custom', 'mock-upstream-3', ?, ?, ?, ?, 1, 'healthy')
    `).run(enc3.encrypted, enc3.iv, enc3.authTag, upstreamBaseUrl);

    const scope = endpointScopeForBaseUrl(upstreamBaseUrl);

    // Note: rank 1 + Frontier = highest intelligence; Small + rank 95 = lowest intelligence
    const ecoModelDbId = Number(
      db.prepare(`
        INSERT INTO models (
          platform, model_id, display_name, size_label, intelligence_rank, speed_rank,
          context_window, supports_tools, supports_vision, enabled, key_id, source, endpoint_scope
        ) VALUES ('custom', 'eco-fast-mock', 'Eco Fast Mock', 'Small', 95, 1, 128000, 1, 0, 1, ?, 'user', ?)
      `).run(customKeyId, scope).lastInsertRowid,
    );

    const maxModelDbId = Number(
      db.prepare(`
        INSERT INTO models (
          platform, model_id, display_name, size_label, intelligence_rank, speed_rank,
          context_window, supports_tools, supports_vision, enabled, key_id, source, endpoint_scope
        ) VALUES ('custom', 'max-smart-mock', 'Max Smart Mock', 'Frontier', 1, 95, 128000, 1, 0, 1, ?, 'user', ?)
      `).run(customKeyId, scope).lastInsertRowid,
    );

    // Seed baseline request samples so speedScore(eco) ≈ 1.0 and speedScore(max) ≈ 0.01 with high reliability certainty
    for (let i = 0; i < 40; i += 1) {
      db.prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms)
        VALUES ('custom', 'eco-fast-mock', ?, 'success', 50, 300, 40, 40)
      `).run(customKeyId);
      db.prepare(`
        INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, ttfb_ms)
        VALUES ('custom', 'max-smart-mock', ?, 'success', 50, 2, 4900, 4900)
      `).run(customKeyId);
    }
    refreshStatsCache(db, true);

    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(ecoModelDbId);
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 2, 1)').run(maxModelDbId);
    addToActiveChain(ecoModelDbId, 1, true);
    addToActiveChain(maxModelDbId, 2, true);

    // 3. Boot Express app and create two isolated member accounts
    const app = createApp();
    appServer = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => appServer.once('listening', () => resolve()));
    const appPort = (appServer.address() as { port: number }).port;
    base = `http://127.0.0.1:${appPort}`;

    // Create primary admin first so subsequent users can be regular members
    createUser('root-admin@example.com', 'AdminPass123!');

    const memberA = createUser('alice-workspace@example.com', 'MemberPass123!', 'member');
    userAId = memberA.userId;
    userAToken = createSession(userAId);

    const memberB = createUser('bob-workspace@example.com', 'MemberPass123!', 'member');
    userBId = memberB.userId;
    userBToken = createSession(userBId);
  });

  beforeEach(() => {
    capturedCalls.length = 0;
    forceUpstreamJsonOnStream = false;
    nextReplyChunks = ['Hello ', 'from ', 'stream!'];
  });

  afterAll(async () => {
    await new Promise<void>(resolve => appServer.close(() => resolve()));
    await new Promise<void>(resolve => upstreamServer.close(() => resolve()));
    getDb().close();
  });

  it('supports Custom Assistant CRUD, Vietnamese slug normalization, 32KB knowledge cap, and 20-agent cap', async () => {
    const unauth = await apiJson('/api/user/ai-hub/custom-assistants');
    expect(unauth.status).toBe(401);

    const created = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        name: 'Chuyên gia Kiến trúc SQLite',
        category: 'data',
        description: 'Tối ưu truy vấn WAL và migration an toàn.',
        systemPrompt: 'You are a principal SQLite database architect.',
        knowledgeMarkdown: '## Schema Rules\n\n\n\n- Always include `// DOWN: reversible`\n- Scope by `user_id`',
        recommendedRoutingMode: 'max',
      },
      userAToken,
    );

    expect(created.status).toBe(201);
    const agent = created.body?.assistant;
    expect(agent.slug).toBe('chuyen-gia-kien-truc-sqlite');
    expect(agent.assistantRef).toBe(`user:${agent.id}`);
    expect(agent.recommendedRoutingMode).toBe('max');

    // Update custom assistant
    const updated = await apiJson(
      `/api/user/ai-hub/custom-assistants/${agent.id}`,
      'PATCH',
      {
        description: 'Updated description',
        recommendedRoutingMode: 'eco',
      },
      userAToken,
    );
    expect(updated.status).toBe(200);
    expect(updated.body?.assistant.description).toBe('Updated description');
    expect(updated.body?.assistant.recommendedRoutingMode).toBe('eco');

    // Reject > 32KB knowledge_markdown
    const oversizedKnowledge = 'x'.repeat(32_769);
    const tooLarge = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        name: 'Oversized Docs Agent',
        systemPrompt: 'Valid system prompt here.',
        knowledgeMarkdown: oversizedKnowledge,
      },
      userAToken,
    );
    expect(tooLarge.status).toBe(400);
    expect(tooLarge.body?.error?.code).toBe('knowledge_too_large');

    // Enforce max 20 custom assistants per user
    const tempIds: number[] = [];
    for (let i = 2; i <= 20; i += 1) {
      const res = await apiJson(
        '/api/user/ai-hub/custom-assistants',
        'POST',
        {
          name: `Temp Agent ${i}`,
          systemPrompt: `System prompt for agent ${i}`,
        },
        userAToken,
      );
      expect(res.status).toBe(201);
      tempIds.push(res.body!.assistant.id);
    }

    const twentyFirst = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        name: 'Agent Twenty-One',
        systemPrompt: 'Should fail on cap',
      },
      userAToken,
    );
    expect(twentyFirst.status).toBe(400);
    expect(twentyFirst.body?.error?.code).toBe('custom_assistant_limit_reached');

    // Clean up temp agents
    for (const id of tempIds) {
      const del = await apiJson(`/api/user/ai-hub/custom-assistants/${id}`, 'DELETE', undefined, userAToken);
      expect(del.status).toBe(200);
    }
  });

  it('enforces strict cross-user isolation across custom assistants, key bindings, and threads', async () => {
    const aliceAgentRes = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        slug: 'alice-secret-agent',
        name: 'Alice Secret Agent',
        systemPrompt: 'TOP_SECRET_ALICE_PROMPT_NEVER_LEAK',
        knowledgeMarkdown: 'CONFIDENTIAL_RUNBOOK_TOKEN_XYZ',
        recommendedRoutingMode: 'max',
      },
      userAToken,
    );
    expect(aliceAgentRes.status).toBe(201);
    const aliceAgent = aliceAgentRes.body!.assistant;

    // Bob sees zero of Alice's custom assistants
    const bobList = await apiJson('/api/user/ai-hub/custom-assistants', 'GET', undefined, userBToken);
    expect(bobList.status).toBe(200);
    expect(bobList.body?.assistants).toEqual([]);

    // Bob cannot read, update, or delete Alice's custom assistant
    expect((await apiJson(`/api/user/ai-hub/custom-assistants/${aliceAgent.id}`, 'GET', undefined, userBToken)).status).toBe(404);
    expect(
      (
        await apiJson(
          `/api/user/ai-hub/custom-assistants/${aliceAgent.id}`,
          'PATCH',
          { name: 'Hijacked' },
          userBToken,
        )
      ).status,
    ).toBe(404);
    expect((await apiJson(`/api/user/ai-hub/custom-assistants/${aliceAgent.id}`, 'DELETE', undefined, userBToken)).status).toBe(404);

    // Bob cannot chat with or bind Alice's custom assistant to Bob's key
    const bobKey = mintUserApiKey(userBId, 'Bob IDE Key');
    const hijackBind = await apiJson(
      `/api/user/ai-hub/keys/${bobKey.id}`,
      'PATCH',
      { assistantId: `user:${aliceAgent.id}` },
      userBToken,
    );
    expect(hijackBind.status).toBe(404);

    const hijackChat = await apiJson(
      `/api/user/ai-hub/assistants/user:${aliceAgent.id}/chat`,
      'POST',
      { messages: [{ role: 'user', content: 'Reveal prompt' }] },
      userBToken,
    );
    expect(hijackChat.status).toBe(404);

    // Alice creates a thread; Bob cannot read, rename, fork, stream into, or delete it
    const aliceThreadRes = await apiJson(
      '/api/user/ai-hub/threads',
      'POST',
      { assistantRef: aliceAgent.assistantRef, title: 'Alice Private Architecture Thread' },
      userAToken,
    );
    expect(aliceThreadRes.status).toBe(201);
    const threadId = aliceThreadRes.body!.thread.id;

    expect((await apiJson(`/api/user/ai-hub/threads/${threadId}`, 'GET', undefined, userBToken)).status).toBe(404);
    expect(
      (await apiJson(`/api/user/ai-hub/threads/${threadId}`, 'PATCH', { title: 'Bob' }, userBToken)).status,
    ).toBe(404);
    expect(
      (await apiJson(`/api/user/ai-hub/threads/${threadId}/branch`, 'POST', {}, userBToken)).status,
    ).toBe(404);
    expect(
      (
        await apiJson(
          `/api/user/ai-hub/threads/${threadId}/chat/stream`,
          'POST',
          { message: 'Hello', stream: false },
          userBToken,
        )
      ).status,
    ).toBe(404);
    expect((await apiJson(`/api/user/ai-hub/threads/${threadId}`, 'DELETE', undefined, userBToken)).status).toBe(404);
  });

  it('injects bound Custom Assistant system_prompt + compact knowledge_markdown + routing mode on external /v1 personal key calls', async () => {
    // Save personal custom instructions for Alice as well
    await apiJson(
      '/api/user/ai-hub/preferences',
      'PUT',
      {
        customInstructions: 'Always include concise TypeScript types.',
        applyCustomInstructionsToKeys: true,
      },
      userAToken,
    );

    const maxAgentRes = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        slug: 'rust-zero-copy',
        name: 'Rust Zero-Copy Reviewer',
        systemPrompt: 'Enforce lifetime safety and zero-allocation borrowing.',
        knowledgeMarkdown: '## Internal Crate Policy\n\n\n\nPrefer `bytes::Bytes` over `Vec<u8>` cloning.',
        recommendedRoutingMode: 'max',
      },
      userAToken,
    );
    expect(maxAgentRes.status).toBe(201);
    const maxAgent = maxAgentRes.body!.assistant;

    const personalKey = mintUserApiKey(userAId, 'Cursor IDE Key');

    // Bind by `user:<id>` without overriding key's `default` routingMode so `recommendedRoutingMode` ('max') steers /v1
    const bound = await apiJson(
      `/api/user/ai-hub/keys/${personalKey.id}`,
      'PATCH',
      { assistantId: `user:${maxAgent.id}` },
      userAToken,
    );
    expect(bound.status).toBe(200);
    expect(bound.body?.key.userAssistantId).toBe(maxAgent.id);
    expect(bound.body?.key.assistantRef).toBe(`user:${maxAgent.id}`);
    expect(bound.body?.key.assistantSlug).toBe('rust-zero-copy');

    // Call external /v1/chat/completions with Alice's sk-flm-... personal API key
    const v1Res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${personalKey.key}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Review my parser buffer slice.' }],
      }),
    });
    expect(v1Res.status).toBe(200);
    expect(capturedCalls.length).toBe(1);

    const firstOutbound = capturedCalls[0]!;
    // `max` routingMode maps to 'smartest' bandit preset -> selects `max-smart-mock` (intelligence_rank 99)
    expect(firstOutbound.model).toBe('max-smart-mock');
    expect(firstOutbound.messages[0]?.role).toBe('system');
    const injectedSystem = String(firstOutbound.messages[0]?.content ?? '');
    expect(injectedSystem).toContain('Enforce lifetime safety and zero-allocation borrowing.');
    expect(injectedSystem).toContain('[Personal Knowledge Context]');
    expect(injectedSystem).toContain('Prefer `bytes::Bytes` over `Vec<u8>` cloning.');
    // Excessive 4 newlines were compacted to double newline
    expect(injectedSystem).not.toContain('\n\n\n');
    expect(injectedSystem).toContain('[User Custom Instructions]');
    expect(injectedSystem).toContain('Always include concise TypeScript types.');

    // Now create an `eco` custom assistant and bind by custom slug!
    const ecoAgentRes = await apiJson(
      '/api/user/ai-hub/custom-assistants',
      'POST',
      {
        slug: 'quick-shell-helper',
        name: 'Quick Shell Helper',
        systemPrompt: 'Return one-line POSIX shell commands.',
        knowledgeMarkdown: 'Target environment: Alpine sh.',
        recommendedRoutingMode: 'eco',
      },
      userAToken,
    );
    expect(ecoAgentRes.status).toBe(201);

    const boundBySlug = await apiJson(
      `/api/user/ai-hub/keys/${personalKey.id}`,
      'PATCH',
      { assistantId: 'quick-shell-helper' },
      userAToken,
    );
    expect(boundBySlug.status).toBe(200);
    expect(boundBySlug.body?.key.assistantSlug).toBe('quick-shell-helper');

    capturedCalls.length = 0;
    const v1EcoRes = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${personalKey.key}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'Count lines in src/' }],
      }),
    });
    expect(v1EcoRes.status).toBe(200);
    expect(capturedCalls[0]?.model).toBe('eco-fast-mock');
    expect(String(capturedCalls[0]?.messages[0]?.content)).toContain('Return one-line POSIX shell commands.');
    expect(String(capturedCalls[0]?.messages[0]?.content)).toContain('Target environment: Alpine sh.');
  });

  it('streams SSE tokens, persists threads, supports graceful JSON fallback, and branches from any turn index', async () => {
    nextReplyChunks = ['Here ', 'is ', 'turn 1 reply.'];

    // Turn 1: SSE stream with auto thread creation (`createThread: true`)
    const streamRes1 = await fetch(`${base}/api/user/ai-hub/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...dashboardSessionHeaders(userAToken),
      },
      body: JSON.stringify({
        assistantRef: 'code-reviewer',
        createThread: true,
        message: 'Audit our auth middleware for session fixation.',
        routingMode: 'max',
      }),
    });

    expect(streamRes1.status).toBe(200);
    expect(streamRes1.headers.get('content-type')).toContain('text/event-stream');
    const rawSse1 = await streamRes1.text();

    expect(rawSse1).toContain('event: meta');
    expect(rawSse1).toContain('event: delta');
    expect(rawSse1).toContain('"delta":"Here "');
    expect(rawSse1).toContain('"delta":"turn 1 reply."');
    expect(rawSse1).toContain('event: done');
    expect(rawSse1).toContain('data: [DONE]');

    const doneMatch1 = rawSse1.match(/event: done\ndata: (.+)\n/);
    expect(doneMatch1).toBeTruthy();
    const donePayload1 = JSON.parse(doneMatch1![1]!) as {
      reply: string;
      threadId: number;
      userMessage: { messageIndex: number };
      assistantMessage: { messageIndex: number };
    };
    expect(donePayload1.reply).toBe('Here is turn 1 reply.');
    expect(donePayload1.threadId).toBeGreaterThan(0);
    expect(donePayload1.userMessage.messageIndex).toBe(0);
    expect(donePayload1.assistantMessage.messageIndex).toBe(1);

    const threadId = donePayload1.threadId;

    // Turn 2: Second turn on the thread via SSE stream
    forceUpstreamJsonOnStream = false;
    nextReplyChunks = ['Turn 2 ', 'follow-up reply.'];

    const streamRes2 = await fetch(`${base}/api/user/ai-hub/threads/${threadId}/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...dashboardSessionHeaders(userAToken),
      },
      body: JSON.stringify({
        message: 'Now check rate limiting headers.',
      }),
    });
    expect(streamRes2.status).toBe(200);
    const rawSse2 = await streamRes2.text();
    expect(rawSse2).toContain('Turn 2 follow-up reply.');

    // Verify full 4-message thread history (`0..3`)
    const detail = await apiJson(`/api/user/ai-hub/threads/${threadId}`, 'GET', undefined, userAToken);
    expect(detail.status).toBe(200);
    expect(detail.body?.thread.messages).toHaveLength(4);
    expect(detail.body?.thread.title).toContain('Audit our auth middleware');

    // Fork/branch thread from message index 1 (after first assistant reply!)
    const invalidFork = await apiJson(
      `/api/user/ai-hub/threads/${threadId}/branch`,
      'POST',
      { fromMessageIndex: 99 },
      userAToken,
    );
    expect(invalidFork.status).toBe(400);
    expect(invalidFork.body?.error?.code).toBe('invalid_branch_point');

    const forkedRes = await apiJson(
      `/api/user/ai-hub/threads/${threadId}/branch`,
      'POST',
      { fromMessageIndex: 1, title: 'Alternative Auth Exploration' },
      userAToken,
    );
    expect(forkedRes.status).toBe(201);
    const forked = forkedRes.body!.thread;
    expect(forked.title).toBe('Alternative Auth Exploration');
    expect(forked.forkedFromThreadId).toBe(threadId);
    expect(forked.forkedFromMessageIndex).toBe(1);
    expect(forked.messages).toHaveLength(2);
    expect(forked.messages[0].content).toBe('Audit our auth middleware for session fixation.');
    expect(forked.messages[1].content).toBe('Here is turn 1 reply.');

    // Parent thread still has all 4 messages intact
    const parentAfterFork = await apiJson(`/api/user/ai-hub/threads/${threadId}`, 'GET', undefined, userAToken);
    expect(parentAfterFork.body?.thread.messages).toHaveLength(4);

    // Client-requested JSON fallback (`Accept: application/json`) on forked thread
    nextReplyChunks = ['Direct JSON reply on branch'];
    const jsonFallback = await apiJson(
      `/api/user/ai-hub/threads/${forked.id}/chat/stream`,
      'POST',
      { message: 'What about CSRF?' },
      userAToken,
      { Accept: 'application/json' },
    );
    expect(jsonFallback.status).toBe(200);
    expect(jsonFallback.body?.reply).toBe('Direct JSON reply on branch');
    expect(jsonFallback.body?.thread.messageCount).toBe(4);
  });

  it('detects fenced code artifacts and strictly sanitizes HTML & SVG under Helmet CSP', () => {
    const assistantReply = [
      'Here is an architecture diagram and an interactive table:',
      '```svg title="architecture.svg"',
      '<svg viewBox="0 0 200 80"><script>alert("xss")</script><rect x="10" y="10" width="180" height="60" onload="evil()" fill="#2563eb" /><foreignObject><div><iframe src="javascript:alert(1)"></iframe></div></foreignObject><text x="100" y="45">Gateway</text></svg>',
      '```',
      '```html',
      '<div onclick="steal()" style="color: #111; background: url(javascript:alert(1))"><h3>Report</h3><script>fetch("https://evil.example")</script><a href="JaVaScRiPt&#58;alert(1)">Bad Link</a><a href="https://example.com/docs">Safe Docs</a></div>',
      '```',
      '```mermaid',
      'flowchart LR\n  A[Client] --> B[FreeLLMAPI]',
      '```',
    ].join('\n');

    const detected = detectAssistantArtifacts(assistantReply, 'turn4');
    expect(detected).toHaveLength(3);
    expect(detected[0]?.kind).toBe('svg');
    expect(detected[0]?.suggestedFilename).toBe('architecture.svg');
    expect(detected[1]?.kind).toBe('html');
    expect(detected[2]?.kind).toBe('mermaid');

    const cleanSvg = sanitizeArtifactSvg(detected[0]!.content);
    expect(cleanSvg).toContain('<svg viewBox="0 0 200 80">');
    expect(cleanSvg).toContain('<rect x="10" y="10" width="180" height="60" fill="#2563eb" />');
    expect(cleanSvg).toContain('<text x="100" y="45">Gateway</text>');
    expect(cleanSvg).not.toContain('<script');
    expect(cleanSvg).not.toContain('alert');
    expect(cleanSvg).not.toContain('onload');
    expect(cleanSvg).not.toContain('foreignObject');
    expect(cleanSvg).not.toContain('iframe');

    const cleanHtml = sanitizeArtifactHtml(detected[1]!.content);
    expect(cleanHtml).toContain('<h3>Report</h3>');
    expect(cleanHtml).toContain('style="color: #111"');
    expect(cleanHtml).toContain('href="https://example.com/docs" rel="noopener noreferrer" target="_blank"');
    expect(cleanHtml).not.toContain('onclick');
    expect(cleanHtml).not.toContain('<script');
    expect(cleanHtml).not.toContain('evil.example');
    expect(cleanHtml).not.toContain('javascript');
    expect(cleanHtml).not.toContain('JaVaScRiPt');
  });
});
