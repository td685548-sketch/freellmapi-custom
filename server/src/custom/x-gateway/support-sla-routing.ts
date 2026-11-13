import type {
  SupportDeskDepartment,
  SupportDeskSlaClock,
  SupportDeskSlaPolicy,
  SupportDeskSlaTarget,
  SupportDeskTicketState,
  SupportTicketPriority,
} from '@freellmapi/shared/support-service-desk.js';

export type SupportSlaTicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface SupportSlaTicketSnapshot {
  id: string;
  tenantId: number | string;
  conversationId?: string;
  subject: string;
  reason: string;
  priority: SupportTicketPriority;
  status: SupportSlaTicketStatus;
  createdAt: string;
}

export interface SupportSlaCalculatedResult {
  tracked: boolean;
  firstResponse: SupportDeskSlaClock;
  resolution: SupportDeskSlaClock;
}

function normalizePhrase(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function cloneTargets(
  targets: Record<SupportTicketPriority, SupportDeskSlaTarget>,
): Record<SupportTicketPriority, SupportDeskSlaTarget> {
  return {
    urgent: { ...targets.urgent },
    high: { ...targets.high },
    medium: { ...targets.medium },
    low: { ...targets.low },
  };
}

function isTerminalStatus(status: SupportSlaTicketStatus): boolean {
  return status === 'resolved' || status === 'closed';
}

/**
 * Deterministically selects a support department using ordered accent-normalized
 * phrase matching against ticket subject and reason, falling back to 'general'.
 */
export function selectSupportDeskDepartment(
  ticket: Pick<SupportSlaTicketSnapshot, 'subject' | 'reason'>,
  policy: Pick<SupportDeskSlaPolicy, 'routingRules'>,
): { department: SupportDeskDepartment; routingSource: 'rule' | 'fallback' } {
  const haystack = normalizePhrase(`${ticket.subject ?? ''} ${ticket.reason ?? ''}`);
  if (haystack && Array.isArray(policy.routingRules)) {
    for (const rule of policy.routingRules) {
      if (!rule || !Array.isArray(rule.keywords)) continue;
      for (const rawKeyword of rule.keywords) {
        const keyword = normalizePhrase(String(rawKeyword ?? ''));
        if (keyword && haystack.includes(keyword)) {
          return { department: rule.department, routingSource: 'rule' };
        }
      }
    }
  }
  return { department: 'general', routingSource: 'fallback' };
}

/**
 * Evaluates 24/7 UTC SLA clocks for a persisted ticket state at an explicit epoch timestamp.
 */
export function calculateSupportDeskSla(
  state: SupportDeskTicketState | null | undefined,
  now: number,
): SupportSlaCalculatedResult {
  if (!state || state.tracking === 'paused') {
    return {
      tracked: false,
      firstResponse: { status: 'not_observed', deadlineAt: null, elapsedMs: null },
      resolution: { status: 'not_observed', deadlineAt: null, elapsedMs: null },
    };
  }

  const cycleOpenedAtMs = Date.parse(state.cycleOpenedAt);
  const target = state.policyTargets[state.priority];
  const firstTargetMs = target.firstResponseMinutes * 60_000;
  const resTargetMs = target.resolutionMinutes * 60_000;
  const firstDeadlineMs = cycleOpenedAtMs + firstTargetMs;
  const resDeadlineMs = cycleOpenedAtMs + resTargetMs;
  const firstDeadlineIso = new Date(firstDeadlineMs).toISOString();
  const resDeadlineIso = new Date(resDeadlineMs).toISOString();

  let firstResponse: SupportDeskSlaClock;
  if (!state.conversationId) {
    const endMs = state.resolvedAt ? Date.parse(state.resolvedAt) : now;
    firstResponse = {
      status: 'not_observed',
      deadlineAt: firstDeadlineIso,
      elapsedMs: Math.max(0, endMs - cycleOpenedAtMs),
    };
  } else if (state.firstHumanReplyAt) {
    const replyMs = Date.parse(state.firstHumanReplyAt);
    firstResponse = {
      status: replyMs < firstDeadlineMs ? 'met' : 'breached',
      deadlineAt: firstDeadlineIso,
      elapsedMs: Math.max(0, replyMs - cycleOpenedAtMs),
    };
  } else if (state.terminal) {
    const endMs = state.resolvedAt ? Date.parse(state.resolvedAt) : now;
    firstResponse = {
      status: 'not_observed',
      deadlineAt: firstDeadlineIso,
      elapsedMs: Math.max(0, endMs - cycleOpenedAtMs),
    };
  } else {
    const elapsedMs = Math.max(0, now - cycleOpenedAtMs);
    const status =
      now >= firstDeadlineMs
        ? 'breached'
        : elapsedMs * 4 >= firstTargetMs * 3
          ? 'warning'
          : 'healthy';
    firstResponse = { status, deadlineAt: firstDeadlineIso, elapsedMs };
  }

  let resolution: SupportDeskSlaClock;
  if (state.resolvedAt) {
    const resolvedMs = Date.parse(state.resolvedAt);
    resolution = {
      status: resolvedMs < resDeadlineMs ? 'met' : 'breached',
      deadlineAt: resDeadlineIso,
      elapsedMs: Math.max(0, resolvedMs - cycleOpenedAtMs),
    };
  } else if (state.terminal) {
    resolution = {
      status: 'not_observed',
      deadlineAt: resDeadlineIso,
      elapsedMs: Math.max(0, now - cycleOpenedAtMs),
    };
  } else {
    const elapsedMs = Math.max(0, now - cycleOpenedAtMs);
    const status =
      now >= resDeadlineMs
        ? 'breached'
        : elapsedMs * 4 >= resTargetMs * 3
          ? 'warning'
          : 'healthy';
    resolution = { status, deadlineAt: resDeadlineIso, elapsedMs };
  }

  return {
    tracked: true,
    firstResponse,
    resolution,
  };
}

/**
 * Creates the initial SLA & routing state for a newly created ticket when SLA tracking is enabled.
 * Returns null when SLA tracking is disabled or tenantId is not a positive integer.
 */
export function initializeSupportDeskTicketState(
  ticket: SupportSlaTicketSnapshot,
  policy: SupportDeskSlaPolicy,
  now: number,
): SupportDeskTicketState | null {
  if (!policy.enabled) return null;
  const numericTenantId = Number(ticket.tenantId);
  if (!Number.isInteger(numericTenantId) || numericTenantId <= 0) return null;

  const routing = selectSupportDeskDepartment(ticket, policy);
  const terminal = isTerminalStatus(ticket.status);
  const openedAt = ticket.createdAt || new Date(now).toISOString();

  return {
    tenantId: numericTenantId,
    ticketId: ticket.id,
    ...(ticket.conversationId ? { conversationId: ticket.conversationId } : {}),
    version: 1,
    cycle: 1,
    cycleOpenedAt: openedAt,
    tracking: 'tracked',
    policyVersion: policy.version,
    policyTargets: cloneTargets(policy.targets),
    priority: ticket.priority,
    department: routing.department,
    routingSource: routing.routingSource,
    firstHumanReplyAt: null,
    resolvedAt: terminal ? openedAt : null,
    terminal,
  };
}

/**
 * Computes the next SLA ticket state for status/priority transitions and explicit reopens.
 */
export function transitionSupportDeskTicketState(
  _beforeTicket: Pick<SupportSlaTicketSnapshot, 'priority' | 'status'>,
  afterTicket: Pick<SupportSlaTicketSnapshot, 'priority' | 'status'>,
  state: SupportDeskTicketState,
  now: number,
  options: { statusExplicitlySet: boolean; currentPolicy?: SupportDeskSlaPolicy },
): SupportDeskTicketState {
  const isReopen =
    state.terminal &&
    options.statusExplicitlySet &&
    (afterTicket.status === 'open' || afterTicket.status === 'in_progress');

  if (isReopen) {
    const nowIso = new Date(now).toISOString();
    const policyEnabled = Boolean(options.currentPolicy?.enabled);
    return {
      ...state,
      cycle: state.cycle + 1,
      cycleOpenedAt: nowIso,
      tracking: policyEnabled ? 'tracked' : 'paused',
      policyVersion:
        policyEnabled && options.currentPolicy ? options.currentPolicy.version : state.policyVersion,
      policyTargets:
        policyEnabled && options.currentPolicy
          ? cloneTargets(options.currentPolicy.targets)
          : cloneTargets(state.policyTargets),
      priority: afterTicket.priority,
      firstHumanReplyAt: null,
      resolvedAt: null,
      terminal: false,
    };
  }

  if (!state.terminal && isTerminalStatus(afterTicket.status)) {
    const nowIso = new Date(now).toISOString();
    return {
      ...state,
      priority: afterTicket.priority,
      resolvedAt: state.resolvedAt ?? nowIso,
      terminal: true,
    };
  }

  return {
    ...state,
    priority: afterTicket.priority,
  };
}
