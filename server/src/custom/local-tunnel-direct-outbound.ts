import { tursoEnabled } from '../db/turso.js';

const LOCAL_TUNNEL_HOST_SUFFIXES = ['.ts.net', '.trycloudflare.com'] as const;

export interface LocalDirectOutboundResult {
  applied: boolean;
  reason:
    | 'forced_on'
    | 'auto_local_tunnel'
    | 'disabled_by_override'
    | 'cloud_hosted'
    | 'not_local_tunnel'
    | 'not_fetch_relay';
}

function parseTriStateFlag(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

/**
 * True when running on Render or a remote Turso cloud database.
 * Cloud deployments retain their configured Fetch Relay / outbound proxy untouched.
 */
export function isCloudHostedEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RENDER === 'true' || Boolean(env.RENDER_SERVICE_ID?.trim())) {
    return true;
  }
  if (tursoEnabled(env)) {
    return true;
  }
  const publicUrl = env.PUBLIC_APP_URL?.trim();
  if (publicUrl) {
    try {
      const host = new URL(publicUrl).hostname.toLowerCase();
      if (host.endsWith('.onrender.com')) return true;
    } catch {
      // ignore malformed URL here
    }
  }
  return false;
}

/**
 * True when running on a local SQLite host exposed through a local tunnel daemon
 * (e.g., Tailscale Funnel `*.ts.net`, Cloudflare Tunnel with loopback trust proxy).
 */
export function isLocalTunnelEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCloudHostedEnvironment(env)) return false;

  const publicUrl = env.PUBLIC_APP_URL?.trim();
  if (publicUrl) {
    try {
      const host = new URL(publicUrl).hostname.toLowerCase();
      if (LOCAL_TUNNEL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
        return true;
      }
    } catch {
      // ignore malformed URL
    }
  }

  const trustProxy = env.TRUST_PROXY?.trim().toLowerCase() ?? '';
  if (
    trustProxy === 'loopback' ||
    trustProxy === '127.0.0.1' ||
    trustProxy === '127.0.0.1,::1'
  ) {
    return Boolean(publicUrl);
  }

  return false;
}

/**
 * Bypasses inherited cloud Fetch Relay settings (`PROXY_MODE=fetch-relay`) ONLY on
 * local tunnel servers so upstream LLM calls travel directly over the host network
 * with minimal latency, while leaving Render / Turso cloud deployments untouched.
 *
 * Operators can explicitly control this via `FREEAPI_LOCAL_DIRECT_OUTBOUND=1|0`.
 */
export function applyLocalTunnelDirectOutbound(
  env: NodeJS.ProcessEnv = process.env,
  log: (msg: string) => void = console.log,
): LocalDirectOutboundResult {
  if (isCloudHostedEnvironment(env)) {
    return { applied: false, reason: 'cloud_hosted' };
  }

  const override = parseTriStateFlag(env.FREEAPI_LOCAL_DIRECT_OUTBOUND);
  if (override === false) {
    return { applied: false, reason: 'disabled_by_override' };
  }

  const proxyMode = (env.PROXY_MODE ?? env.proxy_mode ?? '').trim().toLowerCase();
  const hasProxyUrl = Boolean((env.PROXY_URL ?? env.proxy_url ?? '').trim());

  if (override === true) {
    if (hasProxyUrl || proxyMode) {
      delete env.PROXY_URL;
      delete env.proxy_url;
      delete env.PROXY_MODE;
      delete env.proxy_mode;
      delete env.FETCH_RELAY_TOKEN;
      delete env.fetch_relay_token;
      log(
        '[local-direct] Direct outbound routing forced via FREEAPI_LOCAL_DIRECT_OUTBOUND=1 (cloud relay bypassed).',
      );
    }
    return { applied: true, reason: 'forced_on' };
  }

  if (!isLocalTunnelEnvironment(env)) {
    return { applied: false, reason: 'not_local_tunnel' };
  }

  if (proxyMode !== 'fetch-relay') {
    return { applied: false, reason: 'not_fetch_relay' };
  }

  delete env.PROXY_URL;
  delete env.proxy_url;
  delete env.PROXY_MODE;
  delete env.proxy_mode;
  delete env.FETCH_RELAY_TOKEN;
  delete env.fetch_relay_token;
  log(
    '[local-direct] Local tunnel server detected — bypassing cloud fetch-relay for low-latency direct outbound routing (set FREEAPI_LOCAL_DIRECT_OUTBOUND=0 to keep relay).',
  );
  return { applied: true, reason: 'auto_local_tunnel' };
}
