import http, { type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CloudAiRuntimePack, CloudSignedLease } from '@freellmapi/shared/cloud-entitlement.js';
import type { SupportSetupTraceStep } from '@freellmapi/shared/support-setup-copilot.js';
import { createApp } from '../../app.js';
import { recordServerLocalAddress } from '../../custom/ai-platform/orchestrator/engine.js';
import { configureCloudEntitlementForTesting } from '../../custom/cloud-entitlement/service.js';
import { invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import type { CopilotLlmCall } from '../../custom/support-setup-copilot/agent-loop.js';
import {
  buildSystemTargetFallbackReply,
  buildSystemTargetOverviewReply,
  handleSystemTargetChatTurnGrounded,
} from '../../custom/support-setup-copilot/system-target.js';
import { runHumanLikeLlmCoach } from '../../custom/support-setup-copilot/llm-coach.js';
import { setCopilotModelSource } from '../../custom/support-setup-copilot/model-source.js';
import { runWithTrace, traceDone, traceFinish, traceStart, traceStep, traceUsage } from '../../custom/support-setup-copilot/trace.js';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { createSession, createUser, type SessionUser } from '../../services/auth.js';
import { setUserPermissions } from '../../services/users.js';

function installMockCloudLease(): void {
  process.env.FREEAPI_AI_ACTIVATION_TOKEN = 'dummy-test-token-never-sent';
  const lease: CloudSignedLease = {
    licenseId: 'test-lic-trace', label: 'Test License', instanceId: 'test-inst-trace',
    scopes: ['ai_platform', 'customer_ai', 'support_copilot', 'support_suite', 'tenant_portal'],
    packVersion: 4, packHash: 'hash-trace',
    issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
  const pack: CloudAiRuntimePack = {
    version: 4,
    supportCoachPack: { personaVi: 'Persona Vi', personaEn: 'Persona En', playbookReference: 'Playbook', outputContract: 'Contract' },
    supportAgentCopilotInstruction: 'x', customerAiDirective: 'ACTIVE', supportGatewayDirective: 'ACTIVE', aiPlatformCapabilityGrant: 'ACTIVE',
  };
  configureCloudEntitlementForTesting({
    activeLeaseRecord: { lease, tokenHash: 'dummy-hash', signature: 'dummy-sig', runtimePack: pack, verifiedAtMs: Date.now() },
  });
}

const fakeModel = (output: Record<string, unknown> | null, seen?: { extra?: string }): CopilotLlmCall => async (input) => {
  if (seen) seen.extra = input.extraInstructions;
  return output ? { output: output as never, modelUsed: 'fake-model', routeSource: 'main_gateway_loopback' } : null;
};

describe('trace helpers', () => {
  it('are silent no-ops outside a trace', async () => {
    expect(traceStart({ kind: 'analyze', titleVi: 'a', titleEn: 'a' })).toBe('');
    traceFinish('', 'done');
    traceDone({ kind: 'analyze', titleVi: 'a', titleEn: 'a' });
    await expect(traceStep({ kind: 'tool', titleVi: 'a', titleEn: 'a' }, () => 7)).resolves.toBe(7);
  });

  it('inside a trace: a step runs, then finishes with its detail, and a failing step shows as error', async () => {
    const seen: SupportSetupTraceStep[] = [];
    await runWithTrace((s) => seen.push(s), async () => {
      await traceStep({ kind: 'knowledge', titleVi: 'Tra', titleEn: 'Search' }, () => 3, (n) => ({ detailVi: `${n} mục`, detailEn: `${n} items` }));
      await expect(traceStep({ kind: 'tool', titleVi: 'x', titleEn: 'x' }, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    });
    expect(seen.map((s) => `${s.id}:${s.status}`)).toEqual(['s1:running', 's1:done', 's2:running', 's2:error']);
    expect(seen[1]).toMatchObject({ detailEn: '3 items', titleEn: 'Search' });
  });

  it('a throwing sink (closed connection) never breaks the turn', async () => {
    await runWithTrace(() => { throw new Error('closed'); }, async () => {
      await expect(traceStep({ kind: 'tool', titleVi: 'x', titleEn: 'x' }, () => 1)).resolves.toBe(1);
    });
  });
});

describe('usage: what a reply actually cost', () => {
  let admin: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    admin = createUser('trace-usage-admin@example.com', 'AdminPass123!');
    installMockCloudLease();
  });
  afterAll(() => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
  });

  const completion = (content: string) =>
    new Response(JSON.stringify({ model: 'fake/m', choices: [{ message: { content } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const coachInput = (fetchImpl: typeof fetch) => ({
    user: admin,
    messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
    locale: 'vi' as const,
    targetMode: 'update_tenant' as const,
    diagnostic: null,
    extracted: {},
    gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
    fetchImpl,
  });

  it('is null outside a trace and zero for a turn that never reaches a model', async () => {
    expect(traceUsage()).toBeNull();
    await runWithTrace(() => {}, async () => {
      expect(traceUsage()).toEqual({ modelCalls: 0, toolCalls: 0 });
    });
  });

  it('counts one real model request for a normal answer', async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return completion(JSON.stringify({ intent: 'guide', reply: 'Response cache giúp giảm số lần gọi nhà cung cấp khi câu hỏi lặp lại.' })); }) as unknown as typeof fetch;
    const usage = await runWithTrace(() => {}, async () => {
      const res = await runHumanLikeLlmCoach(coachInput(fetchImpl));
      expect(res?.output.reply).toContain('Response cache');
      return traceUsage();
    });
    expect(calls).toBe(1);
    expect(usage?.modelCalls).toBe(1);
  });

  it('counts the corrective retry too (every request that spends tokens)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return completion(JSON.stringify({
        intent: 'guide',
        reply: calls === 1
          ? 'Response cache reduces repeated provider calls when the same question comes in again and again.'
          : 'Response cache giúp giảm số lần gọi nhà cung cấp khi câu hỏi lặp lại.',
      }));
    }) as unknown as typeof fetch;
    const usage = await runWithTrace(() => {}, async () => {
      await runHumanLikeLlmCoach(coachInput(fetchImpl));
      return traceUsage();
    });
    expect(usage?.modelCalls).toBe(calls);
    expect(calls).toBe(2);
  });
});

describe('why a model attempt failed is shown on the "ask the model" step', () => {
  let admin: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'd'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    admin = createUser('trace-reason-admin@example.com', 'AdminPass123!');
  });
  afterAll(() => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    setCopilotModelSource('both');
  });

  const input = (fetchImpl: typeof fetch) => ({
    user: admin,
    messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
    locale: 'vi' as const, targetMode: 'update_tenant' as const, diagnostic: null, extracted: {},
    gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
    fetchImpl,
  });
  const run = async (fetchImpl: typeof fetch) => {
    const seen: SupportSetupTraceStep[] = [];
    const result = await runWithTrace((st) => seen.push(st), () => runHumanLikeLlmCoach(input(fetchImpl)));
    const model = [...seen].reverse().find((st) => st.kind === 'model');
    return { result, model, seen };
  };

  it('a provider error is explained with its status, for each route it tried', async () => {
    setCopilotModelSource('both');
    const fetchImpl = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const { result, model } = await run(fetchImpl);
    expect(result).toBeNull();
    expect(model?.status).toBe('error');
    expect(model?.detailVi).toContain('Chưa có mô hình nào trả lời');
    expect(model?.detailVi).toContain('FreeLLMAPI auto: chưa có nhà cung cấp nào sẵn sàng (HTTP 503)');
    expect(model?.detailVi).toContain('FreeLLMAPI auto:balanced'); // auto failed over, and that is shown too
    expect(model?.detailEn).toContain('No model answered');
    expect(model?.detailEn).toContain('no provider is ready (HTTP 503)');
  });

  it('a slow model is reported as a timeout with the real limit, not as a mystery', async () => {
    const fetchImpl = (async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }) as unknown as typeof fetch;
    const { model } = await run(fetchImpl);
    expect(model?.detailVi).toContain('quá 30 giây chưa trả lời');
    expect(model?.detailEn).toContain('no answer within 30 s');
    // A timeout on 'auto' no longer ends the turn: 'auto:balanced' is tried too.
    expect(model?.detailVi).toContain('FreeLLMAPI auto: quá 30 giây chưa trả lời');
    expect(model?.detailVi).toContain('FreeLLMAPI auto:balanced: quá 30 giây chưa trả lời');
  });

  it('an unusable answer and a refused key each get their own reason', async () => {
    const badFormat = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })) as unknown as typeof fetch;
    expect((await run(badFormat)).model?.detailVi).toContain('trả lời sai định dạng');
    const denied = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    expect((await run(denied)).model?.detailVi).toContain('bị từ chối xác thực (HTTP 401)');
  });

  it('"Thruline only" with no account says so, and says FreeLLMAPI was turned off by the setting', async () => {
    setCopilotModelSource('thruline');
    let calls = 0;
    const { model } = await run((async () => { calls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch);
    expect(calls).toBe(0);
    expect(model?.detailVi).toContain('Thruline: chưa nối tài khoản nhà cung cấp nào');
    expect(model?.detailVi).toContain('FreeLLMAPI: đang tắt trong mục chọn Mô hình');
    setCopilotModelSource('both');
  });

  it('an answer after a failed route still mentions what failed first', async () => {
    setCopilotModelSource('both');
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return n === 1
        ? new Response('{}', { status: 429 })
        : new Response(JSON.stringify({ model: 'fake/m', choices: [{ message: { content: JSON.stringify({ intent: 'guide', reply: 'Response cache giúp giảm số lần gọi nhà cung cấp.' }) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const { result, model } = await run(fetchImpl);
    expect(result?.output.reply).toContain('Response cache');
    expect(model?.status).toBe('done');
    expect(model?.detailVi).toContain('fake/m');
    expect(model?.detailVi).toContain('trước đó: FreeLLMAPI auto: đang bị giới hạn tốc độ');
    expect(model?.detailVi).not.toContain('Thruline: chưa nối'); // never tried: noise once a model answered
  });
});

describe('live reasoning while the model streams its answer', () => {
  let admin: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    admin = createUser('trace-reasoning-admin@example.com', 'AdminPass123!');
  });
  afterAll(() => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    setCopilotModelSource('both');
  });

  it('shows the model thinking, then the reply as it forms — in a single streamed request', async () => {
    setCopilotModelSource('freellmapi');
    const sse = (payload: string): string => `data: ${payload}\n\n`;
    const chunks = [
      sse(JSON.stringify({ model: 'fake/stream', choices: [{ delta: { reasoning_content: 'Người dùng hỏi về cache; cần trả lời ngắn gọn.' } }] })),
      sse(JSON.stringify({ choices: [{ delta: { content: '{"intent":"guide","reply":"Response cache' } }] })),
      sse(JSON.stringify({ choices: [{ delta: { content: ' giúp giảm số lần gọi nhà cung cấp."}' } }] })),
      'data: [DONE]\n\n',
    ];
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const seen: SupportSetupTraceStep[] = [];
    const result = await runWithTrace((st) => seen.push(st), () =>
      runHumanLikeLlmCoach({
        user: admin,
        messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
        locale: 'vi' as const, targetMode: 'update_tenant' as const, diagnostic: null, extracted: {},
        gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
        fetchImpl,
      }),
    );

    expect(calls).toBe(1); // streamed once; no second plain request for the same attempt
    expect(result?.output.reply).toContain('Response cache');
    expect(result?.routeSource).toBe('main_gateway_loopback');
    const modelSteps = seen.filter((st) => st.kind === 'model');
    const withReasoning = modelSteps.filter((st) => st.reasoning);
    expect(withReasoning.length).toBeGreaterThanOrEqual(2);
    expect(withReasoning[0]?.reasoning).toContain('Người dùng hỏi về cache');
    expect(withReasoning[withReasoning.length - 1]?.reasoning).toContain('Response cache');
    // The finished step keeps the last reasoning, so the panel can be reviewed afterwards.
    expect(modelSteps[modelSteps.length - 1]?.status).toBe('done');
    expect(modelSteps[modelSteps.length - 1]?.reasoning).toContain('Response cache');
    setCopilotModelSource('both');
  });

  it('a slow-but-alive stream is not cut off by the per-attempt deadline while tokens keep arriving', async () => {
    setCopilotModelSource('freellmapi');
    const sse = (payload: string): string => `data: ${payload}\n\n`;
    // Chunks arrive ~350ms apart, so the whole answer takes ~700ms — well past
    // the 300ms per-attempt budget. The old total-deadline abort would kill it
    // after the first chunk (reasoning only) and the turn would fail; with the
    // inactivity watchdog every chunk extends the deadline and it completes.
    const timedChunks = [
      { delayMs: 0, sse: sse(JSON.stringify({ model: 'fake/stream', choices: [{ delta: { reasoning_content: 'Người dùng hỏi về cache; cần trả lời ngắn gọn.' } }] })) },
      { delayMs: 350, sse: sse(JSON.stringify({ choices: [{ delta: { content: '{"intent":"guide","reply":"Response cache' } }] })) },
      { delayMs: 350, sse: sse(JSON.stringify({ choices: [{ delta: { content: ' giúp giảm số lần gọi nhà cung cấp."}' } }] })) },
      { delayMs: 0, sse: 'data: [DONE]\n\n' },
    ];
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      const stream = new ReadableStream({
        async start(controller) {
          // Like a real fetch body, an abort errors the stream mid-read.
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(init.signal?.reason ?? new Error('aborted'));
            } catch {
              // Already closed.
            }
          });
          for (const { delayMs, sse: chunk } of timedChunks) {
            if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            if (init?.signal?.aborted) return;
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const seen: SupportSetupTraceStep[] = [];
    const result = await runWithTrace((st) => seen.push(st), () =>
      runHumanLikeLlmCoach({
        user: admin,
        messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
        locale: 'vi' as const, targetMode: 'update_tenant' as const, diagnostic: null, extracted: {},
        gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
        fetchImpl,
        timeoutMs: 300,
        streamTimeouts: { idleMs: 600, totalMs: 3000 },
      }),
    );

    expect(calls).toBe(1); // one streamed request; no plain retry, no corrective retry
    expect(result?.output.reply).toContain('Response cache');
    expect(result?.routeSource).toBe('main_gateway_loopback');
    const modelSteps = seen.filter((st) => st.kind === 'model');
    expect(modelSteps[modelSteps.length - 1]?.status).toBe('done');
    expect(modelSteps[modelSteps.length - 1]?.reasoning).toContain('Người dùng hỏi về cache');
    setCopilotModelSource('both');
  });

  it('a stalled stream still aborts on silence instead of holding the turn until the total cap', async () => {
    setCopilotModelSource('freellmapi');
    const sse = (payload: string): string => `data: ${payload}\n\n`;
    let calls = 0;
    const fetchImpl = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls += 1;
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            try {
              controller.error(init.signal?.reason ?? new Error('aborted'));
            } catch {
              // Already closed.
            }
          });
          // One reasoning chunk, then silence forever: the stream never
          // yields another chunk and never closes.
          controller.enqueue(
            new TextEncoder().encode(
              sse(JSON.stringify({ choices: [{ delta: { reasoning_content: 'Đang suy nghĩ…' } }] })),
            ),
          );
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const startedAt = Date.now();
    const result = await runHumanLikeLlmCoach({
      user: admin,
      messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
      locale: 'vi' as const, targetMode: 'update_tenant' as const, diagnostic: null, extracted: {},
      gatewayLoopback: { host: '127.0.0.1', port: 9, forceLoopback: true },
      fetchImpl,
      timeoutMs: 300,
      streamTimeouts: { idleMs: 200, totalMs: 5000 },
    });
    const elapsedMs = Date.now() - startedAt;

    // The turn fails (a stalled stream is unusable), but it fails fast: each
    // attempt aborts ~200ms after its only chunk, not at the 5s total cap.
    // Since the format-failure failover, the empty partial answer no longer
    // ends the turn after one model — 'auto:balanced' is tried too, and it
    // stalls the same way.
    expect(result).toBeNull();
    expect(calls).toBe(2); // 'auto' and 'auto:balanced' both stall out
    expect(elapsedMs).toBeLessThan(2000);
    setCopilotModelSource('both');
  });
});

describe('Tier 1 Thruline streams its answer live', () => {
  let admin: SessionUser;
  let mockServer: Server;
  let mockPort: number;

  const upstreamCalls: Array<{ stream?: boolean; model?: string }> = [];
  type SseChunk = { delayMs: number; sse: string; hangAfter?: boolean };
  let nextSseScripts: SseChunk[][] = [];

  const validAnswer = JSON.stringify({
    intent: 'guide',
    reply: 'Response cache giúp giảm số lần gọi nhà cung cấp.',
  });
  const sse = (payload: string): string => `data: ${payload}\n\n`;
  const defaultScript = (): SseChunk[] => [
    { delayMs: 0, sse: sse(JSON.stringify({ model: 'thruline/stream', choices: [{ delta: { reasoning_content: 'Người dùng hỏi về cache; cần trả lời ngắn gọn.' } }] })) },
    { delayMs: 0, sse: sse(JSON.stringify({ choices: [{ delta: { content: '{"intent":"guide","reply":"Response cache' } }] })) },
    { delayMs: 0, sse: sse(JSON.stringify({ choices: [{ delta: { content: ' giúp giảm số lần gọi nhà cung cấp."}' } }] })) },
    { delayMs: 0, sse: 'data: [DONE]\n\n' },
  ];

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    admin = createUser('trace-tier1-admin@example.com', 'AdminPass123!');

    // Mock OpenAI-compatible upstream: serves scripted SSE when the request
    // asks for a stream, plain JSON otherwise (the plain-fallback path).
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: { stream?: boolean; model?: string } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        } catch {
          body = {};
        }
        upstreamCalls.push({ stream: body.stream, model: body.model });
        if (body.stream === true) {
          const script = nextSseScripts.shift() ?? defaultScript();
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          void (async () => {
            for (const { delayMs, sse: line, hangAfter } of script) {
              if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
              // NOTE: `req.destroyed` is NOT a liveness signal — the request
              // stream auto-destroys once its body is read. The response (and
              // its socket) is what tells us the client went away.
              if (res.destroyed || res.writableEnded) return;
              res.write(line);
              if (hangAfter) {
                // Stall forever (until the client aborts): never write again.
                await new Promise<void>((resolve) => res.on('close', () => resolve()));
                return;
              }
            }
            if (!res.destroyed) res.end();
          })();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl_mock_tier1',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model ?? 'thruline-stream-coach',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: validAnswer },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
    });
    mockServer.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => mockServer.once('listening', () => resolve()));
    mockPort = (mockServer.address() as { port: number }).port;
  });
  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    setCopilotModelSource('both');
    mockServer.closeAllConnections?.();
    await new Promise<void>((r) => mockServer.close(() => r()));
  });

  beforeEach(() => {
    upstreamCalls.length = 0;
    nextSseScripts = [];
    // A fresh account per test: a stalled stream cools its route for 30s, so
    // reusing the same row would hide the account from later tests.
    const db = getDb();
    db.prepare('DELETE FROM x_gateway_keys').run();
    const enc = encrypt('sk-tier1-test');
    db.prepare(
      `INSERT INTO x_gateway_keys (
         provider, label, auth_method, encrypted_key, iv, auth_tag,
         base_url, models_json, status, enabled, monthly_request_cap, monthly_token_cap
       ) VALUES (?, ?, 'api_key', ?, ?, ?, ?, ?, 'healthy', 1, 0, 0)`,
    ).run(
      'openrouter',
      'Thruline Stream Account',
      enc.encrypted,
      enc.iv,
      enc.authTag,
      `http://127.0.0.1:${mockPort}/v1`,
      JSON.stringify([{ id: 'thruline-stream-coach', name: 'Thruline Stream Coach' }]),
    );
    invalidateXGatewayKeyCache();
    setCopilotModelSource('thruline');
  });

  const run = async (opts?: { timeoutMs?: number; streamTimeouts?: { idleMs?: number; totalMs?: number } }) => {
    const seen: SupportSetupTraceStep[] = [];
    const result = await runWithTrace((st) => seen.push(st), () =>
      runHumanLikeLlmCoach({
        user: admin,
        messages: [{ role: 'user' as const, content: 'cho mình hỏi về cài đặt cache' }],
        locale: 'vi' as const,
        targetMode: 'update_tenant' as const,
        diagnostic: null,
        extracted: {},
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts?.streamTimeouts ? { streamTimeouts: opts.streamTimeouts } : {}),
      }),
    );
    const model = [...seen].reverse().find((st) => st.kind === 'model');
    return { result, model, seen };
  };

  it('streams the model thinking, then the reply as it forms — in a single streamed request', async () => {
    const { result, seen } = await run();

    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]?.stream).toBe(true);
    expect(result?.output.reply).toContain('Response cache');
    expect(result?.routeSource).toBe('thruline_account');
    const modelSteps = seen.filter((st) => st.kind === 'model');
    const withReasoning = modelSteps.filter((st) => st.reasoning);
    expect(withReasoning.length).toBeGreaterThanOrEqual(2);
    expect(withReasoning[0]?.reasoning).toContain('Người dùng hỏi về cache');
    expect(withReasoning[withReasoning.length - 1]?.reasoning).toContain('Response cache');
    // The finished step keeps the last reasoning, so the panel can be reviewed afterwards.
    expect(modelSteps[modelSteps.length - 1]?.status).toBe('done');
    expect(modelSteps[modelSteps.length - 1]?.reasoning).toContain('Response cache');
  });

  it('a slow-but-alive Tier 1 stream is not cut off by the per-attempt deadline while tokens keep arriving', async () => {
    // Chunks arrive ~350ms apart, so the whole answer takes ~700ms — well past
    // the 300ms per-attempt budget. The old fixed 12s cap (and a plain
    // 300ms deadline) would kill it after the first chunk; with the
    // inactivity watchdog every chunk extends the deadline and it completes.
    nextSseScripts.push([
      { delayMs: 0, sse: sse(JSON.stringify({ model: 'thruline/stream', choices: [{ delta: { reasoning_content: 'Người dùng hỏi về cache; cần trả lời ngắn gọn.' } }] })) },
      { delayMs: 350, sse: sse(JSON.stringify({ choices: [{ delta: { content: '{"intent":"guide","reply":"Response cache' } }] })) },
      { delayMs: 350, sse: sse(JSON.stringify({ choices: [{ delta: { content: ' giúp giảm số lần gọi nhà cung cấp."}' } }] })) },
      { delayMs: 0, sse: 'data: [DONE]\n\n' },
    ]);
    const { result, seen } = await run({ timeoutMs: 300, streamTimeouts: { idleMs: 600, totalMs: 3000 } });

    expect(upstreamCalls).toHaveLength(1); // one streamed request; no plain retry, no corrective retry
    expect(result?.output.reply).toContain('Response cache');
    expect(result?.routeSource).toBe('thruline_account');
    const modelSteps = seen.filter((st) => st.kind === 'model');
    expect(modelSteps[modelSteps.length - 1]?.status).toBe('done');
    expect(modelSteps[modelSteps.length - 1]?.reasoning).toContain('Người dùng hỏi về cache');
  });

  it('an empty stream falls back to one plain completion for the same model', async () => {
    nextSseScripts.push([{ delayMs: 0, sse: 'data: [DONE]\n\n' }]);
    const { result } = await run();

    expect(upstreamCalls).toHaveLength(2);
    expect(upstreamCalls[0]?.stream).toBe(true);
    expect(upstreamCalls[1]?.stream).toBeFalsy();
    expect(result?.output.reply).toContain('Response cache');
    expect(result?.routeSource).toBe('thruline_account');
  });

  it('a stalled Tier 1 stream still aborts on silence instead of holding the turn until the total cap', async () => {
    nextSseScripts.push([
      { delayMs: 0, sse: sse(JSON.stringify({ choices: [{ delta: { reasoning_content: 'Đang suy nghĩ…' } }] })), hangAfter: true },
    ]);
    const startedAt = Date.now();
    const { result } = await run({ timeoutMs: 300, streamTimeouts: { idleMs: 200, totalMs: 5000 } });
    const elapsedMs = Date.now() - startedAt;

    // The turn fails (a stalled stream is unusable), but it fails fast: the
    // attempt aborts ~200ms after its only chunk, not at the 5s total cap —
    // and a timeout is never retried plain, so the upstream saw one request.
    expect(result).toBeNull();
    expect(upstreamCalls).toHaveLength(1);
    expect(elapsedMs).toBeLessThan(2000);
  });
});

describe('System target: model answer first for unrecognised messages, honest fallback last', () => {
  let admin: SessionUser;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = 'e'.repeat(64);
    initDb(':memory:');
    admin = createUser('trace-sys-admin@example.com', 'AdminPass123!');
    installMockCloudLease();
  });
  afterAll(() => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
  });

  const ask = (content: string, llmCall: CopilotLlmCall) =>
    handleSystemTargetChatTurnGrounded({ user: admin, messages: [{ role: 'user', content }], locale: 'vi', llmCall });

  it('"giờ là mấy giờ": the model answers (with the System scope rules attached), no overview recital', async () => {
    const seen: { extra?: string } = {};
    const res = await ask('giờ là mấy giờ', fakeModel({ intent: 'guide', reply: 'Mình không xem được giờ, nhưng mình giúp được phần cài đặt hệ thống.', suggestedQuickReplies: [] }, seen));
    expect(res.reply).toContain('không xem được giờ');
    expect(res.reply).not.toContain('Bạn đang ở mục tiêu');
    expect(res.usedFallback).toBe(false);
    expect(res.proposal).toBeNull();
    expect(seen.extra).toContain('NEVER invent facts such as the time');
    expect(seen.extra).toContain('NO tenant here');
    expect(res.suggestedQuickReplies.length).toBeGreaterThan(0); // falls back to the System quick replies
  });

  it('with no model route, an unrecognised message gets an honest "did not understand" lead, then the overview', async () => {
    const res = await ask('giờ là mấy giờ', fakeModel(null));
    expect(res.usedFallback).toBe(true);
    expect(res.reply).toContain('chưa hiểu');
    expect(res.reply).toContain('chưa đổi gì');
    expect(res.reply).toContain('Toàn hệ thống');
  });

  it('a greeting still gets just the overview; the lead only appears for non-greetings', () => {
    expect(buildSystemTargetFallbackReply('xin chào', 'vi')).toBe(buildSystemTargetOverviewReply('vi'));
    expect(buildSystemTargetFallbackReply('Hello there', 'en')).toBe(buildSystemTargetOverviewReply('en'));
    expect(buildSystemTargetFallbackReply('what time is it', 'en')).toContain('changed nothing');
    expect(buildSystemTargetFallbackReply('', 'en')).toBe(buildSystemTargetOverviewReply('en'));
  });

  it('rule-based requests never reach the model (exact, free, consent-gated)', async () => {
    let called = false;
    const res = await ask('Bật response cache', async () => { called = true; return null; });
    expect(called).toBe(false);
    expect(res.intent).toBe('propose_setup');
    expect(res.proposal?.systemActions?.[0]).toMatchObject({ settingId: 'response_cache' });
  });

  it('a model that proposes a setup or asks a questionnaire is not trusted on this target', async () => {
    const a = await ask('hmm lạ quá', fakeModel({ intent: 'propose_setup', reply: 'Kế hoạch' }));
    expect(a.usedFallback).toBe(true);
    const b = await ask('hmm lạ quá', fakeModel({ intent: 'guide', reply: '1. Tên shop là gì?\n2. Web là gì?' }));
    expect(b.usedFallback).toBe(true);
  });
});

describe('POST /chat as an event stream', () => {
  let server: Server;
  let base: string;
  let adminToken: string;
  let viewerToken: string;

  const stream = async (token: string, content: string, extra: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}/api/support-setup-copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ locale: 'vi', currentPath: '/thruline/support', messages: [{ role: 'user', content }], ...extra }),
    });
    const text = await res.text();
    const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((block) => {
      const [ev, ...data] = block.split('\n');
      return { event: ev!.slice('event: '.length), data: JSON.parse(data.join('\n').slice('data: '.length)) as any };
    });
    return { res, events };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = 'f'.repeat(64);
    initDb(':memory:');
    installMockCloudLease();
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
    recordServerLocalAddress({ socket: { localAddress: '127.0.0.1', localPort: port } } as never);
    const admin = createUser('trace-http-admin@example.com', 'AdminPass123!');
    adminToken = createSession(admin.userId);
    const viewer = createUser('trace-http-viewer@example.com', 'UserPass123!', 'member');
    setUserPermissions(viewer.userId, ['view_cache'], admin.userId);
    viewerToken = createSession(viewer.userId);
  });
  afterAll(async () => {
    configureCloudEntitlementForTesting(null);
    delete process.env.FREEAPI_AI_ACTIVATION_TOKEN;
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    getDb().prepare('DELETE FROM auth_request_limits').run();
  });

  it('streams its working steps, then the normal response as the final event', async () => {
    const { res, events } = await stream(adminToken, 'Bật response cache', { targetMode: 'system' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const steps = events.filter((e) => e.event === 'step').map((e) => e.data as SupportSetupTraceStep);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]).toMatchObject({ kind: 'analyze', status: 'running' });
    expect(steps.some((s) => s.kind === 'decide')).toBe(true);
    const last = events[events.length - 1]!;
    expect(last.event).toBe('final');
    expect(last.data.status).toBe(200);
    expect(last.data.body.proposal.systemActions[0]).toMatchObject({ settingId: 'response_cache' });
    // answered by rules: no model request, no tool call, and it says so
    expect(last.data.body.usage).toEqual({ modelCalls: 0, toolCalls: 0 });
  });

  it('reports an error as the final event with its status and the usual error shape', async () => {
    const { events } = await stream(viewerToken, 'Bật response cache', { targetMode: 'system' });
    const last = events[events.length - 1]!;
    expect(last.event).toBe('final');
    expect(last.data.status).toBe(403);
    expect(last.data.body.error.message).toBeTruthy();
  });

  it('a request that does not ask for a stream still gets plain JSON, with no steps', async () => {
    const res = await fetch(`${base}/api/support-setup-copilot/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ locale: 'vi', currentPath: '/thruline/support', targetMode: 'system', messages: [{ role: 'user', content: 'Bật response cache' }] }),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as any;
    expect(body.proposal.systemActions[0].settingId).toBe('response_cache');
    expect(body.usage).toBeUndefined(); // usage is only reported on the streamed path
  });
});
