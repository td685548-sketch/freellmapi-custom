import crypto from 'node:crypto';
import type {
  CopilotActionProposal,
  CopilotActionRoutingMode,
  CopilotActionType,
  CopilotEffectiveRoutingMode,
  CopilotExecuteActionRequest,
  CopilotExecuteActionResponse,
  CopilotIdeConfigSnippets,
  CopilotOnboardingChecklist,
  CopilotOnboardingStepId,
  SupportSetupChatResponse,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getDb } from '../../db/index.js';
import type { SessionUser } from '../../services/auth.js';
import { getStarterQuotaConfig } from '../../services/starter-quota.js';
import { listUserApiKeys, mintUserApiKey } from '../../services/user-keys.js';
import {
  CustomerAiError,
  listAssistantsForCustomer,
  normalizeRoutingMode,
  updateUserKeyAiConfig,
} from '../customer-ai/store.js';
import { SupportSetupCopilotError } from './store.js';

export const MAX_ACTIVE_PERSONAL_KEYS = 20;

const VALID_ACTION_ROUTING_MODES = new Set<CopilotActionRoutingMode>(['eco', 'balanced', 'max']);

export function foldVietnameseAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanOrigin(rawOrigin: string): string {
  return rawOrigin.trim().replace(/\/+$/, '').replace(/\/v1$/i, '') || 'http://127.0.0.1:3001';
}

export function buildIdeConfigSnippets(
  serverOrigin: string,
  rawKey: string,
): CopilotIdeConfigSnippets {
  const gatewayBaseUrl = cleanOrigin(serverOrigin);
  const openAiBaseUrl = `${gatewayBaseUrl}/v1`;

  const cursor = [
    '# Cursor Settings -> Models -> OpenAI API Key & Override OpenAI Base URL',
    `OpenAI Base URL: ${openAiBaseUrl}`,
    `OpenAI API Key:  ${rawKey}`,
    'Model:           auto',
  ].join('\n');

  const claudeCode = JSON.stringify(
    {
      env: {
        ANTHROPIC_BASE_URL: gatewayBaseUrl,
        ANTHROPIC_AUTH_TOKEN: rawKey,
        ANTHROPIC_MODEL: 'auto',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'auto',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'auto',
      },
    },
    null,
    2,
  );

  const openCode = [
    '// 1) ~/.config/opencode/opencode.json',
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'freellmapi/auto',
        provider: {
          freellmapi: {
            npm: '@ai-sdk/openai-compatible',
            name: 'FreeLLMAPI',
            options: { baseURL: openAiBaseUrl },
            models: {
              auto: { name: 'Auto', limit: { context: 128000, output: 8192 } },
            },
          },
        },
      },
      null,
      2,
    ),
    '',
    '// 2) ~/.local/share/opencode/auth.json',
    JSON.stringify(
      {
        freellmapi: { type: 'api', key: rawKey },
      },
      null,
      2,
    ),
  ].join('\n');

  return {
    gatewayBaseUrl,
    openAiBaseUrl,
    cursor,
    claudeCode,
    openCode,
  };
}

/**
 * Computes the live 3-step Member Onboarding checklist strictly scoped to `userId`.
 */
export function buildOnboardingChecklist(userId: number): CopilotOnboardingChecklist {
  const db = getDb();
  const activeKeys = listUserApiKeys(userId).filter((k) => !k.revoked);
  const hasActiveKey = activeKeys.length > 0;
  const hasUsedPersonalKey = activeKeys.some((k) => Boolean(k.lastUsedAt));

  const reqSignals = db
    .prepare(
      `SELECT
         COUNT(*) AS totalCount,
         COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successCount,
         COALESCE(SUM(CASE
           WHEN (client_agent IS NOT NULL AND trim(client_agent) <> '')
             OR (caller IS NOT NULL AND trim(caller) <> '' AND caller <> 'playground')
           THEN 1 ELSE 0
         END), 0) AS ideTrafficCount
       FROM requests
       WHERE user_id = ?`,
    )
    .get(userId) as
    | { totalCount: number; successCount: number; ideTrafficCount: number }
    | undefined;

  const hasPlaygroundOrTestCall = Number(reqSignals?.successCount ?? 0) > 0;
  const hasIdeConnection =
    hasUsedPersonalKey || Number(reqSignals?.ideTrafficCount ?? 0) > 0;

  const steps: CopilotOnboardingChecklist['steps'] = [
    {
      stepNumber: 1,
      id: 'mint_personal_key',
      completed: hasActiveKey,
      titleEn: '1. Mint Personal API Key',
      titleVi: '1. Tạo Personal API Key cá nhân',
      descriptionEn: hasActiveKey
        ? `${activeKeys.length} active personal key(s) ready (${activeKeys[0]!.keyPrefix}).`
        : 'Generate your private sk-flm-… key with Eco, Balanced, or Max smart routing.',
      descriptionVi: hasActiveKey
        ? `Đã có ${activeKeys.length} khóa cá nhân đang hoạt động (${activeKeys[0]!.keyPrefix}).`
        : 'Tạo khóa riêng sk-flm-… gắn chế độ định tuyến Eco, Balanced hoặc Max.',
      ctaLabelEn: hasActiveKey ? 'Manage Keys' : 'Mint Key Now',
      ctaLabelVi: hasActiveKey ? 'Quản lý Key' : 'Tạo Key ngay',
      targetPath: '/agents',
    },
    {
      stepNumber: 2,
      id: 'test_in_playground',
      completed: hasPlaygroundOrTestCall,
      titleEn: '2. Test in Playground / AI Hub',
      titleVi: '2. Chat thử trên Playground / AI Hub',
      descriptionEn: hasPlaygroundOrTestCall
        ? 'Verified! Your account has completed live AI inference calls.'
        : 'Send a quick test prompt in Playground or AI Hub to verify model responses.',
      descriptionVi: hasPlaygroundOrTestCall
        ? 'Đã xác nhận! Tài khoản của bạn đã chạy thử nghiệm gọi model thành công.'
        : 'Gửi thử 1 tin nhắn trên Playground hoặc AI Hub để kiểm tra phản hồi AI.',
      ctaLabelEn: 'Open AI Hub',
      ctaLabelVi: 'Mở AI Hub',
      targetPath: '/assistants',
    },
    {
      stepNumber: 3,
      id: 'connect_ide',
      completed: hasIdeConnection,
      titleEn: '3. Connect Your Coding IDE',
      titleVi: '3. Kết nối IDE lập trình (Cursor / Claude Code / OpenCode)',
      descriptionEn: hasIdeConnection
        ? 'Connected! Live API key traffic detected from your external client/IDE.'
        : 'Paste your personal key & gateway URL into Cursor, Claude Code, or OpenCode.',
      descriptionVi: hasIdeConnection
        ? 'Đã kết nối! Hệ thống đã ghi nhận lưu lượng gọi từ IDE / công cụ bên ngoài.'
        : 'Dán Personal Key & địa chỉ cổng vào Cursor, Claude Code hoặc OpenCode.',
      ctaLabelEn: 'IDE Setup Guides',
      ctaLabelVi: 'Cấu hình IDE',
      targetPath: '/agents',
    },
  ];

  const completedCount = steps.filter((s) => s.completed).length;

  return {
    completedCount,
    totalCount: 3,
    steps,
  };
}

export function buildCreatePersonalKeyProposal(params: {
  name?: string;
  routingMode?: CopilotActionRoutingMode;
  assistantId?: number | null;
  assistantName?: string | null;
}): CopilotActionProposal {
  const name = (params.name?.trim() || 'Copilot Personal Key').slice(0, 80);
  const routingMode: CopilotActionRoutingMode =
    params.routingMode && VALID_ACTION_ROUTING_MODES.has(params.routingMode)
      ? params.routingMode
      : 'balanced';
  const assistantId = params.assistantId ?? null;
  const assistantName = params.assistantName ?? null;

  const modeLabelVi =
    routingMode === 'eco'
      ? 'Eco (nhanh & tiết kiệm quota)'
      : routingMode === 'max'
        ? 'Max (ưu tiên model mạnh nhất)'
        : 'Balanced (cân bằng tốc độ & chất lượng)';
  const modeLabelEn =
    routingMode === 'eco'
      ? 'Eco (fast & quota-saving)'
      : routingMode === 'max'
        ? 'Max (top-reasoning quality)'
        : 'Balanced (optimal speed & quality)';

  const assistantSuffixVi = assistantName ? ` · gắn trợ lý "${assistantName}"` : '';
  const assistantSuffixEn = assistantName ? ` · bound to "${assistantName}"` : '';

  return {
    id: `act_${crypto.randomUUID()}`,
    actionType: 'create_personal_key',
    requiresConfirmation: true,
    titleEn: `Mint New Personal API Key ("${name}")`,
    titleVi: `Tạo Personal API Key mới ("${name}")`,
    summaryEn: `Creates a private sk-flm-… key for your account with ${modeLabelEn} routing${assistantSuffixEn} and generates ready-to-copy Cursor, Claude Code, and OpenCode snippets.`,
    summaryVi: `Tạo khóa riêng sk-flm-… cho tài khoản của bạn với chế độ ${modeLabelVi}${assistantSuffixVi}, kèm cấu hình dán ngay cho Cursor, Claude Code và OpenCode.`,
    confirmLabelEn: 'Confirm & Run',
    confirmLabelVi: 'Xác nhận & Chạy',
    params: {
      name,
      routingMode,
      assistantId,
      assistantName,
    },
  };
}

export function buildSwitchKeyRoutingModeProposal(params: {
  keyId: number;
  keyName: string;
  keyPrefix: string;
  fromRoutingMode: CopilotEffectiveRoutingMode;
  routingMode: CopilotActionRoutingMode;
}): CopilotActionProposal {
  const { keyId, keyName, keyPrefix, fromRoutingMode, routingMode } = params;
  return {
    id: `act_${crypto.randomUUID()}`,
    actionType: 'switch_key_routing_mode',
    requiresConfirmation: true,
    titleEn: `Switch Key "${keyName}" to ${routingMode.toUpperCase()} Mode`,
    titleVi: `Chuyển Key "${keyName}" sang chế độ ${routingMode.toUpperCase()}`,
    summaryEn: `Updates your active Personal API Key (${keyPrefix}) from "${fromRoutingMode}" to "${routingMode}" routing mode.`,
    summaryVi: `Cập nhật Personal API Key đang hoạt động (${keyPrefix}) từ chế độ "${fromRoutingMode}" sang "${routingMode}".`,
    confirmLabelEn: 'Confirm & Run',
    confirmLabelVi: 'Xác nhận & Chạy',
    params: {
      keyId,
      keyName,
      keyPrefix,
      fromRoutingMode,
      routingMode,
    },
  };
}

export function buildOpenOnboardingGuideProposal(params: {
  userId: number;
  focusStep?: CopilotOnboardingStepId;
}): CopilotActionProposal {
  const checklist = buildOnboardingChecklist(params.userId);
  return {
    id: `act_${crypto.randomUUID()}`,
    actionType: 'open_onboarding_guide',
    requiresConfirmation: true,
    titleEn: `Member 3-Step Onboarding Checklist (${checklist.completedCount}/3 complete)`,
    titleVi: `Checklist 3 bước bắt đầu cho Thành viên (${checklist.completedCount}/3 hoàn tất)`,
    summaryEn:
      'Interactive checklist tracking your live progress: 1. Mint Personal Key -> 2. Test in Playground/AI Hub -> 3. Connect IDE.',
    summaryVi:
      'Bảng hướng dẫn tương tác theo trạng thái thực tế của tài khoản: 1. Tạo Personal Key -> 2. Thử trên Playground/AI Hub -> 3. Kết nối IDE.',
    confirmLabelEn: 'Confirm & Run',
    confirmLabelVi: 'Xác nhận & Chạy',
    params: {
      ...(params.focusStep ? { focusStep: params.focusStep } : {}),
    },
    onboardingPreview: checklist,
  };
}

function parseRequestedRoutingMode(text: string, folded: string): CopilotActionRoutingMode | undefined {
  if (/\beco\b|tiet\s+kiem/i.test(folded)) return 'eco';
  if (/\bmax\b|toi\s+da|smartest/i.test(folded)) return 'max';
  if (/\bbalanced\b|can\s+bang/i.test(folded)) return 'balanced';
  if (/tiết\s+kiệm/i.test(text)) return 'eco';
  return undefined;
}

function parseRequestedKeyName(raw: string, folded: string): string {
  const quoted = /["“'`]([^"”'`\n]{2,48})["”'`]/.exec(raw);
  if (quoted?.[1]?.trim()) {
    return quoted[1].trim().slice(0, 60);
  }
  const namedMatch =
    /(?:ten\s+la|named|called|label(?:ed)?)\s+([A-Za-z0-9 _.-]{2,40})/i.exec(folded);
  if (namedMatch?.[1]?.trim()) {
    return namedMatch[1].trim().slice(0, 60);
  }
  if (/\bcursor\b/i.test(folded)) return 'Cursor Key';
  if (/\bclaude(?:\s*code)?\b/i.test(folded)) return 'Claude Code Key';
  if (/\bopencode\b/i.test(folded)) return 'OpenCode Key';
  if (/\bcodex\b/i.test(folded)) return 'Codex Key';
  return 'Personal IDE Key';
}

/** True when the message asks to switch a key's routing mode (with or without naming which key). */
export function isSwitchKeyModeRequest(rawMessage: string): boolean {
  const folded = foldVietnameseAscii(rawMessage.trim());
  if (!folded || EXCLUDE_TENANT_SETUP_RE.test(folded)) return false;
  return SWITCH_KEY_MODE_VI_RE.test(folded) || SWITCH_KEY_MODE_EN_RE.test(folded);
}

/**
 * Hex fragments the user explicitly used to point at a key. The key list shows keys masked as
 * `sk-flm-6025…c359`, so people write "…c359", "...c359", "sk-flm-6025…c359" or "key c359".
 * Only explicit references count; a stray number elsewhere in the sentence is ignored.
 */
export function extractKeyReferences(rawMessage: string): string[] {
  const text = rawMessage.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:sk-flm-|[\u2026*\u2022]|\.{2,})\s*([0-9a-f]{3,24})/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\bkeys?\s+([0-9a-f]{4,24})\b/g)) {
    if (/\d/.test(m[1]!)) out.add(m[1]!);
  }
  return [...out];
}

/** A masked prefix looks like `sk-flm-6025…c359`: the first and last characters are all that is shown. */
function keyMatchesReference(keyPrefix: string, fragment: string): boolean {
  const lower = keyPrefix.toLowerCase().replace(/^sk-flm-/, '');
  const [head = '', tail = ''] = lower.split('\u2026');
  return head.startsWith(fragment) || tail.endsWith(fragment) || `${head}${tail}`.includes(fragment);
}

export function findKeysByReference<K extends { keyPrefix: string }>(keys: readonly K[], rawMessage: string): { referenced: boolean; matches: K[] } {
  const refs = extractKeyReferences(rawMessage);
  if (refs.length === 0) return { referenced: false, matches: [] };
  return { referenced: true, matches: keys.filter((k) => refs.some((f) => keyMatchesReference(k.keyPrefix, f))) };
}

export interface MatchedUserActionIntent {
  actionType: CopilotActionType;
  proposal: CopilotActionProposal;
  noteVi?: string;
  noteEn?: string;
}

const EXCLUDE_TENANT_SETUP_RE =
  /\b(?:ai\s+support|support\s+tenant|tenant|widget|service\s+desk|7\s*(?:buoc|steps?))\b/i;

const INFORMATIONAL_HOWTO_GUARD_RE =
  /^(?:lam\s+sao|nhu\s+the\s+nao|o\s+dau|cach\s+nao|how\s+(?:do\s+i|to|can\s+i)|where\s+(?:do\s+i|to|can\s+i)|what\s+is)\b/i;

const CREATE_PERSONAL_KEY_VI_RE =
  /\b(?:tao|cap|sinh|mint|khoi\s+tao)\s+(?:giup\s+(?:minh|toi|em)\s+|cho\s+(?:minh|toi|em)\s+)?(?:mot\s+|1\s+|them\s+)?(?:personal\s*(?:api\s*)?keys?|api\s*keys?(?:\s+ca\s+nhan|\s+moi|\s+rieng)?|keys?\s+(?:ca\s+nhan|moi|ide|cursor|claude|opencode)|khoa\s+(?:api|ca\s+nhan|moi))\b|\b(?:tao|cap|mint)\s+(?:api\s*)?keys?\s+(?:giup|cho)\s+(?:minh|toi|em)\b/i;

const CREATE_PERSONAL_KEY_EN_RE =
  /\b(?:create|mint|generate|issue|make)\s+(?:me\s+|for\s+me\s+)?(?:a\s+|an\s+|another\s+|new\s+)?(?:personal\s*(?:api\s*)?key|api\s*key|ide\s*key|member\s*key)\b/i;

const SWITCH_KEY_MODE_VI_RE =
  /\b(?:chuyen|doi|dat|bat|set|cap\s+nhat)\s+(?:che\s+do\s+|routing(?:\s*mode)?\s+)?(?:tat\s+ca\s+|cac\s+|cua\s+)?(?:personal\s*|api\s*)?(?:keys?|khoa)[\s\w"'\u2026.*\u2022:,-]{0,48}?\b(?:sang|qua|thanh|ve|len|o\s+che\s+do)\s+(?:che\s+do\s+)?(?:eco|balanced|max|tiet\s+kiem|can\s+bang|toi\s+da)\b|\b(?:bat|chuyen\s+sang|doi\s+sang)\s+(?:che\s+do\s+)?(?:eco|balanced|max)(?:\s+mode)?\s+(?:cho\s+)?(?:personal\s*|api\s*)?(?:keys?|khoa)\b/i;

const SWITCH_KEY_MODE_EN_RE =
  /\b(?:switch|change|set|update|move|turn)\s+(?:my\s+|the\s+|active\s+|personal\s+)?(?:api\s*)?keys?[\s\w"'\u2026.*\u2022:,-]{0,48}?\b(?:to|into|on)\s+(?:eco|balanced|max)(?:\s+(?:mode|routing|tier))?\b|\b(?:enable|activate|use)\s+(?:eco|balanced|max)\s+(?:routing\s+)?mode\s+(?:on|for)\s+(?:my\s+|the\s+)?(?:personal\s+)?(?:api\s*)?keys?\b/i;

const ONBOARDING_GUIDE_VI_RE =
  /\b(?:mo\s+|xem\s+|cho\s+(?:minh|toi)\s+xem\s+)?(?:huong\s+dan|checklist|lo\s+trinh)\s+(?:nguoi\s+moi|thanh\s+vien(?:\s+moi)?|onboarding|3\s*buoc(?:\s+bat\s+dau)?|bat\s+dau)\b|\b(?:minh|toi)\s+(?:moi\s+tao\s+tai\s+khoan|la\s+nguoi\s+moi|la\s+thanh\s+vien\s+moi)\b|\bbat\s+dau\s+su\s+dung\s+(?:tai\s+khoan|cong\s+api)\s+(?:nhu\s+the\s+nao|ra\s+sao|tu\s+dau)\b/i;

const ONBOARDING_GUIDE_EN_RE =
  /\b(?:open|show|view|launch|start)?\s*(?:the\s+|my\s+)?(?:member\s+|new\s+user\s+|3[-\s]*step\s+)?onboarding\s+(?:guide|checklist|steps)\b|\bgetting\s+started\s+checklist\b|\bhow\s+do\s+i\s+get\s+started\s+as\s+a\s+(?:new\s+)?member\b/i;

/**
 * Matches explicit self-service user action intents (`create_personal_key`,
 * `switch_key_routing_mode`, `open_onboarding_guide`) without mutating state.
 */
export function matchUserActionIntent(
  rawMessage: string,
  user: SessionUser,
): MatchedUserActionIntent | null {
  const trimmed = rawMessage.trim();
  if (!trimmed) return null;
  const folded = foldVietnameseAscii(trimmed);

  if (EXCLUDE_TENANT_SETUP_RE.test(folded)) {
    return null;
  }

  // 1. Switch existing personal key routing mode
  if (SWITCH_KEY_MODE_VI_RE.test(folded) || SWITCH_KEY_MODE_EN_RE.test(folded)) {
    const targetMode = parseRequestedRoutingMode(trimmed, folded) ?? 'eco';
    const activeKeys = listUserApiKeys(user.userId).filter((k) => !k.revoked);

    if (activeKeys.length === 0) {
      const fallbackCreate = buildCreatePersonalKeyProposal({
        name: 'Personal IDE Key',
        routingMode: targetMode,
      });
      return {
        actionType: 'create_personal_key',
        proposal: fallbackCreate,
        noteVi: `Hiện tài khoản của bạn chưa có Personal API Key nào đang hoạt động, nên mình chuẩn bị sẵn thẻ **Tạo Personal API Key mới** gắn luôn chế độ **${targetMode.toUpperCase()}** cho bạn nhé!`,
        noteEn: `You don't have an active Personal API Key yet, so I've prepared a **Create Personal API Key** card pre-set to **${targetMode.toUpperCase()}** mode for your confirmation!`,
      };
    }

    const byReference = findKeysByReference(activeKeys, trimmed);
    // The user pointed at a specific key. Switch exactly that one, or nothing: guessing could change a
    // key they did not mean. The router asks which key when this returns null (see buildKeyClarificationResponse).
    if (byReference.referenced && byReference.matches.length !== 1) return null;
    const matchedByName = byReference.matches[0] ?? activeKeys.find(
      (k) =>
        folded.includes(foldVietnameseAscii(k.name)) ||
        trimmed.toLowerCase().includes(k.keyPrefix.slice(0, 10).toLowerCase()),
    );
    const chosen =
      matchedByName ??
      activeKeys.find((k) => k.routingMode !== targetMode) ??
      activeKeys[0]!;

    return {
      actionType: 'switch_key_routing_mode',
      proposal: buildSwitchKeyRoutingModeProposal({
        keyId: chosen.id,
        keyName: chosen.name,
        keyPrefix: chosen.keyPrefix,
        fromRoutingMode: normalizeRoutingMode(chosen.routingMode, 'default'),
        routingMode: targetMode,
      }),
    };
  }

  // 2. Mint / create a new Personal API Key (skip pure informational "how do I get an api key?" questions)
  if (
    !INFORMATIONAL_HOWTO_GUARD_RE.test(folded) &&
    (CREATE_PERSONAL_KEY_VI_RE.test(folded) || CREATE_PERSONAL_KEY_EN_RE.test(folded))
  ) {
    const routingMode = parseRequestedRoutingMode(trimmed, folded) ?? 'balanced';
    const keyName = parseRequestedKeyName(trimmed, folded);

    let assistantId: number | null = null;
    let assistantName: string | null = null;
    try {
      const catalog = listAssistantsForCustomer({
        isGuest: false,
        isAdmin: user.role === 'admin',
      });
      const matchedAssistant = catalog.find(
        (a) =>
          folded.includes(a.slug.toLowerCase()) ||
          folded.includes(foldVietnameseAscii(a.name)),
      );
      if (matchedAssistant) {
        assistantId = matchedAssistant.id;
        assistantName = matchedAssistant.name;
      }
    } catch {
      // Optional assistant catalog lookup
    }

    return {
      actionType: 'create_personal_key',
      proposal: buildCreatePersonalKeyProposal({
        name: keyName,
        routingMode,
        assistantId,
        assistantName,
      }),
    };
  }

  // 3. Open 3-step Member Onboarding checklist
  if (ONBOARDING_GUIDE_VI_RE.test(folded) || ONBOARDING_GUIDE_EN_RE.test(folded)) {
    return {
      actionType: 'open_onboarding_guide',
      proposal: buildOpenOnboardingGuideProposal({ userId: user.userId }),
    };
  }

  return null;
}

/**
 * The user named a key by its masked tail/head, but it matched none of their active keys (or several).
 * Instead of guessing, show the active keys so they can pick one. Returns null when there is nothing to ask.
 */
export function buildKeyClarificationResponse(params: {
  message: string;
  user: SessionUser;
  locale: 'vi' | 'en';
}): SupportSetupChatResponse | null {
  const { message, user, locale } = params;
  if (!isSwitchKeyModeRequest(message)) return null;
  const activeKeys = listUserApiKeys(user.userId).filter((k) => !k.revoked);
  if (activeKeys.length === 0) return null;
  const { referenced, matches } = findKeysByReference(activeKeys, message);
  if (!referenced || matches.length === 1) return null;

  const folded = foldVietnameseAscii(message.trim());
  const mode = (parseRequestedRoutingMode(message.trim(), folded) ?? 'eco').toUpperCase();
  const shown = (matches.length > 1 ? matches : activeKeys).slice(0, 8);
  const refs = extractKeyReferences(message).map((r) => `\`${r}\``).join(', ');
  const list = shown
    .map((k) => `- **${k.name}** (\`${k.keyPrefix}\` · ${locale === 'vi' ? 'chế độ' : 'mode'} \`${normalizeRoutingMode(k.routingMode, 'default')}\`)`)
    .join('\n');

  const reply =
    locale === 'vi'
      ? matches.length === 0
        ? `Mình không thấy Personal API Key nào đang bật của bạn có phần ${refs} nên **chưa đổi gì** (mình không đoán key để tránh đổi nhầm). Các key đang bật của bạn:\n${list}\n\nBạn chọn đúng key giúp mình nhé.`
        : `Có ${matches.length} key khớp với ${refs} nên mình **chưa đổi gì**. Bạn chọn đúng key giúp mình:\n${list}`
      : matches.length === 0
        ? `None of your active Personal API Keys contains ${refs}, so I **changed nothing** (I will not guess a key and risk switching the wrong one). Your active keys:\n${list}\n\nPlease pick the exact key.`
        : `${matches.length} keys match ${refs}, so I **changed nothing**. Please pick the exact key:\n${list}`;

  return {
    ok: true,
    replyLocale: locale,
    reply,
    intent: 'guide',
    missingQuestions: [],
    suggestedQuickReplies: shown
      .slice(0, 4)
      .map((k) => (locale === 'vi' ? `Chuyển key ${k.keyPrefix} sang ${mode}` : `Switch key ${k.keyPrefix} to ${mode}`)),
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}

export function buildActionProposalChatResponse(params: {
  matched: MatchedUserActionIntent;
  locale: 'vi' | 'en';
}): SupportSetupChatResponse {
  const { matched, locale } = params;
  const { proposal } = matched;

  let reply: string;
  let suggestedQuickReplies: string[];

  if (proposal.actionType === 'create_personal_key') {
    const p = proposal.params as { name: string; routingMode?: CopilotActionRoutingMode };
    reply =
      matched.noteVi && locale === 'vi'
        ? `${matched.noteVi}\n\nMình chưa tự ý tạo khóa — bạn kiểm tra thông tin bên dưới rồi bấm **Xác nhận & Chạy** để nhận khóa một lần kèm cấu hình Cursor / Claude Code / OpenCode nhé.`
        : matched.noteEn && locale === 'en'
          ? `${matched.noteEn}\n\nNothing has been created yet — review the action card below and click **Confirm & Run** to mint your one-time key and copy your IDE snippets.`
          : locale === 'vi'
            ? `Mình đã chuẩn bị sẵn thao tác tạo **Personal API Key ("${p.name}")** ở chế độ **${(p.routingMode ?? 'balanced').toUpperCase()}**. Hệ thống **chưa tạo khóa** cho đến khi bạn bấm nút **Xác nhận & Chạy** bên dưới — ngay sau khi xác nhận, mình sẽ hiển thị khóa gốc một lần kèm cấu hình copy ngay cho **Cursor**, **Claude Code** và **OpenCode** nhé!`
            : `I have prepared the action to mint your **Personal API Key ("${p.name}")** with **${(p.routingMode ?? 'balanced').toUpperCase()}** routing. **No key has been created yet** — click **Confirm & Run** below to generate your one-time key alongside ready-to-copy **Cursor**, **Claude Code**, and **OpenCode** configs!`;
    suggestedQuickReplies =
      locale === 'vi'
        ? ['Kiểm tra sức khỏe tài khoản giúp mình', 'Mở checklist 3 bước cho thành viên mới']
        : ['Diagnose my account health', 'Open 3-step member onboarding checklist'];
  } else if (proposal.actionType === 'switch_key_routing_mode') {
    const p = proposal.params as {
      keyName: string;
      keyPrefix: string;
      fromRoutingMode: string;
      routingMode: CopilotActionRoutingMode;
    };
    reply =
      locale === 'vi'
        ? `Mình đã chuẩn bị thao tác chuyển khóa **${p.keyName}** (\`${p.keyPrefix}\`) từ chế độ **${p.fromRoutingMode}** sang **${p.routingMode.toUpperCase()}**. Chưa có thay đổi nào được ghi — bạn bấm **Xác nhận & Chạy** ở thẻ bên dưới để áp dụng ngay nhé!`
        : `I have staged switching your key **${p.keyName}** (\`${p.keyPrefix}\`) from **${p.fromRoutingMode}** to **${p.routingMode.toUpperCase()}** mode. Nothing has changed yet — click **Confirm & Run** on the card below to apply it!`;
    suggestedQuickReplies =
      locale === 'vi'
        ? ['Kiểm tra lại lỗi & hạn mức tài khoản', 'Tạo thêm 1 Personal API Key mới']
        : ['Check my account diagnostics', 'Create another Personal API Key'];
  } else {
    const done = proposal.onboardingPreview?.completedCount ?? 0;
    reply =
      locale === 'vi'
        ? `Đây là **Checklist 3 bước bắt đầu** dành cho tài khoản của bạn (hiện đã hoàn tất **${done}/3** bước trực tiếp từ dữ liệu thực tế). Bạn có thể xem tiến độ bên dưới hoặc bấm **Xác nhận & Chạy** để làm mới & mở lối tắt từng bước nhé!`
        : `Here is your live **3-Step Member Onboarding Checklist** (**${done}/3** steps completed based on your real account activity). Review your progress below or click **Confirm & Run** to refresh and jump right into the next step!`;
    suggestedQuickReplies =
      locale === 'vi'
        ? ['Tạo Personal API Key mới giúp mình', 'Kiểm tra tài khoản & chẩn đoán lỗi API']
        : ['Create a Personal API Key for me', 'Diagnose my account & API errors'];
  }

  return {
    ok: true,
    replyLocale: locale,
    reply,
    intent: 'propose_action',
    missingQuestions: [],
    suggestedQuickReplies,
    proposal: null,
    userDiagnostic: null,
    actionProposal: proposal,
    modelUsed: null,
    usedFallback: true,
  };
}

/**
 * Executes a consent-gated Copilot user action strictly scoped to `user.userId`.
 */
export function executeCopilotUserAction(params: {
  user: SessionUser;
  body: CopilotExecuteActionRequest;
  serverOrigin: string;
}): CopilotExecuteActionResponse {
  const { user, body, serverOrigin } = params;

  if (body.confirmed !== true) {
    throw new SupportSetupCopilotError(
      400,
      'confirmation_required',
      'Explicit user confirmation (confirmed: true) is required before executing an action.',
    );
  }

  const db = getDb();
  const liveUser = db
    .prepare('SELECT id, role FROM users WHERE id = ?')
    .get(user.userId) as { id: number; role: string } | undefined;

  if (!liveUser) {
    throw new SupportSetupCopilotError(
      401,
      'authentication_required',
      'User account no longer exists.',
    );
  }

  const liveRole: 'admin' | 'member' = liveUser.role === 'admin' ? 'admin' : 'member';

  if (body.actionType === 'create_personal_key') {
    const existingKeys = listUserApiKeys(user.userId);
    const activeKeys = existingKeys.filter((k) => !k.revoked);

    if (activeKeys.length >= MAX_ACTIVE_PERSONAL_KEYS) {
      throw new SupportSetupCopilotError(
        400,
        'key_limit_reached',
        `You already have ${activeKeys.length} active Personal API Keys (maximum ${MAX_ACTIVE_PERSONAL_KEYS}). Please revoke an unused key first.`,
      );
    }

    const rawMode = body.params?.routingMode;
    if (rawMode !== undefined && !VALID_ACTION_ROUTING_MODES.has(rawMode)) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_routing_mode',
        'Routing mode must be eco, balanced, or max.',
      );
    }
    const routingMode: CopilotActionRoutingMode = rawMode ?? 'balanced';
    const keyName = (body.params?.name?.trim() || 'Copilot Personal Key').slice(0, 100);
    const assistantId =
      body.params?.assistantId !== undefined ? body.params.assistantId : null;

    // Preserve any admin-configured or starter-quota RPM cap on the user's account
    const inheritedRpm =
      activeKeys.length > 0
        ? Math.min(...activeKeys.map((k) => k.rpmLimit || 60))
        : liveRole === 'member'
          ? getStarterQuotaConfig().rpmLimit
          : 60;

    let created: ReturnType<typeof mintUserApiKey>;
    try {
      created = mintUserApiKey(user.userId, keyName, {
        routingMode,
        assistantId,
        callerRole: liveRole,
      });
    } catch (err) {
      if (err instanceof CustomerAiError) {
        throw new SupportSetupCopilotError(err.status, err.code, err.message);
      }
      throw err;
    }

    if (inheritedRpm !== 60 && Number.isFinite(inheritedRpm) && inheritedRpm > 0) {
      db.prepare('UPDATE user_api_keys SET rpm_limit = ? WHERE id = ? AND user_id = ?').run(
        Math.max(1, Math.min(1000, Math.floor(inheritedRpm))),
        created.id,
        user.userId,
      );
    }

    let assistantName: string | null = null;
    if (created.assistantId !== null) {
      const aRow = db
        .prepare('SELECT name FROM custom_ai_assistants WHERE id = ?')
        .get(created.assistantId) as { name: string } | undefined;
      assistantName = aRow?.name ?? null;
    }

    const snippets = buildIdeConfigSnippets(serverOrigin, created.key);
    const onboarding = buildOnboardingChecklist(user.userId);

    return {
      ok: true,
      actionType: 'create_personal_key',
      messageEn: `Minted new Personal API Key "${created.name}" (${created.routingMode.toUpperCase()} mode). Save this key now — it is shown in full only once!`,
      messageVi: `Đã tạo thành công Personal API Key "${created.name}" (chế độ ${created.routingMode.toUpperCase()}). Hãy lưu lại ngay — khóa đầy đủ chỉ hiển thị duy nhất một lần!`,
      createdKey: {
        id: created.id,
        name: created.name,
        rawKey: created.key,
        keyPrefix: created.keyPrefix,
        routingMode: created.routingMode,
        assistantId: created.assistantId,
        assistantName,
        createdAt: created.createdAt,
        snippets,
      },
      onboarding,
    };
  }

  if (body.actionType === 'switch_key_routing_mode') {
    const keyId = body.params?.keyId;
    const routingMode = body.params?.routingMode;
    if (!keyId || !Number.isInteger(keyId) || keyId <= 0) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_key_id',
        'A valid personal API key ID is required.',
      );
    }
    if (!routingMode || !VALID_ACTION_ROUTING_MODES.has(routingMode)) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_routing_mode',
        'Routing mode must be eco, balanced, or max.',
      );
    }

    const existingRow = db
      .prepare(
        `SELECT id, name, key_prefix, routing_mode, revoked
           FROM user_api_keys
          WHERE id = ? AND user_id = ?`,
      )
      .get(keyId, user.userId) as
      | {
          id: number;
          name: string;
          key_prefix: string;
          routing_mode: string | null;
          revoked: number;
        }
      | undefined;

    if (!existingRow || existingRow.revoked) {
      throw new SupportSetupCopilotError(
        404,
        'key_not_found',
        'Active personal API key not found.',
      );
    }

    const previousRoutingMode = normalizeRoutingMode(existingRow.routing_mode, 'default');

    let updated: ReturnType<typeof updateUserKeyAiConfig>;
    try {
      updated = updateUserKeyAiConfig(user.userId, liveRole, keyId, { routingMode });
    } catch (err) {
      if (err instanceof CustomerAiError) {
        throw new SupportSetupCopilotError(err.status, err.code, err.message);
      }
      throw err;
    }

    return {
      ok: true,
      actionType: 'switch_key_routing_mode',
      messageEn: `Switched key "${existingRow.name}" (${existingRow.key_prefix}) from ${previousRoutingMode} to ${routingMode.toUpperCase()} mode.`,
      messageVi: `Đã chuyển khóa "${existingRow.name}" (${existingRow.key_prefix}) từ chế độ ${previousRoutingMode} sang ${routingMode.toUpperCase()}.`,
      updatedKey: {
        id: updated.id,
        name: existingRow.name,
        keyPrefix: existingRow.key_prefix,
        previousRoutingMode,
        routingMode,
        assistantId: updated.assistantId,
        assistantName: updated.assistantName,
      },
      onboarding: buildOnboardingChecklist(user.userId),
    };
  }

  if (body.actionType === 'open_onboarding_guide') {
    const onboarding = buildOnboardingChecklist(user.userId);
    return {
      ok: true,
      actionType: 'open_onboarding_guide',
      messageEn: `Loaded live Member Onboarding Checklist (${onboarding.completedCount}/3 steps completed).`,
      messageVi: `Đã cập nhật Checklist bắt đầu của bạn (${onboarding.completedCount}/3 bước hoàn tất).`,
      onboarding,
    };
  }

  throw new SupportSetupCopilotError(400, 'unsupported_action', 'Unsupported Copilot action type.');
}
