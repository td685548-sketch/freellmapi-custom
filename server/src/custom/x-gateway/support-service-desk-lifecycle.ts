import type { SupportDeskTicketState } from '@freellmapi/shared/support-service-desk.js';
import type { SupportEscalationTicket } from './support-workflows.js';
import {
  getSupportDeskSlaPolicy,
  getSupportDeskTicketState,
  insertSupportDeskTicketState,
  listSupportDeskTicketStates,
  updateSupportDeskTicketState,
} from './support-service-desk-store.js';
import {
  initializeSupportDeskTicketState,
  transitionSupportDeskTicketState,
} from './support-sla-routing.js';

function parseNumericTenantId(tenantId: number | string): number | null {
  const num = Number(tenantId);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/**
 * Synchronous lifecycle hook invoked inside the ticket-creation transaction.
 * No-ops for legacy non-numeric tenant fixtures or disabled SLA policies.
 */
export function onTicketCreatedLifecycle(
  ticket: SupportEscalationTicket,
  now: number = Date.now(),
): void {
  const numericTenantId = parseNumericTenantId(ticket.tenantId);
  if (numericTenantId === null) return;

  const policy = getSupportDeskSlaPolicy(numericTenantId);
  const state = initializeSupportDeskTicketState(ticket, policy, now);
  if (!state) return;

  insertSupportDeskTicketState(state);
}

/**
 * Synchronous lifecycle hook invoked inside addHumanAgentReply transaction.
 * Stops first-response clock once for active linked cycles and finishes clocks if resolveConversation is set.
 */
export function onHumanReplyLifecycle(
  tenantId: number | string,
  conversationId: string,
  replyTimestampIso: string,
  options?: { resolveConversation?: boolean },
): void {
  const numericTenantId = parseNumericTenantId(tenantId);
  if (numericTenantId === null) return;

  const replyMs = Date.parse(replyTimestampIso);
  let cursor: string | undefined;

  do {
    const page = listSupportDeskTicketStates(numericTenantId, { cursor, limit: 100 });
    for (const state of page.items) {
      if (state.conversationId !== conversationId || state.terminal) continue;

      const patch: Partial<SupportDeskTicketState> = {};
      let changed = false;

      if (
        state.tracking === 'tracked' &&
        !state.firstHumanReplyAt &&
        replyMs >= Date.parse(state.cycleOpenedAt)
      ) {
        patch.firstHumanReplyAt = replyTimestampIso;
        changed = true;
      }

      if (options?.resolveConversation) {
        patch.resolvedAt = state.resolvedAt ?? replyTimestampIso;
        patch.terminal = true;
        changed = true;
      }

      if (changed) {
        updateSupportDeskTicketState(numericTenantId, state.ticketId, patch, state.version);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/**
 * Synchronous lifecycle hook invoked inside updateSupportEscalationTicket transaction.
 * Transitions existing tracked SLA state without backfilling untracked legacy tickets.
 */
export function onTicketUpdatedLifecycle(
  beforeTicket: SupportEscalationTicket,
  afterTicket: SupportEscalationTicket,
  now: number = Date.now(),
  options?: { statusExplicitlySet: boolean },
): void {
  const numericTenantId = parseNumericTenantId(afterTicket.tenantId);
  if (numericTenantId === null) return;

  const existing = getSupportDeskTicketState(numericTenantId, afterTicket.id);
  if (!existing) return;

  const statusExplicitlySet = Boolean(options?.statusExplicitlySet);
  const isReopen =
    existing.terminal &&
    statusExplicitlySet &&
    (afterTicket.status === 'open' || afterTicket.status === 'in_progress');
  const currentPolicy = isReopen ? getSupportDeskSlaPolicy(numericTenantId) : undefined;

  const next = transitionSupportDeskTicketState(beforeTicket, afterTicket, existing, now, {
    statusExplicitlySet,
    currentPolicy,
  });

  const changed =
    next.cycle !== existing.cycle ||
    next.cycleOpenedAt !== existing.cycleOpenedAt ||
    next.tracking !== existing.tracking ||
    next.policyVersion !== existing.policyVersion ||
    next.priority !== existing.priority ||
    next.firstHumanReplyAt !== existing.firstHumanReplyAt ||
    next.resolvedAt !== existing.resolvedAt ||
    next.terminal !== existing.terminal;

  if (changed) {
    updateSupportDeskTicketState(
      numericTenantId,
      afterTicket.id,
      {
        cycle: next.cycle,
        cycleOpenedAt: next.cycleOpenedAt,
        tracking: next.tracking,
        policyVersion: next.policyVersion,
        policyTargets: next.policyTargets,
        priority: next.priority,
        firstHumanReplyAt: next.firstHumanReplyAt,
        resolvedAt: next.resolvedAt,
        terminal: next.terminal,
      },
      existing.version,
    );
  }
}
