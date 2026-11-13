import { EventEmitter } from 'events';
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';

const MAX_BUFFERED_LINES = 1000;
const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_LINES = 50;

interface LogBufferState {
  logs: string[];
  pendingLines: string[];
  flushTimer: NodeJS.Timeout | null;
  patched: boolean;
  originals: Record<string, (...args: unknown[]) => void>;
  emitter: EventEmitter;
}

// Global buffer state across reloads
const globalKey = '__x_gateway_console_log_buffer_state__';
const g = global as unknown as Record<string, LogBufferState | undefined>;

if (!g[globalKey]) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  g[globalKey] = {
    logs: [],
    pendingLines: [],
    flushTimer: null,
    patched: false,
    originals: {},
    emitter,
  };
}

const state = g[globalKey]!;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, '');
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return stripAnsi(arg);
  if (arg instanceof Error) return stripAnsi(arg.stack || arg.message || String(arg));
  try {
    return stripAnsi(JSON.stringify(arg));
  } catch {
    return stripAnsi(String(arg));
  }
}

function flushPendingLines(): void {
  state.flushTimer = null;
  if (!state.pendingLines.length) return;
  const lines = state.pendingLines.splice(0, state.pendingLines.length);
  state.emitter.emit('lines', lines);
}

function scheduleFlush(): void {
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(flushPendingLines, FLUSH_INTERVAL_MS);
  if (state.flushTimer?.unref) state.flushTimer.unref();
}

function appendLine(line: string): void {
  state.logs.push(line);
  if (state.logs.length > MAX_BUFFERED_LINES) {
    state.logs = state.logs.slice(-MAX_BUFFERED_LINES);
  }
  state.pendingLines.push(line);
  if (state.pendingLines.length >= MAX_BATCH_LINES) {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingLines();
  } else {
    scheduleFlush();
  }
}

export function initConsoleLogCapture(): void {
  if (state.patched) return;

  const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
  for (const level of levels) {
    const original = console[level];
    state.originals[level] = original.bind(console);
    console[level] = (...args: unknown[]) => {
      const now = new Date().toISOString().slice(11, 19);
      const levelTag = `[${level.toUpperCase()}]`;
      const formatted = args.map(formatArg).join(' ');
      const line = `${now} ${levelTag} ${formatted}`;

      appendLine(line);
      state.originals[level](...args);
    };
  }

  // Also tap process.stdout / stderr
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') {
      const cleaned = stripAnsi(chunk).trim();
      if (cleaned) {
        const now = new Date().toISOString().slice(11, 19);
        appendLine(`${now} [STDOUT] ${cleaned}`);
      }
    }
    return (origStdoutWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
  };

  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string') {
      const cleaned = stripAnsi(chunk).trim();
      if (cleaned) {
        const now = new Date().toISOString().slice(11, 19);
        appendLine(`${now} [STDERR] ${cleaned}`);
      }
    }
    return (origStderrWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
  };

  state.patched = true;
}

export function getConsoleLogs(): string[] {
  return [...state.logs];
}

export function clearConsoleLogs(): void {
  state.logs = [];
  state.emitter.emit('clear');
}

export function getConsoleEmitter(): EventEmitter {
  return state.emitter;
}

// Initialize immediately
initConsoleLogCapture();

// ---------------------------------------------------------------------
// Router: Handles both /api/translator/console-logs and /console-logs
// ---------------------------------------------------------------------

export const consoleStreamRouter = Router();
// Server console output can carry request details: signed-in accounts that may open the
// Thruline console's log page only (the same pair of permissions the page itself asks for).
consoleStreamRouter.use(requireAuth, requirePermission('use_x_gateway'), requirePermission('view_keys'));

// Stream SSE logs
consoleStreamRouter.get('/console-logs/stream', (req: Request, res: Response) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Flush headers immediately
  res.flushHeaders?.();

  // Send initial buffer
  const initial = getConsoleLogs();
  res.write(`data: ${JSON.stringify({ type: 'init', logs: initial })}\n\n`);

  let closed = false;

  const onLine = (line: string) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify({ type: 'line', line })}\n\n`);
    } catch {
      cleanup();
    }
  };

  const onLines = (lines: string[]) => {
    if (closed || !Array.isArray(lines) || lines.length === 0) return;
    try {
      res.write(`data: ${JSON.stringify({ type: 'lines', lines })}\n\n`);
    } catch {
      cleanup();
    }
  };

  const onClear = () => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify({ type: 'clear' })}\n\n`);
    } catch {
      cleanup();
    }
  };

  state.emitter.on('line', onLine);
  state.emitter.on('lines', onLines);
  state.emitter.on('clear', onClear);

  // Keepalive every 25 seconds
  const keepalive = setInterval(() => {
    if (closed) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25_000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    state.emitter.off('line', onLine);
    state.emitter.off('lines', onLines);
    state.emitter.off('clear', onClear);
    try {
      res.end();
    } catch {
      // already closed
    }
  };

  req.on('close', cleanup);
  req.on('error', cleanup);
});

// JSON snapshot of console logs
consoleStreamRouter.get('/console-logs', (_req: Request, res: Response) => {
  res.json({ logs: getConsoleLogs() });
});

// Clear console logs
consoleStreamRouter.delete('/console-logs', (_req: Request, res: Response) => {
  clearConsoleLogs();
  res.status(204).end();
});
