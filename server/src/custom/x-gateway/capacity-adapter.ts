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
  pdf?: CapacityPool;
  videoInput?: CapacityPool;
  search?: CapacityPool;
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
  pdf: {
    enabled: false,
    roundRobin: false,
    models: [],
  },
  videoInput: {
    enabled: false,
    roundRobin: false,
    models: [],
  },
  search: {
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

export function looksLikePdfModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  return /gemini|claude|gpt-4o|gpt-5|gpt-6|mimo|qwen.*vl/i.test(id);
}

export function looksLikeVideoModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  return /gemini|omni|qwen.*vl|mimo-v2-omni/i.test(id);
}

export function looksLikeSearchModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = String(modelId).toLowerCase();
  return /sonar|perplexity|search|grounding|gemini/i.test(id);
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
        pdf: {
          enabled: Boolean(parsed.pdf?.enabled),
          roundRobin: Boolean(parsed.pdf?.roundRobin),
          models: Array.isArray(parsed.pdf?.models) ? parsed.pdf.models.filter(m => typeof m === 'string' && m.trim()) : [],
        },
        videoInput: {
          enabled: Boolean(parsed.videoInput?.enabled),
          roundRobin: Boolean(parsed.videoInput?.roundRobin),
          models: Array.isArray(parsed.videoInput?.models) ? parsed.videoInput.models.filter(m => typeof m === 'string' && m.trim()) : [],
        },
        search: {
          enabled: Boolean(parsed.search?.enabled),
          roundRobin: Boolean(parsed.search?.roundRobin),
          models: Array.isArray(parsed.search?.models) ? parsed.search.models.filter(m => typeof m === 'string' && m.trim()) : [],
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
  pdf: boolean;
  videoInput: boolean;
  search: boolean;
}

export function detectRequiredCapabilities(
  messages: ChatMessage[],
  tools?: Array<Record<string, any>>,
): RequiredCapabilities {
  let vision = false;
  let audioInput = false;
  let pdf = false;
  let videoInput = false;
  let search = false;

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const name = String(tool?.function?.name ?? tool?.name ?? tool?.type ?? '').toLowerCase();
      if (name === 'web_search' || name === 'web_search_preview' || name === 'google_search' || name === 'google_search_retrieval' || name === 'x_search') {
        search = true;
      }
    }
  }

  for (const msg of messages) {
    if (!msg) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, any>;
        const type = String(p.type || '').toLowerCase();
        if (type === 'image_url' || type === 'image' || type === 'input_image' || p.image_url || p.image) {
          vision = true;
        }
        if (type === 'input_audio' || type === 'audio' || type === 'audio_url' || p.input_audio || p.audio) {
          audioInput = true;
        }
        if (type === 'input_video' || type === 'video' || type === 'video_url' || p.video_url || p.video) {
          videoInput = true;
        }
        if (type === 'file' || type === 'document' || type === 'input_file') {
          const mime = String(
            p.file?.mime_type
            ?? p.source?.media_type
            ?? (typeof p.file?.file_data === 'string' ? p.file.file_data.match(/^data:([^;,]+)/)?.[1] : '')
            ?? '',
          ).toLowerCase();
          if (mime.startsWith('image/')) vision = true;
          else if (mime.startsWith('audio/')) audioInput = true;
          else if (mime.startsWith('video/')) videoInput = true;
          else pdf = true;
        }
      }
    } else if (typeof content === 'string') {
      if (content.includes('data:image/') || content.includes('"type":"image_url"')) vision = true;
      if (content.includes('data:application/pdf')) pdf = true;
      if (content.includes('data:video/')) videoInput = true;
    }
    const extra = msg as unknown as Record<string, unknown>;
    if (Array.isArray(extra.images) && extra.images.length > 0) {
      vision = true;
    }
  }

  return { vision, audioInput, pdf, videoInput, search };
}

export interface CandidateRouteLike {
  account: AccountRow & { requests: number; tokens: number };
  modelId: string;
}

export function reorderCandidatesByCapabilities(
  candidates: CandidateRouteLike[],
  req: RequiredCapabilities,
): CandidateRouteLike[] {
  if (candidates.length <= 1) return candidates;
  const hardChecks: Array<(m: string) => boolean> = [];
  if (req.vision) hardChecks.push(looksLikeVisionModel);
  if (req.audioInput) hardChecks.push(looksLikeAudioModel);
  if (req.pdf) hardChecks.push(looksLikePdfModel);
  if (req.videoInput) hardChecks.push(looksLikeVideoModel);
  if (hardChecks.length === 0 && !req.search) return candidates;

  const scoreOf = (m: string): number => {
    const hardOk = hardChecks.every((fn) => fn(m));
    if (!hardOk) return 2;
    if (req.search && !looksLikeSearchModel(m)) return 1;
    return 0;
  };

  return candidates
    .map((c, idx) => ({ c, idx, score: scoreOf(c.modelId) }))
    .sort((a, b) => a.score - b.score || a.idx - b.idx)
    .map((x) => x.c);
}

/**
 * Checks if the existing candidate routes satisfy required modalities.
 * If a required modality (like Vision) is missing from all candidates,
 * prepends eligible adapter candidates from the configured capacity pool.
 */
export function augmentCandidatesWithCapacityAdapter(
  candidates: CandidateRouteLike[],
  messages: ChatMessage[],
  tools?: Array<Record<string, any>>,
): CandidateRouteLike[] {
  const req = detectRequiredCapabilities(messages, tools);
  if (!req.vision && !req.audioInput && !req.pdf && !req.videoInput && !req.search) return candidates;

  const settings = getCapacityAdapterSettings();
  let extra: CandidateRouteLike[] = [];

  if (req.vision && settings.vision.enabled && !candidates.some(c => looksLikeVisionModel(c.modelId))) {
    extra = extra.concat(resolveAdapterPoolCandidates(settings.vision.models, 'vision'));
  }
  if (req.audioInput && settings.audioInput.enabled && !candidates.some(c => looksLikeAudioModel(c.modelId))) {
    extra = extra.concat(resolveAdapterPoolCandidates(settings.audioInput.models, 'audio'));
  }
  if (req.pdf && settings.pdf?.enabled && !candidates.some(c => looksLikePdfModel(c.modelId))) {
    extra = extra.concat(resolveAdapterPoolCandidates(settings.pdf.models, 'pdf'));
  }
  if (req.videoInput && settings.videoInput?.enabled && !candidates.some(c => looksLikeVideoModel(c.modelId))) {
    extra = extra.concat(resolveAdapterPoolCandidates(settings.videoInput.models, 'video'));
  }
  if (req.search && settings.search?.enabled && !candidates.some(c => looksLikeSearchModel(c.modelId))) {
    extra = extra.concat(resolveAdapterPoolCandidates(settings.search.models, 'search'));
  }

  return extra.length > 0 ? [...extra, ...candidates] : candidates;
}

function resolveAdapterPoolCandidates(
  poolModels: string[],
  cap: 'vision' | 'audio' | 'pdf' | 'video' | 'search',
): CandidateRouteLike[] {
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

