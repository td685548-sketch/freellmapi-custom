import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { initDb, getDb } from '../../db/index.js';
import {
  createSupportTenant,
  getSupportTenantSigningSecret,
  type SupportTenant,
} from '../../custom/x-gateway/support-store.js';
import {
  upsertSupportWebhookSubscription,
  deleteSupportWebhookSubscription,
} from '../../custom/x-gateway/support-crm-webhooks.js';
import {
  enqueueSupportPartnerEvent,
  listSupportEventOutbox,
  retrySupportEventDelivery,
  drainSupportEventOutbox,
  startSupportEventWorker,
  stopSupportEventWorker,
  SupportOutboxError,
} from '../../custom/x-gateway/support-event-outbox.js';

describe('Support Durable Event Outbox (US3)', () => {
  let tenantA: SupportTenant;
  let tenantB: SupportTenant;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');

    tenantA = createSupportTenant({ name: 'Alpha Corp', slug: 'alpha-corp' }).tenant;
    tenantB = createSupportTenant({ name: 'Beta Corp', slug: 'beta-corp' }).tenant;

    stopSupportEventWorker();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    stopSupportEventWorker();
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('Transactional Enqueue & Deduplication', () => {
    it('creates stable event ID and creates delivery record for each matching enabled subscription', () => {
      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Ticket Webhook',
        targetUrl: 'https://partner.example.com/tickets',
        events: ['ticket.created'],
      });

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'All Events Webhook',
        targetUrl: 'https://partner.example.com/all',
        events: ['ticket.created', 'ticket.resolved'],
      });

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Disabled Webhook',
        targetUrl: 'https://partner.example.com/disabled',
        events: ['ticket.created'],
        enabled: false,
      });

      const eventId = enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { ticketId: 'tkt_1001' },
        dedupKey: 'dedup_ticket_1001',
      });

      expect(eventId).toMatch(/^evt_/);

      const items = listSupportEventOutbox(tenantA.id);
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.eventId === eventId)).toBe(true);
      expect(items.every((i) => i.status === 'pending')).toBe(true);
      expect(items.every((i) => i.attempts === 0)).toBe(true);

      const names = items.map((i) => i.webhookName);
      expect(names).toContain('Ticket Webhook');
      expect(names).toContain('All Events Webhook');
      expect(names).not.toContain('Disabled Webhook');
    });

    it('deduplicates event: re-enqueuing with same dedupKey returns original eventId without duplicate deliveries', () => {
      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Action Hook',
        targetUrl: 'https://partner.example.com/actions',
        events: ['action.approved'],
      });

      const id1 = enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'action.approved',
        payload: { actionId: 'act_1' },
        dedupKey: 'act_approved_1',
      });

      const id2 = enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'action.approved',
        payload: { actionId: 'act_1' },
        dedupKey: 'act_approved_1',
      });

      expect(id1).toBe(id2);
      const items = listSupportEventOutbox(tenantA.id);
      expect(items).toHaveLength(1);
    });

    it('isolates events strictly by tenant', () => {
      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Hook A',
        targetUrl: 'https://a.example.com/hook',
        events: ['ticket.created'],
      });

      upsertSupportWebhookSubscription(String(tenantB.id), {
        name: 'Hook B',
        targetUrl: 'https://b.example.com/hook',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { text: 'In A' },
        dedupKey: 'shared_key',
      });

      expect(listSupportEventOutbox(tenantA.id)).toHaveLength(1);
      expect(listSupportEventOutbox(tenantB.id)).toHaveLength(0);
    });
  });

  describe('Drain & Worker Delivery', () => {
    it('dispatches event with HMAC signature, stable eventId envelope, and marks delivered on 200', async () => {
      let capturedRequest: { url: string; headers: Record<string, string>; body: string } | null = null;
      const fetchMock = vi.fn(async (url: unknown, init: unknown) => {
        capturedRequest = {
          url: String(url),
          headers: (init as RequestInit).headers as Record<string, string>,
          body: String((init as RequestInit).body),
        };
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      });
      vi.stubGlobal('fetch', fetchMock);

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Prod Hook',
        targetUrl: 'https://partner.example.com/events',
        events: ['ticket.resolved'],
        secretHeader: 'X-Partner-Sig',
      });

      const eventId = enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.resolved',
        payload: { ticketId: 'tkt_200' },
        dedupKey: 'res_200',
      });

      await drainSupportEventOutbox();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(capturedRequest).not.toBeNull();
      expect(capturedRequest!.headers['X-Support-Event']).toBe('ticket.resolved');
      expect(capturedRequest!.headers['X-Support-Event-Id']).toBe(eventId);
      expect(capturedRequest!.headers['X-Support-Attempt']).toBe('1');

      // Verify HMAC-SHA256 signature
      const secret = getSupportTenantSigningSecret(tenantA.id);
      const expectedSig = createHmac('sha256', secret).update(capturedRequest!.body).digest('hex');
      expect(capturedRequest!.headers['X-Partner-Sig']).toBe(`sha256=${expectedSig}`);

      // Verify envelope JSON
      const envelope = JSON.parse(capturedRequest!.body) as {
        id: string;
        event: string;
        tenantId: number;
        payload: Record<string, unknown>;
      };
      expect(envelope.id).toBe(eventId);
      expect(envelope.event).toBe('ticket.resolved');
      expect(envelope.tenantId).toBe(tenantA.id);
      expect(envelope.payload).toEqual({ ticketId: 'tkt_200' });

      // Outbox status should be delivered
      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('delivered');
      expect(items[0].statusCode).toBe(200);
      expect(items[0].attempts).toBe(1);
    });

    it('retries on 500 error with backoff schedule', async () => {
      const fetchMock = vi.fn(async () => new Response('Internal Server Error', { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Flaky Hook',
        targetUrl: 'https://partner.example.com/flaky',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 1 },
        dedupKey: 'flaky_1',
      });

      const beforeDrain = Date.now();
      await drainSupportEventOutbox();

      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(1);
      expect(items[0].statusCode).toBe(500);

      // Backoff after attempt 1 is 1 second
      const nextAttemptTime = new Date(items[0].nextAttemptAt!).getTime();
      expect(nextAttemptTime).toBeGreaterThanOrEqual(beforeDrain + 800);
      expect(nextAttemptTime).toBeLessThanOrEqual(beforeDrain + 3000);
    });

    it('marks dead after 5 failed attempts', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection reset')));

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Down Hook',
        targetUrl: 'https://partner.example.com/down',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 2 },
        dedupKey: 'down_2',
      });

      // Simulate 5 attempts by draining with advancing timestamps
      let simulatedNow = Date.now();
      for (let i = 0; i < 5; i++) {
        simulatedNow += 150_000; // advance past any backoff
        await drainSupportEventOutbox({ now: simulatedNow });
      }

      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('dead');
      expect(items[0].attempts).toBe(5);
      expect(items[0].nextAttemptAt).toBeNull();
      expect(items[0].lastError).toContain('Connection reset');
    });

    it('marks dead immediately on non-retryable 4xx (e.g. 400 Bad Request)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Request', { status: 400 })));

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Rejected Hook',
        targetUrl: 'https://partner.example.com/rejected',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 3 },
        dedupKey: 'rej_3',
      });

      await drainSupportEventOutbox();

      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('dead');
      expect(items[0].statusCode).toBe(400);
      expect(items[0].attempts).toBe(1);
      expect(items[0].nextAttemptAt).toBeNull();
    });

    it('respects Retry-After header on 429 up to 300 seconds', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('Too Many Requests', {
              status: 429,
              headers: { 'Retry-After': '60' },
            }),
        ),
      );

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Rate Limited Hook',
        targetUrl: 'https://partner.example.com/rate-limit',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 4 },
        dedupKey: 'rl_4',
      });

      const before = Date.now();
      await drainSupportEventOutbox();

      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('pending');
      expect(items[0].attempts).toBe(1);
      const nextTime = new Date(items[0].nextAttemptAt!).getTime();
      expect(nextTime).toBeGreaterThanOrEqual(before + 59_000);
      expect(nextTime).toBeLessThanOrEqual(before + 65_000);
    });

    it('marks dead if subscription was deleted/disabled before send time, never sending to new target', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const sub = upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Soon Deleted Hook',
        targetUrl: 'https://partner.example.com/deleted',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 5 },
        dedupKey: 'del_5',
      });

      // Delete subscription before drain
      deleteSupportWebhookSubscription(String(tenantA.id), sub.id);

      await drainSupportEventOutbox();

      expect(fetchMock).not.toHaveBeenCalled();
      const items = listSupportEventOutbox(tenantA.id);
      expect(items[0].status).toBe('dead');
      expect(items[0].lastError).toBe('subscription_disabled_or_deleted');
    });
  });

  describe('Manual Requeue', () => {
    it('manually retries a dead delivery and resets state to pending without re-executing action', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('Terminal error', { status: 404 })));

      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Dead Hook',
        targetUrl: 'https://partner.example.com/dead',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 6 },
        dedupKey: 'manual_6',
      });

      await drainSupportEventOutbox();

      const [deadItem] = listSupportEventOutbox(tenantA.id);
      expect(deadItem.status).toBe('dead');

      // Manual retry
      retrySupportEventDelivery(tenantA.id, deadItem.id);

      const [retriedItem] = listSupportEventOutbox(tenantA.id);
      expect(retriedItem.status).toBe('pending');
      expect(retriedItem.attempts).toBe(0);
      expect(retriedItem.lastError).toBeUndefined();
    });

    it('rejects manual retry for non-dead records with 409', async () => {
      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'Pending Hook',
        targetUrl: 'https://partner.example.com/pending',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 7 },
        dedupKey: 'pending_7',
      });

      const [pendingItem] = listSupportEventOutbox(tenantA.id);
      expect(pendingItem.status).toBe('pending');

      expect(() => {
        retrySupportEventDelivery(tenantA.id, pendingItem.id);
      }).toThrow(SupportOutboxError);
    });

    it('rejects manual retry for different tenant with 404/409', () => {
      upsertSupportWebhookSubscription(String(tenantA.id), {
        name: 'A Hook',
        targetUrl: 'https://partner.example.com/a',
        events: ['ticket.created'],
      });

      enqueueSupportPartnerEvent({
        tenantId: tenantA.id,
        event: 'ticket.created',
        payload: { id: 8 },
        dedupKey: 'tenant_iso_8',
      });

      const [itemA] = listSupportEventOutbox(tenantA.id);

      expect(() => {
        retrySupportEventDelivery(tenantB.id, itemA.id);
      }).toThrow(SupportOutboxError);
    });
  });

  describe('Worker Lifecycle', () => {
    it('starts and stops worker idempotently', () => {
      const stop1 = startSupportEventWorker();
      const stop2 = startSupportEventWorker();

      expect(typeof stop1).toBe('function');
      expect(typeof stop2).toBe('function');

      stop1();
      stop2();
      // Calling stop again is safe
      stopSupportEventWorker();
    });
  });
  it('does not let a stale sender overwrite a replacement delivery claim', async () => {
    upsertSupportWebhookSubscription(String(tenantA.id), { name: 'Fenced', targetUrl: 'https://partner.example.com/events', events: ['ticket.created'] });
    enqueueSupportPartnerEvent({ tenantId: tenantA.id, event: 'ticket.created', payload: { ticketId: 'ticket_fence' }, dedupKey: 'fence' });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const draining = drainSupportEventOutbox();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const item = listSupportEventOutbox(tenantA.id)[0];
    getDb().prepare("UPDATE x_support_partner_deliveries SET claim_token = 'replacement', state = 'delivering', attempts = 2 WHERE id = ?").run(item.id);
    finish(new Response('{}', { status: 200 }));
    await draining;
    expect(getDb().prepare('SELECT state, claim_token, attempts FROM x_support_partner_deliveries WHERE id = ?').get(item.id)).toEqual({ state: 'delivering', claim_token: 'replacement', attempts: 2 });
  });

  it('stops active drains before the database can close', async () => {
    upsertSupportWebhookSubscription(String(tenantA.id), { name: 'Shutdown', targetUrl: 'https://partner.example.com/events', events: ['ticket.created'] });
    enqueueSupportPartnerEvent({ tenantId: tenantA.id, event: 'ticket.created', payload: {}, dedupKey: 'shutdown' });
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const draining = drainSupportEventOutbox();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    stopSupportEventWorker();
    expect(fetchMock.mock.calls[0]).toBeDefined();
    getDb().close?.();
    finish(new Response('{}', { status: 200 }));
    await expect(draining).resolves.toBeUndefined();
  });

});
