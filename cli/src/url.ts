// The ONE gateway-URL normaliser for the CLI.
//
// Four copies of this used to live in different files (index.ts `rootUrl`,
// tools.ts `rootUrl`, keys.ts `gatewayRoot`, doctor.ts `normalizeUrl`), each
// with its own quirks — one lowercased the host, one did not, one validated
// the scheme and one happily built a fetch URL out of garbage. A gateway URL
// is `http(s)://host[:port][/prefix]` with an optional trailing `/v1` and
// trailing slashes; normalising it is one job, so it lives here.
//
// Two shapes, one rule:
// - `gatewayRootUrl` builds request bases: it validates (http/https, no
//   credentials, query or fragment) and throws a plain error on anything
//   else, so a bad `--url` fails fast with a readable message instead of a
//   confusing fetch failure downstream.
// - `normalizeUrl` (doctor.ts, comparison-only) still never throws and still
//   drops query/fragment instead of rejecting them; it shares only the
//   suffix-stripping step below, so the `/v1` rule cannot drift apart again.

/** Strip trailing slashes, then a trailing `/v1` — the gateway's API prefix. */
export function stripGatewaySuffix(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/**
 * Normalise a gateway URL for building requests: trim, require http(s) with
 * no credentials, query or fragment, drop a trailing `/v1` and trailing
 * slashes. Scheme/host are folded by the URL parser; a path prefix keeps its
 * case (`http://host/gateway` is a different endpoint from
 * `http://host/Gateway`).
 */
export function gatewayRootUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('--url must be an HTTP(S) gateway URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('--url must be an HTTP(S) gateway URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--url must be an HTTP(S) URL without credentials, a query, or a fragment');
  }
  return `${parsed.protocol}//${parsed.host}${stripGatewaySuffix(parsed.pathname)}`;
}

/** `gatewayRootUrl(url)` with the `/v1` API prefix re-attached. */
export function gatewayV1Url(url: string): string {
  return `${gatewayRootUrl(url)}/v1`;
}
