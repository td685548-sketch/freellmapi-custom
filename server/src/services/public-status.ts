import { getDb } from '../db/index.js';

export interface PublicModelFamilyStatus {
  id: string;
  name: string;
  count: number;
}

export interface PublicServiceStatus {
  status: 'operational' | 'degraded';
  version: string;
  uptimeSeconds: number;
  uptimeHuman: string;
  timestamp: string;
  models: {
    total: number;
    chat: number;
    embedding: number;
    media: number;
  };
  families: PublicModelFamilyStatus[];
}

const PLATFORM_FAMILY_NAMES: Record<string, string> = {
  openai: 'OpenAI (GPT-4o, o3-mini)',
  anthropic: 'Anthropic (Claude 3.7 / 3.5 Sonnet, Haiku)',
  claude: 'Anthropic Claude',
  google: 'Google Gemini (Gemini 2.5 Pro / Flash)',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek (R1, V3)',
  groq: 'Groq Llama & Mixtral',
  mistral: 'Mistral AI',
  xai: 'xAI Grok',
  qwen: 'Qwen & Alibaba Cloud',
  cohere: 'Cohere Command',
  ollama: 'Local Ollama & Open Weights',
  opencode: 'OpenCode Zen & MiniMax',
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function getPublicServiceStatus(): PublicServiceStatus {
  const db = getDb();
  const uptimeSeconds = Math.floor(process.uptime());

  let totalModels = 0;
  let chatModels = 0;
  let embeddingModels = 0;
  let mediaModels = 0;
  const platformCounts = new Map<string, number>();

  try {
    const chatRows = db.prepare(`
      SELECT platform, COUNT(*) as cnt
      FROM models
      WHERE enabled = 1
      GROUP BY platform
    `).all() as Array<{ platform: string; cnt: number }>;

    for (const r of chatRows) {
      const cnt = Number(r.cnt) || 0;
      chatModels += cnt;
      totalModels += cnt;
      const p = (r.platform || 'other').toLowerCase();
      platformCounts.set(p, (platformCounts.get(p) ?? 0) + cnt);
    }
  } catch {
    // Graceful fallback if models table is busy
  }

  try {
    const embRows = db.prepare(`
      SELECT platform, COUNT(*) as cnt
      FROM embedding_models
      WHERE enabled = 1
      GROUP BY platform
    `).all() as Array<{ platform: string; cnt: number }>;

    for (const r of embRows) {
      const cnt = Number(r.cnt) || 0;
      embeddingModels += cnt;
      totalModels += cnt;
      const p = (r.platform || 'other').toLowerCase();
      platformCounts.set(p, (platformCounts.get(p) ?? 0) + cnt);
    }
  } catch {
    // embedding_models table may not exist in minimal test setups
  }

  try {
    const mediaRows = db.prepare(`
      SELECT platform, COUNT(*) as cnt
      FROM media_models
      WHERE enabled = 1
      GROUP BY platform
    `).all() as Array<{ platform: string; cnt: number }>;

    for (const r of mediaRows) {
      const cnt = Number(r.cnt) || 0;
      mediaModels += cnt;
      totalModels += cnt;
      const p = (r.platform || 'other').toLowerCase();
      platformCounts.set(p, (platformCounts.get(p) ?? 0) + cnt);
    }
  } catch {
    // media_models table may not exist in minimal test setups
  }

  const families: PublicModelFamilyStatus[] = [];
  for (const [platform, count] of platformCounts.entries()) {
    families.push({
      id: platform,
      name: PLATFORM_FAMILY_NAMES[platform] || platform.toUpperCase(),
      count,
    });
  }
  families.sort((a, b) => b.count - a.count);

  return {
    status: totalModels > 0 ? 'operational' : 'degraded',
    version: '0.4.1',
    uptimeSeconds,
    uptimeHuman: formatUptime(uptimeSeconds),
    timestamp: new Date().toISOString(),
    models: {
      total: totalModels,
      chat: chatModels,
      embedding: embeddingModels,
      media: mediaModels,
    },
    families,
  };
}
