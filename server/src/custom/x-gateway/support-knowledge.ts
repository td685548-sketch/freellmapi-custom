import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';

const KNOWLEDGE_KEY = 'x_gateway_support_knowledge_v1';
const MASKING_KEY = 'x_gateway_support_masking_v1';
const SNIPPET_MAX = 400;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupportKnowledgeDoc {
  id: string;
  tenantId: string;
  title: string;
  category: string;
  content: string;
  tags: string[];
  allowedRoles: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportKnowledgeChunkMatch {
  docId: string;
  title: string;
  category: string;
  tags: string[];
  allowedRoles: string[];
  snippet: string;
  score: number;
}

export type SupportBuiltinMaskDetector = 'email' | 'phone' | 'credit_card' | 'api_key';

export interface SupportCustomMaskRule {
  id: string;
  name: string;
  pattern: string;
  replacement: string;
  enabled: boolean;
}

export interface SupportMaskingPolicy {
  tenantId: string;
  enabled: boolean;
  builtinDetectors: SupportBuiltinMaskDetector[];
  unmaskedRoles: string[];
  customRules: SupportCustomMaskRule[];
  updatedAt: string;
}

export interface SupportMaskResult<T = unknown> {
  masked: T;
  redactionCount: number;
  appliedRules: string[];
  bypassedByRole: boolean;
}

// ---------------------------------------------------------------------------
// Persistence (SQLite `settings` table)
// ---------------------------------------------------------------------------

function readStore<T>(key: string): Record<string, T> {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, T>) : {};
  } catch {
    return {};
  }
}

function writeStore<T>(key: string, store: Record<string, T>): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(store));
}

function strArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  return v.map((x) => String(x).trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Knowledge base CRUD
// ---------------------------------------------------------------------------

export function listSupportKnowledgeDocs(tenantId: string): SupportKnowledgeDoc[] {
  const docs = readStore<SupportKnowledgeDoc[]>(KNOWLEDGE_KEY)[String(tenantId)];
  return Array.isArray(docs) ? docs : [];
}

export function getSupportKnowledgeDocById(tenantId: string, docId: string): SupportKnowledgeDoc | undefined {
  return listSupportKnowledgeDocs(tenantId).find((d) => d.id === docId);
}

/**
 * Create or update a document. When `allowedRoles` is omitted on a NEW doc it
 * defaults to admin-only (fail closed); updates keep the existing value.
 */
export function upsertSupportKnowledgeDoc(
  tenantId: string,
  input: Partial<SupportKnowledgeDoc> & { title: string; content: string },
): SupportKnowledgeDoc {
  const tid = String(tenantId);
  const store = readStore<SupportKnowledgeDoc[]>(KNOWLEDGE_KEY);
  const docs = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();
  const existingIdx = input.id ? docs.findIndex((d) => d.id === input.id) : -1;
  const existing = existingIdx >= 0 ? docs[existingIdx] : undefined;

  const doc: SupportKnowledgeDoc = {
    id: existing?.id ?? input.id ?? `kb_${randomUUID()}`,
    tenantId: tid,
    title: String(input.title).trim(),
    category: (input.category ?? existing?.category ?? 'faq').trim() || 'faq',
    content: String(input.content),
    tags: strArray(input.tags, existing?.tags ?? []),
    allowedRoles: strArray(input.allowedRoles, existing?.allowedRoles ?? ['admin']),
    enabled: input.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  if (existing) docs[existingIdx] = doc;
  else docs.push(doc);
  store[tid] = docs;
  writeStore(KNOWLEDGE_KEY, store);
  return doc;
}

export function deleteSupportKnowledgeDoc(tenantId: string, docId: string): boolean {
  const tid = String(tenantId);
  const store = readStore<SupportKnowledgeDoc[]>(KNOWLEDGE_KEY);
  const docs = Array.isArray(store[tid]) ? store[tid] : [];
  const next = docs.filter((d) => d.id !== docId);
  if (next.length === docs.length) return false;
  store[tid] = next;
  writeStore(KNOWLEDGE_KEY, store);
  return true;
}

const DEFAULT_DOCS: Array<Pick<SupportKnowledgeDoc, 'title' | 'category' | 'allowedRoles' | 'tags' | 'content'>> = [
  {
    title: 'Public Shipping & Delivery FAQ',
    category: 'faq',
    allowedRoles: ['*'],
    tags: ['shipping', 'delivery', 'tracking', 'faq'],
    content: [
      'Standard shipping takes 3-5 business days. Express shipping takes 1-2 business days and is available for most products.',
      'Once your order ships you will receive a tracking code by email. You can use the tracking code on the carrier website to follow your delivery.',
      'International delivery typically takes 7-14 business days. Customs duties and taxes may apply and are paid by the recipient.',
    ].join('\n\n'),
  },
  {
    title: 'Customer Order & Loyalty Guide',
    category: 'policy',
    allowedRoles: ['customer', 'staff', 'admin'],
    tags: ['orders', 'loyalty', 'returns', 'refund', 'membership'],
    content: [
      'Customers can request a return within 30 days of delivery. Items must be unused and in original packaging. Refunds are issued to the original payment method within 5-7 business days.',
      'Loyalty tiers: standard, silver and gold. Gold members enjoy free express shipping and early access to new products. Tier upgrades happen automatically based on yearly spend.',
      'To cancel an order, contact support before it moves to the shipped status. Shipped orders must go through the return process.',
    ].join('\n\n'),
  },
  {
    title: 'Internal Refund & Escalation SOP',
    category: 'internal_sop',
    allowedRoles: ['staff', 'admin'],
    tags: ['refund', 'escalation', 'sop', 'internal', 'chargeback'],
    content: [
      'Refunds up to 100 USD may be approved by staff directly. Refunds above 100 USD require a second approval from an admin and a documented reason.',
      'Escalate to a human supervisor when the customer mentions legal action, a chargeback, safety issues, or when the same issue has been reopened more than twice.',
      'Always verify the customer identity against the order email before issuing a refund. Record the ticket id in the order notes.',
    ].join('\n\n'),
  },
  {
    title: 'Executive SLA & Margin Playbook',
    category: 'internal_sop',
    allowedRoles: ['admin'],
    tags: ['sla', 'margin', 'executive', 'playbook', 'pricing'],
    content: [
      'SLA targets: first response within 15 minutes for urgent tickets, 4 hours for high priority, 24 hours for medium and low priority. Breaches are reviewed weekly.',
      'Target gross margin is 35 percent. Discounts that reduce margin below 20 percent require executive approval. Do not disclose margin figures to customers or staff.',
      'Goodwill budget: up to 2 percent of monthly revenue may be used for compensation credits at admin discretion.',
    ].join('\n\n'),
  },
];

/** Seeds the 4 default docs (idempotent by title) and returns the tenant's docs. */
export function seedDefaultSupportKnowledgeDocs(tenantId: string): SupportKnowledgeDoc[] {
  const existingTitles = new Set(listSupportKnowledgeDocs(tenantId).map((d) => d.title));
  for (const d of DEFAULT_DOCS) {
    if (existingTitles.has(d.title)) continue;
    upsertSupportKnowledgeDoc(tenantId, { ...d, enabled: true });
  }
  return listSupportKnowledgeDocs(tenantId);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'my', 'me', 'i',
  'it', 'be', 'do', 'does', 'how', 'what', 'can', 'with', 'at', 'by', 'we', 'you', 'your',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function overlap(queryTokens: Set<string>, text: string): number {
  const seen = new Set(tokenize(text));
  let n = 0;
  for (const q of queryTokens) if (seen.has(q)) n += 1;
  return n;
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length <= SNIPPET_MAX ? t : `${t.slice(0, SNIPPET_MAX - 1).trimEnd()}…`;
}

export function searchSupportKnowledge(
  tenantId: string,
  query: string,
  userRole: string,
  options?: { topK?: number; category?: string },
): SupportKnowledgeChunkMatch[] {
  // SECURITY: role/enabled/category filtering happens before any scoring.
  const visible = listSupportKnowledgeDocs(tenantId).filter(
    (doc) =>
      doc.enabled !== false &&
      Array.isArray(doc.allowedRoles) &&
      (doc.allowedRoles.includes('*') || doc.allowedRoles.includes(userRole)) &&
      (!options?.category || doc.category === options.category),
  );
  const qTokens = new Set(tokenize(String(query ?? '')));
  if (qTokens.size === 0) return [];

  const matches: SupportKnowledgeChunkMatch[] = [];
  for (const doc of visible) {
    const titleScore = overlap(qTokens, doc.title) * 3;
    const tagScore = overlap(qTokens, (doc.tags ?? []).join(' ')) * 2;
    const chunks = doc.content.split(/\n\s*\n/).map((c) => c.trim()).filter(Boolean);
    let contentScore = 0;
    let best = { score: 0, text: '' };
    for (const chunk of chunks) {
      const s = overlap(qTokens, chunk);
      contentScore += s;
      if (s > best.score) best = { score: s, text: chunk };
    }
    const score = titleScore + tagScore + contentScore;
    if (score <= 0) continue;
    matches.push({
      docId: doc.id,
      title: doc.title,
      category: doc.category,
      tags: doc.tags ?? [],
      allowedRoles: doc.allowedRoles,
      snippet: truncate(best.text || chunks[0] || doc.title),
      score,
    });
  }
  matches.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return matches.slice(0, Math.max(1, options?.topK ?? 5));
}

export function buildSupportKnowledgeContextPrompt(matches: SupportKnowledgeChunkMatch[]): string {
  if (!matches.length) return '';
  const body = matches
    .map((m, i) => `${i + 1}. ${m.title} (${m.category})\n${m.snippet}`)
    .join('\n\n');
  return [
    '[ROLE-SCOPED KNOWLEDGE BASE]',
    'Use only the excerpts below when they are relevant. Do not reveal information beyond them.',
    '',
    body,
    '[END KNOWLEDGE BASE]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Masking policy
// ---------------------------------------------------------------------------

const ALL_DETECTORS: SupportBuiltinMaskDetector[] = ['email', 'phone', 'credit_card', 'api_key'];

function defaultPolicy(tenantId: string): SupportMaskingPolicy {
  return {
    tenantId,
    enabled: true,
    builtinDetectors: [...ALL_DETECTORS],
    unmaskedRoles: ['admin'],
    customRules: [],
    updatedAt: new Date(0).toISOString(),
  };
}

export function getSupportMaskingPolicy(tenantId: string): SupportMaskingPolicy {
  const tid = String(tenantId);
  const saved = readStore<SupportMaskingPolicy>(MASKING_KEY)[tid];
  if (!saved) return defaultPolicy(tid);
  const base = defaultPolicy(tid);
  return {
    ...base,
    ...saved,
    tenantId: tid,
    builtinDetectors: strArray(saved.builtinDetectors, base.builtinDetectors).filter((d): d is SupportBuiltinMaskDetector =>
      (ALL_DETECTORS as string[]).includes(d),
    ),
    unmaskedRoles: strArray(saved.unmaskedRoles, base.unmaskedRoles),
    customRules: Array.isArray(saved.customRules) ? saved.customRules : [],
  };
}

export function updateSupportMaskingPolicy(
  tenantId: string,
  patch: Partial<Omit<SupportMaskingPolicy, 'tenantId' | 'updatedAt'>>,
): SupportMaskingPolicy {
  const tid = String(tenantId);
  const current = getSupportMaskingPolicy(tid);
  const next: SupportMaskingPolicy = {
    ...current,
    enabled: patch.enabled ?? current.enabled,
    builtinDetectors: patch.builtinDetectors
      ? patch.builtinDetectors.filter((d) => ALL_DETECTORS.includes(d))
      : current.builtinDetectors,
    unmaskedRoles: patch.unmaskedRoles ? strArray(patch.unmaskedRoles, []) : current.unmaskedRoles,
    customRules: patch.customRules
      ? patch.customRules.map((r) => ({
          id: r.id || `rule_${randomUUID()}`,
          name: r.name,
          pattern: r.pattern,
          replacement: r.replacement ?? '[REDACTED]',
          enabled: r.enabled !== false,
        }))
      : current.customRules,
    updatedAt: new Date().toISOString(),
  };
  const store = readStore<SupportMaskingPolicy>(MASKING_KEY);
  store[tid] = next;
  writeStore(MASKING_KEY, store);
  return next;
}

// ---------------------------------------------------------------------------
// Masking engine
// ---------------------------------------------------------------------------

const API_KEY_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ptk_[A-Za-z0-9_-]{8,}|pss_[A-Za-z0-9_-]{8,})/g;
const CARD_RE = /(?<![\w*])(?:\d[ -]?){12,15}\d(?![\w])/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?<![\w*])\+?\d(?:[\d\s().-]{6,18})\d(?![\w])/g;

function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

function maskText(text: string, policy: SupportMaskingPolicy): { text: string; count: number; rules: string[] } {
  let out = text;
  let count = 0;
  const rules: string[] = [];
  const apply = (name: string, re: RegExp, fn: (m: string) => string | null) => {
    let hits = 0;
    out = out.replace(re, (m) => {
      const r = fn(m);
      if (r === null) return m;
      hits += 1;
      return r;
    });
    if (hits > 0) {
      count += hits;
      if (!rules.includes(name)) rules.push(name);
    }
  };
  const has = (d: SupportBuiltinMaskDetector) => policy.builtinDetectors.includes(d);

  if (has('api_key')) apply('api_key', API_KEY_RE, () => '[REDACTED_KEY]');
  if (has('credit_card')) {
    apply('credit_card', CARD_RE, (m) => {
      const d = digitsOf(m);
      if (d.length < 13 || d.length > 16) return null;
      return `****-****-****-${d.slice(-4)}`;
    });
  }
  if (has('email')) {
    apply('email', EMAIL_RE, (m) => {
      const at = m.lastIndexOf('@');
      return `${m.slice(0, 1)}***${m.slice(at)}`;
    });
  }
  if (has('phone')) {
    apply('phone', PHONE_RE, (m) => {
      const d = digitsOf(m);
      if (d.length < 9 || d.length > 15) return null;
      return `${'*'.repeat(d.length - 4)}${d.slice(-4)}`;
    });
  }
  for (const rule of policy.customRules) {
    if (!rule.enabled) continue;
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'gi');
    } catch {
      continue;
    }
    apply(rule.name, re, (m) => (m.length === 0 ? null : rule.replacement));
  }
  return { text: out, count, rules };
}

export function maskSupportSensitiveText(tenantId: string, text: string, userRole: string): SupportMaskResult<string> {
  const policy = getSupportMaskingPolicy(tenantId);
  const bypassed = policy.unmaskedRoles.includes(userRole);
  if (!policy.enabled || bypassed) {
    return { masked: text, redactionCount: 0, appliedRules: [], bypassedByRole: bypassed };
  }
  const r = maskText(String(text ?? ''), policy);
  return { masked: r.text, redactionCount: r.count, appliedRules: r.rules, bypassedByRole: false };
}

export function maskSupportSensitiveData<T>(tenantId: string, data: T, userRole: string): SupportMaskResult<T> {
  const policy = getSupportMaskingPolicy(tenantId);
  const bypassed = policy.unmaskedRoles.includes(userRole);
  if (!policy.enabled || bypassed) {
    return { masked: data, redactionCount: 0, appliedRules: [], bypassedByRole: bypassed };
  }
  let count = 0;
  const rules = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = maskText(v, policy);
      count += r.count;
      r.rules.forEach((x) => rules.add(x));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  const masked = walk(data) as T;
  return { masked, redactionCount: count, appliedRules: [...rules], bypassedByRole: false };
}
