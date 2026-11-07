import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';

// POST /api/client-profiles/:id/test - send one real chat request with the profile's own key and report
// what came back. It goes through the public /v1 endpoint on this same server (over the loopback), so the
// answer shows exactly what the web's backend would get: the key check, the model list, the token cap, the
// per-minute limit, the allowances and the routed model. It spends a little of the key's allowance, so it
// needs edit_client_profiles. The key is decrypted here and never sent to the browser.

export const profileTestRouter = Router();

const TIMEOUT_MS = 30_000;
const REPLY_LIMIT = 600;

const bodySchema = z.object({
  message: z.string().trim().min(1).max(1000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  /** Ask for a streamed answer, as a chat widget would, and report how the stream behaved. */
  stream: z.boolean().optional(),
}).strict();

interface Row { encrypted_key: string; iv: string; auth_tag: string; enabled: number }

/** The address this server's own connection arrived on, as a host a client can dial back. */
function selfHost(req: Request): string {
  const address = (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
  if (!address || address === '::' || address === '0.0.0.0') return '127.0.0.1';
  return address.includes(':') ? `[${address}]` : address;
}

export interface TestResult {
  /** HTTP status the call got (0 when it could not be made at all). */
  status: number;
  ok: boolean;
  latencyMs: number;
  model: string | null;
  platform: string | null;
  reply: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error: { message: string; code: string | null; type: string | null } | null;
  /** Seconds to wait when the call was refused for rate or allowance. */
  retryAfter: number | null;
  /** Streamed tests only: time to the first text, number of data frames, and whether the stream ended properly. */
  stream: { firstTokenMs: number | null; chunks: number; finished: boolean } | null;
}

/** Read a chat-completions event stream, noting when the first text arrived. */
async function readStream(response: globalThis.Response, started: number, result: TestResult): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const stream = { firstTokenMs: null as number | null, chunks: 0, finished: false };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { stream.finished = true; continue; }
      let frame: any;
      try { frame = JSON.parse(data); } catch { continue; }
      stream.chunks += 1;
      if (frame?.error) {
        const e = frame.error;
        result.ok = false;
        result.error = { message: String(e?.message ?? e).slice(0, 500), code: typeof e?.code === 'string' ? e.code : null, type: typeof e?.type === 'string' ? e.type : null };
      }
      const delta = frame?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        if (stream.firstTokenMs === null) stream.firstTokenMs = Date.now() - started;
        text += delta;
      }
      if (typeof frame?.model === 'string') result.model = frame._routed_via?.model ?? frame.model;
      if (frame?._routed_via?.platform) result.platform = frame._routed_via.platform;
      if (frame?.usage) result.usage = { inputTokens: Number(frame.usage.prompt_tokens) || 0, outputTokens: Number(frame.usage.completion_tokens) || 0 };
    }
  }
  result.reply = text ? text.slice(0, REPLY_LIMIT) : null;
  result.stream = stream;
  if (!stream.finished && !result.error) {
    result.ok = false;
    result.error = { message: 'The stream ended without its final [DONE] frame.', code: 'stream_incomplete', type: null };
  }
}

profileTestRouter.post('/:id/test', async (req: Request, res: Response) => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) { res.status(400).json({ error: { message: 'Invalid profile id' } }); return; }
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'message is up to 1000 characters, model up to 200, stream true or false' } });
    return;
  }
  const row = getDb().prepare('SELECT encrypted_key, iv, auth_tag, enabled FROM client_profiles WHERE id = ?').get(id) as Row | undefined;
  if (!row) { res.status(404).json({ error: { message: 'Client profile not found' } }); return; }

  let key: string;
  try { key = decrypt(row.encrypted_key, row.iv, row.auth_tag); } catch {
    res.status(500).json({ error: { message: 'The stored key could not be read.' } });
    return;
  }

  const port = req.socket.localPort;
  const started = Date.now();
  const result: TestResult = { status: 0, ok: false, latencyMs: 0, model: null, platform: null, reply: null, usage: null, error: null, retryAfter: null, stream: null };
  const streamed = parsed.data.stream === true;
  try {
    const response = await fetch(`http://${selfHost(req)}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'user-agent': 'freellm-dashboard-test',
        host: `127.0.0.1:${port}`, // always on the host allowlist, whatever name the dashboard was opened by
      },
      body: JSON.stringify({
        model: parsed.data.model ?? 'auto',
        max_tokens: 64,
        ...(streamed ? { stream: true, stream_options: { include_usage: true } } : {}),
        messages: [{ role: 'user', content: parsed.data.message ?? 'Reply with one short sentence confirming you are working.' }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    result.status = response.status;
    result.ok = response.ok;
    const retry = Number(response.headers.get('retry-after'));
    result.retryAfter = Number.isFinite(retry) && retry > 0 ? retry : null;
    if (streamed && response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      await readStream(response, started, result);
      result.latencyMs = Date.now() - started;
      res.json({ result, profileEnabled: row.enabled === 1 });
      return;
    }
    const body = await response.json().catch(() => null) as any;
    result.model = body?._routed_via?.model ?? (typeof body?.model === 'string' ? body.model : null);
    result.platform = body?._routed_via?.platform ?? null;
    const content = body?.choices?.[0]?.message?.content;
    result.reply = typeof content === 'string' ? content.slice(0, REPLY_LIMIT) : null;
    if (body?.usage) result.usage = { inputTokens: Number(body.usage.prompt_tokens) || 0, outputTokens: Number(body.usage.completion_tokens) || 0 };
    if (!response.ok) {
      const e = body?.error;
      result.error = {
        message: String(typeof e === 'string' ? e : e?.message ?? `HTTP ${response.status}`).slice(0, 500),
        code: typeof e?.code === 'string' ? e.code : null,
        type: typeof e?.type === 'string' ? e.type : null,
      };
    }
  } catch (err) {
    result.error = { message: err instanceof Error && err.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} seconds.` : 'The test request could not be sent.', code: null, type: null };
  }
  result.latencyMs = Date.now() - started;
  res.json({ result, profileEnabled: row.enabled === 1 });
});
