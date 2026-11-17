import { getDb } from '../../db/index.js';
import { setConfigValue } from './config.js';
import { listProviderModelConfigs, type ProviderModelConfig } from '../provider-accounts/store.js';
import type { ComboStrategy } from './combos.js';

/** Global routing defaults for Thruline (spec 022), stored in `x_gateway_config`. */
export interface RoutingDefaults {
  /** Account strategy for providers that have no explicit strategy of their own. */
  accountStrategy: 'fallback' | 'round-robin';
  accountStickyLimit: number;
  /** Rotate `fallback` combos too. */
  comboRoundRobin: boolean;
  /** Calls each combo step serves before rotating. */
  comboStickyLimit: number;
}

export const ROUTING_DEFAULTS_KEY = 'routing_defaults';
export const MAX_STICKY_LIMIT = 100;
export const DEFAULT_ROUTING_DEFAULTS: Readonly<RoutingDefaults> = {
  accountStrategy: 'fallback',
  accountStickyLimit: 3,
  comboRoundRobin: false,
  comboStickyLimit: 1,
};

function clampLimit(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_STICKY_LIMIT, Math.max(1, Math.trunc(n)));
}

export function normalizeRoutingDefaults(input: unknown): RoutingDefaults {
  const o = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return {
    accountStrategy: o.accountStrategy === 'round-robin' ? 'round-robin' : 'fallback',
    accountStickyLimit: clampLimit(o.accountStickyLimit, DEFAULT_ROUTING_DEFAULTS.accountStickyLimit),
    comboRoundRobin: o.comboRoundRobin === true,
    comboStickyLimit: clampLimit(o.comboStickyLimit, DEFAULT_ROUTING_DEFAULTS.comboStickyLimit),
  };
}

const CACHE_TTL_MS = 5_000;
let cache: { db: unknown; expiresAt: number; value: RoutingDefaults } | null = null;

export function invalidateRoutingDefaultsCache(): void {
  cache = null;
}

export function getRoutingDefaults(): RoutingDefaults {
  const now = Date.now();
  let db: ReturnType<typeof getDb>;
  try { db = getDb(); } catch { return { ...DEFAULT_ROUTING_DEFAULTS }; }
  if (cache && cache.db === db && now < cache.expiresAt) return cache.value;
  let value = { ...DEFAULT_ROUTING_DEFAULTS };
  try {
    const row = db.prepare('SELECT value FROM x_gateway_config WHERE key = ?').get(ROUTING_DEFAULTS_KEY) as { value: string } | undefined;
    if (row?.value) value = normalizeRoutingDefaults(JSON.parse(row.value));
  } catch { /* A missing or malformed value keeps today's behaviour. */ }
  cache = { db, expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

export function setRoutingDefaults(patch: Partial<RoutingDefaults>, updatedBy?: number): RoutingDefaults {
  const next = normalizeRoutingDefaults({ ...getRoutingDefaults(), ...patch });
  setConfigValue(ROUTING_DEFAULTS_KEY, JSON.stringify(next), updatedBy);
  invalidateRoutingDefaultsCache();
  return next;
}

/**
 * Account policy for one provider. An explicit provider strategy always wins;
 * the global default only fills in providers that never chose one.
 */
export function effectiveProviderPolicy(
  provider: string,
  resolved: Pick<ProviderModelConfig, 'strategy' | 'stickyLimit'>,
  stored: Record<string, ProviderModelConfig> = listProviderModelConfigs(),
): { strategy?: string; stickyLimit?: number } {
  const entry = stored[provider];
  if (entry?.strategy) return { strategy: resolved.strategy, stickyLimit: resolved.stickyLimit };
  const defaults = getRoutingDefaults();
  const sticky = Number.isFinite(entry?.stickyLimit) ? resolved.stickyLimit : defaults.accountStickyLimit;
  return { strategy: defaults.accountStrategy, stickyLimit: sticky };
}

export function shouldRotateCombo(strategy: ComboStrategy, defaults: RoutingDefaults = getRoutingDefaults()): boolean {
  return strategy === 'round-robin' || (strategy === 'fallback' && defaults.comboRoundRobin);
}
