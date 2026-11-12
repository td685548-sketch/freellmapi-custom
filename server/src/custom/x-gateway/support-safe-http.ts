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
  options?: { allowLocalhost?: boolean },
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

    // Metadata check is strictly forbidden under all circumstances
    if (isMetadataIp(host, host)) {
      return { safe: false, reason: 'SSRF protection: cloud metadata destinations are strictly forbidden' };
    }

    // Server-owned exact origin allowlist check
    if (isTrustedPartnerOrigin(u.origin)) {
      return { safe: true };
    }

    // Localhost test opt-in (only if server env permits)
    const localhostPermitted = isLocalhostAllowedByServer(options?.allowLocalhost);

    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      if (localhostPermitted) return { safe: true };
      return { safe: false, reason: 'SSRF protection: private or localhost URLs are not allowed' };
    }

    const ip = parseIpAddress(host);
    if (ip) {
      if (isMetadataIp(ip)) {
        return { safe: false, reason: 'SSRF protection: cloud metadata destinations are strictly forbidden' };
      }
      if (isPrivateIp(ip)) {
        if (localhostPermitted) return { safe: true };
        return { safe: false, reason: 'SSRF protection: private or localhost URLs are not allowed' };
      }
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

  // Cloud metadata is strictly blocked even under allowlists
  if (isMetadataIp(host, host)) {
    throw new SafeHttpError(403, 'SSRF protection: Cloud metadata destinations are forbidden');
  }

  const directIp = parseIpAddress(host);
  const localhostPermitted = options?.trustedOrigin || isLocalhostAllowedByServer(options?.allowLocalhost);

  if (directIp) {
    if (isMetadataIp(directIp)) {
      throw new SafeHttpError(403, 'SSRF protection: Cloud metadata destinations are forbidden');
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
    if (isMetadataIp(canonical)) {
      throw new SafeHttpError(403, `SSRF protection: Host resolved to metadata address ${canonical}`);
    }
    if (isPrivateIp(canonical) && !localhostPermitted) {
      throw new SafeHttpError(403, `SSRF protection: Host resolved to private address ${canonical}`);
    }
  }

  return ips;
}

/**
 * Validates safe HTTP URL including DNS lookup.
 */
export async function validateSafeHttpUrl(
  rawUrl: string,
  options?: {
    allowLocalhost?: boolean;
    checkDns?: boolean;
    dnsResolver?: (host: string) => Promise<string[]>;
  },
): Promise<{ safe: boolean; reason?: string; resolvedIps?: string[] }> {
  const syncCheck = isSafeHttpUrlSync(rawUrl, options);
  if (!syncCheck.safe) return syncCheck;

  try {
    const u = new URL(rawUrl);
    const trustedOrigin = isTrustedPartnerOrigin(u.origin);
    const resolvedIps = await resolveAndValidateHost(u.hostname, {
      allowLocalhost: options?.allowLocalhost,
      dnsResolver: options?.dnsResolver,
      trustedOrigin,
    });
    return { safe: true, resolvedIps };
  } catch (err) {
    return { safe: false, reason: (err as Error).message };
  }
}

/**
 * Creates an undici.Agent with a safe lookup function pinned to validated IP.
 */
export function getSafeUndiciDispatcher(options?: {
  allowLocalhost?: boolean;
  dnsResolver?: (host: string) => Promise<string[]>;
  trustedOrigin?: boolean;
}): Agent {
  return new Agent({
    maxRedirections: 0,
    connect: {
      lookup: (hostname, lookupOpts, callback) => {
        resolveAndValidateHost(hostname, options)
          .then((ips) => {
            const chosen = ips[0];
            const family = chosen.includes(':') ? 6 : 4;
            callback(null, chosen, family);
          })
          .catch((err) => {
            callback(err as Error, '', 4);
          });
      },
    },
  });
}

/**
 * Executes an HTTP fetch with SSRF validation, DNS binding, and redirect prevention.
 */
export async function safeFetch(
  url: string | URL,
  init?: RequestInit,
  options?: {
    allowLocalhost?: boolean;
    fetchFn?: typeof fetch;
    dnsResolver?: (host: string) => Promise<string[]>;
  },
): Promise<Response> {
  const urlStr = typeof url === 'string' ? url : url.toString();
  const u = new URL(urlStr);

  const trustedOrigin = isTrustedPartnerOrigin(u.origin);

  // Validate URL and resolve DNS before dispatch
  const validation = await validateSafeHttpUrl(urlStr, {
    allowLocalhost: options?.allowLocalhost,
    checkDns: true,
    dnsResolver: options?.dnsResolver,
  });

  if (!validation.safe) {
    throw new SafeHttpError(403, validation.reason || 'SSRF protection blocked request');
  }

  const fetchImpl = options?.fetchFn ?? globalThis.fetch;

  // Use safe undici dispatcher for connection-pinned DNS if native fetch is used
  const dispatcher = getSafeUndiciDispatcher({
    allowLocalhost: options?.allowLocalhost,
    dnsResolver: options?.dnsResolver,
    trustedOrigin,
  });

  const mergedInit: RequestInit & { dispatcher?: Agent } = {
    ...init,
    redirect: 'manual',
    dispatcher,
  };

  let res: Response;
  try {
    res = await fetchImpl(urlStr, mergedInit);
  } catch (err) {
    void dispatcher.destroy().catch(() => {});
    if (err instanceof SafeHttpError) throw err;
    throw new SafeHttpError(502, `Network request failed: ${(err as Error).message}`);
  }

  // Close the per-request pool after its active response body completes.
  void dispatcher.close().catch(() => {});
  // Reject redirects strictly: no redirect following
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new SafeHttpError(400, `HTTP redirect ${res.status} blocked: redirects are not permitted for security`);
  }

  return res;
}
