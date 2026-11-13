import crypto from 'node:crypto';
import {
  SUPPORT_EVIDENCE_LIMITS,
  type SupportEvidenceFormat,
} from '@freellmapi/shared/support-evidence.js';
import {
  isTrustedPartnerOrigin,
  safeFetch,
  SafeHttpError,
} from './support-safe-http.js';

export class SupportEvidenceError extends Error {
  public statusCode: number;
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupportEvidenceError';
    this.statusCode = status;
  }
}

export interface NormalizedSupportEvidenceChunk {
  ordinal: number;
  heading?: string;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
}

export interface NormalizedSupportEvidenceRevision {
  format: SupportEvidenceFormat;
  title: string;
  category: string;
  tags: string[];
  content: string;
  contentHash: string;
  chunks: NormalizedSupportEvidenceChunk[];
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MARKDOWN_HEADING_RE = /^#{1,6}\s+(.+)$/;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function normalizeText(raw: string): string {
  if (LONE_SURROGATE_RE.test(raw)) {
    throw new SupportEvidenceError(415, 'unsupported_import_format', 'Import content contains invalid UTF-16 surrogates.');
  }
  if (raw.includes('\u0000')) {
    throw new SupportEvidenceError(415, 'unsupported_import_format', 'Binary or NUL-byte content is not supported.');
  }
  let text = raw;
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
  }
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

function normalizeMetadata(input: {
  title: unknown;
  category?: unknown;
  tags?: unknown;
  format: unknown;
}): { format: SupportEvidenceFormat; title: string; category: string; tags: string[] } {
  if (input.format !== 'text' && input.format !== 'markdown' && input.format !== 'faq_json') {
    throw new SupportEvidenceError(415, 'unsupported_import_format', 'Format must be text, markdown, or faq_json.');
  }

  if (typeof input.title !== 'string') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Title is required and must be a string.');
  }
  const title = normalizeText(input.title).trim();
  if (!title || title.length > SUPPORT_EVIDENCE_LIMITS.maxTitleChars) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `Title must be 1..${SUPPORT_EVIDENCE_LIMITS.maxTitleChars} characters.`,
    );
  }

  let category = '';
  if (input.category !== undefined) {
    if (typeof input.category !== 'string') {
      throw new SupportEvidenceError(400, 'invalid_input', 'Category must be a string.');
    }
    category = normalizeText(input.category).trim();
    if (category.length > SUPPORT_EVIDENCE_LIMITS.maxCategoryChars) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `Category must be at most ${SUPPORT_EVIDENCE_LIMITS.maxCategoryChars} characters.`,
      );
    }
  }

  const tags: string[] = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw new SupportEvidenceError(400, 'invalid_input', 'Tags must be an array of strings.');
    }
    if (input.tags.length > SUPPORT_EVIDENCE_LIMITS.maxTagsCount) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `At most ${SUPPORT_EVIDENCE_LIMITS.maxTagsCount} tags are allowed.`,
      );
    }
    const seen = new Set<string>();
    for (const rawTag of input.tags) {
      if (typeof rawTag !== 'string') {
        throw new SupportEvidenceError(400, 'invalid_input', 'Each tag must be a string.');
      }
      const tag = normalizeText(rawTag).trim();
      if (!tag || tag.length > SUPPORT_EVIDENCE_LIMITS.maxTagChars) {
        throw new SupportEvidenceError(
          400,
          'invalid_input',
          `Each tag must be 1..${SUPPORT_EVIDENCE_LIMITS.maxTagChars} characters.`,
        );
      }
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }

  return { format: input.format, title, category, tags };
}

function parseFaqJsonContent(normalizedRaw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedRaw);
  } catch {
    throw new SupportEvidenceError(400, 'invalid_input', 'FAQ JSON content is not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new SupportEvidenceError(400, 'invalid_input', 'FAQ JSON must be an array of {question, answer} items.');
  }
  if (parsed.length < 1 || parsed.length > SUPPORT_EVIDENCE_LIMITS.maxFaqItems) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `FAQ JSON must contain 1..${SUPPORT_EVIDENCE_LIMITS.maxFaqItems} items.`,
    );
  }

  const rendered: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new SupportEvidenceError(400, 'invalid_input', `FAQ item at index ${i} must be an object.`);
    }
    const keys = Object.keys(item as Record<string, unknown>);
    if (keys.some((k) => k !== 'question' && k !== 'answer')) {
      throw new SupportEvidenceError(400, 'invalid_input', `FAQ item at index ${i} contains unsupported fields.`);
    }
    const rec = item as { question?: unknown; answer?: unknown };
    if (typeof rec.question !== 'string' || typeof rec.answer !== 'string') {
      throw new SupportEvidenceError(400, 'invalid_input', `FAQ item at index ${i} requires string question and answer.`);
    }
    const q = normalizeText(rec.question).trim();
    const a = normalizeText(rec.answer).trim();
    if (!q || q.length > SUPPORT_EVIDENCE_LIMITS.maxFaqQuestionChars) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `FAQ question at index ${i} must be 1..${SUPPORT_EVIDENCE_LIMITS.maxFaqQuestionChars} characters.`,
      );
    }
    if (!a || a.length > SUPPORT_EVIDENCE_LIMITS.maxFaqAnswerChars) {
      throw new SupportEvidenceError(
        400,
        'invalid_input',
        `FAQ answer at index ${i} must be 1..${SUPPORT_EVIDENCE_LIMITS.maxFaqAnswerChars} characters.`,
      );
    }
    rendered.push(`Q: ${q}\nA: ${a}`);
  }

  const combined = rendered.join('\n\n');
  if (combined.length > SUPPORT_EVIDENCE_LIMITS.maxNormalizedChars) {
    throw new SupportEvidenceError(
      413,
      'import_too_large',
      `Normalized FAQ content exceeds ${SUPPORT_EVIDENCE_LIMITS.maxNormalizedChars} characters.`,
    );
  }
  return combined;
}

function adjustEndForSurrogate(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    return index - 1;
  }
  return index;
}

function adjustStartForSurrogate(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    return index + 1;
  }
  return index;
}

interface LineSpan {
  lineNumber: number; // 1-based
  startOffset: number;
  endOffset: number; // inclusive of content, exclusive of \n
  heading?: string;
}

function buildLineSpans(text: string, trackHeadings: boolean): LineSpan[] {
  const lines = text.split('\n');
  const spans: LineSpan[] = [];
  let offset = 0;
  let currentHeading: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (trackHeadings) {
      const m = MARKDOWN_HEADING_RE.exec(line.trim());
      if (m) {
        currentHeading = m[1].trim();
      }
    }
    const startOffset = offset;
    const endOffset = offset + line.length;
    spans.push({
      lineNumber: i + 1,
      startOffset,
      endOffset,
      heading: currentHeading,
    });
    offset = endOffset + 1; // +1 for '\n'
  }
  return spans;
}

function findLineForOffset(spans: LineSpan[], offset: number): LineSpan {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const span = spans[mid];
    if (offset < span.startOffset) {
      hi = mid - 1;
    } else if (offset > span.endOffset) {
      lo = mid + 1;
    } else {
      return span;
    }
  }
  return spans[Math.min(Math.max(lo, 0), spans.length - 1)];
}

export function chunkCanonicalText(
  canonicalText: string,
  format: SupportEvidenceFormat,
): NormalizedSupportEvidenceChunk[] {
  const target = SUPPORT_EVIDENCE_LIMITS.chunkTargetChars;
  const overlap = SUPPORT_EVIDENCE_LIMITS.chunkOverlapChars;
  const spans = buildLineSpans(canonicalText, format === 'markdown');
  const chunks: NormalizedSupportEvidenceChunk[] = [];

  let start = 0;
  let ordinal = 1;

  while (start < canonicalText.length) {
    let end = Math.min(start + target, canonicalText.length);
    if (end < canonicalText.length) {
      end = adjustEndForSurrogate(canonicalText, end);
      if (end <= start) {
        end = Math.min(start + target, canonicalText.length);
      }
    }

    const slice = canonicalText.slice(start, end);
    const startSpan = findLineForOffset(spans, start);
    const endSpan = findLineForOffset(spans, Math.max(start, end - 1));

    chunks.push({
      ordinal,
      ...(startSpan.heading ? { heading: startSpan.heading } : {}),
      startLine: startSpan.lineNumber,
      endLine: endSpan.lineNumber,
      text: slice,
      contentHash: sha256Hex(slice),
    });

    if (chunks.length > SUPPORT_EVIDENCE_LIMITS.maxChunksPerRevision) {
      throw new SupportEvidenceError(
        413,
        'import_too_large',
        `Revision exceeds maximum ${SUPPORT_EVIDENCE_LIMITS.maxChunksPerRevision} chunks.`,
      );
    }

    if (end >= canonicalText.length) break;

    let nextStart = Math.max(start + 1, end - overlap);
    nextStart = adjustStartForSurrogate(canonicalText, nextStart);
    if (nextStart <= start) {
      nextStart = end;
    }
    start = nextStart;
    ordinal++;
  }

  return chunks;
}

export function validateAndNormalizeImportInput(input: {
  title: unknown;
  category?: unknown;
  tags?: unknown;
  format: unknown;
  content: unknown;
}): NormalizedSupportEvidenceRevision {
  const meta = normalizeMetadata(input);

  if (typeof input.content !== 'string') {
    throw new SupportEvidenceError(400, 'invalid_input', 'Content must be a UTF-8 string.');
  }
  const rawBytes = Buffer.byteLength(input.content, 'utf8');
  if (rawBytes > SUPPORT_EVIDENCE_LIMITS.maxImportBytes) {
    throw new SupportEvidenceError(
      413,
      'import_too_large',
      `Import exceeds maximum ${SUPPORT_EVIDENCE_LIMITS.maxImportBytes} bytes.`,
    );
  }

  const normalized = normalizeText(input.content);
  if (normalized.length > SUPPORT_EVIDENCE_LIMITS.maxNormalizedChars) {
    throw new SupportEvidenceError(
      413,
      'import_too_large',
      `Normalized content exceeds ${SUPPORT_EVIDENCE_LIMITS.maxNormalizedChars} code units.`,
    );
  }
  if (!normalized.trim()) {
    throw new SupportEvidenceError(400, 'invalid_input', 'Import content cannot be empty.');
  }

  const canonicalContent =
    meta.format === 'faq_json' ? parseFaqJsonContent(normalized) : normalized;

  const chunks = chunkCanonicalText(canonicalContent, meta.format);
  const contentHash = sha256Hex(
    JSON.stringify({
      format: meta.format,
      title: meta.title,
      category: meta.category,
      tags: meta.tags,
      content: canonicalContent,
    }),
  );

  return {
    format: meta.format,
    title: meta.title,
    category: meta.category,
    tags: meta.tags,
    content: canonicalContent,
    contentHash,
    chunks,
  };
}

export function validateImportExportUrl(rawUrl: unknown): URL {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new SupportEvidenceError(400, 'invalid_input', 'Export URL is required.');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SupportEvidenceError(400, 'invalid_input', 'Export URL is not a valid URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new SupportEvidenceError(403, 'unsafe_import_target', 'Export URL must use HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new SupportEvidenceError(403, 'unsafe_import_target', 'Export URL must not contain credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new SupportEvidenceError(400, 'invalid_input', 'Export URL must not contain query parameters or fragments.');
  }
  if (parsed.protocol === 'http:') {
    const allowedTestOrigin =
      process.env.NODE_ENV !== 'production' && isTrustedPartnerOrigin(parsed.origin);
    if (!allowedTestOrigin) {
      throw new SupportEvidenceError(
        403,
        'unsafe_import_target',
        'HTTP export URLs are only permitted for configured non-production trusted test origins.',
      );
    }
  }
  return parsed;
}

function validateResponseContentType(
  contentTypeHeader: string | null,
  expectedFormat: SupportEvidenceFormat,
): void {
  if (!contentTypeHeader) {
    throw new SupportEvidenceError(415, 'unsupported_import_format', 'Export response is missing Content-Type header.');
  }
  const parts = contentTypeHeader.split(';').map((p) => p.trim());
  const mediaType = parts[0]?.toLowerCase() ?? '';

  for (let i = 1; i < parts.length; i++) {
    const param = parts[i];
    if (!param) continue;
    const eqIdx = param.indexOf('=');
    if (eqIdx === -1) continue;
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    const val = param.slice(eqIdx + 1).trim().replace(/^"|"$/g, '').toLowerCase();
    if (key === 'charset' && val !== 'utf-8' && val !== 'utf8') {
      throw new SupportEvidenceError(415, 'unsupported_import_format', 'Export response charset must be UTF-8.');
    }
  }

  const allowedMediaTypes: Record<SupportEvidenceFormat, readonly string[]> = {
    text: ['text/plain'],
    markdown: ['text/markdown', 'text/plain'],
    faq_json: ['application/json'],
  };

  if (!allowedMediaTypes[expectedFormat].includes(mediaType)) {
    throw new SupportEvidenceError(
      415,
      'unsupported_import_format',
      `Unsupported export media type for ${expectedFormat}.`,
    );
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbortCleanup?: () => void,
): Promise<T> {
  if (signal.aborted) {
    onAbortCleanup?.();
    return Promise.reject(new SupportEvidenceError(504, 'import_timeout', 'Import timed out or was aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      onAbortCleanup?.();
      reject(new SupportEvidenceError(504, 'import_timeout', 'Import timed out or was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

export async function fetchSupportEvidenceExport(options: {
  url: string;
  format: SupportEvidenceFormat;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
  dnsResolver?: (host: string) => Promise<string[]>;
  deadlineMs?: number;
}): Promise<string> {
  const parsedUrl = validateImportExportUrl(options.url);
  const deadlineMs = options.deadlineMs ?? SUPPORT_EVIDENCE_LIMITS.importDeadlineMs;

  if (options.signal?.aborted) {
    throw new SupportEvidenceError(504, 'import_timeout', 'Import request was aborted.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Import deadline exceeded'));
  }, deadlineMs);

  const onCallerAbort = () => {
    controller.abort(options.signal?.reason ?? new Error('Import aborted'));
  };
  options.signal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    let res: Response;
    const rawFetchPromise = safeFetch(
      parsedUrl.toString(),
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'text/plain, text/markdown, application/json',
        },
      },
      {
        fetchFn: options.fetchFn,
        dnsResolver: options.dnsResolver,
      },
    );
    // Ensure late resolution or rejection after timeout/abort cleans up and never leaks unhandled rejections.
    void rawFetchPromise.then(
      (lateRes) => {
        if (controller.signal.aborted) {
          void lateRes.body?.cancel().catch(() => {});
        }
      },
      () => {},
    );

    try {
      res = await raceWithAbort(rawFetchPromise, controller.signal);
    } catch (err) {
      if (err instanceof SupportEvidenceError) throw err;
      if (timedOut || controller.signal.aborted) {
        throw new SupportEvidenceError(504, 'import_timeout', 'Export fetch timed out or was aborted.');
      }
      if (err instanceof SafeHttpError) {
        if (err.status === 403 || err.status === 400) {
          throw new SupportEvidenceError(403, 'unsafe_import_target', 'Export URL target is blocked by security policy.');
        }
        throw new SupportEvidenceError(502, 'unsafe_import_target', 'Export URL network or DNS lookup failed.');
      }
      throw new SupportEvidenceError(502, 'unsafe_import_target', 'Export URL fetch failed.');
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new SupportEvidenceError(502, 'unsafe_import_target', `Export endpoint returned HTTP ${res.status}.`);
    }

    validateResponseContentType(res.headers.get('content-type'), options.format);

    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredBytes = Number(contentLengthHeader);
      if (Number.isFinite(declaredBytes) && declaredBytes > SUPPORT_EVIDENCE_LIMITS.maxImportBytes) {
        await res.body?.cancel().catch(() => {});
        throw new SupportEvidenceError(
          413,
          'import_too_large',
          `Export exceeds maximum ${SUPPORT_EVIDENCE_LIMITS.maxImportBytes} bytes.`,
        );
      }
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          if (controller.signal.aborted) {
            void reader.cancel().catch(() => {});
            throw new SupportEvidenceError(504, 'import_timeout', 'Export stream timed out or was aborted.');
          }
          const readPromise = reader.read();
          void readPromise.catch(() => {});
          const { done, value } = await raceWithAbort(readPromise, controller.signal, () => {
            void reader.cancel().catch(() => {});
          });
          if (done) break;
          if (value) {
            totalBytes += value.byteLength;
            if (totalBytes > SUPPORT_EVIDENCE_LIMITS.maxImportBytes) {
              await reader.cancel().catch(() => {});
              throw new SupportEvidenceError(
                413,
                'import_too_large',
                `Export exceeds maximum ${SUPPORT_EVIDENCE_LIMITS.maxImportBytes} bytes.`,
              );
            }
            chunks.push(value);
          }
        }
      } catch (err) {
        if (err instanceof SupportEvidenceError) throw err;
        if (timedOut || controller.signal.aborted) {
          throw new SupportEvidenceError(504, 'import_timeout', 'Export stream timed out or was aborted.');
        }
        throw new SupportEvidenceError(502, 'unsafe_import_target', 'Failed to read export response stream.');
      }
    }

    if (controller.signal.aborted) {
      throw new SupportEvidenceError(504, 'import_timeout', 'Import timed out or was aborted.');
    }

    const combined = Buffer.concat(chunks, totalBytes);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(combined);
    } catch {
      throw new SupportEvidenceError(415, 'unsupported_import_format', 'Export response is not valid UTF-8.');
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}
