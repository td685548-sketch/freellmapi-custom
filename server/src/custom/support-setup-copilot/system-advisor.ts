/**
 * State-aware system advisor for the Setup Copilot.
 *
 * Reads the live system (switches, knowledge documents, embedding keys, the last
 * 24h of request errors) and turns it into recommendations that each carry a
 * reason and the evidence it rests on. Two rules keep it honest:
 *
 *  1. Permission-mirrored: a recommendation is only computed for a setting the
 *     caller may change (same permission the REST route needs). A user who lacks
 *     the permission gets no data about that area at all.
 *  2. Grounded: reasons are built here from measured facts — never from model
 *     text — and say when a number is a heuristic or could not be read.
 *
 * Read-only. Nothing here changes a setting; changes still go through the
 * Consent Card (`system-settings.ts`).
 */
import type {
  SupportSystemSettingAction,
  SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { getDb, getSetting } from '../../db/index.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import type { SessionUser } from '../../services/auth.js';
import { isCacheEnabled } from '../../services/cache.js';
import { getCompressionConfig } from '../../services/compression/config.js';
import { getDefaultFamily, listEmbeddingModels } from '../../services/embeddings.js';
import { getFlags } from '../ai-platform/flags.js';
import { classifyDiagnosticErrorCategory } from './error-doctor.js';
import { REQUIRED_PERMISSION_BY_SETTING } from './system-settings.js';

const KNOWLEDGE_KEY = 'x_gateway_support_knowledge_v1';

/** Heuristic thresholds. Stated in the evidence so nobody mistakes them for hard facts. */
export const ADVISOR_THRESHOLDS = {
  rateLimitMinCount: 5,
  rateLimitMinSharePct: 5,
  highInputMinRequests: 20,
  highInputAvgTokens: 6000,
} as const;

export interface SystemAdviceItem {
  /** Stable id, e.g. `enable_retrieval`. */
  id: string;
  /** `recommend` = a change the caller can propose now; `attention` = something to know, no change offered. */
  kind: 'recommend' | 'attention';
  settingId: SupportSystemSettingId;
  /** Payload to stage through the matching `setting.*` tool (recommend only). */
  payload?: Record<string, unknown>;
  requiredPermission: Permission;
  titleVi: string;
  titleEn: string;
  reasonVi: string;
  reasonEn: string;
  evidence: string[];
}

export interface SystemAdvice {
  items: SystemAdviceItem[];
  /** Areas the caller cannot see because they lack the permission (names the permission, nothing else). */
  hiddenAreas: Array<{ settingId: SupportSystemSettingId; requiredPermission: Permission }>;
  /** Facts that could not be read; shown so a gap is never mistaken for "all good". */
  unreadable: string[];
}

interface KnowledgeStats {
  docs: number;
  tenantsWithDocs: number;
}

function readKnowledgeStats(): KnowledgeStats {
  const raw = getSetting(KNOWLEDGE_KEY);
  if (!raw) return { docs: 0, tenantsWithDocs: 0 };
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return { docs: 0, tenantsWithDocs: 0 };
  let docs = 0;
  let tenantsWithDocs = 0;
  for (const list of Object.values(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const enabled = list.filter((d) => d && typeof d === 'object' && (d as { enabled?: boolean }).enabled !== false).length;
    docs += enabled;
    if (enabled > 0) tenantsWithDocs += 1;
  }
  return { docs, tenantsWithDocs };
}

/** Platforms of the default embedding family that have a usable (enabled, not invalid) provider key. */
function readEmbeddingKeyPlatforms(): { family: string; platformsWithKey: string[]; platformsAll: string[] } {
  const family = getDefaultFamily();
  const rows = listEmbeddingModels().filter((r) => r.family === family && r.enabled === 1);
  const platformsAll = [...new Set(rows.map((r) => r.platform))];
  const db = getDb();
  const withKey = platformsAll.filter((platform) => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM api_keys WHERE platform = ? AND enabled = 1 AND status NOT IN ('invalid', 'disabled')",
      )
      .get(platform) as { c: number } | undefined;
    return Number(row?.c ?? 0) > 0;
  });
  return { family, platformsWithKey: withKey, platformsAll };
}

interface TrafficStats {
  total: number;
  failed: number;
  rateLimited: number;
  avgInputTokens: number;
}

function readTraffic24h(): TrafficStats {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN input_tokens > 0 THEN input_tokens END) AS avgIn
       FROM requests WHERE created_at >= datetime('now', '-24 hours')`,
    )
    .get() as { total: number; failed: number | null; avgIn: number | null } | undefined;
  const errors = db
    .prepare(
      `SELECT error FROM requests
       WHERE status = 'error' AND created_at >= datetime('now', '-24 hours')
       ORDER BY id DESC LIMIT 500`,
    )
    .all() as Array<{ error: string | null }>;
  const rateLimited = errors.filter((e) => classifyDiagnosticErrorCategory(e.error) === 'rate_limit_429').length;
  return {
    total: Number(agg?.total ?? 0),
    failed: Number(agg?.failed ?? 0),
    rateLimited,
    avgInputTokens: Math.round(Number(agg?.avgIn ?? 0)),
  };
}

function safe<T>(label: string, unreadable: string[], fn: () => T): T | null {
  try {
    return fn();
  } catch {
    unreadable.push(label);
    return null;
  }
}

/** Compute advice for `user`. Pure reads; safe to call on every chat turn. */
export function buildSystemAdvice(user: SessionUser | undefined): SystemAdvice {
  const items: SystemAdviceItem[] = [];
  const unreadable: string[] = [];
  const hiddenAreas: SystemAdvice['hiddenAreas'] = [];
  const may = (id: SupportSystemSettingId): boolean => hasPermission(user, REQUIRED_PERMISSION_BY_SETTING[id]);
  const gate = (id: SupportSystemSettingId): boolean => {
    if (may(id)) return true;
    hiddenAreas.push({ settingId: id, requiredPermission: REQUIRED_PERMISSION_BY_SETTING[id] });
    return false;
  };

  // --- AI Platform: document vectorization -------------------------------------------------
  if (gate('ai_platform_pillars')) {
    const perm = REQUIRED_PERMISSION_BY_SETTING.ai_platform_pillars;
    const flags = safe('ai platform flags', unreadable, () => getFlags());
    const knowledge = safe('knowledge documents', unreadable, readKnowledgeStats);
    const embed = safe('embedding provider keys', unreadable, readEmbeddingKeyPlatforms);
    if (flags && knowledge && embed) {
      const hasKey = embed.platformsWithKey.length > 0;
      const keyFact = hasKey
        ? `Embedding family \`${embed.family}\` has a usable key on: ${embed.platformsWithKey.join(', ')}.`
        : `Embedding family \`${embed.family}\` has no usable provider key (looked at: ${embed.platformsAll.join(', ') || 'none enabled'}).`;
      const docFact = `${knowledge.docs} enabled knowledge document(s) across ${knowledge.tenantsWithDocs} tenant(s).`;

      if (!flags.retrieval && knowledge.docs > 0 && hasKey) {
        items.push({
          id: 'enable_retrieval',
          kind: 'recommend',
          settingId: 'ai_platform_pillars',
          payload: { retrieval: true },
          requiredPermission: perm,
          titleVi: 'Bật vector hóa tài liệu (Retrieval)',
          titleEn: 'Turn on document vectorization (Retrieval)',
          reasonVi: `Hiện chỉ khớp từ khóa nên khách hỏi bằng cách diễn đạt khác với tài liệu sẽ dễ bị bỏ sót. Hệ thống đang có ${knowledge.docs} tài liệu tri thức (${knowledge.tenantsWithDocs} tenant) và đã có key embedding dùng được, nên bật Retrieval sẽ vector hóa chúng và tìm kết hợp từ khóa + ngữ nghĩa. Đổi lại, nội dung tài liệu được gửi tới nhà cung cấp embedding và tốn hạn mức của họ; nếu lỗi hoặc chưa lập chỉ mục xong, chat tự quay về tìm từ khóa.`,
          reasonEn: `Today only keyword matching runs, so a customer who words a question differently from the document is easily missed. The system has ${knowledge.docs} knowledge document(s) (${knowledge.tenantsWithDocs} tenant(s)) and a usable embedding key, so turning Retrieval on vectorizes them and searches by keyword + meaning. In return, document text is sent to the embedding provider and uses its quota; if that fails or indexing is not finished, chat falls back to keyword search.`,
          evidence: [docFact, keyFact, 'Retrieval switch is currently off.'],
        });
      } else if (!flags.retrieval && knowledge.docs > 0 && !hasKey) {
        items.push({
          id: 'retrieval_needs_embedding_key',
          kind: 'attention',
          settingId: 'ai_platform_pillars',
          requiredPermission: perm,
          titleVi: 'Chưa thể bật Retrieval: thiếu key embedding',
          titleEn: 'Cannot usefully turn on Retrieval yet: no embedding key',
          reasonVi: `Có ${knowledge.docs} tài liệu tri thức nhưng chưa có key nhà cung cấp embedding dùng được, nên bật Retrieval lúc này sẽ không tạo được vector (chat vẫn chỉ tìm từ khóa). Hãy thêm key cho một nhà cung cấp embedding trước (trang \`/keys\` hoặc \`/thruline/providers\`), rồi bật Retrieval.`,
          reasonEn: `There are ${knowledge.docs} knowledge document(s) but no usable embedding provider key, so turning Retrieval on now would not produce vectors (chat would still be keyword-only). Add a key for an embedding provider first (\`/keys\` or \`/thruline/providers\`), then turn Retrieval on.`,
          evidence: [docFact, keyFact],
        });
      } else if (flags.retrieval && !hasKey) {
        items.push({
          id: 'retrieval_on_without_key',
          kind: 'attention',
          settingId: 'ai_platform_pillars',
          requiredPermission: perm,
          titleVi: 'Retrieval đang bật nhưng thiếu key embedding',
          titleEn: 'Retrieval is on but there is no embedding key',
          reasonVi: 'Công tắc Retrieval đã bật nhưng không có key embedding dùng được, nên hệ thống không lập được chỉ mục vector và đang tự lùi về tìm từ khóa.',
          reasonEn: 'The Retrieval switch is on but no usable embedding key exists, so no vector index can be built and search falls back to keywords.',
          evidence: [docFact, keyFact, 'Retrieval switch is currently on.'],
        });
      }
    }
  }

  // --- Response cache vs. rate-limit pressure; compression vs. very long prompts -----------
  const traffic = (may('response_cache') || may('prompt_compression'))
    ? safe('last-24h request statistics', unreadable, readTraffic24h)
    : null;

  if (gate('response_cache') && traffic) {
    const share = traffic.total > 0 ? Math.round((traffic.rateLimited / traffic.total) * 100) : 0;
    if (
      !safe('response cache state', unreadable, isCacheEnabled) &&
      traffic.rateLimited >= ADVISOR_THRESHOLDS.rateLimitMinCount &&
      share >= ADVISOR_THRESHOLDS.rateLimitMinSharePct
    ) {
      items.push({
        id: 'enable_response_cache',
        kind: 'recommend',
        settingId: 'response_cache',
        payload: { enabled: true },
        requiredPermission: REQUIRED_PERMISSION_BY_SETTING.response_cache,
        titleVi: 'Bật Response Cache để giảm lỗi 429',
        titleEn: 'Turn on Response Cache to ease 429s',
        reasonVi: `${traffic.rateLimited}/${traffic.total} lượt gọi trong 24 giờ qua (${share}%) bị giới hạn tốc độ (429). Response Cache trả lời ngay các prompt giống hệt mà không gọi nhà cung cấp nên giảm số lượt chạm trần. Lưu ý nó chỉ giúp khi có prompt lặp lại y hệt; nếu lưu lượng toàn prompt mới thì hiệu quả thấp.`,
        reasonEn: `${traffic.rateLimited} of ${traffic.total} requests in the last 24h (${share}%) were rate-limited (429). Response Cache answers identical prompts without calling a provider, so fewer requests hit the ceiling. It only helps when prompts repeat exactly; with all-new prompts the benefit is small.`,
        evidence: [
          `${traffic.rateLimited} rate-limited of ${traffic.total} requests in 24h (${share}%).`,
          `Heuristic: suggested only at >= ${ADVISOR_THRESHOLDS.rateLimitMinCount} rate-limited requests and >= ${ADVISOR_THRESHOLDS.rateLimitMinSharePct}% share.`,
          'Response Cache is currently off.',
        ],
      });
    }
  }

  if (gate('prompt_compression') && traffic) {
    const mode = safe('compression mode', unreadable, () => getCompressionConfig().mode);
    if (
      mode === 'off' &&
      traffic.total >= ADVISOR_THRESHOLDS.highInputMinRequests &&
      traffic.avgInputTokens >= ADVISOR_THRESHOLDS.highInputAvgTokens
    ) {
      items.push({
        id: 'enable_prompt_compression',
        kind: 'recommend',
        settingId: 'prompt_compression',
        payload: { mode: 'lossless' },
        requiredPermission: REQUIRED_PERMISSION_BY_SETTING.prompt_compression,
        titleVi: 'Bật nén prompt chế độ an toàn (lossless)',
        titleEn: 'Turn on safe prompt compression (lossless)',
        reasonVi: `Prompt đầu vào trung bình khoảng ${traffic.avgInputTokens} token trên ${traffic.total} lượt gọi trong 24 giờ qua. Nén ở chế độ \`lossless\` chỉ bỏ phần dư thừa nên không làm mất nội dung, vừa giảm token vừa giảm nguy cơ chạm giới hạn token mỗi phút. Chế độ \`standard\`/\`aggressive\` tiết kiệm hơn nhưng có thể mất chi tiết.`,
        reasonEn: `Input prompts average about ${traffic.avgInputTokens} tokens across ${traffic.total} requests in the last 24h. \`lossless\` compression only strips redundancy, so no content is lost while it cuts tokens and the chance of hitting tokens-per-minute limits. \`standard\`/\`aggressive\` save more but can drop detail.`,
        evidence: [
          `Average input ${traffic.avgInputTokens} tokens over ${traffic.total} requests in 24h.`,
          `Heuristic: suggested only at >= ${ADVISOR_THRESHOLDS.highInputMinRequests} requests and >= ${ADVISOR_THRESHOLDS.highInputAvgTokens} average input tokens.`,
          'Prompt compression is currently off.',
        ],
      });
    }
  }

  return { items, hiddenAreas, unreadable };
}

/** Prompt section: live advice for this caller, bounded in size. Empty when the caller can change none of these areas. */
export function buildSystemAdvicePromptSection(user: SessionUser | undefined, locale: 'vi' | 'en'): string {
  let advice: SystemAdvice;
  try {
    advice = buildSystemAdvice(user);
  } catch {
    return '';
  }
  const mayAny = (['ai_platform_pillars', 'response_cache', 'prompt_compression'] as const).some((id) =>
    hasPermission(user, REQUIRED_PERMISSION_BY_SETTING[id]),
  );
  if (!mayAny) return '';

  const head =
    'LIVE SYSTEM ADVICE (measured just now from this system; permission-filtered for this caller; reasons below are ground truth — quote their numbers, never invent others):';
  const lines: string[] = [head];
  if (advice.items.length === 0) {
    lines.push(
      '- No change is recommended right now. If the user asks "should I change X?", say what you measured and that nothing currently argues for it.',
    );
  }
  for (const item of advice.items) {
    const title = locale === 'vi' ? item.titleVi : item.titleEn;
    const reason = locale === 'vi' ? item.reasonVi : item.reasonEn;
    const how =
      item.kind === 'recommend'
        ? `You MAY stage it with tool setting.${item.settingId} input ${JSON.stringify(item.payload)} (Consent Card; nothing applies until the user approves).`
        : 'Informational: no change can fix this directly.';
    lines.push(`- [${item.id}] ${title}. ${how}\n  Why: ${reason}\n  Evidence: ${item.evidence.join(' ')}`);
  }
  if (advice.unreadable.length > 0) {
    lines.push(`- Could NOT be read just now: ${advice.unreadable.join(', ')}. Say so instead of assuming it is fine.`);
  }
  lines.push(
    '- When the user asks WHY a change is suggested, explain with the Why/Evidence above and the trade-off; offer to stage it only if it is listed as something you MAY stage.',
  );
  return lines.join('\n');
}

/**
 * Attach the advisor's reason + evidence to a proposed action card when the
 * proposal matches a recommendation (same setting, payload within the
 * recommended keys). The reason is therefore always advisor-built, never model text.
 */
export function attachAdviceToActions(
  actions: SupportSystemSettingAction[],
  user: SessionUser | undefined,
): SupportSystemSettingAction[] {
  if (actions.length === 0) return actions;
  let advice: SystemAdvice;
  try {
    advice = buildSystemAdvice(user);
  } catch {
    return actions;
  }
  return actions.map((action) => {
    const match = advice.items.find(
      (item) =>
        item.kind === 'recommend' &&
        item.settingId === action.settingId &&
        item.payload !== undefined &&
        Object.entries(action.payload ?? {}).every(([k, v]) => item.payload![k] === v),
    );
    if (!match) return action;
    return { ...action, reasonVi: match.reasonVi, reasonEn: match.reasonEn, evidence: match.evidence };
  });
}
