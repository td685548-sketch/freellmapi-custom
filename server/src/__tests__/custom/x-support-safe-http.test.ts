import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isSafeHttpUrlSync,
  validateSafeHttpUrl,
  safeFetch,
  parseIpAddress,
  parseIpv4Address,
  isPrivateIp,
  isMetadataIp,
  SafeHttpError,
} from '../../custom/x-gateway/support-safe-http.js';

describe('Safe HTTP SSRF & Transport Protection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS;
    delete process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('IPv4 parser and evasion handling', () => {
    it('parses standard dotted decimal', () => {
      expect(parseIpv4Address('127.0.0.1')).toBe('127.0.0.1');
      expect(parseIpv4Address('192.168.1.5')).toBe('192.168.1.5');
      expect(parseIpv4Address('169.254.169.254')).toBe('169.254.169.254');
    });

    it('parses octal IPv4 tokens', () => {
      expect(parseIpv4Address('0177.0.0.1')).toBe('127.0.0.1');
      expect(parseIpv4Address('017700000001')).toBe('127.0.0.1');
    });

    it('parses hex IPv4 tokens', () => {
      expect(parseIpv4Address('0x7f.0.0.1')).toBe('127.0.0.1');
      expect(parseIpv4Address('0x7f000001')).toBe('127.0.0.1');
      expect(parseIpv4Address('0xa9fea9fe')).toBe('169.254.169.254');
    });

    it('parses dword / decimal integer IPv4', () => {
      // 2130706433 = (127 << 24) | 1
      expect(parseIpv4Address('2130706433')).toBe('127.0.0.1');
      // 2852039166 = 169.254.169.254
      expect(parseIpv4Address('2852039166')).toBe('169.254.169.254');
    });

    it('parses class-based addresses with fewer dots', () => {
      expect(parseIpv4Address('127.1')).toBe('127.0.0.1');
      expect(parseIpv4Address('10.1')).toBe('10.0.0.1');
      expect(parseIpv4Address('192.168.1')).toBe('192.168.0.1');
    });

    it('handles IPv4-mapped IPv6 in parseIpAddress', () => {
      expect(parseIpAddress('::ffff:127.0.0.1')).toBe('127.0.0.1');
      expect(parseIpAddress('::ffff:7f00:1')).toBe('127.0.0.1');
      expect(parseIpAddress('0:0:0:0:0:ffff:10.0.0.1')).toBe('10.0.0.1');
    });
  });

  describe('isPrivateIp & isMetadataIp', () => {
    it('identifies private IPv4 ranges', () => {
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('10.254.1.1')).toBe(true);
      expect(isPrivateIp('172.16.0.1')).toBe(true);
      expect(isPrivateIp('172.31.255.255')).toBe(true);
      expect(isPrivateIp('192.168.1.1')).toBe(true);
      expect(isPrivateIp('169.254.169.254')).toBe(true);
      expect(isPrivateIp('0.0.0.0')).toBe(true);
      expect(isPrivateIp('100.64.0.1')).toBe(true);
      expect(isPrivateIp('224.0.0.1')).toBe(true);
      expect(isPrivateIp('240.0.0.1')).toBe(true);

      // Public IPs
      expect(isPrivateIp('8.8.8.8')).toBe(false);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('93.184.216.34')).toBe(false);
    });

    it('identifies private IPv6 ranges', () => {
      expect(isPrivateIp('::1')).toBe(true);
      expect(isPrivateIp('::')).toBe(true);
      expect(isPrivateIp('fc00::1')).toBe(true);
      expect(isPrivateIp('fd12:3456::1')).toBe(true);
      expect(isPrivateIp('fe80::1')).toBe(true);
    });

    it('identifies metadata IPs and hosts', () => {
      expect(isMetadataIp('169.254.169.254')).toBe(true);
      expect(isMetadataIp('100.100.100.200')).toBe(true);
      expect(isMetadataIp('8.8.8.8', 'metadata.google.internal')).toBe(true);
      expect(isMetadataIp('8.8.8.8', 'instance-data')).toBe(true);
      expect(isMetadataIp('fd00:ec2::254')).toBe(true);
      expect(isMetadataIp('fe80::1')).toBe(true);
    });
  });

  describe('URL syntax and credential checks', () => {
    it('rejects URLs with embedded credentials', () => {
      expect(isSafeHttpUrlSync('http://user:pass@example.com/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('https://admin@example.com/webhook').safe).toBe(false);
    });

    it('rejects non-http/https protocols', () => {
      expect(isSafeHttpUrlSync('ftp://example.com/file').safe).toBe(false);
      expect(isSafeHttpUrlSync('file:///etc/passwd').safe).toBe(false);
      expect(isSafeHttpUrlSync('gopher://example.com').safe).toBe(false);
      expect(isSafeHttpUrlSync('javascript:alert(1)').safe).toBe(false);
    });

    it('rejects IP evasions via sync check', () => {
      expect(isSafeHttpUrlSync('http://0177.0.0.1/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://0x7f000001/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://2130706433/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://127.1/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://[::1]/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://[::ffff:127.0.0.1]/webhook').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://169.254.169.254/latest/meta-data').safe).toBe(false);
      expect(isSafeHttpUrlSync('http://2852039166/latest/meta-data').safe).toBe(false);
    });
  });

  describe('DNS binding and SSRF DNS checks', () => {
    it('blocks domain resolving to private IP or loopback', async () => {
      const mockDns = vi.fn(async () => ['127.0.0.1']);
      const result = await validateSafeHttpUrl('https://my-internal.com/hook', {
        dnsResolver: mockDns,
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('SSRF');
      expect(mockDns).toHaveBeenCalledWith('my-internal.com');
    });

    it('blocks domain resolving to cloud metadata', async () => {
      const mockDns = vi.fn(async () => ['169.254.169.254']);
      const result = await validateSafeHttpUrl('https://imds-spoof.com/hook', {
        dnsResolver: mockDns,
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('metadata');
    });

    it('blocks if ANY resolved IP in multi-address response is private', async () => {
      const mockDns = vi.fn(async () => ['93.184.216.34', '10.0.0.1']);
      const result = await validateSafeHttpUrl('https://dual-homed.com/hook', {
        dnsResolver: mockDns,
      });
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('SSRF');
    });

    it('allows valid public domain resolving to public IP', async () => {
      const mockDns = vi.fn(async () => ['93.184.216.34']);
      const result = await validateSafeHttpUrl('https://api.partner.com/hook', {
        dnsResolver: mockDns,
      });
      expect(result.safe).toBe(true);
      expect(result.resolvedIps).toEqual(['93.184.216.34']);
    });
  });

  describe('Server-owned trusted origins allowlist', () => {
    it('allows exact origin in SUPPORT_TRUSTED_PARTNER_ORIGINS', async () => {
      process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS = 'http://192.168.1.50:8080,https://internal-api.corp:8443';

      expect(isSafeHttpUrlSync('http://192.168.1.50:8080/hook').safe).toBe(true);
      // Different port is not allowed
      expect(isSafeHttpUrlSync('http://192.168.1.50:9090/hook').safe).toBe(false);
      // Different IP is not allowed
      expect(isSafeHttpUrlSync('http://192.168.1.51:8080/hook').safe).toBe(false);
    });

    it('NEVER allows cloud metadata even if listed in trusted origins', async () => {
      process.env.SUPPORT_TRUSTED_PARTNER_ORIGINS = 'http://169.254.169.254';

      expect(isSafeHttpUrlSync('http://169.254.169.254/latest/meta-data').safe).toBe(false);

      const mockDns = vi.fn(async () => ['169.254.169.254']);
      const result = await validateSafeHttpUrl('http://169.254.169.254/latest/meta-data', {
        dnsResolver: mockDns,
      });
      expect(result.safe).toBe(false);
    });
  });

  describe('Localhost test opt-in controls', () => {
    it('rejects allowLocalhost when SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS is NOT set', () => {
      delete process.env.SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS;
      expect(isSafeHttpUrlSync('http://127.0.0.1:8080/hook', { allowLocalhost: true }).safe).toBe(false);
      expect(isSafeHttpUrlSync('http://localhost:3000/hook', { allowLocalhost: true }).safe).toBe(false);
    });

    it('permits allowLocalhost when SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS=1', () => {
      process.env.SUPPORT_ALLOW_LOCAL_WEBHOOK_TESTS = '1';
      expect(isSafeHttpUrlSync('http://127.0.0.1:8080/hook', { allowLocalhost: true }).safe).toBe(true);
      expect(isSafeHttpUrlSync('http://localhost:3000/hook', { allowLocalhost: true }).safe).toBe(true);
    });
  });

  describe('safeFetch execution & redirect prevention', () => {
    it('rejects HTTP 301/302 redirects without following', async () => {
      const mockFetch = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      }));

      const mockDns = vi.fn(async () => ['93.184.216.34']);

      await expect(
        safeFetch('https://api.partner.com/redirect', {}, {
          fetchFn: mockFetch as unknown as typeof fetch,
          dnsResolver: mockDns,
        }),
      ).rejects.toThrow(SafeHttpError);

      await expect(
        safeFetch('https://api.partner.com/redirect', {}, {
          fetchFn: mockFetch as unknown as typeof fetch,
          dnsResolver: mockDns,
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('executes successful safe request with manual redirect and safe dispatcher', async () => {
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const mockDns = vi.fn(async () => ['93.184.216.34']);

      const res = await safeFetch('https://api.partner.com/data', {}, {
        fetchFn: mockFetch as unknown as typeof fetch,
        dnsResolver: mockDns,
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
    });
  });

  describe('Additive MCP options: allowedOrigins, requireExplicitHttpOrigin & manual followRedirects', () => {
    it('allows exact-origin private/loopback only when listed in allowedOrigins and blocks metadata/unspecified/multicast/link-local', async () => {
      const mockDns = vi.fn(async (host: string) => {
        if (host === 'internal-mcp.example') return ['10.20.30.40'];
        if (host === 'localhost') return ['127.0.0.1'];
        return ['93.184.216.34'];
      });

      // Allowed exact origin (private IP)
      const okPrivate = await validateSafeHttpUrl('https://internal-mcp.example:8443/mcp', {
        allowedOrigins: ['https://internal-mcp.example:8443'],
        requireExplicitHttpOrigin: true,
        dnsResolver: mockDns,
      });
      expect(okPrivate.safe).toBe(true);
      expect(okPrivate.resolvedIps).toEqual(['10.20.30.40']);

      // Different port rejected
      const wrongPort = await validateSafeHttpUrl('https://internal-mcp.example:9443/mcp', {
        allowedOrigins: ['https://internal-mcp.example:8443'],
        requireExplicitHttpOrigin: true,
        dnsResolver: mockDns,
      });
      expect(wrongPort.safe).toBe(false);

      // HTTP rejected unless exact origin in allowedOrigins
      const httpNotAllowed = await validateSafeHttpUrl('http://api.partner.com/mcp', {
        allowedOrigins: ['https://api.partner.com'],
        requireExplicitHttpOrigin: true,
        dnsResolver: mockDns,
      });
      expect(httpNotAllowed.safe).toBe(false);

      // HTTP allowed when exact origin in allowedOrigins
      const httpAllowed = await validateSafeHttpUrl('http://127.0.0.1:4321/mcp', {
        allowedOrigins: ['http://127.0.0.1:4321'],
        requireExplicitHttpOrigin: true,
        dnsResolver: mockDns,
      });
      expect(httpAllowed.safe).toBe(true);

      // Wildcard, CIDR, path, query, userinfo in allowedOrigins are ignored/rejected
      const wildcardRejected = await validateSafeHttpUrl('http://127.0.0.1:4321/mcp', {
        allowedOrigins: ['http://*.127.0.0.1:4321', 'http://127.0.0.0/8', 'http://127.0.0.1:4321/path', 'http://user:pass@127.0.0.1:4321'],
        requireExplicitHttpOrigin: true,
        dnsResolver: mockDns,
      });
      expect(wildcardRejected.safe).toBe(false);

      // Metadata, link-local, unspecified, multicast ALWAYS blocked even if in allowedOrigins
      for (const badUrl of [
        'http://169.254.169.254/latest/meta-data',
        'http://169.254.1.2:8080/mcp',
        'http://0.0.0.0:8080/mcp',
        'http://224.0.0.1:8080/mcp',
        'http://[fe80::1]:8080/mcp',
        'http://[::]:8080/mcp',
        'http://[ff02::1]:8080/mcp',
      ]) {
        const origin = new URL(badUrl).origin;
        const res = await validateSafeHttpUrl(badUrl, {
          allowedOrigins: [origin],
          requireExplicitHttpOrigin: true,
          dnsResolver: mockDns,
        });
        expect(res.safe).toBe(false);
      }
    });

    it('follows up to 3 method-preserving redirects, validates each hop DNS, and strips credentials on cross-origin', async () => {
      const seenRequests: Array<{ url: string; method?: string; headers: Record<string, string>; hasDispatcher: boolean }> = [];
      let step = 0;
      const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit & { dispatcher?: unknown }) => {
        step += 1;
        const headersObj: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headersObj[k.toLowerCase()] = v;
        });
        seenRequests.push({
          url: String(url),
          method: init?.method,
          headers: headersObj,
          hasDispatcher: Boolean(init?.dispatcher),
        });
        expect(init?.redirect).toBe('manual');
        expect(init?.dispatcher).toBeDefined();

        if (step === 1) {
          return new Response(null, { status: 307, headers: { Location: 'https://mcp-b.example.com/v2/rpc' } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });

      const mockDns = vi.fn(async () => ['93.184.216.34']);

      const res = await safeFetch(
        'https://mcp-a.example.com/rpc',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer super-secret',
            'X-Custom-Secret': 'secret-123',
            'Mcp-Session-Id': 'sess-abc',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        },
        {
          fetchFn: mockFetch as unknown as typeof fetch,
          dnsResolver: mockDns,
          followRedirects: {
            maxRedirects: 3,
            methodPreservingOnly: true,
            stripHeadersOnCrossOrigin: ['x-custom-secret'],
          },
        },
      );

      expect(res.status).toBe(200);
      expect(seenRequests).toHaveLength(2);
      expect(seenRequests[0].headers['authorization']).toBe('Bearer super-secret');
      expect(seenRequests[0].headers['x-custom-secret']).toBe('secret-123');
      expect(seenRequests[0].headers['mcp-session-id']).toBe('sess-abc');
      // Cross-origin hop stripped sensitive headers
      expect(seenRequests[1].headers['authorization']).toBeUndefined();
      expect(seenRequests[1].headers['x-custom-secret']).toBeUndefined();
      expect(seenRequests[1].headers['mcp-session-id']).toBeUndefined();
      expect(seenRequests[1].headers['content-type']).toBe('application/json');
      expect(mockDns).toHaveBeenCalledWith('mcp-a.example.com');
      expect(mockDns).toHaveBeenCalledWith('mcp-b.example.com');
    });

    it('rejects non-method-preserving 302 on POST, redirect loops, >3 hops, and redirects to private/metadata IPs', async () => {
      const mockDns = vi.fn(async (host: string) => {
        if (host === 'evil-internal.example.com') return ['10.0.0.5'];
        return ['93.184.216.34'];
      });

      // 302 on POST rejected
      const fetch302 = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://mcp-b.example.com/rpc' } }));
      await expect(
        safeFetch('https://mcp-a.example.com/rpc', { method: 'POST' }, {
          fetchFn: fetch302 as unknown as typeof fetch,
          dnsResolver: mockDns,
          followRedirects: { maxRedirects: 3, methodPreservingOnly: true },
        }),
      ).rejects.toThrow(SafeHttpError);

      // >3 hops rejected
      let hop = 0;
      const fetch4Hops = vi.fn(async () => {
        hop += 1;
        return new Response(null, { status: 307, headers: { Location: `https://mcp-a.example.com/hop-${hop}` } });
      });
      await expect(
        safeFetch('https://mcp-a.example.com/hop-0', { method: 'POST' }, {
          fetchFn: fetch4Hops as unknown as typeof fetch,
          dnsResolver: mockDns,
          followRedirects: { maxRedirects: 3, methodPreservingOnly: true },
        }),
      ).rejects.toThrow(SafeHttpError);

      // Redirect loop rejected
      const fetchLoop = vi.fn(async (url: string | URL | Request) => {
        const next = String(url).endsWith('/a') ? 'https://mcp-a.example.com/b' : 'https://mcp-a.example.com/a';
        return new Response(null, { status: 307, headers: { Location: next } });
      });
      await expect(
        safeFetch('https://mcp-a.example.com/a', { method: 'POST' }, {
          fetchFn: fetchLoop as unknown as typeof fetch,
          dnsResolver: mockDns,
          followRedirects: { maxRedirects: 3, methodPreservingOnly: true },
        }),
      ).rejects.toThrow(SafeHttpError);

      // Redirect to private DNS target rejected
      const fetchToInternal = vi.fn(async () => new Response(null, {
        status: 307,
        headers: { Location: 'https://evil-internal.example.com/rpc' },
      }));
      await expect(
        safeFetch('https://mcp-a.example.com/rpc', { method: 'POST' }, {
          fetchFn: fetchToInternal as unknown as typeof fetch,
          dnsResolver: mockDns,
          followRedirects: { maxRedirects: 3, methodPreservingOnly: true },
        }),
      ).rejects.toThrow(SafeHttpError);
    });

    it('enforces timeoutMs/signal during slow or hanging DNS resolution without invoking fetchFn', async () => {
      const fetchFn = vi.fn(async () => new Response('ok', { status: 200 }));

      // Slow DNS (350ms) vs 50ms timeoutMs
      const startSlow = Date.now();
      await expect(
        safeFetch('https://dns-slow.example.test/mcp', { method: 'POST' }, {
          timeoutMs: 50,
          fetchFn: fetchFn as unknown as typeof fetch,
          dnsResolver: async () => {
            await new Promise((r) => setTimeout(r, 350));
            return ['93.184.216.34'];
          },
        }),
      ).rejects.toThrow(SafeHttpError);
      expect(Date.now() - startSlow).toBeLessThan(200);

      // Hanging (never-settling) DNS vs 50ms timeoutMs
      const startHang = Date.now();
      await expect(
        safeFetch('https://dns-hang.example.test/mcp', { method: 'POST' }, {
          timeoutMs: 50,
          fetchFn: fetchFn as unknown as typeof fetch,
          dnsResolver: () => new Promise<string[]>(() => {}),
        }),
      ).rejects.toThrow(SafeHttpError);
      expect(Date.now() - startHang).toBeLessThan(200);

      // Caller AbortSignal aborting during pending DNS
      const ac = new AbortController();
      setTimeout(() => ac.abort(new Error('caller cancelled')), 20);
      const startAbort = Date.now();
      await expect(
        safeFetch('https://dns-abort.example.test/mcp', { method: 'POST', signal: ac.signal }, {
          fetchFn: fetchFn as unknown as typeof fetch,
          dnsResolver: () => new Promise<string[]>(() => {}),
        }),
      ).rejects.toThrow(SafeHttpError);
      expect(Date.now() - startAbort).toBeLessThan(200);

      // Wait past 350ms to confirm late DNS settlement never dispatches fetchFn
      await new Promise((r) => setTimeout(r, 380));
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});
