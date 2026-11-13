/**
 * Frozen external DTOs, limits, and constants for AI Support Knowledge Evidence (Spec 018).
 * Owned by Agent 1 (shared/support-evidence.ts).
 */

export const SUPPORT_EVIDENCE_LIMITS = {
  maxImportBytes: 1_048_576,
  maxNormalizedChars: 64_000,
  maxSourceNameChars: 200,
  maxTitleChars: 200,
  maxCategoryChars: 80,
  maxTagsCount: 20,
  maxTagChars: 40,
  maxSourcesPerTenant: 50,
  maxRevisionsPerSource: 20,
  maxChunksPerRevision: 128,
  maxPublishedChunksPerTenant: 4000,
  maxLegacyDocs: 100,
  maxLegacyChunksPerDoc: 128,
  chunkTargetChars: 1000,
  chunkOverlapChars: 100,
  minClippedChunkChars: 80,
  maxFaqItems: 100,
  maxFaqQuestionChars: 500,
  maxFaqAnswerChars: 4000,
  maxIdChars: 80,
  maxCompletionChars: 16_000,
  maxCitationMarkers: 50,
  minCitations: 1,
  maxCitations: 5,
  maxExcerptChars: 240,
  maxConsoleQueryChars: 500,
  maxRuntimeQueryChars: 16_000,
  maxQueryTerms: 32,
  maxCasesPerSuite: 50,
  maxExpectedSourceIdsPerCase: 10,
  maxForbiddenSourceIdsPerCase: 10,
  maxRunsListed: 50,
  importDeadlineMs: 5000,
  evalDeadlineMs: 2000,
} as const;

export const SUPPORT_EVIDENCE_ROLES = ['guest', 'customer', 'staff', 'admin'] as const;
export type SupportEvidenceRole = (typeof SUPPORT_EVIDENCE_ROLES)[number];

export type SupportEvidenceSourceKind = 'text' | 'markdown' | 'faq_json' | 'url';
export type SupportEvidenceFormat = 'text' | 'markdown' | 'faq_json';
export type SupportEvidenceSourceStatus = 'active' | 'archived';

export interface SupportEvidenceSource {
  id: string;
  tenantId: number;
  name: string;
  kind: SupportEvidenceSourceKind;
  status: SupportEvidenceSourceStatus;
  allowedRoles: SupportEvidenceRole[]; // nonempty unique known roles; default ['admin'], no wildcard
  version: number; // positive OCC integer
  publishedRevisionId: string | null;
  draftRevisionId: string | null;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportEvidenceRevision {
  id: string;
  tenantId: number;
  sourceId: string;
  format: SupportEvidenceFormat;
  title: string;
  category: string;
  tags: string[];
  contentHash: string;
  chunkCount: number;
  createdAt: string;
}

export interface SupportEvidenceRevisionDetail extends SupportEvidenceRevision {
  content: string;
}

export interface SupportEvidenceChunk {
  id: string;
  tenantId: number;
  sourceId: string;
  revisionId: string;
  ordinal: number;
  heading?: string;
  startLine: number;
  endLine: number;
  text: string;
  contentHash: string;
}

export type SupportEvidencePolicyMode = 'off' | 'required';

export interface SupportEvidencePolicy {
  mode: SupportEvidencePolicyMode; // default 'off'
  includeLegacyDocs: boolean; // default true
  topK: number; // integer 1..5; default 3
  minCoverage: number; // number 0..1; default 0.25
  maxEvidenceChars: number; // integer 1000..12000; default 6000
  version: number; // positive integer
  updatedAt: string; // ISO8601 UTC
}

export const DEFAULT_EVIDENCE_POLICY: SupportEvidencePolicy = {
  mode: 'off',
  includeLegacyDocs: true,
  topK: 3,
  minCoverage: 0.25,
  maxEvidenceChars: 6000,
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export const EVIDENCE_POLICY_BOUNDS = {
  topK: { min: 1, max: 5, default: 3 },
  minCoverage: { min: 0, max: 1, default: 0.25 },
  maxEvidenceChars: { min: 1000, max: 12000, default: 6000 },
} as const;

export interface SupportEvidenceCandidate {
  citationId: string;
  sourceId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  startLine: number;
  endLine: number;
  providedText: string;
  providedTextHash: string;
  lexicalCoverage: number;
  score: number;
}

export interface SupportEvidencePack {
  tenantId: number;
  role: SupportEvidenceRole;
  policyVersion: number;
  snapshotId: string; // sha256 hex
  contextPrompt: string;
  candidates: SupportEvidenceCandidate[];
}

export interface SupportEvidenceCitation {
  id: string; // citationId
  ordinal: number; // 1-based appearance order
  sourceId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  startLine: number;
  endLine: number;
  excerpt: string; // <= 240 chars
}

export type SupportAnswerEvidenceStatus = 'cited' | 'abstained' | 'redacted';
export type SupportAnswerEvidenceReason =
  | 'no_matches'
  | 'invalid_citations'
  | 'sources_changed'
  | 'source_revoked';

export interface SupportAnswerEvidence {
  requestId: string;
  status: SupportAnswerEvidenceStatus;
  reason?: SupportAnswerEvidenceReason;
  policyVersion: number;
  snapshotId: string;
  citations: SupportEvidenceCitation[];
}

export type SupportResponseNoticeReason = 'no_matches' | 'invalid_citations' | 'sources_changed';

export interface SupportResponseNotice {
  requestId: string;
  reason: SupportResponseNoticeReason;
}

export interface SupportEvidenceCase {
  id: string; // ASCII [A-Za-z0-9_-], 1..80 chars
  query: string; // 1..500 chars
  role: SupportEvidenceRole;
  expectedSourceIds: string[]; // array <= 10
  forbiddenSourceIds: string[]; // array <= 10
  expectAbstention: boolean;
}

export interface SupportEvidenceSuite {
  id: string;
  tenantId: number;
  name: string; // 1..200
  version: number; // positive OCC integer
  cases: SupportEvidenceCase[]; // 1..50
  createdAt: string;
  updatedAt: string;
}

export type SupportEvidenceRunStatus = 'completed' | 'partial' | 'failed';

export interface SupportEvidenceRunCaseResult {
  caseId: string;
  role: SupportEvidenceRole;
  returnedSourceIds: string[]; // restricted to that role
  expectedHit: boolean;
  forbiddenHitCount: number;
  abstentionMatched: boolean;
  passed: boolean;
  snapshotId?: string;
  error?: string;
}

export interface SupportEvidenceRun {
  id: string;
  tenantId: number;
  suiteId: string;
  suiteVersion: number;
  status: SupportEvidenceRunStatus;
  startedAt: string;
  completedAt: string;
  casesChecked: number;
  totalCases: number;
  matchedExpectedCases: number;
  expectedCasesChecked: number;
  casesWithoutForbiddenHits: number;
  correctlyAbstainedCases: number;
  hitAtK: number; // 0..1
  allPassed: boolean;
  snapshotIds: string[];
  results: SupportEvidenceRunCaseResult[];
}

export interface SupportEvidenceValidation {
  valid: boolean;
  canonicalReply: string;
  citations: SupportEvidenceCitation[];
  reason?: 'invalid_citations' | 'sources_changed';
}

export interface SupportEvidencePreview {
  snapshotId: string;
  policyVersion: number;
  candidates: Array<{
    id: string;
    sourceId: string;
    revisionId: string;
    title: string;
    startLine: number;
    endLine: number;
    excerpt: string;
    lexicalCoverage: number;
    score: number;
  }>;
  contextChars: number;
  willAbstain: boolean;
}
