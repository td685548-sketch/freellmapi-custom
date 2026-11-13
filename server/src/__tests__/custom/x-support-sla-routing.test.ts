import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPPORT_DESK_SLA_POLICY,
  type SupportDeskSlaPolicy,
  type SupportDeskTicketState,
  type SupportTicketPriority,
} from '@freellmapi/shared/support-service-desk.js';
import {
  calculateSupportDeskSla,
  initializeSupportDeskTicketState,
  selectSupportDeskDepartment,
  transitionSupportDeskTicketState,
  type SupportSlaTicketSnapshot,
} from '../../custom/x-gateway/support-sla-routing.js';

const BASE_TIME = Date.parse('2026-11-13T10:00:00.000Z');
const MINUTE = 60_000;

function makePolicy(overrides: Partial<SupportDeskSlaPolicy> = {}): SupportDeskSlaPolicy {
  return {
    ...DEFAULT_SUPPORT_DESK_SLA_POLICY,
    enabled: true,
    version: 3,
    routingRules: [
      { id: 'r1', department: 'billing', keywords: ['hóa đơn', 'invoice', 'charge'] },
      { id: 'r2', department: 'returns', keywords: ['đổi trả', 'refund'] },
      { id: 'r3', department: 'technical', keywords: ['lỗi 500', 'api timeout'] },
    ],
    ...overrides,
  };
}

function makeTicket(overrides: Partial<SupportSlaTicketSnapshot> = {}): SupportSlaTicketSnapshot {
  return {
    id: 'tkt_1',
    tenantId: 10,
    conversationId: 'conv_1',
    subject: 'General inquiry',
    reason: 'Need assistance',
    priority: 'medium',
    status: 'open',
    createdAt: new Date(BASE_TIME).toISOString(),
    ...overrides,
  };
}

describe('Support SLA & Routing Pure Engine (Spec 019)', () => {
  // 1-4: Routing across 4 departments + accent normalization + first-match + fallback
  it('1. routes to billing with accent-normalized Vietnamese phrase match', () => {
    const res = selectSupportDeskDepartment(
      { subject: 'Sai HOA DON thang 11', reason: 'Kiem tra lai' },
      makePolicy(),
    );
    expect(res).toEqual({ department: 'billing', routingSource: 'rule' });
  });

  it('2. routes to returns using ordered keyword match', () => {
    const res = selectSupportDeskDepartment(
      { subject: 'Yeu cau doi tra san pham', reason: 'Khong dung mo ta' },
      makePolicy(),
    );
    expect(res).toEqual({ department: 'returns', routingSource: 'rule' });
  });

  it('3. routes to technical when technical keyword matches', () => {
    const res = selectSupportDeskDepartment(
      { subject: 'API timeout on checkout', reason: 'Happening since morning' },
      makePolicy(),
    );
    expect(res).toEqual({ department: 'technical', routingSource: 'rule' });
  });

  it('4. uses first-match-wins when multiple rules match and falls back to general when none match', () => {
    const firstWins = selectSupportDeskDepartment(
      { subject: 'Refund for duplicate invoice', reason: 'api timeout' },
      makePolicy(),
    );
    expect(firstWins).toEqual({ department: 'billing', routingSource: 'rule' });

    const fallback = selectSupportDeskDepartment(
      { subject: 'Account question', reason: 'How do I update my profile?' },
      makePolicy(),
    );
    expect(fallback).toEqual({ department: 'general', routingSource: 'fallback' });
  });

  // 5-6: Initialization & disabled policy / legacy nonnumeric tenant
  it('5. returns null on initialize when SLA policy is disabled or tenantId is non-numeric', () => {
    expect(
      initializeSupportDeskTicketState(makeTicket(), makePolicy({ enabled: false }), BASE_TIME),
    ).toBeNull();
    expect(
      initializeSupportDeskTicketState(makeTicket({ tenantId: 'legacy_alpha' }), makePolicy(), BASE_TIME),
    ).toBeNull();
  });

  it('6. snapshots all 4 priority targets and policyVersion on ticket creation', () => {
    const policy = makePolicy({
      version: 7,
      targets: {
        urgent: { firstResponseMinutes: 4, resolutionMinutes: 40 },
        high: { firstResponseMinutes: 12, resolutionMinutes: 120 },
        medium: { firstResponseMinutes: 60, resolutionMinutes: 1440 },
        low: { firstResponseMinutes: 240, resolutionMinutes: 4320 },
      },
    });
    const state = initializeSupportDeskTicketState(
      makeTicket({ priority: 'urgent', subject: 'Double charge' }),
      policy,
      BASE_TIME,
    )!;
    expect(state).not.toBeNull();
    expect(state.policyVersion).toBe(7);
    expect(state.policyTargets).toEqual(policy.targets);
    expect(state.department).toBe('billing');
    expect(state.routingSource).toBe('rule');
    expect(state.cycle).toBe(1);
    expect(state.tracking).toBe('tracked');
  });

  // 7-10: 75% warning and 100% breach boundaries across all 4 priorities
  it.each<{ priority: SupportTicketPriority; firstMin: number; resMin: number }>([
    { priority: 'urgent', firstMin: 5, resMin: 60 },
    { priority: 'high', firstMin: 15, resMin: 240 },
    { priority: 'medium', firstMin: 60, resMin: 1440 },
    { priority: 'low', firstMin: 240, resMin: 4320 },
  ])('7-10. evaluates healthy / 75% warning / 100% breached bounds for $priority', ({ priority, firstMin, resMin }) => {
    const state = initializeSupportDeskTicketState(
      makeTicket({ priority }),
      makePolicy(),
      BASE_TIME,
    )!;

    // Just before 75% of firstResponse
    const beforeWarn = BASE_TIME + firstMin * MINUTE * 0.75 - 1;
    expect(calculateSupportDeskSla(state, beforeWarn).firstResponse.status).toBe('healthy');

    // Exactly at 75% of firstResponse
    const atWarn = BASE_TIME + firstMin * MINUTE * 0.75;
    expect(calculateSupportDeskSla(state, atWarn).firstResponse.status).toBe('warning');

    // Just before 100% of firstResponse
    const beforeBreach = BASE_TIME + firstMin * MINUTE - 1;
    expect(calculateSupportDeskSla(state, beforeBreach).firstResponse.status).toBe('warning');

    // Exactly at 100% of firstResponse
    const atBreach = BASE_TIME + firstMin * MINUTE;
    expect(calculateSupportDeskSla(state, atBreach).firstResponse.status).toBe('breached');

    // Resolution at 75% and 100%
    expect(calculateSupportDeskSla(state, BASE_TIME + resMin * MINUTE * 0.75 - 1).resolution.status).toBe('healthy');
    expect(calculateSupportDeskSla(state, BASE_TIME + resMin * MINUTE * 0.75).resolution.status).toBe('warning');
    expect(calculateSupportDeskSla(state, BASE_TIME + resMin * MINUTE).resolution.status).toBe('breached');
  });

  // 11: Qualifying stopped clocks: < deadline is met, >= deadline is breached
  it('11. marks firstResponse and resolution met strictly before deadline and breached at/after deadline', () => {
    const baseState = initializeSupportDeskTicketState(
      makeTicket({ priority: 'medium' }),
      makePolicy(),
      BASE_TIME,
    )!;

    const metState: SupportDeskTicketState = {
      ...baseState,
      firstHumanReplyAt: new Date(BASE_TIME + 60 * MINUTE - 1).toISOString(),
      resolvedAt: new Date(BASE_TIME + 1440 * MINUTE - 1).toISOString(),
      terminal: true,
    };
    const metSla = calculateSupportDeskSla(metState, BASE_TIME + 5000 * MINUTE);
    expect(metSla.firstResponse.status).toBe('met');
    expect(metSla.resolution.status).toBe('met');

    const breachedAtExactDeadline: SupportDeskTicketState = {
      ...baseState,
      firstHumanReplyAt: new Date(BASE_TIME + 60 * MINUTE).toISOString(),
      resolvedAt: new Date(BASE_TIME + 1440 * MINUTE).toISOString(),
      terminal: true,
    };
    const breachedSla = calculateSupportDeskSla(breachedAtExactDeadline, BASE_TIME + 5000 * MINUTE);
    expect(breachedSla.firstResponse.status).toBe('breached');
    expect(breachedSla.resolution.status).toBe('breached');
  });

  // 12: Ticket without conversationId -> firstResponse not_observed, never met/0ms
  it('12. reports firstResponse as not_observed for tickets without a linked conversation', () => {
    const state = initializeSupportDeskTicketState(
      makeTicket({ conversationId: undefined, priority: 'medium' }),
      makePolicy(),
      BASE_TIME,
    )!;
    const sla = calculateSupportDeskSla(state, BASE_TIME + 10 * MINUTE);
    expect(sla.tracked).toBe(true);
    expect(sla.firstResponse.status).toBe('not_observed');
    expect(sla.firstResponse.deadlineAt).toBe(new Date(BASE_TIME + 60 * MINUTE).toISOString());
    expect(sla.firstResponse.elapsedMs).toBe(10 * MINUTE);
    expect(sla.resolution.status).toBe('healthy');
  });

  // 13: Terminal cycle without human reply -> firstResponse not_observed
  it('13. reports firstResponse as not_observed when ticket resolves without any human reply', () => {
    const state = initializeSupportDeskTicketState(
      makeTicket({ priority: 'high' }),
      makePolicy(),
      BASE_TIME,
    )!;
    const resolved = transitionSupportDeskTicketState(
      { priority: 'high', status: 'open' },
      { priority: 'high', status: 'resolved' },
      state,
      BASE_TIME + 20 * MINUTE,
      { statusExplicitlySet: true },
    );
    const sla = calculateSupportDeskSla(resolved, BASE_TIME + 30 * MINUTE);
    expect(sla.firstResponse.status).toBe('not_observed');
    expect(sla.firstResponse.elapsedMs).toBe(20 * MINUTE);
    expect(sla.resolution.status).toBe('met');
  });

  // 14: Priority update on active cycle recomputes from SAME cycleOpenedAt
  it('14. recomputes deadlines from same cycleOpenedAt on priority change without resetting clock', () => {
    const state = initializeSupportDeskTicketState(
      makeTicket({ priority: 'low' }),
      makePolicy(),
      BASE_TIME,
    )!;
    const updated = transitionSupportDeskTicketState(
      { priority: 'low', status: 'open' },
      { priority: 'urgent', status: 'open' },
      state,
      BASE_TIME + 10 * MINUTE,
      { statusExplicitlySet: false },
    );
    expect(updated.cycle).toBe(1);
    expect(updated.cycleOpenedAt).toBe(state.cycleOpenedAt);
    expect(updated.priority).toBe('urgent');
    // At +10m, urgent 5m firstResponse is already breached
    const sla = calculateSupportDeskSla(updated, BASE_TIME + 10 * MINUTE);
    expect(sla.firstResponse.status).toBe('breached');
    expect(sla.firstResponse.deadlineAt).toBe(new Date(BASE_TIME + 5 * MINUTE).toISOString());
  });

  // 15: Priority-only patch on terminal ticket does NOT reopen
  it('15. does not reopen a terminal ticket on a priority-only patch', () => {
    const state: SupportDeskTicketState = {
      ...initializeSupportDeskTicketState(makeTicket({ priority: 'medium' }), makePolicy(), BASE_TIME)!,
      terminal: true,
      resolvedAt: new Date(BASE_TIME + 30 * MINUTE).toISOString(),
    };
    const after = transitionSupportDeskTicketState(
      { priority: 'medium', status: 'resolved' },
      { priority: 'urgent', status: 'resolved' },
      state,
      BASE_TIME + 50 * MINUTE,
      { statusExplicitlySet: false, currentPolicy: makePolicy({ version: 9 }) },
    );
    expect(after.cycle).toBe(1);
    expect(after.terminal).toBe(true);
    expect(after.resolvedAt).toBe(state.resolvedAt);
  });

  // 16: Explicit reopen when policy is enabled vs disabled (paused)
  it('16. increments cycle and resets clocks on explicit reopen; pauses when policy is disabled', () => {
    const terminalState: SupportDeskTicketState = {
      ...initializeSupportDeskTicketState(makeTicket({ priority: 'medium' }), makePolicy(), BASE_TIME)!,
      terminal: true,
      firstHumanReplyAt: new Date(BASE_TIME + 10 * MINUTE).toISOString(),
      resolvedAt: new Date(BASE_TIME + 20 * MINUTE).toISOString(),
    };

    const reopenTime = BASE_TIME + 100 * MINUTE;
    const reopenedEnabled = transitionSupportDeskTicketState(
      { priority: 'medium', status: 'resolved' },
      { priority: 'high', status: 'open' },
      terminalState,
      reopenTime,
      { statusExplicitlySet: true, currentPolicy: makePolicy({ version: 8, enabled: true }) },
    );
    expect(reopenedEnabled.cycle).toBe(2);
    expect(reopenedEnabled.cycleOpenedAt).toBe(new Date(reopenTime).toISOString());
    expect(reopenedEnabled.tracking).toBe('tracked');
    expect(reopenedEnabled.policyVersion).toBe(8);
    expect(reopenedEnabled.firstHumanReplyAt).toBeNull();
    expect(reopenedEnabled.resolvedAt).toBeNull();
    expect(reopenedEnabled.terminal).toBe(false);

    const reopenedDisabled = transitionSupportDeskTicketState(
      { priority: 'medium', status: 'resolved' },
      { priority: 'high', status: 'in_progress' },
      terminalState,
      reopenTime,
      { statusExplicitlySet: true, currentPolicy: makePolicy({ version: 9, enabled: false }) },
    );
    expect(reopenedDisabled.cycle).toBe(2);
    expect(reopenedDisabled.tracking).toBe('paused');
    expect(reopenedDisabled.firstHumanReplyAt).toBeNull();
    expect(reopenedDisabled.resolvedAt).toBeNull();
    expect(reopenedDisabled.terminal).toBe(false);

    const pausedSla = calculateSupportDeskSla(reopenedDisabled, reopenTime + 10 * MINUTE);
    expect(pausedSla.tracked).toBe(false);
    expect(pausedSla.firstResponse).toEqual({ status: 'not_observed', deadlineAt: null, elapsedMs: null });
    expect(pausedSla.resolution).toEqual({ status: 'not_observed', deadlineAt: null, elapsedMs: null });
  });
});
