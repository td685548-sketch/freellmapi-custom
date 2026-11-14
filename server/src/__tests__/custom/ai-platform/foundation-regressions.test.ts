import express, { type Express, type Request } from 'express';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import { hashClientProfileKey } from '../../../lib/system-prompt.js';
import { profileInferenceGate } from '../../../middleware/profile-gate.js';
import { addDoc, resetKnowledgeIndexes } from '../../../services/profile-knowledge.js';
import { preparseGuard } from '../../../custom/preparse-guard.js';
import { callGateway, isInternalCall } from '../../../custom/ai-platform/loopback.js';
import { installInterceptor } from '../../../custom/ai-platform/wire/interceptor.js';
import { resetFlagsCacheForTests } from '../../../custom/ai-platform/flags.js';

async function withServer(app: Express, run: (base: string, port: number) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try { await run(`http://127.0.0.1:${port}`, port); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe('foundation real HTTP boundaries', () => {
  beforeEach(() => { initDb(':memory:'); resetFlagsCacheForTests(); });
  afterEach(() => { getDb().close(); resetKnowledgeIndexes(); resetFlagsCacheForTests(); });

  it.each([true, false])('masks Responses lifecycle snapshots and preserves event order over HTTP (buffering=%s)', async buffering => {
    const app = express();
    app.get('/', (req, res) => {
      res.type('text/event-stream');
      installInterceptor(req, res, 'responses', [{ name: 'mask', buffering, failClosed: true,
        onDelta: text => ({ emit: text.replace('private@example.test', '[MASKED]') }),
        onComplete: () => ({ replaceWith: '[MASKED]' }) }]);
      const events = [
        { type: 'response.created', response: { id: 'r1', output: [] } },
        { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'private@example.test' },
        { type: 'response.output_text.done', text: 'private@example.test' },
        { type: 'response.content_part.done', part: { type: 'output_text', text: 'private@example.test' } },
        { type: 'response.output_item.done', item: { type: 'message', content: [{ type: 'output_text', text: 'private@example.test' }] } },
        { type: 'response.completed', response: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'private@example.test' }] }] } },
      ];
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
    await withServer(app, async base => {
      const output = await (await fetch(base)).text();
      expect(output).not.toContain('private@example.test');
      expect(output).toContain('[MASKED]');
      expect(output.indexOf('event: response.created')).toBeLessThan(output.indexOf('event: response.output_text.delta'));
      expect(output.indexOf('event: response.output_text.delta')).toBeLessThan(output.indexOf('event: response.completed'));
      const events = output.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      expect(events.find(event => event.type === 'response.content_part.added').part.text).toBe('');
    });
  });

  it.each(['oversized', 'malformed'])('fails closed on %s Gemini JSON without releasing original data', async kind => {
    const app = express();
    app.get('/', (req, res) => {
      res.type('application/json');
      installInterceptor(req, res, 'gemini', [{ name: 'strict', buffering: true, failClosed: true }]);
      res.end(kind === 'oversized' ? JSON.stringify([{ candidates: [{ content: { parts: [{ text: 'private'.repeat(650000) }] } }] }])
        : '[{"candidates": "private"}');
    });
    await withServer(app, async base => {
      const raw = await (await fetch(base)).text();
      expect(raw).not.toContain('private');
      expect(JSON.parse(raw)[0].candidates[0].finishReason).toBe('SAFETY');
    });
  });

  it.each(['mask', 'block'])('filters chunked Gemini JSON arrays without emitting raw bytes (%s)', async mode => {
    const app = express();
    app.get('/', (req, res) => {
      res.type('application/json');
      installInterceptor(req, res, 'gemini', [{ name: mode, buffering: true, failClosed: true,
        onComplete: () => ({ replaceWith: '[FILTERED]', ...(mode === 'block' ? { reason: 'policy' } : {}) }) }]);
      res.write('[');
      res.write(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private@example.test' }] } }] }));
      res.end(',' + JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 3 } }) + ']');
    });
    await withServer(app, async base => {
      const raw = await (await fetch(base)).text();
      expect(raw).not.toContain('private@example.test');
      const body = JSON.parse(raw);
      expect(Array.isArray(body)).toBe(true);
      expect(raw).toContain('[FILTERED]');
      expect(raw).toContain('"totalTokenCount":3');
      if (mode === 'block') expect(raw).toContain('SAFETY');
    });
  });

  it('does not run JSON completion filters a second time through Express res.end', async () => {
    const app = express(); let calls = 0;
    app.get('/', (req, res) => {
      installInterceptor(req, res, 'openai-chat', [{ name: 'mask', buffering: true,
        onComplete: () => { calls++; return { replaceWith: 'safe' }; } }]);
      res.json({ choices: [{ message: { content: 'private' } }] });
    });
    await withServer(app, async base => {
      const response = await fetch(base);
      expect((await response.json()).choices[0].message.content).toBe('safe');
      expect(calls).toBe(1);
    });
  });

  it.each(['bearer', 'google-header', 'google-query'])('keeps signed mounted loopbacks valid after profile enrichment (%s)', async auth => {
    const token = 'sk-cp-synthetic-profile';
    const db = getDb();
    const result = db.prepare("INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, enabled, kb_enabled, kb_max_chars, max_tokens_cap) VALUES ('Probe', ?, 'e', 'i', 't', 1, 1, 1500, 8)")
      .run(hashClientProfileKey(token));
    addDoc(Number(result.lastInsertRowid), 'Shipping', 'Shipping costs five dollars.');
    const app = express(); app.use(express.json());
    app.use('/v1', profileInferenceGate, (req, res) => res.json({ choices: [{ message: {
      role: 'assistant', content: JSON.stringify({ internal: isInternalCall(req), maxTokens: req.body.max_tokens,
        injected: req.body.messages.some((message: { role: string }) => message.role === 'system'), token: req.headers.authorization }),
    } }] }));
    await withServer(app, async (_base, port) => {
      const headers = auth === 'bearer' ? { authorization: `Bearer ${token}` }
        : auth === 'google-header' ? { 'x-goog-api-key': token } : {};
      const req = { headers, originalUrl: '/v1beta/models/probe:generateContent', query: auth === 'google-query' ? { key: token } : {},
        socket: { localAddress: '127.0.0.1', localPort: port } } as unknown as Request;
      const response = await callGateway(req, { model: 'probe', messages: [{ role: 'user', content: 'Shipping costs?' }],
        depth: 0, runId: 'run-probe', signal: AbortSignal.timeout(5000) });
      const payload = JSON.parse(String(response.message.content));
      expect(payload.internal).toEqual({ depth: 1, runId: 'run-probe' });
      expect(payload.maxTokens).toBe(8);
      expect(payload.injected).toBe(true);
      expect(payload.token).toBe(`Bearer ${token}`);
    });
  });

  it.each(['GET', 'POST'])('strips internal headers on the real preparse path before early returns (%s)', async method => {
    const app = express(); app.use(preparseGuard);
    app.all('/', (req, res) => res.json({ header: req.headers['x-ai-platform-internal'] ?? null }));
    await withServer(app, async base => {
      const response = await fetch(base, { method, headers: { 'x-forwarded-for': '203.0.113.9', 'x-ai-platform-internal': 'forged' } });
      expect(await response.json()).toEqual({ header: null });
    });
  });
});
