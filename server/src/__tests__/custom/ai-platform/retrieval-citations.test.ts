import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import {
  CITATIONS_HEADER_NAME,
  RETRIEVAL_HEADER_NAME,
  RETRIEVAL_LIMITS,
  type CitationEntry,
  type RetrievalHit,
} from '@freellmapi/shared/ai-platform-retrieval.js';
import {
  applyCitationsHeader,
  buildCitations,
  citationFilter,
  encodeCitationsHeader,
  formatRetrievalHeader,
} from '../../../custom/ai-platform/retrieval/citations.js';
import { installInterceptor } from '../../../custom/ai-platform/wire/interceptor.js';

function makeHit(overrides: Partial<RetrievalHit> = {}): RetrievalHit {
  return {
    docId: '101',
    chunkId: 1,
    ord: 0,
    title: 'Refund Policy',
    snippet: 'Refunds are processed within 5-7 business days.',
    text: 'Refunds are processed within 5-7 business days to the original payment method.',
    score: 0.9123456,
    keywordRank: 1,
    semanticRank: 1,
    sources: ['keyword', 'semantic'],
    ...overrides,
  };
}

function makeResponseMock(headersSent = false) {
  const reqEmitter = new EventEmitter();
  const resEmitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const written: Buffer[] = [];
  const jsonOut: unknown[] = [];

  const req = Object.assign(reqEmitter, {
    method: 'POST',
    originalUrl: '/v1/chat/completions',
    url: '/v1/chat/completions',
  }) as unknown as Request;

  const res = Object.assign(resEmitter, {
    statusCode: 200,
    headersSent,
    writableFinished: false,
    setHeader(name: string, val: string | string[]) {
      headers[name.toLowerCase()] = Array.isArray(val) ? val.join(', ') : String(val);
      return res;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    removeHeader(name: string) {
      delete headers[name.toLowerCase()];
    },
    write(chunk: string | Uint8Array, encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      const encoding = typeof encOrCb === 'string' ? encOrCb : 'utf8';
      const callback = typeof encOrCb === 'function' ? encOrCb : cb;
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk, encoding)
          : Buffer.from(chunk);
      written.push(buf);
      callback?.();
      return true;
    },
    end(chunk?: string | Uint8Array | (() => void), encOrCb?: BufferEncoding | (() => void), cb?: () => void) {
      let actual: string | Uint8Array | undefined;
      let encoding: BufferEncoding = 'utf8';
      let callback: (() => void) | undefined;
      if (typeof chunk === 'function') callback = chunk;
      else {
        actual = chunk;
        if (typeof encOrCb === 'function') callback = encOrCb;
        else if (typeof encOrCb === 'string') {
          encoding = encOrCb;
          callback = cb;
        }
      }
      if (actual !== undefined) {
        written.push(
          Buffer.isBuffer(actual)
            ? actual
            : typeof actual === 'string'
              ? Buffer.from(actual, encoding)
              : Buffer.from(actual),
        );
      }
      (res as unknown as { writableFinished: boolean }).writableFinished = true;
      callback?.();
      resEmitter.emit('finish');
      return res;
    },
    json(body: unknown) {
      jsonOut.push(body);
      (res as unknown as { writableFinished: boolean }).writableFinished = true;
      return res;
    },
  }) as unknown as Response;

  return { req, res, headers, written, jsonOut };
}

describe('retrieval/citations', () => {
  it('buildCitations projects hits cleanly with rounded scores and fallback snippets', () => {
    const hits: RetrievalHit[] = [
      makeHit(),
      makeHit({
        docId: '202',
        chunkId: 9,
        ord: 2,
        title: 'Shipping Guide',
        snippet: '',
        text: '  Express   shipping arrives in 2 days.  ',
        score: 0.5,
      }),
    ];

    const citations = buildCitations(hits);
    expect(citations).toEqual([
      {
        docId: '101',
        chunkId: 1,
        title: 'Refund Policy',
        score: 0.9123,
        snippet: 'Refunds are processed within 5-7 business days.',
      },
      {
        docId: '202',
        chunkId: 9,
        title: 'Shipping Guide',
        score: 0.5,
        snippet: 'Express shipping arrives in 2 days.',
      },
    ]);
  });

  it('encodeCitationsHeader encodes base64url JSON within 4 KB by popping tail entries', () => {
    const many: CitationEntry[] = Array.from({ length: 40 }, (_, i) => ({
      docId: `doc-${i + 1}`,
      chunkId: i + 1,
      title: `Policy Section ${i + 1} with Descriptive Title`,
      score: 1 - i * 0.01,
      snippet: `Detailed snippet number ${i + 1} `.repeat(8).trim(),
    }));

    const encoded = encodeCitationsHeader(many);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(
      RETRIEVAL_LIMITS.citationsHeaderMaxBytes,
    );
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);

    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as CitationEntry[];
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.length).toBeLessThan(many.length);
    // Preserves highest-priority prefix entries in order
    expect(decoded[0]?.docId).toBe('doc-1');
    expect(decoded[decoded.length - 1]?.docId).toBe(`doc-${decoded.length}`);
  });

  it('encodeCitationsHeader truncates an oversized single citation cleanly without breaking UTF-8', () => {
    const oversized: CitationEntry[] = [
      {
        docId: 'doc-vi',
        chunkId: 1,
        title: 'Chính sách bảo hành mở rộng',
        score: 0.88,
        snippet: 'Tiếng Việt có dấu và biểu tượng 🚀 '.repeat(250),
      },
    ];

    const encoded = encodeCitationsHeader(oversized, 512);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(512);
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as CitationEntry[];
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.docId).toBe('doc-vi');
    expect(decoded[0]?.snippet.includes('\uFFFD')).toBe(false);
    expect(decoded[0]?.snippet.endsWith('…')).toBe(true);
  });

  it('applyCitationsHeader sets retrieval and citations headers unless disabled or empty', () => {
    const hits = [makeHit()];
    const citations = buildCitations(hits);

    const m1 = makeResponseMock();
    applyCitationsHeader(m1.res, citations, formatRetrievalHeader('hybrid', false));
    expect(m1.headers[RETRIEVAL_HEADER_NAME]).toBe('hybrid');
    expect(m1.headers[CITATIONS_HEADER_NAME]).toBeDefined();
    const decoded = JSON.parse(
      Buffer.from(m1.headers[CITATIONS_HEADER_NAME]!, 'base64url').toString('utf8'),
    ) as CitationEntry[];
    expect(decoded).toEqual(citations);

    // Disabled via x-freellm-citations: off -> omits citations header, keeps retrieval header
    const m2 = makeResponseMock();
    applyCitationsHeader(m2.res, citations, formatRetrievalHeader('keyword', true), {
      citationsEnabled: false,
    });
    expect(m2.headers[RETRIEVAL_HEADER_NAME]).toBe('keyword;degraded');
    expect(m2.headers[CITATIONS_HEADER_NAME]).toBeUndefined();

    // Empty citations -> omits citations header
    const m3 = makeResponseMock();
    applyCitationsHeader(m3.res, [], 'keyword');
    expect(m3.headers[RETRIEVAL_HEADER_NAME]).toBe('keyword');
    expect(m3.headers[CITATIONS_HEADER_NAME]).toBeUndefined();

    // headersSent === true -> no throw, no mutation
    const m4 = makeResponseMock(true);
    applyCitationsHeader(m4.res, citations, 'hybrid');
    expect(m4.headers[RETRIEVAL_HEADER_NAME]).toBeUndefined();
  });

  it('citationFilter respects disabled flag and allowedDocIds role boundary', () => {
    const hits = [
      makeHit({ docId: 'public-doc', chunkId: 1, title: 'Public FAQ' }),
      makeHit({ docId: 'admin-doc', chunkId: 2, title: 'Admin Margins' }),
    ];

    expect(citationFilter('openai-chat', hits, { disabled: true })).toBeNull();
    expect(citationFilter('openai-chat', [])).toBeNull();
    expect(
      citationFilter('openai-chat', hits, { allowedDocIds: new Set(['other-doc']) }),
    ).toBeNull();

    const filtered = citationFilter('openai-chat', hits, {
      allowedDocIds: new Set(['public-doc']),
    });
    expect(filtered).not.toBeNull();
    const out = filtered!.onResponseObject({ id: 'chatcmpl-1', choices: [] });
    expect(out?.citations).toHaveLength(1);
    expect((out?.citations as CitationEntry[])[0]?.docId).toBe('public-doc');
  });

  it('citationFilter attaches top-level citations only for openai-chat and responses, never anthropic or gemini', async () => {
    const hits = [makeHit()];

    const openaiBody = { id: 'chatcmpl-1', object: 'chat.completion', choices: [] };
    const openaiFilter = citationFilter('openai-chat', hits)!;
    expect(openaiFilter.buffering).toBeFalsy();
    expect(await openaiFilter.onComplete?.('Answer text')).toEqual({
      action: 'pass',
      text: 'Answer text',
    });
    const openaiOut = openaiFilter.onResponseObject(openaiBody);
    expect(openaiOut).toBeDefined();
    expect(openaiOut?.citations).toEqual(buildCitations(hits));
    expect((openaiBody as Record<string, unknown>).citations).toBeUndefined();

    const responsesBody = { id: 'resp-1', object: 'response', output_text: 'Hi' };
    const responsesFilter = citationFilter('responses', hits)!;
    const responsesOut = responsesFilter.onResponseObject(responsesBody);
    expect(responsesOut?.citations).toEqual(buildCitations(hits));

    const anthropicFilter = citationFilter('anthropic', hits)!;
    expect(
      anthropicFilter.onResponseObject({ id: 'msg-1', type: 'message', content: [] }),
    ).toBeUndefined();

    const geminiFilter = citationFilter('gemini', hits)!;
    expect(geminiFilter.onResponseObject({ candidates: [] })).toBeUndefined();
  });

  it('citationFilter passes SSE streams through installInterceptor without altering text', async () => {
    const hits = [makeHit()];
    const filter = citationFilter('openai-chat', hits)!;
    const m = makeResponseMock();
    installInterceptor(m.req, m.res, 'openai-chat', [filter]);

    m.res.write(
      'data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
    );
    m.res.write(
      'data: {"id":"1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
    );
    m.res.end('data: [DONE]\n\n');
    await new Promise((r) => setTimeout(r, 20));

    const streamed = Buffer.concat(m.written).toString('utf8');
    expect(streamed).toContain('"content":"Hello"');
    expect(streamed).toContain('"content":" world"');
    expect(streamed).toContain('data: [DONE]');
  });
});
