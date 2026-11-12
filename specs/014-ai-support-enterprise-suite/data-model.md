# Data Model: AI Support Enterprise Suite (`014-ai-support-enterprise-suite`)

## 1. Role-Scoped Knowledge Base & PII Masking (`server/src/custom/x-gateway/support-knowledge.ts` — Agent 1)

### 1.1 Knowledge Document & Search Types
```ts
export interface SupportKnowledgeDoc {
  id: string;                 // e.g. 'kb_' + randomUUID()
  tenantId: string;
  title: string;
  category: string;           // e.g. 'faq' | 'policy' | 'troubleshooting' | 'internal_sop'
  content: string;            // Markdown / plain text content
  tags: string[];
  allowedRoles: string[];     // Roles allowed to access this doc; ['*'] allows all roles
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportKnowledgeChunkMatch {
  docId: string;
  title: string;
  category: string;
  tags: string[];
  allowedRoles: string[];
  snippet: string;            // Matched excerpt (<= 500 chars)
  score: number;              // Relevance score (> 0)
}
```

### 1.2 PII & Sensitive Data Masking Types
```ts
export type SupportBuiltinMaskDetector = 'email' | 'phone' | 'credit_card' | 'api_key';

export interface SupportCustomMaskRule {
  id: string;
  name: string;
  pattern: string;            // RegExp pattern string
  replacement: string;        // e.g. '[REDACTED_ID]'
  enabled: boolean;
}

export interface SupportMaskingPolicy {
  tenantId: string;
  enabled: boolean;
  builtinDetectors: SupportBuiltinMaskDetector[]; // Default: ['email', 'phone', 'credit_card', 'api_key']
  unmaskedRoles: string[];                        // Roles exempt from masking, e.g. ['admin']
  customRules: SupportCustomMaskRule[];
  updatedAt: string;
}

export interface SupportMaskResult<T = unknown> {
  masked: T;
  redactionCount: number;
  appliedRules: string[];     // Names of detectors/rules that triggered
  bypassedByRole: boolean;
}
```

### 1.3 Exported Functions from `support-knowledge.ts`
- `listSupportKnowledgeDocs(tenantId: string): SupportKnowledgeDoc[]`
- `getSupportKnowledgeDocById(tenantId: string, docId: string): SupportKnowledgeDoc | undefined`
- `upsertSupportKnowledgeDoc(tenantId: string, input: Partial<SupportKnowledgeDoc> & { title: string; content: string }): SupportKnowledgeDoc`
- `deleteSupportKnowledgeDoc(tenantId: string, docId: string): boolean`
- `seedDefaultSupportKnowledgeDocs(tenantId: string): SupportKnowledgeDoc[]`
- `searchSupportKnowledge(tenantId: string, query: string, userRole: string, options?: { topK?: number; category?: string }): SupportKnowledgeChunkMatch[]`
- `buildSupportKnowledgeContextPrompt(matches: SupportKnowledgeChunkMatch[]): string`
- `getSupportMaskingPolicy(tenantId: string): SupportMaskingPolicy`
- `updateSupportMaskingPolicy(tenantId: string, patch: Partial<Omit<SupportMaskingPolicy, 'tenantId' | 'updatedAt'>>): SupportMaskingPolicy`
- `maskSupportSensitiveText(tenantId: string, text: string, userRole: string): SupportMaskResult<string>`
- `maskSupportSensitiveData<T>(tenantId: string, data: T, userRole: string): SupportMaskResult<T>`

---

## 2. Conversation Threads, Escalation Tickets & Approval-Gated Actions (`server/src/custom/x-gateway/support-workflows.ts` — Agent 2)

### 2.1 Persistent Conversation Threads
```ts
export type SupportMessageSenderType = 'customer' | 'ai_assistant' | 'human_agent' | 'system';

export interface SupportConversationMessage {
  id: string;                 // 'msg_' + randomUUID()
  senderType: SupportMessageSenderType;
  senderId: string;           // userId or 'ai' or staff username
  senderName?: string;
  senderRole?: string;
  content: string;
  toolTrace?: Array<{
    toolName: string;
    status: string;
    durationMs?: number;
  }>;
  createdAt: string;
}

export type SupportConversationStatus = 'active' | 'escalated' | 'resolved' | 'closed';

export interface SupportConversation {
  id: string;                 // 'conv_' + randomUUID()
  tenantId: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  userRole: string;
  subject: string;
  status: SupportConversationStatus;
  messages: SupportConversationMessage[];
  assignedAgent?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 2.2 Human Escalation Tickets
```ts
export type SupportTicketPriority = 'low' | 'medium' | 'high' | 'urgent';
export type SupportTicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';

export interface SupportEscalationTicket {
  id: string;                 // 'tkt_' + randomUUID()
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
```

### 2.3 Human-in-the-Loop Pending Action Approvals
```ts
export type SupportPendingActionStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface SupportPendingAction {
  id: string;                 // 'act_' + randomUUID()
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  toolName: string;           // e.g. 'issue_refund', 'cancel_order', 'update_shipping'
  actionSummary: string;      // Human-readable description
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
  deflectionRatePct: number;  // Percentage of conversations NOT escalated to human
  totalTickets: number;
  openTickets: number;
  totalPendingActions: number;
  awaitingApprovalActions: number;
  approvedActions: number;
  rejectedActions: number;
  byRole: Record<string, number>;
}
```

### 2.4 Exported Functions from `support-workflows.ts`
- `listSupportConversations(tenantId: string, filter?: { userId?: string; status?: SupportConversationStatus }): SupportConversation[]`
- `getSupportConversationForUser(tenantId: string, conversationId: string, requester: { userId: string; role: string }): SupportConversation` (Throws error with `statusCode = 403` if `requester.userId !== conv.userId` and `requester.role` is not in `['admin', 'staff']`; `404` if not found)
- `createOrAppendSupportConversation(tenantId: string, input: { conversationId?: string; userId: string; userName?: string; userEmail?: string; userRole: string; subject?: string; message: Omit<SupportConversationMessage, 'id' | 'createdAt'> }): SupportConversation`
- `addHumanAgentReply(tenantId: string, conversationId: string, input: { agentName: string; content: string; resolveConversation?: boolean }): SupportConversation`
- `listSupportEscalationTickets(tenantId: string, filter?: { userId?: string; status?: SupportTicketStatus; priority?: SupportTicketPriority }): SupportEscalationTicket[]`
- `createSupportEscalationTicket(tenantId: string, input: { conversationId?: string; userId: string; userName?: string; userRole: string; subject: string; reason: string; priority?: SupportTicketPriority }): SupportEscalationTicket`
- `updateSupportEscalationTicket(tenantId: string, ticketId: string, patch: Partial<Pick<SupportEscalationTicket, 'status' | 'priority' | 'assignedTo' | 'resolutionNotes'>>): SupportEscalationTicket | null`
- `listSupportPendingActions(tenantId: string, filter?: { userId?: string; status?: SupportPendingActionStatus }): SupportPendingAction[]`
- `proposeSupportPendingAction(tenantId: string, input: { conversationId?: string; userId: string; userName?: string; userRole: string; toolName: string; actionSummary: string; payload: Record<string, unknown> }): SupportPendingAction`
- `reviewSupportPendingAction(tenantId: string, actionId: string, review: { decision: 'approved' | 'rejected'; reviewedBy: string; reviewNote?: string; executionResult?: unknown }): SupportPendingAction | null`
- `getSupportAnalyticsSummary(tenantId: string): SupportAnalyticsSummary`
