# Data Model: AI Support Governance, Customer Memory CRM & Outbound Partner Webhooks (`015-ai-support-governance-and-automation`)

## 1. Prompt Injection Firewall, Topic Guardrails & Per-Role Quotas (`server/src/custom/x-gateway/support-guardrails.ts` — Agent 1)

```ts
export type SupportInjectionDetector =
  | 'ignore_instructions'
  | 'role_spoofing'
  | 'system_prompt_leak'
  | 'sql_injection_probe';

export interface SupportRoleQuotaRule {
  maxRequestsPerWindow: number; // 0 = unlimited
  maxTokensPerWindow: number;   // 0 = unlimited
  windowSeconds: number;        // e.g. 3600
}

export interface SupportGuardrailPolicy {
  tenantId: string;
  enabled: boolean;
  blockPromptInjection: boolean;
  injectionDetectors: SupportInjectionDetector[];
  blockedTopics: string[];
  competitorKeywords: string[];
  maxInputLength: number;       // default 4000
  bypassRoles: string[];        // default ['admin']
  roleQuotas: Record<string, SupportRoleQuotaRule>;
  updatedAt: string;
}

export interface SupportGuardrailEvaluation {
  allowed: boolean;
  blockedReason?: 'prompt_injection' | 'blocked_topic' | 'competitor_mention' | 'input_too_long';
  triggeredRules: string[];
  matchedTerms: string[];
  bypassedByRole: boolean;
  sanitizedText: string;
}

export interface SupportQuotaStatus {
  allowed: boolean;
  reason?: 'quota_exceeded_requests' | 'quota_exceeded_tokens';
  userId: string;
  userRole: string;
  requestsUsed: number;
  maxRequests: number;
  tokensUsed: number;
  maxTokens: number;
  windowSeconds: number;
  resetAt: string;
}
```

### Exported Functions from `support-guardrails.ts`
- `getSupportGuardrailPolicy(tenantId: string): SupportGuardrailPolicy`
- `updateSupportGuardrailPolicy(tenantId: string, patch: Partial<Omit<SupportGuardrailPolicy, 'tenantId' | 'updatedAt'>>): SupportGuardrailPolicy`
- `evaluateSupportInputGuardrails(tenantId: string, input: { text: string; userId?: string; userRole: string }): SupportGuardrailEvaluation`
- `getSupportUserQuotaStatus(tenantId: string, input: { userId: string; userRole: string }): SupportQuotaStatus`
- `checkAndConsumeSupportUserQuota(tenantId: string, input: { userId: string; userRole: string; tokens?: number }): SupportQuotaStatus`
- `resetSupportUserQuota(tenantId: string, userId?: string): void`

---

## 2. Customer CRM Memory, CSAT Ratings & Outbound Partner Event Webhooks (`server/src/custom/x-gateway/support-crm-webhooks.ts` — Agent 2)

```ts
export interface SupportCustomerProfile {
  id: string;                   // 'crm_' + randomUUID()
  tenantId: string;
  userId: string;
  name?: string;
  email?: string;
  role: string;
  tier: string;                 // e.g. 'standard' | 'silver' | 'gold' | 'vip'
  tags: string[];
  customAttributes: Record<string, string | number | boolean>;
  memoryFacts: string[];        // Long-term facts remembered across sessions
  totalInteractions: number;
  averageCsat: number | null;
  csatCount: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportCsatRating {
  id: string;                   // 'csat_' + randomUUID()
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  score: number;                // 1..5 integer
  category?: string;            // e.g. 'accuracy' | 'speed' | 'politeness' | 'resolution'
  comment?: string;
  createdAt: string;
}

export interface SupportCsatSummary {
  tenantId: string;
  totalRatings: number;
  averageScore: number;         // rounded to 2 decimal places, 0 if no ratings
  positiveCount: number;        // score >= 4
  neutralCount: number;         // score === 3
  negativeCount: number;        // score <= 2
  positivePct: number;          // 0..100 integer
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

export type SupportPartnerEventType =
  | 'ticket.created'
  | 'ticket.resolved'
  | 'action.approved'
  | 'action.rejected'
  | 'csat.submitted'
  | 'guardrail.blocked'
  | 'webhook.test';

export interface SupportWebhookSubscription {
  id: string;                   // 'wh_' + randomUUID()
  tenantId: string;
  name: string;
  targetUrl: string;
  events: SupportPartnerEventType[];
  secretHeader?: string;        // optional custom header name; default 'X-Support-Signature'
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportWebhookDelivery {
  id: string;                   // 'dlv_' + randomUUID()
  tenantId: string;
  webhookId: string;
  webhookName: string;
  event: SupportPartnerEventType;
  targetUrl: string;
  status: 'delivered' | 'failed';
  statusCode?: number;
  durationMs: number;
  error?: string;
  createdAt: string;
}
```

### Exported Functions from `support-crm-webhooks.ts`
- `listSupportCustomerProfiles(tenantId: string, filter?: { role?: string; tier?: string; query?: string }): SupportCustomerProfile[]`
- `getSupportCustomerProfileForRequester(tenantId: string, targetUserId: string, requester: { userId: string; role: string }): SupportCustomerProfile | undefined` (Throws error with `statusCode = 403` if `requester.userId !== targetUserId` and `!['admin', 'staff'].includes(requester.role)`)
- `upsertSupportCustomerProfile(tenantId: string, input: { userId: string; name?: string; email?: string; role?: string; tier?: string; tags?: string[]; customAttributes?: Record<string, string | number | boolean>; memoryFacts?: string[]; incrementInteractions?: boolean }): SupportCustomerProfile`
- `appendCustomerMemoryFact(tenantId: string, userId: string, fact: string): SupportCustomerProfile`
- `buildCustomerMemoryPrompt(tenantId: string, userId: string, requesterRole: string): string`
- `submitSupportCsatRating(tenantId: string, input: { conversationId?: string; userId: string; userName?: string; userRole: string; score: number; category?: string; comment?: string }): SupportCsatRating` (Validates `score` is integer `1..5`, saves rating, and updates `averageCsat` & `csatCount` on the customer's `SupportCustomerProfile`)
- `listSupportCsatRatings(tenantId: string, filter?: { userId?: string; minScore?: number; maxScore?: number }): SupportCsatRating[]`
- `getSupportCsatSummary(tenantId: string): SupportCsatSummary`
- `listSupportWebhookSubscriptions(tenantId: string): SupportWebhookSubscription[]`
- `upsertSupportWebhookSubscription(tenantId: string, input: Partial<SupportWebhookSubscription> & { name: string; targetUrl: string; events: SupportPartnerEventType[] }): SupportWebhookSubscription`
- `deleteSupportWebhookSubscription(tenantId: string, webhookId: string): boolean`
- `listSupportWebhookDeliveries(tenantId: string, webhookId?: string): SupportWebhookDelivery[]`
- `dispatchSupportPartnerEvent(tenantId: string, event: SupportPartnerEventType, payload: Record<string, unknown>, options?: { signingSecret?: string; allowLocalhost?: boolean }): Promise<SupportWebhookDelivery[]>`
