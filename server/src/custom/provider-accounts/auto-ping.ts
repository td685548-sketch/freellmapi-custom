import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getSetting, setSetting } from '../../db/index.js';
import { accountRow, resolveXGatewayAccountProxy } from './store.js';
import { resolveXGatewayProvider } from './catalog.js';
import { decrypt } from '../../lib/crypto.js';
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

// In-memory Cooldown storage (accountId -> ISO expiration string)
const cooldownMap = new Map<number, number>();

// In-memory schedules cache (synced to DB settings)
const scheduleCache = new Map<number, AutoPingSchedule>();

let workerInterval: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------
// Cooldown Management
// ---------------------------------------------------------------------

export function setAccountCooldown(accountId: number, durationMsOrUntil: number | string): void {
  const untilMs = typeof durationMsOrUntil === 'string'
    ? new Date(durationMsOrUntil).getTime()
    : Date.now() + durationMsOrUntil;

  cooldownMap.set(accountId, untilMs);
}

export function getAccountCooldown(accountId: number): {
  inCooldown: boolean;
  until: string | null;
  remainingMs: number;
} {
  const expiry = cooldownMap.get(accountId);
  if (!expiry) {
    return { inCooldown: false, until: null, remainingMs: 0 };
  }
  const remaining = expiry - Date.now();
  if (remaining <= 0) {
    cooldownMap.delete(accountId);
    return { inCooldown: false, until: null, remainingMs: 0 };
  }
  return {
    inCooldown: true,
    until: new Date(expiry).toISOString(),
    remainingMs: remaining,
  };
}

export function clearAccountCooldown(accountId: number): void {
  cooldownMap.delete(accountId);
}

export function getAllCooldowns(): Record<number, string> {
  const now = Date.now();
  const res: Record<number, string> = {};
  for (const [id, expiry] of cooldownMap.entries()) {
    if (expiry > now) {
      res[id] = new Date(expiry).toISOString();
    } else {
      cooldownMap.delete(id);
    }
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

  const provider = resolveXGatewayProvider(row.provider, row.base_url);
  if (!provider) {
    return { ok: false, latencyMs: Date.now() - start, message: 'Provider unavailable' };
  }

  try {
    const credential = decrypt(row.encrypted_key, row.iv, row.auth_tag);
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

const scheduleUpdateSchema = z.object({
  mode: z.enum(['off', 'reset', 'schedule']).optional(),
  anchor: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  windowHours: z.number().min(0.5).max(24).optional(),
  slotsPerDay: z.number().int().min(1).max(24).optional(),
  timezone: z.string().max(100).optional(),
}).strict();

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
