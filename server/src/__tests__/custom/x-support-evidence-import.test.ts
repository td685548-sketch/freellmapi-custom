import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectDb, defaultDbFactory, type Db } from '../../db/index.js';
import { runMigrations } from '../../db/migrate/runner.js';
import { nodeSqliteFactory } from '../../db/node-sqlite.js';
import { initEncryptionKey } from '../../lib/crypto.js';
import * as supportStore from '../../custom/x-gateway/support-store.js';
import {
  createSupportEvidenceSource,
  ensureSupportEvidenceTables,
  importSupportEvidenceRevision,
  listPublishedSupportEvidenceChunks,
  publishSupportEvidenceRevision,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  chunkCanonicalText,
  SupportEvidenceError,
  validateAndNormalizeImportInput,
  validateImportExportUrl,
} from '../../custom/x-gateway/support-evidence-import.js';
import { SUPPORT_EVIDENCE_LIMITS } from '@freellmapi/shared/support-evidence.js';

let db: Db;
let tenantId: number;

beforeEach(async () => {
  db = connectDb(':memory:', {
    factory: (dbPath) => {
      try {
        return defaultDbFactory()(dbPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ERR_DLOPEN_FAILED') throw error;
        return nodeSqliteFactory(dbPath);
      }
    },
  });
  await runMigrations(db, 'up');
  vi.stubEnv('ENCRYPTION_KEY', '12'.repeat(32));
  initEncryptionKey(db);
  supportStore.ensureSupportTables();
  ensureSupportEvidenceTables(db);
  tenantId = supportStore.createSupportTenant({ name: 'Import Tenant', slug: 'import-tenant' }).tenant.id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  db?.close?.();
});

describe('support-evidence-import', () => {
  it('normalizes BOM, CRLF, NFC, tracks markdown headings and 1-based line numbers, and avoids splitting surrogate pairs', () => {
    const raw = '\uFEFF# Heading One\r\nLine 2 e\u0301\r\n' + '😀'.repeat(600);
    const normalized = validateAndNormalizeImportInput({
      title: '  Unicode Guide  ',
      category: 'guides',
      tags: ['unicode', 'unicode', 'guide'],
      format: 'markdown',
      content: raw,
    });

    expect(normalized.title).toBe('Unicode Guide');
    expect(normalized.tags).toEqual(['unicode', 'guide']);
    expect(normalized.content.startsWith('# Heading One\nLine 2 \u00e9\n')).toBe(true);
    expect(normalized.chunks.length).toBeGreaterThanOrEqual(2);
    expect(normalized.chunks[0].heading).toBe('Heading One');
    expect(normalized.chunks[0].startLine).toBe(1);

    // Ensure no chunk starts or ends with a lone surrogate
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const chunk of normalized.chunks) {
      expect(loneSurrogate.test(chunk.text)).toBe(false);
    }
  });

  it('rejects oversized bytes, oversized normalized chars, >128 chunks, lone surrogates, NUL bytes, and invalid FAQ schemas', () => {
    expect(() =>
      validateAndNormalizeImportInput({
        title: 'Too Big Bytes',
        format: 'text',
        content: 'a'.repeat(SUPPORT_EVIDENCE_LIMITS.maxImportBytes + 1),
      }),
    ).toThrowError(SupportEvidenceError);

    expect(() =>
      validateAndNormalizeImportInput({
        title: 'Too Big Chars',
        format: 'text',
        content: 'a'.repeat(SUPPORT_EVIDENCE_LIMITS.maxNormalizedChars + 1),
      }),
    ).toThrowError(SupportEvidenceError);

    // >128 chunks: 128 chunks with target=1000, overlap=100 -> step=900; 128*900 = 115200 > 64000,
    // so test chunkCanonicalText directly for >128 chunks cap
    expect(() => chunkCanonicalText('a'.repeat(120_000), 'text')).toThrowError(SupportEvidenceError);

    expect(() =>
      validateAndNormalizeImportInput({
        title: 'Bad Surrogate',
        format: 'text',
        content: 'hello \uD800 world',
      }),
    ).toThrowError(SupportEvidenceError);

    expect(() =>
      validateAndNormalizeImportInput({
        title: 'Binary NUL',
        format: 'text',
        content: 'hello\u0000world',
      }),
    ).toThrowError(SupportEvidenceError);

    expect(() =>
      validateAndNormalizeImportInput({
        title: 'Bad FAQ',
        format: 'faq_json',
        content: JSON.stringify([{ question: 'Q?', answer: 'A', extra: 1 }]),
      }),
    ).toThrowError(SupportEvidenceError);
  });

  it('rejects URLs with credentials, queries, fragments, or non-HTTPS in production', () => {
    expect(() => validateImportExportUrl('https://user:pass@example.com/kb.txt')).toThrowError(SupportEvidenceError);
    expect(() => validateImportExportUrl('https://example.com/kb.txt?token=1')).toThrowError(SupportEvidenceError);
    expect(() => validateImportExportUrl('https://example.com/kb.txt#frag')).toThrowError(SupportEvidenceError);

    vi.stubEnv('NODE_ENV', 'production');
    expect(() => validateImportExportUrl('http://example.com/kb.txt')).toThrowError(SupportEvidenceError);
  });

  it('rejects redirects, private DNS IPs, unsupported media types, invalid UTF-8, oversized streams, and timeouts while leaving published source untouched', async () => {
    const src = createSupportEvidenceSource(tenantId, {
      name: 'Remote KB',
      kind: 'url',
      allowedRoles: ['customer'],
    });
    const pubRev = await importSupportEvidenceRevision({
      tenantId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Live v1',
      format: 'text',
      content: undefined,
      url: 'https://kb.example.com/export.txt',
      dnsResolver: async () => ['93.184.216.34'],
      fetchFn: async () =>
        new Response('Live published knowledge.', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    });
    const published = publishSupportEvidenceRevision(tenantId, src.id, pubRev.revision.id, pubRev.source.version);

    // 1. Redirect blocked
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Redirect',
        format: 'text',
        url: 'https://kb.example.com/redirect.txt',
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }),
      }),
    ).rejects.toMatchObject({ status: 403, code: 'unsafe_import_target' });

    // 2. Private DNS resolution blocked
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Private DNS',
        format: 'text',
        url: 'https://internal.example.com/export.txt',
        dnsResolver: async () => ['10.0.0.5'],
        fetchFn: async () => new Response('secret', { status: 200, headers: { 'content-type': 'text/plain' } }),
      }),
    ).rejects.toMatchObject({ status: 403, code: 'unsafe_import_target' });

    // 3. HTML media type rejected
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'HTML Page',
        format: 'text',
        url: 'https://kb.example.com/page.html',
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () =>
          new Response('<html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      }),
    ).rejects.toMatchObject({ status: 415, code: 'unsupported_import_format' });

    // 4. Invalid UTF-8 bytes rejected
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Bad UTF8',
        format: 'text',
        url: 'https://kb.example.com/bad.txt',
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () =>
          new Response(new Uint8Array([0xff, 0xfe, 0xfd]), {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
      }),
    ).rejects.toMatchObject({ status: 415, code: 'unsupported_import_format' });

    // 5. Streamed byte limit > 1MiB rejected
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Huge Stream',
        format: 'text',
        url: 'https://kb.example.com/huge.txt',
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(600_000).fill(65));
              controller.enqueue(new Uint8Array(600_000).fill(65));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
        },
      }),
    ).rejects.toMatchObject({ status: 413, code: 'import_too_large' });

    // 6. Aborted signal never commits late
    const ac = new AbortController();
    ac.abort();
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Aborted',
        format: 'text',
        url: 'https://kb.example.com/aborted.txt',
        signal: ac.signal,
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () => new Response('Late content', { status: 200, headers: { 'content-type': 'text/plain' } }),
      }),
    ).rejects.toMatchObject({ status: 504, code: 'import_timeout' });

    // Live published source remains completely untouched!
    const live = listPublishedSupportEvidenceChunks(tenantId, 'customer');
    expect(live).toHaveLength(1);
    expect(live[0].chunk.text).toBe('Live published knowledge.');
  });

  it('enforces import deadline on slow remote response and rejects non-UTF-8 charset and mismatched format/kind', async () => {
    const { fetchSupportEvidenceExport } = await import('../../custom/x-gateway/support-evidence-import.js');

    // Slow response exceeding deadlineMs
    await expect(
      fetchSupportEvidenceExport({
        url: 'https://kb.example.com/slow.txt',
        format: 'text',
        deadlineMs: 30,
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      }),
    ).rejects.toMatchObject({ status: 504, code: 'import_timeout' });

    // Non-UTF-8 charset rejected
    await expect(
      fetchSupportEvidenceExport({
        url: 'https://kb.example.com/latin1.txt',
        format: 'text',
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () =>
          new Response('hello', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
          }),
      }),
    ).rejects.toMatchObject({ status: 415, code: 'unsupported_import_format' });

    // Mismatched format/kind rejected
    const mdSrc = createSupportEvidenceSource(tenantId, { name: 'MD Only', kind: 'markdown' });
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: mdSrc.id,
        expectedVersion: mdSrc.version,
        title: 'Wrong Format',
        format: 'text',
        content: 'plain text',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_input' });
  });

  it('bounds stalled DNS, stalled headers, stalled body stream, caller disconnect, and late network completion without mutating live source', async () => {
    const src = createSupportEvidenceSource(tenantId, {
      name: 'Deadline Guard KB',
      kind: 'url',
      allowedRoles: ['customer'],
    });
    const initial = await importSupportEvidenceRevision({
      tenantId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Live v1',
      format: 'text',
      url: 'https://kb.example.com/live.txt',
      dnsResolver: async () => ['93.184.216.34'],
      fetchFn: async () =>
        new Response('Live baseline content.', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
    });
    const published = publishSupportEvidenceRevision(tenantId, src.id, initial.revision.id, initial.source.version);

    // 1. Stalled DNS promise (never settles) must still fail with 504 within deadline
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Stalled DNS',
        format: 'text',
        url: 'https://kb.example.com/dns-hang.txt',
        deadlineMs: 25,
        dnsResolver: () => new Promise<string[]>(() => {}),
        fetchFn: async () => new Response('Should not run', { status: 200 }),
      }),
    ).rejects.toMatchObject({ status: 504, code: 'import_timeout' });

    // 2. Stalled headers (fetchFn ignores signal and never settles)
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Stalled Headers',
        format: 'text',
        url: 'https://kb.example.com/header-hang.txt',
        deadlineMs: 25,
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: () => new Promise<Response>(() => {}),
      }),
    ).rejects.toMatchObject({ status: 504, code: 'import_timeout' });

    // 3. Stalled body stream (first chunk arrives, second chunk hangs forever)
    let streamCancelled = false;
    await expect(
      importSupportEvidenceRevision({
        tenantId,
        sourceId: src.id,
        expectedVersion: published.version,
        title: 'Stalled Body',
        format: 'text',
        url: 'https://kb.example.com/body-hang.txt',
        deadlineMs: 25,
        dnsResolver: async () => ['93.184.216.34'],
        fetchFn: async () => {
          let sentFirst = false;
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentFirst) {
                sentFirst = true;
                controller.enqueue(new TextEncoder().encode('partial '));
              }
              // Second pull never enqueues or closes
            },
            cancel() {
              streamCancelled = true;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
      }),
    ).rejects.toMatchObject({ status: 504, code: 'import_timeout' });
    expect(streamCancelled).toBe(true);

    // 4. Caller disconnect mid-flight + late network completion after abort must not commit
    const callerAc = new AbortController();
    let resolveLateFetch!: (res: Response) => void;
    const lateFetchPromise = new Promise<Response>((resolve) => {
      resolveLateFetch = resolve;
    });

    const pendingImport = importSupportEvidenceRevision({
      tenantId,
      sourceId: src.id,
      expectedVersion: published.version,
      title: 'Caller Disconnect',
      format: 'text',
      url: 'https://kb.example.com/late.txt',
      signal: callerAc.signal,
      deadlineMs: 5000,
      dnsResolver: async () => ['93.184.216.34'],
      fetchFn: () => lateFetchPromise,
    });

    setTimeout(() => callerAc.abort(), 15);
    await expect(pendingImport).rejects.toMatchObject({ status: 504, code: 'import_timeout' });

    // Simulate network completing late after caller aborted
    resolveLateFetch(
      new Response('Late content that must never commit.', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );
    await new Promise((r) => setTimeout(r, 20));

    // Verify published source/version/chunks are completely unchanged
    const live = listPublishedSupportEvidenceChunks(tenantId, 'customer');
    expect(live).toHaveLength(1);
    expect(live[0].chunk.text).toBe('Live baseline content.');
  });
});
