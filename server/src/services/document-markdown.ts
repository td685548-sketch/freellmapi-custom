import path from 'node:path';
import zlib from 'node:zlib';
import {
  DOCUMENT_MARKDOWN_LIMITS,
  type DocumentConversionErrorCode,
  type DocumentMarkdownConversionResult,
  type DocumentSourceFormat,
} from '@freellmapi/shared/document-markdown.js';

export class DocumentConversionError extends Error {
  readonly status: number;
  readonly code: DocumentConversionErrorCode;

  constructor(status: number, code: DocumentConversionErrorCode, message: string) {
    super(message);
    this.name = 'DocumentConversionError';
    this.status = status;
    this.code = code;
  }
}

const MAX_XML_NODES = 500_000;
const MAX_XML_DEPTH = 256;
const MONOSPACE_FONT_RE = /(?:consolas|courier|menlo|monaco|mono|fira\s*code|source\s*code|jetbrains|hack|inconsolata|lucida\s*console)/i;

function stripControlChars(input: string, preserveNewlines = false): string {
  let out = '';
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code === 0x09) {
      out += preserveNewlines ? ' ' : ' ';
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      out += preserveNewlines ? input[i] : ' ';
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += ' ';
      continue;
    }
    out += input[i];
  }
  return out;
}

export function deriveDocumentTitle(filename: string): string {
  const base = path.posix.basename(String(filename || '').replace(/\\/g, '/'));
  const stem = base.replace(/\.[^.]+$/, '');
  const cleaned = stripControlChars(stem.normalize('NFC')).replace(/\s+/g, ' ').trim().slice(0, 200).trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return 'Untitled Document';
  return cleaned;
}

// ---------------------------------------------------------------------------
// Safe ZIP parser (node:zlib only, zip-bomb & encrypted-entry hardened)
// ---------------------------------------------------------------------------

interface ZipIndex {
  entryNames: Set<string>;
  files: Map<string, string>;
  lowerToExact: Map<string, string>;
}

function normalizeZipPath(rawName: string): string | null {
  if (!rawName || rawName.includes('\0')) return null;
  const slashed = rawName.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const parts = slashed.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) return null;
  return parts.join('/');
}

function readZipXmlEntries(
  buf: Buffer,
  shouldExtract: (lowerPath: string) => boolean,
): ZipIndex {
  const minEocdSize = 22;
  if (buf.length < minEocdSize) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'File is too small to be a valid Office archive.');
  }

  const searchStart = Math.max(0, buf.length - (minEocdSize + 65_535));
  let eocdOffset = -1;
  for (let pos = buf.length - minEocdSize; pos >= searchStart; pos -= 1) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(pos + 20);
      if (pos + minEocdSize + commentLen === buf.length) {
        eocdOffset = pos;
        break;
      }
    }
  }
  if (eocdOffset === -1) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'Corrupted Office archive: missing ZIP directory.');
  }

  const diskNumber = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const diskEntries = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (
    diskNumber !== 0 ||
    cdDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'Unsupported or corrupted ZIP64/multi-disk archive.');
  }

  if (totalEntries > DOCUMENT_MARKDOWN_LIMITS.maxZipEntries) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'Archive exceeds the maximum entry count.');
  }

  const cdEnd = cdOffset + cdSize;
  if (cdOffset > eocdOffset || cdEnd > eocdOffset) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'Corrupted Office archive central directory bounds.');
  }

  const entryNames = new Set<string>();
  const files = new Map<string, string>();
  const lowerToExact = new Map<string, string>();
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
  let totalUncompressed = 0;
  let cursor = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > cdEnd || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new DocumentConversionError(422, 'corrupted_archive', 'Corrupted central directory entry in Office archive.');
    }

    const gpFlag = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);

    const nextCursor = cursor + 46 + nameLen + extraLen + commentLen;
    if (nextCursor > cdEnd) {
      throw new DocumentConversionError(422, 'corrupted_archive', 'Truncated central directory entry in Office archive.');
    }

    if ((gpFlag & 0x0001) !== 0) {
      throw new DocumentConversionError(
        415,
        'password_protected_document',
        'Password-protected Office documents cannot be converted. Remove the password and try again.',
      );
    }

    const rawName = utf8Decoder.decode(buf.subarray(cursor + 46, cursor + 46 + nameLen));
    cursor = nextCursor;

    const normalized = normalizeZipPath(rawName);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
    entryNames.add(lower);
    if (!lowerToExact.has(lower)) lowerToExact.set(lower, normalized);

    if (lower.endsWith('/') || !shouldExtract(lower)) continue;

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      uncompressedSize > DOCUMENT_MARKDOWN_LIMITS.maxEntryUncompressedBytes
    ) {
      throw new DocumentConversionError(
        413,
        'file_too_large',
        'An XML part inside the Office file exceeds the maximum uncompressed size.',
      );
    }

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new DocumentConversionError(422, 'corrupted_archive', 'Corrupted local file header in Office archive.');
    }

    const lfhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lfhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > cdOffset || dataEnd > cdOffset) {
      throw new DocumentConversionError(422, 'corrupted_archive', 'Corrupted entry data range in Office archive.');
    }

    const slice = buf.subarray(dataStart, dataEnd);
    let rawBytes: Buffer;
    if (method === 0) {
      if (slice.length > DOCUMENT_MARKDOWN_LIMITS.maxEntryUncompressedBytes) {
        throw new DocumentConversionError(413, 'file_too_large', 'Document XML part exceeds size limit.');
      }
      rawBytes = slice;
    } else if (method === 8) {
      try {
        rawBytes = zlib.inflateRawSync(slice, {
          maxOutputLength: DOCUMENT_MARKDOWN_LIMITS.maxEntryUncompressedBytes,
        });
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'ERR_BUFFER_TOO_SMALL' || err instanceof RangeError) {
          throw new DocumentConversionError(
            413,
            'file_too_large',
            'Document XML part exceeds maximum uncompressed size limit.',
          );
        }
        throw new DocumentConversionError(422, 'corrupted_archive', 'Failed to decompress Office archive XML entry.');
      }
    } else {
      throw new DocumentConversionError(
        415,
        'unsupported_format',
        `Unsupported ZIP compression method (${method}) in Office archive.`,
      );
    }

    totalUncompressed += rawBytes.length;
    if (totalUncompressed > DOCUMENT_MARKDOWN_LIMITS.maxTotalUncompressedBytes) {
      throw new DocumentConversionError(
        413,
        'file_too_large',
        'Total decompressed XML content exceeds the 32 MiB safety limit.',
      );
    }

    files.set(lower, utf8Decoder.decode(rawBytes));
  }

  return { entryNames, files, lowerToExact };
}

// ---------------------------------------------------------------------------
// Safe lightweight XML tree parser (zero DTD/XXE evaluation)
// ---------------------------------------------------------------------------

interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<XmlNode | string>;
}

const NAMED_XML_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function isValidXmlCodePoint(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  return cp >= 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
}

function decodeXmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const cp = Number.parseInt(entity.slice(2), 16);
      return isValidXmlCodePoint(cp) ? String.fromCodePoint(cp) : '';
    }
    if (entity.startsWith('#')) {
      const cp = Number.parseInt(entity.slice(1), 10);
      return isValidXmlCodePoint(cp) ? String.fromCodePoint(cp) : '';
    }
    return NAMED_XML_ENTITIES[entity] ?? full;
  });
}

function xmlLocalName(rawName: string): string {
  const colon = rawName.indexOf(':');
  return colon >= 0 ? rawName.slice(colon + 1) : rawName;
}

function parseXmlAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!rawAttrs) return attrs;
  const re = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawAttrs)) !== null) {
    const rawKey = match[1]!;
    const rawVal = match[2] ?? match[3] ?? '';
    const decoded = decodeXmlEntities(rawVal);
    attrs[rawKey] = decoded;
    const localKey = xmlLocalName(rawKey);
    if (!(localKey in attrs)) {
      attrs[localKey] = decoded;
    }
  }
  return attrs;
}

function parseXmlDocument(xmlText: string): XmlNode {
  const xml = xmlText.startsWith('\uFEFF') ? xmlText.slice(1) : xmlText;
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let nodeCount = 0;
  let i = 0;
  const len = xml.length;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      const tail = xml.slice(i);
      if (tail) stack[stack.length - 1]!.children.push(decodeXmlEntities(tail));
      break;
    }

    if (lt > i) {
      const text = xml.slice(i, lt);
      if (text) stack[stack.length - 1]!.children.push(decodeXmlEntities(text));
    }

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const cdata = end === -1 ? xml.slice(lt + 9) : xml.slice(lt + 9, end);
      if (cdata) stack[stack.length - 1]!.children.push(cdata);
      i = end === -1 ? len : end + 3;
      continue;
    }

    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }

    if (xml.startsWith('<!', lt)) {
      // Skip DOCTYPE/ENTITY declarations without expanding entities; respect nested [...]
      let pos = lt + 2;
      let bracketDepth = 0;
      let quote: string | null = null;
      while (pos < len) {
        const ch = xml[pos]!;
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === '[') {
          bracketDepth += 1;
        } else if (ch === ']') {
          if (bracketDepth > 0) bracketDepth -= 1;
        } else if (ch === '>' && bracketDepth === 0) {
          pos += 1;
          break;
        }
        pos += 1;
      }
      i = pos;
      continue;
    }

    // Find end of tag respecting attribute quotes
    let pos = lt + 1;
    let quote: string | null = null;
    while (pos < len) {
      const ch = xml[pos]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      pos += 1;
    }
    if (pos >= len) break;

    const tagContent = xml.slice(lt + 1, pos).trim();
    i = pos + 1;

    if (!tagContent) continue;

    if (tagContent.startsWith('/')) {
      const closingLocal = xmlLocalName(tagContent.slice(1).trim());
      for (let s = stack.length - 1; s >= 1; s -= 1) {
        if (stack[s]!.tag === closingLocal) {
          stack.length = s;
          break;
        }
      }
      continue;
    }

    const selfClosing = tagContent.endsWith('/');
    const body = selfClosing ? tagContent.slice(0, -1).trim() : tagContent;
    const spaceIdx = body.search(/\s/);
    const rawName = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const rawAttrs = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1);
    const tag = xmlLocalName(rawName);
    if (!tag) continue;

    nodeCount += 1;
    if (nodeCount > MAX_XML_NODES) {
      throw new DocumentConversionError(413, 'file_too_large', 'Document XML structure exceeds node limit.');
    }

    const node: XmlNode = { tag, attrs: parseXmlAttributes(rawAttrs), children: [] };
    stack[stack.length - 1]!.children.push(node);

    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new DocumentConversionError(422, 'corrupted_archive', 'Document XML nesting exceeds depth limit.');
      }
      stack.push(node);
    }
  }

  return root;
}

function isXmlNode(v: XmlNode | string): v is XmlNode {
  return typeof v !== 'string';
}

function childNodes(node: XmlNode | undefined, tag?: string): XmlNode[] {
  if (!node) return [];
  const out: XmlNode[] = [];
  for (const ch of node.children) {
    if (isXmlNode(ch) && (!tag || ch.tag === tag)) out.push(ch);
  }
  return out;
}

function findChild(node: XmlNode | undefined, tag: string): XmlNode | undefined {
  if (!node) return undefined;
  for (const ch of node.children) {
    if (isXmlNode(ch) && ch.tag === tag) return ch;
  }
  return undefined;
}

function nodeText(node: XmlNode | undefined): string {
  if (!node) return '';
  let out = '';
  for (const ch of node.children) {
    out += typeof ch === 'string' ? ch : nodeText(ch);
  }
  return out;
}

function collectDescendants(node: XmlNode | undefined, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (!node) return out;
  for (const ch of node.children) {
    if (!isXmlNode(ch)) continue;
    if (ch.tag === tag) out.push(ch);
    collectDescendants(ch, tag, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared Markdown Helpers
// ---------------------------------------------------------------------------

function renderMarkdownTable(rawRows: string[][]): string {
  if (rawRows.length === 0) return '';
  const colCount = Math.min(
    DOCUMENT_MARKDOWN_LIMITS.maxSheetCols,
    Math.max(1, ...rawRows.map((r) => r.length)),
  );
  const formatRow = (row: string[]) => {
    const cells: string[] = [];
    for (let c = 0; c < colCount; c += 1) {
      const raw = String(row[c] ?? '');
      const clean = stripControlChars(raw.replace(/\r\n?/g, '\n'), true)
        .trim()
        .replace(/\n+/g, '<br>')
        .replace(/\|/g, '\\|');
      cells.push(clean);
    }
    return `| ${cells.join(' | ')} |`;
  };
  const header = formatRow(rawRows[0] ?? []);
  const separator = `| ${Array.from({ length: colCount }, () => '---').join(' | ')} |`;
  const body = rawRows.slice(1).map(formatRow);
  return [header, separator, ...body].join('\n');
}

function trimGrid(rawRows: string[][]): string[][] {
  if (rawRows.length === 0) return [];
  let minCol = Number.POSITIVE_INFINITY;
  let maxCol = -1;
  let minRow = -1;
  let maxRow = -1;

  for (let r = 0; r < rawRows.length; r += 1) {
    const row = rawRows[r]!;
    let rowHasValue = false;
    for (let c = 0; c < row.length; c += 1) {
      if ((row[c] ?? '').trim().length > 0) {
        rowHasValue = true;
        if (c < minCol) minCol = c;
        if (c > maxCol) maxCol = c;
      }
    }
    if (rowHasValue) {
      if (minRow === -1) minRow = r;
      maxRow = r;
    }
  }

  if (minRow === -1 || maxCol < minCol) return [];
  const trimmed: string[][] = [];
  for (let r = minRow; r <= maxRow; r += 1) {
    const src = rawRows[r] ?? [];
    const out: string[] = [];
    for (let c = minCol; c <= maxCol; c += 1) {
      out.push(src[c] ?? '');
    }
    trimmed.push(out);
  }
  return trimmed;
}

function escapeMarkdownHeading(text: string): string {
  return stripControlChars(text.replace(/\r\n?/g, ' ')).replace(/\s+/g, ' ').trim();
}

function normalizeMarkdownOutput(raw: string): string {
  const lines = raw.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, ''));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// DOCX -> Markdown
// ---------------------------------------------------------------------------

interface DocxStyleInfo {
  styleId: string;
  name?: string;
  basedOn?: string;
  headingLevel?: number;
  isQuote?: boolean;
  isCode?: boolean;
  isMonospace?: boolean;
}

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  linkUrl?: string;
}

interface InlineSegment extends InlineStyle {
  text: string;
}

function isWordBoolOn(el: XmlNode | undefined): boolean {
  if (!el) return false;
  const val = el.attrs.val;
  if (val === undefined) return true;
  const lower = val.trim().toLowerCase();
  return lower !== '0' && lower !== 'false' && lower !== 'off';
}

function isSafeExternalLink(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
}

function parseDocxRels(relsXml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  const root = parseXmlDocument(relsXml);
  for (const rel of collectDescendants(root, 'Relationship')) {
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (id && target && isSafeExternalLink(target)) {
      map.set(id, target.trim());
    }
  }
  return map;
}

function parseDocxStyles(stylesXml: string | undefined): Map<string, DocxStyleInfo> {
  const raw = new Map<string, DocxStyleInfo>();
  if (!stylesXml) return raw;
  const root = parseXmlDocument(stylesXml);
  for (const styleEl of collectDescendants(root, 'style')) {
    const styleId = styleEl.attrs.styleId;
    if (!styleId) continue;
    const name = findChild(styleEl, 'name')?.attrs.val;
    const basedOn = findChild(styleEl, 'basedOn')?.attrs.val;
    const pPr = findChild(styleEl, 'pPr');
    const rPr = findChild(styleEl, 'rPr');
    const outlineVal = findChild(pPr, 'outlineLvl')?.attrs.val;
    const rFonts = findChild(rPr, 'rFonts');
    const fontStr = [rFonts?.attrs.ascii, rFonts?.attrs.hAnsi, rFonts?.attrs.cs].filter(Boolean).join(' ');
    const isMonospace = MONOSPACE_FONT_RE.test(fontStr);

    let headingLevel: number | undefined;
    const lowerName = (name ?? '').trim().toLowerCase();
    const hMatch = /^heading\s*([1-6])$/i.exec(lowerName) ?? /^heading\s*([1-6])$/i.exec(styleId) ?? /^tiêu\s*đề\s*([1-6])$/i.exec(lowerName);
    if (hMatch) {
      headingLevel = Number(hMatch[1]);
    } else if (lowerName === 'title') {
      headingLevel = 1;
    } else if (lowerName === 'subtitle') {
      headingLevel = 2;
    } else if (outlineVal !== undefined && /^[0-5]$/.test(outlineVal.trim())) {
      headingLevel = Number(outlineVal.trim()) + 1;
    }

    const isQuote = /quote|blockquote/i.test(lowerName) || /quote|blockquote/i.test(styleId);
    const isCode = /(?:^|\b)(?:code|verbatim|preformatted)(?:\b|$)/i.test(lowerName) || /code|verbatim/i.test(styleId);

    raw.set(styleId, { styleId, name, basedOn, headingLevel, isQuote, isCode, isMonospace });
  }

  // Resolve basedOn chains safely
  const resolved = new Map<string, DocxStyleInfo>();
  const resolveOne = (id: string, visiting = new Set<string>()): DocxStyleInfo | undefined => {
    const cached = resolved.get(id);
    if (cached) return cached;
    const own = raw.get(id);
    if (!own) return undefined;
    if (!own.basedOn || visiting.has(id)) {
      resolved.set(id, own);
      return own;
    }
    visiting.add(id);
    const parent = resolveOne(own.basedOn, visiting);
    const merged: DocxStyleInfo = {
      ...own,
      headingLevel: own.headingLevel ?? parent?.headingLevel,
      isQuote: own.isQuote || parent?.isQuote,
      isCode: own.isCode || parent?.isCode,
      isMonospace: own.isMonospace || parent?.isMonospace,
    };
    resolved.set(id, merged);
    return merged;
  };
  for (const id of raw.keys()) resolveOne(id);
  return resolved;
}

function parseDocxNumbering(numberingXml: string | undefined): Map<string, Map<number, 'bullet' | 'ordered'>> {
  const numMap = new Map<string, Map<number, 'bullet' | 'ordered'>>();
  if (!numberingXml) return numMap;
  const root = parseXmlDocument(numberingXml);
  const abstracts = new Map<string, Map<number, 'bullet' | 'ordered'>>();

  for (const abs of collectDescendants(root, 'abstractNum')) {
    const absId = abs.attrs.abstractNumId;
    if (!absId) continue;
    const lvlMap = new Map<number, 'bullet' | 'ordered'>();
    for (const lvl of childNodes(abs, 'lvl')) {
      const ilvl = Number(lvl.attrs.ilvl ?? '0');
      const fmt = (findChild(lvl, 'numFmt')?.attrs.val ?? '').toLowerCase();
      lvlMap.set(Number.isFinite(ilvl) ? ilvl : 0, fmt === 'bullet' || fmt === 'none' ? 'bullet' : 'ordered');
    }
    abstracts.set(absId, lvlMap);
  }

  for (const num of collectDescendants(root, 'num')) {
    const numId = num.attrs.numId;
    const absId = findChild(num, 'abstractNumId')?.attrs.val;
    if (!numId || !absId) continue;
    const base = new Map(abstracts.get(absId) ?? []);
    for (const ov of childNodes(num, 'lvlOverride')) {
      const lvl = findChild(ov, 'lvl');
      if (!lvl) continue;
      const ilvl = Number(lvl.attrs.ilvl ?? ov.attrs.ilvl ?? '0');
      const fmt = (findChild(lvl, 'numFmt')?.attrs.val ?? '').toLowerCase();
      base.set(Number.isFinite(ilvl) ? ilvl : 0, fmt === 'bullet' || fmt === 'none' ? 'bullet' : 'ordered');
    }
    numMap.set(numId, base);
  }

  return numMap;
}

function wrapInlineText(text: string, style: InlineStyle): string {
  if (!text) return '';
  if (style.linkUrl) {
    const trimmed = text.trim();
    if (!trimmed) return text;
    const lead = text.slice(0, text.indexOf(trimmed));
    const trail = text.slice(text.indexOf(trimmed) + trimmed.length);
    const inner = wrapInlineText(trimmed, { ...style, linkUrl: undefined });
    const safeText = inner.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const safeUrl = style.linkUrl.replace(/\)/g, '%29');
    return `${lead}[${safeText}](${safeUrl})${trail}`;
  }

  if (style.code) {
    const trimmed = text.trim();
    if (!trimmed) return text;
    const lead = text.slice(0, text.indexOf(trimmed));
    const trail = text.slice(text.indexOf(trimmed) + trimmed.length);
    const ticks = trimmed.includes('`') ? '``' : '`';
    const pad = trimmed.startsWith('`') || trimmed.endsWith('`') ? ' ' : '';
    return `${lead}${ticks}${pad}${trimmed}${pad}${ticks}${trail}`;
  }

  let out = text;
  const applyMarker = (s: string, marker: string): string => {
    const trimmed = s.trim();
    if (!trimmed) return s;
    const startIdx = s.indexOf(trimmed);
    const lead = s.slice(0, startIdx);
    const trail = s.slice(startIdx + trimmed.length);
    return `${lead}${marker}${trimmed}${marker}${trail}`;
  };

  if (style.bold && style.italic) {
    out = applyMarker(out, '***');
  } else if (style.bold) {
    out = applyMarker(out, '**');
  } else if (style.italic) {
    out = applyMarker(out, '*');
  }
  if (style.strike) {
    out = applyMarker(out, '~~');
  }
  return out;
}

function extractParagraphRuns(
  pNode: XmlNode,
  styles: Map<string, DocxStyleInfo>,
  rels: Map<string, string>,
  stripFormatting = false,
): string {
  const segments: InlineSegment[] = [];

  const pushSeg = (seg: InlineSegment) => {
    if (!seg.text) return;
    const prev = segments[segments.length - 1];
    if (
      prev &&
      prev.bold === seg.bold &&
      prev.italic === seg.italic &&
      prev.strike === seg.strike &&
      prev.code === seg.code &&
      prev.linkUrl === seg.linkUrl
    ) {
      prev.text += seg.text;
    } else {
      segments.push({ ...seg });
    }
  };

  const walkRun = (rNode: XmlNode, linkUrl?: string) => {
    const rPr = findChild(rNode, 'rPr');
    const rStyleId = findChild(rPr, 'rStyle')?.attrs.val;
    const rStyle = rStyleId ? styles.get(rStyleId) : undefined;
    const rFonts = findChild(rPr, 'rFonts');
    const fontStr = [rFonts?.attrs.ascii, rFonts?.attrs.hAnsi, rFonts?.attrs.cs].filter(Boolean).join(' ');
    const style: InlineStyle = stripFormatting
      ? { bold: false, italic: false, strike: false, code: false, linkUrl }
      : {
          bold: isWordBoolOn(findChild(rPr, 'b')) || isWordBoolOn(findChild(rPr, 'bCs')),
          italic: isWordBoolOn(findChild(rPr, 'i')) || isWordBoolOn(findChild(rPr, 'iCs')),
          strike: isWordBoolOn(findChild(rPr, 'strike')) || isWordBoolOn(findChild(rPr, 'dstrike')),
          code: Boolean(rStyle?.isCode || rStyle?.isMonospace || MONOSPACE_FONT_RE.test(fontStr)),
          linkUrl,
        };

    for (const ch of rNode.children) {
      if (!isXmlNode(ch)) continue;
      if (ch.tag === 't') {
        pushSeg({ text: nodeText(ch), ...style });
      } else if (ch.tag === 'tab') {
        pushSeg({ text: '\t', ...style, bold: false, italic: false, strike: false, code: false });
      } else if (ch.tag === 'br' || ch.tag === 'cr') {
        pushSeg({ text: '\n', bold: false, italic: false, strike: false, code: false, linkUrl });
      } else if (ch.tag === 'noBreakHyphen') {
        pushSeg({ text: '-', ...style });
      } else if (ch.tag === 'footnoteReference' && ch.attrs.id) {
        pushSeg({ text: `[^${ch.attrs.id}]`, bold: false, italic: false, strike: false, code: false });
      } else if (ch.tag === 'endnoteReference' && ch.attrs.id) {
        pushSeg({ text: `[^en${ch.attrs.id}]`, bold: false, italic: false, strike: false, code: false });
      }
    }
  };

  const walkChildren = (container: XmlNode, linkUrl?: string) => {
    for (const ch of container.children) {
      if (!isXmlNode(ch)) continue;
      if (ch.tag === 'pPr' || ch.tag === 'del' || ch.tag === 'moveFrom' || ch.tag === 'bookmarkStart' || ch.tag === 'bookmarkEnd') {
        continue;
      }
      if (ch.tag === 'r') {
        walkRun(ch, linkUrl);
      } else if (ch.tag === 'hyperlink') {
        const rid = ch.attrs['r:id'] ?? ch.attrs.id;
        const href = rid ? rels.get(rid) : undefined;
        walkChildren(ch, href ?? linkUrl);
      } else if (ch.tag === 'sdt') {
        const sdtContent = findChild(ch, 'sdtContent');
        if (sdtContent) walkChildren(sdtContent, linkUrl);
      } else if (ch.tag === 'ins' || ch.tag === 'smartTag' || ch.tag === 'moveTo') {
        walkChildren(ch, linkUrl);
      } else if (ch.tag === 'fldSimple') {
        const instr = ch.attrs.instr ?? '';
        const hrefMatch = /HYPERLINK\s+"([^"]+)"/i.exec(instr);
        const href = hrefMatch?.[1] && isSafeExternalLink(hrefMatch[1]) ? hrefMatch[1] : linkUrl;
        walkChildren(ch, href);
      }
    }
  };

  walkChildren(pNode);
  return segments.map((s) => wrapInlineText(s.text, s)).join('');
}

function renderDocxTable(
  tblNode: XmlNode,
  styles: Map<string, DocxStyleInfo>,
  rels: Map<string, string>,
): string {
  const rows: string[][] = [];
  for (const tr of childNodes(tblNode, 'tr')) {
    const rowCells: string[] = [];
    for (const tc of childNodes(tr, 'tc')) {
      const tcPr = findChild(tc, 'tcPr');
      const spanRaw = Number(findChild(tcPr, 'gridSpan')?.attrs.val ?? '1');
      const span = Number.isInteger(spanRaw) && spanRaw > 1 && spanRaw <= 25 ? spanRaw : 1;

      const cellParagraphs: string[] = [];
      for (const ch of tc.children) {
        if (!isXmlNode(ch)) continue;
        if (ch.tag === 'p') {
          const txt = extractParagraphRuns(ch, styles, rels).trim();
          if (txt) cellParagraphs.push(txt);
        } else if (ch.tag === 'tbl') {
          const nested = renderDocxTable(ch, styles, rels).trim();
          if (nested) cellParagraphs.push(nested.replace(/\n+/g, '<br>'));
        }
      }
      rowCells.push(cellParagraphs.join('<br>'));
      for (let s = 1; s < span; s += 1) rowCells.push('');
    }
    if (rowCells.some((c) => c.trim().length > 0)) {
      rows.push(rowCells);
    }
  }
  return renderMarkdownTable(rows);
}

function parseNotesEntries(
  notesXml: string | undefined,
  prefix: string,
  styles: Map<string, DocxStyleInfo>,
  rels: Map<string, string>,
): string[] {
  if (!notesXml) return [];
  const root = parseXmlDocument(notesXml);
  const tag = prefix === 'en' ? 'endnote' : 'footnote';
  const lines: string[] = [];
  for (const note of collectDescendants(root, tag)) {
    const type = (note.attrs.type ?? '').toLowerCase();
    if (type === 'separator' || type === 'continuationseparator' || type === 'continuationnotice') {
      continue;
    }
    const id = note.attrs.id;
    if (!id) continue;
    const textParts: string[] = [];
    for (const p of childNodes(note, 'p')) {
      const txt = extractParagraphRuns(p, styles, rels).trim();
      if (txt) textParts.push(txt);
    }
    const combined = textParts.join(' ').trim();
    if (combined) lines.push(`[^${prefix}${id}]: ${combined}`);
  }
  return lines;
}

function convertDocxToMarkdown(zip: ZipIndex, filename: string): DocumentMarkdownConversionResult {
  const docXml = zip.files.get('word/document.xml');
  if (!docXml) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'DOCX archive is missing word/document.xml.');
  }

  const styles = parseDocxStyles(zip.files.get('word/styles.xml'));
  const numbering = parseDocxNumbering(zip.files.get('word/numbering.xml'));
  const rels = parseDocxRels(zip.files.get('word/_rels/document.xml.rels'));

  const docRoot = parseXmlDocument(docXml);
  const docEl = findChild(docRoot, 'document') ?? docRoot;
  const body = findChild(docEl, 'body') ?? docEl;

  const blocks: string[] = [];
  const listCounters = new Map<string, number>();

  const getHeadingLevel = (styleId: string | undefined, pPr: XmlNode | undefined): number | undefined => {
    const outlineVal = findChild(pPr, 'outlineLvl')?.attrs.val;
    if (styleId) {
      const styleInfo = styles.get(styleId);
      if (styleInfo?.headingLevel) return styleInfo.headingLevel;
      const direct = /^heading\s*([1-6])$/i.exec(styleId) ?? /^h([1-6])$/i.exec(styleId);
      if (direct) return Number(direct[1]);
    }
    if (outlineVal !== undefined && /^[0-5]$/.test(outlineVal.trim())) {
      return Number(outlineVal.trim()) + 1;
    }
    return undefined;
  };

  let codeBuffer: string[] = [];
  const flushCodeBuffer = () => {
    if (codeBuffer.length > 0) {
      blocks.push(`\`\`\`\n${codeBuffer.join('\n')}\n\`\`\``);
      codeBuffer = [];
    }
  };

  let listGroupBuffer: string[] = [];
  const flushListBuffer = () => {
    if (listGroupBuffer.length > 0) {
      blocks.push(listGroupBuffer.join('\n'));
      listGroupBuffer = [];
    }
  };

  const processBlockContainer = (container: XmlNode) => {
    for (const ch of container.children) {
      if (!isXmlNode(ch)) continue;
      if (ch.tag === 'sdt') {
        const sdtContent = findChild(ch, 'sdtContent');
        if (sdtContent) processBlockContainer(sdtContent);
        continue;
      }
      if (ch.tag === 'ins' || ch.tag === 'smartTag') {
        processBlockContainer(ch);
        continue;
      }
      if (ch.tag === 'tbl') {
        flushCodeBuffer();
        flushListBuffer();
        const tableMd = renderDocxTable(ch, styles, rels);
        if (tableMd) blocks.push(tableMd);
        continue;
      }
      if (ch.tag !== 'p') continue;

      const pPr = findChild(ch, 'pPr');
      const styleId = findChild(pPr, 'pStyle')?.attrs.val;
      const styleInfo = styleId ? styles.get(styleId) : undefined;

      if (styleInfo?.isCode) {
        flushListBuffer();
        const rawLine = extractParagraphRuns(ch, styles, rels, true).replace(/\n+$/g, '');
        codeBuffer.push(rawLine);
        continue;
      }
      flushCodeBuffer();

      const headingLevel = getHeadingLevel(styleId, pPr);
      const numPr = findChild(pPr, 'numPr');
      const numId = findChild(numPr, 'numId')?.attrs.val;
      const ilvlRaw = Number(findChild(numPr, 'ilvl')?.attrs.val ?? '0');
      const ilvl = Number.isInteger(ilvlRaw) && ilvlRaw >= 0 ? Math.min(ilvlRaw, 8) : 0;

      const text = extractParagraphRuns(ch, styles, rels, Boolean(headingLevel)).trim();
      if (!text) continue;

      if (headingLevel) {
        flushListBuffer();
        listCounters.clear();
        blocks.push(`${'#'.repeat(Math.min(6, Math.max(1, headingLevel)))} ${escapeMarkdownHeading(text)}`);
      } else if (numId && numId !== '0') {
        const kind = numbering.get(numId)?.get(ilvl) ?? 'bullet';
        const indent = '  '.repeat(ilvl);
        const normalizedLine = text.replace(/\n+/g, `\n${indent}  `);
        if (kind === 'ordered') {
          for (const key of listCounters.keys()) {
            const [kNum, kLvl] = key.split(':');
            if (kNum === numId && Number(kLvl) > ilvl) listCounters.delete(key);
          }
          const cKey = `${numId}:${ilvl}`;
          const nextIdx = (listCounters.get(cKey) ?? 0) + 1;
          listCounters.set(cKey, nextIdx);
          listGroupBuffer.push(`${indent}${nextIdx}. ${normalizedLine}`);
        } else {
          listGroupBuffer.push(`${indent}- ${normalizedLine}`);
        }
      } else if (styleInfo?.isQuote) {
        flushListBuffer();
        blocks.push(text.split('\n').map((l) => `> ${l}`).join('\n'));
      } else {
        flushListBuffer();
        blocks.push(text);
      }
    }
  };

  processBlockContainer(body);
  flushCodeBuffer();
  flushListBuffer();

  const footnotes = parseNotesEntries(zip.files.get('word/footnotes.xml'), '', styles, rels);
  const endnotes = parseNotesEntries(zip.files.get('word/endnotes.xml'), 'en', styles, rels);
  if (footnotes.length > 0) blocks.push(footnotes.join('\n'));
  if (endnotes.length > 0) blocks.push(endnotes.join('\n'));

  const markdown = normalizeMarkdownOutput(blocks.join('\n\n'));
  return finalizeMarkdownResult({
    title: deriveDocumentTitle(filename),
    sourceFormat: 'docx',
    markdown,
    warnings: [],
  });
}

// ---------------------------------------------------------------------------
// XLSX -> Markdown
// ---------------------------------------------------------------------------

type CellFormatKind = 'general' | 'date' | 'percent';

const BUILTIN_DATE_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22,
  27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47,
  50, 51, 52, 53, 54, 55, 56, 57, 58,
]);
const BUILTIN_PERCENT_IDS = new Set([9, 10]);

function classifyNumberFormat(numFmtId: number, formatCode?: string): CellFormatKind {
  if (BUILTIN_DATE_IDS.has(numFmtId)) return 'date';
  if (BUILTIN_PERCENT_IDS.has(numFmtId)) return 'percent';
  if (!formatCode) return 'general';
  // Remove quoted text, bracketed tokens ([Red], [$-409]), and escaped characters
  const stripped = formatCode
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '');
  if (stripped.includes('%')) return 'percent';
  const hasDateChars = /[ydhs]/i.test(stripped);
  const hasNumericPlaceholder = /[#0?]/.test(stripped.replace(/\.[0]+/g, ''));
  if (hasDateChars && !hasNumericPlaceholder) return 'date';
  return 'general';
}

function parseXlsxCellXfs(stylesXml: string | undefined): CellFormatKind[] {
  if (!stylesXml) return [];
  const root = parseXmlDocument(stylesXml);
  const customFmts = new Map<number, string>();
  for (const nf of collectDescendants(root, 'numFmt')) {
    const id = Number(nf.attrs.numFmtId);
    if (Number.isInteger(id) && nf.attrs.formatCode !== undefined) {
      customFmts.set(id, nf.attrs.formatCode);
    }
  }
  const xfsNode = findChild(findChild(root, 'styleSheet') ?? root, 'cellXfs');
  if (!xfsNode) return [];
  const kinds: CellFormatKind[] = [];
  for (const xf of childNodes(xfsNode, 'xf')) {
    const id = Number(xf.attrs.numFmtId ?? '0');
    kinds.push(classifyNumberFormat(Number.isFinite(id) ? id : 0, customFmts.get(id)));
  }
  return kinds;
}

function formatExcelSerialDate(serial: number, date1904: boolean): string {
  const wholeDays = Math.floor(serial);
  const fracDay = serial - wholeDays;
  let totalSeconds = Math.round(fracDay * 86_400);
  let dayCarry = 0;
  if (totalSeconds >= 86_400) {
    totalSeconds -= 86_400;
    dayCarry = 1;
  }

  let unixDays: number;
  if (date1904) {
    unixDays = wholeDays + dayCarry - 24_107;
  } else {
    const adjustedWhole = wholeDays + dayCarry;
    unixDays = adjustedWhole >= 60 ? adjustedWhole - 25_569 : adjustedWhole - 25_568;
  }

  const dt = new Date(unixDays * 86_400_000);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  if (totalSeconds <= 0) return `${y}-${m}-${d}`;

  const hh = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const mm = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function formatNumericCell(raw: string, kind: CellFormatKind, date1904: boolean): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return trimmed;

  if (kind === 'date' && num >= 0 && num <= 2_958_465) {
    return formatExcelSerialDate(num, date1904);
  }
  if (kind === 'percent') {
    const pct = Number((num * 100).toPrecision(12));
    return `${pct}%`;
  }
  if (Number.isInteger(num) && Math.abs(num) < 1e15) {
    return String(num);
  }
  return String(Number(num.toPrecision(12)));
}

function parseSharedStrings(sstXml: string | undefined): string[] {
  if (!sstXml) return [];
  const root = parseXmlDocument(sstXml);
  const out: string[] = [];
  for (const si of collectDescendants(root, 'si')) {
    let text = '';
    for (const ch of si.children) {
      if (!isXmlNode(ch)) continue;
      if (ch.tag === 't') {
        text += nodeText(ch);
      } else if (ch.tag === 'r') {
        const t = findChild(ch, 't');
        if (t) text += nodeText(t);
      }
      // Deliberately skip <rPh> phonetic ruby runs
    }
    out.push(text);
  }
  return out;
}

function parseExcelCellRef(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!m) return null;
  const colLetters = m[1]!.toUpperCase();
  let col = 0;
  for (let i = 0; i < colLetters.length; i += 1) {
    col = col * 26 + (colLetters.charCodeAt(i) - 64);
  }
  return { col: col - 1, row: Number(m[2]) - 1 };
}

function extractInlineString(isNode: XmlNode | undefined): string {
  if (!isNode) return '';
  let text = '';
  for (const ch of isNode.children) {
    if (!isXmlNode(ch)) continue;
    if (ch.tag === 't') {
      text += nodeText(ch);
    } else if (ch.tag === 'r') {
      const t = findChild(ch, 't');
      if (t) text += nodeText(t);
    }
  }
  return text;
}

function resolveWorkbookTargetPath(rawTarget: string): string {
  const cleaned = rawTarget.replace(/\\/g, '/').replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
  return cleaned.toLowerCase().startsWith('xl/') ? cleaned.toLowerCase() : `xl/${cleaned.toLowerCase()}`;
}

function convertXlsxToMarkdown(zip: ZipIndex, filename: string): DocumentMarkdownConversionResult {
  const wbXml = zip.files.get('xl/workbook.xml');
  if (!wbXml) {
    throw new DocumentConversionError(422, 'corrupted_archive', 'XLSX workbook is missing xl/workbook.xml.');
  }

  const wbRoot = parseXmlDocument(wbXml);
  const workbookEl = findChild(wbRoot, 'workbook') ?? wbRoot;
  const workbookPr = findChild(workbookEl, 'workbookPr');
  const date1904 = workbookPr?.attrs.date1904 === '1' || workbookPr?.attrs.date1904?.toLowerCase() === 'true';

  const wbRels = new Map<string, string>();
  const wbRelsXml = zip.files.get('xl/_rels/workbook.xml.rels');
  if (wbRelsXml) {
    const relsRoot = parseXmlDocument(wbRelsXml);
    for (const rel of collectDescendants(relsRoot, 'Relationship')) {
      if (rel.attrs.Id && rel.attrs.Target) {
        wbRels.set(rel.attrs.Id, resolveWorkbookTargetPath(rel.attrs.Target));
      }
    }
  }

  const allSheets: Array<{ name: string; target: string; hidden: boolean }> = [];
  const sheetNodes = collectDescendants(workbookEl, 'sheet');
  sheetNodes.forEach((s, idx) => {
    const name = s.attrs.name?.trim() || `Sheet ${idx + 1}`;
    const rid = s.attrs['r:id'] ?? s.attrs.id ?? '';
    const state = (s.attrs.state ?? 'visible').toLowerCase();
    const target = (rid && wbRels.get(rid)) || `xl/worksheets/sheet${idx + 1}.xml`;
    allSheets.push({ name, target, hidden: state === 'hidden' || state === 'veryhidden' });
  });

  const warnings: string[] = [];
  let selectedSheets = allSheets.filter((s) => !s.hidden);
  if (selectedSheets.length === 0 && allSheets.length > 0) {
    selectedSheets = allSheets;
    warnings.push('All sheets were hidden in the workbook; hidden sheets were included.');
  }
  if (selectedSheets.length > DOCUMENT_MARKDOWN_LIMITS.maxWorksheets) {
    warnings.push(
      `Workbook has ${selectedSheets.length} sheets; only the first ${DOCUMENT_MARKDOWN_LIMITS.maxWorksheets} sheets were converted.`,
    );
    selectedSheets = selectedSheets.slice(0, DOCUMENT_MARKDOWN_LIMITS.maxWorksheets);
  }

  const sharedStrings = parseSharedStrings(zip.files.get('xl/sharedstrings.xml'));
  const cellXfs = parseXlsxCellXfs(zip.files.get('xl/styles.xml'));

  const sections: string[] = [];
  let renderedSheetCount = 0;

  for (const sheet of selectedSheets) {
    const sheetXml = zip.files.get(sheet.target);
    if (!sheetXml) continue;
    const sheetRoot = parseXmlDocument(sheetXml);
    const worksheetEl = findChild(sheetRoot, 'worksheet') ?? sheetRoot;
    const sheetData = findChild(worksheetEl, 'sheetData');
    if (!sheetData) continue;

    const grid: string[][] = [];
    let nextRowIdx = 0;
    let clippedRows = false;
    let clippedCols = false;

    for (const rowNode of childNodes(sheetData, 'row')) {
      const explicitRow = rowNode.attrs.r ? Number(rowNode.attrs.r) - 1 : nextRowIdx;
      const rowIdx = Number.isInteger(explicitRow) && explicitRow >= 0 ? explicitRow : nextRowIdx;
      nextRowIdx = rowIdx + 1;
      if (rowIdx >= DOCUMENT_MARKDOWN_LIMITS.maxSheetRows) {
        clippedRows = true;
        continue;
      }

      let nextColIdx = 0;
      for (const cellNode of childNodes(rowNode, 'c')) {
        const parsedRef = cellNode.attrs.r ? parseExcelCellRef(cellNode.attrs.r) : null;
        const cRow = parsedRef ? parsedRef.row : rowIdx;
        const cCol = parsedRef ? parsedRef.col : nextColIdx;
        nextColIdx = cCol + 1;

        if (cRow >= DOCUMENT_MARKDOWN_LIMITS.maxSheetRows) {
          clippedRows = true;
          continue;
        }
        if (cCol >= DOCUMENT_MARKDOWN_LIMITS.maxSheetCols) {
          clippedCols = true;
          continue;
        }

        const cellType = (cellNode.attrs.t ?? '').trim();
        const xfIdx = cellNode.attrs.s ? Number(cellNode.attrs.s) : -1;
        const fmtKind = Number.isInteger(xfIdx) && xfIdx >= 0 ? (cellXfs[xfIdx] ?? 'general') : 'general';

        let value = '';
        if (cellType === 'inlineStr') {
          value = extractInlineString(findChild(cellNode, 'is'));
        } else {
          const vRaw = nodeText(findChild(cellNode, 'v'));
          if (cellType === 's') {
            const idx = Number(vRaw);
            value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx]! : '';
          } else if (cellType === 'b') {
            value = vRaw.trim() === '1' || vRaw.trim().toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
          } else if (cellType === 'str' || cellType === 'e' || cellType === 'd') {
            value = vRaw;
          } else {
            value = formatNumericCell(vRaw, fmtKind, date1904);
          }
        }

        if (!value) continue;
        while (grid.length <= cRow) grid.push([]);
        const targetRow = grid[cRow]!;
        while (targetRow.length <= cCol) targetRow.push('');
        targetRow[cCol] = value;
      }
    }

    if (clippedRows) {
      warnings.push(`Sheet "${sheet.name}" exceeded ${DOCUMENT_MARKDOWN_LIMITS.maxSheetRows} rows and was clipped.`);
    }
    if (clippedCols) {
      warnings.push(`Sheet "${sheet.name}" exceeded ${DOCUMENT_MARKDOWN_LIMITS.maxSheetCols} columns and was clipped.`);
    }

    const trimmed = trimGrid(grid);
    if (trimmed.length === 0) continue;

    renderedSheetCount += 1;
    sections.push(`## ${escapeMarkdownHeading(sheet.name)}\n\n${renderMarkdownTable(trimmed)}`);
  }

  const markdown = normalizeMarkdownOutput(sections.join('\n\n'));
  return finalizeMarkdownResult({
    title: deriveDocumentTitle(filename),
    sourceFormat: 'xlsx',
    markdown,
    sheetCount: renderedSheetCount,
    warnings,
  });
}

// ---------------------------------------------------------------------------
// SpreadsheetML 2003 (.xls XML), HTML-as-Word/Excel, CSV & TSV
// ---------------------------------------------------------------------------

function convertSpreadsheetMl2003ToMarkdown(xmlText: string, filename: string): DocumentMarkdownConversionResult {
  const root = parseXmlDocument(xmlText);
  const workbook = findChild(root, 'Workbook') ?? root;
  const worksheets = childNodes(workbook, 'Worksheet').slice(0, DOCUMENT_MARKDOWN_LIMITS.maxWorksheets);
  const sections: string[] = [];
  let sheetCount = 0;

  worksheets.forEach((ws, idx) => {
    const name = ws.attrs.Name ?? ws.attrs['ss:Name'] ?? `Sheet ${idx + 1}`;
    const table = findChild(ws, 'Table');
    if (!table) return;

    const grid: string[][] = [];
    let rowCursor = 0;
    for (const rowNode of childNodes(table, 'Row')) {
      const rowIdxAttr = rowNode.attrs.Index ?? rowNode.attrs['ss:Index'];
      const rowIdx = rowIdxAttr ? Math.max(0, Number(rowIdxAttr) - 1) : rowCursor;
      rowCursor = rowIdx + 1;
      if (rowIdx >= DOCUMENT_MARKDOWN_LIMITS.maxSheetRows) break;

      const rowArr: string[] = [];
      let colCursor = 0;
      for (const cell of childNodes(rowNode, 'Cell')) {
        const colIdxAttr = cell.attrs.Index ?? cell.attrs['ss:Index'];
        const colIdx = colIdxAttr ? Math.max(0, Number(colIdxAttr) - 1) : colCursor;
        colCursor = colIdx + 1;
        if (colIdx >= DOCUMENT_MARKDOWN_LIMITS.maxSheetCols) continue;
        const dataNode = findChild(cell, 'Data');
        const val = dataNode ? nodeText(dataNode) : nodeText(cell);
        while (rowArr.length <= colIdx) rowArr.push('');
        rowArr[colIdx] = val;
      }
      while (grid.length <= rowIdx) grid.push([]);
      grid[rowIdx] = rowArr;
    }

    const trimmed = trimGrid(grid);
    if (trimmed.length === 0) return;
    sheetCount += 1;
    sections.push(`## ${escapeMarkdownHeading(name)}\n\n${renderMarkdownTable(trimmed)}`);
  });

  const markdown = normalizeMarkdownOutput(sections.join('\n\n'));
  return finalizeMarkdownResult({
    title: deriveDocumentTitle(filename),
    sourceFormat: 'spreadsheetml_2003',
    markdown,
    sheetCount,
    warnings: [],
  });
}

function detectCsvDelimiter(text: string): ',' | ';' {
  const firstLines = text.split('\n').slice(0, 5).filter((l) => l.trim().length > 0).join('\n');
  let commas = 0;
  let semis = 0;
  let inQuote = false;
  for (let i = 0; i < firstLines.length; i += 1) {
    const ch = firstLines[i]!;
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === ',') commas += 1;
      else if (ch === ';') semis += 1;
    }
  }
  return semis > commas ? ';' : ',';
}

function parseDelimitedRows(text: string, delimiter: ',' | ';' | '\t'): { rows: string[][]; clipped: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let clipped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
    } else if (ch === delimiter) {
      if (row.length < DOCUMENT_MARKDOWN_LIMITS.maxSheetCols) row.push(cell);
      else clipped = true;
      cell = '';
    } else if (ch === '\n') {
      if (row.length < DOCUMENT_MARKDOWN_LIMITS.maxSheetCols) row.push(cell);
      else clipped = true;
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= DOCUMENT_MARKDOWN_LIMITS.maxSheetRows) {
        clipped = true;
        break;
      }
    } else {
      cell += ch;
    }
  }

  if ((cell.length > 0 || row.length > 0) && rows.length < DOCUMENT_MARKDOWN_LIMITS.maxSheetRows) {
    if (row.length < DOCUMENT_MARKDOWN_LIMITS.maxSheetCols) row.push(cell);
    else clipped = true;
    rows.push(row);
  }

  return { rows: trimGrid(rows), clipped };
}

function convertDelimitedToMarkdown(
  text: string,
  delimiterMode: 'auto' | '\t',
  filename: string,
  sourceFormat: 'csv' | 'tsv',
): DocumentMarkdownConversionResult {
  const delimiter = delimiterMode === '\t' ? '\t' : detectCsvDelimiter(text);
  const { rows, clipped } = parseDelimitedRows(text, delimiter);
  const warnings = clipped
    ? [`Table exceeded ${DOCUMENT_MARKDOWN_LIMITS.maxSheetRows} rows or ${DOCUMENT_MARKDOWN_LIMITS.maxSheetCols} columns and was clipped.`]
    : [];
  const markdown = normalizeMarkdownOutput(renderMarkdownTable(rows));
  return finalizeMarkdownResult({
    title: deriveDocumentTitle(filename),
    sourceFormat,
    markdown,
    sheetCount: rows.length > 0 ? 1 : 0,
    warnings,
  });
}

function convertHtmlOfficeToMarkdown(html: string, filename: string): DocumentMarkdownConversionResult {
  const cleaned = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const stripTags = (s: string) =>
    decodeXmlEntities(
      s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_, inner: string) => `**${inner.trim()}**`)
        .replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_, inner: string) => `*${inner.trim()}*`)
        .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) =>
          isSafeExternalLink(href) ? `[${inner.trim()}](${href})` : inner,
        )
        .replace(/<[^>]+>/g, ''),
    );

  // Replace HTML tables with placeholders so inline tag stripping doesn't break them
  const tables: string[] = [];
  const withTablePlaceholders = cleaned.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, tableInner: string) => {
    const rows: string[][] = [];
    for (const rowMatch of tableInner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1]!.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)) {
        cells.push(stripTags(cellMatch[1]!).trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
    const md = renderMarkdownTable(trimGrid(rows));
    const idx = tables.length;
    tables.push(md);
    return `\n\n@@TABLE_${idx}@@\n\n`;
  });

  const mdText = decodeXmlEntities(
    withTablePlaceholders
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => `\n\n${'#'.repeat(Number(lvl))} ${stripTags(inner).trim()}\n\n`)
      .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => `\n- ${stripTags(inner).trim()}`)
      .replace(/<\/(?:p|div|tr|ul|ol|blockquote)>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_, inner: string) => `**${stripTags(inner).trim()}**`)
      .replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_, inner: string) => `*${stripTags(inner).trim()}*`)
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) =>
        isSafeExternalLink(href) ? `[${stripTags(inner).trim()}](${href})` : stripTags(inner),
      )
      .replace(/<[^>]+>/g, ''),
  );

  const restored = mdText.replace(/@@TABLE_(\d+)@@/g, (_, idxStr: string) => tables[Number(idxStr)] ?? '');
  const markdown = normalizeMarkdownOutput(restored);
  return finalizeMarkdownResult({
    title: deriveDocumentTitle(filename),
    sourceFormat: 'html_office',
    markdown,
    sheetCount: tables.length > 0 ? tables.length : undefined,
    warnings: [],
  });
}

// ---------------------------------------------------------------------------
// Post-processing & Public Entrypoint
// ---------------------------------------------------------------------------

function finalizeMarkdownResult(input: {
  title: string;
  sourceFormat: DocumentSourceFormat;
  markdown: string;
  sheetCount?: number;
  warnings: string[];
  maxRecommendedChars?: number;
}): DocumentMarkdownConversionResult {
  if (!input.markdown.trim()) {
    throw new DocumentConversionError(
      422,
      'empty_document',
      'No readable text or table data found in the uploaded document.',
    );
  }

  let markdown = input.markdown;
  let truncated = false;
  const warnings = [...input.warnings];

  if (markdown.length > DOCUMENT_MARKDOWN_LIMITS.maxOutputChars) {
    const slice = markdown.slice(0, DOCUMENT_MARKDOWN_LIMITS.maxOutputChars);
    const lastNewline = slice.lastIndexOf('\n');
    markdown = (lastNewline > DOCUMENT_MARKDOWN_LIMITS.maxOutputChars * 0.6 ? slice.slice(0, lastNewline) : slice).trimEnd();
    truncated = true;
    warnings.push(
      `Converted Markdown exceeded ${DOCUMENT_MARKDOWN_LIMITS.maxOutputChars.toLocaleString('en-US')} characters and was truncated.`,
    );
  }

  if (input.maxRecommendedChars && markdown.length > input.maxRecommendedChars) {
    warnings.push(
      `Converted Markdown has ${markdown.length.toLocaleString('en-US')} characters, which exceeds the ${input.maxRecommendedChars.toLocaleString('en-US')}-character limit for this knowledge base.`,
    );
  }

  return {
    ok: true,
    title: input.title,
    format: 'markdown',
    sourceFormat: input.sourceFormat,
    markdown,
    charCount: markdown.length,
    truncated,
    ...(input.sheetCount !== undefined ? { sheetCount: input.sheetCount } : {}),
    warnings,
  };
}

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function bufferContainsOleMarker(buf: Buffer, marker: string): boolean {
  if (buf.includes(Buffer.from(marker, 'ascii'))) return true;
  return buf.includes(Buffer.from(marker, 'utf16le'));
}

function decodeTextBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1]!;
      swapped[i - 1] = buf[i]!;
    }
    return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
  }
  if (buf.includes(0x00)) {
    throw new DocumentConversionError(
      415,
      'unsupported_format',
      'Binary file format is not supported. Upload .docx, .xlsx, .csv, .tsv, .md, or .txt.',
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new DocumentConversionError(
      415,
      'unsupported_format',
      'File is not valid UTF-8 text or a supported Office archive.',
    );
  }
}

export function convertDocumentToMarkdown(
  buffer: Buffer,
  options: { filename: string; mimeType?: string; maxRecommendedChars?: number },
): DocumentMarkdownConversionResult {
  if (!buffer || buffer.length === 0) {
    throw new DocumentConversionError(400, 'empty_file', 'Uploaded file is empty.');
  }
  if (buffer.length > DOCUMENT_MARKDOWN_LIMITS.maxUploadBytes) {
    throw new DocumentConversionError(
      413,
      'file_too_large',
      `Uploaded file exceeds the ${DOCUMENT_MARKDOWN_LIMITS.maxUploadBytes / (1024 * 1024)} MiB size limit.`,
    );
  }

  const filename = String(options.filename || 'document');
  const ext = path.posix.extname(filename.replace(/\\/g, '/')).toLowerCase();
  const mime = (options.mimeType ?? '').toLowerCase();

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(OLE2_MAGIC)) {
    if (bufferContainsOleMarker(buffer, 'EncryptedPackage') || bufferContainsOleMarker(buffer, 'EncryptionInfo')) {
      throw new DocumentConversionError(
        415,
        'password_protected_document',
        'Password-protected Office documents cannot be converted. Remove the password and try again.',
      );
    }
    throw new DocumentConversionError(
      415,
      'legacy_office_binary',
      'Legacy binary Office 97–2003 (.doc/.xls) format is not supported. Please save the file as .docx, .xlsx, or .csv and upload again.',
    );
  }

  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    const zip = readZipXmlEntries(buffer, (lower) => {
      if (lower.startsWith('word/media/') || lower.startsWith('xl/media/') || lower.startsWith('word/embeddings/') || lower.startsWith('xl/embeddings/')) {
        return false;
      }
      return lower.endsWith('.xml') || lower.endsWith('.rels');
    });

    let result: DocumentMarkdownConversionResult;
    if (zip.entryNames.has('word/document.xml')) {
      result = convertDocxToMarkdown(zip, filename);
    } else if (zip.entryNames.has('xl/workbook.xml')) {
      result = convertXlsxToMarkdown(zip, filename);
    } else {
      throw new DocumentConversionError(
        415,
        'unsupported_format',
        'Unsupported ZIP archive: expected a Word (.docx) or Excel (.xlsx) document.',
      );
    }

    return finalizeMarkdownResult({
      title: result.title,
      sourceFormat: result.sourceFormat,
      markdown: result.markdown,
      sheetCount: result.sheetCount,
      warnings: result.warnings,
      maxRecommendedChars: options.maxRecommendedChars,
    });
  }

  const decoded = decodeTextBuffer(buffer);
  const text = (decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded).replace(/\r\n?/g, '\n');
  const head = text.slice(0, 4096).toLowerCase();

  let result: DocumentMarkdownConversionResult;
  if (head.includes('<workbook') && head.includes('schemas-microsoft-com:office:spreadsheet')) {
    result = convertSpreadsheetMl2003ToMarkdown(text, filename);
  } else if (
    (ext === '.xls' || ext === '.doc' || ext === '.html' || ext === '.htm' || mime === 'text/html') &&
    (head.includes('<table') || head.includes('<html') || head.includes('<!doctype html') || head.includes('<body'))
  ) {
    result = convertHtmlOfficeToMarkdown(text, filename);
  } else if (ext === '.csv' || mime === 'text/csv') {
    result = convertDelimitedToMarkdown(text, 'auto', filename, 'csv');
  } else if (ext === '.tsv' || mime === 'text/tab-separated-values') {
    result = convertDelimitedToMarkdown(text, '\t', filename, 'tsv');
  } else if (ext === '.md' || ext === '.markdown' || mime === 'text/markdown') {
    result = finalizeMarkdownResult({
      title: deriveDocumentTitle(filename),
      sourceFormat: 'markdown',
      markdown: normalizeMarkdownOutput(text),
      warnings: [],
    });
  } else if (ext === '.txt' || mime.startsWith('text/')) {
    result = finalizeMarkdownResult({
      title: deriveDocumentTitle(filename),
      sourceFormat: 'text',
      markdown: normalizeMarkdownOutput(text),
      warnings: [],
    });
  } else {
    throw new DocumentConversionError(
      415,
      'unsupported_format',
      `Unsupported file format${ext ? ` (${ext})` : ''}. Upload .docx, .xlsx, .csv, .tsv, .md, or .txt.`,
    );
  }

  return finalizeMarkdownResult({
    title: result.title,
    sourceFormat: result.sourceFormat,
    markdown: result.markdown,
    sheetCount: result.sheetCount,
    warnings: result.warnings,
    maxRecommendedChars: options.maxRecommendedChars,
  });
}
