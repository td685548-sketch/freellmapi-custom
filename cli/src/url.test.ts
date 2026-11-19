import { describe, expect, it } from 'vitest';
import { gatewayRootUrl, gatewayV1Url, stripGatewaySuffix } from './url.js';

describe('gatewayRootUrl', () => {
  it('strips a trailing /v1 and trailing slashes', () => {
    expect(gatewayRootUrl('http://localhost:3001/v1')).toBe('http://localhost:3001');
    expect(gatewayRootUrl('http://localhost:3001/v1/')).toBe('http://localhost:3001');
    expect(gatewayRootUrl('http://localhost:3001///')).toBe('http://localhost:3001');
    expect(gatewayRootUrl('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('keeps a path prefix, case-sensitively', () => {
    expect(gatewayRootUrl('http://host/gateway/v1')).toBe('http://host/gateway');
    expect(gatewayRootUrl('HTTP://Host:3000/Gateway')).toBe('http://host:3000/Gateway');
  });

  it('trims surrounding whitespace', () => {
    expect(gatewayRootUrl('  http://localhost:3001/v1  ')).toBe('http://localhost:3001');
  });

  it('rejects non-HTTP(S) URLs, credentials, queries and fragments', () => {
    expect(() => gatewayRootUrl('ftp://host')).toThrow(/HTTP\(S\) gateway URL/);
    expect(() => gatewayRootUrl('not a url')).toThrow(/HTTP\(S\) gateway URL/);
    expect(() => gatewayRootUrl('http://user:password@localhost:3000')).toThrow(/without credentials/);
    expect(() => gatewayRootUrl('http://localhost:3000/?k=1')).toThrow(/without credentials/);
    expect(() => gatewayRootUrl('http://localhost:3000/#x')).toThrow(/without credentials/);
  });
});

describe('gatewayV1Url', () => {
  it('re-attaches /v1 to the normalised root', () => {
    expect(gatewayV1Url('http://localhost:3001/v1/')).toBe('http://localhost:3001/v1');
    expect(gatewayV1Url('http://host/gateway')).toBe('http://host/gateway/v1');
  });
});

describe('stripGatewaySuffix', () => {
  it('strips trailing slashes then a trailing /v1, case-insensitively', () => {
    expect(stripGatewaySuffix('http://host/v1/')).toBe('http://host');
    expect(stripGatewaySuffix('http://host/V1')).toBe('http://host');
    expect(stripGatewaySuffix('http://host/gateway')).toBe('http://host/gateway');
    // Only a TRAILING /v1 goes: /v1beta is a different API surface.
    expect(stripGatewaySuffix('http://host/v1beta')).toBe('http://host/v1beta');
  });
});
