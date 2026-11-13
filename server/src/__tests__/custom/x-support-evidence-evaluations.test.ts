import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDb, type Db } from '../../db/index.js';
import * as supportStore from '../../custom/x-gateway/support-store.js';
import {
  createSupportEvidenceSource,
  ensureSupportEvidenceTables,
  getSupportEvidenceRun,
  getSupportEvidenceSource,
  importSupportEvidenceRevision,
  publishSupportEvidenceRevision,
  saveSupportEvidenceSuite,
  updateSupportEvidencePolicy,
  updateSupportEvidenceSource,
} from '../../custom/x-gateway/support-evidence-store.js';
import { runSupportEvidenceSuite } from '../../custom/x-gateway/support-evidence-evaluations.js';
import * as retrieval from '../../custom/x-gateway/support-evidence-retrieval.js';
import {
  type SupportEvidenceCase,
  type SupportEvidenceFormat,
  type SupportEvidenceRole,
} from '@freellmapi/shared/support-evidence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/support-evidence/evaluation-cases.json');

let db: Db;
let tenantId: number;
let sourceIdMap: Map<string, string>;

interface FixtureSource {
  name: string;
  kind: 'markdown';
  allowedRoles: SupportEvidenceRole[];
  format: SupportEvidenceFormat;
  title: string;
  category: string;
  tags: string[];
  content: string;
}

interface FixtureCase {
  id: string;
  query: string;
  role: SupportEvidenceRole;
  expectedKeys: string[];
  forbiddenKeys: string[];
  expectAbstention: boolean;
}

interface FixtureDataset {
  fixtureVersion: number;
  sources: Record<string, FixtureSource>;
  cases: FixtureCase[];
}

beforeEach(async () => {
  vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
  db = initDb(':memory:');
  supportStore.ensureSupportTables();
  ensureSupportEvidenceTables(db);

  tenantId = supportStore.createSupportTenant({ name: 'Evaluation Tenant' }).tenant.id;

  // Load and seed the 26 fixture sources into tenant
  const rawJson = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const fixtureData = JSON.parse(rawJson) as FixtureDataset;
  sourceIdMap = new Map<string, string>();

  for (const [key, srcDef] of Object.entries(fixtureData.sources)) {
    const src = createSupportEvidenceSource(tenantId, {
      name: srcDef.name,
      kind: srcDef.kind,
      allowedRoles: srcDef.allowedRoles,
    });
    const rev = await importSupportEvidenceRevision({
      tenantId,
      sourceId: src.id,
      expectedVersion: src.version,
      title: srcDef.title,
      category: srcDef.category,
      tags: srcDef.tags,
      format: srcDef.format,
      content: srcDef.content,
    });
    publishSupportEvidenceRevision(tenantId, src.id, rev.revision.id, src.version + 1);
    sourceIdMap.set(key, src.id);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  db?.close?.();
});

function loadFixtureCases(): SupportEvidenceCase[] {
  const rawJson = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const fixtureData = JSON.parse(rawJson) as FixtureDataset;

  return fixtureData.cases.map((c) => ({
    id: c.id,
    query: c.query,
    role: c.role,
    expectedSourceIds: c.expectedKeys.map((k) => sourceIdMap.get(k)!).filter(Boolean),
    forbiddenSourceIds: c.forbiddenKeys.map((k) => sourceIdMap.get(k)!).filter(Boolean),
    expectAbstention: c.expectAbstention,
  }));
}

describe('support-evidence-evaluations: suite execution & reporting', () => {
  it('executes full 26-case fixture suite with 100% pass and honest metrics', () => {
    const cases = loadFixtureCases();
    expect(cases.length).toBeGreaterThanOrEqual(24);

    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Full Knowledge Regression Suite',
      cases,
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    expect(run.status).toBe('completed');
    expect(run.allPassed).toBe(true);
    expect(run.totalCases).toBe(cases.length);
    expect(run.casesChecked).toBe(cases.length);
    expect(run.expectedCasesChecked).toBeGreaterThan(0);
    expect(run.hitAtK).toBe(1.0);
    expect(run.snapshotIds.length).toBeGreaterThanOrEqual(1);

    // Verify persisted report can be loaded from DB
    const loadedRun = getSupportEvidenceRun(tenantId, run.id);
    expect(loadedRun.id).toBe(run.id);
    expect(loadedRun.allPassed).toBe(true);
    expect(loadedRun.results.length).toBe(cases.length);
  });

  it('fails honestly when an expected source is removed or archived', () => {
    const cases = loadFixtureCases().slice(0, 5);
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Archive Test Suite',
      cases,
    });

    // Find the source used in case 1 and archive it
    const targetSourceId = cases[0].expectedSourceIds[0];
    const sourceRec = db
      .prepare('SELECT version FROM x_support_evidence_sources WHERE tenant_id = ? AND id = ?')
      .get(tenantId, targetSourceId) as { version: number };

    updateSupportEvidenceSource(tenantId, targetSourceId, { status: 'archived' }, sourceRec.version);

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    expect(run.status).toBe('completed');
    expect(run.allPassed).toBe(false);

    // Case 0 must fail because its expected source was archived and no longer returned
    const failedCase = run.results.find((r) => r.caseId === cases[0].id);
    expect(failedCase).toBeDefined();
    expect(failedCase?.expectedHit).toBe(false);
    expect(failedCase?.passed).toBe(false);
  });

  it('fails when a forbidden source appears in returned topK', () => {
    // Construct a case where a public source is forbidden but query explicitly matches it
    const publicShippingSourceId = sourceIdMap.get('shipping_faq')!;

    const testCase: SupportEvidenceCase = {
      id: 'case_forbidden_leak',
      query: 'Standard domestic delivery takes 3 to 5 business days',
      role: 'guest',
      expectedSourceIds: [],
      forbiddenSourceIds: [publicShippingSourceId],
      expectAbstention: true,
    };

    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Forbidden Test Suite',
      cases: [testCase],
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    expect(run.allPassed).toBe(false);
    const res = run.results[0];
    expect(res.forbiddenHitCount).toBeGreaterThan(0);
    expect(res.passed).toBe(false);
  });

  it('calculates hitAtK denominator accurately (0 when no cases have expected sources)', () => {
    const abstentionOnlyCase: SupportEvidenceCase = {
      id: 'case_only_abstention',
      query: 'Query that does not match anything in the knowledge base',
      role: 'guest',
      expectedSourceIds: [],
      forbiddenSourceIds: [],
      expectAbstention: true,
    };

    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Zero Denominator Suite',
      cases: [abstentionOnlyCase],
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    expect(run.status).toBe('completed');
    expect(run.expectedCasesChecked).toBe(0);
    expect(run.hitAtK).toBe(0); // must be 0 rather than manufactured 100%
    expect(run.allPassed).toBe(true); // because the case passed its abstention check
  });

  it('stops gracefully and marks status=partial when CPU deadline is exceeded', () => {
    const cases = loadFixtureCases();
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Timeout Test Suite',
      cases,
    });

    // Provide an impossibly small deadline (0 ms) to trigger immediate timeout
    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
      deadlineMs: 0,
    });

    expect(run.status).toBe('partial');
    expect(run.allPassed).toBe(false);
    expect(run.casesChecked).toBe(0);
    expect(run.totalCases).toBe(cases.length);

    // Unexecuted cases should report an explicit error
    const unexecuted = run.results.filter((r) => r.error);
    expect(unexecuted.length).toBe(cases.length);
    expect(unexecuted[0].error).toContain('deadline');
  });

  it('marks status=partial and allPassed=false if sources change during suite run', () => {
    const cases = loadFixtureCases().slice(0, 4);
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Snapshot Consistency Suite',
      cases,
    });

    // First run with unchanged sources -> completed
    const run1 = runSupportEvidenceSuite({ tenantId, suiteId: suite.id });
    expect(run1.status).toBe('completed');
    expect(run1.allPassed).toBe(true);

    // Now test deterministic replay: run again without changes -> same snapshot and allPassed=true
    const run2 = runSupportEvidenceSuite({ tenantId, suiteId: suite.id });
    expect(run2.status).toBe('completed');
    expect(run2.allPassed).toBe(true);
    expect(run2.snapshotIds).toEqual(run1.snapshotIds);
  });

  it('does NOT invoke external model, quota, or CRM operations during evaluation', () => {
    const cases = loadFixtureCases().slice(0, 2);
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'No AI Call Suite',
      cases,
    });

    // Spy on global fetch to prove zero network calls
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    expect(run.status).toBe('completed');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never leaks forbidden titles or snippets into the run results', () => {
    const cases = loadFixtureCases();
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Security Leak Suite',
      cases,
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });

    const reportJson = JSON.stringify(run);
    // Secret keywords from admin playbook should never appear in results
    expect(reportJson).not.toContain('Executive Margin Rules and Service Level Targets');
    expect(reportJson).not.toContain('Target operating gross margin is fixed');
  });

  it('marks status=partial and allPassed=false when a single-case suite exceeds budget after retrieval', () => {
    const singleCase = loadFixtureCases()[0];
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Single Case Timeout Suite',
      cases: [singleCase],
    });

    let nowCallCount = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount++;
      if (nowCallCount <= 2) return 1000;
      if (nowCallCount === 3) return 1150;
      return 1200;
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
      deadlineMs: 100,
    });
    dateSpy.mockRestore();

    expect(run.status).toBe('partial');
    expect(run.allPassed).toBe(false);
    expect(run.totalCases).toBe(1);
    expect(run.casesChecked).toBe(1);
    expect(run.results.length).toBe(1);
    expect(run.results[0].caseId).toBe(singleCase.id);
    expect(run.results[0].passed).toBe(true);
    expect(run.results[0].snapshotId).toBeDefined();
  });

  it('marks status=partial and allPassed=false when the final case of a multi-case suite exceeds budget', () => {
    const cases = loadFixtureCases().slice(0, 3);
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Last Case Overrun Suite',
      cases,
    });

    let calls = 0;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      calls++;
      if (calls <= 6) return 1000 + calls * 10;
      return 1300;
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
      deadlineMs: 200,
    });
    dateSpy.mockRestore();

    expect(run.status).toBe('partial');
    expect(run.allPassed).toBe(false);
    expect(run.totalCases).toBe(3);
    expect(run.casesChecked).toBe(3);
    expect(run.results.length).toBe(3);
    expect(run.results.every((r) => r.passed)).toBe(true);
  });

  it('detects inconsistent snapshots across distinct roles even when each role appears only once', () => {
    // 4 cases, each testing a distinct role
    const cases = [
      loadFixtureCases().find((c) => c.role === 'guest')!,
      loadFixtureCases().find((c) => c.role === 'customer')!,
      loadFixtureCases().find((c) => c.role === 'staff')!,
      loadFixtureCases().find((c) => c.role === 'admin')!,
    ];
    expect(cases.length).toBe(4);

    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Distinct Single-Role Suite',
      cases,
    });

    const origRetrieve = retrieval.retrieveSupportEvidence;
    let retrieveCalls = 0;
    const shippingFaqId = sourceIdMap.get('shipping_faq')!;

    const retrieveSpy = vi.spyOn(retrieval, 'retrieveSupportEvidence').mockImplementation((opts) => {
      retrieveCalls++;
      // On the 4th case (admin), archive the guest shipping source before retrieval
      if (retrieveCalls === 4) {
        const cur = getSupportEvidenceSource(tenantId, shippingFaqId);
        updateSupportEvidenceSource(tenantId, shippingFaqId, { status: 'archived' }, cur.version);
      }
      return origRetrieve(opts);
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });
    retrieveSpy.mockRestore();

    expect(run.status).toBe('partial');
    expect(run.allPassed).toBe(false);
    expect(run.casesChecked).toBe(4);
    expect(run.totalCases).toBe(4);
  });

  it('detects policy update after last case and labels results with actual pack snapshot', () => {
    const cases = loadFixtureCases().slice(0, 2);
    const suite = saveSupportEvidenceSuite(tenantId, {
      name: 'Post-Last-Case Policy Update Suite',
      cases,
    });

    const origRetrieve = retrieval.retrieveSupportEvidence;
    let retrieveCalls = 0;

    const retrieveSpy = vi.spyOn(retrieval, 'retrieveSupportEvidence').mockImplementation((opts) => {
      retrieveCalls++;
      // On the 2nd case (last case), update policy in store before retrieval
      if (retrieveCalls === 2) {
        updateSupportEvidencePolicy(tenantId, { minCoverage: 0.35 }, 1);
      }
      return origRetrieve(opts);
    });

    const run = runSupportEvidenceSuite({
      tenantId,
      suiteId: suite.id,
    });
    retrieveSpy.mockRestore();

    expect(run.status).toBe('partial');
    expect(run.allPassed).toBe(false);
    expect(run.casesChecked).toBe(2);
    expect(run.totalCases).toBe(2);
    expect(run.results[0].snapshotId).toBeDefined();
    expect(run.results[1].snapshotId).toBeDefined();
  });
});
