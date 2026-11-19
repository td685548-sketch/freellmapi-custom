import type { Request, Response, NextFunction } from 'express';

// Host-header allowlist (#1637): DNS-rebinding defense for localhost installs.
//
// Docker Compose publishes the server on 127.0.0.1 by default, which keeps it
// off the LAN but NOT off the browser: a page on a hostname the attacker
// controls can re-resolve that name to 127.0.0.1 mid-session (rebinding) and
// then issue "same-origin" requests that arrive with `Host: attacker.example`.
// Auth covers /v1 and the dashboard API, but unauthenticated routes (login,
// status, first-run setup) and the login form itself are reachable that way.
//
// The fix is the standard one: unless the Host header names a host the operator
// declared, reject with 403 before routing or auth runs. The guard is OPT-IN:
// with ALLOWED_HOSTS unset it does nothing, because a loopback-only default
// would lock out every LAN, Docker-network, desktop-LAN and reverse-proxy
// install on upgrade. Once ALLOWED_HOSTS lists any hostname, the allow list is
// those names plus the loopback set — localhost, 127.0.0.1, ::1, and
// *.localhost (which browsers treat as loopback-equivalent secure contexts).
// '*' keeps it off explicitly.
//
// Matching is on the HOSTNAME ONLY, never host:port: Compose remaps the outer
// port freely (HOST_BIND + ports: "127.0.0.1:${HOST_PORT:-3001}:3001") and the
// rebinding threat has nothing to do with ports.

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** True when `host` binds every interface instead of loopback only. */
export function isWideBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === '' || normalized === '*' || normalized === '::' || normalized === '0.0.0.0';
}

/**
 * Boot warning for a wide bind with the DNS-rebinding guard off. Called once
 * from createApp: binding '::' / '0.0.0.0' with ALLOWED_HOSTS unset (or '*')
 * leaves the dashboard reachable from the whole network with no Host-header
 * check, so the operator should either narrow the bind (HOST=127.0.0.1) or
 * turn the guard on (ALLOWED_HOSTS). Deliberately a warning, not a refusal:
 * LAN, reverse-proxy and container installs bind wide on purpose.
 */
export function warnOnWideBind(
  host: string,
  allowed: string[],
  logger: Pick<Console, 'warn'> = console,
): void {
  if (!isWideBindHost(host)) return;
  const guardOff = allowed.length === 0 || allowed.includes('*');
  if (!guardOff) return;
  logger.warn(
    '[server] WARNING: listening on all interfaces ' +
      `(${host.trim() || '0.0.0.0'}) with the Host-header guard off (ALLOWED_HOSTS unset). ` +
      'Anyone who can reach this port can load the dashboard. ' +
      'Set HOST=127.0.0.1 to listen on loopback only, or set ALLOWED_HOSTS to the hostnames you serve.',
  );
}

/** Lowercase hostname from a raw Host header value, or null if malformed.
 *  URL parsing is what makes `[::1]:3001` (bracketed IPv6), `host` and
 *  `host:port` all yield a comparable bare hostname. WHATWG URL keeps the
 *  brackets on an IPv6 hostname (`[::1]`), so they are stripped for the
 *  comparison set. */
function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    const host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/**
 * Express middleware enforcing the Host allowlist.
 * @param allowed raw host patterns from ALLOWED_HOSTS (empty → guard off). Exact, case-insensitive hostnames; a single `*` disables the
 *  guard. `*.example.com` entries match any single-label subdomain wildcard
 *  is NOT supported — name every host you serve.
 */
export function createHostGuard(allowed: string[]) {
  const wildcard = allowed.includes('*');
  const names = new Set(
    allowed
      .filter(h => h !== '*')
      .map(h => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const isAllowedHost = (host: string): boolean =>
    DEFAULT_ALLOWED_HOSTS.includes(host) ||
    host.endsWith('.localhost') ||
    names.has(host);

  return function hostGuard(req: Request, res: Response, next: NextFunction): void {
    if (wildcard || names.size === 0) {
      next();
      return;
    }
    // A request with two Host headers never reaches here: Node's HTTP parser
    // rejects it with a 400 before Express sees it. The header value is a
    // plain string by the time this runs.
    const host = hostnameOf(req.headers.host);
    if (host === null || !isAllowedHost(host)) {
      res
        .status(403)
        .json({
          error: {
            message:
              'Host header not allowed. If you reach this server by IP or by a ' +
              'custom hostname, add that hostname to ALLOWED_HOSTS (comma-' +
              'separated; ALLOWED_HOSTS=* disables this check).',
            type: 'invalid_request_error',
          },
        });
      return;
    }
    next();
  };
}
