/**
 * Shared DTOs and persona presets for Service Desk Studio Live End-User Widget Testing (Spec 023).
 */

export type SupportLiveTestViewMode = 'design' | 'live';

export type SupportLiveTestPersonaMode = 'guest' | 'authenticated';

export interface SupportLiveTestPersonaInput {
  mode: SupportLiveTestPersonaMode;
  userId?: string;
  role?: string;
  name?: string;
  email?: string;
  permissions?: string[];
  ttlSeconds?: number;
}

export interface SupportLiveTestPersonaSessionResponse {
  ok: true;
  mode: SupportLiveTestPersonaMode;
  contextToken: string | null;
  expiresIn?: number;
  allowGuest: boolean;
  userContext?: {
    tenantId: number;
    userId: string;
    role: string;
    name?: string;
    email?: string;
    permissions: string[];
    verified: boolean;
  };
}

export type SupportLiveTestOriginCheckReason =
  | 'unrestricted'
  | 'wildcard'
  | 'matched'
  | 'not_in_allowlist'
  | 'invalid_origin';

export interface SupportLiveTestOriginCheckResponse {
  ok: true;
  origin: string;
  allowed: boolean;
  reason: SupportLiveTestOriginCheckReason;
  allowedOrigins: string[];
}

export interface SupportLiveTestTurnDiagnostic {
  timestamp: string;
  endpoint: string;
  status: number;
  ok: boolean;
  conversationId?: string;
  modelUsed?: string | null;
  replySource?: string;
  effectiveRole?: string;
  effectiveUserId?: string;
  allowedTools?: string[];
  toolTrace?: Array<{
    name: string;
    kind: string;
    error?: string;
    rewrittenSql?: string;
  }>;
  evidenceStatus?: string;
  evidenceReason?: string;
  citationsCount?: number;
  pendingActions?: string[];
  outputAction?: string;
  outputReasons?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export interface SupportLiveTestPersonaPreset {
  id: 'guest' | 'customer_alice' | 'customer_bob' | 'staff' | 'admin';
  mode: SupportLiveTestPersonaMode;
  userId: string;
  role: string;
  name: string;
  email?: string;
  permissions: string[];
}

export const SUPPORT_LIVE_TEST_PERSONA_PRESETS: readonly SupportLiveTestPersonaPreset[] = [
  {
    id: 'guest',
    mode: 'guest',
    userId: '',
    role: 'guest',
    name: 'Guest Visitor',
    permissions: [],
  },
  {
    id: 'customer_alice',
    mode: 'authenticated',
    userId: 'cust_101',
    role: 'customer',
    name: 'Alice Nguyen',
    email: 'alice@example.com',
    permissions: [],
  },
  {
    id: 'customer_bob',
    mode: 'authenticated',
    userId: 'cust_102',
    role: 'customer',
    name: 'Bob Tran',
    email: 'bob@example.com',
    permissions: [],
  },
  {
    id: 'staff',
    mode: 'authenticated',
    userId: 'staff_01',
    role: 'staff',
    name: 'Support Staff',
    email: 'staff@example.com',
    permissions: [],
  },
  {
    id: 'admin',
    mode: 'authenticated',
    userId: 'admin_01',
    role: 'admin',
    name: 'Tenant Admin',
    email: 'admin@example.com',
    permissions: [],
  },
] as const;

export interface SupportLiveTestSandboxStats {
  ok: true;
  tenantId: number;
  conversationsCount: number;
  ticketsCount: number;
  pendingActionsCount: number;
  csatRatingsCount: number;
  totalCount: number;
}

export interface SupportLiveTestSandboxCleanupResponse {
  ok: true;
  tenantId: number;
  deleted: {
    conversations: number;
    tickets: number;
    pendingActions: number;
    csatRatings: number;
  };
}

export interface SupportLiveTestPendingActionItem {
  id: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  toolName: string;
  actionSummary: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  createdAt: string;
  isLiveTest?: boolean;
}

export interface SupportLiveTestPendingActionsListResponse {
  ok: true;
  actions: SupportLiveTestPendingActionItem[];
}

export interface SupportLiveTestActionReviewResponse {
  ok: true;
  action: SupportLiveTestPendingActionItem & {
    reviewedBy?: string;
    reviewNote?: string;
    reviewedAt?: string;
    executionStatus?: string;
    executionResult?: unknown;
  };
}
