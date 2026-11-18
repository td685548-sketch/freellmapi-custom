import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { createSession, createUser } from '../../services/auth.js';
import {
  detectRequiredCapabilities,
  reorderCandidatesByCapabilities,
} from '../../custom/x-gateway/capacity-adapter.js';

const REAL_FETCH = globalThis.fetch.bind(globalThis);

function sseFromChunks(chunks: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('Wave 3 SystemOne smart routing, Judge panel fusion, & expanded Capacity Adapter', () => {
  let server: Server;
  let baseUrl = '';
  let adminToken = '';
  let gatewayKey = '';

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'c'.repeat(64);
    initDb(':memory:');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const owner = createUser(`wave3-admin-${Date.now()}@example.test`, 'TestPass#1234');
    adminToken = createSession(owner.userId);

    const enRes = await REAL_FETCH(`${baseUrl}/api/thruline/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enRes.status).toBe(200);

    const keyRes = await REAL_FETCH(`${baseUrl}/api/thruline/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Wave3 Test Key' }),
    });
    expect(keyRes.status).toBe(201);
    gatewayKey = ((await keyRes.json()) as { key: string }).key;

    const importRes = await REAL_FETCH(`${baseUrl}/api/thruline-accounts/subscriptions/bulk-import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        credentials: [
          { provider: 'groq', label: 'Wave3 Groq', key: 'gsk_wave3_test' },
          { provider: 'openai', label: 'Wave3 OpenAI', key: 'sk_wave3_test' },
        ],
      }),
    });
    expect(importRes.status).toBe(200);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('persists combo kind, systemOneModel, judgeModel while keeping legacy bare-array serialization', async () => {
    // 1. Default fallback combo remains a bare JSON array in entries_json
    const legacyRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'legacy-bare',
        entries: [{ platform: 'groq', modelId: 'llama-3.3-70b-versatile' }],
      }),
    });
    expect(legacyRes.status).toBe(201);
    const legacyRow = getDb().prepare('SELECT entries_json FROM x_gateway_combos WHERE name = ?').get('legacy-bare') as { entries_json: string };
    expect(Array.isArray(JSON.parse(legacyRow.entries_json))).toBe(true);

    // 2. Smart combo with systemOneModel & kind
    const smartRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'smart-sysone',
        strategy: 'smart',
        kind: 'image',
        smartPolicy: 'smart',
        confidenceThreshold: 0.8,
        systemOneModel: 'groq/llama-3.1-8b-instant',
        entries: [
          { platform: 'openai', modelId: 'gpt-4o' },
          { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
        ],
      }),
    });
    expect(smartRes.status).toBe(201);
    const smartBody = (await smartRes.json()) as any;
    expect(smartBody.kind).toBe('image');
    expect(smartBody.systemOneModel).toBe('groq/llama-3.1-8b-instant');

    // 3. Fusion combo with judgeModel updated via PUT
    const fusRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'panel-judge',
        strategy: 'fusion',
        judgeModel: 'openai/gpt-4o',
        entries: [
          { platform: 'openai', modelId: 'gpt-4o' },
          { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
        ],
      }),
    });
    expect(fusRes.status).toBe(201);
    const fusBody = (await fusRes.json()) as any;
    expect(fusBody.judgeModel).toBe('openai/gpt-4o');

    const updRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos/${fusBody.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'panel-judge',
        strategy: 'fusion',
        kind: 'chat',
        judgeModel: 'openai/gpt-4o-mini',
        entries: fusBody.entries,
      }),
    });
    expect(updRes.status).toBe(200);
    expect(((await updRes.json()) as any).judgeModel).toBe('openai/gpt-4o-mini');
  });

  it('persists expanded Capacity Adapter pools and detects pdf, videoInput, and web_search capabilities', async () => {
    const putRes = await REAL_FETCH(`${baseUrl}/api/thruline/capacity-adapter`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        vision: { enabled: true, roundRobin: false, models: ['openai/gpt-4o'] },
        audioInput: { enabled: false, roundRobin: false, models: [] },
        pdf: { enabled: true, roundRobin: true, models: ['openai/gpt-4o'] },
        videoInput: { enabled: true, roundRobin: false, models: ['gemini/gemini-2.5-flash'] },
        search: { enabled: true, roundRobin: false, models: ['perplexity/sonar'] },
      }),
    });
    expect(putRes.status).toBe(200);
    const saved = (await putRes.json()) as any;
    expect(saved.pdf.enabled).toBe(true);
    expect(saved.pdf.models).toEqual(['openai/gpt-4o']);
    expect(saved.videoInput.models).toEqual(['gemini/gemini-2.5-flash']);
    expect(saved.search.enabled).toBe(true);

    const caps = detectRequiredCapabilities(
      [{
        role: 'user',
        content: [
          { type: 'file', file: { mime_type: 'application/pdf', file_data: 'data:application/pdf;base64,AAA' } },
          { type: 'video_url', video_url: { url: 'https://example.com/a.mp4' } },
        ] as any,
      }],
      [{ type: 'web_search_preview' }],
    );
    expect(caps).toEqual({
      vision: false,
      audioInput: false,
      pdf: true,
      videoInput: true,
      search: true,
    });

    const fakeAccount = { id: 1, requests: 0, tokens: 0 } as any;
    const reordered = reorderCandidatesByCapabilities(
      [
        { account: fakeAccount, modelId: 'llama-3.3-70b-versatile' },
        { account: fakeAccount, modelId: 'gemini-2.5-flash' },
      ],
      { vision: false, audioInput: false, pdf: true, videoInput: true, search: true },
    );
    expect(reordered[0].modelId).toBe('gemini-2.5-flash');
  });

  it('executes SystemOne classifier routing and sticky threshold logic over HTTP', async () => {
    const createRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'sysone-http',
        strategy: 'smart',
        smartPolicy: 'smart',
        confidenceThreshold: 0.8,
        systemOneModel: 'groq/llama-3.1-8b-instant',
        entries: [
          { platform: 'openai', modelId: 'gpt-4o' },
          { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
        ],
      }),
    });
    expect(createRes.status).toBe(201);

    let classifierTurn = 0;
    const executedModels: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string; messages?: Array<{ role: string; content: string }> };
      if (body.model === 'llama-3.1-8b-instant') {
        classifierTurn++;
        // Turn 1: choose groq; Turn 2: weak openai confidence (0.65 < 0.8 -> keep sticky groq); Turn 3: strong openai confidence (0.92 >= 0.8 -> switch!)
        const answer = classifierTurn === 1
          ? { choice: 'groq/llama-3.3-70b-versatile', confidence: 0.95 }
          : classifierTurn === 2
            ? { choice: 'openai/gpt-4o', confidence: 0.65 }
            : { choice: 'openai/gpt-4o', confidence: 0.92 };
        return new Response(JSON.stringify({
          id: `clf-${classifierTurn}`,
          object: 'chat.completion',
          created: 1,
          model: 'llama-3.1-8b-instant',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
        }), { status: 200 });
      }
      executedModels.push(String(body.model));
      return new Response(JSON.stringify({
        id: `ans-${executedModels.length}`,
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `from:${body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }), { status: 200 });
    });

    const callCombo = (prompt: string) =>
      REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayKey}`,
          'X-Session-Id': 'wave3-sysone-sess',
        },
        body: JSON.stringify({ model: 'combo:sysone-http', messages: [{ role: 'user', content: prompt }] }),
      });

    const r1 = await callCombo('fast code');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('x-systemone-choice')).toBe('groq/llama-3.3-70b-versatile');
    expect(((await r1.json()) as any).choices[0].message.content).toBe('from:llama-3.3-70b-versatile');

    const r2 = await callCombo('follow-up');
    expect(r2.status).toBe(200);
    expect(r2.headers.get('x-routed-via')).toBe('groq/llama-3.3-70b-versatile');

    const r3 = await callCombo('complex analysis');
    expect(r3.status).toBe(200);
    expect(r3.headers.get('x-routed-via')).toBe('openai/gpt-4o');
    expect(executedModels).toEqual([
      'llama-3.3-70b-versatile',
      'llama-3.3-70b-versatile',
      'gpt-4o',
    ]);
  });

  it('executes Judge-Synthesized Panel Fusion (non-stream + SSE stream) and preserves race fusion when judgeModel unset', async () => {
    const judgeComboRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'judge-synth',
        strategy: 'fusion',
        judgeModel: 'openai/gpt-4o',
        entries: [
          { platform: 'openai', modelId: 'gpt-4o' },
          { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
        ],
      }),
    });
    expect(judgeComboRes.status).toBe(201);

    const raceComboRes = await REAL_FETCH(`${baseUrl}/api/thruline/combos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'race-only',
        strategy: 'fusion',
        entries: [
          { platform: 'openai', modelId: 'gpt-4o' },
          { platform: 'groq', modelId: 'llama-3.3-70b-versatile' },
        ],
      }),
    });
    expect(raceComboRes.status).toBe(201);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith(baseUrl)) return REAL_FETCH(input, init);
      const body = JSON.parse(String(init?.body || '{}')) as { model?: string; stream?: boolean; messages?: Array<{ role: string; content: string }> };
      const isJudgeCall = Array.isArray(body.messages) && body.messages.some(m => typeof m.content === 'string' && m.content.includes('You are the JUDGE in a model-fusion panel'));
      if (isJudgeCall) {
        if (body.stream) {
          return sseFromChunks([
            { id: 'js-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthesized Stream' }, finish_reason: null }] },
            { id: 'js-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
          ]);
        }
        return new Response(JSON.stringify({
          id: 'j-1',
          object: 'chat.completion',
          created: 1,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'Synthesized Answer' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: `p-${body.model}`,
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `Panel from ${body.model}` }, finish_reason: 'stop' }],
      }), { status: 200 });
    });

    // Non-stream judge fusion
    const nonStreamRes = await REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify({ model: 'combo:judge-synth', messages: [{ role: 'user', content: 'compare A and B' }] }),
    });
    expect(nonStreamRes.status).toBe(200);
    expect(nonStreamRes.headers.get('x-fusion-judge')).toBe('openai/gpt-4o');
    expect(((await nonStreamRes.json()) as any).choices[0].message.content).toBe('Synthesized Answer');

    // Streaming judge fusion
    const streamRes = await REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify({ model: 'combo:judge-synth', stream: true, messages: [{ role: 'user', content: 'compare A and B' }] }),
    });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('x-fusion-judge')).toBe('openai/gpt-4o');
    const sseText = await streamRes.text();
    expect(sseText).toContain('Synthesized Stream');
    expect(sseText).toContain('data: [DONE]');

    // Race-only fusion when judgeModel unset
    const raceRes = await REAL_FETCH(`${baseUrl}/thruline/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify({ model: 'combo:race-only', messages: [{ role: 'user', content: 'quick ping' }] }),
    });
    expect(raceRes.status).toBe(200);
    expect(raceRes.headers.get('x-fusion-judge')).toBeNull();
    const raceJson = (await raceRes.json()) as any;
    expect(raceJson.choices[0].message.content).toMatch(/^Panel from /);
  });
});
