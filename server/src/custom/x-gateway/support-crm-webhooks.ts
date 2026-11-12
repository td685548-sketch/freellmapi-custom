import { createHmac, randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';

const CRM_KEY = 'x_gateway_support_crm_v1';
const CSAT_KEY = 'x_gateway_support_csat_v1';
const WEBHOOKS_KEY = 'x_gateway_support_webhooks_v1';
const DELIVERIES_KEY = 'x_gateway_support_webhook_deliveries_v1';
const MAX_DELIVERIES_PER_TENANT = 200;
const MAX_MEMORY_FACTS = 50;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class SupportCrmWebhookError extends Error {
  public statusCode: number;
  constructor(public status: number, message: string) {
    super(message);
    this.statusCode = status;
  }
}

// ---------------------------------------------------------------------------
// Types (mirroring specs/015-ai-support-governance-and-automation/data-model.md)
// ---------------------------------------------------------------------------

export interface SupportCustomerProfile {
  id: string; // 'crm_' + randomUUID()
  tenantId: string;
  userId: string;
  name?: string;
  email?: string;
  role: string;
  tier: string; // e.g. 'standard' | 'silver' | 'gold' | 'vip'
  tags: string[];
  customAttributes: Record<string, string | number | boolean>;
  memoryFacts: string[]; // Long-term facts remembered across sessions
  totalInteractions: number;
  averageCsat: number | null;
  csatCount: number;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupportCsatRating {
  id: string; // 'csat_' + randomUUID()
  tenantId: string;
  conversationId?: string;
  userId: string;
  userName?: string;
  userRole: string;
  score: number; // 1..5 integer
  category?: string; // e.g. 'accuracy' | 'speed' | 'politeness' | 'resolution'
  comment?: string;
  createdAt: string;
}

export interface SupportCsatSummary {
  tenantId: string;
  totalRatings: number;
  averageScore: number; // rounded to 2 decimal places, 0 if no ratings
  positiveCount: number; // score >= 4
  neutralCount: number; // score === 3
  negativeCount: number; // score <= 2
  positivePct: number; // 0..100 integer
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
  id: string; // 'wh_' + randomUUID()
  tenantId: string;
  name: string;
  targetUrl: string;
  events: SupportPartnerEventType[];
  secretHeader?: string; // optional custom header name; default 'X-Support-Signature'
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SupportWebhookDelivery {
  id: string; // 'dlv_' + randomUUID()
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
// Customer CRM Profiles & Long-Term Memory
// ---------------------------------------------------------------------------

export function listSupportCustomerProfiles(
  tenantId: string,
  filter?: { role?: string; tier?: string; query?: string },
): SupportCustomerProfile[] {
  const tid = String(tenantId);
  const store = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  return list.filter((p) => {
    if (filter?.role && p.role.toLowerCase() !== filter.role.toLowerCase()) return false;
    if (filter?.tier && p.tier.toLowerCase() !== filter.tier.toLowerCase()) return false;
    if (filter?.query) {
      const q = filter.query.toLowerCase().trim();
      const inId = p.userId.toLowerCase().includes(q);
      const inName = p.name ? p.name.toLowerCase().includes(q) : false;
      const inEmail = p.email ? p.email.toLowerCase().includes(q) : false;
      const inTags = p.tags.some((t) => t.toLowerCase().includes(q));
      const inFacts = p.memoryFacts.some((f) => f.toLowerCase().includes(q));
      if (!inId && !inName && !inEmail && !inTags && !inFacts) return false;
    }
    return true;
  });
}

export function getSupportCustomerProfileForRequester(
  tenantId: string,
  targetUserId: string,
  requester: { userId: string; role: string },
): SupportCustomerProfile | undefined {
  const role = String(requester.role ?? '').toLowerCase();
  const isAdminOrStaff = role === 'admin' || role === 'staff';

  if (requester.userId !== targetUserId && !isAdminOrStaff) {
    throw new SupportCrmWebhookError(
      403,
      'Forbidden: cannot access another customer CRM profile',
    );
  }

  const tid = String(tenantId);
  const store = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  return list.find((p) => p.userId === targetUserId);
}

export function upsertSupportCustomerProfile(
  tenantId: string,
  input: {
    userId: string;
    name?: string;
    email?: string;
    role?: string;
    tier?: string;
    tags?: string[];
    customAttributes?: Record<string, string | number | boolean>;
    memoryFacts?: string[];
    incrementInteractions?: boolean;
  },
): SupportCustomerProfile {
  const tid = String(tenantId);
  const store = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  const idx = list.findIndex((p) => p.userId === input.userId);
  let profile: SupportCustomerProfile;

  const dedupedTags = (existingTags: string[] = [], newTags: string[] = []): string[] => {
    return Array.from(new Set([...existingTags, ...newTags].map((t) => t.trim()))).filter(Boolean);
  };

  const dedupedFacts = (existingFacts: string[] = [], newFacts: string[] = []): string[] => {
    const combined = Array.from(
      new Set([...existingFacts, ...newFacts].map((f) => f.trim())),
    ).filter(Boolean);
    return combined.slice(-MAX_MEMORY_FACTS);
  };

  if (idx >= 0) {
    const existing = list[idx];
    profile = {
      ...existing,
      name: input.name !== undefined ? input.name : existing.name,
      email: input.email !== undefined ? input.email : existing.email,
      role: input.role !== undefined ? input.role : existing.role,
      tier: input.tier !== undefined ? input.tier : existing.tier,
      tags: input.tags !== undefined ? dedupedTags(existing.tags, input.tags) : existing.tags,
      customAttributes: {
        ...existing.customAttributes,
        ...(input.customAttributes || {}),
      },
      memoryFacts:
        input.memoryFacts !== undefined
          ? dedupedFacts(existing.memoryFacts, input.memoryFacts)
          : existing.memoryFacts,
      totalInteractions:
        existing.totalInteractions + (input.incrementInteractions ? 1 : 0),
      lastSeenAt: now,
      updatedAt: now,
    };
    list[idx] = profile;
  } else {
    profile = {
      id: `crm_${randomUUID()}`,
      tenantId: tid,
      userId: input.userId,
      name: input.name,
      email: input.email,
      role: input.role || 'customer',
      tier: input.tier || 'standard',
      tags: dedupedTags([], input.tags || []),
      customAttributes: input.customAttributes || {},
      memoryFacts: dedupedFacts([], input.memoryFacts || []),
      totalInteractions: input.incrementInteractions ? 1 : 0,
      averageCsat: null,
      csatCount: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    list.push(profile);
  }

  store[tid] = list;
  writeStore(CRM_KEY, store);
  return profile;
}

export function appendCustomerMemoryFact(
  tenantId: string,
  userId: string,
  fact: string,
): SupportCustomerProfile {
  const trimmed = String(fact ?? '').trim();
  if (!trimmed) {
    throw new SupportCrmWebhookError(400, 'Memory fact cannot be empty');
  }

  const tid = String(tenantId);
  const store = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  let profile = list.find((p) => p.userId === userId);

  if (!profile) {
    profile = {
      id: `crm_${randomUUID()}`,
      tenantId: tid,
      userId,
      role: 'customer',
      tier: 'standard',
      tags: [],
      customAttributes: {},
      memoryFacts: [trimmed],
      totalInteractions: 1,
      averageCsat: null,
      csatCount: 0,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
    list.push(profile);
  } else {
    if (!profile.memoryFacts.includes(trimmed)) {
      profile.memoryFacts = [...profile.memoryFacts, trimmed].slice(-MAX_MEMORY_FACTS);
      profile.updatedAt = now;
      profile.lastSeenAt = now;
    }
  }

  store[tid] = list;
  writeStore(CRM_KEY, store);
  return profile;
}

export function buildCustomerMemoryPrompt(
  tenantId: string,
  userId: string,
  _requesterRole?: string,
): string {
  const tid = String(tenantId);
  const store = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const profile = list.find((p) => p.userId === userId);

  if (!profile) return '';

  const hasFacts = Array.isArray(profile.memoryFacts) && profile.memoryFacts.length > 0;
  const hasAttributes =
    profile.customAttributes && Object.keys(profile.customAttributes).length > 0;

  if (!hasFacts && !hasAttributes) {
    return '';
  }

  const lines: string[] = ['[CUSTOMER MEMORY CONTEXT]'];
  if (profile.name) {
    lines.push(`Customer Name: ${profile.name}`);
  }
  lines.push(`Customer ID: ${profile.userId}`);
  if (profile.tier) {
    lines.push(`Tier: ${profile.tier}`);
  }
  if (profile.tags && profile.tags.length > 0) {
    lines.push(`Tags: ${profile.tags.join(', ')}`);
  }
  if (hasAttributes) {
    lines.push(`Attributes: ${JSON.stringify(profile.customAttributes)}`);
  }
  if (hasFacts) {
    lines.push('Remembered Facts:');
    for (const f of profile.memoryFacts) {
      lines.push(`- ${f}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CSAT Feedback Loop
// ---------------------------------------------------------------------------

export function submitSupportCsatRating(
  tenantId: string,
  input: {
    conversationId?: string;
    userId: string;
    userName?: string;
    userRole: string;
    score: number;
    category?: string;
    comment?: string;
  },
): SupportCsatRating {
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new SupportCrmWebhookError(
      400,
      'CSAT score must be an integer between 1 and 5',
    );
  }

  const tid = String(tenantId);
  const store = readStore<SupportCsatRating[]>(CSAT_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  const rating: SupportCsatRating = {
    id: `csat_${randomUUID()}`,
    tenantId: tid,
    conversationId: input.conversationId,
    userId: input.userId,
    userName: input.userName,
    userRole: input.userRole,
    score: input.score,
    category: input.category,
    comment: input.comment?.trim(),
    createdAt: now,
  };

  list.push(rating);
  store[tid] = list;
  writeStore(CSAT_KEY, store);

  // Recalculate averageCsat & csatCount on user's SupportCustomerProfile
  const userRatings = list.filter((r) => r.userId === input.userId);
  const csatCount = userRatings.length;
  const totalScore = userRatings.reduce((sum, r) => sum + r.score, 0);
  const averageCsat = csatCount > 0 ? Math.round((totalScore / csatCount) * 100) / 100 : null;

  const crmStore = readStore<SupportCustomerProfile[]>(CRM_KEY);
  const crmList = Array.isArray(crmStore[tid]) ? crmStore[tid] : [];
  const profileIdx = crmList.findIndex((p) => p.userId === input.userId);

  if (profileIdx >= 0) {
    crmList[profileIdx] = {
      ...crmList[profileIdx],
      name: input.userName || crmList[profileIdx].name,
      averageCsat,
      csatCount,
      updatedAt: now,
    };
  } else {
    crmList.push({
      id: `crm_${randomUUID()}`,
      tenantId: tid,
      userId: input.userId,
      name: input.userName,
      role: input.userRole || 'customer',
      tier: 'standard',
      tags: [],
      customAttributes: {},
      memoryFacts: [],
      totalInteractions: 1,
      averageCsat,
      csatCount,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  crmStore[tid] = crmList;
  writeStore(CRM_KEY, crmStore);

  return rating;
}

export function listSupportCsatRatings(
  tenantId: string,
  filter?: { userId?: string; minScore?: number; maxScore?: number },
): SupportCsatRating[] {
  const tid = String(tenantId);
  const store = readStore<SupportCsatRating[]>(CSAT_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  return list.filter((r) => {
    if (filter?.userId && r.userId !== filter.userId) return false;
    if (filter?.minScore !== undefined && r.score < filter.minScore) return false;
    if (filter?.maxScore !== undefined && r.score > filter.maxScore) return false;
    return true;
  });
}

export function getSupportCsatSummary(tenantId: string): SupportCsatSummary {
  const tid = String(tenantId);
  const store = readStore<SupportCsatRating[]>(CSAT_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  const totalRatings = list.length;
  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let totalScore = 0;

  const distribution: Record<'1' | '2' | '3' | '4' | '5', number> = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
  };

  for (const r of list) {
    totalScore += r.score;
    if (r.score >= 4) positiveCount++;
    else if (r.score === 3) neutralCount++;
    else negativeCount++;

    const key = String(r.score) as '1' | '2' | '3' | '4' | '5';
    if (distribution[key] !== undefined) {
      distribution[key]++;
    }
  }

  const averageScore =
    totalRatings > 0 ? Math.round((totalScore / totalRatings) * 100) / 100 : 0;
  const positivePct =
    totalRatings > 0 ? Math.round((positiveCount / totalRatings) * 100) : 0;

  return {
    tenantId: tid,
    totalRatings,
    averageScore,
    positiveCount,
    neutralCount,
    negativeCount,
    positivePct,
    distribution,
  };
}

// ---------------------------------------------------------------------------
// Outbound Partner Event Webhooks
// ---------------------------------------------------------------------------

export function isSsrfSafeUrl(
  rawUrl: string,
  allowLocalhost = false,
): { safe: boolean; reason?: string } {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { safe: false, reason: 'Target URL must use http or https protocol' };
    }
    if (allowLocalhost) {
      return { safe: true };
    }
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.startsWith('127.') ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '[::1]' ||
      host === '::1'
    ) {
      return { safe: false, reason: 'SSRF protection: private or localhost URLs are not allowed' };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }
}

export function listSupportWebhookSubscriptions(tenantId: string): SupportWebhookSubscription[] {
  const tid = String(tenantId);
  const store = readStore<SupportWebhookSubscription[]>(WEBHOOKS_KEY);
  return Array.isArray(store[tid]) ? store[tid] : [];
}

export function upsertSupportWebhookSubscription(
  tenantId: string,
  input: Partial<SupportWebhookSubscription> & {
    name: string;
    targetUrl: string;
    events: SupportPartnerEventType[];
  },
): SupportWebhookSubscription {
  const trimmedUrl = String(input.targetUrl ?? '').trim();
  try {
    const u = new URL(trimmedUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error();
    }
  } catch {
    throw new SupportCrmWebhookError(
      400,
      'Invalid targetUrl: must be a valid http: or https: URL',
    );
  }

  const trimmedName = String(input.name ?? '').trim();
  if (!trimmedName) {
    throw new SupportCrmWebhookError(400, 'Webhook subscription name is required');
  }

  const tid = String(tenantId);
  const store = readStore<SupportWebhookSubscription[]>(WEBHOOKS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const now = new Date().toISOString();

  const idx = input.id ? list.findIndex((w) => w.id === input.id) : -1;
  let sub: SupportWebhookSubscription;

  if (idx >= 0) {
    const existing = list[idx];
    sub = {
      ...existing,
      name: trimmedName,
      targetUrl: trimmedUrl,
      events: input.events ?? existing.events,
      secretHeader: input.secretHeader ?? existing.secretHeader,
      enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
      updatedAt: now,
    };
    list[idx] = sub;
  } else {
    sub = {
      id: input.id || `wh_${randomUUID()}`,
      tenantId: tid,
      name: trimmedName,
      targetUrl: trimmedUrl,
      events: input.events || [],
      secretHeader: input.secretHeader || 'X-Support-Signature',
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    list.push(sub);
  }

  store[tid] = list;
  writeStore(WEBHOOKS_KEY, store);
  return sub;
}

export function deleteSupportWebhookSubscription(tenantId: string, webhookId: string): boolean {
  const tid = String(tenantId);
  const store = readStore<SupportWebhookSubscription[]>(WEBHOOKS_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];
  const idx = list.findIndex((w) => w.id === webhookId);
  if (idx < 0) return false;

  list.splice(idx, 1);
  store[tid] = list;
  writeStore(WEBHOOKS_KEY, store);
  return true;
}

export function listSupportWebhookDeliveries(
  tenantId: string,
  webhookId?: string,
): SupportWebhookDelivery[] {
  const tid = String(tenantId);
  const store = readStore<SupportWebhookDelivery[]>(DELIVERIES_KEY);
  const list = Array.isArray(store[tid]) ? store[tid] : [];

  if (webhookId) {
    return list.filter((d) => d.webhookId === webhookId);
  }
  return list;
}

export async function dispatchSupportPartnerEvent(
  tenantId: string,
  event: SupportPartnerEventType,
  payload: Record<string, unknown>,
  options?: { signingSecret?: string; allowLocalhost?: boolean },
): Promise<SupportWebhookDelivery[]> {
  const tid = String(tenantId);
  const subs = listSupportWebhookSubscriptions(tid).filter(
    (s) => s.enabled && (event === 'webhook.test' || s.events.includes(event)),
  );

  if (subs.length === 0) {
    return [];
  }

  const deliveriesStore = readStore<SupportWebhookDelivery[]>(DELIVERIES_KEY);
  const existingDeliveries = Array.isArray(deliveriesStore[tid]) ? deliveriesStore[tid] : [];
  const newDeliveries: SupportWebhookDelivery[] = [];

  for (const sub of subs) {
    const deliveryId = `dlv_${randomUUID()}`;
    const now = new Date().toISOString();
    const ssrf = isSsrfSafeUrl(sub.targetUrl, options?.allowLocalhost);

    if (!ssrf.safe) {
      const delivery: SupportWebhookDelivery = {
        id: deliveryId,
        tenantId: tid,
        webhookId: sub.id,
        webhookName: sub.name,
        event,
        targetUrl: sub.targetUrl,
        status: 'failed',
        durationMs: 0,
        error: ssrf.reason || 'SSRF protection blocked target URL',
        createdAt: now,
      };
      newDeliveries.push(delivery);
      continue;
    }

    const bodyJson = JSON.stringify({
      id: deliveryId,
      event,
      tenantId: tid,
      timestamp: now,
      payload,
    });

    const secret = options?.signingSecret || 'default_secret';
    const signature = createHmac('sha256', secret).update(bodyJson).digest('hex');
    const headerName = sub.secretHeader || 'X-Support-Signature';

    const startTime = Date.now();
    try {
      const res = await fetch(sub.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Support-Event': event,
          'X-Support-Delivery-Id': deliveryId,
          [headerName]: `sha256=${signature}`,
        },
        body: bodyJson,
        signal: AbortSignal.timeout(5000),
      });

      const durationMs = Date.now() - startTime;
      const delivery: SupportWebhookDelivery = {
        id: deliveryId,
        tenantId: tid,
        webhookId: sub.id,
        webhookName: sub.name,
        event,
        targetUrl: sub.targetUrl,
        status: res.ok ? 'delivered' : 'failed',
        statusCode: res.status,
        durationMs,
        error: res.ok ? undefined : `HTTP ${res.status} ${res.statusText}`,
        createdAt: now,
      };
      newDeliveries.push(delivery);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const delivery: SupportWebhookDelivery = {
        id: deliveryId,
        tenantId: tid,
        webhookId: sub.id,
        webhookName: sub.name,
        event,
        targetUrl: sub.targetUrl,
        status: 'failed',
        durationMs,
        error: (err as Error).message || 'Network request failed',
        createdAt: now,
      };
      newDeliveries.push(delivery);
    }
  }

  // Prepend and cap to MAX_DELIVERIES_PER_TENANT
  deliveriesStore[tid] = [...newDeliveries, ...existingDeliveries].slice(
    0,
    MAX_DELIVERIES_PER_TENANT,
  );
  writeStore(DELIVERIES_KEY, deliveriesStore);

  return newDeliveries;
}
