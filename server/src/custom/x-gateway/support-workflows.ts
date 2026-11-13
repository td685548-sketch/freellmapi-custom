import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';
import type { SupportAnswerEvidence } from '@freellmapi/shared/support-evidence.js';
import type {
  SupportDeskConversationIntake,
  SupportDeskInternalConversationIntake,
} from '@freellmapi/shared/support-service-desk.js';
import { sanitizeSupportEvidenceConversation } from './support-evidence-runtime.js';
import { hydrateSupportConversationIntake } from './support-service-desk-runtime.js';
import {
  onHumanReplyLifecycle,
  onTicketCreatedLifecycle,
  onTicketUpdatedLifecycle,
} from './support-service-desk-lifecycle.js';

const CONVERSATIONS_KEY = 'x_gateway_support_conversations_v1';
const TICKETS_KEY = 'x_gateway_support_tickets_v1';
const ACTIONS_KEY = 'x_gateway_support_actions_v1';

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class SupportWorkflowError extends Error {
  public statusCode: number;
  constructor(public status: number, message: string) {
    super(message);
    this.statusCode = status;
  }
}

// ---------------------------------------------------------------------------
// Types (mirroring specs/014-ai-support-enterprise-suite/data-model.md)
// ---------------------------------------------------------------------------

export type SupportMessageSenderType = 'customer' | 'ai_assistant' | 'human_agent' | 'system';

export interface SupportConversationMessage {
  id: string; // 'msg_' + randomUUID()
  senderType: SupportMessageSenderType;
  senderId: string;
  senderName?: string;
  senderRole?: string;
  content: string;
  toolTrace?: Array<{
    toolName: string;
    status: string;
    durationMs?: number;
  }>;
  evidence?: SupportAnswerEvidence;
  responseNotice?: {
    requestId: string;
    reason: 'no_matches' | 'invalid_citations' | 'sources_changed';
  };
  createdAt: string;
}

export type SupportConversationStatus = 'active' | 'escalated' | 'resolved' | 'closed';

export interface SupportConversation {
  id: string; // 'conv_' + randomUUID()
  tenantId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole: string;
  subject: string;
  status: SupportConversationStatus;
  messages: SupportConversationMessage[];
  assignedAgent?: string;
  intake?: SupportDeskConversationIntake;
  createdAt: string;
  updatedAt: string;
}

export type SupportTicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type SupportTicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface SupportEscalationTicket {
  id: string; // 'tkt_' + randomUUID()
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  subject: string;
  reason: string;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  assignedTo?: string;
  resolutionNotes?: string;
  createdAt: string;
  updatedAt: string;
}

export type SupportPendingActionStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface SupportPendingAction {
  id: string; // 'act_' + randomUUID()
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  toolName: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  status: SupportPendingActionStatus;
  reviewedBy?: string;
  reviewNote?: string;
  executionResult?: unknown;
  createdAt: string;
  reviewedAt?: string;
}

export interface SupportAnalyticsSummary {
  tenantId: string;
  totalConversations: number;
  activeConversations: number;
  escalatedConversations: number;
  resolvedConversations: number;
  deflectionRatePct: number;
  totalTickets: number;
  openTickets: number;
  totalPendingActions: number;
  awaitingApprovalActions: number;
  approvedActions: number;
  rejectedActions: number;
  byRole: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureSettingsTable(): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
}

function readStore<T>(key: string): Record<string, T> {
  ensureSettingsTable();
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {};
  } catch {
    return {};
  }
}

function writeStore<T>(key: string, store: Record<string, T>): void {
  ensureSettingsTable();
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, JSON.stringify(store));
}

// ---------------------------------------------------------------------------
// Conversation Operations
// ---------------------------------------------------------------------------

export function listSupportConversations(
  tenantId: string,
  filter?: { userId?: string; status?: SupportConversationStatus },
): SupportConversation[] {
  const tid = String(tenantId);
  const store = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const numericTenantId = Number(tid);

  return list
    .filter((conv) => {
      if (filter?.userId && conv.userId !== filter.userId) return false;
      if (filter?.status && conv.status !== filter.status) return false;
      return true;
    })
    .map((conv) =>
      Number.isInteger(numericTenantId) && numericTenantId > 0
        ? hydrateSupportConversationIntake({
            tenantId: numericTenantId,
            conversation: sanitizeSupportEvidenceConversation({
              tenantId: numericTenantId,
              conversation: conv,
              viewerRole: conv.userRole,
            }),
            viewerRole: conv.userRole,
          })
        : conv,
    );
}

export function getSupportConversationForUser(
  tenantId: string,
  conversationId: string,
  requester: { userId: string; role: string },
): SupportConversation {
  const tid = String(tenantId);
  const store = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const found = list.find((c) => c.id === conversationId);

  if (!found) {
    throw new SupportWorkflowError(404, `Conversation '${conversationId}' not found`);
  }

  const role = String(requester.role ?? '').toLowerCase();
  const isAdminOrStaff = role === 'admin' || role === 'staff';

  if (found.userId !== requester.userId && !isAdminOrStaff) {
    throw new SupportWorkflowError(
      403,
      'Forbidden: cannot access another user conversation',
    );
  }

  const numericTenantId = Number(tid);
  if (Number.isInteger(numericTenantId) && numericTenantId > 0) {
    return hydrateSupportConversationIntake({
      tenantId: numericTenantId,
      conversation: sanitizeSupportEvidenceConversation({
        tenantId: numericTenantId,
        conversation: found,
        viewerRole: requester.role,
      }),
      viewerRole: requester.role,
    });
  }

  return found;
}

export function createOrAppendSupportConversation(
  tenantId: string,
  input: {
    conversationId?: string;
    userId: string;
    userName?: string;
    userEmail?: string;
    userRole: string;
    subject?: string;
    message: Omit<SupportConversationMessage, 'id' | 'createdAt' | 'evidence' | 'responseNotice'>;
    internalEvidence?: {
      evidence?: SupportAnswerEvidence;
      responseNotice?: SupportConversationMessage['responseNotice'];
    };
    internalIntake?: SupportDeskInternalConversationIntake;
  },
): SupportConversation {
  const tid = String(tenantId);
  const store = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  const newMsg: SupportConversationMessage = {
    id: `msg_${randomUUID()}`,
    senderType: input.message.senderType,
    senderId: input.message.senderId,
    senderName: input.message.senderName,
    senderRole: input.message.senderRole,
    content: input.message.content,
    toolTrace: input.message.toolTrace,
    ...(input.internalEvidence?.evidence ? { evidence: input.internalEvidence.evidence } : {}),
    ...(input.internalEvidence?.responseNotice ? { responseNotice: input.internalEvidence.responseNotice } : {}),
    createdAt: now,
  };

  const existingIdx = input.conversationId
    ? list.findIndex((c) => c.id === input.conversationId)
    : -1;

  let conv: SupportConversation;

  if (existingIdx >= 0) {
    const existing = list[existingIdx];
    const role = String(input.userRole ?? '').toLowerCase();
    const isAdminOrStaff = role === 'admin' || role === 'staff';

    if (existing.userId !== input.userId && !isAdminOrStaff) {
      throw new SupportWorkflowError(
        403,
        'Forbidden: cannot access another user conversation',
      );
    }

    const persistedIntake = input.internalIntake
      ? ({
          schemaHash: input.internalIntake.schemaHash,
          submittedAt: input.internalIntake.submittedAt,
          receiptHash: input.internalIntake.receiptHash,
        } as unknown as SupportDeskConversationIntake)
      : existing.intake;

    conv = {
      ...existing,
      userName: input.userName ?? existing.userName,
      userEmail: input.userEmail ?? existing.userEmail,
      ...(persistedIntake ? { intake: persistedIntake } : {}),
      messages: [...existing.messages, newMsg],
      updatedAt: now,
    };
    list[existingIdx] = conv;
  } else {
    const persistedIntake = input.internalIntake
      ? ({
          schemaHash: input.internalIntake.schemaHash,
          submittedAt: input.internalIntake.submittedAt,
          receiptHash: input.internalIntake.receiptHash,
        } as unknown as SupportDeskConversationIntake)
      : undefined;

    conv = {
      id: `conv_${randomUUID()}`,
      tenantId: tid,
      userId: input.userId,
      userName: input.userName,
      userEmail: input.userEmail,
      userRole: input.userRole,
      subject: (input.subject ?? 'Support Conversation').trim(),
      status: 'active',
      ...(persistedIntake ? { intake: persistedIntake } : {}),
      messages: [newMsg],
      createdAt: now,
      updatedAt: now,
    };
    list.push(conv);
  }

  store[tid] = list;
  writeStore(CONVERSATIONS_KEY, store);
  return conv;
}

export function addHumanAgentReply(
  tenantId: string,
  conversationId: string,
  input: { agentName: string; content: string; resolveConversation?: boolean },
): SupportConversation {
  const tid = String(tenantId);
  return getDb().transaction(() => {
    const store = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
    const list = Array.isArray(store[tid]) ? store[tid] : [];
    const idx = list.findIndex((c) => c.id === conversationId);

    if (idx < 0) {
      throw new SupportWorkflowError(404, `Conversation '${conversationId}' not found`);
    }

    const existing = list[idx];
    const now = new Date().toISOString();

    const agentMsg: SupportConversationMessage = {
      id: `msg_${randomUUID()}`,
      senderType: 'human_agent',
      senderId: input.agentName,
      senderName: input.agentName,
      senderRole: 'staff',
      content: input.content,
      createdAt: now,
    };

    const updated: SupportConversation = {
      ...existing,
      assignedAgent: input.agentName,
      status: input.resolveConversation ? 'resolved' : existing.status,
      messages: [...existing.messages, agentMsg],
      updatedAt: now,
    };

    list[idx] = updated;
    store[tid] = list;
    writeStore(CONVERSATIONS_KEY, store);

    onHumanReplyLifecycle(tid, conversationId, now, {
      resolveConversation: input.resolveConversation,
    });

    return updated;
  })();
}

// ---------------------------------------------------------------------------
// Escalation Ticket Operations
// ---------------------------------------------------------------------------

export function listSupportEscalationTickets(
  tenantId: string,
  filter?: { userId?: string; status?: SupportTicketStatus; priority?: SupportTicketPriority },
): SupportEscalationTicket[] {
  const tid = String(tenantId);
  const store = readStore<SupportEscalationTicket[]>(TICKETS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  return list.filter((tkt) => {
    if (filter?.userId && tkt.userId !== filter.userId) return false;
    if (filter?.status && tkt.status !== filter.status) return false;
    if (filter?.priority && tkt.priority !== filter.priority) return false;
    return true;
  });
}

export function createSupportEscalationTicket(
  tenantId: string,
  input: {
    conversationId?: string;
    userId: string;
    userName?: string;
    userRole: string;
    subject: string;
    reason: string;
    priority?: SupportTicketPriority;
  },
): SupportEscalationTicket {
  const tid = String(tenantId);
  return getDb().transaction(() => {
    const store = readStore<SupportEscalationTicket[]>(TICKETS_KEY);
    const list = Array.isArray(store[tid]) ? store[tid] : [];
    const now = new Date().toISOString();

    const ticket: SupportEscalationTicket = {
      id: `tkt_${randomUUID()}`,
      tenantId: tid,
      conversationId: input.conversationId,
      userId: input.userId,
      userName: input.userName,
      userRole: input.userRole,
      subject: input.subject.trim(),
      reason: input.reason.trim(),
      priority: input.priority ?? 'medium',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };

    list.push(ticket);
    store[tid] = list;
    writeStore(TICKETS_KEY, store);

    // If conversationId provided, update conversation status to 'escalated'
    if (input.conversationId) {
      const convStore = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
      const convList = Array.isArray(convStore[tid]) ? convStore[tid] : [];
      const cIdx = convList.findIndex((c) => c.id === input.conversationId);
      if (cIdx >= 0) {
        convList[cIdx] = {
          ...convList[cIdx],
          status: 'escalated',
          updatedAt: now,
        };
        convStore[tid] = convList;
        writeStore(CONVERSATIONS_KEY, convStore);
      }
    }

    onTicketCreatedLifecycle(ticket, Date.parse(now));

    return ticket;
  })();
}

export function updateSupportEscalationTicket(
  tenantId: string,
  ticketId: string,
  patch: Partial<Pick<SupportEscalationTicket, 'status' | 'priority' | 'assignedTo' | 'resolutionNotes'>>,
): SupportEscalationTicket | null {
  const tid = String(tenantId);
  return getDb().transaction(() => {
    const store = readStore<SupportEscalationTicket[]>(TICKETS_KEY);
    const list = Array.isArray(store[tid]) ? store[tid] : [];
    const idx = list.findIndex((t) => t.id === ticketId);
    if (idx < 0) return null;

    const existing = list[idx];
    const now = new Date().toISOString();
    const updated: SupportEscalationTicket = {
      ...existing,
      ...patch,
      updatedAt: now,
    };

    list[idx] = updated;
    store[tid] = list;
    writeStore(TICKETS_KEY, store);

    // If status resolved and ticket is linked to a conversation, update conversation to resolved
    if (patch.status === 'resolved' && updated.conversationId) {
      const convStore = readStore<SupportConversation[]>(CONVERSATIONS_KEY);
      const convList = Array.isArray(convStore[tid]) ? convStore[tid] : [];
      const cIdx = convList.findIndex((c) => c.id === updated.conversationId);
      if (cIdx >= 0) {
        convList[cIdx] = {
          ...convList[cIdx],
          status: 'resolved',
          updatedAt: now,
        };
        convStore[tid] = convList;
        writeStore(CONVERSATIONS_KEY, convStore);
      }
    }

    onTicketUpdatedLifecycle(existing, updated, Date.parse(now), {
      statusExplicitlySet: patch.status !== undefined,
    });

    return updated;
  })();
}

// ---------------------------------------------------------------------------
// Pending Action Approvals
// ---------------------------------------------------------------------------

export function listSupportPendingActions(
  tenantId: string,
  filter?: { userId?: string; status?: SupportPendingActionStatus },
): SupportPendingAction[] {
  const tid = String(tenantId);
  const store = readStore<SupportPendingAction[]>(ACTIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  return list.filter((act) => {
    if (filter?.userId && act.userId !== filter.userId) return false;
    if (filter?.status && act.status !== filter.status) return false;
    return true;
  });
}

export function proposeSupportPendingAction(
  tenantId: string,
  input: {
    conversationId?: string;
    userId: string;
    userName?: string;
    userRole: string;
    toolName: string;
    actionSummary: string;
    payload: Record<string, unknown>;
  },
): SupportPendingAction {
  const tid = String(tenantId);
  const store = readStore<SupportPendingAction[]>(ACTIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  const action: SupportPendingAction = {
    id: `act_${randomUUID()}`,
    tenantId: tid,
    conversationId: input.conversationId,
    userId: input.userId,
    userName: input.userName,
    userRole: input.userRole,
    toolName: input.toolName.trim(),
    actionSummary: input.actionSummary.trim(),
    payload: input.payload,
    status: 'pending',
    createdAt: now,
  };

  list.push(action);
  store[tid] = list;
  writeStore(ACTIONS_KEY, store);
  return action;
}

export function reviewSupportPendingAction(
  tenantId: string,
  actionId: string,
  review: {
    decision: 'approved' | 'rejected';
    reviewedBy: string;
    reviewNote?: string;
    executionResult?: unknown;
  },
): SupportPendingAction | null {
  const tid = String(tenantId);
  const store = readStore<SupportPendingAction[]>(ACTIONS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const idx = list.findIndex((a) => a.id === actionId);
  if (idx < 0) return null;

  const existing = list[idx];
  const now = new Date().toISOString();
  const updated: SupportPendingAction = {
    ...existing,
    status: review.decision,
    reviewedBy: review.reviewedBy,
    reviewNote: review.reviewNote,
    executionResult: review.executionResult !== undefined ? review.executionResult : existing.executionResult,
    reviewedAt: now,
  };

  list[idx] = updated;
  store[tid] = list;
  writeStore(ACTIONS_KEY, store);
  return updated;
}

// ---------------------------------------------------------------------------
// Analytics Summary
// ---------------------------------------------------------------------------

export function getSupportAnalyticsSummary(tenantId: string): SupportAnalyticsSummary {
  const tid = String(tenantId);
  const convs = listSupportConversations(tid);
  const tickets = listSupportEscalationTickets(tid);
  const actions = listSupportPendingActions(tid);

  const totalConversations = convs.length;
  const activeConversations = convs.filter((c) => c.status === 'active').length;
  const escalatedConversations = convs.filter((c) => c.status === 'escalated').length;
  const resolvedConversations = convs.filter((c) => c.status === 'resolved').length;

  const deflectionRatePct =
    totalConversations === 0
      ? 100
      : Math.max(0, Math.round(((totalConversations - escalatedConversations) / totalConversations) * 100));

  const totalTickets = tickets.length;
  const openTickets = tickets.filter((t) => t.status === 'open' || t.status === 'in_progress').length;

  const totalPendingActions = actions.length;
  const awaitingApprovalActions = actions.filter((a) => a.status === 'pending').length;
  const approvedActions = actions.filter((a) => a.status === 'approved').length;
  const rejectedActions = actions.filter((a) => a.status === 'rejected').length;

  const byRole: Record<string, number> = {};
  for (const c of convs) {
    const role = c.userRole || 'customer';
    byRole[role] = (byRole[role] ?? 0) + 1;
  }

  return {
    tenantId: tid,
    totalConversations,
    activeConversations,
    escalatedConversations,
    resolvedConversations,
    deflectionRatePct,
    totalTickets,
    openTickets,
    totalPendingActions,
    awaitingApprovalActions,
    approvedActions,
    rejectedActions,
    byRole,
  };
}
