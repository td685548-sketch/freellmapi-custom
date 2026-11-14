import { StringDecoder } from 'node:string_decoder';
import type { Request, Response } from 'express';
import type { Wire } from './detect.js';
import { geminiArrayItems, geminiItemText, rewriteGeminiArray, rewriteResponsesFrame } from './stream-payload.js';

export interface OutputFilter {
  name: string;
  onDelta?(text: string): { emit: string; stop?: { replacement: string; reason: string } };
  onComplete?(
    full: string,
  ): Promise<{ replaceWith?: string; reason?: string }> | { replaceWith?: string; reason?: string };
  onUsage?(usage: unknown): void;
  buffering?: boolean;
  failClosed?: boolean;
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractUsageFromJson(wire: Wire, obj: Record<string, unknown>): unknown {
  if (wire === 'openai-chat') return obj.usage;
  if (wire === 'anthropic') {
    if (obj.usage !== undefined) return obj.usage;
    const msg = asRecord(obj.message);
    return msg?.usage;
  }
  if (wire === 'responses') {
    if (obj.usage !== undefined) return obj.usage;
    const resp = asRecord(obj.response);
    return resp?.usage;
  }
  if (wire === 'gemini') return obj.usageMetadata;
  return undefined;
}

function extractNonStreamText(wire: Wire, body: Record<string, unknown>): string | null {
  if (wire === 'openai-chat') {
    const choices = Array.isArray(body.choices) ? body.choices : null;
    const first = choices ? asRecord(choices[0]) : null;
    const msg = first ? asRecord(first.message) : null;
    return typeof msg?.content === 'string' ? msg.content : null;
  }
  if (wire === 'anthropic') {
    const content = Array.isArray(body.content) ? body.content : null;
    if (!content) return null;
    const parts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    return parts.length > 0 ? parts.join('') : null;
  }
  if (wire === 'responses') {
    if (typeof body.output_text === 'string') return body.output_text;
    const output = Array.isArray(body.output) ? body.output : null;
    if (!output) return null;
    for (const item of output) {
      const it = asRecord(item);
      if (it?.type === 'message' && Array.isArray(it.content)) {
        const parts = it.content
          .map((c) => asRecord(c))
          .filter((c): c is Record<string, unknown> => Boolean(c && c.type === 'output_text' && typeof c.text === 'string'))
          .map((c) => c.text as string);
        if (parts.length > 0) return parts.join('');
      }
    }
    return null;
  }
  if (wire === 'gemini') {
    const candidates = Array.isArray(body.candidates) ? body.candidates : null;
    const first = candidates ? asRecord(candidates[0]) : null;
    const content = first ? asRecord(first.content) : null;
    const parts = content && Array.isArray(content.parts) ? content.parts : null;
    if (!parts) return null;
    const texts: string[] = [];
    for (const p of parts) {
      const part = asRecord(p);
      if (part && part.thought !== true && typeof part.text === 'string') texts.push(part.text);
    }
    return texts.length > 0 ? texts.join('') : null;
  }
  return null;
}

function replaceNonStreamText(
  wire: Wire,
  body: Record<string, unknown>,
  newText: string,
  blocked: boolean,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };
  if (wire === 'openai-chat') {
    const choices = Array.isArray(body.choices) ? [...body.choices] : [];
    const first = asRecord(choices[0]) ?? { index: 0, message: { role: 'assistant', content: '' } };
    const msg = asRecord(first.message) ?? { role: 'assistant' };
    choices[0] = {
      ...first,
      message: { ...msg, content: newText },
      ...(blocked ? { finish_reason: 'content_filter' } : {}),
    };
    clone.choices = choices;
    return clone;
  }
  if (wire === 'anthropic') {
    const content = Array.isArray(body.content) ? [...body.content] : [];
    const nonText = content.filter((b) => asRecord(b)?.type !== 'text');
    clone.content = [{ type: 'text', text: newText }, ...nonText];
    if (blocked) clone.stop_reason = 'refusal';
    return clone;
  }
  if (wire === 'responses') {
    clone.output_text = newText;
    const output = Array.isArray(body.output) ? [...body.output] : [];
    const msgIdx = output.findIndex((o) => asRecord(o)?.type === 'message');
    const msgItem = msgIdx >= 0 ? asRecord(output[msgIdx]) : null;
    const updatedItem = {
      ...(msgItem ?? { type: 'message', id: 'msg_intercepted', role: 'assistant' }),
      status: blocked ? 'incomplete' : (msgItem?.status ?? 'completed'),
      content: [{ type: 'output_text', text: newText, annotations: [] }],
    };
    if (msgIdx >= 0) output[msgIdx] = updatedItem;
    else output.unshift(updatedItem);
    clone.output = output;
    if (blocked) {
      clone.status = 'incomplete';
      clone.incomplete_details = { reason: 'content_filter' };
    }
    return clone;
  }
  // gemini
  const candidates = Array.isArray(body.candidates) ? [...body.candidates] : [];
  const first = asRecord(candidates[0]) ?? { index: 0, content: { role: 'model', parts: [] } };
  const content = asRecord(first.content) ?? { role: 'model', parts: [] };
  candidates[0] = {
    ...first,
    content: { ...content, parts: [{ text: newText }] },
    ...(blocked ? { finishReason: 'SAFETY' } : {}),
  };
  clone.candidates = candidates;
  return clone;
}

function extractStreamDelta(
  wire: Wire,
  obj: Record<string, unknown>,
): { text: string | null; setText: (next: string) => void } {
  if (wire === 'openai-chat') {
    const choices = Array.isArray(obj.choices) ? obj.choices : null;
    const first = choices ? asRecord(choices[0]) : null;
    const delta = first ? asRecord(first.delta) : null;
    if (delta && typeof delta.content === 'string') {
      return {
        text: delta.content,
        setText: (next: string) => {
          delta.content = next;
        },
      };
    }
    return { text: null, setText: () => {} };
  }
  if (wire === 'anthropic') {
    if (obj.type === 'content_block_delta') {
      const delta = asRecord(obj.delta);
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        return {
          text: delta.text,
          setText: (next: string) => {
            delta.text = next;
          },
        };
      }
    }
    return { text: null, setText: () => {} };
  }
  if (wire === 'responses') {
    if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
      return {
        text: obj.delta,
        setText: (next: string) => {
          obj.delta = next;
        },
      };
    }
    return { text: null, setText: () => {} };
  }
  if (wire === 'gemini') {
    const candidates = Array.isArray(obj.candidates) ? obj.candidates : null;
    const first = candidates ? asRecord(candidates[0]) : null;
    const content = first ? asRecord(first.content) : null;
    const parts = content && Array.isArray(content.parts) ? content.parts : null;
    if (parts) {
      for (const p of parts) {
        const part = asRecord(p);
        if (part && part.thought !== true && typeof part.text === 'string') {
          return {
            text: part.text,
            setText: (next: string) => {
              part.text = next;
            },
          };
        }
      }
    }
    return { text: null, setText: () => {} };
  }
  return { text: null, setText: () => {} };
}

function buildStreamStopFrames(wire: Wire, replacement: string, model: string): string {
  if (wire === 'openai-chat') {
    const out: string[] = [];
    if (replacement.length > 0) {
      out.push(
        `data: ${JSON.stringify({
          id: 'chatcmpl-guard',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { content: replacement }, finish_reason: null }],
        })}\n\n`,
      );
    }
    out.push(
      `data: ${JSON.stringify({
        id: 'chatcmpl-guard',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
      })}\n\n`,
    );
    out.push('data: [DONE]\n\n');
    return out.join('');
  }
  if (wire === 'anthropic') {
    const out: string[] = [];
    if (replacement.length > 0) {
      out.push(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: replacement },
        })}\n\n`,
      );
    }
    out.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null },
        usage: { output_tokens: 0 },
      })}\n\n`,
    );
    out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    return out.join('');
  }
  if (wire === 'responses') {
    const out: string[] = [];
    if (replacement.length > 0) {
      out.push(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: 'response.output_text.delta',
          item_id: 'msg_guard',
          output_index: 0,
          content_index: 0,
          delta: replacement,
        })}\n\n`,
      );
    }
    out.push(
      `event: response.incomplete\ndata: ${JSON.stringify({
        type: 'response.incomplete',
        response: {
          id: 'resp_guard',
          object: 'response',
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
          model,
          output_text: replacement,
        },
      })}\n\n`,
    );
    return out.join('');
  }
  // gemini
  const out: string[] = [];
  if (replacement.length > 0) {
    out.push(
      `data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: replacement }] }, index: 0 }],
      })}\n\n`,
    );
  }
  out.push(
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY', index: 0 }],
    })}\n\n`,
  );
  return out.join('');
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk ?? ''), 'utf8');
}

/**
 * Installs a protocol-aware response interceptor on `res` for the given filters.
 * When `filters` is empty, returns immediately without modifying `res`.
 */
export function installInterceptor(_req: Request, res: Response, wire: Wire, filters: OutputFilter[]): void {
  if (filters.length === 0) return;

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origJson = res.json.bind(res);
  let sendingJson = false;
  const sendJson = (body: unknown): Response => {
    sendingJson = true;
    try { return origJson(body); }
    finally { sendingJson = false; }
  };

  const anyFailClosed = filters.some((f) => f.failClosed === true);
  const anyBuffering = filters.some((f) => f.buffering === true);

  let closed = false;
  let stopped = false;
  let finalized = false;

  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
    }
  });

  const runOnCompleteChain = async (initialText: string): Promise<{ text: string; blocked: boolean }> => {
    let text = initialText;
    let blocked = false;
    for (const filter of filters) {
      if (closed) return { text, blocked };
      if (!filter.onComplete) continue;
      const result = await filter.onComplete(text);
      if (closed) return { text, blocked };
      if (result.replaceWith !== undefined) {
        text = result.replaceWith;
        if (result.reason) blocked = true;
      }
    }
    return { text, blocked };
  };

  res.json = ((body: unknown): Response => {
    const obj = asRecord(body);
    if (!obj) {
      if (anyFailClosed) {
        return sendJson(replaceNonStreamText(wire, {}, '', true));
      }
      return sendJson(body);
    }

    try {
      const usage = extractUsageFromJson(wire, obj);
      if (usage !== undefined) {
        for (const f of filters) f.onUsage?.(usage);
      }

      const text = extractNonStreamText(wire, obj);
      if (text === null) {
        return sendJson(body);
      }

      let currentText = text;
      let blocked = false;
      for (const f of filters) {
        if (!f.onDelta) continue;
        const deltaRes = f.onDelta(currentText);
        if (deltaRes.stop) {
          currentText = deltaRes.stop.replacement;
          blocked = true;
          break;
        }
        currentText = deltaRes.emit;
      }

      const hasComplete = !blocked && filters.some((f) => Boolean(f.onComplete));
      if (!hasComplete) {
        if (!blocked && currentText === text) return sendJson(body);
        return sendJson(replaceNonStreamText(wire, obj, currentText, blocked));
      }

      void runOnCompleteChain(currentText)
        .then(({ text: finalText, blocked: completeBlocked }) => {
          if (closed) return;
          const isBlocked = blocked || completeBlocked;
          if (!isBlocked && finalText === text) {
            sendJson(body);
          } else {
            sendJson(replaceNonStreamText(wire, obj, finalText, isBlocked));
          }
        })
        .catch(() => {
          if (closed) return;
          if (anyFailClosed) {
            sendJson(replaceNonStreamText(wire, obj, '', true));
          } else {
            sendJson(body);
          }
        });
      return res;
    } catch {
      if (anyFailClosed) {
        return sendJson(replaceNonStreamText(wire, {}, '', true));
      }
      return sendJson(body);
    }
  }) as Response['json'];

  const decoder = new StringDecoder('utf8');
  let sseBuffer = '';
  let bufferedText = '';
  let bufferedTextBytes = 0;
  let lastModel = '';
  const pendingFrames: Array<{ raw: string; delta: boolean }> = [];
  let geminiJson = false;
  let passThrough = false;
  let pendingBytes = 0;

  const frameData = (frame: string): Record<string, unknown> => JSON.parse(frame.split(/\r?\n/)
    .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
  const withDelta = (frame: string, text: string): string => {
    const obj = frameData(frame);
    extractStreamDelta(wire, obj).setText(text);
    return frame.split(/\r?\n/).filter(line => !line.startsWith('data:'))
      .concat(`data: ${JSON.stringify(obj)}`).join('\n');
  };
  const detectGeminiJson = (): boolean => {
    if (wire === 'gemini' && sseBuffer.trimStart().startsWith('[')) geminiJson = true;
    return geminiJson;
  };
  const finishGeminiJson = async (): Promise<void> => {
    const items = geminiArrayItems(sseBuffer);
    let text = '';
    let textBytes = 0;
    let blocked = false;
    for (const item of items) {
      const usage = extractUsageFromJson('gemini', item);
      if (usage !== undefined) for (const filter of filters) filter.onUsage?.(usage);
      if (blocked) continue;
      let emitted = geminiItemText(item);
      for (const filter of filters) {
        if (!filter.onDelta) continue;
        const result = filter.onDelta(emitted);
        if (result.stop) { text = result.stop.replacement; textBytes = Buffer.byteLength(text); blocked = true; break; }
        emitted = result.emit;
      }
      if (!blocked) { text += emitted; textBytes += Buffer.byteLength(emitted); }
      if (textBytes > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
    }
    if (!blocked) {
      const result = await runOnCompleteChain(text);
      text = result.text; blocked = result.blocked;
    }
    if (Buffer.byteLength(text) > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
    if (!closed) origEnd(rewriteGeminiArray(items, text, blocked));
  };

  const processFrame = (rawFrame: string): string | null => {
    if (stopped || closed) return null;
    try {
      if (anyBuffering) {
        pendingBytes += Buffer.byteLength(rawFrame) + 2;
        if (pendingBytes > MAX_BUFFER_BYTES) throw new Error('Stream buffer limit exceeded');
      }
      const lines = rawFrame.split(/\r?\n/);
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }
      if (dataLines.length === 0) {
        if (anyFailClosed && rawFrame.split(/\r?\n/).some(line => line.trim()
          && !/^(?:event:|id:|retry:|:)/.test(line))) throw new Error('Invalid SSE framing');
        if (anyBuffering) { pendingFrames.push({ raw: rawFrame, delta: false }); return null; }
        return `${rawFrame}\n\n`;
      }
      const payloadStr = dataLines.join('\n').trim();
      if (payloadStr === '[DONE]') {
        if (anyBuffering) pendingFrames.push({ raw: rawFrame, delta: false });
        return anyBuffering ? null : `${rawFrame}\n\n`;
      }

      const parsed: unknown = JSON.parse(payloadStr);

      const obj = asRecord(parsed);
      if (!obj) {
        throw new Error('Invalid SSE object');
      }

      if (typeof obj.model === 'string') lastModel = obj.model;
      else if (typeof obj.modelVersion === 'string') lastModel = obj.modelVersion;
      else if (typeof asRecord(obj.response)?.model === 'string') lastModel = asRecord(obj.response)!.model as string;

      const usage = extractUsageFromJson(wire, obj);
      if (usage !== undefined) {
        for (const f of filters) f.onUsage?.(usage);
      }

      const { text, setText } = extractStreamDelta(wire, obj);
      if (text === null) {
        if (anyBuffering) {
          pendingFrames.push({ raw: rawFrame, delta: false });
          return null;
        }
        return `${wire === 'responses' ? rewriteResponsesFrame(rawFrame, bufferedText) : rawFrame}\n\n`;
      }

      let emitted = text;
      for (const f of filters) {
        if (!f.onDelta) continue;
        const d = f.onDelta(emitted);
        if (d.stop) {
          stopped = true;
          return buildStreamStopFrames(wire, d.stop.replacement, lastModel || 'unknown');
        }
        emitted = d.emit;
      }

      if (anyBuffering || wire === 'responses') {
        bufferedTextBytes += Buffer.byteLength(emitted);
        if (bufferedTextBytes > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
        bufferedText += emitted;
      }
      if (anyBuffering) {
        pendingFrames.push({ raw: rawFrame, delta: true });
        return null;
      }

      if (emitted === text) {
        return `${rawFrame}\n\n`;
      }
      setText(emitted);
      const rebuiltLines = lines.filter((l) => !l.startsWith('data:'));
      rebuiltLines.push(`data: ${JSON.stringify(obj)}`);
      return `${rebuiltLines.join('\n')}\n\n`;
    } catch {
      if (anyFailClosed) {
        stopped = true;
        return buildStreamStopFrames(wire, '', lastModel || 'unknown');
      }
      passThrough = true;
      return pendingFrames.map(frame => `${frame.raw}\n\n`).join('') + `${rawFrame}\n\n`;
    }
  };

  const drainSseBuffer = (flushAll: boolean): boolean => {
    let ok = true;
    const sepRe = /\r?\n\r?\n/;
    let match: RegExpExecArray | null;
    while ((match = sepRe.exec(sseBuffer)) !== null) {
      const frame = sseBuffer.slice(0, match.index);
      sseBuffer = sseBuffer.slice(match.index + match[0].length);
      const out = processFrame(frame);
      if (out !== null && !closed) {
        ok = origWrite(out) && ok;
      }
      if (passThrough) {
        if (sseBuffer) ok = origWrite(sseBuffer) && ok;
        sseBuffer = '';
        return ok;
      }
      if (stopped) {
        sseBuffer = '';
        return ok;
      }
    }
    if (flushAll && sseBuffer.trim().length > 0 && !stopped) {
      const out = processFrame(sseBuffer);
      sseBuffer = '';
      if (out !== null && !closed) {
        ok = origWrite(out) && ok;
      }
    }
    return ok;
  };

  res.write = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (sendingJson || passThrough) return origWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

    if (stopped || closed) {
      callback?.();
      return true;
    }

    const buf = toBuffer(chunk, encoding);
    if (Buffer.byteLength(sseBuffer) + buf.length > MAX_BUFFER_BYTES) {
      if (anyFailClosed) {
        stopped = true;
        origWrite(geminiJson || (wire === 'gemini' && (sseBuffer + buf.toString('utf8')).trimStart().startsWith('['))
          ? rewriteGeminiArray([], '', true) : buildStreamStopFrames(wire, '', lastModel || 'unknown'));
        callback?.();
        return true;
      }
      for (const frame of pendingFrames) origWrite(`${frame.raw}\n\n`);
      if (sseBuffer) origWrite(sseBuffer);
      sseBuffer = '';
      passThrough = true;
      const ok = origWrite(buf);
      callback?.();
      return ok;
    }

    sseBuffer += decoder.write(buf);
    if (detectGeminiJson()) { callback?.(); return true; }
    const ok = drainSseBuffer(false);
    callback?.();
    return ok;
  }) as Response['write'];

  res.end = ((
    chunk?: unknown,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): Response => {
    if (sendingJson || passThrough) return origEnd(chunk as string, encodingOrCb as BufferEncoding, cb);
    let actualChunk: unknown;
    let encoding: BufferEncoding | undefined;
    let callback: (() => void) | undefined;

    if (typeof chunk === 'function') {
      callback = chunk as () => void;
    } else {
      actualChunk = chunk;
      if (typeof encodingOrCb === 'function') {
        callback = encodingOrCb;
      } else {
        encoding = encodingOrCb;
        callback = cb;
      }
    }

    if (finalized) {
      callback?.();
      return res;
    }
    finalized = true;

    if (actualChunk !== undefined && !stopped && !closed) {
      const buf = toBuffer(actualChunk, encoding);
      if (Buffer.byteLength(sseBuffer) + buf.length > MAX_BUFFER_BYTES) {
        const arrayFormat = geminiJson || (wire === 'gemini' && (sseBuffer + buf.toString('utf8')).trimStart().startsWith('['));
        const output = anyFailClosed
          ? (arrayFormat ? rewriteGeminiArray([], '', true) : buildStreamStopFrames(wire, '', lastModel || 'unknown'))
          : Buffer.concat([Buffer.from(pendingFrames.map(frame => `${frame.raw}\n\n`).join('') + sseBuffer), buf]);
        origEnd(output); callback?.(); return res;
      }
      sseBuffer += decoder.write(buf);
    }
    sseBuffer += decoder.end();

    if (!stopped && !closed && detectGeminiJson()) {
      void finishGeminiJson().catch(() => {
        if (!closed) origEnd(anyFailClosed ? rewriteGeminiArray([], '', true) : sseBuffer);
      }).finally(() => callback?.());
      return res;
    }

    if (!stopped && !closed) {
      drainSseBuffer(true);
    }

    if (passThrough) { origEnd(); callback?.(); return res; }

    if (stopped || closed) {
      if (!closed) origEnd();
      callback?.();
      return res;
    }

    if (anyBuffering) {
      void runOnCompleteChain(bufferedText)
        .then(({ text: finalText, blocked }) => {
          if (closed) return;
          if (Buffer.byteLength(finalText) > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
          if (blocked) {
            origWrite(buildStreamStopFrames(wire, finalText, lastModel || 'unknown'));
          } else {
            let emitted = false;
            for (const frame of pendingFrames) {
              if (frame.delta) {
                if (!emitted) origWrite(`${withDelta(frame.raw, finalText)}\n\n`);
                emitted = true;
              } else {
                origWrite(`${wire === 'responses' ? rewriteResponsesFrame(frame.raw, finalText) : frame.raw}\n\n`);
              }
            }
          }
          origEnd();
          callback?.();
        })
        .catch(() => {
          if (closed) return;
          if (anyFailClosed) {
            origWrite(buildStreamStopFrames(wire, '', lastModel || 'unknown'));
          }
          origEnd();
          callback?.();
        });
      return res;
    }

    origEnd();
    callback?.();
    return res;
  }) as Response['end'];
}
