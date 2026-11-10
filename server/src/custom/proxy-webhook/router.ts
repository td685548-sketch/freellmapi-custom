import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { maskProxyUrl } from '../../lib/key-proxy.js';
import { probeProxyUrl } from '../../lib/proxy.js';
import {
  listProxyPool,
  recordProxyTestResult,
  updateProxyWebhookUrl,
  type ProxyPoolEntry,
} from '../x-gateway/proxy-pool.js';

export const proxyWebhookRouter = Router();

/**
 * Constant-time string equality check to prevent timing attacks.
 */
export function constantTimeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function redactProbeError(error: string | undefined): string {
  if (!error) return 'Proxy unreachable or refused the connection.';
  return error.replace(/([\w.%-]+):([^\s@/]+)@/g, '$1:***@');
}

/**
 * MiProxy Webhook Endpoint:
 * POST /api/proxy-webhook?token=...
 *
 * Receives dynamic proxy URL updates from the Android MiProxy app,
 * updates the corresponding proxy pool entry, and probes the new connection.
 */
proxyWebhookRouter.post('/', async (req: Request, res: Response) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    return res.status(401).json({
      error: { message: 'Missing token in query parameter (?token=...)', code: 'unauthorized' },
    });
  }

  // 1. Resolve matching target proxy
  const allEntries = listProxyPool();
  let matchedEntry: ProxyPoolEntry | undefined;

  // A. Check against individual proxy entries with webhookEnabled and a webhookToken
  for (const entry of allEntries) {
    if (entry.webhookEnabled && entry.webhookToken && constantTimeEqual(entry.webhookToken, token)) {
      matchedEntry = entry;
      break;
    }
  }

  // B. Check against global PROXY_WEBHOOK_TOKEN environment variable
  const globalToken = process.env.PROXY_WEBHOOK_TOKEN?.trim();
  if (!matchedEntry && globalToken && constantTimeEqual(globalToken, token)) {
    const queryId = req.query.id ? Number(req.query.id) : undefined;
    const queryTarget = typeof req.query.target === 'string' ? req.query.target.trim() : undefined;
    const envTarget = process.env.PROXY_WEBHOOK_TARGET_NAME?.trim();

    if (queryId && Number.isSafeInteger(queryId)) {
      matchedEntry = allEntries.find(e => e.id === queryId);
    } else if (queryTarget) {
      matchedEntry = allEntries.find(e => e.name.toLowerCase() === queryTarget.toLowerCase());
    } else if (envTarget) {
      matchedEntry = allEntries.find(e => e.name.toLowerCase() === envTarget.toLowerCase());
    } else {
      // Fallback: pick first entry with webhook enabled, or the first pool entry
      matchedEntry = allEntries.find(e => e.webhookEnabled) ?? allEntries[0];
    }
  }

  if (!matchedEntry) {
    if (globalToken && constantTimeEqual(globalToken, token)) {
      return res.status(404).json({
        error: { message: 'Target proxy entry not found', code: 'not_found' },
      });
    }
    return res.status(401).json({
      error: { message: 'Invalid token', code: 'unauthorized' },
    });
  }

  // 2. Validate request body
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({
      error: { message: 'Invalid JSON body', code: 'invalid_body' },
    });
  }

  const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
  if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
    return res.status(400).json({
      error: { message: 'Proxy URL must start with http:// or https://', code: 'invalid_url' },
    });
  }

  try {
    const parsed = new URL(rawUrl);
    if (!parsed.hostname) {
      return res.status(400).json({
        error: { message: 'Proxy URL hostname is invalid', code: 'invalid_url' },
      });
    }
  } catch {
    return res.status(400).json({
      error: { message: 'Malformed proxy URL', code: 'invalid_url' },
    });
  }

  let timestamp = Date.now();
  if (body.timestamp !== undefined) {
    const num = Number(body.timestamp);
    if (isNaN(num) || num <= 0) {
      return res.status(400).json({
        error: { message: 'Invalid timestamp', code: 'invalid_timestamp' },
      });
    }
    timestamp = num;
  }

  const type = typeof body.type === 'string' ? body.type : 'manual';

  // 3. Anti-overwrite check: ignore if timestamp is older than last_webhook_at
  if (matchedEntry.lastWebhookAt && timestamp < matchedEntry.lastWebhookAt) {
    console.log(
      `[ProxyWebhook] Ignored outdated payload (ts: ${timestamp} < last: ${matchedEntry.lastWebhookAt}) for proxy #${matchedEntry.id} (${matchedEntry.name})`,
    );
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: 'Outdated timestamp',
      id: matchedEntry.id,
      name: matchedEntry.name,
    });
  }

  // 4. Update proxy URL in database
  const updatedEntry = updateProxyWebhookUrl(matchedEntry.id, rawUrl, timestamp);
  console.log(
    `[ProxyWebhook] Updated proxy #${matchedEntry.id} (${matchedEntry.name}): type=${type}, url=${maskProxyUrl(rawUrl)}`,
  );

  // 5. Immediate probe test (HTTP forward proxy mode)
  let testOk = false;
  let testLatency = 0;
  let testError: string | undefined;

  try {
    const probe = await probeProxyUrl(rawUrl, {
      targetUrl: 'https://www.gstatic.com/generate_204',
      timeoutMs: 10_000,
      mode: 'forward',
    });
    testOk = probe.ok;
    testLatency = probe.latencyMs;
    testError = probe.error;
  } catch (err: any) {
    testOk = false;
    testLatency = 0;
    testError = err?.message ?? String(err);
  }

  recordProxyTestResult(matchedEntry.id, testOk, testLatency, testOk ? null : redactProbeError(testError));
  console.log(
    `[ProxyWebhook] Probe test for proxy #${matchedEntry.id}: ok=${testOk}, latency=${testLatency}ms${testError ? ', error=' + testError : ''}`,
  );

  return res.status(200).json({
    ok: true,
    id: updatedEntry.id,
    name: updatedEntry.name,
    url: updatedEntry.proxyUrl,
    type,
    timestamp,
    test: {
      ok: testOk,
      latencyMs: testLatency,
      ...(testOk ? {} : { error: redactProbeError(testError) }),
    },
  });
});
