/**
 * Optional streaming for POST /chat. A client that sends `Accept: text/event-stream` gets the
 * Copilot's working steps live, then the same JSON response (or error) it would have got without
 * streaming, as the last event. Any other client is untouched.
 *
 * It works by wrapping `res.json` for this request only, so none of the many `res.json(...)`
 * branches in the route needed to change.
 */
import type { NextFunction, Request, Response } from 'express';
import { runWithTrace } from './trace.js';

const HEARTBEAT_MS = 15_000;

export function wantsChatStream(req: Request): boolean {
  return String(req.headers.accept ?? '').includes('text/event-stream');
}

export function copilotChatStream(req: Request, res: Response, next: NextFunction): void {
  if (!wantsChatStream(req)) {
    next();
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const write = (event: string, data: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  res.on('close', () => clearInterval(heartbeat));

  // The route ends every request with res.json(...) — directly or through the error handler.
  res.json = ((body: unknown) => {
    clearInterval(heartbeat);
    write('final', { status: res.statusCode, body });
    if (!res.writableEnded) res.end();
    return res;
  }) as Response['json'];

  runWithTrace((step) => write('step', step), () => next());
}

/**
 * Error handler mounted right after the /chat route. Once the stream is open the global error
 * handler can no longer answer (headers are sent), so a streaming request reports its error as
 * the final event, in the same `{ error: { message, type } }` shape the global handler uses.
 */
export function copilotChatStreamError(err: Error, req: Request, res: Response, next: NextFunction): void {
  if (!wantsChatStream(req) || !res.headersSent) {
    next(err);
    return;
  }
  const isProduction = (process.env.NODE_ENV ?? 'development') === 'production';
  console.error('[Error]', isProduction ? err : err.message);
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({
    error: {
      message: isProduction && status >= 500 ? 'Internal server error' : err.message,
      type: err.name ?? 'server_error',
    },
  });
}
