import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { initDb } from '../../db/index.js';
import {
  preprocessGatewayMessages,
  isTokenSaversBypassed,
} from '../../custom/x-gateway/token-savers-pipeline.js';
import {
  setRtkEnabled,
  filterGrep,
  filterFind,
  filterTree,
  filterLs,
  filterSearchList,
  filterDedupLog,
  filterGitLog,
  compressMessages,
} from '../../custom/x-gateway/rtk.js';
import { setPxpipeEnabled, setPxpipeMinChars } from '../../custom/x-gateway/pxpipe.js';
import { setHeadroomConfig } from '../../custom/x-gateway/headroom.js';
import { setOutputSaverLevels } from '../../custom/output-savers/config.js';

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

describe('X Gateway Token Savers Pipeline Integration', () => {
  beforeAll(() => {
    initDb(':memory:');
  });

  describe('Bypass Headers Parser', () => {
    it('detects x-token-saver: off', () => {
      const { req } = createMockReqRes({ 'x-token-saver': 'off' });
      const status = isTokenSaversBypassed(req);
      expect(status.allInputBypassed).toBe(true);
      expect(status.outputBypassed).toBe(true);
      expect(status.rtkBypassed).toBe(true);
      expect(status.headroomBypassed).toBe(true);
      expect(status.pxpipeBypassed).toBe(true);
    });

    it('detects x-disable-savers: true and 1', () => {
      const { req: req1 } = createMockReqRes({ 'x-disable-savers': 'true' });
      expect(isTokenSaversBypassed(req1).allInputBypassed).toBe(true);

      const { req: req2 } = createMockReqRes({ 'x-disable-savers': '1' });
      expect(isTokenSaversBypassed(req2).allInputBypassed).toBe(true);
    });

    it('detects x-9router-token-saver: 0', () => {
      const { req } = createMockReqRes({ 'x-9router-token-saver': '0' });
      const status = isTokenSaversBypassed(req);
      expect(status.allInputBypassed).toBe(true);
    });

    it('detects granular bypass headers like x-disable-rtk: 1', () => {
      const { req } = createMockReqRes({
        'x-disable-rtk': '1',
        'x-output-saver': 'false',
      });
      const status = isTokenSaversBypassed(req);
      expect(status.allInputBypassed).toBe(false);
      expect(status.rtkBypassed).toBe(true);
      expect(status.outputBypassed).toBe(true);
      expect(status.headroomBypassed).toBe(false);
      expect(status.pxpipeBypassed).toBe(false);
    });
  });

  describe('RTK Compressor Stage & Filters', () => {
    it('compresses tool results and sets response headers', async () => {
      setRtkEnabled(true);
      setPxpipeEnabled(false);
      setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });
      setHeadroomConfig({ enabled: false });

      const { req, res, responseHeaders } = createMockReqRes();
      const porcelain = '## main\n' + Array.from({ length: 40 }, (_, i) => `M  file_${i}.ts`).join('\n');
      const messages = [
        { role: 'user', content: 'check git status' },
        { role: 'tool', tool_call_id: 'call_1', content: porcelain },
      ];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      expect(result.appliedSavers).toContain('RTK');
      expect(result.rtkTokensSavedEst).toBeGreaterThan(0);
      expect(result.messages[1].content).toContain('* main');
      expect(responseHeaders['x-token-savers-applied']).toContain('RTK');
      expect(responseHeaders['x-rtk-saved-tokens-est']).toBeDefined();
    });

    it('bypasses RTK when x-disable-rtk: true header is passed', async () => {
      setRtkEnabled(true);
      const { req, res, responseHeaders } = createMockReqRes({ 'x-disable-rtk': 'true' });
      const porcelain = '## main\n' + Array.from({ length: 40 }, (_, i) => `M  file_${i}.ts`).join('\n');
      const messages = [
        { role: 'user', content: 'check git status' },
        { role: 'tool', tool_call_id: 'call_1', content: porcelain },
      ];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      expect(result.appliedSavers).not.toContain('RTK');
      expect(result.rtkTokensSavedEst).toBe(0);
      expect(result.messages[1].content).toBe(porcelain);
      expect(responseHeaders['x-token-savers-applied']).toBe('none');
    });

    it('filters grep output correctly', () => {
      const grepDump = Array.from({ length: 15 }, (_, i) => `server/src/app.ts:${i * 10}:const val${i} = ${i};`).join('\n');
      const filtered = filterGrep(grepDump);
      expect(filtered).toContain('matches in 1F:');
      expect(filtered).toContain('[file] server/src/app.ts');
      expect(filtered).toContain('+10');
    });

    it('filters find output correctly', () => {
      const findDump = [
        'src/services/auth.ts',
        'src/services/router.ts',
        'src/services/user.ts',
        'client/src/App.tsx',
        'client/src/index.tsx',
      ].join('\n');
      const filtered = filterFind(findDump);
      expect(filtered).toContain('files in 2 dirs:');
      expect(filtered).toContain('src/services/  (3)');
      expect(filtered).toContain('client/src/  (2)');
    });

    it('filters tree output removing directory/file summary', () => {
      const treeDump = [
        '.',
        '├── src',
        '│   └── app.ts',
        '└── package.json',
        '',
        '2 directories, 2 files',
      ].join('\n');
      const filtered = filterTree(treeDump);
      expect(filtered).not.toContain('2 directories, 2 files');
      expect(filtered).toContain('├── src');
    });

    it('filters ls -la output to compact listing', () => {
      const lsDump = [
        'total 48',
        'drwxr-xr-x  5 user group  4096 Nov 10 12:00 src',
        '-rw-r--r--  1 user group  2048 Nov 10 12:00 package.json',
        '-rw-r--r--  1 user group 16384 Nov 10 12:00 tsconfig.json',
      ].join('\n');
      const filtered = filterLs(lsDump);
      expect(filtered).toContain('dirs (1): src');
      expect(filtered).toContain('package.json');
    });

    it('filters search-list Cursor glob output', () => {
      const searchListDump = [
        "Result of search in 'server' (total 3 files):",
        '- server/src/app.ts',
        '- server/src/index.ts',
        '- server/package.json',
      ].join('\n');
      const filtered = filterSearchList(searchListDump);
      expect(filtered).toContain("Result of search in 'server' (total 3 files):");
      expect(filtered).toContain('server/src/ (2):');
    });

    it('filters dedupLog collapsing repetitive log lines', () => {
      const repetitiveDump = [
        '2026-11-10 12:00:00 [info] server listening',
        '2026-11-10 12:00:01 [info] heart beat tick',
        '2026-11-10 12:00:01 [info] heart beat tick',
        '2026-11-10 12:00:01 [info] heart beat tick',
        '2026-11-10 12:00:01 [info] heart beat tick',
        '2026-11-10 12:00:05 [info] completed',
      ].join('\n');
      const filtered = filterDedupLog(repetitiveDump);
      expect(filtered).toContain('duplicate lines');
    });

    it('filters gitLog output keeping commit headers and stats', () => {
      const gitLogDump = [
        'commit a1b2c3d4e5f6',
        'Author: Developer <dev@example.com>',
        'Date:   Tue Nov 10 12:00:00 2026 +0000',
        '',
        '    feat(x-gateway): add token savers',
        '',
        ' 5 files changed, 250 insertions(+), 10 deletions(-)',
        'diff --git a/file.ts b/file.ts',
        'lots of diff content here...',
      ].join('\n');
      const filtered = filterGitLog(gitLogDump);
      expect(filtered).toContain('commit a1b2c3d4e5f6');
      expect(filtered).toContain('Author: Developer <dev@example.com>');
      expect(filtered).toContain('Subject: feat(x-gateway): add token savers');
      expect(filtered).toContain('diff body omitted');
    });

    it('compresses OpenAI Responses format function_call_output while preserving call_id', () => {
      setRtkEnabled(true);
      const porcelain = '## main\n' + Array.from({ length: 40 }, (_, i) => `M  file_${i}.ts`).join('\n');
      const body = {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_abc_123',
            output: porcelain,
          },
        ],
      };

      const res = compressMessages(body, true);
      expect(res).not.toBeNull();
      expect(res!.hits.length).toBeGreaterThan(0);
      expect((body.input[0] as any).call_id).toBe('call_abc_123');
      expect((body.input[0] as any).output).toContain('* main');
    });

    it('preserves error tool results unmodified', () => {
      setRtkEnabled(true);
      const errorDump = 'npm ERR! code ENOENT\nnpm ERR! syscall open\n'.repeat(20);
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_err_1',
                is_error: true,
                content: errorDump,
              },
            ],
          },
        ],
      };

      const res = compressMessages(body, true);
      expect(res).toBeNull();
      expect(((body.messages[0] as any).content[0] as any).content).toBe(errorDump);
    });

    it('keeps original text if compressed version is not smaller', () => {
      setRtkEnabled(true);
      const shortText = 'git diff\n- a\n+ b';
      const body = {
        messages: [
          { role: 'tool', tool_call_id: 'call_short', content: shortText },
        ],
      };

      const res = compressMessages(body, true);
      expect(res).toBeNull();
      expect(body.messages[0].content).toBe(shortText);
    });
  });

  describe('Output Savers Stage', () => {
    it('injects caveman and ponytail into system message and records headers', async () => {
      setRtkEnabled(false);
      setPxpipeEnabled(false);
      setHeadroomConfig({ enabled: false });
      setOutputSaverLevels({ caveman: 'lite', ponytail: 'off' });

      const { req, res, responseHeaders } = createMockReqRes();
      const messages = [{ role: 'user', content: 'Hello' }];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      expect(result.appliedSavers).toContain('caveman(lite)');
      expect(result.injectedOutputChars).toBeGreaterThan(0);
      expect(result.messages[0].role).toBe('system');
      expect(result.messages[0].content).toContain('caveman');
      expect(responseHeaders['x-output-saver-applied']).toContain('caveman(lite)');
    });

    it('bypasses output savers when x-output-saver: off', async () => {
      setOutputSaverLevels({ caveman: 'lite', ponytail: 'off' });
      const { req, res, responseHeaders } = createMockReqRes({ 'x-output-saver': 'off' });
      const messages = [{ role: 'user', content: 'Hello' }];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      expect(result.appliedSavers).not.toContain('caveman(lite)');
      expect(result.messages[0].role).toBe('user');
      expect(responseHeaders['x-output-saver-applied']).toBeUndefined();
    });
  });

  describe('PXPIPE Vision Stage', () => {
    it('renders bulky text context to PNG for vision models', async () => {
      setRtkEnabled(false);
      setHeadroomConfig({ enabled: false });
      setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });
      setPxpipeEnabled(true);
      setPxpipeMinChars(1500);

      const { req, res, responseHeaders } = createMockReqRes();
      const bulkyMsg = { role: 'user', content: 'Extensive documentation data... '.repeat(300) };
      const tailMsg = { role: 'user', content: 'Summarize the documentation above.' };
      const messages = [bulkyMsg, tailMsg];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'claude-3-5-sonnet-20241022',
        targetProvider: 'anthropic',
        format: 'claude',
      });

      expect(result.pxpipeTokensSavedEst).toBeGreaterThan(0);
      expect(result.appliedSavers.some(s => s.startsWith('PXPIPE'))).toBe(true);
      expect(responseHeaders['x-pxpipe-saved-tokens-est']).toBeDefined();

      expect(result.textOnlyMessages[0].content).toBe(bulkyMsg.content);
      expect(Array.isArray(result.messages[0].content)).toBe(true);
    });

    it('bypasses PXPIPE for text-only models like deepseek-chat', async () => {
      setPxpipeEnabled(true);
      setPxpipeMinChars(1500);

      const { req, res } = createMockReqRes();
      const bulkyMsg = { role: 'user', content: 'Extensive documentation data... '.repeat(300) };
      const tailMsg = { role: 'user', content: 'Summarize the documentation above.' };
      const messages = [bulkyMsg, tailMsg];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'deepseek-chat',
        targetProvider: 'deepseek',
      });

      expect(result.pxpipeTokensSavedEst).toBe(0);
      expect(result.appliedSavers.some(s => s.startsWith('PXPIPE'))).toBe(false);
      expect(result.messages[0].content).toBe(bulkyMsg.content);
    });
  });

  describe('Headroom Fail-Open & SSRF Protection Stage', () => {
    it('fails open when headroom service is unreachable or blocked', async () => {
      setRtkEnabled(false);
      setPxpipeEnabled(false);
      setOutputSaverLevels({ caveman: 'off', ponytail: 'off' });
      setHeadroomConfig({
        enabled: true,
        url: 'http://127.0.0.1:9999',
        timeoutMs: 500,
      });

      const { req, res } = createMockReqRes();
      const originalContent = 'Sample user message for headroom test';
      const messages = [{ role: 'user', content: originalContent }];

      const result = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      expect(result.headroomTokensSavedEst).toBe(0);
      expect(result.messages[0].content).toBe(originalContent);
    });
  });

  describe('Idempotency & Double Preprocessing Protection', () => {
    it('does not re-apply savers or duplicate injections when called twice with same req', async () => {
      setOutputSaverLevels({ caveman: 'lite', ponytail: 'off' });
      const { req, res } = createMockReqRes();
      const messages = [{ role: 'user', content: 'First message' }];

      const firstPass = await preprocessGatewayMessages(req, res, {
        messages,
        targetModel: 'gpt-4o',
      });

      const secondPass = await preprocessGatewayMessages(req, res, {
        messages: firstPass.messages,
        targetModel: 'gpt-4o',
      });

      expect(secondPass).toBe(firstPass);
      const systemMessages = secondPass.messages.filter(m => m.role === 'system');
      expect(systemMessages.length).toBe(1);
    });
  });
});
