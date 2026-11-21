/**
 * AI Platform pillar switches as one Copilot "system setting" (`ai_platform_pillars`).
 *
 * Mirrors `PUT /api/ai-platform/flags` (permission `edit_ai_flags`): any subset of
 * the six pillars can be set to true/false, keys that are left out keep their value.
 * Kept in its own file so `system-settings.ts` only needs small hook points.
 */
import { PILLARS, type Pillar } from '@freellmapi/shared/ai-platform.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import type { SupportSystemSettingAction } from '@freellmapi/shared/support-setup-copilot.js';
import { getFlags, setFlags } from '../ai-platform/flags.js';

export type PillarPatch = Partial<Record<Pillar, boolean>>;

interface PillarLabel {
  vi: string;
  en: string;
  /** Accent-folded phrases that name this pillar in a request. */
  keywords: RegExp;
}

export const PILLAR_LABELS: Readonly<Record<Pillar, PillarLabel>> = {
  retrieval: {
    vi: 'Tìm kiếm ngữ nghĩa / vector hóa tài liệu (Retrieval)',
    en: 'Semantic retrieval / document vectorization (Retrieval)',
    keywords:
      /\b(?:retrieval|rag|tim\s+kiem\s+(?:ngu\s+nghia|vector)|vector\s*hoa|embedding|semantic\s+(?:search|retrieval)|knowledge\s+retrieval)\b/,
  },
  prompts: {
    vi: 'Thư viện Prompt (Prompts)',
    en: 'Prompt library (Prompts)',
    keywords: /\b(?:prompt\s+(?:library|registry|studio)|thu\s+vien\s+prompt|ai\s+platform\s+prompts?)\b/,
  },
  promptCache: {
    vi: 'Prompt Cache ngữ nghĩa',
    en: 'Semantic Prompt Cache',
    keywords: /\b(?:prompt\s+cache|cache\s+prompt|bo\s+nho\s+dem\s+prompt|semantic\s+cache)\b/,
  },
  mcpClient: {
    vi: 'MCP Client (kết nối công cụ ngoài)',
    en: 'MCP Client (external tool servers)',
    keywords: /\b(?:mcp\s+client|external\s+mcp|ket\s+noi\s+mcp\s+ben\s+ngoai)\b/,
  },
  outputGuard: {
    vi: 'Output Guard (kiểm duyệt đầu ra AI Platform)',
    en: 'Output Guard (AI Platform output policy)',
    keywords: /\b(?:output\s+guard|bao\s+ve\s+dau\s+ra\s+ai|rao\s+dau\s+ra\s+ai)\b/,
  },
  orchestrator: {
    vi: 'Orchestrator (điều phối luồng agent)',
    en: 'Orchestrator (agent flows)',
    keywords: /\b(?:orchestrator|dieu\s+phoi\s+(?:agent|luong\s+agent))\b/,
  },
};

/** True when the (accent-folded) text names any AI Platform pillar. */
export function mentionsAnyPillar(foldedText: string): boolean {
  return PILLARS.some((p) => PILLAR_LABELS[p].keywords.test(foldedText));
}

/** Keep only known pillars with real booleans. Anything else is dropped, never coerced. */
export function normalizePillarPatch(raw: Record<string, unknown> | undefined): PillarPatch {
  const out: PillarPatch = {};
  if (!raw) return out;
  for (const pillar of PILLARS) {
    if (typeof raw[pillar] === 'boolean') out[pillar] = raw[pillar] as boolean;
  }
  return out;
}

/** The part of a patch that would actually change something. */
export function effectivePillarPatch(patch: PillarPatch): PillarPatch {
  const current = getFlags();
  const out: PillarPatch = {};
  for (const pillar of PILLARS) {
    if (patch[pillar] !== undefined && patch[pillar] !== current[pillar]) out[pillar] = patch[pillar];
  }
  return out;
}

function onOffVi(v: boolean): string {
  return v ? 'bật' : 'tắt';
}
function onOffEn(v: boolean): string {
  return v ? 'on' : 'off';
}

export function buildPillarsAction(
  rawPayload: Record<string, unknown>,
  requiredPermission: Permission,
  canApply: boolean,
): SupportSystemSettingAction {
  const patch = normalizePillarPatch(rawPayload);
  const current = getFlags();
  const changed = PILLARS.filter((p) => patch[p] !== undefined);
  const list = (lang: 'vi' | 'en', pick: (p: Pillar) => boolean): string =>
    changed.length === 0
      ? lang === 'vi'
        ? '(không đổi)'
        : '(no change)'
      : changed
          .map((p) => `${PILLAR_LABELS[p][lang]}: ${lang === 'vi' ? onOffVi(pick(p)) : onOffEn(pick(p))}`)
          .join('; ');

  return {
    settingId: 'ai_platform_pillars',
    requiredPermission,
    canApply,
    enabledByDefault: canApply,
    titleVi: 'Công tắc AI Platform',
    titleEn: 'AI Platform switches',
    summaryVi:
      'Bật/tắt các trụ cột AI Platform (vector hóa tài liệu, prompt cache, output guard…). Tắt đi vẫn giữ dữ liệu, bật lại là khôi phục cấu hình cũ.',
    summaryEn:
      'Turn AI Platform pillars on or off (document vectorization, prompt cache, output guard…). Turning one off keeps its data; turning it back on restores the previous configuration.',
    currentValueVi: list('vi', (p) => current[p]),
    currentValueEn: list('en', (p) => current[p]),
    proposedValueVi: list('vi', (p) => patch[p] as boolean),
    proposedValueEn: list('en', (p) => patch[p] as boolean),
    payload: patch as Record<string, unknown>,
  };
}

export function applyPillarsPatch(
  rawPayload: Record<string, unknown>,
): { detailVi: string; detailEn: string; changed: Pillar[] } {
  const patch = normalizePillarPatch(rawPayload);
  const changed = PILLARS.filter((p) => patch[p] !== undefined);
  if (changed.length === 0) {
    return { detailVi: 'Không có công tắc AI Platform nào cần đổi.', detailEn: 'No AI Platform switch needed changing.', changed };
  }
  setFlags(patch);
  return {
    detailVi: `Đã cập nhật công tắc AI Platform: ${changed.map((p) => `${PILLAR_LABELS[p].vi} → ${onOffVi(patch[p] as boolean)}`).join('; ')}.`,
    detailEn: `Updated AI Platform switches: ${changed.map((p) => `${PILLAR_LABELS[p].en} → ${onOffEn(patch[p] as boolean)}`).join('; ')}.`,
    changed,
  };
}

/** Deterministic parse of "bật retrieval", "tắt prompt cache"… from one folded clause. */
export function parsePillarsFromClause(
  foldedClause: string,
  polarity: 'enable' | 'disable' | 'set' | null,
): PillarPatch | null {
  if (polarity !== 'enable' && polarity !== 'disable') return null;
  const patch: PillarPatch = {};
  for (const pillar of PILLARS) {
    if (PILLAR_LABELS[pillar].keywords.test(foldedClause)) patch[pillar] = polarity === 'enable';
  }
  return Object.keys(patch).length > 0 ? patch : null;
}
