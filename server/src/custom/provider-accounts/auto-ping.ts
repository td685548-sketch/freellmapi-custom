import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../../db/index.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { clearCooldownsForKey } from '../../services/ratelimit.js';
import { isQuotaWindowFresh } from '../x-gateway/quota/store.js';
import type { XQuotaWindow } from '@freellmapi/shared/x-quota.js';
import { accountRow, resolveXGatewayAccountProxy } from './store.js';
import { resolveAccountProvider } from './execution.js';
import { resolveAccountCredential } from './oauth-lifecycle.js';
import { withKeyProxy } from '../../lib/proxy.js';

export interface AutoPingSchedule {
  enabled: boolean;
  mode: 'off' | 'reset' | 'schedule';
  anchor: string; // HH:MM
  windowHours: number;
  slotsPerDay: number;
  timezone: string;
  lastPingAt?: string | null;
  lastPingStatus?: 'ok' | 'error' | null;
}

export const PING_SCHEDULE_DEFAULTS: AutoPingSchedule = {
  enabled: false,
  mode: 'off',
  anchor: '08:00',
  windowHours: 5,
  slotsPerDay: 3,
  timezone: 'UTC',
};

// In-memory Cooldown storage. Key is `${accountId}|${modelId ?? ''}`; an empty
// model segment means the whole account is cooling down.
interface CooldownEntry { accountId: number; modelId: string | null; until: number; lastError: string | null }
const cooldownMap = new Map<string, CooldownEntry>();
const cooldownKey = (accountId: number, modelId?: string | null): string => `${accountId}|${modelId ?? ''}`;

// In-memory schedules cache (synced to DB settings)
const scheduleCache = new Map<number, AutoPingSchedule>();

let workerInterval: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------
// Cooldown Management
// ---------------------------------------------------------------------

export function setAccountCooldown(
  accountId: number,
  durationMsOrUntil: number | string,
  modelId?: string,
  lastError?: string,
): void {
  const untilMs = typeof durationMsOrUntil === 'string'
    ? new Date(durationMsOrUntil).getTime()
    : Date.now() + durationMsOrUntil;
  if (!Number.isFinite(untilMs)) return;

  cooldownMap.set(cooldownKey(accountId, modelId), {
    accountId,
    modelId: modelId || null,
    until: untilMs,
    lastError: lastError ?? null,
  });
}

/** Active (non-expired) cooldown entries; expired ones are purged on read. */
export function listCooldownEntries(): Array<{
  accountId: number;
  modelId: string | null;
  until: string;
  remainingMs: number;
  lastError: string | null;
}> {
  const now = Date.now();
  const res = [];
  for (const [key, entry] of cooldownMap.entries()) {
    if (entry.until <= now) {
      cooldownMap.delete(key);
      continue;
    }
    res.push({
      accountId: entry.accountId,
      modelId: entry.modelId,
      until: new Date(entry.until).toISOString(),
      remainingMs: entry.until - now,
      lastError: entry.lastError,
    });
  }
  return res;
}

/**
 * Cooldown status for an account. With `modelId` only the account-wide entry and
 * that model's entry count; without it the longest active entry of the account
 * (account-wide or any model) is reported.
 */
export function getAccountCooldown(accountId: number, modelId?: string): {
  inCooldown: boolean;
  until: string | null;
  remainingMs: number;
  modelId?: string | null;
  lastError?: string | null;
} {
  const matches = listCooldownEntries().filter(e => e.accountId === accountId
    && (modelId === undefined || e.modelId === null || e.modelId === modelId));
  if (!matches.length) return { inCooldown: false, until: null, remainingMs: 0 };
  const best = matches.reduce((a, b) => (b.remainingMs > a.remainingMs ? b : a));
  return {
    inCooldown: true,
    until: best.until,
    remainingMs: best.remainingMs,
    modelId: best.modelId,
    lastError: best.lastError,
  };
}

/** Clears one model's cooldown when `modelId` is given, otherwise all of the account's. */
export function clearAccountCooldown(accountId: number, modelId?: string): void {
  if (modelId !== undefined) {
    cooldownMap.delete(cooldownKey(accountId, modelId));
    return;
  }
  for (const [key, entry] of cooldownMap.entries()) {
    if (entry.accountId === accountId) cooldownMap.delete(key);
  }
}

export function getAllCooldowns(): Record<number, string> {
  const res: Record<number, string> = {};
  for (const e of listCooldownEntries()) {
    if (!res[e.accountId] || res[e.accountId] < e.until) res[e.accountId] = e.until;
  }
  return res;
}

// ---------------------------------------------------------------------
// Auto-Ping Schedule Storage
// ---------------------------------------------------------------------

function scheduleSettingKey(accountId: number): string {
  return `x_account_ping_schedule_${accountId}`;
}

export function getAutoPingSchedule(accountId: number): AutoPingSchedule {
  if (scheduleCache.has(accountId)) {
    return { ...scheduleCache.get(accountId)! };
  }

  try {
    const raw = getSetting(scheduleSettingKey(accountId));
    if (raw) {
      const parsed = JSON.parse(raw);
      const schedule: AutoPingSchedule = {
        enabled: parsed.enabled === true,
        mode: parsed.mode || (parsed.enabled ? 'schedule' : 'off'),
        anchor: parsed.anchor || PING_SCHEDULE_DEFAULTS.anchor,
        windowHours: Number(parsed.windowHours) || PING_SCHEDULE_DEFAULTS.windowHours,
        slotsPerDay: Number(parsed.slotsPerDay) || PING_SCHEDULE_DEFAULTS.slotsPerDay,
        timezone: parsed.timezone || PING_SCHEDULE_DEFAULTS.timezone,
        lastPingAt: parsed.lastPingAt ?? null,
        lastPingStatus: parsed.lastPingStatus ?? null,
      };
      scheduleCache.set(accountId, schedule);
      return schedule;
    }
  } catch {
    // Fall back to defaults
  }

  const def = { ...PING_SCHEDULE_DEFAULTS };
  scheduleCache.set(accountId, def);
  return def;
}

export function setAutoPingSchedule(accountId: number, patch: Partial<AutoPingSchedule>): AutoPingSchedule {
  const current = getAutoPingSchedule(accountId);
  const updated: AutoPingSchedule = {
    ...current,
    ...patch,
    enabled: patch.mode ? patch.mode !== 'off' : patch.enabled ?? current.enabled,
  };

  scheduleCache.set(accountId, updated);
  try {
    setSetting(scheduleSettingKey(accountId), JSON.stringify(updated));
  } catch {
    // Fallback in-memory
  }
  return updated;
}

// ---------------------------------------------------------------------
// Execution & Worker
// ---------------------------------------------------------------------

export async function pingAccount(accountId: number): Promise<{
  ok: boolean;
  latencyMs: number;
  message?: string;
}> {
  const start = Date.now();
  let row;
  try {
    row = accountRow(accountId);
  } catch {
    return { ok: false, latencyMs: Date.now() - start, message: 'Account not found' };
  }

  const provider = resolveAccountProvider(row);
  if (!provider) {
    return { ok: false, latencyMs: Date.now() - start, message: 'Provider unavailable' };
  }

  try {
    // Resolve (and refresh) subscription credentials before probing, so an
    // expired OAuth token does not look like a broken account.
    const credential = await resolveAccountCredential(row);
    const proxyUrl = resolveXGatewayAccountProxy(row);

    const ok = await withKeyProxy(proxyUrl, async () => {
      if (provider.supportsKeyValidation) {
        return (await provider.validateKey(credential, { platform: row.platform, keyId: row.id })) === true;
      }
      return true;
    });

    const latencyMs = Date.now() - start;
    setAutoPingSchedule(accountId, {
      lastPingAt: new Date().toISOString(),
      lastPingStatus: ok ? 'ok' : 'error',
    });

    return { ok, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    setAutoPingSchedule(accountId, {
      lastPingAt: new Date().toISOString(),
      lastPingStatus: 'error',
    });
    return { ok: false, latencyMs, message: msg };
  }
}

/**
 * Check if the account should be pinged according to its schedule
 */
export function shouldPingNow(schedule: AutoPingSchedule): boolean {
  if (!schedule.enabled || schedule.mode === 'off') return false;

  const now = new Date();
  if (schedule.mode === 'reset') {
    // Check if pinged in the last 4 hours
    if (schedule.lastPingAt) {
      const last = new Date(schedule.lastPingAt).getTime();
      if (now.getTime() - last < 4 * 3600 * 1000) return false;
    }
    return true;
  }

  if (schedule.mode === 'schedule') {
    const [anchorHour, anchorMin] = schedule.anchor.split(':').map(Number);
    const windowMinutes = (schedule.windowHours || 5) * 60;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const anchorMinutes = (anchorHour || 0) * 60 + (anchorMin || 0);

    const diff = (currentMinutes - anchorMinutes + 1440) % 1440;
    const slotIndex = Math.floor(diff / windowMinutes);

    if (slotIndex < (schedule.slotsPerDay || 3)) {
      const slotStart = (anchorMinutes + slotIndex * windowMinutes) % 1440;
      const minutesSinceSlotStart = (currentMinutes - slotStart + 1440) % 1440;

      // Fire in the first 10 minutes of the slot window
      if (minutesSinceSlotStart < 10) {
        if (schedule.lastPingAt) {
          const last = new Date(schedule.lastPingAt).getTime();
          // Don't re-ping if already pinged in this slot window (last 30m)
          if (now.getTime() - last < 30 * 60 * 1000) return false;
        }
        return true;
      }
    }
  }

  return false;
}

export function startAutoPingWorker(): void {
  if (workerInterval) return;

  workerInterval = setInterval(async () => {
    try {
      for (const [accountId, schedule] of scheduleCache.entries()) {
        if (shouldPingNow(schedule)) {
          await pingAccount(accountId);
        }
      }
    } catch {
      // Ignore background worker errors
    }
  }, 60_000); // Check once per minute

  if (workerInterval.unref) workerInterval.unref();
}

export function stopAutoPingWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

// ---------------------------------------------------------------------
// Express Router
// ---------------------------------------------------------------------

export const autoPingRouter = Router();

autoPingRouter.use(requireAuth, requirePermission('use_x_gateway'));


// ---------------------------------------------------------------------
// Availability (cooldown + quota exhaustion) and bulk auto-ping
// ---------------------------------------------------------------------

const SCHEDULE_KEY_PREFIX = 'x_account_ping_schedule_';
const RATE_LIMIT_WINDOW_ID = 'rate-limit-cooldown';

export interface AvailabilityEntry {
  accountId: number;
  accountLabel: string;
  provider: string;
  model: string | null; // null = every model of the account
  status: 'cooldown' | 'quota_exhausted';
  until: string | null;
  remainingMs: number;
  lastError?: string | null;
}

interface AccountMeta { id: number; label: string; provider: string }
interface QuotaSnapshotRow { account_id: number; snapshot_json: string | null; observed_at: string | null }

function parseWindows(json: string | null | undefined): XQuotaWindow[] {
  try {
    const parsed: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed as XQuotaWindow[] : [];
  } catch {
    return [];
  }
}

function accountMetaMap(): Map<number, AccountMeta> {
  const rows = getDb().prepare('SELECT id, label, provider FROM x_gateway_keys').all() as AccountMeta[];
  return new Map(rows.map(r => [r.id, r]));
}

export function getAvailability(now = Date.now()): { models: AvailabilityEntry[]; unavailableCount: number } {
  const meta = accountMetaMap();
  const describe = (id: number) => ({
    accountLabel: meta.get(id)?.label ?? `Account #${id}`,
    provider: meta.get(id)?.provider ?? '',
  });
  const models: AvailabilityEntry[] = [];
  const seen = new Set<string>();

  for (const e of listCooldownEntries()) {
    seen.add(cooldownKey(e.accountId, e.modelId));
    models.push({
      accountId: e.accountId, ...describe(e.accountId), model: e.modelId,
      status: 'cooldown', until: e.until, remainingMs: e.remainingMs, lastError: e.lastError,
    });
  }

  const snapshots = getDb().prepare('SELECT account_id, snapshot_json, observed_at FROM x_gateway_quota').all() as QuotaSnapshotRow[];
  for (const snap of snapshots) {
    for (const w of parseWindows(snap.snapshot_json)) {
      if (!w.blocking || w.remaining == null || w.remaining > 0) continue;
      if (!isQuotaWindowFresh(w, snap.observed_at, now)) continue;
      const isRateLimit = w.id === RATE_LIMIT_WINDOW_ID;
      // The in-memory cooldown already reports the same 429; do not list it twice.
      if (isRateLimit && seen.has(cooldownKey(snap.account_id, w.modelId ?? null))) continue;
      const untilMs = w.resetAt ? Date.parse(w.resetAt) : NaN;
      models.push({
        accountId: snap.account_id, ...describe(snap.account_id), model: w.modelId ?? null,
        status: isRateLimit ? 'cooldown' : 'quota_exhausted',
        until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null,
        remainingMs: Number.isFinite(untilMs) ? Math.max(0, untilMs - now) : 0,
      });
    }
  }

  models.sort((a, b) => a.accountId - b.accountId || (a.model ?? '').localeCompare(b.model ?? ''));
  return { models, unavailableCount: models.length };
}

export interface ClearCooldownFilter { accountId?: number; provider?: string; model?: string }

export function clearCooldowns(filter: ClearCooldownFilter = {}): { accounts: number; cooldowns: number; quotaWindows: number } {
  const db = getDb();
  const meta = accountMetaMap();
  let ids: number[];
  if (filter.accountId !== undefined) {
    ids = [filter.accountId];
  } else {
    ids = [...new Set([...meta.keys(), ...listCooldownEntries().map(e => e.accountId)])];
  }
  if (filter.provider) ids = ids.filter(id => meta.get(id)?.provider === filter.provider);

  const before = listCooldownEntries().length;
  let quotaWindows = 0;
  for (const id of ids) {
    if (filter.model) {
      // An account-wide cooldown also blocks this model, so it is cleared with it.
      clearAccountCooldown(id, filter.model);
      clearAccountCooldown(id, '');
    } else {
      clearAccountCooldown(id);
    }
    try { clearCooldownsForKey(id); } catch { /* DB-backed cooldown table is best effort */ }

    const row = db.prepare('SELECT snapshot_json FROM x_gateway_quota WHERE account_id = ?').get(id) as { snapshot_json: string | null } | undefined;
    if (!row) continue;
    const windows = parseWindows(row.snapshot_json);
    const kept = windows.filter(w => {
      const blocking = w.blocking && w.remaining != null && w.remaining <= 0;
      const inScope = !filter.model || !w.modelId || w.modelId === filter.model;
      return !(blocking && inScope);
    });
    if (kept.length !== windows.length) {
      quotaWindows += windows.length - kept.length;
      db.prepare('UPDATE x_gateway_quota SET snapshot_json = ? WHERE account_id = ?').run(JSON.stringify(kept), id);
    }
  }
  return { accounts: ids.length, cooldowns: before - listCooldownEntries().length, quotaWindows };
}

export function listAutoPingSchedules(): Array<{ accountId: number; schedule: AutoPingSchedule }> {
  const ids = new Set<number>(scheduleCache.keys());
  try {
    const rows = getDb().prepare('SELECT key FROM settings WHERE key LIKE ?').all(`${SCHEDULE_KEY_PREFIX}%`) as { key: string }[];
    for (const r of rows) {
      const id = Number(r.key.slice(SCHEDULE_KEY_PREFIX.length));
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  } catch {
    // settings table unavailable: fall back to the cache only
  }
  return [...ids].sort((a, b) => a - b).map(accountId => ({ accountId, schedule: getAutoPingSchedule(accountId) }));
}

export async function runAutoPingAll(): Promise<{
  ran: number;
  results: Array<{ accountId: number; ok: boolean; latencyMs: number; message?: string }>;
}> {
  const results = [];
  for (const { accountId, schedule } of listAutoPingSchedules()) {
    if (!schedule.enabled || schedule.mode === 'off') continue;
    results.push({ accountId, ...(await pingAccount(accountId)) });
  }
  return { ran: results.length, results };
}

const clearCooldownSchema = z.object({
  accountId: z.number().int().positive().optional(),
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(300).optional(),
}).strict();


const scheduleUpdateSchema = z.object({
  mode: z.enum(['off', 'reset', 'schedule']).optional(),
  anchor: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowHours: z.number().min(0.5).max(24).optional(),
  slotsPerDay: z.number().int().min(1).max(24).optional(),
  timezone: z.string().max(100).optional(),
}).strict();

autoPingRouter.get('/auto-ping', (_req: Request, res: Response) => {
  const schedules = listAutoPingSchedules();
  const active = schedules.filter(s => s.schedule.enabled && s.schedule.mode !== 'off');
  const lastRunAt = schedules
    .map(s => s.schedule.lastPingAt)
    .filter((v): v is string => !!v)
    .sort()
    .pop() ?? null;
  res.json({ enabled: active.length > 0, activeSchedules: active.length, lastRunAt, schedules });
});

autoPingRouter.post('/auto-ping/run', async (_req: Request, res: Response) => {
  res.json(await runAutoPingAll());
});

autoPingRouter.get('/availability', (_req: Request, res: Response) => {
  res.json(getAvailability());
});

autoPingRouter.post('/cooldowns/clear', (req: Request, res: Response) => {
  const parsed = clearCooldownSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid clear parameters', issues: parsed.error.issues });
    return;
  }
  res.json({ cleared: clearCooldowns(parsed.data), ...getAvailability() });
});

autoPingRouter.get('/cooldowns', (_req: Request, res: Response) => {
  res.json({ cooldowns: getAllCooldowns() });
});

autoPingRouter.get('/:id/auto-ping', (req: Request, res: Response) => {
  const accountId = Number(req.params.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'Invalid account ID' });
    return;
  }
  const schedule = getAutoPingSchedule(accountId);
  const cooldown = getAccountCooldown(accountId);
  res.json({ schedule, cooldown });
});

autoPingRouter.put('/:id/auto-ping', (req: Request, res: Response) => {
  const accountId = Number(req.params.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'Invalid account ID' });
    return;
  }
  const parseResult = scheduleUpdateSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid schedule parameters', issues: parseResult.error.issues });
    return;
  }
  const updated = setAutoPingSchedule(accountId, parseResult.data);
  res.json({ schedule: updated });
});

autoPingRouter.post('/:id/ping', async (req: Request, res: Response) => {
  const accountId = Number(req.params.id);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    res.status(400).json({ error: 'Invalid account ID' });
    return;
  }
  const result = await pingAccount(accountId);
  res.json(result);
});

// Start the worker on module load
startAutoPingWorker();
