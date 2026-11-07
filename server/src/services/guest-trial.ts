import type { Request } from 'express';
import { getDb, getSetting, getUnifiedApiKey, setSetting } from '../db/index.js';
import {
  GUEST_TRIAL_DEFAULTS, GUEST_TRIAL_LIMITS as L, type GuestTrialInfo, type GuestTrialSettings,
} from '@freellmapi/shared/guest-access.js';
import { getGuestPermissions } from './guest-access.js';

// A small chat for signed-out visitors (guest permission try_playground). Every message is one
// loopback call to /v1/chat/completions with the gateway's own key, so it is routed, logged and limited
// like any request. Bounds: per IP per rolling hour (in memory), per UTC day for all visitors together
// (persisted, so a restart does not reset it), output tokens and message length. Nothing is stored:
// the visitor's browser sends the few earlier turns with each message.

const SETTINGS_KEY = 'guest_trial';
const DAY_COUNT_PREFIX = 'guest_trial_count:';
const HOUR_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 60_000;

const clamp = (v: unknown, [min, max]: readonly [number, number], fallback: number) =>
  (typeof v === 'number' && Number.isInteger(v) ? Math.max(min, Math.min(max, v)) : fallback);

export function normalizeTrialSettings(raw: Partial<GuestTrialSettings> | null | undefined): GuestTrialSettings {
  const d = GUEST_TRIAL_DEFAULTS;
  const models = Array.isArray(raw?.models)
    ? [...new Set(raw!.models.filter((m): m is string => typeof m === 'string').map(m => m.trim()).filter(m => m && m.length <= 200))].slice(0, L.maxModels)
    : d.models;
  return {
    perIpPerHour: clamp(raw?.perIpPerHour, L.perIpPerHour, d.perIpPerHour),
    dailyCap: clamp(raw?.dailyCap, L.dailyCap, d.dailyCap),
    maxTokens: clamp(raw?.maxTokens, L.maxTokens, d.maxTokens),
    maxInputChars: clamp(raw?.maxInputChars, L.maxInputChars, d.maxInputChars),
    models,
  };
}

export function getTrialSettings(): GuestTrialSettings {
  try { return normalizeTrialSettings(JSON.parse(getSetting(SETTINGS_KEY) ?? 'null')); } catch { return normalizeTrialSettings(null); }
}

export function setTrialSettings(next: Partial<GuestTrialSettings>): GuestTrialSettings {
  const merged = normalizeTrialSettings({ ...getTrialSettings(), ...next });
  setSetting(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

/** What a visitor is told, or null when the trial is off. */
export function trialInfo(): GuestTrialInfo | null {
  if (!getGuestPermissions().includes('try_playground')) return null;
  const s = getTrialSettings();
  return { models: s.models, perIpPerHour: s.perIpPerHour, maxInputChars: s.maxInputChars };
}

// --- Limits --------------------------------------------------------------------------------------------

const byIp = new Map<string, number[]>();
const MAX_TRACKED = 20_000;

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

function dayCount(now: number): number {
  return Number(getSetting(DAY_COUNT_PREFIX + today(now)) ?? 0) || 0;
}

export type Admission =
  | { ok: true; remainingHour: number; remainingDay: number; commit: () => void; release: () => void }
  | { ok: false; reason: 'ip_hourly' | 'daily_cap'; retryAfterSec: number };

/**
 * Take one message's place for this IP and today, or say why not. The place is held while the answer is
 * produced and handed back if no answer came, so a provider failure does not cost the visitor a message.
 */
export function admitTrial(ip: string, s: GuestTrialSettings, now = Date.now()): Admission {
  const times = (byIp.get(ip) ?? []).filter(t => now - t < HOUR_MS);
  if (times.length >= s.perIpPerHour) {
    return { ok: false, reason: 'ip_hourly', retryAfterSec: Math.max(1, Math.ceil((times[0]! + HOUR_MS - now) / 1000)) };
  }
  const used = dayCount(now);
  if (used >= s.dailyCap) {
    const midnight = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
    return { ok: false, reason: 'daily_cap', retryAfterSec: Math.max(1, Math.ceil((midnight - now) / 1000)) };
  }
  times.push(now);
  byIp.delete(ip);
  byIp.set(ip, times);
  while (byIp.size > MAX_TRACKED) byIp.delete(byIp.keys().next().value!);
  let settled = false;
  return {
    ok: true,
    remainingHour: s.perIpPerHour - times.length,
    remainingDay: s.dailyCap - used - 1,
    commit: () => {
      if (settled) return;
      settled = true;
      const key = DAY_COUNT_PREFIX + today(now);
      getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run(key);
    },
    release: () => {
      if (settled) return;
      settled = true;
      const list = byIp.get(ip);
      const at = list?.lastIndexOf(now) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    },
  };
}

/** Tests only. */
export function resetTrialLimits(): void { byIp.clear(); }

// --- The call -------------------------------------------------------------------------------------------

export interface TrialTurn { role: 'user' | 'assistant'; content: string }
export interface TrialAnswer { ok: boolean; status: number; reply: string | null; model: string | null; error: string | null }

function selfTarget(req: Request): { host: string; port: number } {
  const address = (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
  const host = !address || address === '::' || address === '0.0.0.0' ? '127.0.0.1' : address.includes(':') ? `[${address}]` : address;
  return { host, port: req.socket.localPort ?? 0 };
}

export async function askTrial(req: Request, turns: TrialTurn[], model: string, s: GuestTrialSettings): Promise<TrialAnswer> {
  const { host, port } = selfTarget(req);
  try {
    const res = await fetch(`http://${host}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${getUnifiedApiKey()}`, 'user-agent': 'freellm-guest-trial', host: `127.0.0.1:${port}` },
      body: JSON.stringify({ model, max_tokens: s.maxTokens, messages: turns }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown } }>; model?: unknown; _routed_via?: { model?: string }; error?: { message?: string } } | null;
    const content = body?.choices?.[0]?.message?.content;
    const reply = typeof content === 'string' ? content : null;
    return {
      ok: res.ok && reply !== null,
      status: res.status,
      reply,
      model: body?._routed_via?.model ?? (typeof body?.model === 'string' ? body.model : null),
      error: res.ok ? (reply === null ? 'The model returned no text.' : null) : (body?.error?.message ?? `HTTP ${res.status}`).slice(0, 300),
    };
  } catch (err) {
    return { ok: false, status: 0, reply: null, model: null, error: err instanceof Error && err.name === 'TimeoutError' ? 'No answer in time.' : 'The request could not be sent.' };
  }
}
