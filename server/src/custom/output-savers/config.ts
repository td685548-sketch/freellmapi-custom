import { z } from 'zod';
import { getSetting, setSetting } from '../../db/index.js';
import { SAVER_LEVELS, SAVER_NAMES, type SaverLevel, type SaverName } from './prompts.js';

export const SAVERS_SETTING = 'output_savers';

export type OutputSaverLevels = Record<SaverName, SaverLevel>;

export type SaverSource = 'setting' | 'env' | 'default';

const OFF_LEVELS: OutputSaverLevels = { caveman: 'off', ponytail: 'off' };

const levelSchema = z.enum(SAVER_LEVELS);

const storedSchema = z.object({
  // Optional rather than defaulted: a stored value written before a saver
  // existed must leave that saver to the environment instead of pinning it off.
  caveman: levelSchema.optional(),
  ponytail: levelSchema.optional(),
});

export const outputSaversUpdateSchema = z.object({
  caveman: levelSchema.optional(),
  ponytail: levelSchema.optional(),
}).strict();

export type OutputSaversUpdate = z.infer<typeof outputSaversUpdateSchema>;

const levelRank: Record<SaverLevel, number> = { off: 0, lite: 1, full: 2, ultra: 3 };

export function isSaverLevel(value: unknown): value is SaverLevel {
  return typeof value === 'string' && (SAVER_LEVELS as readonly string[]).includes(value);
}

function envLevel(name: SaverName): SaverLevel {
  const raw = process.env[`FREELLMAPI_${name.toUpperCase()}`]?.trim().toLowerCase();
  return isSaverLevel(raw) ? raw : 'off';
}

function storedLevels(): Partial<OutputSaverLevels> {
  let raw: string | undefined;
  try {
    raw = getSetting(SAVERS_SETTING);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    return storedSchema.parse(JSON.parse(raw));
  } catch {
    // An unreadable value must not change what a request looks like: fall back
    // to every saver off.
    return {};
  }
}

export interface OutputSaverSettings {
  levels: OutputSaverLevels;
  sources: Record<SaverName, SaverSource>;
}

// Every chat request asks what the savers should do, including the overwhelmingly
// common case of "nothing". Reading the setting each time would be a blocking
// round trip on a remote driver, so serve a snapshot that a local write
// invalidates at once and a 5 s TTL re-reads — a change made by another process
// still lands, and no request pays for the query.
const SNAPSHOT_TTL_MS = 5_000;

interface Snapshot extends OutputSaverSettings {
  loadedAtMs: number;
}

let snapshot: Snapshot | null = null;

export function invalidateOutputSaverSnapshot(): void {
  snapshot = null;
}

function loadSnapshot(): Snapshot {
  const now = Date.now();
  if (snapshot && now - snapshot.loadedAtMs < SNAPSHOT_TTL_MS) return snapshot;
  const stored = storedLevels();
  const levels = { ...OFF_LEVELS };
  const sources: Record<SaverName, SaverSource> = { caveman: 'default', ponytail: 'default' };
  for (const name of SAVER_NAMES) {
    const value = stored[name];
    if (value !== undefined) {
      levels[name] = value;
      sources[name] = 'setting';
      continue;
    }
    const fromEnv = envLevel(name);
    if (fromEnv !== 'off') {
      levels[name] = fromEnv;
      sources[name] = 'env';
    }
  }
  snapshot = { levels, sources, loadedAtMs: now };
  return snapshot;
}

export function readOutputSaverSettings(): OutputSaverSettings {
  return loadSnapshot();
}

export function getOutputSaverLevels(): OutputSaverLevels {
  return loadSnapshot().levels;
}

export function setOutputSaverLevels(update: OutputSaversUpdate): OutputSaverLevels {
  const parsed = outputSaversUpdateSchema.parse(update);
  const current = loadSnapshot().levels;
  const next: OutputSaverLevels = {
    caveman: parsed.caveman ?? current.caveman,
    ponytail: parsed.ponytail ?? current.ponytail,
  };
  setSetting(SAVERS_SETTING, JSON.stringify(next));
  invalidateOutputSaverSnapshot();
  return next;
}

/**
 * `X-FreeLLM-Saver` accepts `off`, `caveman=lite`, `ponytail=ultra`,
 * `caveman=off,ponytail=lite`, or a bare level that ceilings every saver.
 * Anything unrecognised is `default`, which leaves the operator setting alone.
 */
export type SaverDirective =
  | { kind: 'default' }
  | { kind: 'off' }
  | { kind: 'levels'; levels: Partial<OutputSaverLevels> };

const OFF_TOKENS = /^(off|no|0|false|bypass|skip|none)$/;

export function parseSaverDirective(header: string | string[] | undefined): SaverDirective {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  if (!raw || raw === 'default' || raw === 'on' || raw === 'yes' || raw === '1' || raw === 'true') {
    return { kind: 'default' };
  }
  if (OFF_TOKENS.test(raw)) return { kind: 'off' };

  const levels: Partial<OutputSaverLevels> = {};
  for (const segment of raw.split(',')) {
    const token = segment.trim();
    if (!token) continue;
    if (isSaverLevel(token)) {
      // A bare level is a ceiling for both savers, never a floor.
      for (const name of SAVER_NAMES) levels[name] = token;
      continue;
    }
    if (OFF_TOKENS.test(token)) return { kind: 'off' };
    const [name, value] = token.split('=', 2).map(part => part?.trim());
    if (!name || !value || !isSaverLevel(value)) continue;
    if ((SAVER_NAMES as readonly string[]).includes(name)) levels[name as SaverName] = value;
  }
  return Object.keys(levels).length > 0 ? { kind: 'levels', levels } : { kind: 'default' };
}

/**
 * A request can reduce or disable a saver but never raise one, so a caller
 * cannot spend operator-enabled tokens the operator did not agree to, and
 * cannot turn a style on for a deployment that kept it off.
 */
export function resolveSaverLevels(
  config: OutputSaverLevels,
  directive: SaverDirective,
): OutputSaverLevels {
  if (directive.kind === 'off') return { ...OFF_LEVELS };
  if (directive.kind === 'default') return config;
  const resolved = { ...config };
  for (const name of SAVER_NAMES) {
    const requested = directive.levels[name];
    if (requested === undefined) continue;
    if (levelRank[requested] < levelRank[config[name]]) resolved[name] = requested;
  }
  return resolved;
}
