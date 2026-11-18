import {
  EVAL_CANARY_LIMITS,
  type CredentialScrubSettings,
  type CredentialScrubSettingsInput,
  type Scope,
  type ScopeKind,
} from '@freellmapi/shared/ai-platform-eval-canary.js';
import { getDb } from '../../../db/index.js';
import { normalizeScope } from '../scope.js';
import type { GuardAction, OutputFilter, OutputFilterSink } from '../wire/interceptor.js';
import { assertScopeExists } from './store.js';

export interface CredentialPatternEntry {
  name: string;
  regex: RegExp;
  replacement: string;
}

export interface CredentialScrubDetection {
  type: string;
  count: number;
}

export interface CredentialScrubResult {
  text: string;
  detections: CredentialScrubDetection[];
  modified: boolean;
}

export interface CredentialStreamScrubberOptions {
  windowChars?: number;
  maxBufferChars?: number;
}

export interface CredentialStreamScrubber {
  push(chunk: string): CredentialScrubResult & { emit: string };
  flush(): CredentialScrubResult & { emit: string };
  reset(): void;
  getBufferedLength(): number;
}

/**
 * Ordered credential signature catalog inspired by OmniRoute's credentialMasker.
 * Specific provider prefixes (`sk-proj-`, `sk-ant-`) MUST precede the generic `sk-` fallback.
 */
export const CREDENTIAL_SCRUB_PATTERNS: readonly CredentialPatternEntry[] = [
  {
    name: 'openai_proj',
    regex: /sk-proj-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:openai]',
  },
  {
    name: 'anthropic',
    regex: /sk-ant-api[0-9]?-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:anthropic]',
  },
  {
    name: 'anthropic_alt',
    regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:anthropic]',
  },
  {
    name: 'openai',
    regex: /\bsk-[A-Za-z0-9]{32,}\b/g,
    replacement: '[REDACTED:openai]',
  },
  {
    name: 'groq',
    regex: /\bgsk_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:groq]',
  },
  {
    name: 'xai',
    regex: /\bxai-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:xai]',
  },
  {
    name: 'google',
    regex: /AIza[0-9A-Za-z_-]{20,}/g,
    replacement: '[REDACTED:google]',
  },
  {
    name: 'huggingface',
    regex: /\bhf_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:hf]',
  },
  {
    name: 'replicate',
    regex: /\br8_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:replicate]',
  },
  {
    name: 'github',
    regex: /gh[pousr]_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:github]',
  },
  {
    name: 'slack',
    regex: /xox[bpoa]-[A-Za-z0-9-]{10,}/g,
    replacement: '[REDACTED:slack]',
  },
  {
    name: 'linear',
    regex: /lin_api_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:linear]',
  },
  {
    name: 'notion',
    regex: /secret_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:notion]',
  },
  {
    name: 'npm',
    regex: /npm_[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED:npm]',
  },
  {
    name: 'postman',
    regex: /PMAK-[a-f0-9]{8}-[a-f0-9]{16,}/gi,
    replacement: '[REDACTED:postman]',
  },
  {
    name: 'stripe',
    regex: /(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}/g,
    replacement: '[REDACTED:stripe]',
  },
  {
    name: 'square',
    regex: /sq0(?:atp-[0-9A-Za-z_-]{20,}|csp-[0-9A-Za-z_-]{20,})/g,
    replacement: '[REDACTED:square]',
  },
  {
    name: 'aws_access_key',
    regex: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED:aws]',
  },
  {
    name: 'sendgrid',
    regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
    replacement: '[REDACTED:sendgrid]',
  },
  {
    name: 'mailgun',
    regex: /key-[a-f0-9]{32}/g,
    replacement: '[REDACTED:mailgun]',
  },
  {
    name: 'private_key',
    // Linear-time PEM matcher: body cannot contain "-----", avoiding catastrophic backtracking.
    regex:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----(?:[^-]|-(?!----))*-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'connection_string',
    regex:
      /((?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis(?:\+tls|s)?|amqps?):\/\/)[^:/@\s"']*:[^/@\s"']+@/gi,
    replacement: '$1[REDACTED:credentials]@',
  },
  {
    name: 'auth_header',
    regex:
      /((?:["']?(?:Authorization|x-api-key|api-key|apikey)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?)[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: '$1[REDACTED:auth_header]',
  },
  {
    name: 'openai_compatible',
    regex: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED:openai]',
  },
];

export const PARTIAL_PREFIXES: ReadonlyArray<{ prefix: string; minBody: number; caseInsensitive?: boolean }> = [
  { prefix: 'sk-proj-', minBody: 0 },
  { prefix: 'sk-ant-api', minBody: 0 },
  { prefix: 'sk-ant-', minBody: 0 },
  { prefix: 'sk_live_', minBody: 0 },
  { prefix: 'sk_test_', minBody: 0 },
  { prefix: 'rk_live_', minBody: 0 },
  { prefix: 'rk_test_', minBody: 0 },
  { prefix: 'sk-', minBody: 0 },
  { prefix: 'AKIA', minBody: 0 },
  { prefix: 'gsk_', minBody: 0 },
  { prefix: 'xai-', minBody: 0 },
  { prefix: 'AIza', minBody: 0 },
  { prefix: 'hf_', minBody: 0 },
  { prefix: 'r8_', minBody: 0 },
  { prefix: 'ghp_', minBody: 0 },
  { prefix: 'gho_', minBody: 0 },
  { prefix: 'ghu_', minBody: 0 },
  { prefix: 'ghs_', minBody: 0 },
  { prefix: 'ghr_', minBody: 0 },
  { prefix: 'xoxb-', minBody: 0 },
  { prefix: 'xoxp-', minBody: 0 },
  { prefix: 'xoxo-', minBody: 0 },
  { prefix: 'xoxa-', minBody: 0 },
  { prefix: 'xox-', minBody: 0 },
  { prefix: 'lin_api_', minBody: 0 },
  { prefix: 'secret_', minBody: 0 },
  { prefix: 'npm_', minBody: 0 },
  { prefix: 'PMAK-', minBody: 0, caseInsensitive: true },
  { prefix: 'SG.', minBody: 0 },
  { prefix: 'key-', minBody: 0 },
  { prefix: '-----BEGIN', minBody: 0 },
  { prefix: 'eyJ', minBody: 0 },
  { prefix: 'sq0atp-', minBody: 0 },
  { prefix: 'sq0csp-', minBody: 0 },
  { prefix: 'postgres://', minBody: 0, caseInsensitive: true },
  { prefix: 'postgresql://', minBody: 0, caseInsensitive: true },
  { prefix: 'mongodb://', minBody: 0, caseInsensitive: true },
  { prefix: 'mongodb+srv://', minBody: 0, caseInsensitive: true },
  { prefix: 'mysql://', minBody: 0, caseInsensitive: true },
  { prefix: 'redis://', minBody: 0, caseInsensitive: true },
  { prefix: 'rediss://', minBody: 0, caseInsensitive: true },
  { prefix: 'redis+tls://', minBody: 0, caseInsensitive: true },
  { prefix: 'amqp://', minBody: 0, caseInsensitive: true },
  { prefix: 'amqps://', minBody: 0, caseInsensitive: true },
];

export const UNCLOSED_BEGIN_PREFIX = '-----BEGIN[^-]*$';
export const UNCLOSED_AUTHORITY_PREFIX = ':\\/\\/[^/@\\s"\']*$';

const MAX_PARTIAL_PROBE = 512;
const TOKEN_BOUNDARY = /[\s"'\\{}[\],;()<>]/;
const BEGIN_HEAD = '-----BEGIN';
const BEGIN_HEADER_PATTERN = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;
const END_MARKER_PATTERN = /-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/;
const BEGIN_HEADER_SLICE = 64;
const END_LOOKBEHIND = 64;

const PARTIAL_TAIL_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----?$/,
  new RegExp(UNCLOSED_BEGIN_PREFIX),
  /-(?:-{0,4}(?:B(?:E(?:G(?:I(?:N[^-]*)?)?)?)?)?)?$/,
  new RegExp(
    `(?:mongodb(?:\\+srv)?|postgres(?:ql)?|mysql|redis(?:\\+tls|s)?|amqps?)${UNCLOSED_AUTHORITY_PREFIX}`,
    'i',
  ),
  /(?:["']?(?:authorization|x-api-key|api-key|apikey)["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic|Token)\s+)?)[A-Za-z0-9._~+/=-]*$/i,
  /data:image\/[a-zA-Z0-9.+-]*(?:;(?:b(?:a(?:s(?:e(?:6(?:4(?:,[a-zA-Z0-9+/=]*)?)?)?)?)?)?)?)?$/,
];

const DATA_URL_MIME = 'data:image/';
const DATA_URL_ENCODING = ';base64,';
const MIME_TAIL = /^[a-zA-Z0-9.+-]+$/;
const BASE64_TAIL = /^[a-zA-Z0-9+/=]+/;

function mergeDetections(
  target: CredentialScrubDetection[],
  incoming: readonly CredentialScrubDetection[],
): void {
  for (const item of incoming) {
    const existing = target.find((d) => d.type === item.type);
    if (existing) {
      existing.count += item.count;
    } else {
      target.push({ type: item.type, count: item.count });
    }
  }
}

function redactPlainSpan(text: string): CredentialScrubResult {
  if (!text) return { text, detections: [], modified: false };
  let result = text;
  const detections: CredentialScrubDetection[] = [];
  for (const p of CREDENTIAL_SCRUB_PATTERNS) {
    const re = new RegExp(p.regex.source, p.regex.flags);
    const matches = result.match(re);
    if (matches && matches.length > 0) {
      result = result.replace(new RegExp(p.regex.source, p.regex.flags), p.replacement);
      detections.push({ type: p.name, count: matches.length });
    }
  }
  return { text: result, detections, modified: result !== text };
}

function findUnclosedBeginIndex(text: string): number | undefined {
  let from = 0;
  for (;;) {
    const at = text.indexOf(BEGIN_HEAD, from);
    if (at === -1) return undefined;
    const slice = text.slice(at, at + BEGIN_HEADER_SLICE);
    const head = BEGIN_HEADER_PATTERN.exec(slice);
    if (head) {
      if (!END_MARKER_PATTERN.test(text.slice(at + head[0].length))) {
        return at;
      }
    } else if (at + BEGIN_HEADER_SLICE >= text.length) {
      // Potentially still streaming the "-----BEGIN ... PRIVATE KEY-----" header line itself
      if (/^-----BEGIN(?: [A-Z ]*)?-{0,5}$/.test(text.slice(at))) {
        return at;
      }
    }
    from = at + BEGIN_HEAD.length;
  }
}

function markUnclosedBeginHead(input: CredentialScrubResult): CredentialScrubResult {
  const at = findUnclosedBeginIndex(input.text);
  if (at === undefined) return input;
  const head = BEGIN_HEADER_PATTERN.exec(input.text.slice(at, at + BEGIN_HEADER_SLICE));
  if (!head) return input;
  const detections = [...input.detections];
  mergeDetections(detections, [{ type: 'private_key', count: 1 }]);
  return {
    text: `${input.text.slice(0, at)}[REDACTED:private_key]`,
    detections,
    modified: true,
  };
}

/**
 * Redacts all cataloged credentials in `text` while preserving `data:image/*;base64,...` URLs.
 * When `opts.isFinal` is true (default), any unclosed PEM private key block is also redacted.
 */
export function scrubCredentialsInText(
  text: string,
  opts?: { isFinal?: boolean },
): CredentialScrubResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: text ?? '', detections: [], modified: false };
  }
  const isFinal = opts?.isFinal ?? true;

  let cursor = 0;
  let rebuilt = '';
  let hasDataUrl = false;
  const detections: CredentialScrubDetection[] = [];

  for (;;) {
    const mimeAt = text.indexOf(DATA_URL_MIME, cursor);
    if (mimeAt === -1) break;
    const mimeEnd = mimeAt + DATA_URL_MIME.length;
    const encodingAt = text.indexOf(DATA_URL_ENCODING, mimeEnd);
    if (encodingAt === -1) break;
    const mimeType = text.slice(mimeEnd, encodingAt);
    if (!MIME_TAIL.test(mimeType)) {
      cursor = mimeEnd;
      continue;
    }
    const payloadStart = encodingAt + DATA_URL_ENCODING.length;
    const tail = BASE64_TAIL.exec(text.slice(payloadStart));
    if (!tail) {
      cursor = payloadStart;
      continue;
    }
    hasDataUrl = true;
    const before = redactPlainSpan(text.slice(cursor, mimeAt));
    rebuilt += before.text;
    mergeDetections(detections, before.detections);
    rebuilt += text.slice(mimeAt, payloadStart + tail[0].length);
    cursor = payloadStart + tail[0].length;
  }

  let baseResult: CredentialScrubResult;
  if (!hasDataUrl) {
    baseResult = redactPlainSpan(text);
  } else {
    const after = redactPlainSpan(text.slice(cursor));
    rebuilt += after.text;
    mergeDetections(detections, after.detections);
    baseResult = {
      text: rebuilt,
      detections,
      modified: rebuilt !== text,
    };
  }

  return isFinal ? markUnclosedBeginHead(baseResult) : baseResult;
}

function isPlausiblePartialToken(token: string): boolean {
  if (!token) return false;
  const lower = token.toLowerCase();
  for (const entry of PARTIAL_PREFIXES) {
    const p = entry.caseInsensitive ? entry.prefix.toLowerCase() : entry.prefix;
    const candidate = entry.caseInsensitive ? lower : token;
    // Either `token` is still forming the prefix ("s", "sk", "sk-pr", "post", "AI")
    // or `token` has started the prefix and has not hit a delimiter yet ("sk-proj-abc123").
    if (p.startsWith(candidate)) return true;
    if (candidate.startsWith(p)) {
      // Connection strings complete their secret portion at '@'; once '@' is present,
      // the authority credentials are complete and can be scrubbed immediately.
      if (entry.prefix.endsWith('://') && candidate.includes('@')) continue;
      return true;
    }
  }
  // Auth header keywords still typing (e.g. "Authoriz", "x-api-")
  for (const kw of ['authorization', 'x-api-key', 'api-key', 'apikey', 'data:image/']) {
    if (kw.startsWith(lower)) return true;
  }
  return false;
}

function findTrailingTokenHoldIndex(buffer: string): number | undefined {
  let tokenStart = buffer.length;
  while (tokenStart > 0 && !TOKEN_BOUNDARY.test(buffer[tokenStart - 1]!)) {
    tokenStart -= 1;
  }
  if (tokenStart >= buffer.length) return undefined;

  const fullToken = buffer.slice(tokenStart);
  if (isPlausiblePartialToken(fullToken)) {
    return tokenStart;
  }

  // Check sub-tokens after `=` or `:` (e.g. `OPENAI_API_KEY=sk-proj-...` or `token:ghp_...`)
  for (let i = tokenStart; i < buffer.length; i += 1) {
    const ch = buffer[i];
    if ((ch === '=' || ch === ':') && i + 1 < buffer.length) {
      // Do not split `scheme://...` at `:`
      if (ch === ':' && buffer[i + 1] === '/' && buffer[i + 2] === '/') continue;
      const sub = buffer.slice(i + 1);
      if (isPlausiblePartialToken(sub)) {
        return i + 1;
      }
    }
  }

  return undefined;
}

/**
 * Finds the earliest buffer index where a partial credential or unclosed block touches
 * the end of `buffer`, or `undefined` when the tail has no partial credential prefix.
 */
export function findCredentialPartialTailIndex(buffer: string): number | undefined {
  if (!buffer) return undefined;
  let earliest: number | undefined;

  const note = (idx: number | undefined) => {
    if (idx !== undefined && idx >= 0 && (earliest === undefined || idx < earliest)) {
      earliest = idx;
    }
  };

  note(findUnclosedBeginIndex(buffer));
  note(findTrailingTokenHoldIndex(buffer));

  const tail = buffer.length > MAX_PARTIAL_PROBE ? buffer.slice(-MAX_PARTIAL_PROBE) : buffer;
  const base = buffer.length - tail.length;

  for (const pattern of PARTIAL_TAIL_PATTERNS) {
    const re = new RegExp(`(?:${pattern.source})$`, pattern.flags.replace(/g/g, ''));
    const m = re.exec(tail);
    if (m && typeof m.index === 'number') {
      note(base + m.index);
    }
  }

  return earliest;
}

function beforeCrossingMatch(text: string, pattern: RegExp, cut: number): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  for (const match of text.matchAll(re)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start < cut && end > cut) {
      return start;
    }
  }
  return cut;
}

function backOffSurrogate(text: string, cut: number): number {
  let safe = Math.max(0, Math.min(text.length, cut));
  if (safe > 0 && safe < text.length) {
    const code = text.charCodeAt(safe - 1);
    if (code >= 0xd800 && code <= 0xdbff) safe -= 1;
  }
  return safe;
}

type OverflowContinuation =
  | { kind: 'pem'; tail: string }
  | { kind: 'token'; charPattern: RegExp }
  | { kind: 'image'; charPattern: RegExp };

/**
 * Creates a stateful chunk-boundary credential scrubber with zero-leak tail holdback
 * and bounded memory window (`maxBufferChars`, default 64 KiB).
 */
export function createCredentialStreamScrubber(
  options?: CredentialStreamScrubberOptions,
): CredentialStreamScrubber {
  const windowChars = Math.max(0, Math.floor(options?.windowChars ?? 0));
  const maxBufferChars = Math.max(
    64,
    Math.floor(options?.maxBufferChars ?? EVAL_CANARY_LIMITS.maxScrubBufferChars),
  );

  let buffer = '';
  let continuation: OverflowContinuation | null = null;

  const consumeContinuation = (incoming: string): { passThrough: string; remaining: string } => {
    if (!continuation || !incoming) return { passThrough: '', remaining: incoming };
    if (continuation.kind === 'pem') {
      const joined = continuation.tail + incoming;
      const endMatch = END_MARKER_PATTERN.exec(joined);
      if (!endMatch) {
        continuation.tail = joined.slice(-END_LOOKBEHIND);
        return { passThrough: '', remaining: '' };
      }
      continuation = null;
      return { passThrough: '', remaining: joined.slice(endMatch.index + endMatch[0].length) };
    }
    const kind = continuation.kind;
    const match = continuation.charPattern.exec(incoming)?.[0] ?? '';
    if (match.length < incoming.length) {
      continuation = null;
    }
    return {
      passThrough: kind === 'image' ? match : '',
      remaining: incoming.slice(match.length),
    };
  };

  return {
    push(chunk: string) {
      if (!chunk) {
        return { text: '', emit: '', detections: [], modified: false };
      }

      const cont = consumeContinuation(chunk);
      if (!cont.remaining && buffer.length === 0) {
        return { text: cont.passThrough, emit: cont.passThrough, detections: [], modified: false };
      }
      buffer += cont.remaining;

      let cut = Math.max(0, buffer.length - windowChars);
      const partialIdx = findCredentialPartialTailIndex(buffer);
      if (partialIdx !== undefined && cut > partialIdx) {
        cut = partialIdx;
      }
      for (const entry of CREDENTIAL_SCRUB_PATTERNS) {
        cut = beforeCrossingMatch(buffer, entry.regex, cut);
      }
      cut = backOffSurrogate(buffer, cut);

      // Handle bounded buffer overflow without ever leaking raw credential characters
      if (buffer.length > maxBufferChars && buffer.length - cut > maxBufferChars) {
        const prefixOut = cut > 0 ? scrubCredentialsInText(buffer.slice(0, cut), { isFinal: false }) : null;
        const held = buffer.slice(cut);
        const beginMatch = BEGIN_HEADER_PATTERN.exec(held);
        if (beginMatch && !END_MARKER_PATTERN.test(held.slice(beginMatch.index + beginMatch[0].length))) {
          const prePem = scrubCredentialsInText(held.slice(0, beginMatch.index), { isFinal: false });
          continuation = { kind: 'pem', tail: held.slice(-END_LOOKBEHIND) };
          buffer = '';
          const detections: CredentialScrubDetection[] = [];
          if (prefixOut) mergeDetections(detections, prefixOut.detections);
          mergeDetections(detections, prePem.detections);
          mergeDetections(detections, [{ type: 'private_key', count: 1 }]);
          const emit = `${cont.passThrough}${prefixOut?.text ?? ''}${prePem.text}[REDACTED:private_key]`;
          return { text: emit, emit, detections, modified: true };
        }

        if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(held)) {
          continuation = { kind: 'image', charPattern: /^[a-zA-Z0-9+/=]+/ };
          buffer = '';
          const emit = `${cont.passThrough}${prefixOut?.text ?? ''}${held}`;
          return {
            text: emit,
            emit,
            detections: prefixOut?.detections ?? [],
            modified: Boolean(prefixOut?.modified),
          };
        }

        const scrubbedHeld = scrubCredentialsInText(held, { isFinal: true });
        if (scrubbedHeld.modified) {
          continuation = { kind: 'token', charPattern: /^[A-Za-z0-9._~+/=-]+/ };
          buffer = '';
          const detections: CredentialScrubDetection[] = [];
          if (prefixOut) mergeDetections(detections, prefixOut.detections);
          mergeDetections(detections, scrubbedHeld.detections);
          const emit = `${cont.passThrough}${prefixOut?.text ?? ''}${scrubbedHeld.text}`;
          return { text: emit, emit, detections, modified: true };
        }

        // Ordinary long unbroken non-secret payload: release head up to maxBufferChars / 2
        const forcedCut = backOffSurrogate(buffer, buffer.length - Math.floor(maxBufferChars / 2));
        const forcedOut = scrubCredentialsInText(buffer.slice(0, forcedCut), { isFinal: false });
        buffer = buffer.slice(forcedCut);
        const emit = `${cont.passThrough}${forcedOut.text}`;
        return { text: emit, emit, detections: forcedOut.detections, modified: forcedOut.modified };
      }

      if (cut <= 0) {
        return { text: cont.passThrough, emit: cont.passThrough, detections: [], modified: false };
      }

      const slice = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      const scrubbed = scrubCredentialsInText(slice, { isFinal: false });
      const emit = `${cont.passThrough}${scrubbed.text}`;
      return { text: emit, emit, detections: scrubbed.detections, modified: scrubbed.modified };
    },

    flush() {
      continuation = null;
      if (!buffer) {
        return { text: '', emit: '', detections: [], modified: false };
      }
      const remaining = buffer;
      buffer = '';
      const scrubbed = scrubCredentialsInText(remaining, { isFinal: true });
      return { ...scrubbed, emit: scrubbed.text };
    },

    reset() {
      buffer = '';
      continuation = null;
    },

    getBufferedLength() {
      return buffer.length;
    },
  };
}

function mergeGuardActions(first?: GuardAction, second?: GuardAction): GuardAction {
  if (first === 'blocked' || second === 'blocked') return 'blocked';
  if (first === 'masked' || second === 'masked') return 'masked';
  if (first === 'logged' || second === 'logged') return 'logged';
  return 'pass';
}

/**
 * Wraps an optional inner `OutputFilter` (such as `createStreamGuard`) with real-time
 * chunk-boundary credential scrubbing so neither the wire response nor any guard event
 * excerpt ever receives raw credentials.
 */
export function wrapOutputFilterWithCredentialScrubber(options: {
  stream: boolean;
  inner: OutputFilter | null;
  windowChars?: number;
  maxBufferChars?: number;
  onScrubbedEvent?: (scrubbedExcerptSource: string) => void;
}): OutputFilter {
  const { inner, stream } = options;
  const scrubber = createCredentialStreamScrubber({
    windowChars: options.windowChars,
    maxBufferChars: options.maxBufferChars,
  });
  const buffering = !stream || Boolean(inner?.buffering);

  let scrubTriggered = false;
  let eventRecorded = false;
  let scrubbedPreview = '';

  const noteScrub = (scrubbedText: string) => {
    scrubTriggered = true;
    if (scrubbedPreview.length < 600) {
      scrubbedPreview = (scrubbedPreview + scrubbedText).slice(0, 600);
    }
  };

  const maybeEmitScrubEvent = () => {
    if (scrubTriggered && !eventRecorded) {
      eventRecorded = true;
      options.onScrubbedEvent?.(scrubbedPreview);
    }
  };

  return {
    name: 'output-guard',
    isOutputGuard: true,
    buffering,
    failClosed: Boolean(inner?.failClosed),
    attach(sink: OutputFilterSink) {
      inner?.attach?.(sink);
    },
    dispose() {
      scrubber.reset();
      inner?.dispose?.();
    },
    onDelta(text: string) {
      if (buffering) {
        // In full-buffering or non-stream mode, accumulate and scrub atomically in onComplete
        // while keeping inner buffer updated with already-scrubbed text if inner exists.
        if (!stream) {
          const full = scrubCredentialsInText(text, { isFinal: true });
          if (full.modified) noteScrub(full.text);
          if (!inner?.onDelta) {
            maybeEmitScrubEvent();
            return {
              emit: full.text,
              action: full.modified ? 'masked' : 'pass',
              ...(full.modified ? { reason: 'pii' } : {}),
            };
          }
          const innerRes = inner.onDelta(full.text);
          const action = mergeGuardActions(full.modified ? 'masked' : 'pass', innerRes.action);
          if (action === 'masked' && innerRes.action !== 'masked') {
            maybeEmitScrubEvent();
          }
          return {
            ...innerRes,
            action,
            reason: innerRes.reason ?? (full.modified ? 'pii' : undefined),
          };
        }
        return { emit: text, action: 'pass' };
      }

      const step = scrubber.push(text);
      if (step.modified) {
        noteScrub(step.emit);
      }

      if (!inner?.onDelta) {
        if (step.modified) maybeEmitScrubEvent();
        return {
          emit: step.emit,
          action: step.modified ? 'masked' : 'pass',
          ...(step.modified ? { reason: 'pii' } : {}),
        };
      }

      if (step.emit.length === 0) {
        if (step.modified) maybeEmitScrubEvent();
        return {
          emit: '',
          action: step.modified ? 'masked' : 'pass',
          ...(step.modified ? { reason: 'pii' } : {}),
        };
      }

      const innerRes = inner.onDelta(step.emit);
      const action = mergeGuardActions(step.modified ? 'masked' : 'pass', innerRes.action);
      if (step.modified && innerRes.action !== 'blocked' && innerRes.action !== 'masked') {
        maybeEmitScrubEvent();
      }
      return {
        ...innerRes,
        action,
        reason: innerRes.reason ?? (step.modified ? 'pii' : undefined),
      };
    },

    onBeforeTerminal() {
      if (buffering) return { emit: '' };
      const tail = scrubber.flush();
      if (tail.modified) {
        noteScrub(tail.emit);
      }

      if (!inner) {
        if (tail.modified) maybeEmitScrubEvent();
        return {
          emit: tail.emit,
          action: tail.modified ? 'masked' : 'pass',
          ...(tail.modified ? { reason: 'pii' } : {}),
        };
      }

      let combinedEmit = '';
      let combinedAction: GuardAction = tail.modified ? 'masked' : 'pass';
      let combinedReason: string | undefined = tail.modified ? 'pii' : undefined;

      if (tail.emit.length > 0 && inner.onDelta) {
        const deltaRes = inner.onDelta(tail.emit);
        combinedAction = mergeGuardActions(combinedAction, deltaRes.action);
        combinedReason = deltaRes.reason ?? combinedReason;
        if (deltaRes.stop) {
          return deltaRes;
        }
        combinedEmit += deltaRes.emit;
      }

      if (inner.onBeforeTerminal) {
        const termRes = inner.onBeforeTerminal();
        combinedAction = mergeGuardActions(combinedAction, termRes.action);
        combinedReason = termRes.reason ?? combinedReason;
        if (termRes.stop) {
          return termRes;
        }
        combinedEmit += termRes.emit;
      }

      if (tail.modified && combinedAction !== 'blocked') {
        maybeEmitScrubEvent();
      }

      return {
        emit: combinedEmit,
        action: combinedAction,
        ...(combinedReason ? { reason: combinedReason } : {}),
      };
    },

    async onComplete(full: string) {
      const scrubbed = scrubCredentialsInText(full, { isFinal: true });
      if (scrubbed.modified) {
        noteScrub(scrubbed.text);
      }

      if (!inner?.onComplete) {
        if (scrubbed.modified) {
          maybeEmitScrubEvent();
          return {
            replaceWith: scrubbed.text,
            action: 'masked',
            reason: 'pii',
          };
        }
        return { action: 'pass' };
      }

      const innerRes = await inner.onComplete(scrubbed.text);
      const action = mergeGuardActions(scrubbed.modified ? 'masked' : 'pass', innerRes.action);
      if (action === 'blocked') {
        return innerRes;
      }
      if (innerRes.replaceWith !== undefined) {
        return {
          replaceWith: innerRes.replaceWith,
          action,
          reason: innerRes.reason ?? (scrubbed.modified ? 'pii' : undefined),
        };
      }
      if (scrubbed.modified) {
        maybeEmitScrubEvent();
        return {
          replaceWith: scrubbed.text,
          action: 'masked',
          reason: innerRes.reason ?? 'pii',
        };
      }
      return innerRes;
    },
  };
}

// ── Settings Persistence (custom_ai_credential_scrub_settings) ────────────────

interface CredentialScrubSettingsRow {
  scope_kind: ScopeKind;
  scope_id: string;
  enabled: number;
  updated_by: number | null;
  updated_at: string | null;
}

function hasScrubTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'custom_ai_credential_scrub_settings'",
        )
        .get(),
    );
  } catch {
    return false;
  }
}

function rowToSettings(scope: Scope, row?: CredentialScrubSettingsRow): CredentialScrubSettings {
  return {
    scopeKind: scope.kind,
    scopeId: scope.id,
    credentialStreamScrubEnabled: Boolean(row?.enabled),
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function getCredentialScrubSettings(scope: Scope): CredentialScrubSettings {
  const norm = assertScopeExists(scope);
  if (!hasScrubTable()) return rowToSettings(norm);
  const row = getDb()
    .prepare(
      'SELECT * FROM custom_ai_credential_scrub_settings WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as CredentialScrubSettingsRow | undefined;
  return rowToSettings(norm, row);
}

export function getRuntimeCredentialScrubEnabled(scope: Scope): boolean {
  try {
    const norm = normalizeScope(scope);
    if (!hasScrubTable()) return false;
    const row = getDb()
      .prepare(
        'SELECT enabled FROM custom_ai_credential_scrub_settings WHERE scope_kind = ? AND scope_id = ?',
      )
      .get(norm.kind, norm.id) as { enabled?: number } | undefined;
    return row?.enabled === 1;
  } catch {
    return false;
  }
}

export function setCredentialScrubSettings(
  scope: Scope,
  input: CredentialScrubSettingsInput,
  actorId: number | null,
): CredentialScrubSettings {
  const norm = assertScopeExists(scope);
  const enabledInt = input.credentialStreamScrubEnabled ? 1 : 0;
  const nowIso = new Date().toISOString();
  const db = getDb();

  db.prepare(
    `INSERT INTO custom_ai_credential_scrub_settings (
       scope_kind, scope_id, enabled, updated_by, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
       enabled = excluded.enabled,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(norm.kind, norm.id, enabledInt, actorId, nowIso);

  const saved = db
    .prepare(
      'SELECT * FROM custom_ai_credential_scrub_settings WHERE scope_kind = ? AND scope_id = ?',
    )
    .get(norm.kind, norm.id) as CredentialScrubSettingsRow | undefined;
  return rowToSettings(norm, saved);
}
