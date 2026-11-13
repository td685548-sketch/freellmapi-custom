import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { decrypt } from '../../lib/crypto.js';
import { createSupportTenant } from '../../custom/x-gateway/support-store.js';
import {
  addHumanAgentReply,
  createOrAppendSupportConversation,
  createSupportEscalationTicket,
  listSupportEscalationTickets,
  updateSupportEscalationTicket,
} from '../../custom/x-gateway/support-workflows.js';
import {
  getSupportDeskTicketState,
  updateSupportDeskSlaPolicy,
} from '../../custom/x-gateway/support-service-desk-store.js';
import * as deskStore from '../../custom/x-gateway/support-service-desk-store.js';
import { calculateSupportDeskSla } from '../../custom/x-gateway/support-sla-routing.js';

describe('Support Service Desk Lifecycle & Rollback (Spec 019)', () => {
  let tenantId: number;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    tenantId = createSupportTenant({ name: 'Lifecycle Tenant', defaultModel: 'test-model' }).tenant.id;
  });

  function enableSla(overrides?: Parameters<typeof updateSupportDeskSlaPolicy>[1]) {
    return updateSupportDeskSlaPolicy(
      tenantId,
      {
        enabled: true,
        routingRules: [
          { id: 'r_bill', department: 'billing', keywords: ['invoice', 'hóa đơn'] },
          { id: 'r_tech', department: 'technical', keywords: ['crash', 'timeout'] },
          { id: 'r_ret', department: 'returns', keywords: ['refund'] },
        ],
        ...overrides,
      },
      1,
    );
  }

  it('1. keeps SLA off by default and no-ops for legacy non-numeric tenant fixtures', () => {
    const tkt = createSupportEscalationTicket(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Invoice issue',
      reason: 'Need help',
      priority: 'high',
    });
    expect(getSupportDeskTicketState(tenantId, tkt.id)).toBeNull();

    const legacyTkt = createSupportEscalationTicket('legacy_string_tenant', {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Legacy',
      reason: 'Legacy test',
    });
    expect(legacyTkt.id).toMatch(/^tkt_/);
  });

  it('2. atomically creates SLA state with snapshotted targets and deterministic routing on ticket creation', () => {
    const policy = enableSla({
      targets: {
        urgent: { firstResponseMinutes: 5, resolutionMinutes: 60 },
        high: { firstResponseMinutes: 10, resolutionMinutes: 120 },
        medium: { firstResponseMinutes: 30, resolutionMinutes: 600 },
        low: { firstResponseMinutes: 120, resolutionMinutes: 2400 },
      },
    });

    const conv = createOrAppendSupportConversation(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'u1', content: 'My HOA DON is wrong' },
    });

    const tkt = createSupportEscalationTicket(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      subject: 'Sai hoa don',
      reason: 'Charged twice',
      priority: 'high',
    });

    const state = getSupportDeskTicketState(tenantId, tkt.id);
    expect(state).not.toBeNull();
    expect(state!.policyVersion).toBe(policy.version);
    expect(state!.policyTargets).toEqual(policy.targets);
    expect(state!.department).toBe('billing');
    expect(state!.routingSource).toBe('rule');
    expect(state!.cycle).toBe(1);
    expect(state!.firstHumanReplyAt).toBeNull();
    expect(state!.resolvedAt).toBeNull();
    expect(state!.terminal).toBe(false);
  });

  it('3. ignores AI/system messages and records firstHumanReplyAt once across repeated human replies', () => {
    enableSla();
    const conv = createOrAppendSupportConversation(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'u1', content: 'Help' },
    });
    const tkt = createSupportEscalationTicket(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      subject: 'General question',
      reason: 'Question',
    });

    createOrAppendSupportConversation(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'ai_assistant', senderId: 'ai', content: 'AI reply' },
    });
    expect(getSupportDeskTicketState(tenantId, tkt.id)!.firstHumanReplyAt).toBeNull();

    addHumanAgentReply(String(tenantId), conv.id, { agentName: 'Agent A', content: 'First human reply' });
    const afterFirst = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(afterFirst.firstHumanReplyAt).toBeTruthy();

    addHumanAgentReply(String(tenantId), conv.id, { agentName: 'Agent A', content: 'Second human reply' });
    const afterSecond = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(afterSecond.firstHumanReplyAt).toBe(afterFirst.firstHumanReplyAt);
  });

  it('4. finishes linked active SLA clocks on resolveConversation without fabricating ticket status', () => {
    enableSla();
    const conv = createOrAppendSupportConversation(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'u1', content: 'Timeout' },
    });
    const tkt = createSupportEscalationTicket(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      subject: 'API timeout',
      reason: '504',
    });

    addHumanAgentReply(String(tenantId), conv.id, {
      agentName: 'Agent B',
      content: 'Fixed now',
      resolveConversation: true,
    });

    const state = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(state.terminal).toBe(true);
    expect(state.resolvedAt).toBeTruthy();
    expect(state.firstHumanReplyAt).toBeTruthy();

    // Ticket workflow status remains untouched ('open')
    const [storedTkt] = listSupportEscalationTickets(String(tenantId));
    expect(storedTkt.status).toBe('open');
  });

  it('5. stops resolution clock on explicit resolved/closed update and does not overwrite resolvedAt', () => {
    enableSla();
    const tkt = createSupportEscalationTicket(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Standalone',
      reason: 'No conv',
    });

    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'resolved' });
    const firstResolved = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(firstResolved.terminal).toBe(true);
    expect(firstResolved.resolvedAt).toBeTruthy();

    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'closed' });
    const afterClosed = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(afterClosed.resolvedAt).toBe(firstResolved.resolvedAt);
  });

  it('6. updates priority without resetting cycleOpenedAt and does not reopen terminal on priority-only patch', () => {
    enableSla();
    const tkt = createSupportEscalationTicket(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Slow',
      reason: 'Slow',
      priority: 'low',
    });
    const initial = getSupportDeskTicketState(tenantId, tkt.id)!;

    updateSupportEscalationTicket(String(tenantId), tkt.id, { priority: 'urgent' });
    const upgraded = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(upgraded.priority).toBe('urgent');
    expect(upgraded.cycle).toBe(1);
    expect(upgraded.cycleOpenedAt).toBe(initial.cycleOpenedAt);

    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'resolved' });
    updateSupportEscalationTicket(String(tenantId), tkt.id, { priority: 'high' });
    const afterPriorityOnResolved = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(afterPriorityOnResolved.terminal).toBe(true);
    expect(afterPriorityOnResolved.cycle).toBe(1);
  });

  it('7. reopens terminal ticket (including after resolveConversation) and pauses if policy disabled', () => {
    const policy = enableSla();
    const conv = createOrAppendSupportConversation(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'u1', content: 'Crash' },
    });
    const tkt = createSupportEscalationTicket(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      subject: 'Crash',
      reason: 'App crash',
    });

    addHumanAgentReply(String(tenantId), conv.id, {
      agentName: 'Agent C',
      content: 'Resolved',
      resolveConversation: true,
    });
    expect(getSupportDeskTicketState(tenantId, tkt.id)!.terminal).toBe(true);

    // Explicit status=open reopens cycle 2 even though ticket.status was still 'open'
    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'open' });
    const cycle2 = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(cycle2.cycle).toBe(2);
    expect(cycle2.terminal).toBe(false);
    expect(cycle2.firstHumanReplyAt).toBeNull();
    expect(cycle2.resolvedAt).toBeNull();
    expect(cycle2.tracking).toBe('tracked');

    // Resolve and then disable policy before reopening -> cycle 3 is paused
    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'resolved' });
    updateSupportDeskSlaPolicy(tenantId, { enabled: false }, policy.version);
    updateSupportEscalationTicket(String(tenantId), tkt.id, { status: 'in_progress' });
    const cycle3 = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(cycle3.cycle).toBe(3);
    expect(cycle3.tracking).toBe('paused');
    const readCycles = () => {
      const row = getDb().prepare('SELECT meta_encrypted,meta_iv,meta_auth_tag FROM x_support_desk_ticket_state WHERE tenant_id = ? AND ticket_id = ?').get(tenantId,tkt.id) as {meta_encrypted:string;meta_iv:string;meta_auth_tag:string};
      return JSON.parse(decrypt(row.meta_encrypted,row.meta_iv,row.meta_auth_tag)).historicalCycles;
    };
    expect(readCycles()).toHaveLength(2);
    expect(readCycles()[1]).toMatchObject({cycle:2,terminal:true});
    deskStore.updateSupportDeskTicketState(tenantId,tkt.id,{department:'technical',routingSource:'manual'},cycle3.version);
    expect(readCycles()).toHaveLength(2);

    expect(calculateSupportDeskSla(cycle3, Date.now()).tracked).toBe(false);
  });

  it('8. does not retroactively rewrite existing cycle targets when SLA policy is edited', () => {
    const p1 = enableSla({
      targets: {
        urgent: { firstResponseMinutes: 5, resolutionMinutes: 60 },
        high: { firstResponseMinutes: 15, resolutionMinutes: 240 },
        medium: { firstResponseMinutes: 60, resolutionMinutes: 1440 },
        low: { firstResponseMinutes: 240, resolutionMinutes: 4320 },
      },
    });
    const tkt = createSupportEscalationTicket(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Invoice',
      reason: 'Help',
      priority: 'urgent',
    });

    updateSupportDeskSlaPolicy(
      tenantId,
      {
        targets: {
          urgent: { firstResponseMinutes: 1, resolutionMinutes: 10 },
          high: { firstResponseMinutes: 15, resolutionMinutes: 240 },
          medium: { firstResponseMinutes: 60, resolutionMinutes: 1440 },
          low: { firstResponseMinutes: 240, resolutionMinutes: 4320 },
        },
      },
      p1.version,
    );

    const state = getSupportDeskTicketState(tenantId, tkt.id)!;
    expect(state.policyVersion).toBe(p1.version);
    expect(state.policyTargets.urgent.firstResponseMinutes).toBe(5);
  });

  it('9. does not backfill old untracked tickets when SLA policy is later enabled', () => {
    const oldTkt = createSupportEscalationTicket(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      subject: 'Old',
      reason: 'Before SLA',
    });
    enableSla();
    updateSupportEscalationTicket(String(tenantId), oldTkt.id, { priority: 'urgent' });
    expect(getSupportDeskTicketState(tenantId, oldTkt.id)).toBeNull();
  });

  it('10. rolls back canonical ticket/conversation writes if SLA persistence fails in transaction', () => {
    enableSla();
    const conv = createOrAppendSupportConversation(String(tenantId), {
      userId: 'u1',
      userRole: 'customer',
      message: { senderType: 'customer', senderId: 'u1', content: 'Help' },
    });

    // Inject failure on insertSupportDeskTicketState
    vi.spyOn(deskStore, 'insertSupportDeskTicketState').mockImplementationOnce(() => {
      throw new Error('Simulated SLA insert failure');
    });
    expect(() =>
      createSupportEscalationTicket(String(tenantId), {
        conversationId: conv.id,
        userId: 'u1',
        userRole: 'customer',
        subject: 'Should rollback',
        reason: 'Failure',
      }),
    ).toThrow('Simulated SLA insert failure');
    expect(listSupportEscalationTickets(String(tenantId))).toHaveLength(0);

    // Create a valid ticket, then fail on updateSupportDeskTicketState during human reply & ticket update
    const tkt = createSupportEscalationTicket(String(tenantId), {
      conversationId: conv.id,
      userId: 'u1',
      userRole: 'customer',
      subject: 'Valid',
      reason: 'Test',
    });

    vi.spyOn(deskStore, 'updateSupportDeskTicketState').mockImplementationOnce(() => {
      throw new Error('Simulated SLA update failure');
    });
    expect(() =>
      addHumanAgentReply(String(tenantId), conv.id, {
        agentName: 'Agent',
        content: 'Should rollback reply',
      }),
    ).toThrow('Simulated SLA update failure');

    // Corrupt SLA policy row fails closed and rolls back ticket creation
    getDb()
      .prepare('UPDATE x_support_desk_sla_policies SET payload_encrypted = ? WHERE tenant_id = ?')
      .run('corrupted_ciphertext', tenantId);
    expect(() =>
      createSupportEscalationTicket(String(tenantId), {
        userId: 'u1',
        userRole: 'customer',
        subject: 'Corrupt policy',
        reason: 'Fail closed',
      }),
    ).toThrow();
    expect(listSupportEscalationTickets(String(tenantId))).toHaveLength(1);
    expect(listSupportEscalationTickets(String(tenantId))[0].id).toBe(tkt.id);
  });
});
