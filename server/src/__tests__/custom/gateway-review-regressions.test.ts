import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { mintXGatewayClientKey, updateXGatewayClientKeyAccess } from '../../custom/x-gateway/client-keys.js';
import { createApiKeyAccount, invalidateXGatewayKeyCache } from '../../custom/provider-accounts/store.js';
import { invalidateConfigCache, setEnabled } from '../../custom/x-gateway/config.js';
import { xGatewayRouter } from '../../custom/x-gateway/router.js';
import { preprocessGatewayMessages } from '../../custom/x-gateway/token-savers-pipeline.js';
import { setRtkEnabled } from '../../custom/x-gateway/rtk.js';
import { renderTextToPng, setPxpipeEnabled, setPxpipeMinChars } from '../../custom/x-gateway/pxpipe.js';
import { setHeadroomConfig } from '../../custom/x-gateway/headroom.js';
import { setOutputSaverLevels } from '../../custom/output-savers/config.js';
import { proxyFetch } from '../../lib/proxy.js';

vi.mock('../../lib/proxy.js', async original => ({ ...await original<typeof import('../../lib/proxy.js')>(), proxyFetch: vi.fn() }));
const httpFetch = globalThis.fetch;
let fixture: Server; let server: Server; let fixtureUrl: string; let base: string; let key: { id: number; key: string }; let hits: number;
let finishReason = 'tool_calls';
let forwarded: any;
beforeAll(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const upstream = express(); upstream.use(express.json());
  upstream.post('/chat/completions', (req, res) => {
    hits++; forwarded = req.body;
    if (!req.body.stream) { res.json({ id: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }); return; }
    const events = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_A', type: 'function', function: { name: 'shell', arguments: '{"command":' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_B', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: finishReason }] },
    ];
    res.type('text/event-stream').end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
  });
  fixture = await new Promise(resolve => { const s = upstream.listen(0, '127.0.0.1', () => resolve(s)); });
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const app = express(); app.use(express.json()); app.use('/x/v1', xGatewayRouter);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  initDb(':memory:'); invalidateConfigCache(); invalidateXGatewayKeyCache(); setEnabled(true);
  const user = createUser('review@test.dev', 'password123'); key = mintXGatewayClientKey(user.userId);
  createApiKeyAccount({ provider: 'custom', key: 'fixture-secret', baseUrl: fixtureUrl, models: [{ id: 'fixture', name: 'fixture' }] });
  forwarded = undefined; hits = 0; finishReason = 'tool_calls'; setRtkEnabled(false); setPxpipeEnabled(false); setHeadroomConfig({ enabled: false }); setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });
  vi.mocked(proxyFetch).mockImplementation((_url, init) => httpFetch(fixtureUrl + '/chat/completions', init));
});
afterAll(async () => { server.closeAllConnections(); fixture.closeAllConnections(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => fixture.close(() => r()))]); });
async function request(path: string, stream = false) {
  return httpFetch(base + '/x/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'custom/fixture', messages: [{ role: 'user', content: 'Hi' }], input: 'Hi', max_tokens: 16, stream }) });
}
it.each(['/chat/completions', '/messages', '/responses', '/completions', '/embeddings', '/images/generations', '/audio/speech'])('rejects a disallowed model before any upstream request: %s', async path => {
  updateXGatewayClientKeyAccess(key.id, { restricted: true, allowedModels: ['other-model'] });
  const res = await request(path); expect(res.status).toBe(403); expect(hits).toBe(0);
});
it.each(['/messages', '/responses'])('streams parallel tool IDs, names and fragmented arguments: %s', async path => {
  const res = await request(path, true); const raw = await res.text(); expect(res.status).toBe(200);
  const events = raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  expect(raw).toContain('call_A'); expect(raw).toContain('call_B'); expect(raw).toContain('shell'); expect(raw).toContain('read_file');
  if (path === '/messages') {
    const args = events.filter(e => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && e.index === 1).map(e => e.delta.partial_json).join('');
    expect(JSON.parse(args)).toEqual({ command: 'pwd' }); expect(events.find(e => e.type === 'message_delta').delta.stop_reason).toBe('tool_use');
  } else {
    const completed = events.find(e => e.type === 'response.completed').response;
    expect(completed.output.filter((item: any) => item.type === 'function_call')).toHaveLength(2);
    const call = completed.output.find((item: any) => item.call_id === 'call_A'); expect(JSON.parse(call.arguments)).toEqual({ command: 'pwd' });
    expect(events.find(e => e.type === 'response.output_item.added' && e.item.call_id === 'call_A').item.id).toBe(call.id);
    const added = events.find(e => e.type === 'response.output_item.added' && e.item.call_id === 'call_A');
    expect(completed.output[added.output_index].id).toBe(added.item.id);
  }
});
it.each(['/messages', '/responses'])('preserves a length-limited terminal state: %s', async path => {
  finishReason = 'length'; const res = await request(path, true); const raw = await res.text();
  expect(raw).toContain(path === '/messages' ? 'max_tokens' : 'max_output_tokens');
});
it('RTK preserves converted system instructions and tool pairs for Messages requests', async () => {
  setRtkEnabled(true);
  const output = '## main\n' + Array.from({ length: 40 }, (_, i) => `M  file_${i}.ts`).join('\n');
  const messages = [{ role: 'system' as const, content: 'Preserve me.' }, { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call_A', type: 'function' as const, function: { name: 'shell', arguments: '{}' } }] }, { role: 'tool' as const, tool_call_id: 'call_A', content: output }];
  const rawBody = { system: 'Preserve me.', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_A', name: 'shell', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_A', content: output }] }] };
  const result = await preprocessGatewayMessages(undefined, undefined, { messages, rawBody, format: 'claude' });
  expect(result.appliedSavers).toContain('RTK'); expect(result.messages.map(m => m.role)).toEqual(['system', 'assistant', 'tool']); expect(result.messages[0].content).toBe('Preserve me.'); expect(result.messages[1].tool_calls).toEqual(messages[1].tool_calls); expect(result.messages[2].tool_call_id).toBe('call_A'); expect(result.messages[2].content).not.toBe(output);
});
it.each(['claude', 'gemini', 'openai-responses'] as const)('PXPIPE keeps canonical image blocks after %s conversion', async format => {
  setPxpipeEnabled(true); setPxpipeMinChars(1000);
  const result = await preprocessGatewayMessages(undefined, undefined, { format, targetModel: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'document '.repeat(4000) }, { role: 'user', content: 'Question' }] });
  expect(result.pxpipeTokensSavedEst).toBeGreaterThan(0);
  expect(Array.isArray(result.messages[0].content)).toBe(true);
  expect((result.messages[0].content as any[]).some(block => block.type === 'image_url')).toBe(true);
  expect((result.messages[0] as any).parts).toBeUndefined();
});
it('preserves Unicode history instead of replacing it with unreadable PNGs', async () => {
  setPxpipeEnabled(true); setPxpipeMinChars(1000); const text = 'Tiếng Việt 秘密資料 😀 '.repeat(1000);
  const result = await preprocessGatewayMessages(undefined, undefined, { targetModel: 'gpt-4o', messages: [{ role: 'user', content: text }, { role: 'user', content: 'Question' }] });
  expect(result.messages[0].content).toBe(text); expect(result.pxpipeTokensSavedEst).toBe(0); expect(() => renderTextToPng(['秘密資料'])).toThrow('Unicode');
});

it('forwards compressed Messages history with system and tool pairs intact over HTTP', async () => {
  setRtkEnabled(true);
  const output = '## main\n' + Array.from({ length: 40 }, (_, i) => `M  file_${i}.ts`).join('\n');
  const res = await httpFetch(base + '/x/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'custom/fixture', max_tokens: 8, system: 'Preserve this instruction.', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_A', name: 'shell', input: { command: 'git status' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_A', content: output }] }] }) });
  expect(res.status).toBe(200);
  expect(forwarded.messages.find((m: any) => m.role === 'system').content).toContain('Preserve this instruction.');
  expect(forwarded.messages.find((m: any) => m.role === 'assistant').tool_calls[0].id).toBe('call_A');
  const tool = forwarded.messages.find((m: any) => m.role === 'tool'); expect(tool.tool_call_id).toBe('call_A'); expect(tool.content).not.toBe(output);
});
it.each(['/messages', '/responses'])('forwards PXPIPE canonical image data to a real HTTP upstream from %s', async path => {
  setPxpipeEnabled(true); setPxpipeMinChars(1000);
  const history = [{ role: 'user', content: 'document '.repeat(4000) }, { role: 'user', content: 'Question' }];
  const res = await httpFetch(base + '/x/v1' + path, { method: 'POST', headers: { Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'custom/gpt-4o', max_tokens: 8, messages: history, input: history }) });
  expect(res.status).toBe(200); expect(Number(res.headers.get('x-pxpipe-saved-tokens-est'))).toBeGreaterThan(0);
  const content = forwarded.messages.find((m: any) => Array.isArray(m.content))?.content;
  expect(content?.some((part: any) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'))).toBe(true);
});
