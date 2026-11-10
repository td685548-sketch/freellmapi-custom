import { deflateSync } from 'node:zlib';
import { getSetting, setSetting } from '../../db/index.js';

export const PXPIPE_ENABLED_KEY = 'x_pxpipe_enabled';
export const PXPIPE_MIN_CHARS_KEY = 'x_pxpipe_min_chars';
export const PXPIPE_TIMEOUT_MS_KEY = 'x_pxpipe_timeout_ms';

export const DEFAULT_PXPIPE_MIN_CHARS = 25000;
export const DEFAULT_PXPIPE_TIMEOUT_MS = 15000;
const EST_CHARS_PER_TOKEN = 4;
const MAX_LOGS = 100;

export interface PxpipeEvent {
  id: string;
  time: string;
  date: string;
  model: string;
  provider?: string;
  originalChars: number;
  compressedChars: number;
  imagedChars: number;
  imageCount: number;
  imageBytes: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  durationMs: number;
  status: string;
  reason?: string;
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
    timeoutMs: number;
  };
}

const historyLogs: PxpipeEvent[] = [];
let memoryEnabled: boolean | null = null;
let memoryMinChars: number | null = null;
let memoryTimeoutMs: number | null = null;

export function isPxpipeEnabled(): boolean {
  if (memoryEnabled !== null) return memoryEnabled;
  try {
    const envVal = process.env.X_PXPIPE_ENABLED ?? process.env.PXPIPE_ENABLED;
    if (envVal !== undefined && envVal.trim() !== '') {
      const en = envVal.trim() === '1' || envVal.trim().toLowerCase() === 'true';
      memoryEnabled = en;
      return en;
    }
    const val = getSetting(PXPIPE_ENABLED_KEY);
    if (val === undefined || val === '') return false; // Default OFF until enabled
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
    // Fail open
  }
}

export function getPxpipeMinChars(): number {
  if (memoryMinChars !== null) return memoryMinChars;
  try {
    const envVal = process.env.X_PXPIPE_MIN_CHARS ?? process.env.PXPIPE_MIN_CHARS;
    if (envVal !== undefined && envVal.trim() !== '') {
      const parsed = Number(envVal);
      if (Number.isFinite(parsed) && parsed > 0) {
        memoryMinChars = parsed;
        return parsed;
      }
    }
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
    // Fail open
  }
}

export function getPxpipeTimeoutMs(): number {
  if (memoryTimeoutMs !== null) return memoryTimeoutMs;
  try {
    const val = getSetting(PXPIPE_TIMEOUT_MS_KEY);
    const parsed = val ? Number(val) : NaN;
    const timeout = Number.isFinite(parsed) && parsed >= 500 && parsed <= 60000 ? parsed : DEFAULT_PXPIPE_TIMEOUT_MS;
    memoryTimeoutMs = timeout;
    return timeout;
  } catch {
    return DEFAULT_PXPIPE_TIMEOUT_MS;
  }
}

export function setPxpipeTimeoutMs(ms: number): void {
  const safe = Math.max(500, Math.min(60000, ms));
  memoryTimeoutMs = safe;
  try {
    setSetting(PXPIPE_TIMEOUT_MS_KEY, String(safe));
  } catch {
    // Fail open
  }
}

export function getPxpipeConfig(): { enabled: boolean; minChars: number; timeoutMs: number } {
  return {
    enabled: isPxpipeEnabled(),
    minChars: getPxpipeMinChars(),
    timeoutMs: getPxpipeTimeoutMs(),
  };
}

export function setPxpipeConfig(cfg: { enabled?: boolean; minChars?: number; timeoutMs?: number }): void {
  if (cfg.enabled !== undefined) setPxpipeEnabled(cfg.enabled);
  if (cfg.minChars !== undefined) setPxpipeMinChars(cfg.minChars);
  if (cfg.timeoutMs !== undefined) setPxpipeTimeoutMs(cfg.timeoutMs);
}

export function estTokens(chars: number): number {
  return Math.max(1, Math.round(chars / EST_CHARS_PER_TOKEN));
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

  const timelineMap: Record<string, PxpipeTimelineEntry> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    timelineMap[d] = { date: d, tokensSavedEst: 0, originalTokens: 0, compressedTokens: 0 };
  }

  const durations: Record<string, number[]> = {
    today: [],
    yesterday: [],
    last7d: [],
    last30d: [],
    all: [],
  };

  for (const log of historyLogs) {
    const logDate = new Date(log.date);
    const logDateStr = log.date;

    const assignToWindow = (key: string) => {
      const w = windows[key];
      w.requests++;
      if (log.status === 'compressed') {
        w.compressed++;
        w.tokensBeforeEst += log.tokensBeforeEst;
        w.tokensAfterEst += log.tokensAfterEst;
        w.tokensSavedEst += log.tokensSavedEst;
        w.imagesGenerated += log.imageCount;
        durations[key].push(log.durationMs);
      } else if (log.status === 'error') {
        w.errors++;
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

// ─────────────────────────────────────────────────────────────────────────────
// Vision Capability Detection (mirrors 9Router capabilities.js & visionPatterns.js)
// ─────────────────────────────────────────────────────────────────────────────

const NOT_VISION_REGEX = /(^|[-_/:.])(image|img|stable-image|dall|sdxl|diffusion|embed|rerank|guard|moderation|tts|stt|whisper|voice|speech|audio)([-_/:.]|$)/i;

const VISION_NAME_REGEX = new RegExp(
  [
    `(^|[-_/:.])(vision|vl|vlm|multimodal|omni|visual)([-_/:.]|$)`,
    `[0-9]\\.[0-9]+v([-_/:.]|$)`,
    `(^|[-_/:.])glm-[0-9]+v([-_/:.]|$)`,
    '(^|[-_/:.])(llava|pixtral|internvl|cogvlm|minicpm-v|moondream|idefics|fuyu)',
  ].join('|'),
  'i'
);

const KNOWN_VISION_PATTERNS = [
  /claude-3/i,
  /claude-4/i,
  /claude-sonnet/i,
  /claude-opus/i,
  /claude-haiku/i,
  /gpt-4o/i,
  /gpt-4\.5/i,
  /gpt-4-turbo/i,
  /o1\b/i,
  /o3\b/i,
  /o3-mini/i,
  /gemini-1\.5/i,
  /gemini-2/i,
  /gemini-pro-vision/i,
  /qwen.*-vl/i,
  /qwen2\.5-vl/i,
  /internvl/i,
  /pixtral/i,
  /command-a-vision/i,
];

const KNOWN_TEXT_ONLY_PATTERNS = [
  /deepseek-chat/i,
  /deepseek-coder/i,
  /deepseek-r1/i,
  /deepseek-v3/i,
  /llama-3/i,
  /llama-2/i,
  /mistral-large/i,
  /mistral-small/i,
  /codestral/i,
  /qwen2\.5-coder/i,
];

export function isVisionCapableModel(modelId?: string, provider?: string): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();

  if (KNOWN_TEXT_ONLY_PATTERNS.some(p => p.test(id))) {
    return false;
  }

  if (NOT_VISION_REGEX.test(id)) {
    return false;
  }

  if (KNOWN_VISION_PATTERNS.some(p => p.test(id))) {
    return true;
  }

  if (VISION_NAME_REGEX.test(id)) {
    return true;
  }

  const prov = String(provider || '').toLowerCase();
  if (prov === 'anthropic' || prov === 'gemini' || prov === 'google') {
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic 8-bit Monospace PNG Renderer
// ─────────────────────────────────────────────────────────────────────────────

const ASCII_FONT_5X7 = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, // 32 space
  0x00, 0x00, 0x5f, 0x00, 0x00, // 33 !
  0x00, 0x07, 0x00, 0x07, 0x00, // 34 "
  0x14, 0x7f, 0x14, 0x7f, 0x14, // 35 #
  0x24, 0x2a, 0x7f, 0x2a, 0x12, // 36 $
  0x23, 0x13, 0x08, 0x64, 0x62, // 37 %
  0x36, 0x49, 0x55, 0x22, 0x50, // 38 &
  0x00, 0x05, 0x03, 0x00, 0x00, // 39 '
  0x00, 0x1c, 0x22, 0x41, 0x00, // 40 (
  0x00, 0x41, 0x22, 0x1c, 0x00, // 41 )
  0x14, 0x08, 0x3e, 0x08, 0x14, // 42 *
  0x08, 0x08, 0x3e, 0x08, 0x08, // 43 +
  0x00, 0x50, 0x30, 0x00, 0x00, // 44 ,
  0x08, 0x08, 0x08, 0x08, 0x08, // 45 -
  0x00, 0x60, 0x60, 0x00, 0x00, // 46 .
  0x20, 0x10, 0x08, 0x04, 0x02, // 47 /
  0x3e, 0x51, 0x49, 0x45, 0x3e, // 48 0
  0x00, 0x42, 0x7f, 0x40, 0x00, // 49 1
  0x42, 0x61, 0x51, 0x49, 0x46, // 50 2
  0x21, 0x41, 0x45, 0x4b, 0x31, // 51 3
  0x18, 0x14, 0x12, 0x7f, 0x10, // 52 4
  0x27, 0x45, 0x45, 0x45, 0x39, // 53 5
  0x3c, 0x4a, 0x49, 0x49, 0x30, // 54 6
  0x01, 0x71, 0x09, 0x05, 0x03, // 55 7
  0x36, 0x49, 0x49, 0x49, 0x36, // 56 8
  0x06, 0x49, 0x49, 0x29, 0x1e, // 57 9
  0x00, 0x36, 0x36, 0x00, 0x00, // 58 :
  0x00, 0x56, 0x36, 0x00, 0x00, // 59 ;
  0x08, 0x14, 0x22, 0x41, 0x00, // 60 <
  0x14, 0x14, 0x14, 0x14, 0x14, // 61 =
  0x00, 0x41, 0x22, 0x14, 0x08, // 62 >
  0x02, 0x01, 0x51, 0x09, 0x06, // 63 ?
  0x32, 0x49, 0x79, 0x41, 0x3e, // 64 @
  0x7e, 0x11, 0x11, 0x11, 0x7e, // 65 A
  0x7f, 0x49, 0x49, 0x49, 0x36, // 66 B
  0x3e, 0x41, 0x41, 0x41, 0x22, // 67 C
  0x7f, 0x41, 0x41, 0x22, 0x1c, // 68 D
  0x7f, 0x49, 0x49, 0x49, 0x41, // 69 E
  0x7f, 0x09, 0x09, 0x09, 0x01, // 70 F
  0x3e, 0x41, 0x49, 0x49, 0x7a, // 71 G
  0x7f, 0x08, 0x08, 0x08, 0x7f, // 72 H
  0x00, 0x41, 0x7f, 0x41, 0x00, // 73 I
  0x20, 0x40, 0x41, 0x3f, 0x01, // 74 J
  0x7f, 0x08, 0x14, 0x22, 0x41, // 75 K
  0x7f, 0x40, 0x40, 0x40, 0x40, // 76 L
  0x7f, 0x02, 0x0c, 0x02, 0x7f, // 77 M
  0x7f, 0x04, 0x08, 0x10, 0x7f, // 78 N
  0x3e, 0x41, 0x41, 0x41, 0x3e, // 79 O
  0x7f, 0x09, 0x09, 0x09, 0x06, // 80 P
  0x3e, 0x41, 0x51, 0x21, 0x5e, // 81 Q
  0x7f, 0x09, 0x19, 0x29, 0x46, // 82 R
  0x46, 0x49, 0x49, 0x49, 0x31, // 83 S
  0x01, 0x01, 0x7f, 0x01, 0x01, // 84 T
  0x3f, 0x40, 0x40, 0x40, 0x3f, // 85 U
  0x1f, 0x20, 0x40, 0x20, 0x1f, // 86 V
  0x3f, 0x40, 0x38, 0x40, 0x3f, // 87 W
  0x63, 0x14, 0x08, 0x14, 0x63, // 88 X
  0x07, 0x08, 0x70, 0x08, 0x07, // 89 Y
  0x61, 0x51, 0x49, 0x45, 0x43, // 90 Z
  0x00, 0x7f, 0x41, 0x41, 0x00, // 91 [
  0x02, 0x04, 0x08, 0x10, 0x20, // 92 \
  0x00, 0x41, 0x41, 0x7f, 0x00, // 93 ]
  0x04, 0x02, 0x01, 0x02, 0x04, // 94 ^
  0x40, 0x40, 0x40, 0x40, 0x40, // 95 _
  0x00, 0x01, 0x02, 0x04, 0x00, // 96 `
  0x20, 0x54, 0x54, 0x54, 0x78, // 97 a
  0x7f, 0x48, 0x44, 0x44, 0x38, // 98 b
  0x38, 0x44, 0x44, 0x44, 0x20, // 99 c
  0x38, 0x44, 0x44, 0x48, 0x7f, // 100 d
  0x38, 0x54, 0x54, 0x54, 0x18, // 101 e
  0x08, 0x7e, 0x09, 0x01, 0x02, // 102 f
  0x0c, 0x52, 0x52, 0x52, 0x3e, // 103 g
  0x7f, 0x08, 0x04, 0x04, 0x78, // 104 h
  0x00, 0x44, 0x7d, 0x40, 0x00, // 105 i
  0x20, 0x40, 0x44, 0x3d, 0x00, // 106 j
  0x7f, 0x10, 0x28, 0x44, 0x00, // 107 k
  0x00, 0x41, 0x7f, 0x40, 0x00, // 108 l
  0x7c, 0x04, 0x18, 0x04, 0x78, // 109 m
  0x7c, 0x08, 0x04, 0x04, 0x78, // 110 n
  0x38, 0x44, 0x44, 0x44, 0x38, // 111 o
  0x7c, 0x14, 0x14, 0x14, 0x08, // 112 p
  0x08, 0x14, 0x14, 0x18, 0x7c, // 113 q
  0x7c, 0x08, 0x04, 0x04, 0x08, // 114 r
  0x48, 0x54, 0x54, 0x54, 0x20, // 115 s
  0x04, 0x3f, 0x44, 0x40, 0x20, // 116 t
  0x3c, 0x40, 0x40, 0x20, 0x7c, // 117 u
  0x1c, 0x20, 0x40, 0x20, 0x1c, // 118 v
  0x3c, 0x40, 0x30, 0x40, 0x3c, // 119 w
  0x44, 0x28, 0x10, 0x28, 0x44, // 120 x
  0x0c, 0x50, 0x50, 0x50, 0x3c, // 121 y
  0x44, 0x64, 0x54, 0x4c, 0x44, // 122 z
  0x00, 0x08, 0x36, 0x41, 0x00, // 123 {
  0x00, 0x00, 0x7f, 0x00, 0x00, // 124 |
  0x00, 0x41, 0x36, 0x08, 0x00, // 125 }
  0x08, 0x08, 0x2a, 0x1c, 0x08, // 126 ~
]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function calculateCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = data.length;
  const chunk = new Uint8Array(8 + len + 4);

  chunk[0] = (len >>> 24) & 0xff;
  chunk[1] = (len >>> 16) & 0xff;
  chunk[2] = (len >>> 8) & 0xff;
  chunk[3] = len & 0xff;

  chunk.set(typeBytes, 4);
  chunk.set(data, 8);

  const crcTarget = new Uint8Array(4 + len);
  crcTarget.set(typeBytes, 0);
  crcTarget.set(data, 4);
  const crc = calculateCrc32(crcTarget);

  chunk[8 + len] = (crc >>> 24) & 0xff;
  chunk[8 + len + 1] = (crc >>> 16) & 0xff;
  chunk[8 + len + 2] = (crc >>> 8) & 0xff;
  chunk[8 + len + 3] = crc & 0xff;

  return chunk;
}

export function renderTextToPng(
  lines: string[],
  options?: { width?: number; lineHeight?: number; charWidth?: number }
): { pngBuffer: Buffer; width: number; height: number } {
  const charWidth = options?.charWidth ?? 6;
  const lineHeight = options?.lineHeight ?? 10;
  const maxLineLen = Math.max(1, ...lines.map(l => l.length));
  const marginX = 12;
  const marginY = 12;

  const width = options?.width ?? Math.max(200, Math.min(1024, maxLineLen * charWidth + marginX * 2));
  const height = Math.max(100, lines.length * lineHeight + marginY * 2);

  const rowStride = 1 + width;
  const rawBitmap = new Uint8Array(rowStride * height);

  for (let y = 0; y < height; y++) {
    rawBitmap[y * rowStride] = 0;
    for (let x = 0; x < width; x++) {
      rawBitmap[y * rowStride + 1 + x] = 255;
    }
  }

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const topY = marginY + lineIdx * lineHeight;
    if (topY + 7 >= height) break;

    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const startX = marginX + charIdx * charWidth;
      if (startX + 5 >= width) break;

      const code = line.charCodeAt(charIdx);
      if (code < 32 || code > 126) continue;

      const fontOffset = (code - 32) * 5;
      for (let col = 0; col < 5; col++) {
        const bits = ASCII_FONT_5X7[fontOffset + col];
        for (let row = 0; row < 7; row++) {
          if ((bits >> row) & 1) {
            const px = startX + col;
            const py = topY + row;
            if (px < width && py < height) {
              rawBitmap[py * rowStride + 1 + px] = 24;
            }
          }
        }
      }
    }
  }

  const compressed = deflateSync(rawBitmap, { level: 6 });
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  ihdrData[0] = (width >>> 24) & 0xff;
  ihdrData[1] = (width >>> 16) & 0xff;
  ihdrData[2] = (width >>> 8) & 0xff;
  ihdrData[3] = width & 0xff;
  ihdrData[4] = (height >>> 24) & 0xff;
  ihdrData[5] = (height >>> 16) & 0xff;
  ihdrData[6] = (height >>> 8) & 0xff;
  ihdrData[7] = height & 0xff;
  ihdrData[8] = 8;
  ihdrData[9] = 0;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const ihdrChunk = createPngChunk('IHDR', ihdrData);
  const idatChunk = createPngChunk('IDAT', compressed);
  const iendChunk = createPngChunk('IEND', new Uint8Array(0));

  const pngBuffer = Buffer.concat([pngSignature, ihdrChunk, idatChunk, iendChunk]);
  return { pngBuffer, width, height };
}

export function renderTextToPngPages(
  text: string,
  options?: { maxLinesPerPage?: number; maxCharsPerLine?: number }
): Array<{ pngBuffer: Buffer; width: number; height: number; base64: string; lineCount: number }> {
  const maxLinesPerPage = options?.maxLinesPerPage ?? 90;
  const maxCharsPerLine = options?.maxCharsPerLine ?? 120;

  const rawLines = text.split(/\r?\n/);
  const wrappedLines: string[] = [];

  for (const raw of rawLines) {
    if (raw.length <= maxCharsPerLine) {
      wrappedLines.push(raw);
    } else {
      let remaining = raw;
      while (remaining.length > maxCharsPerLine) {
        wrappedLines.push(remaining.slice(0, maxCharsPerLine));
        remaining = remaining.slice(maxCharsPerLine);
      }
      if (remaining.length > 0) wrappedLines.push(remaining);
    }
  }

  const pages: Array<{ pngBuffer: Buffer; width: number; height: number; base64: string; lineCount: number }> = [];

  for (let i = 0; i < wrappedLines.length; i += maxLinesPerPage) {
    const pageLines = wrappedLines.slice(i, i + maxLinesPerPage);
    const rendered = renderTextToPng(pageLines);
    pages.push({
      pngBuffer: rendered.pngBuffer,
      width: rendered.width,
      height: rendered.height,
      base64: rendered.pngBuffer.toString('base64'),
      lineCount: pageLines.length,
    });
  }

  return pages;
}

export function getPxpipeStatus() {
  const cfg = getPxpipeConfig();
  return {
    installed: true,
    version: '1.2.0-native',
    enabled: cfg.enabled,
    running: true,
    minChars: cfg.minChars,
    timeoutMs: cfg.timeoutMs,
    mode: 'in-process-renderer',
  };
}

export function runPxpipeSelfTest(): { ok: boolean; durationMs: number; reason: string; sampleImageBytes: number } {
  const start = Date.now();
  const sample = 'Hello PXPIPE. Deterministic text-to-image engine online.\nTesting multi-line formatting.';
  const pages = renderTextToPngPages(sample);
  if (pages.length === 0 || pages[0].pngBuffer.length === 0) {
    throw new Error('Self test failed to generate PNG buffer');
  }
  return {
    ok: true,
    durationMs: Date.now() - start,
    reason: 'self_test_passed',
    sampleImageBytes: pages[0].pngBuffer.length,
  };
}

export interface PxpipeCompressionResult {
  applied: boolean;
  reason: string;
  originalChars: number;
  compressedBodyChars: number;
  imagedChars: number;
  imageCount: number;
  imageBytes: number;
  tokensBeforeEst: number;
  tokensAfterEst: number;
  tokensSavedEst: number;
  savedPct: number;
  durationMs: number;
}

export function compressMessagesWithPxpipeVision(
  messages: Array<Record<string, any>>,
  options?: {
    model?: string;
    provider?: string;
    minChars?: number;
    enabled?: boolean;
    format?: 'openai' | 'claude' | 'gemini';
  }
): {
  messages: Array<Record<string, any>>;
  summary: PxpipeCompressionResult;
} {
  const start = Date.now();
  const isEnabled = options?.enabled !== undefined ? options.enabled : isPxpipeEnabled();
  const model = options?.model || 'unknown';
  const provider = options?.provider;
  const threshold = options?.minChars ?? getPxpipeMinChars();

  const skipped = (reason: string, extra: Partial<PxpipeCompressionResult> = {}) => ({
    messages,
    summary: {
      applied: false,
      reason,
      originalChars: 0,
      compressedBodyChars: 0,
      imagedChars: 0,
      imageCount: 0,
      imageBytes: 0,
      tokensBeforeEst: 0,
      tokensAfterEst: 0,
      tokensSavedEst: 0,
      savedPct: 0,
      durationMs: Date.now() - start,
      ...extra,
    },
  });

  if (!isEnabled) {
    return skipped('disabled');
  }

  if (!isVisionCapableModel(model, provider)) {
    return skipped('model_not_vision_capable');
  }

  if (!Array.isArray(messages) || messages.length <= 1) {
    return skipped('insufficient_messages');
  }

  let totalChars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      totalChars += m.content.length;
    }
  }

  if (totalChars < threshold) {
    return skipped('below_threshold', { originalChars: totalChars });
  }

  const format = options?.format || 'openai';
  const newMessages: Array<Record<string, any>> = [];
  let totalImagedChars = 0;
  let totalImagesGenerated = 0;
  let totalImageBytes = 0;
  let imageTokensEst = 0;

  const lastIndex = messages.length - 1;

  for (let idx = 0; idx < messages.length; idx++) {
    const msg = messages[idx];
    const isTail = idx === lastIndex;
    const isSystem = msg.role === 'system' || msg.role === 'developer';
    const isTool = msg.role === 'tool' || msg.tool_call_id || msg.tool_calls || msg.is_error === true;

    if (isTail || isSystem || isTool || typeof msg.content !== 'string' || msg.content.length < 2500) {
      newMessages.push(msg);
      continue;
    }

    const textToImage = msg.content;
    const pages = renderTextToPngPages(textToImage);
    if (pages.length === 0) {
      newMessages.push(msg);
      continue;
    }

    let pageImageTokens = 0;
    let pageBytes = 0;

    for (const p of pages) {
      pageBytes += p.pngBuffer.length;
      pageImageTokens += Math.max(100, Math.round((p.width * p.height) / 750));
    }

    const textTokensEst = estTokens(textToImage.length);
    if (pageImageTokens >= textTokensEst) {
      newMessages.push(msg);
      continue;
    }

    totalImagedChars += textToImage.length;
    totalImagesGenerated += pages.length;
    totalImageBytes += pageBytes;
    imageTokensEst += pageImageTokens;

    if (format === 'claude') {
      const contentParts: any[] = [
        {
          type: 'text',
          text: `[PXPIPE Context Image: ${pages.length} page(s) representing ${textToImage.length} characters of conversational history]`,
        },
      ];
      for (const p of pages) {
        contentParts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: p.base64,
          },
        });
      }
      newMessages.push({ ...msg, content: contentParts });
    } else if (format === 'gemini') {
      const parts: any[] = [
        { text: `[PXPIPE Context Image: ${pages.length} page(s)]` },
      ];
      for (const p of pages) {
        parts.push({
          inlineData: {
            mimeType: 'image/png',
            data: p.base64,
          },
        });
      }
      newMessages.push({ ...msg, parts });
    } else {
      const contentParts: any[] = [
        {
          type: 'text',
          text: `[PXPIPE Context Image: ${pages.length} page(s) representing ${textToImage.length} characters of conversational history]`,
        },
      ];
      for (const p of pages) {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:image/png;base64,${p.base64}`,
          },
        });
      }
      newMessages.push({ ...msg, content: contentParts });
    }
  }

  if (totalImagesGenerated === 0) {
    return skipped('not_profitable', { originalChars: totalChars });
  }

  const tokensBeforeEst = estTokens(totalChars);
  const remainingTextTokens = estTokens(Math.max(0, totalChars - totalImagedChars));
  const tokensAfterEst = remainingTextTokens + imageTokensEst;
  const tokensSavedEst = Math.max(0, tokensBeforeEst - tokensAfterEst);

  if (tokensSavedEst <= 0) {
    return skipped('not_profitable', {
      originalChars: totalChars,
      tokensBeforeEst,
      tokensAfterEst,
    });
  }

  const savedPct = tokensBeforeEst > 0 ? +((tokensSavedEst / tokensBeforeEst) * 100).toFixed(1) : 0;
  const durationMs = Date.now() - start;

  const summary: PxpipeCompressionResult = {
    applied: true,
    reason: 'applied',
    originalChars: totalChars,
    compressedBodyChars: 0,
    imagedChars: totalImagedChars,
    imageCount: totalImagesGenerated,
    imageBytes: totalImageBytes,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    savedPct,
    durationMs,
  };

  const event: PxpipeEvent = {
    id: `px-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
    model,
    provider,
    originalChars: totalChars,
    compressedChars: 0,
    imagedChars: totalImagedChars,
    imageCount: totalImagesGenerated,
    imageBytes: totalImageBytes,
    tokensBeforeEst,
    tokensAfterEst,
    tokensSavedEst,
    savedPct,
    durationMs,
    status: 'compressed',
    reason: 'applied',
  };

  recordPxpipeEvent(event);

  return { messages: newMessages, summary };
}

export async function compressWithPxpipe(
  body: Record<string, any>,
  options?: {
    enabled?: boolean;
    format?: string;
    model?: string;
    provider?: string;
    minChars?: number;
    timeoutMs?: number;
    transform?: any;
  }
): Promise<{ body: Record<string, any> | null; summary: PxpipeCompressionResult }> {
  const enabled = options?.enabled !== undefined ? options.enabled : isPxpipeEnabled();
  if (!enabled) {
    return {
      body: null,
      summary: {
        applied: false,
        reason: 'disabled',
        originalChars: 0,
        compressedBodyChars: 0,
        imagedChars: 0,
        imageCount: 0,
        imageBytes: 0,
        tokensBeforeEst: 0,
        tokensAfterEst: 0,
        tokensSavedEst: 0,
        savedPct: 0,
        durationMs: 0,
      },
    };
  }

  const messages = Array.isArray(body?.messages) ? body.messages : null;
  if (!messages) {
    return {
      body: null,
      summary: {
        applied: false,
        reason: 'missing_messages',
        originalChars: 0,
        compressedBodyChars: 0,
        imagedChars: 0,
        imageCount: 0,
        imageBytes: 0,
        tokensBeforeEst: 0,
        tokensAfterEst: 0,
        tokensSavedEst: 0,
        savedPct: 0,
        durationMs: 0,
      },
    };
  }

  const result = compressMessagesWithPxpipeVision(messages, {
    model: options?.model,
    provider: options?.provider,
    minChars: options?.minChars,
    enabled: true,
    format: 'claude',
  });

  if (!result.summary.applied) {
    return { body: null, summary: result.summary };
  }

  return {
    body: { ...body, messages: result.messages },
    summary: result.summary,
  };
}

export function formatPxpipeLog(summary?: PxpipeCompressionResult | null): string | null {
  if (!summary || !summary.applied) return null;
  return `[PXPIPE] imaged ${summary.imagedChars}ch → ${summary.imageCount} image(s) | est ${summary.tokensBeforeEst}→${summary.tokensAfterEst} tok (-${summary.savedPct}%) in ${summary.durationMs}ms`;
}

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
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/([-=_*~]){5,}/g, '$1$1$1$1');
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
    imagedChars: 0,
    imageCount: 0,
    imageBytes: 0,
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
