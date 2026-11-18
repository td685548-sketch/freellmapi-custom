import { describe, expect, it } from 'vitest';
import {
  applyLocalTunnelDirectOutbound,
  isCloudHostedEnvironment,
  isLocalTunnelEnvironment,
} from '../../custom/local-tunnel-direct-outbound.js';

describe('local-tunnel-direct-outbound', () => {
  it('detects local Tailscale Funnel / loopback tunnel environments with SQLite', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      FREEAPI_DB_DRIVER: 'sqlite',
      PUBLIC_APP_URL: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
      TRUST_PROXY: 'loopback',
    };
    expect(isCloudHostedEnvironment(env)).toBe(false);
    expect(isLocalTunnelEnvironment(env)).toBe(true);
  });

  it('automatically bypasses inherited fetch-relay on a local tunnel server', () => {
    const logs: string[] = [];
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      FREEAPI_DB_DRIVER: 'sqlite',
      PUBLIC_APP_URL: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
      TRUST_PROXY: 'loopback',
      PROXY_MODE: 'fetch-relay',
      PROXY_URL: 'https://relay.example.workers.dev',
      FETCH_RELAY_TOKEN: 'secret-token',
    };

    const res = applyLocalTunnelDirectOutbound(env, (m) => logs.push(m));
    expect(res).toEqual({ applied: true, reason: 'auto_local_tunnel' });
    expect(env.PROXY_URL).toBeUndefined();
    expect(env.PROXY_MODE).toBeUndefined();
    expect(env.FETCH_RELAY_TOKEN).toBeUndefined();
    expect(logs.length).toBe(1);
  });

  it('never modifies fetch-relay on Render or Turso cloud deployments', () => {
    const renderEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      RENDER: 'true',
      RENDER_SERVICE_ID: 'srv-example',
      PUBLIC_APP_URL: 'https://service.onrender.com',
      PROXY_MODE: 'fetch-relay',
      PROXY_URL: 'https://relay.example.workers.dev',
      FETCH_RELAY_TOKEN: 'secret-token',
      FREEAPI_LOCAL_DIRECT_OUTBOUND: '1',
    };

    const res = applyLocalTunnelDirectOutbound(renderEnv, () => {});
    expect(res).toEqual({ applied: false, reason: 'cloud_hosted' });
    expect(renderEnv.PROXY_URL).toBe('https://relay.example.workers.dev');
    expect(renderEnv.PROXY_MODE).toBe('fetch-relay');

    const tursoEnv: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      FREEAPI_DB_DRIVER: 'turso',
      TURSO_DATABASE_URL: 'libsql://example.turso.io',
      TURSO_AUTH_TOKEN: 'tok',
      PUBLIC_APP_URL: 'https://custom.domain.example',
      PROXY_MODE: 'fetch-relay',
      PROXY_URL: 'https://relay.example.workers.dev',
    };
    expect(applyLocalTunnelDirectOutbound(tursoEnv, () => {})).toEqual({
      applied: false,
      reason: 'cloud_hosted',
    });
    expect(tursoEnv.PROXY_URL).toBe('https://relay.example.workers.dev');
  });

  it('preserves fetch-relay on local tunnel server when FREEAPI_LOCAL_DIRECT_OUTBOUND=0', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      FREEAPI_DB_DRIVER: 'sqlite',
      PUBLIC_APP_URL: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
      TRUST_PROXY: 'loopback',
      PROXY_MODE: 'fetch-relay',
      PROXY_URL: 'https://relay.example.workers.dev',
      FREEAPI_LOCAL_DIRECT_OUTBOUND: '0',
    };

    const res = applyLocalTunnelDirectOutbound(env, () => {});
    expect(res).toEqual({ applied: false, reason: 'disabled_by_override' });
    expect(env.PROXY_URL).toBe('https://relay.example.workers.dev');
  });

  it('leaves local SOCKS5/HTTP forward proxies untouched when auto-detecting', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      FREEAPI_DB_DRIVER: 'sqlite',
      PUBLIC_APP_URL: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
      TRUST_PROXY: 'loopback',
      PROXY_URL: 'socks5h://127.0.0.1:1080',
    };

    const res = applyLocalTunnelDirectOutbound(env, () => {});
    expect(res).toEqual({ applied: false, reason: 'not_fetch_relay' });
    expect(env.PROXY_URL).toBe('socks5h://127.0.0.1:1080');
  });
});
