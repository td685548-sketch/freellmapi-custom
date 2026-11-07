import type { ChatMessage } from '@freellmapi/shared/types.js';
import { getDb } from '../../db/index.js';
import { getUsableXGatewayKeys, accountModels, type AccountRow } from '../provider-accounts/store.js';
import { normalizeXGatewayProviderId } from '../provider-accounts/catalog.js';

export interface CapacityPool {
  enabled: boolean;
  roundRobin: boolean;
  models: string[];
}

export interface CapacityAdapterSettings {
  vision: CapacityPool;
  audioInput: CapacityPool;
}

export const DEFAULT_CAPACITY_ADAPTER: CapacityAdapterSettings = {
  vision: {
    enabled: true,
    roundRobin: false,
    models: ['oc/mimo-v2.6-flash-free'],
  },
  audioInput: {
    enabled: false,
    roundRobin: false,
    models: [],
  },
};

const SEP = '[-_/:.]';
const NOT_VISION = new RegExp(
  [
    `(^|${SEP})(image|img)(${SEP}|$)`,
    'stable-image', 'gen[0-9]_image', 'nanobanana', 'imagine',
    't2v', 'i2v', 'flux', 'dall', 'sdxl', 'diffusion',
    'embed', 'rerank', 'guard', 'moderation',
    'tts', 'stt', 'whisper', 'voice', 'speech', 'audio',
  ].join('|'),
  'i',
);

const VISION_NAME = new RegExp(
  [
    `(^|${SEP})(vision|vl|vlm|multimodal|omni|visual|mimo)(${SEP}|$)`,
    'gpt-4o', 'gpt-4-turbo', 'claude-3', 'gemini', 'o1', 'o3',
    `[0-9]\\.[0-9]+v(${SEP}|$)`,
    `(^|${SEP})glm-[0-9]+v(${SEP}|$)`,
    '(^|[-_/:.])(llava|pixtral|internvl|cogvlm|minicpm-v|moondream|idefics|fuyu)',
  ].join('|'),
  'i',
);

export function looksLikeVisionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  if (NOT_VISION.test(id)) return false;
  return VISION_NAME.test(id);
}

export function looksLikeAudioModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  return /audio|voice|speech|whisper|omni/i.test(id);
}

let cachedSettings: CapacityAdapterSettings | null = null;

export function getCapacityAdapterSettings(): CapacityAdapterSettings {
  if (cachedSettings) return cachedSettings;
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM x_gateway_config WHERE key = ?').get('capacity_adapter') as { value: string } | undefined;
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Partial<CapacityAdapterSettings>;
      cachedSettings = {
        vision: {
          enabled: parsed.vision?.enabled !== false,
          roundRobin: Boolean(parsed.vision?.roundRobin),
          models: Array.isArray(parsed.vision?.models) ? parsed.vision.models.filter(m => typeof m === 'string' && m.trim()) : DEFAULT_CAPACITY_ADAPTER.vision.models,
        },
        audioInput: {
          enabled: Boolean(parsed.audioInput?.enabled),
          roundRobin: Boolean(parsed.audioInput?.roundRobin),
          models: Array.isArray(parsed.audioInput?.models) ? parsed.audioInput.models.filter(m => typeof m === 'string' && m.trim()) : [],
        },
      };
      return cachedSettings;
    }
  } catch {
    // fallback
  }
  return DEFAULT_CAPACITY_ADAPTER;
}

export function setCapacityAdapterSettings(settings: CapacityAdapterSettings, userId?: number): void {
  const db = getDb();
  const value = JSON.stringify(settings);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO x_gateway_config (key, value, updated_at, updated_by)
    VALUES ('capacity_adapter', ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(value, now, userId ?? null);
  cachedSettings = settings;
}

export interface RequiredCapabilities {
  vision: boolean;
  audioInput: boolean;
}

export function detectRequiredCapabilities(messages: ChatMessage[]): RequiredCapabilities {
  let vision = false;
  let audioInput = false;

  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        const type = String(p.type || '').toLowerCase();
        if (type === 'image_url' || type === 'image' || p.image_url || p.image) {
          vision = true;
        }
        if (type === 'input_audio' || type === 'audio' || p.input_audio || p.audio) {
          audioInput = true;
        }
      }
    } else if (typeof content === 'string') {
      if (content.includes('data:image/') || content.includes('"type":"image_url"')) {
        vision = true;
      }
    }
    const extra = msg as unknown as Record<string, unknown>;
    if (Array.isArray(extra.images) && extra.images.length > 0) {
      vision = true;
    }
  }

  return { vision, audioInput };
}

export interface CandidateRouteLike {
  account: AccountRow & { requests: number; tokens: number };
  modelId: string;
}

/**
 * Checks if the existing candidate routes satisfy required modalities.
 * If a required modality (like Vision) is missing from all candidates,
 * prepends eligible adapter candidates from the configured capacity pool.
 */
export function augmentCandidatesWithCapacityAdapter(
  candidates: CandidateRouteLike[],
  messages: ChatMessage[],
): CandidateRouteLike[] {
  const req = detectRequiredCapabilities(messages);
  if (!req.vision && !req.audioInput) return candidates;

  const settings = getCapacityAdapterSettings();

  // 1. Check vision
  if (req.vision && settings.vision.enabled) {
    const hasVisionAlready = candidates.some(c => looksLikeVisionModel(c.modelId));
    if (!hasVisionAlready) {
      const adapterCandidates = resolveAdapterPoolCandidates(settings.vision.models, 'vision');
      if (adapterCandidates.length > 0) {
        return [...adapterCandidates, ...candidates];
      }
    }
  }

  // 2. Check audio
  if (req.audioInput && settings.audioInput.enabled) {
    const hasAudioAlready = candidates.some(c => looksLikeAudioModel(c.modelId));
    if (!hasAudioAlready) {
      const adapterCandidates = resolveAdapterPoolCandidates(settings.audioInput.models, 'audio');
      if (adapterCandidates.length > 0) {
        return [...adapterCandidates, ...candidates];
      }
    }
  }

  return candidates;
}

function resolveAdapterPoolCandidates(poolModels: string[], cap: 'vision' | 'audio'): CandidateRouteLike[] {
  const usable = getUsableXGatewayKeys();
  const result: CandidateRouteLike[] = [];

  for (const m of poolModels) {
    const trimmed = m.trim();
    if (!trimmed) continue;
    const slash = trimmed.indexOf('/');
    const providerHint = slash > 0 ? trimmed.slice(0, slash).toLowerCase() : '';
    const modelName = slash > 0 ? trimmed.slice(slash + 1).toLowerCase() : trimmed.toLowerCase();

    for (const acc of usable) {
      const accProvider = normalizeXGatewayProviderId(acc.provider) ?? acc.provider.toLowerCase();
      if (providerHint && accProvider !== providerHint && acc.provider.toLowerCase() !== providerHint) {
        continue;
      }
      const models = accountModels(acc);
      const match = models.find(mod => mod.id.toLowerCase() === modelName || mod.id.toLowerCase().includes(modelName));
      if (match) {
        result.push({
          account: acc as AccountRow & { requests: number; tokens: number },
          modelId: match.id,
        });
      } else if (cap === 'vision' && looksLikeVisionModel(modelName)) {
        // Direct candidate
        result.push({
          account: acc as AccountRow & { requests: number; tokens: number },
          modelId: slash > 0 ? trimmed.slice(slash + 1) : trimmed,
        });
      }
    }
  }

  return result;
}

