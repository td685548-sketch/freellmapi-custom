import { StringDecoder } from 'node:string_decoder';
import type { Request, Response } from 'express';
import type { Wire } from './detect.js';
import {
  geminiArrayItems,
  geminiItemText,
  rewriteGeminiArray,
  rewriteResponsesFrame,
  type GuardTerminalMeta,
} from './stream-payload.js';

export type GuardAction = 'pass' | 'logged' | 'masked' | 'blocked';

export interface OutputFilterSink {
  emitDelta(text: string): void;
  stop(replacement: string, reason: string, action?: 'blocked'): void;
  fail(reason?: string): void;
}

export interface OutputFilter {
  name: string;
  isOutputGuard?: boolean;
  onDelta?(text: string): {
    emit: string;
    stop?: { replacement: string; reason: string; action?: 'blocked' };
    action?: GuardAction;
    reason?: string;
  };
  onBeforeTerminal?(): {
    emit: string;
    stop?: { replacement: string; reason: string; action?: 'blocked' };
    action?: GuardAction;
    reason?: string;
  };
  onComplete?(full: string):
    | Promise<{ replaceWith?: string; reason?: string; action?: GuardAction }>
    | { replaceWith?: string; reason?: string; action?: GuardAction };
  onUsage?(usage: unknown): void;
  attach?(sink: OutputFilterSink): void;
  dispose?(): void;
  buffering?: boolean;
  failClosed?: boolean;
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const installedResponses = new WeakSet<Response>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripStaleBodyHeaders(res: Response): void {
  if (res.headersSent) return;
  res.removeHeader?.('Content-Length');
  res.removeHeader?.('ETag');
}

function setGuardHeader(res: Response, value: string): void {
  if (res.headersSent) return;
  res.setHeader?.('x-freellm-guard', value);
}

function formatGuardHeader(action: GuardAction, reason?: string): string {
  if ((action === 'blocked' || action === 'masked') && reason) {
    return `${action};reason=${reason}`;
  }
  return action;
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

interface TextSlot {
  get: () => string;
  set: (next: string) => void;
}

function collectNonStreamSlots(wire: Wire, body: Record<string, unknown>): TextSlot[] {
  const slots: TextSlot[] = [];
  if (wire === 'openai-chat') {
    const choices = Array.isArray(body.choices) ? body.choices : null;
    if (!choices) return slots;
    for (const c of choices) {
      const choice = asRecord(c);
      const msg = choice ? asRecord(choice.message) : null;
      if (msg && typeof msg.content === 'string') {
        slots.push({
          get: () => msg.content as string,
          set: (next: string) => {
            msg.content = next;
          },
        });
      }
    }
    return slots;
  }
  if (wire === 'anthropic') {
    const content = Array.isArray(body.content) ? body.content : null;
    if (!content) return slots;
    for (const block of content) {
      const b = asRecord(block);
      if (b?.type === 'text' && typeof b.text === 'string') {
        slots.push({
          get: () => b.text as string,
          set: (next: string) => {
            b.text = next;
          },
        });
      }
    }
    return slots;
  }
  if (wire === 'responses') {
    if (typeof body.output_text === 'string') {
      slots.push({
        get: () => body.output_text as string,
        set: (next: string) => {
          body.output_text = next;
        },
      });
    }
    const output = Array.isArray(body.output) ? body.output : null;
    if (output) {
      for (const item of output) {
        const it = asRecord(item);
        if (it?.type === 'message' && Array.isArray(it.content)) {
          for (const c of it.content) {
            const part = asRecord(c);
            if (part && (part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
              slots.push({
                get: () => part.text as string,
                set: (next: string) => {
                  part.text = next;
                },
              });
            }
          }
        }
      }
    }
    return slots;
  }
  if (wire === 'gemini') {
    const candidates = Array.isArray(body.candidates) ? body.candidates : null;
    if (!candidates) return slots;
    for (const cand of candidates) {
      const c = asRecord(cand);
      const content = c ? asRecord(c.content) : null;
      const parts = content && Array.isArray(content.parts) ? content.parts : null;
      if (!parts) continue;
      for (const p of parts) {
        const part = asRecord(p);
        if (part && part.thought !== true && typeof part.text === 'string') {
          slots.push({
            get: () => part.text as string,
            set: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
    return slots;
  }
  return slots;
}

function extractNonStreamText(wire: Wire, body: Record<string, unknown>): string | null {
  const slots = collectNonStreamSlots(wire, body);
  if (slots.length === 0) return null;
  if (wire === 'responses' && typeof body.output_text === 'string') {
    return body.output_text;
  }
  return slots.map((s) => s.get()).join('');
}

function replaceNonStreamText(
  wire: Wire,
  body: Record<string, unknown>,
  newText: string,
  blocked: boolean,
): Record<string, unknown> {
  const clone: Record<string, unknown> = structuredClone(body);
  if (wire === 'openai-chat') {
    const choices = Array.isArray(clone.choices) ? clone.choices : [];
    if (choices.length === 0) {
      clone.choices = [{ index: 0, message: { role: 'assistant', content: newText }, ...(blocked ? { finish_reason: 'content_filter' } : {}) }];
      return clone;
    }
    for (let i = 0; i < choices.length; i++) {
      const ch = asRecord(choices[i]) ?? { index: i, message: { role: 'assistant', content: '' } };
      const msg = asRecord(ch.message) ?? { role: 'assistant' };
      choices[i] = {
        ...ch,
        message: { ...msg, content: i === 0 || blocked ? newText : (typeof msg.content === 'string' ? '' : msg.content) },
        ...(blocked ? { finish_reason: 'content_filter' } : {}),
      };
    }
    clone.choices = choices;
    return clone;
  }
  if (wire === 'anthropic') {
    const content = Array.isArray(clone.content) ? clone.content : [];
    const nonText = content.filter((b) => asRecord(b)?.type !== 'text');
    clone.content = [{ type: 'text', text: newText }, ...nonText];
    if (blocked) clone.stop_reason = 'refusal';
    return clone;
  }
  if (wire === 'responses') {
    clone.output_text = newText;
    const output = Array.isArray(clone.output) ? clone.output : [];
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
  const candidates = Array.isArray(clone.candidates) ? clone.candidates : [];
  if (candidates.length === 0) {
    clone.candidates = [{ index: 0, content: { role: 'model', parts: [{ text: newText }] }, ...(blocked ? { finishReason: 'SAFETY' } : {}) }];
    return clone;
  }
  for (let i = 0; i < candidates.length; i++) {
    const cand = asRecord(candidates[i]) ?? { index: i, content: { role: 'model', parts: [] } };
    const content = asRecord(cand.content) ?? { role: 'model', parts: [] };
    candidates[i] = {
      ...cand,
      content: { ...content, parts: [{ text: i === 0 || blocked ? newText : '' }] },
      ...(blocked ? { finishReason: 'SAFETY' } : {}),
    };
  }
  clone.candidates = candidates;
  return clone;
}

function extractStreamDelta(
  wire: Wire,
  obj: Record<string, unknown>,
): { text: string | null; setText: (next: string) => void } {
  if (wire === 'openai-chat') {
    const choices = Array.isArray(obj.choices) ? obj.choices : null;
    if (!choices) return { text: null, setText: () => {} };
    const deltas: Array<{ get: () => string; set: (v: string) => void }> = [];
    for (const c of choices) {
      const choice = asRecord(c);
      const delta = choice ? asRecord(choice.delta) : null;
      if (delta && typeof delta.content === 'string') {
        deltas.push({
          get: () => delta.content as string,
          set: (next: string) => {
            delta.content = next;
          },
        });
      }
    }
    if (deltas.length === 0) return { text: null, setText: () => {} };
    if (deltas.length === 1) {
      return { text: deltas[0]!.get(), setText: deltas[0]!.set };
    }
    return {
      text: deltas.map((d) => d.get()).join(''),
      setText: (next: string) => {
        deltas[0]!.set(next);
        for (let i = 1; i < deltas.length; i++) deltas[i]!.set('');
      },
    };
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
    if (!candidates) return { text: null, setText: () => {} };
    const textParts: Array<{ get: () => string; set: (v: string) => void }> = [];
    for (const cand of candidates) {
      const c = asRecord(cand);
      const content = c ? asRecord(c.content) : null;
      const parts = content && Array.isArray(content.parts) ? content.parts : null;
      if (!parts) continue;
      for (const p of parts) {
        const part = asRecord(p);
        if (part && part.thought !== true && typeof part.text === 'string') {
          textParts.push({
            get: () => part.text as string,
            set: (next: string) => {
              part.text = next;
            },
          });
        }
      }
    }
    if (textParts.length === 0) return { text: null, setText: () => {} };
    if (textParts.length === 1) {
      return { text: textParts[0]!.get(), setText: textParts[0]!.set };
    }
    return {
      text: textParts.map((p) => p.get()).join(''),
      setText: (next: string) => {
        textParts[0]!.set(next);
        for (let i = 1; i < textParts.length; i++) textParts[i]!.set('');
      },
    };
  }
  return { text: null, setText: () => {} };
}

function buildDeltaFrame(wire: Wire, text: string, model: string): string {
  if (wire === 'openai-chat') {
    return `data: ${JSON.stringify({
      id: 'chatcmpl-guard',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`;
  }
  if (wire === 'anthropic') {
    return `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })}\n\n`;
  }
  if (wire === 'responses') {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: 'response.output_text.delta',
      item_id: 'msg_guard',
      output_index: 0,
      content_index: 0,
      delta: text,
    })}\n\n`;
  }
  return `data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
  })}\n\n`;
}

function buildStreamStopFrames(
  wire: Wire,
  replacement: string,
  model: string,
  guardMeta?: GuardTerminalMeta,
): string {
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
        ...(guardMeta ? { guard: guardMeta } : {}),
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
        ...(guardMeta ? { guard: guardMeta } : {}),
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
        ...(guardMeta ? { guard: guardMeta } : {}),
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
      ...(guardMeta ? { guard: guardMeta } : {}),
    })}\n\n`,
  );
  return out.join('');
}

function attachGuardToTerminalFrame(frame: string, wire: Wire, guardMeta: GuardTerminalMeta): string {
  const lines = frame.split(/\r?\n/);
  const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return frame;
  const payloadStr = dataLines.join('\n').trim();
  if (!payloadStr || payloadStr === '[DONE]') return frame;
  try {
    const obj = asRecord(JSON.parse(payloadStr));
    if (!obj) return frame;
    const isTerminal =
      (wire === 'openai-chat' &&
        Array.isArray(obj.choices) &&
        obj.choices.some((c) => asRecord(c)?.finish_reason != null)) ||
      (wire === 'anthropic' && (obj.type === 'message_delta' || obj.type === 'message_stop')) ||
      (wire === 'responses' && (obj.type === 'response.completed' || obj.type === 'response.incomplete')) ||
      (wire === 'gemini' &&
        Array.isArray(obj.candidates) &&
        obj.candidates.some((c) => asRecord(c)?.finishReason != null));
    if (!isTerminal) return frame;
    obj.guard = guardMeta;
    const rebuilt = lines.filter((l) => !l.startsWith('data:'));
    rebuilt.push(`data: ${JSON.stringify(obj)}`);
    return rebuilt.join('\n');
  } catch {
    return frame;
  }
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding ?? 'utf8');
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk ?? ''), 'utf8');
}

/**
 * Installs a protocol-aware response interceptor on `res` for the given filters.
 * Idempotent per `res`. When `filters` is empty, returns immediately without modifying `res`.
 */
export function installInterceptor(_req: Request, res: Response, wire: Wire, filters: OutputFilter[]): void {
  if (filters.length === 0) return;
  if (installedResponses.has(res)) return;
  installedResponses.add(res);

  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  const origJson = res.json.bind(res);
  const origSend = typeof res.send === 'function' ? res.send.bind(res) : null;

  const hasGuardFilter = filters.some((f) => f.isOutputGuard || f.name === 'output-guard');
  const anyFailClosed = filters.some((f) => f.failClosed === true);
  const anyBuffering = filters.some((f) => f.buffering === true);

  let sendingRaw = false;
  let closed = false;
  let stopped = false;
  let finalized = false;
  let streamActiveHeaderSet = false;
  let lastModel = '';
  let guardOutcome: GuardTerminalMeta = { action: 'pass' };

  const disposeAll = () => {
    for (const f of filters) {
      try {
        f.dispose?.();
      } catch {
        // best-effort cleanup
      }
    }
  };

  const noteOutcome = (action?: GuardAction, reason?: string) => {
    if (!action || action === 'pass') return;
    if (action === 'blocked') {
      guardOutcome = { action: 'blocked', ...(reason ? { reason } : {}) };
    } else if (action === 'masked' && guardOutcome.action !== 'blocked') {
      guardOutcome = { action: 'masked', ...(reason ? { reason } : {}) };
    } else if (action === 'logged' && guardOutcome.action === 'pass') {
      guardOutcome = { action: 'logged', ...(reason ? { reason } : {}) };
    }
  };

  const sendJsonRaw = (body: unknown): Response => {
    sendingRaw = true;
    try {
      return origJson(body);
    } finally {
      sendingRaw = false;
    }
  };

  const sendRaw = (body: unknown): Response => {
    if (!origSend) return sendJsonRaw(body);
    sendingRaw = true;
    try {
      return origSend(body);
    } finally {
      sendingRaw = false;
    }
  };

  const writeRaw = (chunk: unknown, encOrCb?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean => {
    if (hasGuardFilter && !streamActiveHeaderSet && !res.headersSent) {
      setGuardHeader(res, 'active');
      streamActiveHeaderSet = true;
    }
    return origWrite(chunk as string, encOrCb as BufferEncoding, cb);
  };

  const endRaw = (chunk?: unknown, encOrCb?: BufferEncoding | (() => void), cb?: () => void): Response => {
    sendingRaw = true;
    try {
      return origEnd(chunk as string, encOrCb as BufferEncoding, cb);
    } finally {
      sendingRaw = false;
    }
  };

  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      disposeAll();
    }
  });

  // Attach async/timer emission sink to filters that support it
  const sink: OutputFilterSink = {
    emitDelta(text: string) {
      if (stopped || closed || finalized || text.length === 0) return;
      if (hasGuardFilter && !streamActiveHeaderSet && !res.headersSent) {
        setGuardHeader(res, 'active');
        streamActiveHeaderSet = true;
      }
      origWrite(buildDeltaFrame(wire, text, lastModel || 'unknown'));
    },
    stop(replacement: string, reason: string) {
      if (stopped || closed || finalized) return;
      stopped = true;
      finalized = true;
      noteOutcome('blocked', reason);
      if (hasGuardFilter && !streamActiveHeaderSet && !res.headersSent) {
        setGuardHeader(res, 'active');
        streamActiveHeaderSet = true;
      }
      origWrite(buildStreamStopFrames(wire, replacement, lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
      endRaw();
      disposeAll();
    },
    fail(reason?: string) {
      if (stopped || closed || finalized) return;
      if (anyFailClosed) {
        sink.stop('', reason ?? 'guard_failed', 'blocked');
      }
    },
  };

  for (const f of filters) {
    f.attach?.(sink);
  }

  const runOnCompleteChain = async (
    initialText: string,
  ): Promise<{ text: string; blocked: boolean; action: GuardAction; reason?: string }> => {
    let text = initialText;
    let blocked = false;
    let action: GuardAction = 'pass';
    let reason: string | undefined;
    for (const filter of filters) {
      if (closed) return { text, blocked, action, reason };
      if (!filter.onComplete) continue;
      const result = await filter.onComplete(text);
      if (closed) return { text, blocked, action, reason };
      if (result.action) {
        if (result.action === 'blocked') {
          blocked = true;
          action = 'blocked';
          reason = result.reason ?? reason;
        } else if (result.action === 'masked' && action !== 'blocked') {
          action = 'masked';
          reason = result.reason ?? reason;
        } else if (result.action === 'logged' && action === 'pass') {
          action = 'logged';
          reason = result.reason ?? reason;
        }
      }
      if (result.replaceWith !== undefined) {
        text = result.replaceWith;
        // Backward compatibility: if no explicit action was provided and reason is set, treat as blocked
        if (!result.action && result.reason) {
          blocked = true;
          action = 'blocked';
          reason = result.reason;
        }
      }
    }
    noteOutcome(action, reason);
    return { text, blocked, action, reason };
  };

  const guardNonStreamObject = (
    obj: Record<string, unknown>,
    deliver: (payload: Record<string, unknown>) => void,
    onFallbackRaw: () => void,
  ): void => {
    try {
      const usage = extractUsageFromJson(wire, obj);
      if (usage !== undefined) {
        for (const f of filters) f.onUsage?.(usage);
      }

      const text = extractNonStreamText(wire, obj);
      if (text === null) {
        if (hasGuardFilter) setGuardHeader(res, 'pass');
        onFallbackRaw();
        return;
      }

      let currentText = text;
      let blocked = false;
      let deltaAction: GuardAction = 'pass';
      let deltaReason: string | undefined;

      for (const f of filters) {
        if (!f.onDelta) continue;
        const deltaRes = f.onDelta(currentText);
        if (deltaRes.action) {
          noteOutcome(deltaRes.action, deltaRes.reason);
          if (deltaRes.action === 'masked') {
            deltaAction = 'masked';
            deltaReason = deltaRes.reason ?? deltaReason;
          } else if (deltaRes.action === 'logged' && deltaAction === 'pass') {
            deltaAction = 'logged';
            deltaReason = deltaRes.reason ?? deltaReason;
          }
        }
        if (deltaRes.stop) {
          currentText = deltaRes.stop.replacement;
          blocked = true;
          deltaAction = 'blocked';
          deltaReason = deltaRes.stop.reason;
          noteOutcome('blocked', deltaRes.stop.reason);
          break;
        }
        if (!f.onComplete || deltaRes.emit.length > 0) {
          currentText = deltaRes.emit;
        }
      }

      const hasComplete = !blocked && filters.some((f) => Boolean(f.onComplete));
      if (!hasComplete) {
        if (hasGuardFilter) {
          setGuardHeader(res, formatGuardHeader(guardOutcome.action, guardOutcome.reason ?? deltaReason));
        }
        if (!blocked && currentText === text) {
          onFallbackRaw();
          return;
        }
        stripStaleBodyHeaders(res);
        deliver(replaceNonStreamText(wire, obj, currentText, blocked));
        return;
      }

      void runOnCompleteChain(currentText)
        .then(({ text: finalText, blocked: completeBlocked }) => {
          if (closed) return;
          const isBlocked = blocked || completeBlocked;
          if (hasGuardFilter) {
            setGuardHeader(res, formatGuardHeader(guardOutcome.action, guardOutcome.reason));
          }
          if (!isBlocked && finalText === text) {
            onFallbackRaw();
          } else {
            stripStaleBodyHeaders(res);
            deliver(replaceNonStreamText(wire, obj, finalText, isBlocked));
          }
          disposeAll();
        })
        .catch(() => {
          if (closed) return;
          if (anyFailClosed) {
            if (hasGuardFilter) setGuardHeader(res, 'blocked;reason=guard_failed');
            stripStaleBodyHeaders(res);
            deliver(replaceNonStreamText(wire, obj, '', true));
          } else {
            onFallbackRaw();
          }
          disposeAll();
        });
    } catch {
      if (anyFailClosed) {
        if (hasGuardFilter) setGuardHeader(res, 'blocked;reason=guard_failed');
        stripStaleBodyHeaders(res);
        deliver(replaceNonStreamText(wire, {}, '', true));
      } else {
        onFallbackRaw();
      }
      disposeAll();
    }
  };

  res.json = ((body: unknown): Response => {
    if (sendingRaw) return origJson(body);
    if (wire === 'gemini' && Array.isArray(body)) {
      const items = body.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
      if (items.length === body.length) {
        void finishGeminiJson(items, () => sendJsonRaw(body), (rewritten) => {
          sendJsonRaw(JSON.parse(rewritten));
        }).catch(() => {
          if (!closed) {
            sendJsonRaw(anyFailClosed ? JSON.parse(rewriteGeminiArray([], '', true)) : body);
          }
          disposeAll();
        });
        return res;
      }
    }
    const obj = asRecord(body);
    if (!obj) {
      if (anyFailClosed) {
        if (hasGuardFilter) setGuardHeader(res, 'blocked;reason=invalid_json');
        stripStaleBodyHeaders(res);
        return sendJsonRaw(replaceNonStreamText(wire, {}, '', true));
      }
      return sendJsonRaw(body);
    }
    guardNonStreamObject(
      obj,
      (out) => {
        sendJsonRaw(out);
      },
      () => {
        sendJsonRaw(body);
      },
    );
    return res;
  }) as Response['json'];

  if (origSend) {
    res.send = ((body?: unknown): Response => {
      if (sendingRaw) return origSend(body);
      let parsed: unknown = body;
      if (typeof body === 'string') {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
      } else if (Buffer.isBuffer(body)) {
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          parsed = null;
        }
      }
      if (wire === 'gemini' && Array.isArray(parsed)) {
        const items = parsed.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
        if (items.length === parsed.length) {
          void finishGeminiJson(items, () => sendRaw(body), (rewritten) => {
            sendRaw(typeof body === 'string' || Buffer.isBuffer(body) ? rewritten : JSON.parse(rewritten));
          }).catch(() => {
            if (!closed) {
              const fallback = rewriteGeminiArray([], '', true);
              sendRaw(
                anyFailClosed
                  ? (typeof body === 'string' || Buffer.isBuffer(body) ? fallback : JSON.parse(fallback))
                  : body,
              );
            }
            disposeAll();
          });
          return res;
        }
      }
      const obj = asRecord(parsed);
      if (!obj) return sendRaw(body);
      guardNonStreamObject(
        obj,
        (out) => {
          sendRaw(typeof body === 'string' || Buffer.isBuffer(body) ? JSON.stringify(out) : out);
        },
        () => {
          sendRaw(body);
        },
      );
      return res;
    }) as Response['send'];
  }

  const decoder = new StringDecoder('utf8');
  let sseBuffer = '';
  let bufferedText = '';
  let bufferedTextBytes = 0;
  const pendingFrames: Array<{ raw: string; delta: boolean }> = [];
  let geminiJson = false;
  let sseStarted = false;
  let passThrough = false;
  let pendingBytes = 0;
  let terminalGuardEmitted = false;

  const detectGeminiJson = (): boolean => {
    if (!sseStarted && wire === 'gemini' && sseBuffer.trimStart().startsWith('[')) geminiJson = true;
    return geminiJson;
  };

  const finishGeminiJson = async (
    preParsedItems?: Record<string, unknown>[],
    onPassThrough?: () => void,
    onDeliver?: (rewritten: string) => void,
  ): Promise<void> => {
    const items = preParsedItems ?? geminiArrayItems(sseBuffer);
    let rawText = '';
    let text = '';
    let textBytes = 0;
    let blocked = false;
    for (const item of items) {
      const usage = extractUsageFromJson('gemini', item);
      if (usage !== undefined) for (const filter of filters) filter.onUsage?.(usage);
      if (blocked) continue;
      const itemText = geminiItemText(item);
      rawText += itemText;
      let emitted = itemText;
      for (const filter of filters) {
        if (!filter.onDelta) continue;
        const result = filter.onDelta(emitted);
        if (result.action) noteOutcome(result.action, result.reason);
        if (result.stop) {
          text = result.stop.replacement;
          textBytes = Buffer.byteLength(text);
          blocked = true;
          noteOutcome('blocked', result.stop.reason);
          break;
        }
        if (!filter.onComplete && !filter.onBeforeTerminal) {
          emitted = result.emit;
        } else if (result.emit.length > 0) {
          emitted = result.emit;
        } else {
          emitted = '';
        }
      }
      if (!blocked) {
        text += emitted;
        textBytes += Buffer.byteLength(emitted);
      }
      if (textBytes > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
    }
    if (!blocked) {
      for (const filter of filters) {
        if (!filter.onBeforeTerminal) continue;
        const termRes = filter.onBeforeTerminal();
        if (termRes.action) noteOutcome(termRes.action, termRes.reason);
        if (termRes.stop) {
          text = termRes.stop.replacement;
          blocked = true;
          noteOutcome('blocked', termRes.stop.reason);
          break;
        }
        if (termRes.emit.length > 0) {
          text += termRes.emit;
        }
      }
    }
    if (!blocked) {
      const result = await runOnCompleteChain(text || rawText);
      text = result.text;
      blocked = result.blocked;
    }
    if (Buffer.byteLength(text) > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
    if (hasGuardFilter && !res.headersSent) {
      setGuardHeader(res, 'active');
    }
    if (!closed) {
      if (!blocked && text === rawText && onPassThrough) {
        onPassThrough();
      } else {
        stripStaleBodyHeaders(res);
        const rewritten = !blocked && text === rawText && !preParsedItems
          ? sseBuffer
          : rewriteGeminiArray(items, text, blocked);
        if (onDeliver) {
          onDeliver(rewritten);
        } else {
          endRaw(rewritten);
        }
      }
    }
    disposeAll();
  };

  const processFrame = (rawFrame: string): string | null => {
    if (stopped || closed) return null;
    sseStarted = true;
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
      const flushBeforeTerminal = (): string => {
        if (anyBuffering) return '';
        let flushed = '';
        for (const f of filters) {
          if (!f.onBeforeTerminal) continue;
          const resTerm = f.onBeforeTerminal();
          if (resTerm.action) noteOutcome(resTerm.action, resTerm.reason);
          if (resTerm.stop) {
            stopped = true;
            noteOutcome('blocked', resTerm.stop.reason);
            disposeAll();
            return buildStreamStopFrames(wire, resTerm.stop.replacement, lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined);
          }
          if (resTerm.emit.length > 0) {
            flushed += buildDeltaFrame(wire, resTerm.emit, lastModel || 'unknown');
          }
        }
        return flushed;
      };

      const payloadStr = dataLines.join('\n').trim();
      if (payloadStr === '[DONE]') {
        if (anyBuffering) {
          pendingFrames.push({ raw: rawFrame, delta: false });
          return null;
        }
        const preDone = flushBeforeTerminal();
        if (stopped) return preDone;
        return `${preDone}${rawFrame}\n\n`;
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
        let frameOut = wire === 'responses' ? rewriteResponsesFrame(rawFrame, bufferedText) : rawFrame;
        let preTerm = '';
        if (hasGuardFilter && !terminalGuardEmitted) {
          const isTerm = attachGuardToTerminalFrame(frameOut, wire, guardOutcome) !== frameOut;
          if (isTerm) {
            preTerm = flushBeforeTerminal();
            if (stopped) return preTerm;
            frameOut = attachGuardToTerminalFrame(frameOut, wire, guardOutcome);
            terminalGuardEmitted = true;
          }
        }
        return `${preTerm}${frameOut}\n\n`;
      }

      let emitted = text;
      for (const f of filters) {
        if (!f.onDelta) continue;
        const d = f.onDelta(emitted);
        if (d.action) noteOutcome(d.action, d.reason);
        if (d.stop) {
          stopped = true;
          noteOutcome('blocked', d.stop.reason);
          disposeAll();
          return buildStreamStopFrames(wire, d.stop.replacement, lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined);
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
        let frameOut = rawFrame;
        if (hasGuardFilter && !terminalGuardEmitted) {
          const withGuard = attachGuardToTerminalFrame(frameOut, wire, guardOutcome);
          if (withGuard !== frameOut) {
            terminalGuardEmitted = true;
            frameOut = withGuard;
          }
        }
        return `${frameOut}\n\n`;
      }
      if (emitted.length === 0) {
        return null;
      }
      setText(emitted);
      const rebuiltLines = lines.filter((l) => !l.startsWith('data:'));
      rebuiltLines.push(`data: ${JSON.stringify(obj)}`);
      return `${rebuiltLines.join('\n')}\n\n`;
    } catch {
      if (anyFailClosed) {
        stopped = true;
        noteOutcome('blocked', 'invalid_frame');
        disposeAll();
        return buildStreamStopFrames(wire, '', lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined);
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
        ok = writeRaw(out) && ok;
      }
      if (passThrough) {
        if (sseBuffer) ok = writeRaw(sseBuffer) && ok;
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
        ok = writeRaw(out) && ok;
      }
    }
    return ok;
  };

  res.write = ((
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (sendingRaw || passThrough) return origWrite(chunk as string, encodingOrCb as BufferEncoding, cb);
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

    if (stopped || closed || finalized) {
      callback?.();
      return true;
    }

    const buf = toBuffer(chunk, encoding);
    if (Buffer.byteLength(sseBuffer) + buf.length > MAX_BUFFER_BYTES) {
      if (anyFailClosed) {
        stopped = true;
        noteOutcome('blocked', 'buffer_overflow');
        disposeAll();
        writeRaw(geminiJson || (wire === 'gemini' && (sseBuffer + buf.toString('utf8')).trimStart().startsWith('['))
          ? rewriteGeminiArray([], '', true)
          : buildStreamStopFrames(wire, '', lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
        callback?.();
        return true;
      }
      for (const frame of pendingFrames) writeRaw(`${frame.raw}\n\n`);
      if (sseBuffer) writeRaw(sseBuffer);
      sseBuffer = '';
      passThrough = true;
      const ok = writeRaw(buf);
      callback?.();
      return ok;
    }

    sseBuffer += decoder.write(buf);
    if (detectGeminiJson()) { callback?.(); return true; }
    // If not SSE yet (no double newline and doesn't start with data:/event:/comment), wait for end() in case it's non-stream JSON
    if (!sseStarted && !/\r?\n\r?\n/.test(sseBuffer) && sseBuffer.trimStart().startsWith('{')) {
      callback?.();
      return true;
    }
    const ok = drainSseBuffer(false);
    callback?.();
    return ok;
  }) as Response['write'];

  res.end = ((
    chunk?: unknown,
    encodingOrCb?: BufferEncoding | (() => void),
    cb?: () => void,
  ): Response => {
    if (sendingRaw || passThrough) return origEnd(chunk as string, encodingOrCb as BufferEncoding, cb);
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
          ? (arrayFormat ? rewriteGeminiArray([], '', true) : buildStreamStopFrames(wire, '', lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined))
          : Buffer.concat([Buffer.from(pendingFrames.map(frame => `${frame.raw}\n\n`).join('') + sseBuffer), buf]);
        disposeAll();
        endRaw(output);
        callback?.();
        return res;
      }
      sseBuffer += decoder.write(buf);
    }
    sseBuffer += decoder.end();

    // Handle non-stream JSON sent via res.end(JSON.stringify(obj))
    if (!stopped && !closed && !sseStarted && !detectGeminiJson() && sseBuffer.trimStart().startsWith('{')) {
      let parsedObj: Record<string, unknown> | null = null;
      try {
        parsedObj = asRecord(JSON.parse(sseBuffer));
      } catch {
        parsedObj = null;
      }
      if (parsedObj) {
        guardNonStreamObject(
          parsedObj,
          (out) => {
            endRaw(JSON.stringify(out), callback);
          },
          () => {
            endRaw(sseBuffer, callback);
          },
        );
        return res;
      }
    }

    if (!stopped && !closed && detectGeminiJson()) {
      void finishGeminiJson().catch(() => {
        if (!closed) endRaw(anyFailClosed ? rewriteGeminiArray([], '', true) : sseBuffer);
        disposeAll();
      }).finally(() => callback?.());
      return res;
    }

    if (!stopped && !closed) {
      drainSseBuffer(true);
    }

    if (passThrough) { disposeAll(); endRaw(); callback?.(); return res; }

    if (stopped || closed) {
      disposeAll();
      if (!closed) endRaw();
      callback?.();
      return res;
    }

    if (anyBuffering) {
      void runOnCompleteChain(bufferedText)
        .then(({ text: finalText, blocked }) => {
          if (closed) return;
          if (Buffer.byteLength(finalText) > MAX_BUFFER_BYTES) throw new Error('Filtered stream exceeds buffer limit');
          if (blocked) {
            writeRaw(buildStreamStopFrames(wire, finalText, lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
          } else {
            let emitted = false;
            for (const frame of pendingFrames) {
              if (frame.delta) {
                if (!emitted) writeRaw(`${buildDeltaFrame(wire, finalText, lastModel || 'unknown')}`);
                emitted = true;
              } else {
                let rawOut = wire === 'responses' ? rewriteResponsesFrame(frame.raw, finalText) : frame.raw;
                if (hasGuardFilter && !terminalGuardEmitted) {
                  const withGuard = attachGuardToTerminalFrame(rawOut, wire, guardOutcome);
                  if (withGuard !== rawOut) {
                    terminalGuardEmitted = true;
                    rawOut = withGuard;
                  }
                }
                writeRaw(`${rawOut}\n\n`);
              }
            }
          }
          disposeAll();
          endRaw();
          callback?.();
        })
        .catch(() => {
          if (closed) return;
          if (anyFailClosed) {
            noteOutcome('blocked', 'guard_failed');
            writeRaw(buildStreamStopFrames(wire, '', lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
          }
          disposeAll();
          endRaw();
          callback?.();
        });
      return res;
    }

    // Run non-buffering onComplete finalization (e.g. timer-flushed stream guard)
    const hasComplete = filters.some((f) => Boolean(f.onComplete));
    if (hasComplete) {
      void runOnCompleteChain(bufferedText)
        .then(({ text: finalText, blocked }) => {
          if (closed) return;
          if (blocked) {
            writeRaw(buildStreamStopFrames(wire, finalText, lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
          }
          disposeAll();
          endRaw();
          callback?.();
        })
        .catch(() => {
          if (closed) return;
          if (anyFailClosed) {
            noteOutcome('blocked', 'guard_failed');
            writeRaw(buildStreamStopFrames(wire, '', lastModel || 'unknown', hasGuardFilter ? guardOutcome : undefined));
          }
          disposeAll();
          endRaw();
          callback?.();
        });
      return res;
    }

    disposeAll();
    endRaw();
    callback?.();
    return res;
  }) as Response['end'];
}
