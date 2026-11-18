/**
 * Shared contracts and DTOs for the Cloud AI & Support Entitlement Gate.
 * Governs remote activation approval, Ed25519-signed runtime leases,
 * and cloud-delivered runtime prompt packs across server & client.
 */

export const CLOUD_ENTITLEMENT_SCOPES = [
  'ai_platform',
  'customer_ai',
  'support_copilot',
  'support_suite',
  'tenant_portal',
] as const;

export type CloudEntitlementScope = (typeof CLOUD_ENTITLEMENT_SCOPES)[number];

export type CloudEntitlementState =
  | 'active'
  | 'unactivated'
  | 'revoked'
  | 'expired'
  | 'invalid';

export interface CloudCoachRuntimePack {
  personaVi: string;
  personaEn: string;
  playbookReference: string;
  outputContract: string;
}

export interface CloudAiRuntimePack {
  version: number;
  supportCoachPack: CloudCoachRuntimePack;
  supportAgentCopilotInstruction: string;
  customerAiDirective: string;
  supportGatewayDirective: string;
  aiPlatformCapabilityGrant: string;
}

export interface CloudSignedLease {
  licenseId: string;
  label: string;
  instanceId: string;
  scopes: CloudEntitlementScope[];
  packVersion: number;
  packHash: string;
  issuedAt: string;
  expiresAt: string;
}

export interface CloudPendingRequestSummary {
  requestId: string;
  orgName: string;
  contactInfo: string;
  serverOrigin: string;
  status: 'pending' | 'approved' | 'rejected';
  decisionNote?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CloudEntitlementStatusResponse {
  active: boolean;
  state: CloudEntitlementState;
  source: 'db' | 'env' | 'none';
  canManage: boolean;
  license: {
    label: string;
    scopes: CloudEntitlementScope[];
    issuedAt: string;
    expiresAt: string;
  } | null;
  pendingRequest: CloudPendingRequestSummary | null;
  lastError: string | null;
}
