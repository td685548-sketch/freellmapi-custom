/** Shared contracts for the Customer AI Hub, Personal Agent Workspace, smart personal-key routing, and dual-persona intelligence. */

export const KEY_ROUTING_MODES = ['default', 'eco', 'balanced', 'max'] as const;
export type KeyRoutingMode = typeof KEY_ROUTING_MODES[number];

export const ASSISTANT_CATEGORIES = ['coding', 'writing', 'data', 'productivity', 'general'] as const;
export type AssistantCategory = typeof ASSISTANT_CATEGORIES[number];

export const ASSISTANT_AUDIENCES = ['all_members', 'guest_preview', 'admin_only'] as const;
export type AssistantAudience = typeof ASSISTANT_AUDIENCES[number];

export const MAX_USER_CUSTOM_ASSISTANTS = 20;
export const MAX_USER_ASSISTANT_KNOWLEDGE_BYTES = 32_768;
export const MAX_USER_ASSISTANT_SYSTEM_PROMPT_CHARS = 8_000;

/** Customer-facing AI Assistant DTO. Never includes internal systemPrompt text. */
export interface CustomerAiAssistant {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: AssistantCategory;
  icon: string;
  recommendedRoutingMode: KeyRoutingMode;
  starterPrompts: string[];
  audience: AssistantAudience;
  boundKeysCount: number;
  playgroundRuns: number;
}

/** Administrator AI Assistant DTO with authoring and lifecycle fields. */
export interface AdminAiAssistant extends CustomerAiAssistant {
  systemPrompt: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Member-authored private Custom Assistant with personal knowledge context. */
export interface UserCustomAssistant {
  id: number;
  userId: number;
  /** Canonical runtime & key-binding identifier (`user:<id>`). */
  assistantRef: string;
  slug: string;
  name: string;
  category: AssistantCategory;
  description: string;
  systemPrompt: string;
  knowledgeMarkdown: string;
  recommendedRoutingMode: KeyRoutingMode;
  boundKeysCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserCustomAssistantInput {
  slug?: string;
  name: string;
  category?: AssistantCategory;
  description?: string;
  systemPrompt: string;
  knowledgeMarkdown?: string;
  recommendedRoutingMode?: KeyRoutingMode;
}

export interface UserKeyCustomBinding {
  keyId: number;
  userAssistantId: number;
  assistantRef: string;
  slug: string;
  name: string;
  recommendedRoutingMode: KeyRoutingMode;
  updatedAt: string;
}

export interface AssistantThreadSummary {
  id: number;
  userId: number;
  assistantRef: string;
  assistantNameSnapshot: string;
  title: string;
  routingMode: KeyRoutingMode;
  messageCount: number;
  forkedFromThreadId: number | null;
  forkedFromMessageIndex: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantThreadMessage {
  id: number;
  threadId: number;
  messageIndex: number;
  role: 'user' | 'assistant';
  content: string;
  model: string | null;
  routingMode: KeyRoutingMode | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  createdAt: string;
}

export interface AssistantThreadDetail extends AssistantThreadSummary {
  messages: AssistantThreadMessage[];
}

export const ASSISTANT_ARTIFACT_KINDS = ['html', 'svg', 'mermaid', 'markdown', 'json', 'code'] as const;
export type AssistantArtifactKind = typeof ASSISTANT_ARTIFACT_KINDS[number];

export interface DetectedAssistantArtifact {
  id: string;
  kind: AssistantArtifactKind;
  language: string;
  title: string;
  content: string;
  suggestedFilename: string;
}

// ─── CSP-Safe Artifact Detection & Strict Allowlist HTML/SVG Sanitizer ───────

const FORBIDDEN_SUBTREE_TAGS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'foreignobject', 'style', 'noscript', 'template', 'portal',
  'form', 'button', 'textarea', 'select', 'option',
  'audio', 'video', 'canvas', 'animate', 'set', 'animatetransform', 'animatemotion',
  'math', 'head',
]);

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const HTML_ALLOWED_TAGS: Record<string, string> = {
  div: 'div', span: 'span', p: 'p',
  h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
  ul: 'ul', ol: 'ol', li: 'li', dl: 'dl', dt: 'dt', dd: 'dd',
  table: 'table', thead: 'thead', tbody: 'tbody', tfoot: 'tfoot',
  tr: 'tr', th: 'th', td: 'td', caption: 'caption',
  blockquote: 'blockquote', pre: 'pre', code: 'code',
  em: 'em', strong: 'strong', b: 'b', i: 'i', u: 'u', s: 's',
  del: 'del', ins: 'ins', mark: 'mark', small: 'small', sub: 'sub', sup: 'sup',
  br: 'br', hr: 'hr', a: 'a', img: 'img',
  figure: 'figure', figcaption: 'figcaption',
  section: 'section', article: 'article', header: 'header', footer: 'footer',
  main: 'main', nav: 'nav', aside: 'aside', details: 'details', summary: 'summary',
  kbd: 'kbd', samp: 'samp', var: 'var',
};

const SVG_ALLOWED_TAGS: Record<string, string> = {
  svg: 'svg', g: 'g', path: 'path', rect: 'rect', circle: 'circle',
  ellipse: 'ellipse', line: 'line', polyline: 'polyline', polygon: 'polygon',
  text: 'text', tspan: 'tspan', defs: 'defs',
  lineargradient: 'linearGradient', radialgradient: 'radialGradient', stop: 'stop',
  clippath: 'clipPath', mask: 'mask', pattern: 'pattern', marker: 'marker',
  symbol: 'symbol', title: 'title', desc: 'desc',
};

const GLOBAL_HTML_ATTRS = new Set([
  'class', 'title', 'role', 'aria-label', 'aria-hidden',
  'colspan', 'rowspan', 'align', 'open', 'style', 'id',
]);

const SVG_ATTR_MAP: Record<string, string> = {
  id: 'id',
  class: 'class',
  style: 'style',
  xmlns: 'xmlns',
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  width: 'width',
  height: 'height',
  x: 'x',
  y: 'y',
  x1: 'x1',
  y1: 'y1',
  x2: 'x2',
  y2: 'y2',
  cx: 'cx',
  cy: 'cy',
  r: 'r',
  rx: 'rx',
  ry: 'ry',
  d: 'd',
  points: 'points',
  fill: 'fill',
  'fill-opacity': 'fill-opacity',
  'fill-rule': 'fill-rule',
  stroke: 'stroke',
  'stroke-width': 'stroke-width',
  'stroke-linecap': 'stroke-linecap',
  'stroke-linejoin': 'stroke-linejoin',
  'stroke-dasharray': 'stroke-dasharray',
  'stroke-dashoffset': 'stroke-dashoffset',
  'stroke-opacity': 'stroke-opacity',
  opacity: 'opacity',
  transform: 'transform',
  'text-anchor': 'text-anchor',
  'dominant-baseline': 'dominant-baseline',
  'font-size': 'font-size',
  'font-family': 'font-family',
  'font-weight': 'font-weight',
  'letter-spacing': 'letter-spacing',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  offset: 'offset',
  'stop-color': 'stop-color',
  'stop-opacity': 'stop-opacity',
  markerwidth: 'markerWidth',
  markerheight: 'markerHeight',
  refx: 'refX',
  refy: 'refY',
  orient: 'orient',
  'marker-start': 'marker-start',
  'marker-mid': 'marker-mid',
  'marker-end': 'marker-end',
  'clip-path': 'clip-path',
  mask: 'mask',
};

const SAFE_CSS_PROPS = new Set([
  'color', 'background', 'background-color',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius', 'border-collapse',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'font-size', 'font-weight', 'font-style', 'font-family', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration', 'text-transform', 'white-space',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap',
  'grid-template-columns', 'grid-gap',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'opacity', 'box-shadow', 'overflow', 'vertical-align',
]);

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttrValue(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeHtmlEntitiesForCheck(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : '';
    })
    .replace(/&#([0-9]+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : '';
    })
    .replace(/&colon;?/gi, ':')
    .replace(/&tab;?/gi, '')
    .replace(/&newline;?/gi, '');
}

function isSafeAnchorHref(raw: string): boolean {
  const normalized = decodeHtmlEntitiesForCheck(raw)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .trim();
  if (!normalized) return false;
  if (normalized.startsWith('#')) return true;
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return true;
  return /^(https?:|mailto:)/i.test(normalized);
}

function isSafeImgSrc(raw: string): boolean {
  const normalized = decodeHtmlEntitiesForCheck(raw)
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .trim();
  if (!normalized) return false;
  if (normalized.startsWith('/') && !normalized.startsWith('//')) return true;
  return /^data:image\/(png|jpeg|jpg|gif|webp);base64,[a-z0-9+/=]+$/i.test(normalized);
}

function sanitizeInlineStyle(raw: string): string {
  const decoded = decodeHtmlEntitiesForCheck(raw);
  const kept: string[] = [];
  for (const decl of decoded.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx <= 0) continue;
    const prop = decl.slice(0, colonIdx).trim().toLowerCase();
    const val = decl.slice(colonIdx + 1).trim();
    if (!SAFE_CSS_PROPS.has(prop) || !val) continue;
    if (/url\s*\(|expression\s*\(|javascript|vbscript|@import|behavior|-moz-binding|\\/i.test(val)) {
      continue;
    }
    kept.push(`${prop}: ${val}`);
  }
  return kept.join('; ');
}

function sanitizeSvgPaintValue(raw: string): string | null {
  const decoded = decodeHtmlEntitiesForCheck(raw).trim();
  if (!decoded) return null;
  if (/javascript|vbscript|expression|data:/i.test(decoded)) return null;
  if (/url\s*\(/i.test(decoded)) {
    return /^url\(\s*#[A-Za-z0-9_-]+\s*\)$/i.test(decoded) ? decoded : null;
  }
  return decoded;
}

interface ParsedAttr {
  name: string;
  value: string;
}

function parseTagAttributes(attrSource: string): ParsedAttr[] {
  const attrs: ParsedAttr[] = [];
  let i = 0;
  const len = attrSource.length;

  while (i < len) {
    while (i < len && /\s/.test(attrSource[i]!)) i += 1;
    if (i >= len || attrSource[i] === '/') break;

    const nameStart = i;
    while (i < len && !/[\s=/]/.test(attrSource[i]!)) i += 1;
    const name = attrSource.slice(nameStart, i);
    if (!name) {
      i += 1;
      continue;
    }

    while (i < len && /\s/.test(attrSource[i]!)) i += 1;
    let value = '';
    if (i < len && attrSource[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(attrSource[i]!)) i += 1;
      if (i < len && (attrSource[i] === '"' || attrSource[i] === "'")) {
        const quote = attrSource[i]!;
        i += 1;
        const valStart = i;
        while (i < len && attrSource[i] !== quote) i += 1;
        value = attrSource.slice(valStart, i);
        if (i < len && attrSource[i] === quote) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/\s/.test(attrSource[i]!)) i += 1;
        value = attrSource.slice(valStart, i);
      }
    }

    attrs.push({ name, value });
  }
  return attrs;
}

function findTagEnd(input: string, startAfterLt: number): number {
  let quote: string | null = null;
  for (let i = startAfterLt; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function sanitizeMarkupInternal(raw: string, svgOnly: boolean): string {
  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
    .replace(/<![^>]*>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');

  const out: string[] = [];
  const skipStack: string[] = [];
  let i = 0;
  const len = stripped.length;

  while (i < len) {
    const lt = stripped.indexOf('<', i);
    if (lt === -1) {
      if (skipStack.length === 0) {
        out.push(escapeHtmlText(stripped.slice(i)));
      }
      break;
    }

    if (lt > i && skipStack.length === 0) {
      out.push(escapeHtmlText(stripped.slice(i, lt)));
    }

    const gt = findTagEnd(stripped, lt + 1);
    if (gt === -1) {
      // Unclosed `<...` at end of input: never emit raw `<`
      const rest = stripped.slice(lt + 1).trimStart().toLowerCase();
      const maybeTag = rest.match(/^\/?([a-z0-9:-]+)/)?.[1] ?? '';
      if (skipStack.length === 0 && !FORBIDDEN_SUBTREE_TAGS.has(maybeTag)) {
        out.push(escapeHtmlText(stripped.slice(lt)));
      }
      break;
    }

    const inner = stripped.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (!inner) continue;

    const isClosing = inner.startsWith('/');
    const body = isClosing ? inner.slice(1).trim() : inner;
    const selfClosing = !isClosing && body.endsWith('/');
    const cleanBody = selfClosing ? body.slice(0, -1).trim() : body;

    const tagMatch = cleanBody.match(/^([A-Za-z][A-Za-z0-9:-]*)/);
    if (!tagMatch) continue;

    const lowerTag = tagMatch[1]!.toLowerCase();
    const attrPart = cleanBody.slice(tagMatch[1]!.length);

    if (skipStack.length > 0) {
      if (isClosing && skipStack[skipStack.length - 1] === lowerTag) {
        skipStack.pop();
      } else if (!isClosing && !selfClosing && !VOID_TAGS.has(lowerTag) && FORBIDDEN_SUBTREE_TAGS.has(lowerTag)) {
        skipStack.push(lowerTag);
      }
      continue;
    }

    if (FORBIDDEN_SUBTREE_TAGS.has(lowerTag)) {
      if (!isClosing && !selfClosing && !VOID_TAGS.has(lowerTag)) {
        skipStack.push(lowerTag);
      }
      continue;
    }

    const isSvgTag = Object.prototype.hasOwnProperty.call(SVG_ALLOWED_TAGS, lowerTag);
    const isHtmlTag = !svgOnly && Object.prototype.hasOwnProperty.call(HTML_ALLOWED_TAGS, lowerTag);

    if (!isSvgTag && !isHtmlTag) {
      continue;
    }

    const canonicalTag = isSvgTag ? SVG_ALLOWED_TAGS[lowerTag]! : HTML_ALLOWED_TAGS[lowerTag]!;

    if (isClosing) {
      if (!VOID_TAGS.has(lowerTag)) {
        out.push(`</${canonicalTag}>`);
      }
      continue;
    }

    const parsedAttrs = parseTagAttributes(attrPart);
    const safeAttrs: string[] = [];

    for (const attr of parsedAttrs) {
      const lowerAttr = attr.name.toLowerCase();
      // Unconditionally drop any event handler (`on*`), `srcdoc`, `formaction`, `xlink:href`, or `href` on SVG
      if (
        lowerAttr.startsWith('on') ||
        lowerAttr === 'srcdoc' ||
        lowerAttr === 'formaction' ||
        lowerAttr.includes('xlink:')
      ) {
        continue;
      }

      if (lowerAttr === 'style') {
        const cleanStyle = sanitizeInlineStyle(attr.value);
        if (cleanStyle) safeAttrs.push(`style="${escapeAttrValue(cleanStyle)}"`);
        continue;
      }

      if (lowerAttr === 'id') {
        const cleanId = attr.value.trim();
        if (/^[A-Za-z0-9_-]{1,64}$/.test(cleanId)) {
          safeAttrs.push(`id="${escapeAttrValue(cleanId)}"`);
        }
        continue;
      }

      if (isSvgTag) {
        const canonicalSvgAttr = SVG_ATTR_MAP[lowerAttr];
        if (!canonicalSvgAttr) continue;
        if (
          lowerAttr === 'fill' ||
          lowerAttr === 'stroke' ||
          lowerAttr === 'clip-path' ||
          lowerAttr === 'mask' ||
          lowerAttr === 'marker-start' ||
          lowerAttr === 'marker-mid' ||
          lowerAttr === 'marker-end'
        ) {
          const cleanPaint = sanitizeSvgPaintValue(attr.value);
          if (cleanPaint) safeAttrs.push(`${canonicalSvgAttr}="${escapeAttrValue(cleanPaint)}"`);
        } else {
          const decoded = decodeHtmlEntitiesForCheck(attr.value);
          if (!/javascript|vbscript|expression|data:/i.test(decoded)) {
            safeAttrs.push(`${canonicalSvgAttr}="${escapeAttrValue(attr.value.trim())}"`);
          }
        }
        continue;
      }

      // HTML tag attributes
      if (lowerTag === 'a' && lowerAttr === 'href') {
        if (isSafeAnchorHref(attr.value)) {
          safeAttrs.push(`href="${escapeAttrValue(attr.value.trim())}"`);
          safeAttrs.push('rel="noopener noreferrer"');
          safeAttrs.push('target="_blank"');
        }
        continue;
      }

      if (lowerTag === 'img') {
        if (lowerAttr === 'src' && isSafeImgSrc(attr.value)) {
          safeAttrs.push(`src="${escapeAttrValue(attr.value.trim())}"`);
        } else if (lowerAttr === 'alt') {
          safeAttrs.push(`alt="${escapeAttrValue(attr.value)}"`);
        } else if ((lowerAttr === 'width' || lowerAttr === 'height') && /^\d{1,4}$/.test(attr.value.trim())) {
          safeAttrs.push(`${lowerAttr}="${attr.value.trim()}"`);
        }
        continue;
      }

      if (GLOBAL_HTML_ATTRS.has(lowerAttr)) {
        const decoded = decodeHtmlEntitiesForCheck(attr.value);
        if (!/javascript|vbscript|expression/i.test(decoded)) {
          safeAttrs.push(`${lowerAttr}="${escapeAttrValue(attr.value)}"`);
        }
      }
    }

    const attrSuffix = safeAttrs.length > 0 ? ` ${safeAttrs.join(' ')}` : '';
    if (VOID_TAGS.has(lowerTag)) {
      out.push(`<${canonicalTag}${attrSuffix} />`);
    } else if (selfClosing && isSvgTag) {
      out.push(`<${canonicalTag}${attrSuffix} />`);
    } else {
      out.push(`<${canonicalTag}${attrSuffix}>`);
    }
  }

  return out.join('');
}

/** Sanitizes untrusted HTML for CSP-safe (`script-src 'self'`) inline preview rendering. */
export function sanitizeArtifactHtml(rawHtml: string): string {
  return sanitizeMarkupInternal(rawHtml, false);
}

/** Sanitizes untrusted SVG markup, stripping `<script>`, `<foreignObject>`, `on*`, and `javascript:` URLs. */
export function sanitizeArtifactSvg(rawSvg: string): string {
  return sanitizeMarkupInternal(rawSvg, true);
}

const FENCED_BLOCK_RE = /```([A-Za-z0-9_+-]*)[ \t]*([^\r\n`]*)\r?\n([\s\S]*?)```/g;

function classifyFenceLanguage(rawLang: string, content: string): {
  kind: AssistantArtifactKind;
  language: string;
  ext: string;
  label: string;
} | null {
  const lang = rawLang.trim().toLowerCase();
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (lang === 'html' || lang === 'htm') {
    return { kind: 'html', language: 'html', ext: 'html', label: 'HTML Preview' };
  }
  if (lang === 'svg' || (lang === 'xml' && /^<svg[\s>]/i.test(trimmed))) {
    return { kind: 'svg', language: 'svg', ext: 'svg', label: 'SVG Graphic' };
  }
  if (lang === 'mermaid') {
    return { kind: 'mermaid', language: 'mermaid', ext: 'mmd', label: 'Mermaid Diagram' };
  }
  if (lang === 'markdown' || lang === 'md') {
    return { kind: 'markdown', language: 'markdown', ext: 'md', label: 'Markdown Document' };
  }
  if (lang === 'json' || lang === 'jsonc') {
    return { kind: 'json', language: 'json', ext: 'json', label: 'JSON Payload' };
  }
  if (lang === 'tsx' || lang === 'jsx') {
    return { kind: 'code', language: lang, ext: lang, label: `${lang.toUpperCase()} Component` };
  }
  if (lang === 'ts' || lang === 'typescript') {
    return { kind: 'code', language: 'typescript', ext: 'ts', label: 'TypeScript Module' };
  }
  if (lang === 'js' || lang === 'javascript') {
    return { kind: 'code', language: 'javascript', ext: 'js', label: 'JavaScript Module' };
  }
  if (!lang && /^<svg[\s>]/i.test(trimmed)) {
    return { kind: 'svg', language: 'svg', ext: 'svg', label: 'SVG Graphic' };
  }
  return null;
}

/** Extracts previewable fenced code artifacts (`html`, `svg`, `mermaid`, `markdown`, `json`, `tsx`/`ts`/`js`) from assistant markdown. */
export function detectAssistantArtifacts(markdown: string, messageKey = 'msg'): DetectedAssistantArtifact[] {
  if (!markdown || !markdown.includes('```')) return [];
  const artifacts: DetectedAssistantArtifact[] = [];
  FENCED_BLOCK_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = FENCED_BLOCK_RE.exec(markdown)) !== null) {
    const rawLang = match[1] ?? '';
    const metaHint = (match[2] ?? '').trim();
    const content = (match[3] ?? '').trim();
    const classified = classifyFenceLanguage(rawLang, content);
    if (!classified) continue;

    index += 1;
    const customTitle = metaHint.replace(/^(?:title=|filename=)/i, '').replace(/["']/g, '').trim();
    const title = customTitle || `${classified.label} #${index}`;
    const safeSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `artifact-${index}`;
    const suggestedFilename = safeSlug.endsWith(`.${classified.ext}`)
      ? safeSlug
      : `${safeSlug}.${classified.ext}`;

    artifacts.push({
      id: `${messageKey}-artifact-${index}`,
      kind: classified.kind,
      language: classified.language,
      title,
      content,
      suggestedFilename,
    });
  }

  return artifacts;
}

export interface UserAiPreferences {
  customInstructions: string;
  applyCustomInstructionsToKeys: boolean;
  updatedAt: string | null;
}

export interface QuotaCoachTip {
  id: string;
  severity: 'saving' | 'warning' | 'info';
  title: string;
  detail: string;
  estimatedTokenSavingsPct?: number;
  recommendedMode?: KeyRoutingMode;
  targetKeyId?: number;
  targetKeyName?: string;
}

export interface CustomerQuotaCoachReport {
  windowDays: number;
  totalRequests: number;
  totalTokens: number;
  avgTokensPerRequest: number;
  errorRatePct: number;
  potentialSavingsPct: number;
  routingBreakdown: Record<KeyRoutingMode, number>;
  headline: string;
  tips: QuotaCoachTip[];
}

export type AdminAnomalyKind = 'token_spike' | 'high_error_loop' | 'unoptimized_heavy_usage';

export interface AdminAnomalyItem {
  id: string;
  kind: AdminAnomalyKind;
  severity: 'high' | 'medium' | 'low';
  userId: number;
  email: string;
  requests24h: number;
  tokens24h: number;
  baselineDailyTokens: number;
  errorRatePct: number;
  activeNonEcoKeys: number;
  summary: string;
  recommendedAction: 'switch_keys_to_eco' | 'inspect_user';
}

export interface AdminAnomalyRadarReport {
  generatedAt: string;
  windowHours: number;
  totalAssistants: number;
  enabledAssistants: number;
  boundPersonalKeys: number;
  ecoPersonalKeys: number;
  anomalies: AdminAnomalyItem[];
  topAssistants: Array<{
    id: number;
    slug: string;
    name: string;
    category: AssistantCategory;
    boundKeysCount: number;
    playgroundRuns: number;
  }>;
}
