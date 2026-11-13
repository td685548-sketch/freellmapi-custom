import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Server } from 'http';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { createUser, createSession } from '../../services/auth.js';
import { encrypt } from '../../lib/crypto.js';
import {
  inspectTranslation,
  convertSseOpenAIToAnthropic,
  convertSseAnthropicToOpenAI,
} from '../../custom/x-gateway/translator-engine.js';

describe('X Gateway Protocol Translator Engine', () => {
  it('converts OpenAI Chat payload to Anthropic Messages', () => {
    const openaiPayload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a test assistant.' },
        { role: 'user', content: 'Hello Claude!' },
      ],
      temperature: 0.5,
      max_tokens: 1000,
    };

    const res = inspectTranslation('openai_chat', 'anthropic', openaiPayload);
    expect(res.success).toBe(true);
    expect(res.transformed.system).toBe('You are a test assistant.');
    expect(res.transformed.messages).toEqual([{ role: 'user', content: 'Hello Claude!' }]);
    expect(res.transformed.max_tokens).toBe(1000);
    expect(res.transformed.temperature).toBe(0.5);
    expect(res.steps.length).toBeGreaterThanOrEqual(7);
  });

  it('converts Anthropic Messages payload with tools to OpenAI Chat', () => {
    const anthropicPayload = {
      model: 'claude-3-7-sonnet',
      max_tokens: 2048,
      system: 'Tool user system prompt.',
      messages: [
        { role: 'user', content: 'What is the weather?' },
      ],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather in location',
          input_schema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    };

    const res = inspectTranslation('anthropic', 'openai_chat', anthropicPayload);
    expect(res.success).toBe(true);
    const messages = res.transformed.messages as Array<any>;
    expect(messages[0]).toEqual({ role: 'system', content: 'Tool user system prompt.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'What is the weather?' });
    const tools = res.transformed.tools as Array<any>;
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('get_weather');
    expect(tools[0].function.parameters.properties.city.type).toBe('string');
  });

  it('converts OpenAI Chat payload to Google Gemini format', () => {
    const openaiPayload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Gemini instructions' },
        { role: 'user', content: 'Hi Gemini!' },
      ],
      temperature: 0.8,
    };

    const res = inspectTranslation('openai_chat', 'gemini', openaiPayload);
    expect(res.success).toBe(true);
    expect(res.transformed.systemInstruction).toEqual({
      parts: [{ text: 'Gemini instructions' }],
    });
    expect(res.transformed.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi Gemini!' }] },
    ]);
  });

  it('converts Google Gemini format back to OpenAI Chat', () => {
    const geminiPayload = {
      contents: [
        { role: 'user', parts: [{ text: 'Prompt to Gemini' }] },
        { role: 'model', parts: [{ text: 'Model response turn' }] },
      ],
      systemInstruction: {
        parts: [{ text: 'Be concise.' }],
      },
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 500,
      },
    };

    const res = inspectTranslation('gemini', 'openai_chat', geminiPayload);
    expect(res.success).toBe(true);
    const messages = res.transformed.messages as Array<any>;
    expect(messages[0]).toEqual({ role: 'system', content: 'Be concise.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Prompt to Gemini' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'Model response turn' });
    expect(res.transformed.max_tokens).toBe(500);
  });

  it('converts SSE chunks between OpenAI and Anthropic formats', () => {
    const openaiChunk = {
      id: 'chatcmpl-test',
      choices: [{ delta: { content: 'chunk_token' }, finish_reason: null }],
    };
    const anthropicEvent = convertSseOpenAIToAnthropic(openaiChunk, []);
    expect(anthropicEvent.type).toBe('content_block_delta');
    expect((anthropicEvent as any).delta?.text).toBe('chunk_token');

    const backToOpenai = convertSseAnthropicToOpenAI(anthropicEvent, []);
    expect(backToOpenai.object).toBe('chat.completion.chunk');
    expect((backToOpenai as any).choices[0]?.delta?.content).toBe('chunk_token');
  });
});

describe('X Gateway Translator Console Router API', () => {
  let server: Server;
  let base: string;
  let adminSessionToken: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    const enc = encrypt('test-key-val');
    getDb()
      .prepare(
        `INSERT INTO x_gateway_keys (provider, label, auth_method, encrypted_key, iv, auth_tag, status, enabled) VALUES ('openai', 'test-openai', 'api_key', ?, ?, ?, 'healthy', 1)`
      )
      .run(enc.encrypted, enc.iv, enc.authTag);

    const admin = createUser('admin-trans@example.com', 'AdminPass123!');
    adminSessionToken = createSession(admin.userId);

    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          base = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/thruline/translator/templates returns pre-built templates', async () => {
    const res = await fetch(`${base}/api/thruline/translator/templates`, {
      headers: { Authorization: `Bearer ${adminSessionToken}` },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.templates)).toBe(true);
    expect(data.templates.length).toBeGreaterThanOrEqual(4);
  });

  it('POST /api/thruline/translator/inspect executes 7-step pipeline trace', async () => {
    const res = await fetch(`${base}/api/thruline/translator/inspect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: JSON.stringify({
        sourceProtocol: 'openai_chat',
        targetProtocol: 'anthropic',
        payload: {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Say hello' }],
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sourceProtocol).toBe('openai_chat');
    expect(body.targetProtocol).toBe('anthropic');
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps.length).toBeGreaterThanOrEqual(7);
    expect(body.stats).toBeDefined();
    expect(body.stats.sourceTokens).toBeGreaterThan(0);
  });

  it('POST /api/thruline/translator/dispatch tests route availability', async () => {
    const res = await fetch(`${base}/api/thruline/translator/dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminSessionToken}`,
      },
      body: JSON.stringify({
        protocol: 'openai_chat',
        payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'ping' }] },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.availableAccounts).toBe(1);
  });
});
