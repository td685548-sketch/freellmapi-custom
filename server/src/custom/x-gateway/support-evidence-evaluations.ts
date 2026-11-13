import {
  SUPPORT_EVIDENCE_LIMITS,
  type SupportEvidenceRole,
  type SupportEvidenceRun,
  type SupportEvidenceRunCaseResult,
} from '@freellmapi/shared/support-evidence.js';
import {
  getSupportEvidencePolicy,
  getSupportEvidenceSuite,
  saveSupportEvidenceRun,
  SupportEvidenceError,
} from './support-evidence-store.js';
import * as retrieval from './support-evidence-retrieval.js';

export interface RunSupportEvidenceSuiteOptions {
  tenantId: number;
  suiteId: string;
  deadlineMs?: number;
}

/**
 * Executes an evaluation suite against the actual bounded retrieval engine.
 *
 * Guarantees:
 * - Zero external provider, network, tool, or quota operations.
 * - Bounded 2-second CPU budget (timeout gracefully produces a 'partial' report).
 * - Honest hitAtK denominator (0 when no cases have expected sources, not manufactured 100%).
 * - allPassed is true ONLY for completed runs with every case passed and consistent snapshot.
 * - Saves only its own encrypted report via saveSupportEvidenceRun.
 */
export function runSupportEvidenceSuite(
  options: RunSupportEvidenceSuiteOptions,
): SupportEvidenceRun {
  const { tenantId, suiteId } = options;

  if (typeof tenantId !== 'number' || !Number.isInteger(tenantId) || tenantId <= 0) {
    throw new SupportEvidenceError(400, 'invalid_input', 'tenantId must be a positive integer.');
  }
  if (typeof suiteId !== 'string' || !suiteId.trim()) {
    throw new SupportEvidenceError(400, 'invalid_input', 'suiteId is required.');
  }

  const suite = getSupportEvidenceSuite(tenantId, suiteId);
  const totalCases = suite.cases.length;

  if (totalCases === 0 || totalCases > SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite) {
    throw new SupportEvidenceError(
      400,
      'invalid_input',
      `Suite contains invalid number of cases (${totalCases}). Must be 1..${SUPPORT_EVIDENCE_LIMITS.maxCasesPerSuite}.`,
    );
  }

  let activePolicy = getSupportEvidencePolicy(tenantId);
  const deadlineMs = options.deadlineMs ?? SUPPORT_EVIDENCE_LIMITS.evalDeadlineMs;

  const startedAt = new Date().toISOString();
  const startTime = Date.now();

  let casesChecked = 0;
  let matchedExpectedCases = 0;
  let expectedCasesChecked = 0;
  let casesWithoutForbiddenHits = 0;
  let correctlyAbstainedCases = 0;

  const snapshotIdsSet = new Set<string>();
  const roleInitialSnapshots = new Map<SupportEvidenceRole, string>();
  const results: SupportEvidenceRunCaseResult[] = [];
  let timedOut = false;
  let snapshotChangedDuringRun = false;

  for (const caseItem of suite.cases) {
    // Check CPU deadline before executing next case
    if (Date.now() - startTime >= deadlineMs) {
      timedOut = true;
      break;
    }

    // Check for in-flight policy changes
    const currentPolicy = getSupportEvidencePolicy(tenantId);
    if (currentPolicy.version !== activePolicy.version) {
      snapshotChangedDuringRun = true;
      activePolicy = currentPolicy;
    }

    const pack = retrieval.retrieveSupportEvidence({
      tenantId,
      role: caseItem.role,
      query: caseItem.query,
      policy: activePolicy,
      maxContextChars: activePolicy.maxEvidenceChars,
    });

    // Check CPU deadline immediately after retrieval
    const overdueAfterRetrieval = Date.now() - startTime >= deadlineMs;
    if (overdueAfterRetrieval) {
      timedOut = true;
    }

    // Label results with actual pack snapshot and verify role snapshot consistency
    snapshotIdsSet.add(pack.snapshotId);

    const prevSnapshotForRole = roleInitialSnapshots.get(caseItem.role);
    if (!prevSnapshotForRole) {
      roleInitialSnapshots.set(caseItem.role, pack.snapshotId);
    } else if (pack.snapshotId !== prevSnapshotForRole) {
      // If underlying sources or configuration for this role changed while run was in progress
      snapshotChangedDuringRun = true;
    }

    const returnedSourceIds = [...new Set(pack.candidates.map((c) => c.sourceId))];

    // 1. Expected sources check
    const hasExpected = caseItem.expectedSourceIds.length > 0;
    let expectedHit = false;

    if (hasExpected) {
      expectedCasesChecked++;
      expectedHit = caseItem.expectedSourceIds.some((expId) =>
        returnedSourceIds.includes(expId),
      );
      if (expectedHit) {
        matchedExpectedCases++;
      }
    } else {
      expectedHit = true;
    }

    // 2. Forbidden sources check
    const forbiddenHits = caseItem.forbiddenSourceIds.filter((forbId) =>
      returnedSourceIds.includes(forbId),
    );
    const forbiddenHitCount = forbiddenHits.length;
    if (forbiddenHitCount === 0) {
      casesWithoutForbiddenHits++;
    }

    // 3. Abstention check
    const actuallyAbstained = pack.candidates.length === 0;
    const abstentionMatched = actuallyAbstained === caseItem.expectAbstention;
    if (actuallyAbstained && caseItem.expectAbstention) {
      correctlyAbstainedCases++;
    }

    // 4. Case pass/fail
    const passed = expectedHit && forbiddenHitCount === 0 && abstentionMatched;

    results.push({
      caseId: caseItem.id,
      role: caseItem.role,
      returnedSourceIds,
      expectedHit,
      forbiddenHitCount,
      abstentionMatched,
      passed,
      snapshotId: pack.snapshotId,
    });

    casesChecked++;

    if (overdueAfterRetrieval) {
      break;
    }
  }

  // Check deadline before final save (catches single-case or last-case overrun)
  if (Date.now() - startTime >= deadlineMs) {
    timedOut = true;
  }

  // Final consistency check across all observed roles against fresh policy & sources
  const finalPolicy = getSupportEvidencePolicy(tenantId);
  if (finalPolicy.version !== activePolicy.version) {
    snapshotChangedDuringRun = true;
  }
  for (const [observedRole, initialSnap] of roleInitialSnapshots.entries()) {
    const finalSnap = retrieval.getSupportEvidenceSnapshotId({
      tenantId,
      role: observedRole,
      policy: finalPolicy,
    });
    if (finalSnap !== initialSnap) {
      snapshotChangedDuringRun = true;
    }
  }

  const completedAt = new Date().toISOString();

  // If run timed out or was interrupted, populate remaining unexecuted cases with explicit error
  if (casesChecked < totalCases) {
    for (let i = casesChecked; i < totalCases; i++) {
      const skipped = suite.cases[i];
      results.push({
        caseId: skipped.id,
        role: skipped.role,
        returnedSourceIds: [],
        expectedHit: false,
        forbiddenHitCount: 0,
        abstentionMatched: false,
        passed: false,
        error: timedOut
          ? 'Execution budget exceeded 2-second CPU deadline.'
          : 'Case skipped due to premature run completion.',
      });
    }
  }

  const isPartial = timedOut || casesChecked < totalCases || snapshotChangedDuringRun;
  const status: 'completed' | 'partial' = isPartial ? 'partial' : 'completed';

  // hitAtK: expected-hit cases divided by cases with nonempty expectedSourceIds
  const hitAtK =
    expectedCasesChecked > 0 ? Number((matchedExpectedCases / expectedCasesChecked).toFixed(4)) : 0;

  // allPassed is true ONLY for completed runs where every single case checked and passed
  const allPassed =
    status === 'completed' &&
    !snapshotChangedDuringRun &&
    !timedOut &&
    casesChecked === totalCases &&
    results.length === totalCases &&
    results.every((r) => r.passed);

  return saveSupportEvidenceRun(tenantId, {
    suiteId: suite.id,
    suiteVersion: suite.version,
    status,
    startedAt,
    completedAt,
    casesChecked,
    totalCases,
    matchedExpectedCases,
    expectedCasesChecked,
    casesWithoutForbiddenHits,
    correctlyAbstainedCases,
    hitAtK,
    allPassed,
    snapshotIds: [...snapshotIdsSet],
    results,
  });
}
