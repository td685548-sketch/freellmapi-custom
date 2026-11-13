import {
  SUPPORT_EVIDENCE_LIMITS,
  type SupportAnswerEvidence,
  type SupportEvidenceCitation,
  type SupportEvidencePack,
  type SupportEvidencePolicy,
  type SupportEvidenceRole,
} from '@freellmapi/shared/support-evidence.js';
import type { SupportRuntimePolicy } from '@freellmapi/shared/support-runtime.js';
import {
  getSupportEvidencePolicy,
  getSupportMessageEvidence,
} from './support-evidence-store.js';
import {
  getSupportEvidenceSnapshotId,
  retrieveSupportEvidence,
  validateStoredSupportEvidence,
  validateSupportEvidenceReply,
} from './support-evidence-retrieval.js';
import { maskSupportSensitiveText } from './support-knowledge.js';
import { SupportRuntimeError } from './support-runtime-store.js';
import type { SupportConversation, SupportConversationMessage } from './support-workflows.js';
import type { SupportChatCompletionResult } from './support-router.js';
import type { SupportRuntimeMetadata } from '@freellmapi/shared/support-runtime.js';

export type SupportEvidenceAbstentionReason =
  | 'no_matches'
  | 'invalid_citations'
  | 'sources_changed'
  | 'source_revoked';

export const SAFE_EVIDENCE_NOTICES: Record<SupportEvidenceAbstentionReason, string> = {
  no_matches:
    'I could not find any authorized knowledge sources to answer your question. You can request a human support agent for further assistance.',
  invalid_citations:
    'I could not verify a grounded answer with valid citations from authorized knowledge sources. You can request a human support agent for further assistance.',
  sources_changed:
    'The authorized knowledge sources changed while preparing this answer, so I cannot provide it. Please retry or request a human support agent.',
  source_revoked:
    'This answer is no longer available because its underlying knowledge sources were updated or revoked.',
};

const VALID_EVIDENCE_ROLES = new Set<string>(['guest', 'customer', 'staff', 'admin']);

export function assertValidEvidenceRole(role: string): SupportEvidenceRole {
  const normalized = String(role ?? '').trim().toLowerCase();
  if (!VALID_EVIDENCE_ROLES.has(normalized)) {
    throw new SupportRuntimeError(
      403,
      'unsupported_evidence_role',
      `Support role "${role}" is not supported in required knowledge-evidence mode.`,
    );
  }
  return normalized as SupportEvidenceRole;
}

export type PrepareSupportEvidenceResult =
  | {
      mode: 'off';
      policy: SupportEvidencePolicy;
    }
  | {
      mode: 'required';
      policy: SupportEvidencePolicy;
      role: SupportEvidenceRole;
      pack: SupportEvidencePack;
      shouldAbstain: true;
      abstentionReason: 'no_matches';
    }
  | {
      mode: 'required';
      policy: SupportEvidencePolicy;
      role: SupportEvidenceRole;
      pack: SupportEvidencePack;
      shouldAbstain: false;
    };

export function prepareSupportEvidenceTurn(options: {
  tenantId: number;
  role: string;
  query: string;
  runtimePolicy: SupportRuntimePolicy;
}): PrepareSupportEvidenceResult {
  const policy = getSupportEvidencePolicy(options.tenantId);
  if (policy.mode === 'off') {
    return { mode: 'off', policy };
  }

  const role = assertValidEvidenceRole(options.role);
  const pack = retrieveSupportEvidence({
    tenantId: options.tenantId,
    role,
    query: options.query,
    policy,
    maxContextChars: options.runtimePolicy.maxContextChars,
  });

  if (pack.candidates.length === 0) {
    return {
      mode: 'required',
      policy,
      role,
      pack,
      shouldAbstain: true,
      abstentionReason: 'no_matches',
    };
  }

  return {
    mode: 'required',
    policy,
    role,
    pack,
    shouldAbstain: false,
  };
}

export type FinalizeSupportEvidenceResult =
  | {
      accepted: true;
      canonicalReply: string;
      citations: SupportEvidenceCitation[];
    }
  | {
      accepted: false;
      reason: 'invalid_citations' | 'sources_changed';
      canonicalReply: string;
      citations: [];
      currentSnapshotId: string;
    };

const TOOL_CALL_MARKUP_RE = /<support_tool_call>[\s\S]*?<\/support_tool_call>/i;

export function finalizeSupportEvidenceTurn(options: {
  tenantId: number;
  role: SupportEvidenceRole;
  policy: SupportEvidencePolicy;
  pack: SupportEvidencePack;
  rawReply: string;
}): FinalizeSupportEvidenceResult {
  const { tenantId, role, policy, pack, rawReply } = options;

  if (
    typeof rawReply !== 'string' ||
    rawReply.length > SUPPORT_EVIDENCE_LIMITS.maxCompletionChars ||
    TOOL_CALL_MARKUP_RE.test(rawReply)
  ) {
    return {
      accepted: false,
      reason: 'invalid_citations',
      canonicalReply: SAFE_EVIDENCE_NOTICES.invalid_citations,
      citations: [],
      currentSnapshotId: pack.snapshotId,
    };
  }

  const currentPolicy = getSupportEvidencePolicy(tenantId);
  if (currentPolicy.mode !== 'required' || currentPolicy.version !== policy.version) {
    return {
      accepted: false,
      reason: 'sources_changed',
      canonicalReply: SAFE_EVIDENCE_NOTICES.sources_changed,
      citations: [],
      currentSnapshotId: getSupportEvidenceSnapshotId({ tenantId, role, policy: currentPolicy }),
    };
  }

  const validation = validateSupportEvidenceReply({
    tenantId,
    role,
    policy: currentPolicy,
    pack,
    reply: rawReply,
  });

  if (!validation.valid) {
    const reason = validation.reason ?? 'invalid_citations';
    const currentSnapshotId =
      reason === 'sources_changed'
        ? getSupportEvidenceSnapshotId({ tenantId, role, policy: currentPolicy })
        : pack.snapshotId;

    return {
      accepted: false,
      reason,
      canonicalReply: SAFE_EVIDENCE_NOTICES[reason],
      citations: [],
      currentSnapshotId,
    };
  }

  return {
    accepted: true,
    canonicalReply: validation.canonicalReply,
    citations: validation.citations,
  };
}

export function assertSupportEvidenceReplay<
  T extends SupportChatCompletionResult & { runtime: SupportRuntimeMetadata },
>(options: {
  tenantId: number;
  role: string;
  cachedResponse: T;
}): T {
  const policy = getSupportEvidencePolicy(options.tenantId);
  const cachedEvidence = options.cachedResponse.runtime?.evidence as SupportAnswerEvidence | undefined;

  // Preserve pre-018 off-mode cache compatibility when there is no 018 evidence
  if (!cachedEvidence) {
    if (policy.mode === 'off') {
      return options.cachedResponse;
    }
    assertValidEvidenceRole(options.role);
    throw new SupportRuntimeError(
      409,
      'knowledge_context_changed',
      'Cached response has no verified evidence under required mode. Please send a new request.',
    );
  }

  // Every 018 cached response must be revalidated even if policy is now off
  if (policy.mode !== 'required') {
    throw new SupportRuntimeError(
      409,
      'knowledge_context_changed',
      'Knowledge evidence policy changed since this response was cached. Please send a new request.',
    );
  }

  const role = assertValidEvidenceRole(options.role);
  const currentSnapshotId = getSupportEvidenceSnapshotId({
    tenantId: options.tenantId,
    role,
    policy,
  });

  if (
    cachedEvidence.snapshotId !== currentSnapshotId ||
    cachedEvidence.policyVersion !== policy.version
  ) {
    throw new SupportRuntimeError(
      409,
      'knowledge_context_changed',
      'Knowledge sources or policy changed since this response was cached. Please send a new request.',
    );
  }

  return options.cachedResponse;
}

function redactMessage(
  msg: SupportConversationMessage,
  policyVersion: number,
  requestId: string,
): SupportConversationMessage {
  return {
    ...msg,
    content: SAFE_EVIDENCE_NOTICES.source_revoked,
    evidence: {
      requestId,
      status: 'redacted',
      reason: 'source_revoked',
      policyVersion,
      snapshotId: '',
      citations: [],
    },
  };
}

export function sanitizeSupportEvidenceConversation(options: {
  tenantId: number;
  conversation: SupportConversation;
  viewerRole: string;
}): SupportConversation {
  const { tenantId, conversation, viewerRole } = options;
  const hasEvidenceMessages = conversation.messages.some((m) => Boolean(m.evidence));
  if (!hasEvidenceMessages) {
    return conversation;
  }

  const policy = getSupportEvidencePolicy(tenantId);
  const normalizedRole = String(viewerRole ?? '').trim().toLowerCase();
  const isValidRole = VALID_EVIDENCE_ROLES.has(normalizedRole);

  const sanitizedMessages = conversation.messages.map((msg): SupportConversationMessage => {
    const ev = msg.evidence as SupportAnswerEvidence | undefined;
    if (!ev) {
      return msg;
    }

    if (ev.status === 'redacted') {
      return redactMessage(msg, ev.policyVersion || policy.version, ev.requestId);
    }

    if (ev.status === 'abstained') {
      return {
        ...msg,
        evidence: {
          ...ev,
          citations: [],
        },
      };
    }

    if (!isValidRole) {
      return redactMessage(msg, policy.version, ev.requestId);
    }

    const role = normalizedRole as SupportEvidenceRole;
    const record = getSupportMessageEvidence(tenantId, conversation.id, msg.id);
    if (!record) {
      return redactMessage(msg, policy.version, ev.requestId);
    }

    const stillValid = validateStoredSupportEvidence({
      tenantId,
      role,
      policy,
      record,
    });
    if (!stillValid) {
      return redactMessage(msg, policy.version, ev.requestId);
    }

    const maskedContent = maskSupportSensitiveText(String(tenantId), msg.content, role).masked;
    const maskedCitations = ev.citations.map((c) => ({
      ...c,
      title: maskSupportSensitiveText(String(tenantId), c.title, role).masked,
      excerpt: maskSupportSensitiveText(String(tenantId), c.excerpt, role).masked,
    }));

    return {
      ...msg,
      content: maskedContent,
      evidence: {
        ...ev,
        citations: maskedCitations,
      },
    };
  });

  return {
    ...conversation,
    messages: sanitizedMessages,
  };
}
