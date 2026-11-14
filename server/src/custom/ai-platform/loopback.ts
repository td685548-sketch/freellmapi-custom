/**
 * T013 — loopback.ts
 * Secure same-server loopback call for the AI-platform orchestrator.
 * Only node:crypto and node:http are used (no additional packages).
 */
import crypto from 'node:crypto';
import http from 'node:http';
import type { Request } from 'express';
import type { ChatMessage, ChatToolDefinition, TokenUsage } from '@freellmapi/shared/types.js';
import { extractInferenceToken } from '../../middleware/user-rate-limit.js';

// ── Re-export types used by callers ─────────────────────────────────────────

export type ToolDefinition = ChatToolDefinition;
export type Usage = TokenUsage;

// ── Module-level key — generated once, never logged ─────────────────────────

const _KEY: Buffer = crypto.randomBytes(32);

// ── Constants ────────────────────────────────────────────────────────────────

const HEADER_NAME = 'x-ai-platform-internal';
const MAX_DEPTH = 1;
const MAX_STALENESS_SEC = 30;
type InternalCall = { runId?: string; depth: number } | null;
const admittedCalls = new WeakMap<Request, InternalCall>();

/** Verify the immutable inbound request before profile restrictions/enrichment. */
export function captureInternalCall(req: Request): void {
  if (!admittedCalls.has(req)) admittedCalls.set(req, isInternalCall(req));
}

// ── Public interfaces ────────────────────────────────────────────────────────

export interface LoopbackRequest {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  runId?: string;
  depth: number;
  signal: AbortSignal;
}

export class GatewayCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Gateway call failed: ${status} (${code})`);
    this.name = 'GatewayCallError';
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function isLoopbackAddr(raw: string): boolean {
  let addr = raw.trim();
  if (addr.startsWith('::ffff:')) addr = addr.slice(7);
  return addr === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

function sha256hex(data: string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256hex(key: Buffer, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

/**
 * Build the HMAC signing message.
 * Fields: method\npath\nprofile\nendUser\nbodyHash\nrunId\ndepth\ntimestamp\nnonce
 */
function signingMessage(opts: {
  method: string;
  path: string;
  profile: string;
  endUser: string;
  bodyHash: string;
  runId: string;
  depth: number;
  timestamp: string;
  nonce: string;
}): string {
  return [
    opts.method,
    opts.path,
    opts.profile,
    opts.endUser,
    opts.bodyHash,
    opts.runId,
    String(opts.depth),
    opts.timestamp,
    opts.nonce,
  ].join('\n');
}

/**
 * Build the `x-ai-platform-internal` header value.
 * Format: v1.<timestamp>.<nonce>.<hmac_hex>
 */
function buildHeader(opts: {
  method: string;
  path: string;
  profile: string;
  endUser: string;
  bodyJson: string;
  runId?: string;
  depth: number;
}): string {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const bodyHash = sha256hex(opts.bodyJson);
  const msg = signingMessage({
    method: opts.method,
    path: opts.path,
    profile: opts.profile,
    endUser: opts.endUser,
    bodyHash,
    runId: opts.runId ?? '',
    depth: opts.depth,
    timestamp,
    nonce,
  });
  const hmac = hmacSha256hex(_KEY, msg);
  return `v1.${timestamp}.${nonce}.${hmac}`;
}

// ── Exported: isInternalCall ─────────────────────────────────────────────────

/**
 * Validate that `req` arrived from an authenticated loopback call.
 * Returns `{ runId?, depth }` on success, `null` on any failure.
 * Never throws.
 */
export function isInternalCall(req: Request): { runId?: string; depth: number } | null {
  if (admittedCalls.has(req)) return admittedCalls.get(req) ?? null;
  try {
    // 1. Must arrive from a local socket — not via a proxy.
    const remote = req.socket?.remoteAddress ?? '';
    if (!isLoopbackAddr(remote)) return null;
    if (req.headers['x-forwarded-for']) return null;

    // 2. Header must be present.
    const rawHeader = req.headers[HEADER_NAME];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!headerValue) return null;

    // 3. Parse: v1.<timestamp>.<nonce>.<hmac>
    const parts = headerValue.split('.');
    // parts[0]='v1', parts[1]=timestamp, parts[2]=nonce, parts[3..]=hmac (hmac won't contain dots)
    if (parts.length < 4 || parts[0] !== 'v1') return null;
    const [, timestampStr, nonce, ...hmacParts] = parts;
    const hmacHex = hmacParts.join('.');
    if (!timestampStr || !nonce || !hmacHex) return null;

    // 4. Timestamp freshness.
    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp)) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - timestamp > MAX_STALENESS_SEC) return null;

    // 5. Reconstruct the signing message from the request fields.
    //    We need: method, path, profile, endUser, bodyHash, runId, depth, timestamp, nonce.
    //    These are embedded in the HMAC — depth and runId are part of the signed data.
    //    To verify we need to try ALL possible depth values (0 and 1).
    //    We also read the body hash from the actual body.
    const method = req.method ?? 'POST';
    const path = (req.originalUrl || `${req.baseUrl ?? ''}${req.path ?? '/'}`).split('?')[0]!;
    const profile = typeof req.headers['x-profile'] === 'string' ? req.headers['x-profile'] : '';
    const endUser = typeof req.headers['x-end-user'] === 'string' ? req.headers['x-end-user'] : '';
    const runId = typeof req.headers['x-run-id'] === 'string' ? req.headers['x-run-id'] : '';

    // Body hash: use the already-parsed body or the raw body.
    const bodyJson = req.body !== undefined && req.body !== null
      ? JSON.stringify(req.body)
      : '';
    const bodyHash = sha256hex(bodyJson);

    // Try depth 0 and 1 (depth is embedded in the signed message).
    let verifiedDepth: number | null = null;
    for (const candidateDepth of [0, 1]) {
      const msg = signingMessage({
        method,
        path,
        profile,
        endUser,
        bodyHash,
        runId,
        depth: candidateDepth,
        timestamp: timestampStr,
        nonce,
      });
      const expected = hmacSha256hex(_KEY, msg);
      if (expected.length !== hmacHex.length) continue;
      const expectedBuf = Buffer.from(expected, 'hex');
      const providedBuf = Buffer.from(hmacHex, 'hex');
      if (expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
        verifiedDepth = candidateDepth;
        break;
      }
    }

    if (verifiedDepth === null) return null;

    // 6. Reject if depth > MAX_DEPTH (recursion guard).
    if (verifiedDepth > MAX_DEPTH) return null;

    return {
      depth: verifiedDepth,
      ...(runId ? { runId } : {}),
    };
  } catch {
    return null;
  }
}

// ── Exported: callGateway ────────────────────────────────────────────────────

/**
 * Call `/v1/chat/completions` on the same server instance.
 * Uses a loopback address and the server socket's localPort, never Host or X-Forwarded headers.
 * Throws `GatewayCallError` on non-2xx responses.
 */
export async function callGateway(
  req: Request,
  body: LoopbackRequest,
): Promise<{ message: ChatMessage; finishReason: string; usage: Usage; servedModel: string }> {
  const outDepth = body.depth + 1;
  if (!Number.isInteger(body.depth) || body.depth < 0 || outDepth > MAX_DEPTH) {
    throw new GatewayCallError(400, 'max_depth_exceeded');
  }

  // Build request body — non-streaming.
  const reqBody: Record<string, unknown> = {
    model: body.model,
    messages: body.messages,
    stream: false,
  };
  if (body.tools?.length) reqBody['tools'] = body.tools;
  if (body.maxTokens != null) reqBody['max_tokens'] = body.maxTokens;
  const bodyJson = JSON.stringify(reqBody);

  // Stay on loopback even when the incoming socket was addressed through a LAN IP.
  const localAddr = req.socket?.localAddress?.includes(':') && !req.socket.localAddress.startsWith('::ffff:')
    ? '::1' : '127.0.0.1';
  const localPort = req.socket?.localPort ?? 80;
  const path = '/v1/chat/completions';

  // Credential: re-use the caller's own API key (never elevate).
  const callerToken = extractInferenceToken({ headers: req.headers,
    originalUrl: req.originalUrl ?? req.url ?? req.path ?? '', query: req.query ?? {} } as Request);
  const authHeader = callerToken ? `Bearer ${callerToken}` : '';

  // Profile/end-user headers for HMAC.
  const profile = typeof req.headers['x-profile'] === 'string' ? req.headers['x-profile'] : '';
  const endUser = typeof req.headers['x-end-user'] === 'string' ? req.headers['x-end-user'] : '';

  // Build the internal header.
  const internalHeader = buildHeader({
    method: 'POST',
    path,
    profile,
    endUser,
    bodyJson,
    runId: body.runId,
    depth: outDepth,
  });

  const headers: Record<string, string | number> = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(bodyJson),
    [HEADER_NAME]: internalHeader,
  };
  if (authHeader) headers['authorization'] = authHeader;
  if (body.runId) headers['x-run-id'] = body.runId;
  // Propagate profile/end-user so isInternalCall can reconstruct the message.
  if (profile) headers['x-profile'] = profile;
  if (endUser) headers['x-end-user'] = endUser;

  return new Promise<{ message: ChatMessage; finishReason: string; usage: Usage; servedModel: string }>(
    (resolve, reject) => {
      let settled = false;

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        reject(err);
      }

      const outReq = http.request(
        {
          hostname: localAddr,
          port: localPort,
          path,
          method: 'POST',
          headers,
          // Explicitly not following redirects
          family: localAddr.includes(':') && !localAddr.startsWith('::ffff:') ? 6 : 4,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            const statusCode = res.statusCode ?? 0;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (statusCode < 200 || statusCode >= 300) {
              let code = 'gateway_error';
              try {
                const parsed = JSON.parse(raw) as { error?: { code?: string; type?: string } };
                code = parsed.error?.code ?? parsed.error?.type ?? code;
              } catch { /* ignore */ }
              reject(new GatewayCallError(statusCode, code));
              return;
            }
            try {
              const parsed = JSON.parse(raw) as {
                choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
                usage?: Usage;
                model?: string;
                _routed_via?: { model?: string };
              };
              const choice = parsed.choices?.[0];
              if (!choice?.message) {
                reject(new GatewayCallError(502, 'invalid_response'));
                return;
              }
              resolve({
                message: choice.message,
                finishReason: choice.finish_reason ?? 'stop',
                usage: parsed.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                servedModel: parsed._routed_via?.model ?? parsed.model ?? body.model,
              });
            } catch {
              reject(new GatewayCallError(502, 'parse_error'));
            }
          });
          res.on('error', fail);
        },
      );

      outReq.on('error', fail);

      // Respect abort signal.
      if (body.signal.aborted) {
        outReq.destroy();
        fail(new GatewayCallError(499, 'aborted'));
        return;
      }
      const onAbort = () => {
        outReq.destroy();
        fail(new GatewayCallError(499, 'aborted'));
      };
      body.signal.addEventListener('abort', onAbort, { once: true });
      outReq.on('close', () => body.signal.removeEventListener('abort', onAbort));

      outReq.write(bodyJson);
      outReq.end();
    },
  );
}
