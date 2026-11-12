import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  buildSupportKnowledgeContextPrompt,
  deleteSupportKnowledgeDoc,
  getSupportKnowledgeDocById,
  getSupportMaskingPolicy,
  listSupportKnowledgeDocs,
  maskSupportSensitiveData,
  maskSupportSensitiveText,
  searchSupportKnowledge,
  seedDefaultSupportKnowledgeDocs,
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../../custom/x-gateway/support-knowledge.js';

const T = 'tenant_1';

describe('support knowledge base', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'x_gateway_support_%'").run();
  });

  it('starts empty and seeds 4 default docs idempotently', () => {
    expect(listSupportKnowledgeDocs(T)).toEqual([]);
    const docs = seedDefaultSupportKnowledgeDocs(T);
    expect(docs).toHaveLength(4);
    expect(docs.map((d) => d.title)).toEqual([
      'Public Shipping & Delivery FAQ',
      'Customer Order & Loyalty Guide',
      'Internal Refund & Escalation SOP',
      'Executive SLA & Margin Playbook',
    ]);
    expect(docs[0].allowedRoles).toEqual(['*']);
    expect(docs[3].allowedRoles).toEqual(['admin']);
    expect(seedDefaultSupportKnowledgeDocs(T)).toHaveLength(4);
  });

  it('upserts, reads, updates and deletes a document', () => {
    const d = upsertSupportKnowledgeDoc(T, { title: 'Warranty', content: 'One year warranty.', tags: ['warranty'], allowedRoles: ['*'] });
    expect(d.id).toMatch(/^kb_/);
    expect(getSupportKnowledgeDocById(T, d.id)?.title).toBe('Warranty');
    const u = upsertSupportKnowledgeDoc(T, { id: d.id, title: 'Warranty v2', content: 'Two years.' });
    expect(u.id).toBe(d.id);
    expect(u.createdAt).toBe(d.createdAt);
    expect(u.allowedRoles).toEqual(['*']);
    expect(listSupportKnowledgeDocs(T)).toHaveLength(1);
    expect(deleteSupportKnowledgeDoc(T, d.id)).toBe(true);
    expect(deleteSupportKnowledgeDoc(T, d.id)).toBe(false);
    expect(getSupportKnowledgeDocById(T, d.id)).toBeUndefined();
  });

  it('new docs without allowedRoles default to admin-only', () => {
    const d = upsertSupportKnowledgeDoc(T, { title: 'Secret', content: 'hidden thing' });
    expect(d.allowedRoles).toEqual(['admin']);
  });

  it('isolates tenants', () => {
    seedDefaultSupportKnowledgeDocs(T);
    expect(listSupportKnowledgeDocs('tenant_2')).toEqual([]);
    expect(searchSupportKnowledge('tenant_2', 'shipping', 'admin')).toEqual([]);
  });

  it('guest only sees public docs', () => {
    seedDefaultSupportKnowledgeDocs(T);
    const r = searchSupportKnowledge(T, 'refund shipping margin', 'guest');
    expect(r.map((m) => m.title)).toEqual(['Public Shipping & Delivery FAQ']);
  });

  it('customer cannot see staff/admin internal docs', () => {
    seedDefaultSupportKnowledgeDocs(T);
    const r = searchSupportKnowledge(T, 'refund escalation sop margin sla', 'customer');
    const titles = r.map((m) => m.title);
    expect(titles).toContain('Customer Order & Loyalty Guide');
    expect(titles).not.toContain('Internal Refund & Escalation SOP');
    expect(titles).not.toContain('Executive SLA & Margin Playbook');
  });

  it('staff sees SOP but not the executive playbook; admin sees all', () => {
    seedDefaultSupportKnowledgeDocs(T);
    const staff = searchSupportKnowledge(T, 'escalation margin sla', 'staff').map((m) => m.title);
    expect(staff).toContain('Internal Refund & Escalation SOP');
    expect(staff).not.toContain('Executive SLA & Margin Playbook');
    const admin = searchSupportKnowledge(T, 'margin sla playbook', 'admin').map((m) => m.title);
    expect(admin[0]).toBe('Executive SLA & Margin Playbook');
  });

  it('disabled docs are never returned', () => {
    const d = upsertSupportKnowledgeDoc(T, { title: 'Promo', content: 'discount code', allowedRoles: ['*'], enabled: false });
    expect(searchSupportKnowledge(T, 'promo discount', 'admin')).toEqual([]);
    upsertSupportKnowledgeDoc(T, { id: d.id, title: 'Promo', content: 'discount code', enabled: true });
    expect(searchSupportKnowledge(T, 'promo discount', 'admin')).toHaveLength(1);
  });

  it('weights title > tags > content, honours topK and category', () => {
    upsertSupportKnowledgeDoc(T, { title: 'Billing', content: 'nothing', tags: [], allowedRoles: ['*'], category: 'faq' });
    upsertSupportKnowledgeDoc(T, { title: 'Other', content: 'nothing', tags: ['billing'], allowedRoles: ['*'], category: 'policy' });
    upsertSupportKnowledgeDoc(T, { title: 'Misc', content: 'about billing here', allowedRoles: ['*'], category: 'faq' });
    const r = searchSupportKnowledge(T, 'billing', 'guest');
    expect(r.map((m) => m.title)).toEqual(['Billing', 'Other', 'Misc']);
    expect(r.map((m) => m.score)).toEqual([3, 2, 1]);
    expect(searchSupportKnowledge(T, 'billing', 'guest', { topK: 1 })).toHaveLength(1);
    expect(searchSupportKnowledge(T, 'billing', 'guest', { category: 'policy' }).map((m) => m.title)).toEqual(['Other']);
  });

  it('returns relevant snippet capped at 400 chars and empty for no match', () => {
    const long = `${'filler '.repeat(100)}\n\nthe warranty covers battery defects ${'x'.repeat(600)}`;
    upsertSupportKnowledgeDoc(T, { title: 'Doc', content: long, allowedRoles: ['*'] });
    const [m] = searchSupportKnowledge(T, 'warranty battery', 'guest');
    expect(m.snippet.startsWith('the warranty covers')).toBe(true);
    expect(m.snippet.length).toBeLessThanOrEqual(400);
    expect(searchSupportKnowledge(T, 'zzzunknown', 'guest')).toEqual([]);
    expect(searchSupportKnowledge(T, '   ', 'guest')).toEqual([]);
  });

  it('builds the context prompt', () => {
    expect(buildSupportKnowledgeContextPrompt([])).toBe('');
    seedDefaultSupportKnowledgeDocs(T);
    const p = buildSupportKnowledgeContextPrompt(searchSupportKnowledge(T, 'shipping delivery', 'guest'));
    expect(p).toContain('[ROLE-SCOPED KNOWLEDGE BASE]');
    expect(p).toContain('Public Shipping & Delivery FAQ');
  });
});

describe('support masking', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('returns default policy when none saved', () => {
    const p = getSupportMaskingPolicy(T);
    expect(p.enabled).toBe(true);
    expect(p.builtinDetectors).toEqual(['email', 'phone', 'credit_card', 'api_key']);
    expect(p.unmaskedRoles).toEqual(['admin']);
    expect(p.customRules).toEqual([]);
  });

  it('masks credit cards, emails, phones and api keys', () => {
    const r = maskSupportSensitiveText(
      T,
      'Card 4111 1111 1111 1234, mail alice@example.com, tel 0912345678, key sk-abcdef1234567890 and ptk_abcd1234 pss_abcd1234',
      'customer',
    );
    expect(r.masked).toContain('****-****-****-1234');
    expect(r.masked).toContain('a***@example.com');
    expect(r.masked).toContain('******5678');
    expect(r.masked).not.toContain('sk-abcdef');
    expect(r.masked.match(/\[REDACTED_KEY\]/g)).toHaveLength(3);
    expect(r.redactionCount).toBe(6);
    expect(r.appliedRules.sort()).toEqual(['api_key', 'credit_card', 'email', 'phone']);
    expect(r.bypassedByRole).toBe(false);
  });

  it('handles dashed cards and leaves short numbers alone', () => {
    const r = maskSupportSensitiveText(T, 'card 4111-1111-1111-9999 order 12345 year 2026', 'guest');
    expect(r.masked).toBe('card ****-****-****-9999 order 12345 year 2026');
    expect(r.redactionCount).toBe(1);
  });

  it('admin bypasses masking; disabled policy bypasses without role flag', () => {
    const text = 'mail bob@example.com';
    const a = maskSupportSensitiveText(T, text, 'admin');
    expect(a).toEqual({ masked: text, redactionCount: 0, appliedRules: [], bypassedByRole: true });
    updateSupportMaskingPolicy(T, { enabled: false });
    const c = maskSupportSensitiveText(T, text, 'customer');
    expect(c).toEqual({ masked: text, redactionCount: 0, appliedRules: [], bypassedByRole: false });
  });

  it('updates policy: detectors, unmasked roles and custom rules', () => {
    updateSupportMaskingPolicy(T, {
      builtinDetectors: ['email'],
      unmaskedRoles: ['admin', 'staff'],
      customRules: [
        { id: 'r1', name: 'order_id', pattern: 'ORD-\\d+', replacement: '[REDACTED_ID]', enabled: true },
        { id: 'r2', name: 'off', pattern: 'secret', replacement: 'X', enabled: false },
        { id: 'r3', name: 'bad', pattern: '(', replacement: 'X', enabled: true },
      ],
    });
    const p = getSupportMaskingPolicy(T);
    expect(p.builtinDetectors).toEqual(['email']);
    const r = maskSupportSensitiveText(T, 'ord-42 secret tel 0912345678 a@b.io', 'customer');
    expect(r.masked).toBe('[REDACTED_ID] secret tel 0912345678 a***@b.io');
    expect(r.appliedRules.sort()).toEqual(['email', 'order_id']);
    expect(maskSupportSensitiveText(T, 'a@b.io', 'staff').bypassedByRole).toBe(true);
  });

  it('masks nested data and aggregates counts and unique rules', () => {
    const data = {
      name: 'Alice',
      email: 'alice@example.com',
      notes: ['call 0912345678', 'again 0912345678'],
      nested: { card: '4111111111111111', n: 5, ok: true, nothing: null },
    };
    const r = maskSupportSensitiveData(T, data, 'customer');
    expect(r.masked).toEqual({
      name: 'Alice',
      email: 'a***@example.com',
      notes: ['call ******5678', 'again ******5678'],
      nested: { card: '****-****-****-1111', n: 5, ok: true, nothing: null },
    });
    expect(r.redactionCount).toBe(4);
    expect(r.appliedRules.sort()).toEqual(['credit_card', 'email', 'phone']);
    expect(data.email).toBe('alice@example.com');
    const bypass = maskSupportSensitiveData(T, data, 'admin');
    expect(bypass.masked).toBe(data);
    expect(bypass.bypassedByRole).toBe(true);
  });

  it('keeps masking policies per tenant', () => {
    updateSupportMaskingPolicy(T, { enabled: false });
    expect(getSupportMaskingPolicy('tenant_other').enabled).toBe(true);
  });
});
