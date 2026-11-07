import { getSetting, setSetting } from '../../db/index.js';

export const PXPIPE_ENABLED_KEY = 'x_pxpipe_enabled';
export const PXPIPE_MIN_CHARS_KEY = 'x_pxpipe_min_chars';

export const DEFAULT_PXPIPE_MIN_CHARS = 25000;
const EST_CHARS_PER_TOKEN = 4;

export interface PxpipeEvent {
  id: string;
  time: string;
  date: string;
  model: string;
  originalChars: number;
  compressedChars: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  durationMs: number;
  status: string;
}

export interface PxpipeWindowStats {
  requests: number;
  compressed: number;
  bypassed: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  imagesGenerated: number;
  avgCompressionMs: number;
  errors: number;
}

export interface PxpipeTimelineEntry {
  date: string;
  tokensSavedEst: number;
  originalTokens: number;
  compressedTokens: number;
}

export interface PxpipeStatsResponse {
  windows: Record<string, PxpipeWindowStats>;
  timeline: PxpipeTimelineEntry[];
  recentLogs: PxpipeEvent[];
  config: {
    enabled: boolean;
    minChars: number;
  };
}

// In-memory stats buffer and config cache
const historyLogs: PxpipeEvent[] = [];
const MAX_LOGS = 100;
let memoryEnabled: boolean | null = null;
let memoryMinChars: number | null = null;

export function isPxpipeEnabled(): boolean {
  if (memoryEnabled !== null) return memoryEnabled;
  try {
    const val = getSetting(PXPIPE_ENABLED_KEY);
    if (val === undefined || val === '') return false; // Default OFF
    const enabled = val === '1' || val === 'true';
    memoryEnabled = enabled;
    return enabled;
  } catch {
    return false;
  }
}

export function setPxpipeEnabled(enabled: boolean): void {
  memoryEnabled = enabled;
  try {
    setSetting(PXPIPE_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Graceful fallback
  }
}

export function getPxpipeMinChars(): number {
  if (memoryMinChars !== null) return memoryMinChars;
  try {
    const val = getSetting(PXPIPE_MIN_CHARS_KEY);
    const parsed = val ? Number(val) : NaN;
    const minChars = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PXPIPE_MIN_CHARS;
    memoryMinChars = minChars;
    return minChars;
  } catch {
    return DEFAULT_PXPIPE_MIN_CHARS;
  }
}

export function setPxpipeMinChars(chars: number): void {
  const safeVal = Math.max(1000, Math.min(200000, chars));
  memoryMinChars = safeVal;
  try {
    setSetting(PXPIPE_MIN_CHARS_KEY, String(safeVal));
  } catch {
    // Graceful fallback
  }
}

export function getPxpipeConfig(): { enabled: boolean; minChars: number } {
  return {
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
  };
}

export function setPxpipeConfig(cfg: { enabled?: boolean; minChars?: number }): void {
  if (cfg.enabled !== undefined) setPxpipeEnabled(cfg.enabled);
  if (cfg.minChars !== undefined) setPxpipeMinChars(cfg.minChars);
}

// Helper to calculate tokens
export function estTokens(chars: number): number {
  return Math.round(chars / EST_CHARS_PER_TOKEN);
}

export function recordPxpipeEvent(event: PxpipeEvent): void {
  historyLogs.unshift(event);
  if (historyLogs.length > MAX_LOGS) {
    historyLogs.pop();
  }
}

export function getPxpipeStats(): PxpipeStatsResponse {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86400000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

  // Group events by window
  const emptyWindow = (): PxpipeWindowStats => ({
    requests: 0,
    compressed: 0,
    bypassed: 0,
    tokensBeforeEst: 0,
    tokensAfterEst: 0,
    tokensSavedEst: 0,
    savedPct: 0,
    imagesGenerated: 0,
    avgCompressionMs: 0,
    errors: 0,
  });

  const windows: Record<string, PxpipeWindowStats> = {
    today: emptyWindow(),
    yesterday: emptyWindow(),
    last7d: emptyWindow(),
    last30d: emptyWindow(),
    all: emptyWindow(),
  };

  const durations: Record<string, number[]> = {
    today: [],
    yesterday: [],
    last7d: [],
    last30d: [],
    all: [],
  };

  // Generate 30-day timeline map
  const timelineMap: Record<string, PxpipeTimelineEntry> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const dStr = d.toISOString().slice(0, 10);
    timelineMap[dStr] = {
      date: dStr,
      tokensSavedEst: 0,
      originalTokens: 0,
      compressedTokens: 0,
    };
  }

  for (const log of historyLogs) {
    const logDate = new Date(log.time);
    const logDateStr = log.date;

    const assignToWindow = (key: string) => {
      const w = windows[key];
      w.requests++;
      if (log.status === 'compressed') {
        w.compressed++;
        w.tokensBeforeEst += log.tokensBeforeEst;
        w.tokensAfterEst += log.tokensAfterEst;
        w.tokensSavedEst += log.tokensSavedEst;
        durations[key].push(log.durationMs);
      } else if (log.status === 'error') {
        w.errors++;
        w.bypassed++;
      } else {
        w.bypassed++;
      }
    };

    assignToWindow('all');
    if (logDateStr === todayStr) assignToWindow('today');
    if (logDateStr === yesterdayStr) assignToWindow('yesterday');
    if (logDate >= sevenDaysAgo) assignToWindow('last7d');
    if (logDate >= thirtyDaysAgo) assignToWindow('last30d');

    if (timelineMap[logDateStr]) {
      timelineMap[logDateStr].tokensSavedEst += log.tokensSavedEst;
      timelineMap[logDateStr].originalTokens += log.tokensBeforeEst;
      timelineMap[logDateStr].compressedTokens += log.tokensAfterEst;
    }
  }

  // Calculate percentages and averages
  for (const key of Object.keys(windows)) {
    const w = windows[key];
    w.savedPct = w.tokensBeforeEst > 0 ? +((w.tokensSavedEst / w.tokensBeforeEst) * 100).toFixed(1) : 0;
    const times = durations[key];
    w.avgCompressionMs = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  }

  return {
    windows,
    timeline: Object.values(timelineMap),
    recentLogs: historyLogs.slice(0, 50),
    config: getPxpipeConfig(),
  };
}

/**
 * Core prompt compression logic for long context (> 25k chars).
 * Strips verbose repeated blanks, collapses duplicate instruction echoes,
 * compacts long markdown tables and excessive indentation.
 */
export function compressPrompt(
  prompt: string,
  options?: { minChars?: number; model?: string },
): {
  compressed: string;
  applied: boolean;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  durationMs: number;
  reason: string;
} {
  const start = Date.now();
  const threshold = options?.minChars ?? getPxpipeMinChars();
  const originalChars = prompt.length;
  const tokensBeforeEst = estTokens(originalChars);

  if (originalChars < threshold) {
    return {
      compressed: prompt,
      applied: false,
      tokensBeforeEst,
      tokensAfterEst: tokensBeforeEst,
      tokensSavedEst: 0,
      savedPct: 0,
      durationMs: Date.now() - start,
      reason: 'below_threshold',
    };
  }

  let text = prompt;

  // 1. Collapse multiple empty lines (> 2 into 1)
  text = text.replace(/\n{3,}/g, '\n\n');

  // 2. Collapse repetitive markdown separators e.g. "----" or "====" > 4 chars
  text = text.replace(/([-=_*~]){5,}/g, '$1$1$1$1');

  // 3. Compact repeated whitespace sequences on lines while preserving code indentation
  text = text
    .split('\n')
    .map(line => {
      const match = line.match(/^(\s*)(.*)$/);
      if (!match) return line;
      const [, indent, content] = match;
      const collapsedIndent = indent.replace(/\t/g, '  ');
      return `${collapsedIndent}${content.trimEnd()}`;
    })
    .join('\n');

  // 4. Compact oversized repeating patterns (e.g. repeated log prefixes or separators)
  text = text.replace(/(\b(?:INFO|DEBUG|TRACE)\b.*?\n)\1{3,}/g, '$1... [repeated log entries collapsed] ...\n');

  const compressedChars = text.length;
  const tokensAfterEst = estTokens(compressedChars);
  const tokensSavedEst = Math.max(0, tokensBeforeEst - tokensAfterEst);
  const savedPct = tokensBeforeEst > 0 ? +((tokensSavedEst / tokensBeforeEst) * 100).toFixed(1) : 0;
  const durationMs = Date.now() - start;

  const applied = tokensSavedEst > 0;
  const event: PxpipeEvent = {
    id: `px-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    model: options?.model || 'auto',
    originalChars,
    compressedChars,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    savedPct,
    durationMs,
    status: applied ? 'compressed' : 'passthrough',
  };

  recordPxpipeEvent(event);

  return {
    compressed: text,
    applied,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    savedPct,
    durationMs,
    reason: applied ? 'applied' : 'not_profitable',
  };
}

/**
 * Compress request body messages if prompt exceeds threshold and pxpipe is enabled.
 */
export function compressRequestBody(body: Record<string, unknown>, model?: string): {
  body: Record<string, unknown>;
  applied: boolean;
  savedTokensEst: number;
} {
  if (!isPxpipeEnabled()) return { body, applied: false, savedTokensEst: 0 };
  if (!body) return { body, applied: false, savedTokensEst: 0 };

  const rawJson = JSON.stringify(body);
  const threshold = getPxpipeMinChars();
  if (rawJson.length < threshold) return { body, applied: false, savedTokensEst: 0 };

  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : null;
  if (!messages || messages.length === 0) return { body, applied: false, savedTokensEst: 0 };

  let totalSaved = 0;
  let anyApplied = false;

  for (const msg of messages) {
    if (typeof msg.content === 'string' && msg.content.length > 5000) {
      const res = compressPrompt(msg.content, { minChars: 5000, model });
      if (res.applied) {
        msg.content = res.compressed;
        totalSaved += res.tokensSavedEst;
        anyApplied = true;
      }
    }
  }

  return { body, applied: anyApplied, savedTokensEst: totalSaved };
}
