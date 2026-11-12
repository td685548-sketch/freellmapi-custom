import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  listSupportConversations,
  getSupportConversationForUser,
  createOrAppendSupportConversation,
  addHumanAgentReply,
  listSupportEscalationTickets,
  createSupportEscalationTicket,
  updateSupportEscalationTicket,
  listSupportPendingActions,
  proposeSupportPendingAction,
  reviewSupportPendingAction,
  getSupportAnalyticsSummary,
  SupportWorkflowError,
} from '../../custom/x-gateway/support-workflows.js';

const TENANT_A = 'tenant_alpha';
const TENANT_B = 'tenant_beta';

describe('Support Workflows: Conversations, Escalation Tickets, Action Approvals & Analytics', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'x_gateway_support_%'").run();
  });

  // -------------------------------------------------------------------------
  // 1. Conversation Threads
  // -------------------------------------------------------------------------
  describe('Conversation Threads', () => {
    it('creates a new conversation when conversationId is omitted', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userName: 'Alice',
        userEmail: 'alice@example.com',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          senderName: 'Alice',
          senderRole: 'customer',
          content: 'I need help with my recent order delivery status.',
        },
      });

      expect(conv.id).toMatch(/^conv_/);
      expect(conv.tenantId).toBe(TENANT_A);
      expect(conv.userId).toBe('cust_101');
      expect(conv.userName).toBe('Alice');
      expect(conv.status).toBe('active');
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].id).toMatch(/^msg_/);
      expect(conv.messages[0].senderType).toBe('customer');
      expect(conv.messages[0].content).toContain('delivery status');
    });

    it('creates a new conversation with explicit subject when provided', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        subject: 'Custom Subject Title',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'Hello!',
        },
      });

      expect(conv.subject).toBe('Custom Subject Title');
    });

    it('creates a new conversation if conversationId is provided but not found', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        conversationId: 'nonexistent_conv_id',
        userId: 'cust_101',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'Starting new thread',
        },
      });

      expect(conv.id).toMatch(/^conv_/);
      expect(conv.messages).toHaveLength(1);
    });

    it('appends message to existing conversation when called by the owner', () => {
      const initial = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'First message',
        },
      });

      const updated = createOrAppendSupportConversation(TENANT_A, {
        conversationId: initial.id,
        userId: 'cust_101',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'Second message',
        },
      });

      expect(updated.id).toBe(initial.id);
      expect(updated.messages).toHaveLength(2);
      expect(updated.messages[1].content).toBe('Second message');
    });

    it('allows staff or admin to append message to any conversation', () => {
      const initial = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'Need staff help',
        },
      });

      const staffReply = createOrAppendSupportConversation(TENANT_A, {
        conversationId: initial.id,
        userId: 'staff_99',
        userRole: 'staff',
        message: {
          senderType: 'human_agent',
          senderId: 'staff_99',
          senderRole: 'staff',
          content: 'Staff responding',
        },
      });

      expect(staffReply.messages).toHaveLength(2);
      expect(staffReply.messages[1].senderType).toBe('human_agent');
    });

    it('CRITICAL SECURITY: throws 403 when cross-user customer tries to append message', () => {
      const initial = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: {
          senderType: 'customer',
          senderId: 'cust_101',
          content: 'Secret customer info',
        },
      });

      expect(() =>
        createOrAppendSupportConversation(TENANT_A, {
          conversationId: initial.id,
          userId: 'cust_202',
          userRole: 'customer',
          message: {
            senderType: 'customer',
            senderId: 'cust_202',
            content: 'Intruder message',
          },
        }),
      ).toThrowError(/Forbidden/);

      try {
        createOrAppendSupportConversation(TENANT_A, {
          conversationId: initial.id,
          userId: 'cust_202',
          userRole: 'customer',
          message: {
            senderType: 'customer',
            senderId: 'cust_202',
            content: 'Intruder message',
          },
        });
      } catch (err) {
        expect((err as SupportWorkflowError).statusCode).toBe(403);
      }
    });

    it('retrieves conversation for the owning user', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Hello' },
      });

      const retrieved = getSupportConversationForUser(TENANT_A, conv.id, {
        userId: 'cust_101',
        role: 'customer',
      });
      expect(retrieved.id).toBe(conv.id);
      expect(retrieved.userId).toBe('cust_101');
    });

    it('retrieves conversation for staff or admin requester', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Hello' },
      });

      const staffView = getSupportConversationForUser(TENANT_A, conv.id, {
        userId: 'staff_1',
        role: 'staff',
      });
      expect(staffView.id).toBe(conv.id);

      const adminView = getSupportConversationForUser(TENANT_A, conv.id, {
        userId: 'admin_1',
        role: 'admin',
      });
      expect(adminView.id).toBe(conv.id);
    });

    it('CRITICAL SECURITY: throws 403 when another customer attempts to read conversation', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Private order #999' },
      });

      expect(() =>
        getSupportConversationForUser(TENANT_A, conv.id, {
          userId: 'cust_999',
          role: 'customer',
        }),
      ).toThrowError(/Forbidden/);

      try {
        getSupportConversationForUser(TENANT_A, conv.id, {
          userId: 'cust_999',
          role: 'customer',
        });
      } catch (err) {
        expect((err as SupportWorkflowError).statusCode).toBe(403);
      }
    });

    it('throws 404 when conversation does not exist', () => {
      expect(() =>
        getSupportConversationForUser(TENANT_A, 'nonexistent_id', {
          userId: 'cust_101',
          role: 'customer',
        }),
      ).toThrowError(/not found/i);

      try {
        getSupportConversationForUser(TENANT_A, 'nonexistent_id', {
          userId: 'cust_101',
          role: 'customer',
        });
      } catch (err) {
        expect((err as SupportWorkflowError).statusCode).toBe(404);
      }
    });

    it('lists conversations with optional userId and status filters', () => {
      createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_1',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_1', content: 'Msg 1' },
      });
      const c2 = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_2',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_2', content: 'Msg 2' },
      });
      addHumanAgentReply(TENANT_A, c2.id, { agentName: 'Bob', content: 'Done', resolveConversation: true });

      const all = listSupportConversations(TENANT_A);
      expect(all).toHaveLength(2);

      const user1Only = listSupportConversations(TENANT_A, { userId: 'cust_1' });
      expect(user1Only).toHaveLength(1);
      expect(user1Only[0].userId).toBe('cust_1');

      const resolvedOnly = listSupportConversations(TENANT_A, { status: 'resolved' });
      expect(resolvedOnly).toHaveLength(1);
      expect(resolvedOnly[0].id).toBe(c2.id);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Human Agent Hand-Off
  // -------------------------------------------------------------------------
  describe('Human Agent Hand-Off', () => {
    it('appends human agent reply with staff role and assigned agent', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Please help' },
      });

      const updated = addHumanAgentReply(TENANT_A, conv.id, {
        agentName: 'Agent Sarah',
        content: 'Hello, Sarah here! Looking into your order now.',
      });

      expect(updated.messages).toHaveLength(2);
      const agentMsg = updated.messages[1];
      expect(agentMsg.senderType).toBe('human_agent');
      expect(agentMsg.senderId).toBe('Agent Sarah');
      expect(agentMsg.senderRole).toBe('staff');
      expect(updated.assignedAgent).toBe('Agent Sarah');
      expect(updated.status).toBe('active');
    });

    it('resolves conversation when resolveConversation is true', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Please cancel' },
      });

      const resolved = addHumanAgentReply(TENANT_A, conv.id, {
        agentName: 'Agent Sarah',
        content: 'Your order has been cancelled as requested.',
        resolveConversation: true,
      });

      expect(resolved.status).toBe('resolved');
    });

    it('throws 404 when adding reply to nonexistent conversation', () => {
      expect(() =>
        addHumanAgentReply(TENANT_A, 'missing_conv', {
          agentName: 'Agent Sarah',
          content: 'Hello',
        }),
      ).toThrowError(/not found/i);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Escalation Tickets
  // -------------------------------------------------------------------------
  describe('Human Escalation Tickets', () => {
    it('creates an escalation ticket and updates linked conversation status to escalated', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'I want a manager' },
      });
      expect(conv.status).toBe('active');

      const ticket = createSupportEscalationTicket(TENANT_A, {
        conversationId: conv.id,
        userId: 'cust_101',
        userName: 'Alice',
        userRole: 'customer',
        subject: 'Manager escalation requested',
        reason: 'Customer requested human supervisor regarding shipment delay',
        priority: 'high',
      });

      expect(ticket.id).toMatch(/^tkt_/);
      expect(ticket.tenantId).toBe(TENANT_A);
      expect(ticket.conversationId).toBe(conv.id);
      expect(ticket.priority).toBe('high');
      expect(ticket.status).toBe('open');

      const updatedConv = getSupportConversationForUser(TENANT_A, conv.id, {
        userId: 'cust_101',
        role: 'customer',
      });
      expect(updatedConv.status).toBe('escalated');
    });

    it('creates standalone escalation ticket with default medium priority', () => {
      const ticket = createSupportEscalationTicket(TENANT_A, {
        userId: 'cust_102',
        userRole: 'customer',
        subject: 'Hardware failure',
        reason: 'Monitor will not power on',
      });

      expect(ticket.priority).toBe('medium');
      expect(ticket.status).toBe('open');
      expect(ticket.conversationId).toBeUndefined();
    });

    it('lists escalation tickets with filters', () => {
      createSupportEscalationTicket(TENANT_A, {
        userId: 'cust_1',
        userRole: 'customer',
        subject: 'Ticket 1',
        reason: 'Reason 1',
        priority: 'low',
      });
      createSupportEscalationTicket(TENANT_A, {
        userId: 'cust_2',
        userRole: 'customer',
        subject: 'Ticket 2',
        reason: 'Reason 2',
        priority: 'urgent',
      });

      const all = listSupportEscalationTickets(TENANT_A);
      expect(all).toHaveLength(2);

      const urgentOnly = listSupportEscalationTickets(TENANT_A, { priority: 'urgent' });
      expect(urgentOnly).toHaveLength(1);
      expect(urgentOnly[0].userId).toBe('cust_2');

      const user1Only = listSupportEscalationTickets(TENANT_A, { userId: 'cust_1' });
      expect(user1Only).toHaveLength(1);
    });

    it('updates ticket fields (priority, assignedTo, resolutionNotes)', () => {
      const ticket = createSupportEscalationTicket(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        subject: 'Test update',
        reason: 'Reason',
      });

      const updated = updateSupportEscalationTicket(TENANT_A, ticket.id, {
        priority: 'urgent',
        assignedTo: 'senior_agent_john',
        resolutionNotes: 'Customer contacted via phone',
        status: 'in_progress',
      });

      expect(updated).not.toBeNull();
      expect(updated?.priority).toBe('urgent');
      expect(updated?.assignedTo).toBe('senior_agent_john');
      expect(updated?.resolutionNotes).toBe('Customer contacted via phone');
      expect(updated?.status).toBe('in_progress');
    });

    it('resolving a ticket linked to conversation also resolves the conversation', () => {
      const conv = createOrAppendSupportConversation(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'cust_101', content: 'Escalate me' },
      });

      const ticket = createSupportEscalationTicket(TENANT_A, {
        conversationId: conv.id,
        userId: 'cust_101',
        userRole: 'customer',
        subject: 'Escalate',
        reason: 'Reason',
      });

      expect(
        getSupportConversationForUser(TENANT_A, conv.id, { userId: 'cust_101', role: 'customer' })
          .status,
      ).toBe('escalated');

      updateSupportEscalationTicket(TENANT_A, ticket.id, {
        status: 'resolved',
        resolutionNotes: 'Refund processed manually',
      });

      const resolvedConv = getSupportConversationForUser(TENANT_A, conv.id, {
        userId: 'cust_101',
        role: 'customer',
      });
      expect(resolvedConv.status).toBe('resolved');
    });

    it('returns null when updating nonexistent ticket', () => {
      const result = updateSupportEscalationTicket(TENANT_A, 'missing_ticket_id', {
        status: 'closed',
      });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 4. Pending Action Approvals
  // -------------------------------------------------------------------------
  describe('Pending Action Approvals', () => {
    it('proposes a pending action with status pending', () => {
      const action = proposeSupportPendingAction(TENANT_A, {
        userId: 'cust_101',
        userName: 'Alice',
        userRole: 'customer',
        toolName: 'issue_refund',
        actionSummary: 'Refund $89.50 for damaged keyboard order #1002',
        payload: { orderId: 1002, amount: 89.5, reason: 'damaged_in_transit' },
      });

      expect(action.id).toMatch(/^act_/);
      expect(action.tenantId).toBe(TENANT_A);
      expect(action.status).toBe('pending');
      expect(action.toolName).toBe('issue_refund');
      expect(action.payload).toEqual({ orderId: 1002, amount: 89.5, reason: 'damaged_in_transit' });
      expect(action.reviewedBy).toBeUndefined();
    });

    it('reviews pending action with approved decision and executionResult', () => {
      const action = proposeSupportPendingAction(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        toolName: 'cancel_order',
        actionSummary: 'Cancel order #1003',
        payload: { orderId: 1003 },
      });

      const reviewed = reviewSupportPendingAction(TENANT_A, action.id, {
        decision: 'approved',
        reviewedBy: 'finance_manager',
        reviewNote: 'Approved as per 30-day return policy',
        executionResult: { success: true, transactionId: 'tx_98765' },
      });

      expect(reviewed).not.toBeNull();
      expect(reviewed?.status).toBe('approved');
      expect(reviewed?.reviewedBy).toBe('finance_manager');
      expect(reviewed?.reviewNote).toBe('Approved as per 30-day return policy');
      expect(reviewed?.executionResult).toEqual({ success: true, transactionId: 'tx_98765' });
      expect(reviewed?.reviewedAt).toBeDefined();
    });

    it('reviews pending action with rejected decision', () => {
      const action = proposeSupportPendingAction(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        toolName: 'issue_refund',
        actionSummary: 'Refund $999 for out of warranty item',
        payload: { orderId: 99 },
      });

      const reviewed = reviewSupportPendingAction(TENANT_A, action.id, {
        decision: 'rejected',
        reviewedBy: 'supervisor_mary',
        reviewNote: 'Item purchase date exceeds 90 days',
      });

      expect(reviewed?.status).toBe('rejected');
      expect(reviewed?.reviewedBy).toBe('supervisor_mary');
      expect(reviewed?.reviewedAt).toBeDefined();
    });

    it('returns null when reviewing nonexistent action', () => {
      const result = reviewSupportPendingAction(TENANT_A, 'missing_action_id', {
        decision: 'approved',
        reviewedBy: 'admin',
      });
      expect(result).toBeNull();
    });

    it('lists pending actions with filters', () => {
      proposeSupportPendingAction(TENANT_A, {
        userId: 'cust_1',
        userRole: 'customer',
        toolName: 'action_1',
        actionSummary: 'Act 1',
        payload: {},
      });
      const a2 = proposeSupportPendingAction(TENANT_A, {
        userId: 'cust_2',
        userRole: 'customer',
        toolName: 'action_2',
        actionSummary: 'Act 2',
        payload: {},
      });
      reviewSupportPendingAction(TENANT_A, a2.id, { decision: 'approved', reviewedBy: 'admin' });

      const all = listSupportPendingActions(TENANT_A);
      expect(all).toHaveLength(2);

      const pendingOnly = listSupportPendingActions(TENANT_A, { status: 'pending' });
      expect(pendingOnly).toHaveLength(1);
      expect(pendingOnly[0].toolName).toBe('action_1');

      const approvedOnly = listSupportPendingActions(TENANT_A, { status: 'approved' });
      expect(approvedOnly).toHaveLength(1);
      expect(approvedOnly[0].toolName).toBe('action_2');
    });
  });

  // -------------------------------------------------------------------------
  // 5. SLA & Analytics
  // -------------------------------------------------------------------------
  describe('SLA & Analytics Summary', () => {
    it('returns 100% deflection rate when there are zero conversations', () => {
      const analytics = getSupportAnalyticsSummary(TENANT_A);
      expect(analytics.totalConversations).toBe(0);
      expect(analytics.deflectionRatePct).toBe(100);
      expect(analytics.totalTickets).toBe(0);
      expect(analytics.totalPendingActions).toBe(0);
      expect(analytics.byRole).toEqual({});
    });

    it('computes accurate deflection rate and metrics across conversations, tickets and actions', () => {
      // 4 conversations: 3 resolved without escalation, 1 escalated
      const c1 = createOrAppendSupportConversation(TENANT_A, {
        userId: 'u1',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'u1', content: 'Q1' },
      });
      addHumanAgentReply(TENANT_A, c1.id, { agentName: 'Bot', content: 'A1', resolveConversation: true });

      const c2 = createOrAppendSupportConversation(TENANT_A, {
        userId: 'u2',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'u2', content: 'Q2' },
      });
      addHumanAgentReply(TENANT_A, c2.id, { agentName: 'Bot', content: 'A2', resolveConversation: true });

      const c3 = createOrAppendSupportConversation(TENANT_A, {
        userId: 'u3',
        userRole: 'guest',
        message: { senderType: 'customer', senderId: 'u3', content: 'Q3' },
      });
      addHumanAgentReply(TENANT_A, c3.id, { agentName: 'Bot', content: 'A3', resolveConversation: true });

      const c4 = createOrAppendSupportConversation(TENANT_A, {
        userId: 'u4',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'u4', content: 'Escalate' },
      });
      createSupportEscalationTicket(TENANT_A, {
        conversationId: c4.id,
        userId: 'u4',
        userRole: 'customer',
        subject: 'Escalated issue',
        reason: 'Complex problem',
      });

      // Actions
      proposeSupportPendingAction(TENANT_A, {
        userId: 'u1',
        userRole: 'customer',
        toolName: 'refund',
        actionSummary: 'Refund',
        payload: {},
      });
      const a2 = proposeSupportPendingAction(TENANT_A, {
        userId: 'u2',
        userRole: 'customer',
        toolName: 'cancel',
        actionSummary: 'Cancel',
        payload: {},
      });
      reviewSupportPendingAction(TENANT_A, a2.id, { decision: 'approved', reviewedBy: 'admin' });

      const analytics = getSupportAnalyticsSummary(TENANT_A);

      expect(analytics.totalConversations).toBe(4);
      expect(analytics.escalatedConversations).toBe(1);
      expect(analytics.resolvedConversations).toBe(3);
      // Deflection rate: (4 - 1) / 4 = 75%
      expect(analytics.deflectionRatePct).toBe(75);
      expect(analytics.totalTickets).toBe(1);
      expect(analytics.openTickets).toBe(1);
      expect(analytics.totalPendingActions).toBe(2);
      expect(analytics.awaitingApprovalActions).toBe(1);
      expect(analytics.approvedActions).toBe(1);
      expect(analytics.rejectedActions).toBe(0);
      expect(analytics.byRole).toEqual({
        customer: 3,
        guest: 1,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 6. Multi-Tenant Isolation
  // -------------------------------------------------------------------------
  describe('Multi-Tenant Isolation', () => {
    it('guarantees complete isolation between different tenants', () => {
      createOrAppendSupportConversation(TENANT_A, {
        userId: 'user_a',
        userRole: 'customer',
        message: { senderType: 'customer', senderId: 'user_a', content: 'Tenant A msg' },
      });
      createSupportEscalationTicket(TENANT_A, {
        userId: 'user_a',
        userRole: 'customer',
        subject: 'Ticket A',
        reason: 'Reason A',
      });
      proposeSupportPendingAction(TENANT_A, {
        userId: 'user_a',
        userRole: 'customer',
        toolName: 'tool_a',
        actionSummary: 'Action A',
        payload: {},
      });

      expect(listSupportConversations(TENANT_A)).toHaveLength(1);
      expect(listSupportEscalationTickets(TENANT_A)).toHaveLength(1);
      expect(listSupportPendingActions(TENANT_A)).toHaveLength(1);

      expect(listSupportConversations(TENANT_B)).toHaveLength(0);
      expect(listSupportEscalationTickets(TENANT_B)).toHaveLength(0);
      expect(listSupportPendingActions(TENANT_B)).toHaveLength(0);

      const summaryB = getSupportAnalyticsSummary(TENANT_B);
      expect(summaryB.totalConversations).toBe(0);
      expect(summaryB.totalTickets).toBe(0);
      expect(summaryB.totalPendingActions).toBe(0);
    });
  });
});
