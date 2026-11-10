import { getSetting, setSetting } from '../../db/index.js';

export const RTK_SETTING_KEY = 'x_rtk_enabled';

// Constants
const DETECT_WINDOW = 4096;
const SMART_TRUNCATE_MIN_LINES = 40;
const TRUNCATE_HEAD_LINES = 25;
const TRUNCATE_TAIL_LINES = 15;
const STATUS_MAX_FILES = 8;
const STATUS_MAX_UNTRACKED = 5;
const GREP_PER_FILE_MAX = 5;
const FIND_PER_DIR_MAX = 10;
const FIND_TOTAL_DIR_MAX = 20;
const TREE_MAX_LINES = 100;
const DEDUP_LINE_MAX = 150;
const GIT_LOG_MAX_LINES = 100;
const LS_NOISE_DIRS = ['node_modules', '.git', '.next', 'dist', 'build', 'target', '.turbo', '.cache'];
const LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;
export const SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;

// Regex patterns
const RE_GIT_DIFF = /^diff --git /m;
const RE_GIT_DIFF_HUNK = /^@@ /m;
const RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
const RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
const RE_PORCELAIN = /^[ MADRCU?!][ MADRCU?!] \S/m;
const RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
const RE_TREE_GLYPH = /[├└]──|│ {2}/;
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

export function resetRtkStats(): RtkStats {
  statsState.totalCompressions = 0;
  statsState.bytesBefore = 0;
  statsState.bytesAfter = 0;
  statsState.tokensSavedEst = 0;
  statsState.filterHits = {};
  return getRtkStats();
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
// Filters ported from 9Router (open-sse/rtk/filters/*)
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

export function filterGitLog(text: string, maxLines = GIT_LOG_MAX_LINES): string {
  if (!text) return '';
  const lines = String(text).split('\n');
  const out: string[] = [];
  let inCommit = false;
  let subjectSeen = false;

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxLines) {
      out.push(`... (+${lines.length - i} more lines truncated)`);
      break;
    }
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      out.push(line);
      continue;
    }

    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        out.push(trimmed);
        continue;
      }
      if (trimmed === '') continue;
      if (!subjectSeen && /^[*|/\\ ]* {4}\S/.test(line)) {
        out.push('  Subject: ' + trimmed);
        subjectSeen = true;
        continue;
      }
      if (/^\d+ file\w* changed/.test(trimmed)) {
        out.push('  ' + trimmed);
        continue;
      }
      if (/^diff --git /.test(trimmed)) {
        out.push('  ... diff body omitted');
        inCommit = false;
        continue;
      }
    }
  }
  return out.length > 0 ? out.join('\n') : text;
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

export function filterGrep(input: string, maxPerFile = GREP_PER_FILE_MAX): string {
  const byFile = new Map<string, Array<[string, string]>>();
  let total = 0;

  for (const line of input.split('\n')) {
    const first = line.indexOf(':');
    if (first === -1) continue;
    const second = line.indexOf(':', first + 1);
    if (second === -1) continue;
    const file = line.slice(0, first);
    const lineNumStr = line.slice(first + 1, second);
    const content = line.slice(second + 1);
    if (!/^\d+$/.test(lineNumStr)) continue;
    total++;
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push([lineNumStr, content]);
  }

  if (total === 0) return input;

  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:\n\n`;

  for (const file of files) {
    const matches = byFile.get(file)!;
    out += `[file] ${file} (${matches.length}):\n`;
    const show = matches.slice(0, maxPerFile);
    for (const [lineNum, content] of show) {
      out += `  ${lineNum.padStart(4)}: ${content.trim()}\n`;
    }
    if (matches.length > maxPerFile) {
      out += `  +${matches.length - maxPerFile}\n`;
    }
    out += '\n';
  }

  return out.trimEnd();
}

export function filterFind(input: string, perDirMax = FIND_PER_DIR_MAX, totalDirMax = FIND_TOTAL_DIR_MAX): string {
  const lines = input.split('\n').filter(l => l.trim());
  if (lines.length === 0) return input;

  const byDir = new Map<string, string[]>();

  for (const path of lines) {
    const lastSep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    let dir: string;
    let basename: string;
    if (lastSep === -1) {
      dir = '.';
      basename = path;
    } else {
      dir = path.slice(0, lastSep) || '/';
      basename = path.slice(lastSep + 1);
    }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(basename);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:\n\n`;

  const showDirs = dirs.slice(0, totalDirMax);
  for (const dir of showDirs) {
    const files = byDir.get(dir)!;
    const dirLabel = dir.replace(/\\/g, '/');
    out += `${dirLabel}/  (${files.length})\n`;
    const showFiles = files.slice(0, perDirMax);
    for (const f of showFiles) out += `  ${f}\n`;
    if (files.length > perDirMax) {
      out += `  +${files.length - perDirMax}\n`;
    }
  }
  if (dirs.length > totalDirMax) {
    out += `\n+${dirs.length - totalDirMax} more dirs\n`;
  }

  return out.trimEnd();
}

export function filterTree(input: string, maxLines = TREE_MAX_LINES): string {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  const filtered: string[] = [];
  for (const line of lines) {
    if (line.includes('director') && line.includes('file')) continue;
    if (line.trim() === '' && filtered.length === 0) continue;
    filtered.push(line);
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === '') {
    filtered.pop();
  }

  if (filtered.length > maxLines) {
    const cut = filtered.length - maxLines;
    return filtered.slice(0, maxLines).join('\n') + `\n... +${cut} more lines`;
  }

  return filtered.join('\n');
}

function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

function parseLsLine(line: string): { fileType: string; size: number; name: string } | null {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const beforeDate = line.slice(0, m.index);
  const beforeParts = beforeDate.split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;

  const perms = beforeParts[0];
  const fileType = perms.charAt(0);

  let size = 0;
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const n = Number(beforeParts[i]);
    if (Number.isInteger(n) && String(n) === beforeParts[i]) { size = n; break; }
  }
  return { fileType, size, name };
}

export function filterLs(input: string): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];

  for (const line of input.split('\n')) {
    if (line.startsWith('total ') || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === '.' || parsed.name === '..') continue;
    if (LS_NOISE_DIRS.includes(parsed.name)) continue;

    if (parsed.fileType === 'd') {
      dirs.push(parsed.name);
    } else if (parsed.fileType === '-' || parsed.fileType === 'l') {
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }

  if (dirs.length === 0 && files.length === 0) return input;

  let out = '';
  if (dirs.length > 0) {
    out += `dirs (${dirs.length}): ${dirs.sort().join('  ')}\n`;
  }
  if (files.length > 0) {
    out += `files (${files.length}):\n`;
    for (const [name, size] of files.slice(0, 30)) {
      out += `  ${name} (${size})\n`;
    }
    if (files.length > 30) {
      out += `  +${files.length - 30} more files\n`;
    }
  }
  return out.trim();
}

export function filterSearchList(input: string): string {
  const lines = input.split('\n');
  if (lines.length === 0) return input;

  const header = lines[0] || '';
  const rest = lines.slice(1);

  const paths: string[] = [];
  for (const raw of rest) {
    const t = raw.trim();
    if (!t.startsWith('- ')) continue;
    paths.push(t.slice(2));
  }
  if (paths.length === 0) return input;

  const byDir = new Map<string, string[]>();
  for (const p of paths) {
    const slash = p.lastIndexOf('/');
    const dir = slash === -1 ? '.' : (p.slice(0, slash) || '/');
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir)!.push(name);
  }

  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}\n${paths.length} files in ${dirs.length} dirs:\n\n`;

  for (const dir of dirs.slice(0, 20)) {
    const names = byDir.get(dir)!;
    out += `${dir}/ (${names.length}):\n`;
    for (const n of names.slice(0, 10)) out += `  ${n}\n`;
    if (names.length > 10) {
      out += `  +${names.length - 10}\n`;
    }
    out += '\n';
  }
  if (dirs.length > 20) {
    out += `+${dirs.length - 20} more dirs\n`;
  }

  return out.replace(/\n+$/, '');
}

export function filterDedupLog(input: string, maxLines = DEDUP_LINE_MAX): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let prev: string | null = null;
  let runCount = 0;
  let blankStreak = 0;

  const flushRun = () => {
    if (prev !== null && runCount > 1) {
      out.push(`  ... (${runCount - 1} duplicate lines)`);
    }
  };

  for (const line of lines) {
    if (line.trim() === '') {
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount += 1;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= maxLines) {
      out.push(`... (truncated at ${maxLines} lines)`);
      return out.join('\n');
    }
  }
  flushRun();
  return out.join('\n');
}

export function filterReadNumbered(input: string): string {
  const lines = input.split('\n');
  const out: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
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

function countMatches(str: string, regex: RegExp): number {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const m = str.match(re);
  return m ? m.length : 0;
}

function isGrepLine(line: string): boolean {
  const first = line.indexOf(':');
  if (first === -1) return false;
  const second = line.indexOf(':', first + 1);
  if (second === -1) return false;
  const lineno = line.slice(first + 1, second);
  return /^\d+$/.test(lineno);
}

function isPathLike(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(':')) return false;
  return t.startsWith('.') || t.startsWith('/') || t.includes('/');
}

function isLineNumbered(lines: string[]): boolean {
  let count = 0;
  for (const l of lines) {
    if (/^\s*\d+[\s:|]/.test(l)) count++;
  }
  return lines.length > 0 && count / lines.length >= 0.5;
}

function isMostlyPorcelain(head: string): boolean {
  const lines = head.split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter(l => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.5;
}

export function autoDetectFilter(text: string): { name: string; run: (input: string) => string } | null {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;

  // 1. git-log
  if (RE_GIT_LOG.test(head)) return { name: 'git-log', run: filterGitLog };

  // 2. git-diff
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) {
    return { name: 'git-diff', run: filterGitDiff };
  }

  // 3. git-status (long form)
  if (RE_GIT_STATUS.test(head)) {
    return { name: 'git-status', run: filterGitStatus };
  }

  // 4. Build output BEFORE porcelain check
  if (RE_BUILD_OUTPUT.test(head)) {
    return { name: 'build-output', run: filterBuildOutput };
  }

  // 5. git-status (porcelain form)
  if (isMostlyPorcelain(head)) {
    return { name: 'git-status', run: filterGitStatus };
  }

  const lines = head.split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0);

  // 6. grep: first 5 non-empty lines, ANY matches file:number:content
  const first5 = nonEmpty.slice(0, 5);
  if (first5.some(isGrepLine)) {
    return { name: 'grep', run: filterGrep };
  }

  // 7. find: ALL non-empty lines path-like, >=3 lines
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) {
    return { name: 'find', run: filterFind };
  }

  // 8. tree glyphs
  if (RE_TREE_GLYPH.test(head)) {
    return { name: 'tree', run: filterTree };
  }

  // 9. ls -la
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) {
    return { name: 'ls', run: filterLs };
  }

  // 10. search-list (Cursor glob)
  if (SEARCH_LIST_HEADER_RE.test(head)) {
    return { name: 'search-list', run: filterSearchList };
  }

  // 11. read-numbered
  if (lines.length >= 10 && isLineNumbered(lines)) {
    return { name: 'read-numbered', run: filterReadNumbered };
  }

  // 12. dedup-log for generic multi-line noise
  if (nonEmpty.length >= 5) {
    return { name: 'dedup-log', run: filterDedupLog };
  }

  // 13. smart-truncate fallback
  if (text.split('\n').length >= SMART_TRUNCATE_MIN_LINES) {
    return { name: 'smart-truncate', run: smartTruncate };
  }

  return null;
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

    // Safety: never return empty, never grow the input
    if (!compressed || compressed.length === 0 || bytesAfter >= bytesBefore) {
      return { compressed: raw, filter: detector.name, bytesBefore, bytesAfter: bytesBefore, bytesSaved: 0, savedPct: 0 };
    }

    const savedPct = bytesBefore > 0 ? Math.round((bytesSaved / bytesBefore) * 100) : 0;
    recordRtkCompression(detector.name, bytesBefore, bytesAfter);

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

    // Shape 4: OpenAI Responses format — { type: 'function_call_output', output: string | [{type: 'input_text', text: string}] }
    if (m.type === 'function_call_output') {
      if (typeof m.output === 'string') {
        const res = compressToolOutput(m.output);
        if (res.bytesSaved > 0) {
          m.output = res.compressed;
          totalBefore += res.bytesBefore;
          totalAfter += res.bytesAfter;
          hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
        }
      } else if (Array.isArray(m.output)) {
        for (const part of m.output) {
          if (part && typeof part === 'object' && (part as any).type === 'input_text' && typeof (part as any).text === 'string') {
            const res = compressToolOutput((part as any).text);
            if (res.bytesSaved > 0) {
              (part as any).text = res.compressed;
              totalBefore += res.bytesBefore;
              totalAfter += res.bytesAfter;
              hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
            }
          }
        }
      }
      continue;
    }

    // Shape 1: OpenAI tool message — { role: 'tool', content: string }
    if (m.role === 'tool' && typeof m.content === 'string') {
      const res = compressToolOutput(m.content);
      if (res.bytesSaved > 0) {
        m.content = res.compressed;
        totalBefore += res.bytesBefore;
        totalAfter += res.bytesAfter;
        hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
      }
      continue;
    }

    // Shape 1b: OpenAI tool message with array content — { role: 'tool', content: [{ type: 'text', text: string }] }
    if (m.role === 'tool' && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string') {
          const res = compressToolOutput((part as any).text);
          if (res.bytesSaved > 0) {
            (part as any).text = res.compressed;
            totalBefore += res.bytesBefore;
            totalAfter += res.bytesAfter;
            hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
          }
        }
      }
      continue;
    }

    // Shape 2 & 3: Blocks array with tool_result entries (Anthropic / Claude)
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type !== 'tool_result') continue;
        if (b.is_error === true || b.status === 'error') continue; // PRESERVE ERROR OUTPUT

        // String content
        if (typeof b.content === 'string') {
          const res = compressToolOutput(b.content);
          if (res.bytesSaved > 0) {
            b.content = res.compressed;
            totalBefore += res.bytesBefore;
            totalAfter += res.bytesAfter;
            hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
          }
        } else if (Array.isArray(b.content)) {
          // Array content: each { type: 'text', text: string }
          for (const part of b.content) {
            if (part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string') {
              const res = compressToolOutput((part as any).text);
              if (res.bytesSaved > 0) {
                (part as any).text = res.compressed;
                totalBefore += res.bytesBefore;
                totalAfter += res.bytesAfter;
                hits.push({ filter: res.filter, before: res.bytesBefore, after: res.bytesAfter });
              }
            }
          }
        }
      }
    }
  }

  if (hits.length === 0) return null;
  return { bytesBefore: totalBefore, bytesAfter: totalAfter, hits };
}
