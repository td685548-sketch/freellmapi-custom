import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, type Db } from '../../db/index.js';
import * as supportStore from '../../custom/x-gateway/support-store.js';
import {
  createSupportEvidenceSource,
  ensureSupportEvidenceTables,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
  SupportEvidenceError,
} from '../../custom/x-gateway/support-evidence-store.js';
import {
  updateSupportMaskingPolicy,
  upsertSupportKnowledgeDoc,
} from '../../custom/x-gateway/support-knowledge.js';
import {
  buildCurrentLegacyEvidence,
  deriveLegacyRevisionId,
  getSupportEvidenceSnapshotId,
  normalizeForLexicalSearch,
  retrieveSupportEvidence,
  tokenizeLexicalQuery,
  validateStoredSupportEvidence,
  validateSupportEvidenceReply,
} from '../../custom/x-gateway/support-evidence-retrieval.js';
import {
  DEFAULT_EVIDENCE_POLICY,
  SUPPORT_EVIDENCE_LIMITS,
  type SupportEvidencePolicy,
} from '@freellmapi/shared/support-evidence.js';

let db: Db;
let tenantAId: number;
let tenantBId: number;

beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
  db = initDb(':memory:');
  supportStore.ensureSupportTables();
  ensureSupportEvidenceTables(db);

  tenantAId = supportStore.createSupportTenant({ name: 'Alpha Retailer' }).tenant.id;
  tenantBId = supportStore.createSupportTenant({ name: 'Beta Systems' }).tenant.id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  db?.close?.();
});

describe('support-evidence-retrieval: normalization & tokenization', () => {
  it('normalizes Vietnamese diacritics and maps "đ"/"Đ" to "d"', () => {
    const raw = 'Chính sách VẬN CHUYỂN & đổi trả hàng Đã Duyệt';
    const normalized = normalizeForLexicalSearch(raw);
    expect(normalized).toBe('chinh sach van chuyen & doi tra hang da duyet');

    const unaccented = normalizeForLexicalSearch('chinh sach van chuyen & doi tra hang da duyet');
    expect(normalized).toBe(unaccented);
  });

  it('tokenizes Unicode letters/digits and caps at 32 unique terms in stable order', () => {
    const words = Array.from({ length: 40 }, (_, i) => `term${i + 1}`);
    const query = `${words.join(' ')} term1 term2`;
    const tokens = tokenizeLexicalQuery(query, 32);
    expect(tokens.length).toBe(32);
    expect(tokens[0]).toBe('term1');
    expect(tokens[1]).toBe('term2');
    expect(tokens[31]).toBe('term32');
    // Ensure uniqueness
    expect(new Set(tokens).size).toBe(32);
  });

  it('handles empty or punctuation-only queries gracefully', () => {
    expect(tokenizeLexicalQuery('')).toEqual([]);
    expect(tokenizeLexicalQuery('   ')).toEqual([]);
    expect(tokenizeLexicalQuery('!@#$%^&*()_+{}[]:;"<>,.?/')).toEqual([]);
  });
});

describe('support-evidence-retrieval: legacy doc adapter', () => {
  it('filters role-visible and enabled legacy docs before chunking with virtual IDs', () => {
    upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_public',
      title: 'Public Shipping FAQ',
      content: 'Standard shipping takes 3-5 days across all regions.',
      allowedRoles: ['*'],
      enabled: true,
    });
    upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_admin_only',
      title: 'Executive Margin SOP',
      content: 'Admin margins must remain above 35 percent.',
      allowedRoles: ['admin'],
      enabled: true,
    });
    upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_disabled',
      title: 'Disabled Old Guide',
      content: 'Do not use this outdated guide.',
      allowedRoles: ['*'],
      enabled: false,
    });

    const guestChunks = buildCurrentLegacyEvidence(tenantAId, 'guest');
    expect(guestChunks.length).toBe(1);
    expect(guestChunks[0].chunk.sourceId).toBe('legacy:doc_public');
    expect(guestChunks[0].chunk.revisionId).toMatch(/^legrev_[a-f0-9]{24}$/);
    expect(guestChunks[0].title).toBe('Public Shipping FAQ');

    const adminChunks = buildCurrentLegacyEvidence(tenantAId, 'admin');
    expect(adminChunks.length).toBe(2);
    expect(adminChunks.some((c) => c.chunk.sourceId === 'legacy:doc_admin_only')).toBe(true);
    expect(adminChunks.some((c) => c.chunk.sourceId === 'legacy:doc_disabled')).toBe(false);
  });

  it('detects changes in legacy docs and derives a different revisionId', () => {
    const doc1 = upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_mutating',
      title: 'Version One Title',
      content: 'Initial text content.',
      allowedRoles: ['*'],
      enabled: true,
    });
    const rev1 = deriveLegacyRevisionId(doc1);

    const doc2 = upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_mutating',
      title: 'Version Two Title',
      content: 'Modified text content.',
      allowedRoles: ['*'],
      enabled: true,
    });
    const rev2 = deriveLegacyRevisionId(doc2);
    expect(rev1).not.toBe(rev2);
  });
});

describe('support-evidence-retrieval: snapshot IDs', () => {
  it('is deterministic and changes when published revisions or ACL change, but NOT on drafts', async () => {
    const policy = DEFAULT_EVIDENCE_POLICY;
    const initialSnap = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(initialSnap).toMatch(/^[a-f0-9]{64}$/);

    // 1. Create a new source (draft) -> snapshot must NOT change
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Shipping Guide',
      kind: 'markdown',
      allowedRoles: ['customer', 'admin'],
    });
    const snapAfterDraftSource = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(snapAfterDraftSource).toBe(initialSnap);

    // 2. Import draft revision -> snapshot must NOT change
    const { revision } = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Shipping Details',
      format: 'markdown',
      content: 'Delivery takes 3 to 5 business days for all domestic parcels.',
    });
    const snapAfterDraftRevision = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(snapAfterDraftRevision).toBe(initialSnap);

    // 3. Publish revision -> snapshot MUST change
    const published = publishSupportEvidenceRevision(tenantAId, src.id, revision.id, src.version + 1);
    const snapAfterPublish = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(snapAfterPublish).not.toBe(initialSnap);

    // 4. Update source name only -> snapshot must NOT change (name alone does not affect retrieved content or ACL)
    const updatedName = updateSupportEvidenceSource(
      tenantAId,
      src.id,
      { name: 'Renamed Shipping Guide' },
      published.version,
    );
    const snapAfterNameChange = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(snapAfterNameChange).toBe(snapAfterPublish);

    // 5. Update allowedRoles -> snapshot MUST change
    updateSupportEvidenceSource(
      tenantAId,
      src.id,
      { allowedRoles: ['admin'] },
      updatedName.version,
    );
    const snapAfterAclChange = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'customer', policy });
    expect(snapAfterAclChange).not.toBe(snapAfterPublish);
  });

  it('changes snapshot when masking policy or legacy docs change', () => {
    const policy = DEFAULT_EVIDENCE_POLICY;
    const snap1 = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'guest', policy });

    updateSupportMaskingPolicy(String(tenantAId), {
      builtinDetectors: ['email', 'phone', 'api_key'],
    });
    const snap2 = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'guest', policy });
    expect(snap2).not.toBe(snap1);

    upsertSupportKnowledgeDoc(String(tenantAId), {
      id: 'doc_extra',
      title: 'New Knowledge Doc',
      content: 'Some extra text.',
      allowedRoles: ['*'],
      enabled: true,
    });
    const snap3 = getSupportEvidenceSnapshotId({ tenantId: tenantAId, role: 'guest', policy });
    expect(snap3).not.toBe(snap2);
  });
});

describe('support-evidence-retrieval: lexical ranking & EvidencePack', () => {
  it('ranks published sources and respects role isolation in EN and VI', async () => {
    // Source 1: Shipping (Guest + Customer)
    const src1 = createSupportEvidenceSource(tenantAId, {
      name: 'Shipping FAQ',
      kind: 'markdown',
      allowedRoles: ['guest', 'customer', 'staff', 'admin'],
    });
    const r1 = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src1.id,
      expectedVersion: src1.version,
      title: 'Quy định giao nhận và cước phí vận chuyển',
      category: 'van_chuyen',
      tags: ['giao_hang', 'van_chuyen', 'cuoc_phi'],
      format: 'markdown',
      content: 'Thời gian giao hàng tiêu chuẩn kéo dài từ 3 đến 5 ngày làm việc trên toàn quốc.',
    });
    publishSupportEvidenceRevision(tenantAId, src1.id, r1.revision.id, src1.version + 1);

    // Source 2: Staff only SOP
    const src2 = createSupportEvidenceSource(tenantAId, {
      name: 'Staff Refund SOP',
      kind: 'markdown',
      allowedRoles: ['staff', 'admin'],
    });
    const r2 = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src2.id,
      expectedVersion: src2.version,
      title: 'Internal Refund SOP',
      category: 'sop',
      tags: ['refund', 'sop'],
      format: 'markdown',
      content: 'Support staff may refund up to 100 USD without admin signoff.',
    });
    publishSupportEvidenceRevision(tenantAId, src2.id, r2.revision.id, src2.version + 1);

    const policy: SupportEvidencePolicy = {
      ...DEFAULT_EVIDENCE_POLICY,
      topK: 3,
      minCoverage: 0.25,
      maxEvidenceChars: 6000,
    };

    // Guest asking Vietnamese unaccented query
    const guestPack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'thoi gian giao hang tieu chuan mat may ngay',
      policy,
    });

    expect(guestPack.candidates.length).toBe(1);
    expect(guestPack.candidates[0].sourceId).toBe(src1.id);
    expect(guestPack.candidates[0].lexicalCoverage).toBeGreaterThanOrEqual(0.25);
    expect(guestPack.candidates[0].score).toBeGreaterThan(0);
    expect(guestPack.candidates[0].score).toBeLessThanOrEqual(1.0);
    expect(guestPack.contextPrompt).toContain(guestPack.candidates[0].citationId);
    expect(guestPack.contextPrompt).toContain(guestPack.candidates[0].providedText);
    expect(guestPack.contextPrompt).toContain('ROLE-SCOPED KNOWLEDGE BASE');

    // Guest asking for staff refund -> should abstain honestly (no candidates)
    const guestStaffPack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'refund up to 100 USD without admin signoff',
      policy,
    });
    expect(guestStaffPack.candidates.length).toBe(0);
    expect(guestStaffPack.contextPrompt).toBe('');

    // Staff asking for staff refund -> should match
    const staffPack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'staff',
      query: 'refund up to 100 USD without admin signoff',
      policy,
    });
    expect(staffPack.candidates.length).toBe(1);
    expect(staffPack.candidates[0].sourceId).toBe(src2.id);
  });

  it('bounds EvidencePack contextPrompt strictly to min(policy, maxContextChars)', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Long Document',
      kind: 'markdown',
      allowedRoles: ['guest', 'admin'],
    });
    const longText = 'Paragraph test with details about shipping methods.\n\n'.repeat(40);
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Long Shipping Handbook',
      format: 'markdown',
      content: longText,
    });
    publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const policy: SupportEvidencePolicy = {
      ...DEFAULT_EVIDENCE_POLICY,
      topK: 5,
      maxEvidenceChars: 1200,
    };

    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'shipping methods details paragraph',
      policy,
      maxContextChars: 800, // lower than policy
    });

    expect(pack.contextPrompt.length).toBeLessThanOrEqual(800);
    // Every candidate returned must appear in the actual contextPrompt
    for (const c of pack.candidates) {
      expect(pack.contextPrompt).toContain(c.citationId);
      expect(pack.contextPrompt).toContain(c.providedText);
      expect(c.providedText.length).toBeGreaterThanOrEqual(SUPPORT_EVIDENCE_LIMITS.minClippedChunkChars);
    }
  });

  it('isolates tenants completely (Tenant B cannot see Tenant A sources)', async () => {
    const srcA = createSupportEvidenceSource(tenantAId, {
      name: 'Alpha Secret Knowledge',
      kind: 'markdown',
      allowedRoles: ['guest', 'admin'],
    });
    const rA = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: srcA.id,
      expectedVersion: srcA.version,
      title: 'Alpha Secret Title',
      format: 'markdown',
      content: 'Alpha secret token is confidential.',
    });
    publishSupportEvidenceRevision(tenantAId, srcA.id, rA.revision.id, srcA.version + 1);

    const packB = retrieveSupportEvidence({
      tenantId: tenantBId,
      role: 'guest',
      query: 'Alpha Secret Knowledge token',
      policy: DEFAULT_EVIDENCE_POLICY,
    });
    expect(packB.candidates.length).toBe(0);
    expect(packB.contextPrompt).toBe('');
  });
});

describe('support-evidence-retrieval: citation verification', () => {
  it('accepts valid citations, deduplicates repeats, and canonicalizes to [1], [2]', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Refund & Returns',
      kind: 'markdown',
      allowedRoles: ['customer', 'admin'],
    });
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Customer Returns & Refund Policy',
      format: 'markdown',
      content: 'Returns are accepted within 30 days of delivery. Refunds are processed in 5-7 business days.',
    });
    publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const policy = DEFAULT_EVIDENCE_POLICY;
    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'customer',
      query: 'returns accepted days refunds processed',
      policy,
    });

    expect(pack.candidates.length).toBeGreaterThanOrEqual(1);
    const cit1 = pack.candidates[0].citationId;

    const rawReply = `You can return items within 30 days [cite:${cit1}]. As noted earlier, refunds take 5-7 days [cite:${cit1}].`;
    const validation = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy,
      pack,
      reply: rawReply,
    });

    expect(validation.valid).toBe(true);
    expect(validation.canonicalReply).toBe(
      'You can return items within 30 days [1]. As noted earlier, refunds take 5-7 days [1].',
    );
    expect(validation.citations.length).toBe(1);
    expect(validation.citations[0].id).toBe(cit1);
    expect(validation.citations[0].ordinal).toBe(1);
    expect(validation.citations[0].excerpt.length).toBeLessThanOrEqual(240);
  });

  it('rejects forged/unprovided citation IDs with invalid_citations', () => {
    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'anything',
      policy: DEFAULT_EVIDENCE_POLICY,
    });

    const reply = 'Here is some statement [cite:cit_forged_unknown_id].';
    const validation = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'guest',
      policy: DEFAULT_EVIDENCE_POLICY,
      pack,
      reply,
    });

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('invalid_citations');
  });

  it('rejects malformed citation syntax and zero citations', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Info',
      kind: 'markdown',
      allowedRoles: ['guest'],
    });
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Info Doc',
      format: 'markdown',
      content: 'General information text here.',
    });
    publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'information text',
      policy: DEFAULT_EVIDENCE_POLICY,
    });

    // Zero citations
    const noCite = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'guest',
      policy: DEFAULT_EVIDENCE_POLICY,
      pack,
      reply: 'An answer with no citations at all.',
    });
    expect(noCite.valid).toBe(false);
    expect(noCite.reason).toBe('invalid_citations');

    // Malformed citation marker
    const malformed = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'guest',
      policy: DEFAULT_EVIDENCE_POLICY,
      pack,
      reply: 'An answer with [cite: unclosed and malformed marker.',
    });
    expect(malformed.valid).toBe(false);
    expect(malformed.reason).toBe('invalid_citations');
  });

  it('rejects replies containing business tool markup even if valid citation is present', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Guide',
      kind: 'markdown',
      allowedRoles: ['guest'],
    });
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Guide Title',
      format: 'markdown',
      content: 'Shipping policy details.',
    });
    publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'shipping policy',
      policy: DEFAULT_EVIDENCE_POLICY,
    });
    const citId = pack.candidates[0].citationId;

    const toolReply = `According to our policy [cite:${citId}], here is the answer: <support_tool_call>{"name":"lookup_order"}</support_tool_call>`;
    const validation = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'guest',
      policy: DEFAULT_EVIDENCE_POLICY,
      pack,
      reply: toolReply,
    });

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('invalid_citations');
  });

  it('rejects with sources_changed when active sources change before reply finalization', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Guide',
      kind: 'markdown',
      allowedRoles: ['guest'],
    });
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Guide Title',
      format: 'markdown',
      content: 'Original shipping policy.',
    });
    const published = publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const policy = DEFAULT_EVIDENCE_POLICY;
    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'guest',
      query: 'shipping policy',
      policy,
    });
    const citId = pack.candidates[0].citationId;

    // Mutate the source by archiving it before reply validation
    updateSupportEvidenceSource(tenantAId, src.id, { status: 'archived' }, published.version);

    const validation = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'guest',
      policy,
      pack,
      reply: `Here is the valid answer [cite:${citId}].`,
    });

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('sources_changed');
  });
});

describe('support-evidence-retrieval: validateStoredSupportEvidence', () => {
  it('validates unexpired stored evidence and invalidates upon source revocation or policy edit', async () => {
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Shipping Rules',
      kind: 'markdown',
      allowedRoles: ['customer', 'admin'],
    });
    const r = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Shipping Rules',
      format: 'markdown',
      content: 'Items ship within 24 hours of payment verification.',
    });
    const published = publishSupportEvidenceRevision(tenantAId, src.id, r.revision.id, src.version + 1);

    const policy = DEFAULT_EVIDENCE_POLICY;
    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'customer',
      query: 'items ship payment verification',
      policy,
    });
    const valid = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy,
      pack,
      reply: `Items ship in 24 hours [cite:${pack.candidates[0].citationId}].`,
    });

    expect(valid.valid).toBe(true);

    const storedEvidence = {
      requestId: 'req_123',
      status: 'cited' as const,
      policyVersion: policy.version,
      snapshotId: pack.snapshotId,
      citations: valid.citations,
    };

    // Stored evidence is valid initially
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        record: storedEvidence,
      }),
    ).toBe(true);

    // Stored evidence fails when checked for an unauthorized role ('guest')
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'guest',
        policy,
        record: storedEvidence,
      }),
    ).toBe(false);

    // Stored evidence fails when policy version changes
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy: { ...policy, version: policy.version + 1 },
        record: storedEvidence,
      }),
    ).toBe(false);

    // Stored evidence fails when underlying source is archived
    updateSupportEvidenceSource(tenantAId, src.id, { status: 'archived' }, published.version);
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        record: storedEvidence,
      }),
    ).toBe(false);
  });

  it('F04 regression: rejects old pack when saved policy updates from version 2 to 3 in real store', async () => {
    // 1. Initial policy starts at version 1; update saved policy to version 2
    const policyV2 = updateSupportEvidencePolicy(
      tenantAId,
      {
        minCoverage: 0.25,
        topK: 3,
      },
      1,
    );
    expect(policyV2.version).toBe(2);

    // 2. Create and publish a source
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Returns Knowledge Source',
      kind: 'text',
      allowedRoles: ['customer', 'staff', 'admin'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Customer Return and Refund Policy',
      category: 'returns',
      tags: ['returns', 'refunds'],
      format: 'text',
      content: 'Customers have 30 days from delivery to request a refund or return.',
    });
    publishSupportEvidenceRevision(tenantAId, src.id, rev.revision.id, src.version + 1);

    // 3. Retrieve pack at version 2
    const packV2 = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'customer',
      query: 'What is the return refund policy timeframe?',
      policy: policyV2,
    });
    expect(packV2.policyVersion).toBe(2);
    expect(packV2.candidates.length).toBeGreaterThan(0);

    const validCitationId = packV2.candidates[0].citationId;
    const modelReply = `According to our policy, you have 30 days to return an item [cite:${validCitationId}].`;

    // 4. Before policy change, reply is valid
    const initialValidation = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy: policyV2,
      pack: packV2,
      reply: modelReply,
    });
    expect(initialValidation.valid).toBe(true);
    expect(initialValidation.citations.length).toBe(1);

    // 5. Change saved policy in real store to version 3
    const policyV3 = updateSupportEvidencePolicy(
      tenantAId,
      {
        minCoverage: 0.35,
      },
      2,
    );
    expect(policyV3.version).toBe(3);

    // 6. Old pack validation MUST be rejected under runtime validation contract (sources_changed)
    // Case A: caller passes updated policyV3
    const validationWithNewPolicy = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy: policyV3,
      pack: packV2,
      reply: modelReply,
    });
    expect(validationWithNewPolicy.valid).toBe(false);
    expect(validationWithNewPolicy.reason).toBe('sources_changed');

    // Case B: caller (stale turn) passes old policyV2 object captured before model call
    const validationWithOldPolicyObject = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy: policyV2,
      pack: packV2,
      reply: modelReply,
    });
    expect(validationWithOldPolicyObject.valid).toBe(false);
    expect(validationWithOldPolicyObject.reason).toBe('sources_changed');

    // Case C: caller omits policy object, letting validator read real store
    const validationWithoutPolicyParam = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      pack: packV2,
      reply: modelReply,
    });
    expect(validationWithoutPolicyParam.valid).toBe(false);
    expect(validationWithoutPolicyParam.reason).toBe('sources_changed');

    // 7. Stored evidence validation also rejects the old version 2 record
    const storedRecord = {
      tenantId: tenantAId,
      role: 'customer' as const,
      evidence: {
        requestId: 'req_v2',
        status: 'cited' as const,
        policyVersion: 2,
        snapshotId: packV2.snapshotId,
        citations: initialValidation.citations,
      },
    };
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        record: storedRecord,
      }),
    ).toBe(false);
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy: policyV2,
        record: storedRecord,
      }),
    ).toBe(false);
  });

  it('R2-04 regression: corrupt or unavailable policy storage fails closed with typed 503 error, never valid: true or accepting stale record', async () => {
    // 1. Initial saved policy
    const policy = updateSupportEvidencePolicy(
      tenantAId,
      {
        minCoverage: 0.25,
        topK: 3,
      },
      1,
    );

    // 2. Publish authorized source
    const src = createSupportEvidenceSource(tenantAId, {
      name: 'Shipping Guide Source',
      kind: 'text',
      allowedRoles: ['customer', 'staff', 'admin'],
    });
    const rev = await importSupportEvidenceRevision({
      tenantId: tenantAId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: 'Shipping and Delivery Guide',
      category: 'shipping',
      tags: ['shipping', 'delivery'],
      format: 'text',
      content: 'Standard domestic delivery takes 3 to 5 business days across all regions.',
    });
    publishSupportEvidenceRevision(tenantAId, src.id, rev.revision.id, src.version + 1);

    // 3. Retrieve valid pack
    const pack = retrieveSupportEvidence({
      tenantId: tenantAId,
      role: 'customer',
      query: 'delivery timeline standard',
      policy,
    });
    expect(pack.candidates.length).toBeGreaterThan(0);

    // 4. Verify baseline citation
    const validCitationId = pack.candidates[0].citationId;
    const modelReply = `Delivery takes 3 to 5 business days [cite:${validCitationId}].`;

    const baseline = validateSupportEvidenceReply({
      tenantId: tenantAId,
      role: 'customer',
      policy,
      pack,
      reply: modelReply,
    });
    expect(baseline.valid).toBe(true);
    expect(baseline.citations.length).toBe(1);

    const storedRecord = {
      tenantId: tenantAId,
      role: 'customer' as const,
      evidence: {
        requestId: 'req_corrupt_test',
        status: 'cited' as const,
        policyVersion: policy.version,
        snapshotId: pack.snapshotId,
        citations: baseline.citations,
      },
    };
    expect(
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        record: storedRecord,
      }),
    ).toBe(true);

    // 5. Corrupt policy storage in SQLite (invalid JSON)
    db.prepare(
      "UPDATE x_support_evidence_policies SET policy_json = 'INVALID_NON_JSON_CONTENT' WHERE tenant_id = ?",
    ).run(tenantAId);

    // 6. Fresh validator must NEVER return valid: true on corrupt storage
    let freshError: unknown;
    try {
      validateSupportEvidenceReply({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        pack,
        reply: modelReply,
      });
    } catch (err) {
      freshError = err;
    }
    expect(freshError).toBeInstanceOf(SupportEvidenceError);
    const freshSupportErr = freshError as SupportEvidenceError;
    expect(freshSupportErr.statusCode).toBe(503);
    expect(freshSupportErr.code).toBe('evidence_storage_unavailable');

    // 7. Stored validator must NEVER accept the stale record on corrupt storage
    let storedError: unknown;
    try {
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        record: storedRecord,
      });
    } catch (err) {
      storedError = err;
    }
    expect(storedError).toBeInstanceOf(SupportEvidenceError);
    const storedSupportErr = storedError as SupportEvidenceError;
    expect(storedSupportErr.statusCode).toBe(503);
    expect(storedSupportErr.code).toBe('evidence_storage_unavailable');

    // 8. Test unavailable storage: table dropped entirely
    db.prepare('DROP TABLE x_support_evidence_policies').run();

    expect(() =>
      validateSupportEvidenceReply({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        pack,
        reply: modelReply,
      }),
    ).toThrow(SupportEvidenceError);

    expect(() =>
      validateStoredSupportEvidence({
        tenantId: tenantAId,
        role: 'customer',
        policy,
        record: storedRecord,
      }),
    ).toThrow(SupportEvidenceError);
  });
});
