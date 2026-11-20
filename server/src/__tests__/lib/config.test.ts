import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadConfig, parsePort, resetConfigParseWarningsForTests } from '../../lib/config.js';

const ENV_KEYS = ['PORT', 'HOST', 'FREEAPI_DB_PATH', 'DASHBOARD_ORIGINS', 'CLIENT_DIST', 'PROXY_RATE_LIMIT_RPM', 'REQUEST_BODY_LIMIT_MB', 'NODE_ENV', 'TRUST_PROXY'];

afterEach(() => {
  ENV_KEYS.forEach(k => delete process.env[k]);
  resetConfigParseWarningsForTests();
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('returns sensible defaults when no env vars are set', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(3001);
    // Loopback-only by default: a fresh install must not listen on every
    // interface until the operator opts into a wide bind (HOST=:: / 0.0.0.0).
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.dbPath).toBeNull();
    expect(cfg.dashboardOrigins).toEqual([]);
    expect(cfg.clientDist).toBeNull();
    expect(cfg.proxyRateLimitRpm).toBe(120);
    expect(cfg.serveStaticAssets).toBe(true);
  });

  it('still honours an explicit wide bind', () => {
    process.env.HOST = '::';
    const cfg = loadConfig();
    expect(cfg.host).toBe('::');
  });

  it('reads PORT and HOST from env', () => {
    process.env.PORT = '8080';
    process.env.HOST = '0.0.0.0';
    const cfg = loadConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe('0.0.0.0');
  });

  it('parses DASHBOARD_ORIGINS as a comma-separated list', () => {
    process.env.DASHBOARD_ORIGINS = 'http://localhost:3000, http://example.com , ';
    const cfg = loadConfig();
    expect(cfg.dashboardOrigins).toEqual(['http://localhost:3000', 'http://example.com']);
  });

  it('reads CLIENT_DIST from env', () => {
    process.env.CLIENT_DIST = '/opt/client/dist';
    const cfg = loadConfig();
    expect(cfg.clientDist).toBe('/opt/client/dist');
  });

  it('reads FREEAPI_DB_PATH from env', () => {
    process.env.FREEAPI_DB_PATH = '/data/freeapi.db';
    expect(loadConfig().dbPath).toBe('/data/freeapi.db');
  });

  it('parses PROXY_RATE_LIMIT_RPM as a number', () => {
    process.env.PROXY_RATE_LIMIT_RPM = '60';
    expect(loadConfig().proxyRateLimitRpm).toBe(60);
  });

  it('falls back to default RPM for invalid PROXY_RATE_LIMIT_RPM', () => {
    process.env.PROXY_RATE_LIMIT_RPM = 'not-a-number';
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
    process.env.PROXY_RATE_LIMIT_RPM = '-5';
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
  });

  it('accepts 0 to disable rate limiting', () => {
    process.env.PROXY_RATE_LIMIT_RPM = '0';
    expect(loadConfig().proxyRateLimitRpm).toBe(0);
  });

  it('reads NODE_ENV from env', () => {
    process.env.NODE_ENV = 'production';
    expect(loadConfig().nodeEnv).toBe('production');
  });

  it('defaults TRUST_PROXY to false (do not trust forwarded headers)', () => {
    expect(loadConfig().trustProxy).toBe(false);
  });

  it('parses TRUST_PROXY=true as trust-all', () => {
    process.env.TRUST_PROXY = 'true';
    expect(loadConfig().trustProxy).toBe(true);
  });

  it('parses TRUST_PROXY=false as untrusted', () => {
    process.env.TRUST_PROXY = 'false';
    expect(loadConfig().trustProxy).toBe(false);
  });

  it('parses an integer TRUST_PROXY as a hop count, not trust-all', () => {
    process.env.TRUST_PROXY = '1';
    expect(loadConfig().trustProxy).toBe(1);
    process.env.TRUST_PROXY = '2';
    expect(loadConfig().trustProxy).toBe(2);
    process.env.TRUST_PROXY = '0';
    expect(loadConfig().trustProxy).toBe(false);
  });

  it('parses TRUST_PROXY as a comma-separated proxy list', () => {
    process.env.TRUST_PROXY = '100.64.0.0/10, 192.168.1.10 , ';
    expect(loadConfig().trustProxy).toEqual(['100.64.0.0/10', '192.168.1.10']);
  });

  it('falls back to the default request body limit for invalid REQUEST_BODY_LIMIT_MB', () => {
    process.env.REQUEST_BODY_LIMIT_MB = 'not-a-number';
    expect(loadConfig().requestBodyLimitBytes).toBe(25 * 1024 * 1024);
    process.env.REQUEST_BODY_LIMIT_MB = '0';
    expect(loadConfig().requestBodyLimitBytes).toBe(25 * 1024 * 1024);
  });

  it('parses REQUEST_BODY_LIMIT_MB as megabytes', () => {
    process.env.REQUEST_BODY_LIMIT_MB = '10';
    expect(loadConfig().requestBodyLimitBytes).toBe(10 * 1024 * 1024);
  });
});

describe('parsePort', () => {
  it('returns the default when unset or blank', () => {
    expect(parsePort(undefined)).toBe(3001);
    expect(parsePort('')).toBe(3001);
    expect(parsePort('   ')).toBe(3001);
  });

  it('accepts valid ports, trimming surrounding whitespace', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort(' 3001 ')).toBe(3001);
  });

  it.each(['abc', '0', '-1', '65536', '99999', '3001.5', '3001abc', 'NaN', '+3001', '0x3001'])(
    'throws a clear error for invalid PORT=%s',
    (raw) => {
      expect(() => parsePort(raw)).toThrow(/Invalid PORT.*1 and 65535/);
    },
  );

  it('fails fast from loadConfig on an invalid PORT', () => {
    process.env.PORT = 'abc';
    expect(() => loadConfig()).toThrow(/Invalid PORT="abc"/);
    process.env.PORT = '99999';
    expect(() => loadConfig()).toThrow(/Invalid PORT="99999"/);
  });

  it('treats a blank PORT as unset instead of binding a random port', () => {
    process.env.PORT = '';
    expect(loadConfig().port).toBe(3001);
  });
});

describe('invalid numeric env fallbacks warn once per variable', () => {
  it('warns once for PROXY_RATE_LIMIT_RPM across repeated loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROXY_RATE_LIMIT_RPM = 'not-a-number';
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
    expect(loadConfig().proxyRateLimitRpm).toBe(120);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('PROXY_RATE_LIMIT_RPM');
  });

  it('warns once for REQUEST_BODY_LIMIT_MB across repeated loads', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.REQUEST_BODY_LIMIT_MB = '-5';
    expect(loadConfig().requestBodyLimitBytes).toBe(25 * 1024 * 1024);
    expect(loadConfig().requestBodyLimitBytes).toBe(25 * 1024 * 1024);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('REQUEST_BODY_LIMIT_MB');
  });

  it('warns separately for each invalid variable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROXY_RATE_LIMIT_RPM = 'abc';
    process.env.REQUEST_BODY_LIMIT_MB = 'abc';
    loadConfig();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn for valid values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.PROXY_RATE_LIMIT_RPM = '60';
    process.env.REQUEST_BODY_LIMIT_MB = '10';
    loadConfig();
    expect(warn).not.toHaveBeenCalled();
  });
});
