import { up as upgradeFencing } from '../../db/migrations/20261112_180001_support_runtime_fencing.js';
import crypto from 'node:crypto';
import { getDb, type Db } from '../../db/index.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { up as bootstrapExecutionOutboxTables } from '../../db/migrations/20261112_170002_support_execution_outbox.js';
import { getSupportTenantSigningSecret } from './support-store.js';
import {
  listSupportWebhookSubscriptions,
  type SupportPartnerEventType,
} from './support-crm-webhooks.js';
import { safeFetch } from './support-safe-http.js';

export interface SupportOutboxItem {
  id: string;
  eventId: string;
  event: string;
  webhookId: string;
  webhookName: string;
  status: 'pending' | 'delivering' | 'delivered' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  statusCode?: number;
  lastError?: string;
  createdAt: string;
}

export class SupportOutboxError extends Error {
  public statusCode: number;
  constructor(public status: number, message: string) {
    super(message);
    this.statusCode = status;
  }
}

let bootstrappedDb: Db | undefined;
export function ensureOutboxTables(db?: Db): Db {
  const targetDb = db ?? getDb();
  if (bootstrappedDb === targetDb) return targetDb;
  bootstrapExecutionOutboxTables(targetDb);
  upgradeFencing(targetDb);
  bootstrappedDb = targetDb;
  return targetDb;
}

const BACKOFF_SECONDS = [1, 5, 30, 120];

interface DeliveryRow {
  id: string;
  event_id: string;
  tenant_id: number;
  webhook_id: string;
  target_snapshot_encrypted: string;
  target_snapshot_iv: string;
  target_snapshot_auth_tag: string;
  state: 'pending' | 'delivering' | 'delivered' | 'dead';
  attempts: number;
  next_attempt_at: string | null;
  claim_until: string | null;
  last_status_code: number | null;
  sanitized_last_error: string | null;
  created_at: string;
  updated_at: string;
  event_type: SupportPartnerEventType;
  payload_encrypted: string;
  payload_iv: string;
  payload_auth_tag: string;
}

/**
 * Enqueues a durable partner event transactionally with deduplication.
 * Captures matching enabled subscriptions at enqueue time.
 */
export function enqueueSupportPartnerEvent(options: {
  tenantId: number;
  event: SupportPartnerEventType;
  payload: Record<string, unknown>;
  dedupKey: string;
}): string {
  const { tenantId, event, payload, dedupKey } = options;
  ensureOutboxTables();
  const db = getDb();

  const existing = db.prepare(
    'SELECT id FROM x_support_partner_events WHERE tenant_id = ? AND type = ? AND dedup_key = ?',
  ).get(tenantId, event, dedupKey) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const eventId = `evt_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const encPayload = encrypt(JSON.stringify(payload));

  const subs = listSupportWebhookSubscriptions(String(tenantId)).filter(
    (s) => s.enabled && (event === 'webhook.test' || s.events.includes(event)),
  );

  db.transaction(() => {
    // Re-check inside transaction in case of concurrent enqueue
    const doubleCheck = db.prepare(
      'SELECT id FROM x_support_partner_events WHERE tenant_id = ? AND type = ? AND dedup_key = ?',
    ).get(tenantId, event, dedupKey) as { id: string } | undefined;

    if (doubleCheck) {
      return;
    }

    db.prepare(`
      INSERT INTO x_support_partner_events (
        id, tenant_id, type, dedup_key,
        payload_encrypted, payload_iv, payload_auth_tag,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      tenantId,
      event,
      dedupKey,
      encPayload.encrypted,
      encPayload.iv,
      encPayload.authTag,
      now,
    );

    for (const sub of subs) {
      const deliveryId = `dlv_${crypto.randomUUID()}`;
      const targetSnapshot = {
        targetUrl: sub.targetUrl,
        secretHeader: sub.secretHeader,
        webhookName: sub.name,
      };
      const encTarget = encrypt(JSON.stringify(targetSnapshot));

      db.prepare(`
        INSERT INTO x_support_partner_deliveries (
          id, event_id, tenant_id, webhook_id,
          target_snapshot_encrypted, target_snapshot_iv, target_snapshot_auth_tag,
          state, attempts, next_attempt_at, claim_until,
          last_status_code, sanitized_last_error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?)
      `).run(
        deliveryId,
        eventId,
        tenantId,
        sub.id,
        encTarget.encrypted,
        encTarget.iv,
        encTarget.authTag,
        now,
        now,
        now,
      );
    }
  })();

  const createdOrExisting = db.prepare(
    'SELECT id FROM x_support_partner_events WHERE tenant_id = ? AND type = ? AND dedup_key = ?',
  ).get(tenantId, event, dedupKey) as { id: string };

  return createdOrExisting?.id || eventId;
}

/**
 * Lists durable outbox deliveries for a tenant.
 */
export function listSupportEventOutbox(tenantId: number): SupportOutboxItem[] {
  ensureOutboxTables();
  const db = getDb();

  const rows = db.prepare(`
    SELECT d.id, d.event_id, d.webhook_id, d.state, d.attempts, d.next_attempt_at,
           d.last_status_code, d.sanitized_last_error, d.created_at,
           d.target_snapshot_encrypted, d.target_snapshot_iv, d.target_snapshot_auth_tag,
           e.type AS event_type
    FROM x_support_partner_deliveries d
    JOIN x_support_partner_events e ON d.event_id = e.id
    WHERE d.tenant_id = ?
    ORDER BY d.created_at DESC
    LIMIT 100
  `).all(tenantId) as Array<{
    id: string;
    event_id: string;
    webhook_id: string;
    state: SupportOutboxItem['status'];
    attempts: number;
    next_attempt_at: string | null;
    last_status_code: number | null;
    sanitized_last_error: string | null;
    created_at: string;
    target_snapshot_encrypted: string;
    target_snapshot_iv: string;
    target_snapshot_auth_tag: string;
    event_type: string;
  }>;

  return rows.map((r) => {
    let webhookName = 'Unknown Webhook';
    try {
      const snap = JSON.parse(
        decrypt(r.target_snapshot_encrypted, r.target_snapshot_iv, r.target_snapshot_auth_tag),
      ) as { webhookName?: string };
      if (snap.webhookName) webhookName = snap.webhookName;
    } catch {
      // ignore decryption error for display
    }

    return {
      id: r.id,
      eventId: r.event_id,
      event: r.event_type,
      webhookId: r.webhook_id,
      webhookName,
      status: r.state,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      statusCode: r.last_status_code ?? undefined,
      lastError: r.sanitized_last_error ?? undefined,
      createdAt: r.created_at,
    };
  });
}

/**
 * Manually retries a dead delivery. Does NOT re-execute the original action.
 */
export function retrySupportEventDelivery(tenantId: number, deliveryId: string): void {
  ensureOutboxTables();
  const db = getDb();

  const row = db.prepare(
    'SELECT * FROM x_support_partner_deliveries WHERE tenant_id = ? AND id = ?',
  ).get(tenantId, deliveryId) as { state: string } | undefined;

  if (!row) {
    throw new SupportOutboxError(404, 'Delivery record not found');
  }

  if (row.state !== 'dead') {
    throw new SupportOutboxError(409, 'Only dead deliveries can be manually retried');
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE x_support_partner_deliveries
    SET state = 'pending', attempts = 0, next_attempt_at = ?, claim_until = NULL, sanitized_last_error = NULL, updated_at = ?
    WHERE tenant_id = ? AND id = ?
  `).run(now, now, tenantId, deliveryId);
}

let isDraining = false;
let drainEpoch = 0;
let lastWorkerProgressAt: number | null = null;
let drainAbort: AbortController | null = null;

/**
 * Drains eligible outbox records with lease claims, backoff, and safe HTTP delivery.
 */
export async function drainSupportEventOutbox(options?: { now?: number; limit?: number }): Promise<void> {
  if (isDraining) return;
  isDraining = true;
  const epoch = drainEpoch;
  const abort = new AbortController();
  drainAbort = abort;
  let completed = false;

  try {
    ensureOutboxTables();
    const db = getDb();
    const nowTime = options?.now ?? Date.now();
    const nowIso = new Date(nowTime).toISOString();
    const limit = options?.limit ?? 20;

    // Expired last attempts are terminal; a crashed sender must not retry forever.
    db.prepare("UPDATE x_support_partner_deliveries SET state = 'dead', sanitized_last_error = 'last_attempt_interrupted', claim_until = NULL, claim_token = NULL WHERE state = 'delivering' AND claim_until <= ? AND attempts >= 5").run(nowIso);
    // Select candidates only. Claim each immediately before network dispatch.
    let claimed: DeliveryRow[] = [];
    db.transaction(() => {
      claimed = db.prepare(`
        SELECT d.*, e.type AS event_type, e.payload_encrypted, e.payload_iv, e.payload_auth_tag
        FROM x_support_partner_deliveries d
        JOIN x_support_partner_events e ON d.event_id = e.id
        WHERE (d.state = 'pending' OR (d.state = 'delivering' AND d.claim_until <= ?))
          AND d.attempts < 5
          AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
        ORDER BY d.next_attempt_at ASC, d.id ASC
        LIMIT ?
      `).all(nowIso, nowIso, limit) as DeliveryRow[];


    })();

    // Step 2: Deliver each claimed item outside of any transaction
    for (const delivery of claimed) {
      if (epoch !== drainEpoch) return;
      lastWorkerProgressAt = Date.now();
      const claimToken = crypto.randomUUID();
      const attemptCount = db.transaction(() => {
        const claimTime = new Date(Math.max(nowTime, Date.now())).toISOString();
        const changed = db.prepare(`UPDATE x_support_partner_deliveries
          SET state = 'delivering', claim_token = ?, claim_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND attempts < 5 AND (state = 'pending' OR (state = 'delivering' AND claim_until <= ?))
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`).run(claimToken,
          new Date(Math.max(nowTime, Date.now()) + 30_000).toISOString(), claimTime, delivery.id, claimTime, claimTime);
        if (!changed.changes) return 0;
        return (db.prepare('SELECT attempts FROM x_support_partner_deliveries WHERE id = ?').get(delivery.id) as { attempts: number }).attempts;
      })();
      if (!attemptCount) continue;
      const subs = listSupportWebhookSubscriptions(String(delivery.tenant_id));
      const currentSub = subs.find((s) => s.id === delivery.webhook_id);

      // Verify subscription is still active at send time
      if (!currentSub || !currentSub.enabled) {
        const updateTime = new Date().toISOString();
        db.prepare(`
          UPDATE x_support_partner_deliveries
          SET state = 'dead', sanitized_last_error = 'subscription_disabled_or_deleted', claim_until = NULL, updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(updateTime, delivery.id, claimToken);
        continue;
      }

      let target: { targetUrl: string; secretHeader?: string };
      let payload: Record<string, unknown>;
      try {
        target = JSON.parse(
          decrypt(delivery.target_snapshot_encrypted, delivery.target_snapshot_iv, delivery.target_snapshot_auth_tag),
        );
        payload = JSON.parse(
          decrypt(delivery.payload_encrypted, delivery.payload_iv, delivery.payload_auth_tag),
        );
      } catch {
        const updateTime = new Date().toISOString();
        db.prepare(`
          UPDATE x_support_partner_deliveries
          SET state = 'dead', sanitized_last_error = 'decryption_failure', claim_until = NULL, updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(updateTime, delivery.id, claimToken);
        continue;
      }

      let secret: string | undefined;
      try {
        secret = getSupportTenantSigningSecret(delivery.tenant_id);
      } catch {
        // missing secret
      }

      if (!secret) {
        const updateTime = new Date().toISOString();
        db.prepare(`
          UPDATE x_support_partner_deliveries
          SET state = 'dead', sanitized_last_error = 'missing_signing_secret', claim_until = NULL, updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(updateTime, delivery.id, claimToken);
        continue;
      }

      const envelope = {
        id: delivery.event_id,
        event: delivery.event_type,
        tenantId: delivery.tenant_id,
        timestamp: delivery.created_at,
        payload,
      };

      const bodyJson = JSON.stringify(envelope);
      const signature = crypto.createHmac('sha256', secret).update(bodyJson).digest('hex');
      const headerName = target.secretHeader || 'X-Support-Signature';

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Support-Event': delivery.event_type,
        'X-Support-Event-Id': delivery.event_id,
        'X-Support-Delivery-Id': delivery.id,
        'X-Support-Attempt': String(attemptCount),
        [headerName]: `sha256=${signature}`,
      };

      let resStatus: number | null = null;
      let resOk = false;
      let errorMsg: string | null = null;
      let retryAfterSec: number | null = null;

      try {
        const res = await safeFetch(target.targetUrl, {
          method: 'POST',
          headers,
          body: bodyJson,
          signal: AbortSignal.any([AbortSignal.timeout(5000), abort.signal]),
        });
        resStatus = res.status;
        resOk = res.ok;
        if (!res.ok) {
          errorMsg = `HTTP ${res.status}`;
          const retryHeader = res.headers.get('Retry-After');
          if (retryHeader) {
            const parsed = parseInt(retryHeader, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
              retryAfterSec = Math.min(parsed, 300); // capped at 300s
            }
          }
        }
      } catch (err) {
        errorMsg = (err as Error).message || 'Network request failed';
      }

      if (epoch !== drainEpoch) return;
      const updateTime = new Date().toISOString();

      if (resOk) {
        db.prepare(`
          UPDATE x_support_partner_deliveries
          SET state = 'delivered', attempts = ?, last_status_code = ?, sanitized_last_error = NULL,
              next_attempt_at = NULL, claim_until = NULL, updated_at = ?
          WHERE id = ? AND claim_token = ?
        `).run(attemptCount, resStatus, updateTime, delivery.id, claimToken);
      } else {
        // Evaluate retry eligibility
        const isRetryableStatus =
          resStatus === null ||
          resStatus === 408 ||
          resStatus === 429 ||
          (resStatus >= 500 && resStatus <= 599);

        if (attemptCount >= 5 || !isRetryableStatus) {
          // Terminal failure
          db.prepare(`
            UPDATE x_support_partner_deliveries
            SET state = 'dead', attempts = ?, last_status_code = ?, sanitized_last_error = ?,
                next_attempt_at = NULL, claim_until = NULL, updated_at = ?
            WHERE id = ? AND claim_token = ?
          `).run(attemptCount, resStatus, errorMsg, updateTime, delivery.id, claimToken);
        } else {
          // Retry with backoff: 1, 5, 30, 120 seconds
          const backoffBase = BACKOFF_SECONDS[attemptCount - 1] ?? 120;
          const delaySec = retryAfterSec ? Math.max(backoffBase, retryAfterSec) : backoffBase;
          const nextAttempt = new Date(Date.now() + delaySec * 1000).toISOString();

          db.prepare(`
            UPDATE x_support_partner_deliveries
            SET state = 'pending', attempts = ?, last_status_code = ?, sanitized_last_error = ?,
                next_attempt_at = ?, claim_until = NULL, updated_at = ?
            WHERE id = ? AND claim_token = ?
          `).run(attemptCount, resStatus, errorMsg, nextAttempt, updateTime, delivery.id, claimToken);
        }
      }
    }
    completed = true;
  } finally {
    isDraining = false;
    if (drainAbort === abort) drainAbort = null;
    if (epoch === drainEpoch) lastWorkerProgressAt = completed ? Date.now() : null;
  }
}

let workerInterval: NodeJS.Timeout | null = null;

export function getSupportEventWorkerHealth(): { running: boolean; healthy: boolean } {
  const running = workerInterval !== null;
  return { running, healthy: running && lastWorkerProgressAt !== null && Date.now() - lastWorkerProgressAt <= 15_000 };
}

/**
 * Starts durable outbox worker. Idempotent start and stop.
 */
export function startSupportEventWorker(): () => void {
  if (workerInterval) {
    return stopSupportEventWorker;
  }

  lastWorkerProgressAt = null;
  workerInterval = setInterval(() => {
    drainSupportEventOutbox().catch(() => {
      // worker loop error ignored
    });
  }, 1000);

  if (typeof workerInterval.unref === 'function') {
    workerInterval.unref();
  }

  return stopSupportEventWorker;
}

export function stopSupportEventWorker(): void {
  drainEpoch++;
  lastWorkerProgressAt = null;
  drainAbort?.abort();
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
