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
});
