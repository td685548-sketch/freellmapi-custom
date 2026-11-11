import type { ReadableStreamReadResult } from 'node:stream/web';
import { proxyFetch } from '../../lib/proxy.js';

export async function readSubscriptionChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 120_000): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([reader.read(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error('Provider stream timed out while waiting for data.')); }, timeoutMs > 0 ? timeoutMs : 120_000);
      timer.unref?.();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function readSubscriptionJson(response: Response): Promise<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 1_048_576) throw new Error('Provider response exceeded its size limit.');
      chunks.push(chunk.value);
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Provider returned malformed JSON.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider response.');
    return data;
  } finally { await reader.cancel().catch(() => {}); }
}

export async function subscriptionRequest(url: string, body: unknown, signal?: AbortSignal): Promise<{ response: Response; data: Record<string, any> }> {
  const response = await proxyFetch(url, {
    method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
  }, 'custom', 'unknown');
  const data = await readSubscriptionJson(response);
  return { response, data };
}

/** Bounded SSE parsing including split UTF-8, CRLF, multi-line data and EOF. */
export async function* subscriptionEvents(response: Response, timeoutMs = 120_000): AsyncGenerator<Record<string, any>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Provider returned an empty stream.');
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  const parse = () => {
    const raw = data.join('\n'); data = [];
    if (!raw || raw === '[DONE]') return null;
    try { return JSON.parse(raw) as Record<string, any>; }
    catch { throw new Error('Provider returned malformed stream data.'); }
  };
  try {
    while (true) {
      const chunk = await readSubscriptionChunk(reader, timeoutMs);
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      if (pending.length + data.join('').length > 4_194_304) throw new Error('Provider stream event exceeded its size limit.');
      if (chunk.done && pending && !pending.endsWith('\n')) pending += '\n';
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        if (line === '') { const event = parse(); if (event) yield event; }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (chunk.done) { const event = parse(); if (event) yield event; break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
