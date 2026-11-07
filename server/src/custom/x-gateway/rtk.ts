import { getSetting, setSetting } from '../../db/index.js';

export const RTK_SETTING_KEY = 'x_rtk_enabled';

// Constants
const DETECT_WINDOW = 4096;
const SMART_TRUNCATE_MIN_LINES = 40;
const TRUNCATE_HEAD_LINES = 25;
const TRUNCATE_TAIL_LINES = 15;
const STATUS_MAX_FILES = 8;
const STATUS_MAX_UNTRACKED = 5;

// Regex patterns
const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│  /;
const RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
const RE_LS_TOTAL = /^total \d+$/m;
const RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;

// Global stats tracker
export interface RtkStats {
  totalCompressions: number;
  bytesBefore: number;
  bytesAfter: number;
  tokensSavedEst: number;
  filterHits: Record<string, number>;
}

const statsState: RtkStats = {
  totalCompressions: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  tokensSavedEst: 0,
  filterHits: {},
};

let memoryRtkEnabled: boolean | null = null;

export function isRtkEnabled(): boolean {
  if (memoryRtkEnabled !== null) return memoryRtkEnabled;
  try {
    const val = getSetting(RTK_SETTING_KEY);
    if (val === undefined || val === '') return true; // Default ON
    const enabled = val === '1' || val === 'true';
    memoryRtkEnabled = enabled;
    return enabled;
  } catch {
    return true;
  }
}

export function setRtkEnabled(enabled: boolean): void {
  memoryRtkEnabled = enabled;
  try {
    setSetting(RTK_SETTING_KEY, enabled ? '1' : '0');
  } catch {
    // If db write fails, fail gracefully
  }
}

export function getRtkStats(): RtkStats {
  return { ...statsState, filterHits: { ...statsState.filterHits } };
}

export function recordRtkCompression(filter: string, before: number, after: number): void {
  const savedBytes = Math.max(0, before - after);
  statsState.totalCompressions += 1;
  statsState.bytesBefore += before;
  statsState.bytesAfter += after;
  statsState.tokensSavedEst += Math.round(savedBytes / 4);
  statsState.filterHits[filter] = (statsState.filterHits[filter] || 0) + 1;
}

// -------------------------------------------------------------
// Filters
// -------------------------------------------------------------

export function filterGitStatus(input: string): string {
  const lines = input.split('\n');
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return 'Clean working tree';
  }

  let branch = '';
  const stagedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) { branch = longBranch[1]; continue; }
    if (raw.startsWith('##')) { branch = raw.replace(/^##\s*/, ''); continue; }

    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3).trim();

      if (raw.slice(0, 2) === '??') {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }
      if ('MADRC'.includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === 'U') {
        conflicts++;
      }
      if (y === 'M' || y === 'D') {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }

    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1];
      const path = longMatch[2].trim();
      if (kind === 'both modified') conflicts++;
      else if (kind === 'modified' || kind === 'deleted') { modified++; modifiedFiles.push(path); }
      else if (kind === 'new file' || kind === 'renamed') { staged++; stagedFiles.push(path); }
    }
  }

  const out: string[] = [];
  if (branch) out.push(`* ${branch}`);
  if (staged > 0) {
    out.push(`+ Staged: ${staged} files`);
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out.push(`   ${f}`);
    if (stagedFiles.length > STATUS_MAX_FILES) out.push(`   ... +${stagedFiles.length - STATUS_MAX_FILES} more`);
  }
  if (modified > 0) {
    out.push(`~ Modified: ${modified} files`);
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out.push(`   ${f}`);
    if (modifiedFiles.length > STATUS_MAX_FILES) out.push(`   ... +${modifiedFiles.length - STATUS_MAX_FILES} more`);
  }
  if (untracked > 0) {
    out.push(`? Untracked: ${untracked} files`);
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out.push(`   ${f}`);
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) out.push(`   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more`);
  }
  if (conflicts > 0) {
    out.push(`! Conflicts: ${conflicts} files`);
  }
  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out.push('Clean working tree (nothing to commit)');
  }
  return out.join('\n');
}

export function filterGitDiff(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      out.push(`diff: ${parts[2]?.replace(/^a\//, '') || parts[parts.length - 1]}`);
      inHunk = false;
      continue;
    }
    if (line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    if (line.startsWith('@@ ')) {
      const hunkHeader = line.match(/@@\s+[-+0-9, ]+\s+@@(.*)/);
      out.push(hunkHeader ? `@@ ${hunkHeader[1].trim()}` : line);
      inHunk = true;
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+') || line.startsWith('-')) {
        out.push(line);
      }
    }
  }
  return out.length > 0 ? out.join('\n') : input;
}

export function filterBuildOutput(input: string): string {
  const lines = input.split('\n');
  if (lines.length < 5) return input;

  const errors: string[] = [];
  const warnings: string[] = [];
  const summaries: string[] = [];
  let inCargoError = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inCargoError) {
      if (!trimmed) { inCargoError = false; continue; }
      if (RE_CARGO_ERR_CONT.test(line)) { errors.push(line); continue; }
      inCargoError = false;
    }
    if (!trimmed) continue;

    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith('error -->')) {
      errors.push(line);
      inCargoError = true;
      continue;
    }
    if (/^warning(\[|:)/i.test(trimmed) || trimmed.startsWith('warning -->')) {
      warnings.push(line);
      inCargoError = true;
      continue;
    }
    if (/^ERROR:/i.test(trimmed) || /^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^\[WARNING\]/i.test(trimmed) || /^npm warn/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }
    if (
      /^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) ||
      /^\s*Finished\s+/i.test(trimmed) ||
      /^BUILD SUCCESS/i.test(trimmed) ||
      /^Successfully (installed|built)/i.test(trimmed) ||
      /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed)
    ) {
      summaries.push(line);
      continue;
    }
  }

  const result: string[] = [];
  if (errors.length > 0) {
    result.push('--- ERRORS ---');
    result.push(...errors.slice(0, 30));
    if (errors.length > 30) result.push(`... and ${errors.length - 30} more error lines`);
  }
  if (warnings.length > 0) {
    result.push('--- WARNINGS ---');
    result.push(...warnings.slice(0, 15));
    if (warnings.length > 15) result.push(`... and ${warnings.length - 15} more warnings`);
  }
  if (summaries.length > 0) {
    result.push('--- SUMMARY ---');
    result.push(...summaries);
  }

  return result.length > 0 ? result.join('\n') : smartTruncate(input);
}

export function filterReadNumbered(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    // Strip "  123 | code" or "123: code" or "123  code"
    const cleaned = line.replace(/^\s*\d+[\s:|]+/, '');
    if (!cleaned.trim()) {
      blankCount++;
      if (blankCount <= 1) out.push('');
      continue;
    }
    blankCount = 0;
    out.push(cleaned);
  }
  return out.join('\n');
}

export function smartTruncate(input: string): string {
  const lines = input.split('\n');
  if (lines.length <= SMART_TRUNCATE_MIN_LINES) return input;

  const head = lines.slice(0, TRUNCATE_HEAD_LINES);
  const tail = lines.slice(-TRUNCATE_TAIL_LINES);
  const dropped = lines.length - (TRUNCATE_HEAD_LINES + TRUNCATE_TAIL_LINES);

  return [
    ...head,
    `... [RTK: ${dropped} lines compressed/truncated for context brevity] ...`,
    ...tail,
  ].join('\n');
}

// -------------------------------------------------------------
// Autodetect & Compression Dispatcher
// -------------------------------------------------------------

export function autoDetectFilter(text: string): { name: string; run: (input: string) => string } | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  if (RE_GIT_LOG.test(head)) {
    return { name: 'git-log', run: input => smartTruncate(input) };
  }
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) {
    return { name: 'git-diff', run: filterGitDiff };
  }
  if (RE_GIT_STATUS.test(head) || isMostlyPorcelain(head)) {
    return { name: 'git-status', run: filterGitStatus };
  }
  if (RE_BUILD_OUTPUT.test(head)) {
    return { name: 'build-output', run: filterBuildOutput };
  }
  if (RE_TREE_GLYPH.test(head) || RE_LS_TOTAL.test(head) || RE_LS_ROW.test(head)) {
    return { name: 'directory-list', run: smartTruncate };
  }

  const lines = head.split('\n');
  if (lines.length >= 10 && lines.some(l => /^\s*\d+[\s:|]/.test(l))) {
    return { name: 'read-numbered', run: filterReadNumbered };
  }
  if (lines.length >= SMART_TRUNCATE_MIN_LINES) {
    return { name: 'smart-truncate', run: smartTruncate };
  }

  return null;
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter(l => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.5;
}

export function compressToolOutput(raw: string): {
  compressed: string;
  filter: string;
  bytesBefore: number;
  bytesAfter: number;
  bytesSaved: number;
  savedPct: number;
} {
  const bytesBefore = Buffer.byteLength(raw, 'utf8');
  if (bytesBefore < 100) {
    return { compressed: raw, filter: 'passthrough', bytesBefore, bytesAfter: bytesBefore, bytesSaved: 0, savedPct: 0 };
  }

  const detector = autoDetectFilter(raw);
  if (!detector) {
    return { compressed: raw, filter: 'none', bytesBefore, bytesAfter: bytesBefore, bytesSaved: 0, savedPct: 0 };
  }

  try {
    const compressed = detector.run(raw);
    const bytesAfter = Buffer.byteLength(compressed, 'utf8');
    const bytesSaved = Math.max(0, bytesBefore - bytesAfter);
    const savedPct = bytesBefore > 0 ? Math.round((bytesSaved / bytesBefore) * 100) : 0;

    if (bytesSaved > 0) {
      recordRtkCompression(detector.name, bytesBefore, bytesAfter);
    }

    return {
      compressed,
      filter: detector.name,
      bytesBefore,
      bytesAfter,
      bytesSaved,
      savedPct,
    };
  } catch {
    return { compressed: raw, filter: 'error', bytesBefore, bytesAfter: bytesBefore, bytesSaved: 0, savedPct: 0 };
  }
}

export function compressMessages(body: unknown, enabled?: boolean): {
  bytesBefore: number;
  bytesAfter: number;
  hits: Array<{ filter: string; before: number; after: number }>;
} | null {
  const isEnabled = enabled !== undefined ? enabled : isRtkEnabled();
  if (!isEnabled || !body || typeof body !== 'object') return null;

  const target = body as { messages?: unknown[]; input?: unknown[] };
  const items = Array.isArray(target.messages) ? target.messages : Array.isArray(target.input) ? target.input : null;
  if (!items) return null;

  let totalBefore = 0;
  let totalAfter = 0;
  const hits: Array<{ filter: string; before: number; after: number }> = [];

  for (const msg of items) {
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;

    // Shape 1: OpenAI tool message: { role: 'tool', content: string }
    if (m.role === 'tool' && typeof m.content === 'string') {
      const res = compressToolOutput(m.content);
      if (res.bytesSaved > 0) {
        m.content = res.compressed;
        totalBefore += res.bytesBefore;
        totalAfter += res.bytesAfter;
        hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
      }
    }

    // Shape 2: Anthropic / OpenAI tool_result blocks in content array
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_result' && typeof b.content === 'string' && b.is_error !== true) {
          const res = compressToolOutput(b.content);
          if (res.bytesSaved > 0) {
            b.content = res.compressed;
            totalBefore += res.bytesBefore;
            totalAfter += res.bytesAfter;
            hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
          }
        }
      }
    }
  }

  if (hits.length === 0) return null;
  return { bytesBefore: totalBefore, bytesAfter: totalAfter, hits };
}
