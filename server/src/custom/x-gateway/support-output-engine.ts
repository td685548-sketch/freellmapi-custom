import type {
  SupportOutputDecision,
  SupportOutputLeaf,
  SupportOutputPolicy,
  SupportOutputReason,
  SupportOutputRule,
} from '@freellmapi/shared/support-output.js';

/**
 * Frozen structural and inspection bounds from specs/020-ai-support-output-controls/contracts.md.
 */
export const SUPPORT_OUTPUT_ENGINE_LIMITS = Object.freeze({
  maxRules: 50,
  maxRuleIdLength: 64,
  minRuleTermLength: 1,
  maxRuleTermLength: 100,
  minOutputChars: 256,
  maxOutputChars: 64_000,
  maxLeaves: 32,
  maxLeafPathLength: 128,
  maxTotalRawCodeUnits: 128_000,
} as const);

export const SUPPORT_OUTPUT_CREDENTIAL_LIMITATIONS = Object.freeze([
  'Detects only finite known patterns: nonempty Bearer tokens, sk-/sk_sup_ keys (>=8 suffix chars), sup_ctx_ tokens (>=8 suffix chars), and supported private-key PEM blocks (<=16384 chars).',
  'Does not claim universal secret detection; short sk-/sup_ctx_ suffixes (<8 chars), arbitrary env/DB secrets, or obfuscated/split secrets across leaves are not detected.',
] as const);

const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const COLLAPSE_WHITESPACE_RE = /\s+/g;

interface CredentialPatternSpec {
  readonly id: string;
  readonly regex: RegExp;
  readonly replacement: string;
}

const CREDENTIAL_PATTERNS: readonly CredentialPatternSpec[] = [
  {
    id: 'pem_private_key',
    regex:
      /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----[\s\S]{0,16384}?-----END (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  {
    id: 'bearer_token',
    regex: /\bBearer[ \t]+[A-Za-z0-9_~+/-](?:[A-Za-z0-9._~+/-]*[A-Za-z0-9_~+/-])?=*/gi,
    replacement: 'Bearer [REDACTED_TOKEN]',
  },
  {
    id: 'sk_key',
    regex: /\bsk(?:-[A-Za-z0-9_-]{8,}|_sup_[A-Za-z0-9_-]{8,})\b/g,
    replacement: '[REDACTED_KEY]',
  },
  {
    id: 'sup_ctx_token',
    regex: /\bsup_ctx_[A-Za-z0-9._-]{8,}\b/g,
    replacement: '[REDACTED_TOKEN]',
  },
];

/**
 * Typed error thrown by the pure output evaluator without leaking raw input or policy secrets.
 */
export class SupportOutputEngineError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'SupportOutputEngineError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Deterministic bounded normalization for literal substring matching.
 * Preserves Vietnamese accents and never mutates returned display text.
 */
export function normalizeSupportOutputText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .toLowerCase()
    .replace(COLLAPSE_WHITESPACE_RE, ' ')
    .trim();
}

interface NormalizedRule {
  readonly id: string;
  readonly normalizedText: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAndNormalizePolicy(policy: SupportOutputPolicy): NormalizedRule[] {
  if (!isPlainRecord(policy)) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy must be an object.');
  }
  if (!Number.isSafeInteger(policy.tenantId) || policy.tenantId <= 0) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy tenantId must be a positive integer.');
  }
  if (!Number.isSafeInteger(policy.version) || policy.version < 0) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy version must be a non-negative integer.');
  }
  if (policy.mode !== 'off' && policy.mode !== 'log' && policy.mode !== 'enforce') {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy mode is invalid.');
  }
  if (typeof policy.redactCredentials !== 'boolean') {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy redactCredentials must be a boolean.');
  }
  if (typeof policy.updatedAt !== 'string' || policy.updatedAt.trim().length === 0) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy updatedAt must be a non-empty string.');
  }
  if (
    !Number.isSafeInteger(policy.maxOutputChars) ||
    policy.maxOutputChars < SUPPORT_OUTPUT_ENGINE_LIMITS.minOutputChars ||
    policy.maxOutputChars > SUPPORT_OUTPUT_ENGINE_LIMITS.maxOutputChars
  ) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy maxOutputChars is out of bounds.');
  }
  if (!Array.isArray(policy.blockedTerms)) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy blockedTerms must be an array.');
  }
  if (policy.blockedTerms.length > SUPPORT_OUTPUT_ENGINE_LIMITS.maxRules) {
    throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy exceeds maximum rule count.');
  }

  const seenIds = new Set<string>();
  const seenNormalized = new Set<string>();
  const normalizedRules: NormalizedRule[] = [];

  for (const rawRule of policy.blockedTerms as SupportOutputRule[]) {
    if (!isPlainRecord(rawRule)) {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy rule must be an object.');
    }
    if (typeof rawRule.id !== 'string' || !RULE_ID_RE.test(rawRule.id)) {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy rule id is invalid.');
    }
    if (seenIds.has(rawRule.id)) {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy contains duplicate rule id.');
    }
    if (typeof rawRule.text !== 'string') {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy rule text must be a string.');
    }

    const normalizedText = normalizeSupportOutputText(rawRule.text);
    if (
      normalizedText.length < SUPPORT_OUTPUT_ENGINE_LIMITS.minRuleTermLength ||
      normalizedText.length > SUPPORT_OUTPUT_ENGINE_LIMITS.maxRuleTermLength
    ) {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy rule text length is out of bounds.');
    }
    if (seenNormalized.has(normalizedText)) {
      throw new SupportOutputEngineError(400, 'invalid_output_policy', 'Output policy contains duplicate normalized rule.');
    }

    seenIds.add(rawRule.id);
    seenNormalized.add(normalizedText);
    normalizedRules.push({ id: rawRule.id, normalizedText });
  }

  return normalizedRules;
}

function validateLeavesStructure(leaves: SupportOutputLeaf[]): number {
  if (!Array.isArray(leaves)) {
    throw new SupportOutputEngineError(400, 'invalid_output_input', 'Output leaves must be an array.');
  }

  const seenPaths = new Set<string>();
  let totalRawCodeUnits = 0;

  for (const leaf of leaves) {
    if (!isPlainRecord(leaf)) {
      throw new SupportOutputEngineError(400, 'invalid_output_input', 'Output leaf must be an object.');
    }
    if (
      typeof leaf.path !== 'string' ||
      leaf.path.length < 1 ||
      leaf.path.length > SUPPORT_OUTPUT_ENGINE_LIMITS.maxLeafPathLength
    ) {
      throw new SupportOutputEngineError(400, 'invalid_output_input', 'Output leaf path is invalid.');
    }
    if (seenPaths.has(leaf.path)) {
      throw new SupportOutputEngineError(400, 'invalid_output_input', 'Output leaves contain duplicate path.');
    }
    if (typeof leaf.text !== 'string') {
      throw new SupportOutputEngineError(400, 'invalid_output_input', 'Output leaf text must be a string.');
    }

    seenPaths.add(leaf.path);
    totalRawCodeUnits += leaf.text.length;
  }

  return totalRawCodeUnits;
}

function scanAndRedactCredentials(
  text: string,
  applyRedaction: boolean,
): { text: string; matches: number } {
  let current = text;
  let matches = 0;

  for (const spec of CREDENTIAL_PATTERNS) {
    const re = new RegExp(spec.regex.source, spec.regex.flags);
    if (applyRedaction) {
      current = current.replace(re, () => {
        matches += 1;
        return spec.replacement;
      });
    } else {
      while (re.exec(current) !== null) {
        matches += 1;
      }
    }
  }

  return { text: current, matches };
}

/**
 * Pure deterministic evaluator for AI support output controls.
 */
export function evaluateSupportOutput(input: {
  policy: SupportOutputPolicy;
  leaves: SupportOutputLeaf[];
}): SupportOutputDecision {
  if (!isPlainRecord(input)) {
    throw new SupportOutputEngineError(400, 'invalid_output_input', 'Evaluation input must be an object.');
  }

  const normalizedRules = validateAndNormalizePolicy(input.policy);
  const totalRawCodeUnits = validateLeavesStructure(input.leaves);
  const { policy, leaves } = input;

  const overHardLimit =
    leaves.length > SUPPORT_OUTPUT_ENGINE_LIMITS.maxLeaves ||
    totalRawCodeUnits > SUPPORT_OUTPUT_ENGINE_LIMITS.maxTotalRawCodeUnits;

  if (overHardLimit) {
    if (policy.mode === 'enforce') {
      return {
        action: 'block',
        leaves: [],
        reasons: ['inspection_limit'],
        ruleIds: [],
        redactionCount: 0,
        policyVersion: policy.version,
      };
    }
    throw new SupportOutputEngineError(
      503,
      'output_inspection_limit',
      'Output exceeded maximum inspection limit.',
    );
  }

  if (policy.mode === 'off') {
    return {
      action: 'allow',
      leaves: leaves.map((leaf) => ({ path: leaf.path, text: leaf.text })),
      reasons: [],
      ruleIds: [],
      redactionCount: 0,
      policyVersion: policy.version,
    };
  }

  const matchedRuleIds: string[] = [];
  const matchedRuleIdSet = new Set<string>();

  for (const leaf of leaves) {
    if (normalizedRules.length === 0) break;
    const normalizedLeaf = normalizeSupportOutputText(leaf.text);
    for (const rule of normalizedRules) {
      if (normalizedLeaf.includes(rule.normalizedText) && !matchedRuleIdSet.has(rule.id)) {
        matchedRuleIdSet.add(rule.id);
        matchedRuleIds.push(rule.id);
      }
    }
  }

  const hasBlockedTerm = matchedRuleIds.length > 0;
  const isTooLong = totalRawCodeUnits > policy.maxOutputChars;
  const shouldBlock = policy.mode === 'enforce' && (hasBlockedTerm || isTooLong);

  let totalCredentialMatches = 0;
  const shouldRedact = policy.mode === 'enforce' && !shouldBlock && policy.redactCredentials;
  const outputLeaves: SupportOutputLeaf[] = [];

  for (const leaf of leaves) {
    const scanResult = scanAndRedactCredentials(leaf.text, shouldRedact);
    totalCredentialMatches += scanResult.matches;
    outputLeaves.push({
      path: leaf.path,
      text: shouldRedact ? scanResult.text : leaf.text,
    });
  }

  const reasons: SupportOutputReason[] = [];
  if (hasBlockedTerm) reasons.push('blocked_term');
  if (isTooLong) reasons.push('too_long');
  if (totalCredentialMatches > 0) reasons.push('credential');

  if (shouldBlock) {
    return {
      action: 'block',
      leaves: [],
      reasons,
      ruleIds: matchedRuleIds,
      redactionCount: 0,
      policyVersion: policy.version,
    };
  }

  if (shouldRedact && totalCredentialMatches > 0) {
    return {
      action: 'redact',
      leaves: outputLeaves,
      reasons,
      ruleIds: matchedRuleIds,
      redactionCount: totalCredentialMatches,
      policyVersion: policy.version,
    };
  }

  if (reasons.length > 0) {
    return {
      action: 'observe',
      leaves: outputLeaves,
      reasons,
      ruleIds: matchedRuleIds,
      redactionCount: 0,
      policyVersion: policy.version,
    };
  }

  return {
    action: 'allow',
    leaves: outputLeaves,
    reasons: [],
    ruleIds: [],
    redactionCount: 0,
    policyVersion: policy.version,
  };
}
