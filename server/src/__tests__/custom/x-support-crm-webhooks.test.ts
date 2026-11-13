import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import dns from 'node:dns';
import { initDb, getDb } from '../../db/index.js';
import {
  listSupportCustomerProfiles,
  getSupportCustomerProfileForRequester,
  upsertSupportCustomerProfile,
  appendCustomerMemoryFact,
  buildCustomerMemoryPrompt,
  submitSupportCsatRating,
  listSupportCsatRatings,
  getSupportCsatSummary,
  listSupportWebhookSubscriptions,
  upsertSupportWebhookSubscription,
  deleteSupportWebhookSubscription,
  listSupportWebhookDeliveries,
  dispatchSupportPartnerEvent,
  isSsrfSafeUrl,
  SupportCrmWebhookError,
} from '../../custom/x-gateway/support-crm-webhooks.js';

const TENANT_A = 'tenant_crm_alpha';
const TENANT_B = 'tenant_crm_beta';

describe('Customer CRM Memory, CSAT Ratings & Outbound Partner Webhooks', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key LIKE 'x_gateway_support_%'").run();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Customer CRM Profiles & Long-Term Memory
  // -------------------------------------------------------------------------
  describe('Customer CRM Profiles & Long-Term Memory', () => {
    it('creates a new customer profile with default tier, deduped tags, and memory facts', () => {
      const profile = upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice Nguyen',
        email: 'alice@example.com',
        role: 'customer',
        tags: ['vip', 'electronics', 'vip'],
        customAttributes: { preferredLanguage: 'vi', loyaltyPoints: 250 },
        memoryFacts: ['Prefers express delivery', 'Prefers express delivery'],
      });

      expect(profile.id).toMatch(/^crm_/);
      expect(profile.tenantId).toBe(TENANT_A);
      expect(profile.userId).toBe('cust_101');
      expect(profile.tier).toBe('standard');
      expect(profile.tags).toEqual(['vip', 'electronics']);
      expect(profile.memoryFacts).toEqual(['Prefers express delivery']);
      expect(profile.totalInteractions).toBe(0);
      expect(profile.averageCsat).toBeNull();
      expect(profile.csatCount).toBe(0);
    });

    it('upserts an existing profile: updates attributes, dedupes tags/facts, increments interactions', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
        tier: 'silver',
        tags: ['tech'],
        memoryFacts: ['Fact 1'],
      });

      const updated = upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        tier: 'gold',
        tags: ['tech', 'gadgets'],
        memoryFacts: ['Fact 2'],
        customAttributes: { newsletterOptIn: true },
        incrementInteractions: true,
      });

      expect(updated.tier).toBe('gold');
      expect(updated.tags).toEqual(['tech', 'gadgets']);
      expect(updated.memoryFacts).toEqual(['Fact 1', 'Fact 2']);
      expect(updated.customAttributes).toEqual({ newsletterOptIn: true });
      expect(updated.totalInteractions).toBe(1);
    });

    it('lists profiles with role, tier, and query filters', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_1',
        name: 'Bob Tran',
        role: 'customer',
        tier: 'standard',
        tags: ['audio'],
      });
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_2',
        name: 'Charlie Le',
        role: 'vip_customer',
        tier: 'vip',
        tags: ['displays'],
        memoryFacts: ['Uses 4K setup'],
      });

      const all = listSupportCustomerProfiles(TENANT_A);
      expect(all).toHaveLength(2);

      const vipOnly = listSupportCustomerProfiles(TENANT_A, { tier: 'vip' });
      expect(vipOnly).toHaveLength(1);
      expect(vipOnly[0].userId).toBe('cust_2');

      const queryName = listSupportCustomerProfiles(TENANT_A, { query: 'bob' });
      expect(queryName).toHaveLength(1);
      expect(queryName[0].name).toBe('Bob Tran');

      const queryFact = listSupportCustomerProfiles(TENANT_A, { query: '4k setup' });
      expect(queryFact).toHaveLength(1);
      expect(queryFact[0].userId).toBe('cust_2');
    });

    it('getSupportCustomerProfileForRequester: allows customer to access their own profile', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
      });

      const profile = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'cust_101',
        role: 'customer',
      });
      expect(profile).toBeDefined();
      expect(profile?.userId).toBe('cust_101');
    });

    it('getSupportCustomerProfileForRequester: allows staff and admin to access any customer profile', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
      });

      const staffView = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'staff_agent',
        role: 'staff',
      });
      expect(staffView).toBeDefined();

      const adminView = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'admin_user',
        role: 'admin',
      });
      expect(adminView).toBeDefined();
    });

    it('CRITICAL SECURITY: throws 403 when another customer attempts to read someone else profile', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
      });

      expect(() =>
        getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
          userId: 'cust_999',
          role: 'customer',
        }),
      ).toThrowError(/Forbidden/);

      try {
        getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
          userId: 'cust_999',
          role: 'customer',
        });
      } catch (err) {
        expect((err as SupportCrmWebhookError).statusCode).toBe(403);
      }
    });

    it('getSupportCustomerProfileForRequester: returns undefined when profile not found', () => {
      const missing = getSupportCustomerProfileForRequester(TENANT_A, 'nonexistent', {
        userId: 'nonexistent',
        role: 'customer',
      });
      expect(missing).toBeUndefined();
    });

    it('appendCustomerMemoryFact: trims and appends memory facts up to max 50 facts, rejecting empty facts', () => {
      expect(() => appendCustomerMemoryFact(TENANT_A, 'cust_1', '   ')).toThrowError(
        /cannot be empty/,
      );

      const p1 = appendCustomerMemoryFact(TENANT_A, 'cust_1', '  Has a dog named Max  ');
      expect(p1.memoryFacts).toEqual(['Has a dog named Max']);

      // Deduplicates exact fact
      const p2 = appendCustomerMemoryFact(TENANT_A, 'cust_1', 'Has a dog named Max');
      expect(p2.memoryFacts).toHaveLength(1);

      // Appends new fact
      const p3 = appendCustomerMemoryFact(TENANT_A, 'cust_1', 'Lives in Da Nang');
      expect(p3.memoryFacts).toEqual(['Has a dog named Max', 'Lives in Da Nang']);
    });

    it('appendCustomerMemoryFact: auto-creates customer profile if none exists', () => {
      const profile = appendCustomerMemoryFact(TENANT_A, 'new_cust_99', 'Likes blue color');
      expect(profile.userId).toBe('new_cust_99');
      expect(profile.memoryFacts).toEqual(['Likes blue color']);
      expect(profile.role).toBe('customer');
      expect(profile.tier).toBe('standard');
    });

    it('buildCustomerMemoryPrompt: returns empty string if no profile or no facts/attributes', () => {
      expect(buildCustomerMemoryPrompt(TENANT_A, 'nobody', 'customer')).toBe('');

      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_empty',
        name: 'Empty Profile',
      });
      expect(buildCustomerMemoryPrompt(TENANT_A, 'cust_empty', 'customer')).toBe('');
    });

    it('buildCustomerMemoryPrompt: formats [CUSTOMER MEMORY CONTEXT] with tier, tags, attributes, and facts', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
        tier: 'gold',
        tags: ['vip', 'frequent_buyer'],
        customAttributes: { favoriteCategory: 'Mechanical Keyboards' },
        memoryFacts: ['Birthday in November', 'Requires invoice with tax code'],
      });

      const prompt = buildCustomerMemoryPrompt(TENANT_A, 'cust_101', 'customer');
      expect(prompt).toContain('[CUSTOMER MEMORY CONTEXT]');
      expect(prompt).toContain('Customer Name: Alice');
      expect(prompt).toContain('Customer ID: cust_101');
      expect(prompt).toContain('Tier: gold');
      expect(prompt).toContain('Tags: vip, frequent_buyer');
      expect(prompt).toContain('favoriteCategory');
      expect(prompt).toContain('Remembered Facts:');
      expect(prompt).toContain('- Birthday in November');
      expect(prompt).toContain('- Requires invoice with tax code');
    });
  });

  // -------------------------------------------------------------------------
  // 2. CSAT Feedback Loop
  // -------------------------------------------------------------------------
  describe('CSAT Feedback Loop', () => {
    it('submitSupportCsatRating: validates score must be an integer between 1 and 5', () => {
      const invalidScores = [0, 6, 3.5, -1, NaN];
      for (const score of invalidScores) {
        expect(() =>
          submitSupportCsatRating(TENANT_A, {
            userId: 'cust_1',
            userRole: 'customer',
            score,
          }),
        ).toThrowError(/between 1 and 5/);
      }
    });

    it('submitSupportCsatRating: saves rating and automatically recalculates averageCsat and csatCount on profile', () => {
      upsertSupportCustomerProfile(TENANT_A, {
        userId: 'cust_101',
        name: 'Alice',
      });

      const r1 = submitSupportCsatRating(TENANT_A, {
        userId: 'cust_101',
        userName: 'Alice',
        userRole: 'customer',
        score: 5,
        category: 'resolution',
        comment: 'Great help!',
      });
      expect(r1.id).toMatch(/^csat_/);
      expect(r1.score).toBe(5);

      let profile = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'cust_101',
        role: 'customer',
      });
      expect(profile?.averageCsat).toBe(5);
      expect(profile?.csatCount).toBe(1);

      submitSupportCsatRating(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        score: 4,
      });

      profile = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'cust_101',
        role: 'customer',
      });
      // (5 + 4) / 2 = 4.5
      expect(profile?.averageCsat).toBe(4.5);
      expect(profile?.csatCount).toBe(2);

      submitSupportCsatRating(TENANT_A, {
        userId: 'cust_101',
        userRole: 'customer',
        score: 4,
      });

      profile = getSupportCustomerProfileForRequester(TENANT_A, 'cust_101', {
        userId: 'cust_101',
        role: 'customer',
      });
      // (5 + 4 + 4) / 3 = 4.33
      expect(profile?.averageCsat).toBe(4.33);
      expect(profile?.csatCount).toBe(3);
    });

    it('submitSupportCsatRating: auto-creates profile if not present when rating submitted', () => {
      submitSupportCsatRating(TENANT_A, {
        userId: 'cust_brand_new',
        userName: 'Brand New User',
        userRole: 'customer',
        score: 5,
      });

      const profile = getSupportCustomerProfileForRequester(TENANT_A, 'cust_brand_new', {
        userId: 'cust_brand_new',
        role: 'customer',
      });
      expect(profile).toBeDefined();
      expect(profile?.userId).toBe('cust_brand_new');
      expect(profile?.averageCsat).toBe(5);
      expect(profile?.csatCount).toBe(1);
    });

    it('listSupportCsatRatings: lists all ratings and filters by userId, minScore, and maxScore', () => {
      submitSupportCsatRating(TENANT_A, { userId: 'u1', userRole: 'customer', score: 5 });
      submitSupportCsatRating(TENANT_A, { userId: 'u1', userRole: 'customer', score: 2 });
      submitSupportCsatRating(TENANT_A, { userId: 'u2', userRole: 'customer', score: 4 });

      expect(listSupportCsatRatings(TENANT_A)).toHaveLength(3);

      const u1Ratings = listSupportCsatRatings(TENANT_A, { userId: 'u1' });
      expect(u1Ratings).toHaveLength(2);

      const highRatings = listSupportCsatRatings(TENANT_A, { minScore: 4 });
      expect(highRatings).toHaveLength(2);

      const lowRatings = listSupportCsatRatings(TENANT_A, { maxScore: 3 });
      expect(lowRatings).toHaveLength(1);
      expect(lowRatings[0].score).toBe(2);
    });

    it('getSupportCsatSummary: computes accurate metrics, distribution, and empty state', () => {
      const emptySummary = getSupportCsatSummary(TENANT_A);
      expect(emptySummary.totalRatings).toBe(0);
      expect(emptySummary.averageScore).toBe(0);
      expect(emptySummary.positivePct).toBe(0);
      expect(emptySummary.distribution).toEqual({ '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 });

      // Add scores: 5, 5, 4, 3, 1 -> total = 5, sum = 18, avg = 3.6
      // Positive (>=4): 3, Neutral (3): 1, Negative (<=2): 1, PositivePct: 3/5 = 60%
      submitSupportCsatRating(TENANT_A, { userId: 'u1', userRole: 'customer', score: 5 });
      submitSupportCsatRating(TENANT_A, { userId: 'u2', userRole: 'customer', score: 5 });
      submitSupportCsatRating(TENANT_A, { userId: 'u3', userRole: 'customer', score: 4 });
      submitSupportCsatRating(TENANT_A, { userId: 'u4', userRole: 'customer', score: 3 });
      submitSupportCsatRating(TENANT_A, { userId: 'u5', userRole: 'customer', score: 1 });

      const summary = getSupportCsatSummary(TENANT_A);
      expect(summary.totalRatings).toBe(5);
      expect(summary.averageScore).toBe(3.6);
      expect(summary.positiveCount).toBe(3);
      expect(summary.neutralCount).toBe(1);
      expect(summary.negativeCount).toBe(1);
      expect(summary.positivePct).toBe(60);
      expect(summary.distribution).toEqual({
        '1': 1,
        '2': 0,
        '3': 1,
        '4': 1,
        '5': 2,
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Outbound Partner Event Webhooks
  // -------------------------------------------------------------------------
  describe('Outbound Partner Event Webhooks', () => {
    it('upsertSupportWebhookSubscription: validates targetUrl must be http: or https:', () => {
      expect(() =>
        upsertSupportWebhookSubscription(TENANT_A, {
          name: 'Invalid Sub',
          targetUrl: 'ftp://example.com/webhook',
          events: ['ticket.created'],
        }),
      ).toThrowError(/http: or https:/);

      expect(() =>
        upsertSupportWebhookSubscription(TENANT_A, {
          name: 'Invalid Sub',
          targetUrl: 'not_a_url',
          events: ['ticket.created'],
        }),
      ).toThrowError(/http: or https:/);
    });

    it('upsertSupportWebhookSubscription: validates name cannot be empty', () => {
      expect(() =>
        upsertSupportWebhookSubscription(TENANT_A, {
          name: '   ',
          targetUrl: 'https://example.com/webhook',
          events: ['ticket.created'],
        }),
      ).toThrowError(/name is required/);
    });

    it('upsertSupportWebhookSubscription: creates and updates subscriptions', () => {
      const sub = upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Partner Slack Ingest',
        targetUrl: 'https://hooks.slack.com/services/T00/B00/X00',
        events: ['ticket.created', 'action.approved'],
      });

      expect(sub.id).toMatch(/^wh_/);
      expect(sub.name).toBe('Partner Slack Ingest');
      expect(sub.enabled).toBe(true);
      expect(sub.secretHeader).toBe('X-Support-Signature');

      const updated = upsertSupportWebhookSubscription(TENANT_A, {
        id: sub.id,
        name: 'Partner Discord Ingest',
        targetUrl: 'https://discord.com/api/webhooks/123/xyz',
        events: ['csat.submitted'],
      });

      expect(updated.id).toBe(sub.id);
      expect(updated.name).toBe('Partner Discord Ingest');
      expect(updated.events).toEqual(['csat.submitted']);
    });

    it('deleteSupportWebhookSubscription: removes subscription and returns boolean', () => {
      const sub = upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Temporary Sub',
        targetUrl: 'https://example.com/temp',
        events: ['ticket.resolved'],
      });

      expect(listSupportWebhookSubscriptions(TENANT_A)).toHaveLength(1);
      expect(deleteSupportWebhookSubscription(TENANT_A, sub.id)).toBe(true);
      expect(deleteSupportWebhookSubscription(TENANT_A, sub.id)).toBe(false);
      expect(listSupportWebhookSubscriptions(TENANT_A)).toHaveLength(0);
    });

    it('SSRF protection: isSsrfSafeUrl blocks private, localhost, and non-http URLs unless allowLocalhost=true', () => {
      const blockedUrls = [
        'http://localhost:3000/hook',
        'http://127.0.0.1:8080/hook',
        'http://0.0.0.0/hook',
        'http://10.0.0.1/hook',
        'http://192.168.1.1/hook',
        'http://172.16.0.1/hook',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/hook',
      ];

      for (const url of blockedUrls) {
        expect(isSsrfSafeUrl(url, false).safe).toBe(false);
        // With allowLocalhost = true, localhost and private addresses are permitted for tests
        expect(isSsrfSafeUrl(url, true).safe).toBe(true);
      }

      // Public URLs are always safe
      expect(isSsrfSafeUrl('https://api.partner.com/webhooks', false).safe).toBe(true);
      expect(isSsrfSafeUrl('http://webhook.site/abc-123', false).safe).toBe(true);
    });

    it('dispatchSupportPartnerEvent: blocks delivery with SSRF error when targetUrl is private and allowLocalhost is false', async () => {
      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Local Target',
        targetUrl: 'http://127.0.0.1:5000/webhook',
        events: ['ticket.created'],
      });

      const deliveries = await dispatchSupportPartnerEvent(
        TENANT_A,
        'ticket.created',
        { ticketId: 'tkt_123' },
        { allowLocalhost: false },
      );

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('failed');
      expect(deliveries[0].error).toContain('SSRF');

      const savedDeliveries = listSupportWebhookDeliveries(TENANT_A);
      expect(savedDeliveries).toHaveLength(1);
      expect(savedDeliveries[0].status).toBe('failed');
    });

    it('dispatchSupportPartnerEvent: successfully dispatches event with HMAC-SHA256 signature when allowed', async () => {
      const signingSecret = 'secret_test_key_123';
      let capturedRequest: { url: string; headers: Record<string, string>; body: string } | null = null;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        capturedRequest = {
          url: String(url),
          headers: init?.headers as Record<string, string>,
          body: String(init?.body),
        };
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Partner Production Endpoint',
        targetUrl: 'https://partner.com/api/ai-events',
        events: ['ticket.resolved'],
        secretHeader: 'X-Partner-Sig',
      });

      const payload = { ticketId: 'tkt_888', resolution: 'Fixed bug' };
      const deliveries = await dispatchSupportPartnerEvent(
        TENANT_A,
        'ticket.resolved',
        payload,
        { signingSecret, allowLocalhost: false },
      );

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('delivered');
      expect(deliveries[0].statusCode).toBe(200);

      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.headers['Content-Type']).toBe('application/json');
      expect(capturedRequest!.headers['X-Support-Event']).toBe('ticket.resolved');
      expect(capturedRequest!.headers['X-Support-Delivery-Id']).toBeDefined();

      // Verify HMAC-SHA256 signature header
      const sigHeader = capturedRequest!.headers['X-Partner-Sig'];
      expect(sigHeader).toBeDefined();
      expect(sigHeader).toMatch(/^sha256=[a-f0-9]{64}$/);

      const expectedSig = createHmac('sha256', signingSecret)
        .update(capturedRequest!.body)
        .digest('hex');
      expect(sigHeader).toBe(`sha256=${expectedSig}`);
    });

    it('dispatchSupportPartnerEvent: handles network errors gracefully', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Connection refused'));

      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Failing Endpoint',
        targetUrl: 'https://partner.com/api/down',
        events: ['action.approved'],
      });

      const deliveries = await dispatchSupportPartnerEvent(
        TENANT_A,
        'action.approved',
        { actionId: 'act_1' },
        { signingSecret: 'sec_test_fail' },
      );

      expect(deliveries).toHaveLength(1);
      expect(deliveries[0].status).toBe('failed');
      expect(deliveries[0].error).toContain('Connection refused');
    });

    it('dispatchSupportPartnerEvent: rejects when no valid signing secret is provided', async () => {
      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Sec Target',
        targetUrl: 'https://partner.com/api',
        events: ['ticket.created'],
      });

      await expect(
        dispatchSupportPartnerEvent(TENANT_A, 'ticket.created', { id: 1 }, {}),
      ).rejects.toThrow(SupportCrmWebhookError);
    });

    it('dispatchSupportPartnerEvent: filters by event type and supports webhook.test', async () => {
      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Action Only',
        targetUrl: 'https://partner.com/actions',
        events: ['action.approved'],
      });

      // Event is ticket.created -> should not trigger Action Only subscription
      const nonMatching = await dispatchSupportPartnerEvent(TENANT_A, 'ticket.created', {}, { signingSecret: 'sec_test' });
      expect(nonMatching).toHaveLength(0);

      // Event is webhook.test -> triggers all subscriptions
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));
      const testDeliveries = await dispatchSupportPartnerEvent(TENANT_A, 'webhook.test', {}, { signingSecret: 'sec_test' });
      expect(testDeliveries).toHaveLength(1);
    });

    it('dispatchSupportPartnerEvent: caps deliveries history at 200 per tenant', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('OK', { status: 200 }));
      // 205 dispatches each resolve the target host first. Answer from a stub so the test
      // measures the cap, not how fast this machine's resolver is.
      vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);

      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Active Sub',
        targetUrl: 'https://partner.com/hook',
        events: ['csat.submitted'],
      });

      for (let i = 0; i < 205; i++) {
        await dispatchSupportPartnerEvent(TENANT_A, 'csat.submitted', { index: i }, { signingSecret: 'sec_test' });
      }

      const deliveries = listSupportWebhookDeliveries(TENANT_A);
      expect(deliveries).toHaveLength(200);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-Tenant Isolation
  // -------------------------------------------------------------------------
  describe('Multi-Tenant Isolation', () => {
    it('strictly isolates CRM profiles, CSAT ratings, and webhooks between tenants', () => {
      upsertSupportCustomerProfile(TENANT_A, { userId: 'user_shared', name: 'User in A' });
      submitSupportCsatRating(TENANT_A, { userId: 'user_shared', userRole: 'customer', score: 5 });
      upsertSupportWebhookSubscription(TENANT_A, {
        name: 'Hook A',
        targetUrl: 'https://a.com/hook',
        events: ['ticket.created'],
      });

      expect(listSupportCustomerProfiles(TENANT_A)).toHaveLength(1);
      expect(listSupportCsatRatings(TENANT_A)).toHaveLength(1);
      expect(listSupportWebhookSubscriptions(TENANT_A)).toHaveLength(1);

      expect(listSupportCustomerProfiles(TENANT_B)).toHaveLength(0);
      expect(listSupportCsatRatings(TENANT_B)).toHaveLength(0);
      expect(listSupportWebhookSubscriptions(TENANT_B)).toHaveLength(0);
      expect(getSupportCsatSummary(TENANT_B).totalRatings).toBe(0);
    });
  });
});
