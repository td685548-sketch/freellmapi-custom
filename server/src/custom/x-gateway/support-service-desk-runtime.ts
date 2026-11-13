import { SUPPORT_EVIDENCE_ROLES, type SupportEvidenceRole } from '@freellmapi/shared/support-evidence.js';
import type { SupportRuntimeChatInput } from '@freellmapi/shared/support-runtime.js';
import type {
  SupportDeskConversationIntake,
  SupportDeskInternalConversationIntake,
} from '@freellmapi/shared/support-service-desk.js';
import type { SupportTenant, SupportUserContext } from './support-store.js';
import type { SupportConversation } from './support-workflows.js';
import { maskSupportSensitiveData } from './support-knowledge.js';
import {
  bindSupportDeskIntake,
  getSupportDeskWidgetConfig,
  readSupportDeskBoundIntake,
  readSupportDeskIntake,
  SupportDeskError,
} from './support-service-desk-store.js';
import { computeSupportDeskIntakeSchemaHash } from './support-widget-profile.js';

export type SupportDeskIntakeGate =
  | {
      active: false;
      mode: 'disabled';
      tenantId: number;
      userId: string;
      role: string;
    }
  | {
      active: true;
      mode: 'skipped';
      tenantId: number;
      userId: string;
      role: string;
    }
  | {
      active: true;
      mode: 'receipt';
      tenantId: number;
      userId: string;
      role: SupportEvidenceRole;
      receiptId: string;
      receiptHash: string;
      schemaHash: string;
      submittedAt: string;
    }
  | {
      active: true;
      mode: 'bound';
      tenantId: number;
      userId: string;
      role: SupportEvidenceRole;
      receiptHash: string;
      schemaHash: string;
      submittedAt: string;
    };

function assertValidEvidenceRole(role: string): SupportEvidenceRole {
  const normalized = String(role ?? '').toLowerCase() as SupportEvidenceRole;
  if (!(SUPPORT_EVIDENCE_ROLES as readonly string[]).includes(normalized)) {
    throw new SupportDeskError(403, 'unsupported_evidence_role', `Unsupported support role: ${role}`);
  }
  return normalized;
}

/**
 * Validates intake requirements and receipt state before model execution.
 */
export function prepareSupportDeskIntake(params: {
  tenant: SupportTenant;
  context: SupportUserContext;
  input: SupportRuntimeChatInput;
  conversation?: SupportConversation;
  now?: number;
}): SupportDeskIntakeGate {
  const { tenant, context, input, conversation, now } = params;
  const config = getSupportDeskWidgetConfig(tenant.id);
  const schemaHash = computeSupportDeskIntakeSchemaHash(config);
  const isActive = config.enabled && config.intake.fields.length > 0;
  const hasReceiptProp = input.intakeReceiptId !== undefined;
  const receiptId = hasReceiptProp ? String(input.intakeReceiptId).trim() : undefined;

  if (!isActive) {
    if (hasReceiptProp) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        'Intake receipt is not accepted when widget intake is disabled.',
      );
    }
    return {
      active: false,
      mode: 'disabled',
      tenantId: tenant.id,
      userId: context.userId,
      role: context.role,
    };
  }

  if (config.intake.required && !context.verified) {
    throw new SupportDeskError(
      401,
      'signed_session_required',
      'A verified signed session is required when intake is required.',
    );
  }

  if (hasReceiptProp) {
    if (!receiptId || receiptId.length > 128) {
      throw new SupportDeskError(
        400,
        'invalid_input',
        'intakeReceiptId must be a non-empty string up to 128 characters.',
      );
    }
    if (!context.verified) {
      throw new SupportDeskError(
        401,
        'signed_session_required',
        'A verified signed session is required to use an intake receipt.',
      );
    }

    const role = assertValidEvidenceRole(context.role);
    const stored = readSupportDeskIntake({
      tenantId: tenant.id,
      userId: context.userId,
      role,
      receiptId,
      now,
    });

    if (stored.schemaHash !== schemaHash) {
      throw new SupportDeskError(
        409,
        'intake_schema_changed',
        'Intake form schema has changed; please resubmit intake.',
      );
    }

    const targetConversationId = input.conversationId?.trim() || null;
    if (stored.conversationId !== null && stored.conversationId !== targetConversationId) {
      throw new SupportDeskError(
        409,
        'intake_already_bound',
        'Intake receipt is already bound to another conversation.',
      );
    }

    return {
      active: true,
      mode: 'receipt',
      tenantId: tenant.id,
      userId: context.userId,
      role,
      receiptId,
      receiptHash: stored.receiptHash,
      schemaHash,
      submittedAt: stored.createdAt,
    };
  }

  if (conversation) {
    const bound = readSupportDeskBoundIntake({
      tenantId: tenant.id,
      conversationId: conversation.id,
      userId: context.userId,
    });
    if (bound) {
      if (bound.schemaHash === schemaHash && bound.role === context.role) {
        return {
          active: true,
          mode: 'bound',
          tenantId: tenant.id,
          userId: context.userId,
          role: bound.role,
          receiptHash: bound.receiptHash,
          schemaHash: bound.schemaHash,
          submittedAt: bound.createdAt,
        };
      }
      if (config.intake.required) {
        throw new SupportDeskError(
          409,
          'intake_schema_changed',
          'Intake form schema or caller role has changed; please submit a new intake.',
        );
      }
    }
  }

  if (config.intake.required) {
    throw new SupportDeskError(
      428,
      'intake_required',
      'Intake submission is required before starting support chat.',
    );
  }

  return {
    active: true,
    mode: 'skipped',
    tenantId: tenant.id,
    userId: context.userId,
    role: context.role,
  };
}

/**
 * Returns non-value receipt-reference metadata for workflow persistence.
 */
export function getInternalIntakeForGate(
  gate: SupportDeskIntakeGate,
): SupportDeskInternalConversationIntake | undefined {
  if (!gate.active || (gate.mode !== 'receipt' && gate.mode !== 'bound')) {
    return undefined;
  }
  return {
    schemaHash: gate.schemaHash,
    submittedAt: gate.submittedAt,
    receiptHash: gate.receiptHash,
  };
}

/**
 * Revalidates current schema/binding and atomically binds an intake receipt inside the caller's transaction.
 */
export function commitSupportDeskIntake(params: {
  gate: SupportDeskIntakeGate;
  conversationId?: string;
  now?: number;
}): { schemaHash: string; submittedAt: string } | undefined {
  const { gate, conversationId, now } = params;
  const config = getSupportDeskWidgetConfig(gate.tenantId);
  if (!gate.active || gate.mode === 'skipped') {
    if (config.enabled && config.intake.required && config.intake.fields.length > 0) {
      throw new SupportDeskError(409, 'intake_schema_changed', 'Required intake was enabled during turn execution.');
    }
    return undefined;
  }

  const currentSchemaHash = computeSupportDeskIntakeSchemaHash(config);
  if (!config.enabled || config.intake.fields.length === 0 || currentSchemaHash !== gate.schemaHash) {
    throw new SupportDeskError(
      409,
      'intake_schema_changed',
      'Intake form schema changed during turn execution.',
    );
  }

  if (gate.mode === 'receipt') {
    if (!conversationId) {
      throw new SupportDeskError(
        401,
        'signed_session_required',
        'A persisted conversation is required to bind an intake receipt.',
      );
    }
    bindSupportDeskIntake({
      tenantId: gate.tenantId,
      userId: gate.userId,
      role: gate.role,
      receiptId: gate.receiptId,
      conversationId,
      schemaHash: gate.schemaHash,
      now,
    });
  }

  return {
    schemaHash: gate.schemaHash,
    submittedAt: gate.submittedAt,
  };
}

/**
 * Hydrates a copy of bound intake values from encrypted 019 storage for canonical conversation reads,
 * masking according to viewerRole and stripping internal receiptHash.
 */
export function hydrateSupportConversationIntake(params: {
  tenantId: number;
  conversation: SupportConversation;
  viewerRole: string;
}): SupportConversation {
  const { tenantId, conversation, viewerRole } = params;
  const rawIntake = conversation.intake as
    | (SupportDeskConversationIntake & { receiptHash?: string })
    | undefined;
  if (!rawIntake) return conversation;

  const publicProjection: SupportDeskConversationIntake = {
    schemaHash: rawIntake.schemaHash,
    submittedAt: rawIntake.submittedAt,
  };

  if (Number.isInteger(tenantId) && tenantId > 0) {
    const bound = readSupportDeskBoundIntake({
      tenantId,
      conversationId: conversation.id,
      userId: conversation.userId,
    });
    if (bound && bound.role === conversation.userRole) {
      const masked = maskSupportSensitiveData(String(tenantId), bound.values, viewerRole);
      publicProjection.values = masked.masked as Record<string, string | number>;
    }
  }

  return {
    ...conversation,
    intake: publicProjection,
  };
}
