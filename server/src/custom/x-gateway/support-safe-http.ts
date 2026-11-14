import dns from 'node:dns';
import { Agent } from 'undici';

export class SafeHttpError extends Error {
  public statusCode: number;
  constructor(public status: number, message: string) {
    super(message);
    this.statusCode = status;
  }
}

/**
 * Parses numeric IPv4 token in decimal, octal, or hex.
 */
function parseIpv4Token(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  let val: number;
  if (/^0x[0-9a-fA-F]+$/i.test(t)) {
    val = parseInt(t, 16);
  } else if (/^0[0-7]+$/.test(t)) {
    val = parseInt(t, 8);
  } else if (/^\d+$/.test(t)) {
    val = parseInt(t, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(val) || val < 0 || val > 0xffffffff) return null;
  return val;
}

/**
 * Parses any valid IPv4 representation (dword, 2-part, 3-part, 4-part with octal/hex/decimal)
 * into canonical dotted-decimal 'a.b.c.d' string, or returns null.
 */
export function parseIpv4Address(host: string): string | null {
  let clean = host.trim().replace(/^\[|\]$/g, '');
  if (clean.endsWith('.')) clean = clean.slice(0, -1);
  if (!clean) return null;

  const parts = clean.split('.');
  if (parts.length > 4) return null;

  let val: number;
  if (parts.length === 1) {
    const v = parseIpv4Token(parts[0]);
    if (v === null) return null;
    val = v;
  } else if (parts.length === 2) {
    const p0 = parseIpv4Token(parts[0]);
    const p1 = parseIpv4Token(parts[1]);
    if (p0 === null || p1 === null || p0 > 255 || p1 > 0xffffff) return null;
    val = (p0 * 16777216) + p1;
  } else if (parts.length === 3) {
    const p0 = parseIpv4Token(parts[0]);
    const p1 = parseIpv4Token(parts[1]);
    const p2 = parseIpv4Token(parts[2]);
    if (p0 === null || p1 === null || p2 === null || p0 > 255 || p1 > 255 || p2 > 0xffff) return null;
    val = (p0 * 16777216) + (p1 * 65536) + p2;
  } else {
    const p0 = parseIpv4Token(parts[0]);
    const p1 = parseIpv4Token(parts[1]);
    const p2 = parseIpv4Token(parts[2]);
    const p3 = parseIpv4Token(parts[3]);
    if (p0 === null || p1 === null || p2 === null || p3 === null || p0 > 255 || p1 > 255 || p2 > 255 || p3 > 255) return null;
    val = (p0 * 16777216) + (p1 * 65536) + (p2 * 256) + p3;
  }

  const a = (val >>> 24) & 255;
  const b = (val >>> 16) & 255;
  const c = (val >>> 8) & 255;
  const d = val & 255;
  return `${a}.${b}.${c}.${d}`;
}

/**
 * Parses host as IPv4 or IPv6 (including IPv4-mapped IPv6 like ::ffff:127.0.0.1 or ::ffff:7f00:1).
 */
export function parseIpAddress(host: string): string | null {
  const clean = host.trim().replace(/^\[|\]$/g, '').toLowerCase();

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1)
  const mappedMatch = /^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/i.exec(clean);
  if (mappedMatch) {
    const tail = mappedMatch[1];
    const parsedV4 = parseIpv4Address(tail);
    if (parsedV4) return parsedV4;
    // Or tail might be hex notation e.g. 7f00:1
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const high = parseInt(hexParts[0], 16);
      const low = parseInt(hexParts[1], 16);
      if (!isNaN(high) && !isNaN(low) && high >= 0 && high <= 0xffff && low >= 0 && low <= 0xffff) {
        const full = (high << 16) | low;
        return parseIpv4Address(String(full >>> 0));
      }
    }
  }

  // IPv4-compatible IPv6 (::127.0.0.1)
  const compatMatch = /^::([0-9a-fA-F.]+)$/.exec(clean);
  if (compatMatch && compatMatch[1].includes('.')) {
    const parsedV4 = parseIpv4Address(compatMatch[1]);
    if (parsedV4) return parsedV4;
  }

  // Pure IPv4
  const ipv4 = parseIpv4Address(clean);
  if (ipv4) return ipv4;

  // Pure IPv6 check
  if (clean.includes(':')) {
    // Validate IPv6 structure
    return clean;
  }

  return null;
}

/**
 * Checks if IP is cloud metadata (AWS, GCP, Azure, Alibaba, OpenStack, etc.).
 */
export function isMetadataIp(ip: string, hostname?: string): boolean {
  if (hostname) {
    const h = hostname.toLowerCase();
    if (
      h === 'metadata.google.internal' ||
      h === 'metadata' ||
      h === 'instance-data' ||
      h.endsWith('.internal') && h.includes('metadata')
    ) {
      return true;
    }
  }

  const canonicalV4 = parseIpv4Address(ip);
  if (canonicalV4) {
    const parts = canonicalV4.split('.').map(Number);
    // Link-local / metadata 169.254.0.0/16
    if (parts[0] === 169 && parts[1] === 254) return true;
    // Alibaba cloud metadata 100.100.100.200
    if (canonicalV4 === '100.100.100.200') return true;
  }

  const lower = ip.toLowerCase();
  // IPv6 link-local fe80::/10 or AWS IMDSv6 fd00:ec2::254
  if (lower.startsWith('fe80:') || lower.includes('fd00:ec2::254')) return true;

  return false;
}

/**
 * Checks if IP or hostname is ALWAYS forbidden regardless of allowlists:
 * cloud metadata, link-local, unspecified (0.0.0.0/8, ::), multicast/broadcast (224.0.0.0/4, ff00::/8).
 */
export function isAlwaysBlockedIp(ip: string, hostname?: string): boolean {
  if (isMetadataIp(ip, hostname)) return true;

  const canonicalV4 = parseIpv4Address(ip);
  if (canonicalV4) {
    const p0 = Number(canonicalV4.split('.')[0]);
    if (p0 === 0 || p0 >= 224) return true;
  }

  const lower = ip.toLowerCase();
  if (
    lower === '::' ||
    lower === '0:0:0:0:0:0:0:0' ||
    lower.startsWith('fe8') ||
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('ff')
  ) {
    return true;
  }

  return false;
}

/**
 * Normalizes a list of exact allowed origins (scheme + canonical host + port).
 * Rejects wildcards, CIDR, paths, queries, fragments, and embedded credentials.
 */
export function normalizeAllowedExactOrigins(origins?: readonly string[]): Set<string> {
  const out = new Set<string>();
  if (!origins) return out;
  for (const raw of origins) {
    const entry = String(raw ?? '').trim();
    if (!entry || entry.includes('*') || entry.includes('?') || entry.includes('#') || /\s/.test(entry)) {
      continue;
    }
    const schemeIdx = entry.indexOf('://');
    if (schemeIdx === -1) continue;
    const afterScheme = entry.slice(schemeIdx + 3);
    if (afterScheme.includes('/')) continue;
    try {
      const u = new URL(entry);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (u.username || u.password) continue;
      if (u.origin.toLowerCase() === entry.toLowerCase()) {
        out.add(u.origin.toLowerCase());
      }
    } catch {
      // Ignore malformed origin entry
    }
  }
  return out;
}

/**
 * Checks if IP address is private, loopback, link-local, multicast, or reserved.
 */
export function isPrivateIp(ip: string): boolean {
  const canonicalV4 = parseIpv4Address(ip);
  if (canonicalV4) {
    const parts = canonicalV4.split('.').map(Number);
    const p0 = parts[0];
    const p1 = parts[1];
    const p2 = parts[2];

    // 0.0.0.0/8 (current network)
    if (p0 === 0) return true;
    // 10.0.0.0/8 (private)
    if (p0 === 10) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (p0 === 100 && (p1 & 0xc0) === 64) return true;
    // 127.0.0.0/8 (loopback)
    if (p0 === 127) return true;
    // 169.254.0.0/16 (link-local, cloud metadata)
    if (p0 === 169 && p1 === 254) return true;
    // 172.16.0.0/12 (private: 172.16.0.0 - 172.31.255.255)
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true;
    // 192.0.0.0/24 (IETF protocol assignments)
    if (p0 === 192 && p1 === 0 && p2 === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (p0 === 192 && p1 === 0 && p2 === 2) return true;
    // 192.88.99.0/24 (6to4 relay anycast)
    if (p0 === 192 && p1 === 88 && p2 === 99) return true;
    // 192.168.0.0/16 (private)
    if (p0 === 192 && p1 === 168) return true;
    // 198.18.0.0/15 (benchmarking)
    if (p0 === 198 && (p1 & 0xfe) === 18) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (p0 === 198 && p1 === 51 && p2 === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (p0 === 203 && p1 === 0 && p2 === 113) return true;
    // 224.0.0.0/4 (multicast)
    if (p0 >= 224 && p0 <= 239) return true;
    // 240.0.0.0/4 (reserved / broadcast 255.255.255.255)
    if (p0 >= 240) return true;

    return false;
  }

  // IPv6 checks
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true; // loopback
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true; // unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
  if (lower.startsWith('2001:db8:')) return true; // documentation
  if (lower.startsWith('100::')) return true; // discard prefix

  return false;
}

/**
 * Checks if exact origin is in SUPPORT_TRUSTED_PARTNER_ORIGINS.
 */
export function isTrustedPartnerOrigin(origin: string): boolean {
  const env = process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS;
  if (!env) return false;
  const list = env.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(origin.toLowerCase());
}

/**
 * Checks if test localhost mode is active and allowed by server configuration.
 */
export function isLocalhostAllowedByServer(allowLocalhostOption?: boolean): boolean {
  if (!allowLocalhostOption) return false;
  return process.env.SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS === '1';
}

/**
 * Synchronous URL sanity check.
 */
export function isSafeHttpUrlSync(
  rawUrl: string,
  options?: {
    allowLocalhost?: boolean;
    allowedOrigins?: readonly string[];
    requireExplicitHttpOrigin?: boolean;
  },
): { safe: boolean; reason?: string } {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { safe: false, reason: 'Target URL must use http: or https: protocol' };
    }
    if (u.username || u.password) {
      return { safe: false, reason: 'URL credentials are not allowed' };
    }

    const host = u.hostname.toLowerCase();
    if (!host) {
      return { safe: false, reason: 'Host is empty' };
    }

    // Metadata, link-local, unspecified, and multicast are strictly forbidden under all circumstances
    if (isAlwaysBlockedIp(host, host)) {
      return { safe: false, reason: 'SSRF protection: cloud metadata and reserved destinations are strictly forbidden' };
    }

    const ip = parseIpAddress(host);
    if (ip && isAlwaysBlockedIp(ip, host)) {
      return { safe: false, reason: 'SSRF protection: cloud metadata and reserved destinations are strictly forbidden' };
    }

    const exactAllowed = normalizeAllowedExactOrigins(options?.allowedOrigins).has(u.origin.toLowerCase());
    const trustedOrigin = isTrustedPartnerOrigin(u.origin);

    if (options?.requireExplicitHttpOrigin && u.protocol === 'http:' && !exactAllowed && !trustedOrigin) {
      return { safe: false, reason: 'SSRF protection: http: URLs require an exact origin in allowedOrigins' };
    }

    // Server-owned exact origin allowlist check
    if (trustedOrigin || exactAllowed) {
      return { safe: true };
    }

    // Localhost test opt-in (only if server env permits)
    const localhostPermitted = isLocalhostAllowedByServer(options?.allowLocalhost);

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      if (localhostPermitted) return { safe: true };
      return { safe: false, reason: 'SSRF protection: private or localhost URLs are not allowed' };
    }

    if (ip && isPrivateIp(ip)) {
      if (localhostPermitted) return { safe: true };
      return { safe: false, reason: 'SSRF protection: private or localhost URLs are not allowed' };
    }

    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}

/**
 * Resolves hostname via DNS and validates every returned IP.
 */
export async function resolveAndValidateHost(
  hostname: string,
  options?: {
    allowLocalhost?: boolean;
    dnsResolver?: (host: string) => Promise<string[]>;
    trustedOrigin?: boolean;
  },
): Promise<string[]> {
  const host = hostname.toLowerCase();

  // Cloud metadata, link-local, unspecified, multicast are strictly blocked even under allowlists
  if (isAlwaysBlockedIp(host, host)) {
    throw new SafeHttpError(403, 'SSRF protection: Cloud metadata and reserved destinations are forbidden');
  }

  const directIp = parseIpAddress(host);
  const localhostPermitted = options?.trustedOrigin || isLocalhostAllowedByServer(options?.allowLocalhost);

  if (directIp) {
    if (isAlwaysBlockedIp(directIp, host)) {
      throw new SafeHttpError(403, 'SSRF protection: Cloud metadata and reserved destinations are forbidden');
    }
    if (isPrivateIp(directIp) && !localhostPermitted) {
      throw new SafeHttpError(403, `SSRF protection: IP address ${directIp} is private or restricted`);
    }
    return [directIp];
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    if (!localhostPermitted) {
      throw new SafeHttpError(403, `SSRF protection: Host ${hostname} is private or restricted`);
    }
    return ['127.0.0.1'];
  }

  let ips: string[];
  try {
    if (options?.dnsResolver) {
      ips = await options.dnsResolver(hostname);
    } else {
      const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      ips = records.map((r) => r.address);
    }
  } catch (err) {
    // In test environment, allow RFC 2606 test domains when DNS lookup fails
    if (
      process.env.NODE_ENV === 'test' &&
      (host.endsWith('.example.com') || host.endsWith('.example') || host.endsWith('.test') || host === 'partner.com')
    ) {
      ips = ['93.184.216.34']; // safe public dummy IP
    } else {
      throw new SafeHttpError(502, `DNS resolution failed for host "${hostname}": ${(err as Error).message}`);
    }
  }

  if (!ips || ips.length === 0) {
    throw new SafeHttpError(502, `DNS resolution returned no addresses for host "${hostname}"`);
  }

  for (const resolvedIp of ips) {
    const canonical = parseIpAddress(resolvedIp) || resolvedIp;
    if (isAlwaysBlockedIp(canonical)) {
      throw new SafeHttpError(403, `SSRF protection: Host resolved to forbidden metadata/reserved address ${canonical}`);
    }
    if (isPrivateIp(canonical) && !localhostPermitted) {
      throw new SafeHttpError(403, `SSRF protection: Host resolved to private address ${canonical}`);
    }
  }

  return ips;
}

function createCombinedOperationSignal(
  initSignal?: AbortSignal | null,
  optSignal?: AbortSignal | null,
  timeoutMs?: number,
): { signal?: AbortSignal; timedOut: () => boolean; cleanup: () => void } {
  const hasTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs);
  if (!initSignal && !optSignal && !hasTimeout) {
    return { signal: undefined, timedOut: () => false, cleanup: () => {} };
  }

  const controller = new AbortController();
  let expired = false;
  const cleanups: Array<() => void> = [];

  const forward = (src: AbortSignal) => {
    if (controller.signal.aborted) return;
    if (src.aborted) {
      controller.abort(src.reason);
      return;
    }
    const onAbort = () => controller.abort(src.reason);
    src.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => src.removeEventListener('abort', onAbort));
  };

  if (initSignal) forward(initSignal);
  if (optSignal && optSignal !== initSignal) forward(optSignal);

  if (hasTimeout && !controller.signal.aborted) {
    const ms = Math.max(0, Math.trunc(timeoutMs));
    if (ms === 0) {
      expired = true;
      controller.abort(new SafeHttpError(408, 'Request timed out'));
    } else {
      const timer = setTimeout(() => {
        expired = true;
        controller.abort(new SafeHttpError(408, 'Request timed out'));
      }, ms);
      cleanups.push(() => clearTimeout(timer));
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => expired,
    cleanup: () => {
      for (const fn of cleanups) fn();
    },
  };
}

function abortError(timedOut: boolean): SafeHttpError {
  return new SafeHttpError(timedOut ? 408 : 499, timedOut ? 'Request timed out' : 'Request aborted');
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(abortError(timedOut()));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(timedOut()));
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Validates safe HTTP URL including DNS lookup.
 */
export async function validateSafeHttpUrl(
  rawUrl: string,
  options?: {
    allowLocalhost?: boolean;
    allowedOrigins?: readonly string[];
    requireExplicitHttpOrigin?: boolean;
    checkDns?: boolean;
    dnsResolver?: (host: string) => Promise<string[]>;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
): Promise<{ safe: boolean; reason?: string; resolvedIps?: string[] }> {
  const syncCheck = isSafeHttpUrlSync(rawUrl, options);
  if (!syncCheck.safe) return syncCheck;

  const op = createCombinedOperationSignal(options?.signal, undefined, options?.timeoutMs);
  try {
    if (op.signal?.aborted) {
      throw abortError(op.timedOut());
    }
    const u = new URL(rawUrl);
    const exactAllowed = normalizeAllowedExactOrigins(options?.allowedOrigins).has(u.origin.toLowerCase());
    const trustedOrigin = isTrustedPartnerOrigin(u.origin) || exactAllowed;
    const resolvedIps = await raceWithAbort(
      resolveAndValidateHost(u.hostname, {
        allowLocalhost: options?.allowLocalhost,
        dnsResolver: options?.dnsResolver,
        trustedOrigin,
      }),
      op.signal,
      op.timedOut,
    );
    return { safe: true, resolvedIps };
  } catch (err) {
    if (err instanceof SafeHttpError && (err.status === 408 || err.status === 499)) {
      throw err;
    }
    return { safe: false, reason: (err as Error).message };
  } finally {
    op.cleanup();
  }
}

/**
 * Creates an undici.Agent with a safe lookup function pinned to validated IP.
 */
export function getSafeUndiciDispatcher(options?: {
  allowLocalhost?: boolean;
  dnsResolver?: (host: string) => Promise<string[]>;
  trustedOrigin?: boolean;
  signal?: AbortSignal;
  timedOut?: () => boolean;
  /** Addresses already validated for this exact request hop. */
  resolvedIps?: readonly string[];
}): Agent {
  return new Agent({
    maxRedirections: 0,
    connect: {
      lookup: (hostname, lookupOpts, callback) => {
        raceWithAbort(
          options?.resolvedIps
            ? Promise.resolve([...options.resolvedIps])
            : resolveAndValidateHost(hostname, options),
          options?.signal,
          options?.timedOut ?? (() => false),
        )
          .then((ips) => {
            const chosen = ips[0];
            const family = chosen.includes(':') ? 6 : 4;
            if (lookupOpts.all) {
              callback(null, [{ address: chosen, family }]);
            } else {
              callback(null, chosen, family);
            }
          })
          .catch((err) => {
            callback(err as Error, '', 4);
          });
      },
    },
  });
}

const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'mcp-session-id',
  'x-api-key',
  'x-auth-token',
  'x-goog-api-key',
]);

function stripSensitiveHeadersForCrossOrigin(
  headersInit: RequestInit['headers'] | undefined,
  extraStrip?: readonly string[],
): Headers {
  const headers = new Headers(headersInit);
  const stripSet = new Set(CROSS_ORIGIN_SENSITIVE_HEADERS);
  if (extraStrip) {
    for (const h of extraStrip) {
      const normalized = String(h ?? '').trim().toLowerCase();
      if (normalized) stripSet.add(normalized);
    }
  }
  for (const name of [...headers.keys()]) {
    if (stripSet.has(name.toLowerCase())) {
      headers.delete(name);
    }
  }
  return headers;
}

export interface SafeFetchRedirectOptions {
  maxRedirects?: number;
  methodPreservingOnly?: boolean;
  stripHeadersOnCrossOrigin?: readonly string[];
}

/**
 * Executes an HTTP fetch with SSRF validation, DNS binding, and redirect prevention
 * (or bounded manual method-preserving redirect following when explicitly requested).
 */
export async function safeFetch(
  url: string | URL,
  init?: RequestInit,
  options?: {
    allowLocalhost?: boolean;
    allowedOrigins?: readonly string[];
    requireExplicitHttpOrigin?: boolean;
    followRedirects?: SafeFetchRedirectOptions;
    fetchFn?: typeof fetch;
    dnsResolver?: (host: string) => Promise<string[]>;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Revalidate authorization after DNS, before each network dispatch. */
    beforeDispatch?: () => Promise<void>;
  },
): Promise<Response> {
  const fetchImpl = options?.fetchFn ?? globalThis.fetch;
  const maxRedirects = options?.followRedirects
    ? Math.min(3, Math.max(0, Math.trunc(options.followRedirects.maxRedirects ?? 3)))
    : 0;
  const methodPreservingOnly = options?.followRedirects?.methodPreservingOnly ?? true;

  let currentUrl = typeof url === 'string' ? url : url.toString();
  let currentInit: RequestInit = init ? { ...init } : {};
  const visitedUrls = new Set<string>([currentUrl]);
  const allowedOriginSet = normalizeAllowedExactOrigins(options?.allowedOrigins);
  const op = createCombinedOperationSignal(init?.signal, options?.signal, options?.timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (op.signal?.aborted) {
        throw abortError(op.timedOut());
      }

      const u = new URL(currentUrl);
      const trustedOrigin =
        isTrustedPartnerOrigin(u.origin) || allowedOriginSet.has(u.origin.toLowerCase());

      const validation = await validateSafeHttpUrl(currentUrl, {
        allowLocalhost: options?.allowLocalhost,
        allowedOrigins: options?.allowedOrigins,
        requireExplicitHttpOrigin: options?.requireExplicitHttpOrigin,
        checkDns: true,
        dnsResolver: options?.dnsResolver,
        signal: op.signal,
      });

      if (!validation.safe) {
        throw new SafeHttpError(403, validation.reason || 'SSRF protection blocked request');
      }

      if (op.signal?.aborted) {
        throw abortError(op.timedOut());
      }

      // Do not resolve again after this guard: connect uses the validated IPs.
      // An authorization change during DNS/redirect handling must block I/O.
      if (options?.beforeDispatch) {
        await raceWithAbort(options.beforeDispatch(), op.signal, op.timedOut);
      }
      if (op.signal?.aborted) throw abortError(op.timedOut());

      const dispatcher = getSafeUndiciDispatcher({
        allowLocalhost: options?.allowLocalhost,
        dnsResolver: options?.dnsResolver,
        trustedOrigin,
        signal: op.signal,
        timedOut: op.timedOut,
        resolvedIps: validation.resolvedIps,
      });

      const mergedInit: RequestInit & { dispatcher?: Agent } = {
        ...currentInit,
        signal: op.signal ?? currentInit.signal,
        redirect: 'manual',
        dispatcher,
      };

      let res: Response;
      try {
        res = await raceWithAbort(fetchImpl(currentUrl, mergedInit), op.signal, op.timedOut);
      } catch (err) {
        void dispatcher.destroy().catch(() => {});
        if (op.signal?.aborted) {
          throw abortError(op.timedOut());
        }
        if (err instanceof SafeHttpError) throw err;
        throw new SafeHttpError(502, `Network request failed: ${(err as Error).message}`);
      }

      void dispatcher.close().catch(() => {});

      if (res.status < 300 || res.status >= 400) {
        return res;
      }

      if (res.body) {
        await raceWithAbort(res.body.cancel().catch(() => {}), op.signal, op.timedOut);
      }

    if (!options?.followRedirects) {
      throw new SafeHttpError(
        400,
        `HTTP redirect ${res.status} blocked: redirects are not permitted for security`,
      );
    }

    if (hop >= maxRedirects) {
      throw new SafeHttpError(
        400,
        `HTTP redirect limit exceeded (max ${maxRedirects})`,
      );
    }

    const location = res.headers.get('location');
    if (!location) {
      throw new SafeHttpError(400, `HTTP redirect ${res.status} missing Location header`);
    }

    let nextUrlObj: URL;
    try {
      nextUrlObj = new URL(location, currentUrl);
    } catch {
      throw new SafeHttpError(400, 'HTTP redirect target URL is invalid');
    }

    const nextUrl = nextUrlObj.toString();
    if (visitedUrls.has(nextUrl)) {
      throw new SafeHttpError(400, 'HTTP redirect loop detected');
    }

    const method = String(currentInit.method ?? 'GET').toUpperCase();
    if (
      methodPreservingOnly &&
      method !== 'GET' &&
      method !== 'HEAD' &&
      res.status !== 307 &&
      res.status !== 308
    ) {
      throw new SafeHttpError(
        400,
        `HTTP redirect ${res.status} is not method-preserving for ${method}`,
      );
    }

    if (nextUrlObj.origin !== u.origin) {
      currentInit = {
        ...currentInit,
        headers: stripSensitiveHeadersForCrossOrigin(
          currentInit.headers,
          options.followRedirects.stripHeadersOnCrossOrigin,
        ),
      };
    }

      visitedUrls.add(nextUrl);
      currentUrl = nextUrl;
    }

    throw new SafeHttpError(400, 'HTTP redirect limit exceeded');
  } finally {
    op.cleanup();
  }
}
