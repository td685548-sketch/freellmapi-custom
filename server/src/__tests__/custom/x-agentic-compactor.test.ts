import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Express, Request, Response } from 'express';
import http from 'node:http';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken, dashboardSessionHeaders } from '../helpers/auth.js';
import {
  AGENTIC_COMPACTOR_CONFIG_KEY,
  compactGatewayConversation,
  getAgenticCompactorConfig,
  getAgenticCompactorStats,
  invalidateAgenticCompactorCache,
  resetAgenticCompactorStats,
  setAgenticCompactorConfig,
} from '../../custom/x-gateway/agentic-compaction.js';
import {
  compressProseText,
  extractProtectedSpans,
  observeSystemPrefix,
  resetPrefixFreezeTracker,
  validateAndRestoreProse,
} from '../../custom/x-gateway/prose-compressor.js';
import {
  isTokenSaversBypassed,
  preprocessGatewayMessages,
} from '../../custom/x-gateway/token-savers-pipeline.js';
import { setRtkEnabled } from '../../custom/x-gateway/rtk.js';
import { setPxpipeEnabled } from '../../custom/x-gateway/pxpipe.js';
import { setHeadroomConfig } from '../../custom/x-gateway/headroom.js';
import { setOutputSaverLevels } from '../../custom/output-savers/config.js';

function clearAgenticState(): void {
  try {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(AGENTIC_COMPACTOR_CONFIG_KEY);
  } catch {
    // ignore if db not open
  }
  delete process.env.X_AGENTIC_COMPACTOR_ENABLED;
  invalidateAgenticCompactorCache();
  resetAgenticCompactorStats();
  resetPrefixFreezeTracker();
}

function createMockReqRes(headers: Record<string, string> = {}) {
  const req = {
    headers: { ...headers },
  } as unknown as Request;

  const responseHeaders: Record<string, string> = {};
  const res = {
    headersSent: false,
    setHeader: vi.fn((key: string, value: string) => {
      responseHeaders[key.toLowerCase()] = String(value);
    }),
    getHeader: vi.fn((key: string) => responseHeaders[key.toLowerCase()]),
  } as unknown as Response;

  return { req, res, responseHeaders };
}

describe('Spec 029 — Agentic & Code-Safe Input Compactor', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(clearAgenticState);

  describe('Structural Tool-Result Compaction', () => {
    it('compacts source_code, grep_search, terminal_ansi, json_payload, stack_trace, and applies SHA-256 cap', () => {
      setAgenticCompactorConfig({ enabled: true, toolResultMaxChars: 1200, jsonMinChars: 500 });

      const longCode = [
        "import { foo } from './foo.js';",
        "export const bar = 'baz';",
        'export function main() { return foo(); }',
        ...Array.from({ length: 55 }, (_, i) => `const line_${i} = ${i};`),
      ].join('\n');

      const longGrep = Array.from({ length: 45 }, (_, i) => `src/file_${i % 5}.ts:${i + 1}:match_${i}`).join('\n');

      const longAnsi = [
        '$ npm run test',
        ...Array.from({ length: 70 }, (_, i) => `\u001b[32mPASS\u001b[0m test_case_${i % 10}`),
      ].join('\n');

      const longJson = JSON.stringify(
        Array.from({ length: 25 }, (_, i) => ({ id: i, name: `item_${i}`, payload: 'x'.repeat(80) })),
      );

      const longStack = [
        'TypeError: Cannot read properties of undefined (reading "id")',
        ...Array.from({ length: 22 }, (_, i) => `    at step_${i} (D:\\repo\\server\\src\\app.ts:${i + 1}:5)`),
      ].join('\n');

      const hugeRaw = 'A'.repeat(2500);

      const messages: ChatMessage[] = [
        { role: 'tool', tool_call_id: 'c_code', content: longCode },
        { role: 'tool', tool_call_id: 'c_grep', content: longGrep },
        { role: 'tool', tool_call_id: 'c_ansi', content: longAnsi },
        { role: 'tool', tool_call_id: 'c_json', content: longJson },
        { role: 'tool', tool_call_id: 'c_stack', content: longStack },
        { role: 'tool', tool_call_id: 'c_huge', content: hugeRaw },
      ];

      const res = compactGatewayConversation({ messages });
      expect(res.applied).toBe(true);
      expect(res.strategiesApplied).toEqual(
        expect.arrayContaining([
          'source_code',
          'grep_search',
          'terminal_ansi',
          'json_payload',
          'stack_trace',
          'evidence_digest',
        ]),
      );

      expect(String(res.messages[0]!.content)).toContain('lines elided]');
      expect(String(res.messages[1]!.content)).toContain('more matches]');
      expect(String(res.messages[2]!.content)).not.toContain('\u001b[32m');
      expect(String(res.messages[3]!.content)).toContain('"_compacted": "array"');
      expect(String(res.messages[4]!.content)).toContain('frames elided]');
      expect(String(res.messages[5]!.content)).toContain('[evidence compacted; sha256=');
      expect(String(res.messages[5]!.content).length).toBeLessThanOrEqual(1200);
    });

    it('preserves image blocks, computer_call_output objects, and already-compacted outputs', () => {
      setAgenticCompactorConfig({ enabled: true });

      const already = `${'x'.repeat(250)}\n… [10 lines elided] …\n${'y'.repeat(100)}`;
      const screenshotObj = { type: 'screenshot', image_url: 'data:image/png;base64,AAA' };
      const rawBody: Record<string, unknown> = {
        input: [
          { type: 'computer_call_output', call_id: 'comp_1', output: screenshotObj },
          { type: 'function_call_output', call_id: 'fn_1', output: 'z'.repeat(15_000) },
        ],
      };

      const messages: ChatMessage[] = [
        { role: 'tool', tool_call_id: 't1', content: already },
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/img.png' } }] as unknown as ChatMessage['content'],
        },
      ];

      const res = compactGatewayConversation({ messages, rawBody });
      expect(res.messages[0]!.content).toBe(already);
      expect((res.messages[1]!.content as Array<Record<string, unknown>>)[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/img.png' },
      });
      expect((rawBody.input as Array<Record<string, unknown>>)[0]!.output).toEqual(screenshotObj);
      expect(String((rawBody.input as Array<Record<string, unknown>>)[1]!.output)).toContain(
        '[evidence compacted; sha256=',
      );
    });

    it('deduplicates byte-identical tools[] while retaining same-name distinct schemas', () => {
      setAgenticCompactorConfig({ enabled: true, dedupTools: true });

      const toolA1 = { type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' } } } } };
      const toolA2 = { type: 'function', function: { name: 'search', parameters: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } } } } };
      const rawBody: Record<string, unknown> = {
        tools: [structuredClone(toolA1), structuredClone(toolA1), structuredClone(toolA2)],
      };

      const res = compactGatewayConversation({
        messages: [{ role: 'user', content: 'run search' }],
        rawBody,
      });

      expect(res.applied).toBe(true);
      expect(res.strategiesApplied).toContain('tools_dedup');
      expect((rawBody.tools as unknown[]).length).toBe(2);
    });
  });

  describe('Code-Safe Bilingual Prose Compaction & Fidelity Gate', () => {
    it('compresses EN + VI filler while preserving fenced code, inline code, URLs, paths, and {{vars}}', () => {
      const prompt = [
        'Could you please help me in order to update authentication configuration in src/custom/x-gateway/router.ts?',
        'It is important to note that due to the fact that `npm run test` uses https://docs.example.com/guide?tab=1 and `{{tenant_id}}`,',
        'vui lòng cho tôi hỏi nhằm mục đích kiểm tra hàm dưới đây:',
        '```ts',
        'export const configuration = { dueToTheFactThat: "in order to keep please untouched" };',
        '```',
        'Thank you so much in advance!',
      ].join('\n');

      const { spans } = extractProtectedSpans(prompt);
      expect(spans.length).toBeGreaterThanOrEqual(5);

      const res = compressProseText(prompt, 'aggressive');
      expect(res.applied).toBe(true);
      expect(res.rolledBack).toBe(false);
      expect(res.text.length).toBeLessThan(prompt.length);
      expect(res.text).toContain('src/custom/x-gateway/router.ts');
      expect(res.text).toContain('`npm run test`');
      expect(res.text).toContain('https://docs.example.com/guide?tab=1');
      expect(res.text).toContain('`{{tenant_id}}`');
      expect(res.text).toContain('dueToTheFactThat: "in order to keep please untouched"');
      expect(res.text).toContain('auth config');
      expect(res.text).not.toContain('Thank you so much in advance');
    });

    it('rolls back cleanly if a protected span or sentinel integrity check fails', () => {
      const original = 'Please check `keep_me_intact` and ```const x = 1;``` right now.';
      const brokenMasked = 'check \uE000SPAN_99\uE001 right now.';
      const rolled = validateAndRestoreProse(original, brokenMasked, ['`keep_me_intact`', '```const x = 1;```']);
      expect(rolled.rolledBack).toBe(true);
      expect(rolled.applied).toBe(false);
      expect(rolled.text).toBe(original);
    });
  });

  describe('Prompt-Cache Safe Prefix Freeze', () => {
    it('tracks recurring system prompts and keeps system messages byte-identical when prefixFreezeEnabled is true', () => {
      setAgenticCompactorConfig({
        enabled: true,
        prefixFreezeEnabled: true,
        prefixFreezeThreshold: 2,
        proseMode: 'aggressive',
      });

      const systemText = 'It is important to note that you must follow our configuration documentation strictly.';
      const userText = 'Could you please explain due to the fact that we want to optimize authentication configuration?';

      const first = compactGatewayConversation({
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText },
        ],
      });
      expect(first.prefixFrozen).toBe(false);
      expect(first.messages[0]!.content).toBe(systemText);

      const second = compactGatewayConversation({
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: userText },
        ],
      });
      expect(second.prefixFrozen).toBe(true);
      expect(second.messages[0]!.content).toBe(systemText);
      expect(getAgenticCompactorStats().frozenPrefixesSkipped).toBe(1);

      const obs = observeSystemPrefix('dry-run-only', 1, { dryRun: true });
      expect(obs.count).toBe(0);
    });

    it('respects explicit cache_control on content blocks', () => {
      setAgenticCompactorConfig({ enabled: true, prefixFreezeEnabled: false, proseMode: 'aggressive' });
      const res = compactGatewayConversation({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Could you please keep this cached configuration documentation verbatim?',
                cache_control: { type: 'ephemeral' },
              },
            ] as unknown as ChatMessage['content'],
          },
        ],
      });
      expect(res.prefixFrozen).toBe(true);
      expect(res.applied).toBe(false);
    });
  });

  describe('Pipeline Integration & Bypass Headers', () => {
    it('is disabled by default for backward compatibility', async () => {
      setRtkEnabled(false);
      setPxpipeEnabled(false);
      setHeadroomConfig({ enabled: false });
      setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });

      expect(getAgenticCompactorConfig().enabled).toBe(false);

      const { req, res, responseHeaders } = createMockReqRes();
      const result = await preprocessGatewayMessages(req, res, {
        messages: [
          { role: 'user', content: 'Could you please explain in order to test our configuration?' },
        ],
      });
      expect(result.agenticTokensSavedEst).toBe(0);
      expect(result.appliedSavers).not.toContain('Agentic');
      expect(responseHeaders['x-agentic-saved-tokens-est']).toBeUndefined();
    });

    it('runs Stage 1.5 in preprocessGatewayMessages when enabled and honors x-disable-agentic', async () => {
      setRtkEnabled(false);
      setPxpipeEnabled(false);
      setHeadroomConfig({ enabled: false });
      setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });
      setAgenticCompactorConfig({ enabled: true, proseMode: 'standard' });

      const longStack = [
        'Error: Pipeline failure',
        ...Array.from({ length: 24 }, (_, i) => `    at handler_${i} (D:\\repo\\server\\src\\handler.ts:${i + 1}:3)`),
      ].join('\n');

      const { req, res, responseHeaders } = createMockReqRes();
      const result = await preprocessGatewayMessages(req, res, {
        messages: [
          { role: 'user', content: 'debug this' },
          { role: 'tool', tool_call_id: 't1', content: longStack },
        ],
      });

      expect(result.appliedSavers).toContain('Agentic');
      expect(result.agenticTokensSavedEst).toBeGreaterThan(0);
      expect(responseHeaders['x-token-savers-applied']).toContain('Agentic');
      expect(Number(responseHeaders['x-agentic-saved-tokens-est'])).toBeGreaterThan(0);

      const { req: bypassReq, res: bypassRes } = createMockReqRes({ 'x-disable-agentic': '1' });
      expect(isTokenSaversBypassed(bypassReq).agenticBypassed).toBe(true);
      const bypassed = await preprocessGatewayMessages(bypassReq, bypassRes, {
        messages: [
          { role: 'user', content: 'debug this' },
          { role: 'tool', tool_call_id: 't1', content: longStack },
        ],
      });
      expect(bypassed.appliedSavers).not.toContain('Agentic');
      expect(bypassed.agenticTokensSavedEst).toBe(0);
    });
  });

  describe('HTTP Management & Preview Endpoints (/api/savers/agentic)', () => {
    let app: Express;
    let server: http.Server;
    let baseUrl: string;
    let adminToken: string;
    let memberToken: string;

    beforeAll(async () => {
      app = createApp();
      adminToken = mintDashboardToken('agentic-admin@example.com');
      memberToken = mintDashboardToken('agentic-member@example.com');
      getDb().prepare("UPDATE users SET role = 'member' WHERE email = ?").run('agentic-member@example.com');
      await new Promise<void>(resolve => {
        server = app.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    });

    async function callApi(method: string, path: string, body?: unknown, token?: string) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(token ? { ...dashboardSessionHeaders(token) } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    }

    it('supports GET, PUT, POST /preview (dry-run), POST /reset, and enforces validation + permissions', async () => {
      const initial = await callApi('GET', '/api/savers/agentic', undefined, adminToken);
      expect(initial.status).toBe(200);
      expect(initial.body.config.enabled).toBe(false);

      // Validation checks
      expect((await callApi('PUT', '/api/savers/agentic', {}, adminToken)).status).toBe(400);
      expect((await callApi('PUT', '/api/savers/agentic', { unknownKey: true }, adminToken)).status).toBe(400);
      expect((await callApi('PUT', '/api/savers/agentic', { toolResultMaxChars: 50 }, adminToken)).status).toBe(400);

      // Permission check: member cannot mutate
      expect((await callApi('PUT', '/api/savers/agentic', { enabled: true }, memberToken)).status).toBe(403);
      expect((await callApi('GET', '/api/savers/agentic', undefined, memberToken)).status).toBe(200);

      // Admin update persists
      const updated = await callApi(
        'PUT',
        '/api/savers/agentic',
        { enabled: true, proseMode: 'aggressive', toolResultMaxChars: 8000 },
        adminToken,
      );
      expect(updated.status).toBe(200);
      expect(updated.body.config.enabled).toBe(true);
      expect(updated.body.config.proseMode).toBe('aggressive');
      expect(updated.body.config.toolResultMaxChars).toBe(8000);

      // Preview dry-run works even without mutating stats
      const badPreview = await callApi('POST', '/api/savers/agentic/preview', { text: '' }, adminToken);
      expect(badPreview.status).toBe(400);

      const stackSample = [
        'Error: Boom',
        ...Array.from({ length: 24 }, (_, i) => `    at fn_${i} (src/index.ts:${i + 1}:1)`),
      ].join('\n');
      const preview = await callApi(
        'POST',
        '/api/savers/agentic/preview',
        { role: 'tool', text: stackSample },
        adminToken,
      );
      expect(preview.status).toBe(200);
      expect(preview.body.ok).toBe(true);
      expect(preview.body.strategiesApplied).toContain('stack_trace');
      expect(preview.body.tokensSavedEst).toBeGreaterThan(0);

      // Stats remained 0 during preview dry-run
      const afterPreview = await callApi('GET', '/api/savers/agentic', undefined, adminToken);
      expect(afterPreview.body.stats.requestsProcessed).toBe(0);

      // Unified /api/savers/stats includes agentic summary
      const unified = await callApi('GET', '/api/savers/stats', undefined, adminToken);
      expect(unified.status).toBe(200);
      expect(unified.body.agentic.config.enabled).toBe(true);

      // Reset stats succeeds
      const reset = await callApi('POST', '/api/savers/agentic/reset', {}, adminToken);
      expect(reset.status).toBe(200);
      expect(reset.body.ok).toBe(true);
    });
  });
});
