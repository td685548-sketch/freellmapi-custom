import { describe, it, expect } from 'vitest';
import { PLATFORMS, type Platform } from '@freellmapi/shared/types.js';
import { getAllProviders, getProvider, hasProvider } from '../../providers/index.js';

// Every value of the shared `Platform` union must have a registered adapter,
// and every registered adapter must be a `Platform` value. A platform that is
// dropped (models/keys removed, e.g. SambaNova in V23) must also be dropped
// from `PLATFORMS` — otherwise the router silently skips its catalog rows:
// services/router.ts `selectKeyForModel` returns null with only a diag line
// when `hasProvider(entry.platform)` is false, so the model looks routable
// in the catalog but can never serve a request.
describe('Platform <-> provider registry parity', () => {
  it('declares each platform exactly once', () => {
    expect(new Set(PLATFORMS).size).toBe(PLATFORMS.length);
  });

  it('registers a provider for every Platform value', () => {
    const missing = (PLATFORMS as readonly string[]).filter((p) => !hasProvider(p as Platform));
    expect(missing).toEqual([]);
  });

  it('resolves a provider whose platform matches for every Platform value', () => {
    for (const platform of PLATFORMS) {
      const provider = getProvider(platform);
      expect(provider, `getProvider('${platform}')`).toBeDefined();
      expect(provider!.platform).toBe(platform);
    }
  });

  it('registers no provider outside the Platform union', () => {
    const registered = getAllProviders().map((p) => p.platform);
    expect(new Set(registered).size).toBe(registered.length);
    const outside = registered.filter((p) => !(PLATFORMS as readonly string[]).includes(p));
    expect(outside).toEqual([]);
    expect(registered.length).toBe(PLATFORMS.length);
  });
});
