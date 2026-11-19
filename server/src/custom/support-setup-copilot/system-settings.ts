import { parseStoredPermissions } from '@freellmapi/shared/permissions.js';
import {
  SYSTEM_SETTING_IDS,
  type SupportSystemSettingAction,
  type SupportSystemSettingApplyResult,
  type SupportSystemSettingId,
} from '@freellmapi/shared/support-setup-copilot.js';
import type { Permission } from '@freellmapi/shared/user-access.js';
import { getDb, getSetting, setSetting } from '../../db/index.js';
import { hasPermission } from '../../middleware/requirePermission.js';
import { isMcpServerEnabled, MCP_ENABLED_SETTING } from '../../routes/mcp.js';
import { getOllamaEmulationMode, type OllamaEmulationMode } from '../../routes/ollama.js';
import { isAutoUpdateCheckEnabled, UPDATE_CHECK_SETTING } from '../../routes/update.js';
import type { SessionUser, UserRole } from '../../services/auth.js';
import { CACHE_ENABLED_SETTING, isCacheEnabled } from '../../services/cache.js';
import { getCompressionConfig, setCompressionConfig } from '../../services/compression/config.js';
import { COMPRESSION_MODES, type CompressionMode } from '../../services/compression/types.js';
import { isUnifyEnabled, setUnifyEnabled, UNIFY_ENABLED_KEY } from '../../services/model-groups.js';
import {
  DEFAULT_ROUTE_HEALTH_TTL_MINUTES,
  getConfigSnapshot,
  getRouteHealthTtlMinutes,
  MAX_ROUTE_HEALTH_TTL_MINUTES,
  setDefaultSavers,
  setEnabled,
  setRouteHealthTtlMinutes,
  type XGatewaySaverDefaults,
} from '../x-gateway/config.js';
import '../x-gateway/router.js';
import { appendSupportAuditLog } from '../x-gateway/support-enterprise-router.js';
import { SupportSetupCopilotError } from './store.js';

export {
  SYSTEM_SETTING_IDS,
  type SupportSystemSettingAction,
  type SupportSystemSettingApplyResult,
  type SupportSystemSettingId,
};

export const SYSTEM_SETTING_PERMISSIONS = [
  'edit_x_settings',
  'edit_cache',
  'manage_compression',
  'edit_settings',
] as const satisfies readonly Permission[];

export const REQUIRED_PERMISSION_BY_SETTING: Readonly<
  Record<SupportSystemSettingId, Permission>
> = {
  thruline_gateway_enabled: 'edit_x_settings',
  thruline_token_savers: 'edit_x_settings',
  thruline_route_health_ttl: 'edit_x_settings',
  response_cache: 'edit_cache',
  prompt_compression: 'manage_compression',
  model_unification: 'edit_settings',
  mcp_server: 'edit_settings',
  auto_update_check: 'edit_settings',
  ollama_emulation: 'edit_settings',
};

export interface SystemSettingChangeRequest {
  settingId: SupportSystemSettingId;
  payload: Record<string, unknown>;
}

export type SystemSettingsIntentResult =
  | { kind: 'none' }
  | { kind: 'unsupported_sensitive'; replyVi: string; replyEn: string }
  | { kind: 'change_request'; requests: SystemSettingChangeRequest[] };

export interface EvaluateSystemSettingsProposalParams {
  user: SessionUser | undefined;
  messages: ReadonlyArray<{ role: 'user' | 'assistant' | string; content: string }>;
  locale?: 'vi' | 'en';
  llmSuggestedActions?: ReadonlyArray<{
    settingId?: string;
    payload?: Record<string, unknown>;
  }> | null;
}

export type EvaluateSystemSettingsProposalResult =
  | { outcome: 'none' }
  | {
      outcome: 'unsupported_sensitive';
      replyVi: string;
      replyEn: string;
      suggestedQuickReplies: string[];
    }
  | {
      outcome: 'permission_denied';
      missingPermissions: Permission[];
      replyVi: string;
      replyEn: string;
      suggestedQuickReplies: string[];
    }
  | {
      outcome: 'proposed';
      actions: SupportSystemSettingAction[];
      missingPermissions: Permission[];
      replyVi: string;
      replyEn: string;
      summaryVi: string;
      summaryEn: string;
      suggestedQuickReplies: string[];
    };

export interface ApplySystemSettingsActionsParams {
  user: SessionUser | undefined;
  actions: readonly SupportSystemSettingAction[];
  selectedIds?: readonly SupportSystemSettingId[];
}

const VALID_SETTING_ID_SET = new Set<string>(SYSTEM_SETTING_IDS);
const VALID_PONYTAIL_LEVELS = new Set<string>(['off', 'lite', 'full', 'ultra']);
const VALID_INPUT_SAVER_LEVELS = new Set<string>(['off', 'lossless', 'standard']);
const VALID_OLLAMA_MODES = new Set<string>([
  'off',
  'open-loopback',
  'key-required',
]);
const VALID_COMPRESSION_MODES = new Set<string>(COMPRESSION_MODES);

const PERMISSION_LABELS: Readonly<
  Record<
    (typeof SYSTEM_SETTING_PERMISSIONS)[number],
    { vi: string; en: string; screenVi: string; screenEn: string }
  >
> = {
  edit_x_settings: {
    vi: 'Cấu hình cổng Thruline (`edit_x_settings`)',
    en: 'Configure Thruline gateway (`edit_x_settings`)',
    screenVi: '`/thruline/home` hoặc `/thruline/savers`',
    screenEn: '`/thruline/home` or `/thruline/savers`',
  },
  edit_cache: {
    vi: 'Cấu hình bộ nhớ đệm phản hồi (`edit_cache`)',
    en: 'Configure response cache (`edit_cache`)',
    screenVi: 'hộp thoại Cài đặt hệ thống (mục Response Cache)',
    screenEn: 'System Settings dialog (Response Cache section)',
  },
  manage_compression: {
    vi: 'Quản lý nén ngữ cảnh (`manage_compression`)',
    en: 'Manage prompt compression (`manage_compression`)',
    screenVi: 'hộp thoại Cài đặt hệ thống (mục Compression) hoặc `/thruline/savers`',
    screenEn: 'System Settings dialog (Compression section) or `/thruline/savers`',
  },
  edit_settings: {
    vi: 'Chỉnh sửa cài đặt hệ thống (`edit_settings`)',
    en: 'Edit system settings (`edit_settings`)',
    screenVi: 'trang `/keys` (Agent compatibility) hoặc hộp thoại Cài đặt hệ thống',
    screenEn: '`/keys` (Agent compatibility) or the System Settings dialog',
  },
};

export function isSupportSystemSettingId(value: unknown): value is SupportSystemSettingId {
  return typeof value === 'string' && VALID_SETTING_ID_SET.has(value);
}

export function hasAnySystemSettingPermission(user: SessionUser | undefined): boolean {
  if (!user) return false;
  return (
    hasPermission(user, 'edit_x_settings') ||
    hasPermission(user, 'edit_cache') ||
    hasPermission(user, 'manage_compression') ||
    hasPermission(user, 'edit_settings')
  );
}

function foldVietnameseAscii(input: string): string {
  return input
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u0111\u0110]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function clampRouteHealthTtl(raw: unknown): number {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_ROUTE_HEALTH_TTL_MINUTES;
  return Math.max(0, Math.min(MAX_ROUTE_HEALTH_TTL_MINUTES, Math.round(num)));
}

function isValidPonytailLevel(
  value: unknown,
): value is 'off' | 'lite' | 'full' | 'ultra' {
  return typeof value === 'string' && VALID_PONYTAIL_LEVELS.has(value);
}

function isValidInputSaverLevel(
  value: unknown,
): value is XGatewaySaverDefaults['input'] {
  return typeof value === 'string' && VALID_INPUT_SAVER_LEVELS.has(value);
}

function isValidOllamaMode(value: unknown): value is OllamaEmulationMode {
  return typeof value === 'string' && VALID_OLLAMA_MODES.has(value);
}

function isValidCompressionMode(value: unknown): value is CompressionMode {
  return typeof value === 'string' && VALID_COMPRESSION_MODES.has(value);
}

function readCurrentModelUnification(): boolean {
  try {
    const stored = getSetting(UNIFY_ENABLED_KEY);
    if (stored !== undefined && stored.trim() !== '') {
      const normalized = stored.trim().toLowerCase();
      return normalized !== '0' && normalized !== 'false' && normalized !== 'off';
    }
  } catch {
    // Fall back to service accessor when settings table is not yet seeded.
  }
  return isUnifyEnabled();
}

function extractLatestUserMessage(
  messages: ReadonlyArray<{ role: string; content: string }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg && msg.role === 'user' && typeof msg.content === 'string') {
      const trimmed = msg.content.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

/**
 * Pure informational / conceptual / UI-navigation questions where the user is asking
 * "what is X?", "how does X work?", or "where in the UI do I toggle X?" rather than
 * asking the Copilot to execute or propose a configuration change.
 */
function isPureInformationalOrLocationQuestion(folded: string): boolean {
  const asksAiToAct =
    /\b(?:giup\s+(?:minh|toi|em)|ho\s+(?:minh|toi|em)|cho\s+(?:minh|toi|em)|luon\s+di|ngay\s+di|dum\s+(?:minh|toi)|ban\s+(?:hay|co\s+the|vui\s+long)\s+(?:bat|tat|chinh|doi|dat|chuyen|kich\s+hoat|vo\s+hieu|cap\s+nhat|xoa|tao|khoi\s+phuc)|(?:can|could|would)\s+you\s+(?:please\s+)?(?:turn|enable|disable|set|switch|update|change|toggle|activate|deactivate|rotate|delete|remove|restore|reset)|please\s+(?:turn|enable|disable|set|switch|update|change|toggle|activate|deactivate|rotate|delete|remove|restore|reset)|help\s+me\s+(?:turn|enable|disable|set|switch|toggle))\b/.test(
      folded,
    );

  if (asksAiToAct) return false;

  if (
    /\b(?:la\s+gi|la\s+cai\s+gi|nghia\s+la\s+gi|dung\s+de\s+lam\s+gi|co\s+tac\s+dung\s+gi|hoat\s+dong\s+(?:ra\s+sao|nhu\s+the\s+nao|the\s+nao|sao|kieu\s+gi)|khac\s+gi|khac\s+nhau|so\s+sanh|tai\s+sao|vi\s+sao|khi\s+nao\s+nen|co\s+nen\s+dung)\b/.test(
      folded,
    )
  ) {
    return true;
  }

  if (
    /\b(?:o\s+dau|cho\s+nao|muc\s+nao|tab\s+nao|trang\s+nao|man\s+hinh\s+nao|nam\s+o\s+dau|cach\s+(?:bat|tat|chinh|cau\s+hinh|su\s+dung|dung|doi|thiet\s+lap|them|xoa|tao|khoi\s+phuc)|lam\s+sao\s+de|lam\s+the\s+nao\s+de|huong\s+dan\s+(?:cach|su\s+dung|cau\s+hinh)|chi\s+(?:minh|toi|em)\s+(?:cach|cho)|dang\s+bat\s+hay\s+tat|co\s+dang\s+bat\s+khong)\b/.test(
      folded,
    )
  ) {
    return true;
  }

  if (
    /\b(?:what\s+is|what\s+are|what\s+does|how\s+does|how\s+do\s+(?:i|we)|how\s+can\s+i|how\s+to\s+(?:use|enable|disable|configure|find|check|add|create|restore)|where\s+(?:is|are|can\s+i|do\s+i|to\s+find)|explain\s+|tell\s+me\s+about|difference\s+between)\b/.test(
      folded,
    )
  ) {
    return true;
  }

  if (
    /^(?:is|are)\s+[a-z0-9\s_-]+\s+(?:enabled|disabled|on|off|active)\s*\??$/.test(folded)
  ) {
    return true;
  }

  return false;
}

type SensitiveCategory = 'credentials_keys' | 'passwords_accounts' | 'invites' | 'backups';

function detectSensitiveMutationCategory(folded: string): SensitiveCategory | null {
  // Strip benign Ollama 'key-required' mode expressions before scanning for API key mutations
  const sanitized = folded
    .replace(/\bkey[-\s]+required\b/g, 'ollama_mode_auth')
    .replace(
      /\bollama(?:\s+emulation)?\s+(?:che\s+do\s+|mode\s+|sang\s+|to\s+)?(?:yeu\s+cau|can|require|with)\s+(?:api\s+)?key\b/g,
      'ollama m_auth',
    );

  const hasSensitiveVerb =
    /\b(?:doi|thay|thay\s+doi|cap\s+nhat|dat\s+lai|xoa|go|bo|tao|sinh|them|nhap|xuat|hien\s+thi|xem|hien|tiet\s+lo|lo\s+ra|xoay\s+vong|lam\s+moi|thu\s+hoi|khoa|mo\s+khoa|cap\s+quyen|nang\s+quyen|ha\s+quyen|phan\s+quyen|gan\s+quyen|duyet|tu\s+choi|khoi\s+phuc|phuc\s+hoi|tai\s+xuong|change|reset|update|modify|delete|remove|drop|clear|create|generate|add|import|export|reveal|show|view\s+full|expose|rotate|regenerate|revoke|grant|promote|demote|assign|approve|reject|restore|download)\b/.test(
      sanitized,
    );

  if (!hasSensitiveVerb) return null;

  // 1. Passwords, user accounts, roles, permissions, sessions
  if (
    /\b(?:mat\s+khau|password|passcode|admin\s+password|user\s+password)\b/.test(sanitized) ||
    /\b(?:xoa\s+(?:user|tai\s+khoan|nguoi\s+dung|member|admin)|tao\s+(?:user|tai\s+khoan|admin)|delete\s+(?:user|account|member)|remove\s+(?:user|account)|create\s+(?:user|account)|(?:doi|thay|cap\s+nhat|nang|ha|cap|thu\s+hoi|gan|phan)\s+(?:role|quyen|permission)|(?:change|update|grant|revoke|assign|edit)\s+(?:user\s+)?(?:role|roles|permission|permissions)|promote\s+user|demote\s+user|revoke\s+(?:user\s+)?session|dang\s+xuat\s+tat\s+ca)\b/.test(
      sanitized,
    )
  ) {
    return 'passwords_accounts';
  }

  // 2. API keys, Gateway Master Key, URL tokens, proxy credentials, OAuth secrets
  if (
    /\b(?:api\s*key|api\s*keys|apikey|khoa\s+api|key\s+nha\s+cung\s+cap|provider\s+key|provider\s+keys|gateway\s+master\s+key|master\s+key|gateway\s+key|unified\s+(?:api\s+)?key|personal\s+key|url\s+token|url\s+tokens|proxy\s+(?:credential|credentials|password|secret|url)|outbound\s+proxy|oauth\s+(?:token|secret|account)|client\s+secret)\b/.test(
      sanitized,
    )
  ) {
    return 'credentials_keys';
  }

  // 3. Invites & registration requests
  if (
    /\b(?:invite\s+code|invite\s+codes|ma\s+moi|ma\s+invite|invite|registration\s+request|yeu\s+cau\s+dang\s+ky)\b/.test(
      sanitized,
    )
  ) {
    return 'invites';
  }

  // 4. Database backups & snapshots
  if (
    /\b(?:backup|backups|ban\s+sao\s+luu|sao\s+luu|snapshot|snapshots|database\s+restore|khoi\s+phuc\s+(?:du\s+lieu|database|db|he\s+thong))\b/.test(
      sanitized,
    )
  ) {
    return 'backups';
  }

  return null;
}

function buildSensitiveRefusal(category: SensitiveCategory): {
  replyVi: string;
  replyEn: string;
} {
  switch (category) {
    case 'passwords_accounts':
      return {
        replyVi:
          'Vì lý do bảo mật và tránh khóa nhầm tài khoản quản trị, mình không bao giờ tự động thay đổi mật khẩu, xóa tài khoản hay chỉnh sửa quyền hạn (RBAC) của người dùng qua chat. Bạn vui lòng thực hiện trực tiếp tại màn hình **Người dùng & Phân quyền (`/users`)** hoặc phần **Tài khoản cá nhân** trên Dashboard nhé!',
        replyEn:
          'For security and to prevent accidental account lockouts, I never automatically modify passwords, delete user accounts, or alter user roles/permissions via chat. Please make this change directly on the **Users & Roles (`/users`)** screen or in your **Account Profile** settings on the Dashboard.',
      };
    case 'credentials_keys':
      return {
        replyVi:
          'Để bảo vệ an toàn tuyệt đối cho bí mật xác thực, mình không tự động xem, tạo, xóa hay xoay vòng (rotate) API key, Gateway Master Key hoặc thông tin xác thực Proxy. Bạn có thể thao tác an toàn trực tiếp tại trang **Provider Keys (`/keys`)**, **Thruline Providers (`/thruline/providers`)** hoặc mục **Gateway Key trong Cài đặt hệ thống** trên Dashboard nhé!',
        replyEn:
          'To keep your credentials strictly protected, I never automatically view, create, delete, or rotate API keys, the Gateway Master Key, or proxy credentials. Please manage them directly on **Provider Keys (`/keys`)**, **Thruline Providers (`/thruline/providers`)**, or the **System Settings** dialog on the Dashboard.',
      };
    case 'invites':
      return {
        replyVi:
          'Để kiểm soát chặt chẽ quyền đăng ký vào hệ thống, mình không tự động tạo, thu hồi mã mời (Invite Code) hay duyệt yêu cầu đăng ký qua AI. Bạn vui lòng mở trực tiếp màn hình **Mã mời & Đăng ký (`/invites`)** trên Dashboard để thao tác nhé!',
        replyEn:
          'To keep workspace access tightly controlled, I do not automatically generate/revoke invite codes or approve registration requests via AI. Please manage them directly on the **Invites (`/invites`)** screen on the Dashboard.',
      };
    case 'backups':
      return {
        replyVi:
          'Các thao tác tạo, xóa hoặc khôi phục bản sao lưu cơ sở dữ liệu (Backup / Restore) có ảnh hưởng trực tiếp đến toàn bộ dữ liệu hệ thống nên mình không bao giờ tự động chạy qua AI. Bạn vui lòng thực hiện trực tiếp tại màn hình **Sao lưu & Khôi phục (`/backups`)** trên Dashboard để đảm bảo an toàn nhé!',
        replyEn:
          'Creating, deleting, or restoring database snapshots impacts live system data, so I never execute backup operations automatically via AI. Please perform this directly on the **Backups (`/backups`)** screen on the Dashboard.',
      };
  }
}

type Polarity = 'enable' | 'disable' | 'set' | null;

function detectClausePolarity(foldedClause: string): Polarity {
  if (
    /\b(?:tat|vo\s+hieu(?:\s+hoa)?|ngung|ngat|dong\s+cong|turn\s+off|switch\s+off|disable|deactivate)\b/.test(
      foldedClause,
    ) ||
    /\b(?:sang|thanh|to|mode|=)\s*off\b/.test(foldedClause)
  ) {
    return 'disable';
  }

  if (
    /\b(?:bat|kich\s+hoat|mo\s+(?:cong|lai|tinh\s+nang|che\s+do)|turn\s+on|switch\s+on|enable|activate)\b/.test(
      foldedClause,
    ) ||
    /\b(?:sang|thanh|to|mode|=)\s*on\b/.test(foldedClause)
  ) {
    return 'enable';
  }

  if (
    /\b(?:chinh|dat|doi|thay\s+doi|chuyen|cau\s+hinh|thiet\s+lap|set|change|switch|configure|adjust)\b/.test(
      foldedClause,
    )
  ) {
    return 'set';
  }

  return null;
}

/**
 * Guards against Tenant Support 7-step expressions so Tenant AI / Widget / SLA /
 * PII Masking / Prompt Firewall / CORS Origin edits never collide with system settings.
 */
function isExclusivelyTenantSupportClause(foldedClause: string): boolean {
  const hasSystemKeyword =
    /\b(?:response\s+cache|cache\s+phan\s+hoi|bo\s+nho\s+dem|nen\s+prompt|nen\s+ngu\s+canh|prompt\s+compression|context\s+compression|gop\s+(?:model|mo\s+hinh)|hop\s+nhat\s+(?:model|mo\s+hinh)|gom\s+(?:nhom\s+)?(?:model|mo\s+hinh)|model\s+unification|unify\s+model|mcp\s+server|cong\s+mcp|may\s+chu\s+mcp|enable[-\s]mcp|auto\s+update|update\s+check|kiem\s+tra\s+(?:ban\s+)?cap\s+nhat|ollama|route\s+health|health\s+ttl|token\s+saver|tiet\s+kiem\s+token|caveman|ponytail|cong\s+thruline|thruline\s+gateway|x[-\s]?gateway|9router\s+gateway)\b/.test(
      foldedClause,
    );

  if (hasSystemKeyword) return false;

  return /\b(?:widget|nut\s+chat|mau\s+(?:nut|chu\s+dao|widget)|sla|phan\s+luong|che\s+pii|pii\s+masking|masking|tuong\s+lua\s+prompt|prompt\s+firewall|prompt\s+injection|guardrail|guardrails|model\s+mac\s+dinh|default\s+model|cors|allowed\s*origins|domain|system\s+prompt|loi\s+chao|welcome\s+message|khach\s+vang\s+lai|guest\s+chat|faq|knowledge\s+base|tai\s+lieu\s+tri\s+thuc|output\s+policy|kiem\s+soat\s+dau\s+ra)\b/.test(
    foldedClause,
  );
}

function parseTokenSaversPatchFromClause(
  foldedClause: string,
  effectivePolarity: Polarity,
  options: {
    contextMentionsTokenSavers: boolean;
    wholeMessageHasSpecificSaverSubfield: boolean;
  },
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  let matchedSpecific = false;

  if (/\bcaveman\b/.test(foldedClause)) {
    matchedSpecific = true;
    const localOff =
      /\b(?:tat|disable|turn\s+off)\s+(?:che\s+do\s+)?caveman\b|\bcaveman\s*(?:=|:|\s+sang|\s+to)?\s*(?:off|false|tat)\b/.test(
        foldedClause,
      );
    patch.caveman = localOff ? false : effectivePolarity === 'disable' ? false : true;
  }

  if (/\bponytail\b/.test(foldedClause)) {
    matchedSpecific = true;
    const levelMatch =
      /\bponytail\b(?:\s+(?:sang|thanh|muc|che\s+do|level|mode|to|=|:))?\s*(off|lite|full|ultra)\b/.exec(
        foldedClause,
      ) ?? /\b(off|lite|full|ultra)\s+ponytail\b/.exec(foldedClause);
    if (levelMatch && isValidPonytailLevel(levelMatch[1])) {
      patch.ponytail = levelMatch[1];
    } else if (effectivePolarity === 'disable') {
      patch.ponytail = 'off';
    } else {
      patch.ponytail = 'lite';
    }
  }

  if (
    /\b(?:input\s+saver|thruline\s+input|nen\s+dau\s+vao|nen\s+input)\b/.test(foldedClause) ||
    (options.contextMentionsTokenSavers &&
      /\binput\b/.test(foldedClause) &&
      !/\bmax\s+input\b/.test(foldedClause))
  ) {
    matchedSpecific = true;
    const inputMatch = /\b(off|lossless|standard)\b/.exec(foldedClause);
    if (inputMatch && isValidInputSaverLevel(inputMatch[1])) {
      patch.input = inputMatch[1];
    } else if (effectivePolarity === 'disable') {
      patch.input = 'off';
    } else {
      patch.input = 'lossless';
    }
  }

  if (matchedSpecific) {
    return patch;
  }

  // General "bật/tắt token savers" without naming a specific sub-saver anywhere in the turn
  if (
    /\b(?:token\s+saver|token\s+savers|tiet\s+kiem\s+token|thruline\s+saver|thruline\s+savers|default\s+savers)\b/.test(
      foldedClause,
    )
  ) {
    if (effectivePolarity === 'disable') {
      return { caveman: false, ponytail: 'off', input: 'off' };
    }
    if (options.wholeMessageHasSpecificSaverSubfield) {
      return null;
    }
    if (effectivePolarity === 'enable' || effectivePolarity === 'set') {
      const standaloneLevel = /\b(lossless|standard)\b/.exec(foldedClause);
      const current = getConfigSnapshot().savers;
      return {
        ...(current.ponytail === 'off' ? { ponytail: 'lite' } : {}),
        input:
          standaloneLevel?.[1] === 'standard'
            ? 'standard'
            : current.input === 'off'
              ? 'lossless'
              : current.input,
      };
    }
  }

  return null;
}

function parseRouteHealthTtlFromClause(
  foldedClause: string,
  effectivePolarity: Polarity,
): Record<string, unknown> | null {
  if (
    !/\b(?:route\s+health(?:\s+ttl)?|health\s+ttl|thoi\s+gian\s+song\s+route(?:\s+health)?|ttl\s+(?:suc\s+khoe\s+)?route)\b/.test(
      foldedClause,
    )
  ) {
    return null;
  }

  if (effectivePolarity === 'disable') {
    return { minutes: 0 };
  }

  const hourMatch = /(-?\d+(?:\.\d+)?)\s*(?:gio|tieng|hour|hours|hr|hrs|\bh\b)/.exec(foldedClause);
  if (hourMatch) {
    return { minutes: clampRouteHealthTtl(Number(hourMatch[1]) * 60) };
  }

  const minMatch =
    /(?:^|[\s:=])(-?\d+)\s*(?:phut|minute|minutes|min|mins|\bm\b)?/.exec(
      foldedClause.replace(/9router/g, ''),
    );
  if (minMatch) {
    return { minutes: clampRouteHealthTtl(Number(minMatch[1])) };
  }

  if (effectivePolarity === 'enable' || effectivePolarity === 'set') {
    return { minutes: DEFAULT_ROUTE_HEALTH_TTL_MINUTES };
  }

  return null;
}

function parseCompressionFromClause(
  foldedClause: string,
  effectivePolarity: Polarity,
): Record<string, unknown> | null {
  if (
    !/\b(?:nen\s+prompt|nen\s+ngu\s+canh|nen\s+lich\s+su|prompt\s+compression|context\s+compression)\b/.test(
      foldedClause,
    )
  ) {
    return null;
  }

  if (effectivePolarity === 'disable' || /\b(?:mode|che\s+do|sang|thanh|to)\s+off\b/.test(foldedClause)) {
    return { enabled: false, mode: 'off' };
  }

  let mode: CompressionMode | undefined;
  if (/\blossless\b|khong\s+mat\s+du\s+lieu/.test(foldedClause)) {
    mode = 'lossless';
  } else if (/\baggressive\b|manh|toi\s+da/.test(foldedClause)) {
    mode = 'aggressive';
  } else if (/\bstandard\b|tieu\s+chuan/.test(foldedClause)) {
    mode = 'standard';
  }

  if (mode) {
    return { enabled: true, mode };
  }

  if (effectivePolarity === 'enable' || effectivePolarity === 'set') {
    const current = getCompressionConfig().mode;
    const nextMode: CompressionMode = current !== 'off' ? current : 'standard';
    return { enabled: true, mode: nextMode };
  }

  return null;
}

function parseOllamaFromClause(
  foldedClause: string,
  effectivePolarity: Polarity,
): Record<string, unknown> | null {
  if (!/\bollama\b/.test(foldedClause)) {
    return null;
  }
  // Ignore questions/statements about adding an upstream Ollama provider endpoint unless emulation/mode is mentioned
  if (
    /\b(?:them\s+key|add\s+key|provider\s+key)\b/.test(foldedClause) &&
    !/\b(?:emulation|gia\s+lap|tuong\s+thich|loopback|key[-\s]?required|che\s+do|mode)\b/.test(
      foldedClause,
    )
  ) {
    return null;
  }

  if (effectivePolarity === 'disable' || /\b(?:sang|thanh|to|mode|=)\s*off\b/.test(foldedClause)) {
    return { mode: 'off' };
  }

  if (
    /\b(?:open[-\s]?loopback|loopback|noi\s+bo|may\s+cuc\s+bo|localhost|khong\s+can\s+key)\b/.test(
      foldedClause,
    )
  ) {
    return { mode: 'open-loopback' };
  }

  if (/\b(?:key[-\s]?required|yeu\s+cau\s+(?:api\s+)?key|can\s+(?:api\s+)?key|require\s+key)\b/.test(foldedClause)) {
    return { mode: 'key-required' };
  }

  if (effectivePolarity === 'enable' || effectivePolarity === 'set') {
    return { mode: 'key-required' };
  }

  return null;
}

function extractRequestsFromClause(
  foldedClause: string,
  inheritedPolarity: Polarity,
  saverContext: {
    contextMentionsTokenSavers: boolean;
    wholeMessageHasSpecificSaverSubfield: boolean;
  },
): { polarity: Polarity; requests: SystemSettingChangeRequest[] } {
  const clausePolarity = detectClausePolarity(foldedClause);
  const effectivePolarity = clausePolarity ?? inheritedPolarity;
  const out: SystemSettingChangeRequest[] = [];

  if (isExclusivelyTenantSupportClause(foldedClause)) {
    return { polarity: effectivePolarity, requests: out };
  }

  // 1. Thruline Token Savers
  const saversPatch = parseTokenSaversPatchFromClause(
    foldedClause,
    effectivePolarity,
    saverContext,
  );
  if (saversPatch && Object.keys(saversPatch).length > 0) {
    out.push({ settingId: 'thruline_token_savers', payload: saversPatch });
  }

  // 2. Thruline Route Health TTL
  const ttlPatch = parseRouteHealthTtlFromClause(foldedClause, effectivePolarity);
  if (ttlPatch) {
    out.push({ settingId: 'thruline_route_health_ttl', payload: ttlPatch });
  }

  // 3. Thruline Gateway Master Switch (exclude clauses that only targeted savers/ttl/support/combos)
  const mentionsThrulineGateway =
    /\b(?:cong\s+thruline|thruline\s+gateway|x[-\s]?gateway|9router\s+gateway)\b/.test(
      foldedClause,
    ) ||
    (/\b(?:bat|tat|kich\s+hoat|vo\s+hieu(?:\s+hoa)?|enable|disable|turn\s+on|turn\s+off)\s+thruline\b/.test(
      foldedClause,
    ) &&
      !/\b(?:support|tenant|widget|combo|combos|saver|savers|ttl|playground|translator)\b/.test(
        foldedClause,
      ));

  if (
    mentionsThrulineGateway &&
    (effectivePolarity === 'enable' || effectivePolarity === 'disable')
  ) {
    out.push({
      settingId: 'thruline_gateway_enabled',
      payload: { enabled: effectivePolarity === 'enable' },
    });
  }

  // 4. Response Cache (exclude AI Platform 'prompt cache' and 'route health cache')
  const mentionsResponseCache =
    /\b(?:response\s+cache|cache\s+phan\s+hoi|bo\s+nho\s+dem\s+phan\s+hoi|completion\s+cache)\b/.test(
      foldedClause,
    ) ||
    (/\b(?:bo\s+nho\s+dem|cache)\b/.test(foldedClause) &&
      !/\b(?:prompt\s+cache|semantic\s+prompt\s+cache|route\s+health)\b/.test(foldedClause));

  if (
    mentionsResponseCache &&
    (effectivePolarity === 'enable' || effectivePolarity === 'disable')
  ) {
    out.push({
      settingId: 'response_cache',
      payload: { enabled: effectivePolarity === 'enable' },
    });
  }

  // 5. Prompt Compression
  const compressionPatch = parseCompressionFromClause(foldedClause, effectivePolarity);
  if (compressionPatch) {
    out.push({ settingId: 'prompt_compression', payload: compressionPatch });
  }

  // 6. Model Unification
  if (
    /\b(?:model\s+unification|unify\s+models?|gop\s+(?:model|mo\s+hinh)|hop\s+nhat\s+(?:model|mo\s+hinh)|gom\s+(?:nhom\s+)?(?:model|mo\s+hinh))\b/.test(
      foldedClause,
    ) &&
    (effectivePolarity === 'enable' || effectivePolarity === 'disable')
  ) {
    out.push({
      settingId: 'model_unification',
      payload: { enabled: effectivePolarity === 'enable' },
    });
  }

  // 7. MCP Server (gateway /mcp endpoint — exclude managing external AI platform MCP tool servers unless /mcp or mcp server toggle)
  if (
    /\b(?:mcp\s+server|cong\s+mcp|may\s+chu\s+mcp|enable[-\s]mcp|\/mcp)\b/.test(foldedClause) &&
    (effectivePolarity === 'enable' || effectivePolarity === 'disable')
  ) {
    out.push({
      settingId: 'mcp_server',
      payload: { enabled: effectivePolarity === 'enable' },
    });
  }

  // 8. Auto Update Check
  if (
    /\b(?:auto[-\s]?update(?:\s+check)?|automatic\s+update(?:\s+check)?|update\s+check|kiem\s+tra\s+(?:ban\s+)?cap\s+nhat(?:\s+tu\s+dong)?|tu\s+dong\s+kiem\s+tra\s+cap\s+nhat)\b/.test(
      foldedClause,
    ) &&
    (effectivePolarity === 'enable' || effectivePolarity === 'disable')
  ) {
    out.push({
      settingId: 'auto_update_check',
      payload: { enabled: effectivePolarity === 'enable' },
    });
  }

  // 9. Ollama Emulation
  const ollamaPatch = parseOllamaFromClause(foldedClause, effectivePolarity);
  if (ollamaPatch) {
    out.push({ settingId: 'ollama_emulation', payload: ollamaPatch });
  }

  return { polarity: effectivePolarity, requests: out };
}

export function detectSystemSettingsIntent(
  messages: ReadonlyArray<{ role: string; content: string }>,
  _locale: 'vi' | 'en' = 'vi',
): SystemSettingsIntentResult {
  const latestRaw = extractLatestUserMessage(messages);
  if (!latestRaw) return { kind: 'none' };

  const folded = foldVietnameseAscii(latestRaw);
  if (!folded) return { kind: 'none' };

  // Pure informational / how-to / where-is questions stay 'none' so platform-guide.ts answers them
  if (isPureInformationalOrLocationQuestion(folded)) {
    return { kind: 'none' };
  }

  // Sensitive credential, user/role, invite, or backup mutations are strictly refused
  const sensitiveCategory = detectSensitiveMutationCategory(folded);
  if (sensitiveCategory) {
    const refusal = buildSensitiveRefusal(sensitiveCategory);
    return {
      kind: 'unsupported_sensitive',
      replyVi: refusal.replyVi,
      replyEn: refusal.replyEn,
    };
  }

  const saverContext = {
    contextMentionsTokenSavers:
      /\b(?:token\s+saver|token\s+savers|tiet\s+kiem\s+token|thruline\s+saver|thruline\s+savers|default\s+savers)\b/.test(
        folded,
      ),
    wholeMessageHasSpecificSaverSubfield:
      /\b(?:caveman|ponytail|input\s+saver|thruline\s+input|nen\s+dau\s+vao|nen\s+input)\b/.test(
        folded,
      ) ||
      (/\b(?:token\s+saver|token\s+savers|tiet\s+kiem\s+token|default\s+savers)\b/.test(folded) &&
        /\binput\b/.test(folded)),
  };

  // Split multi-action turns across conjunctions/clauses while carrying shared action polarity forward
  const clauses = folded
    .split(/\s*(?:,|;|\bva\b|\band\b|\bcung\s+voi\b|\broi\b|\bthen\b|\bdong\s+thoi\b|\blan\b)\s*/i)
    .map((c) => c.trim())
    .filter(Boolean);

  const mergedById = new Map<SupportSystemSettingId, Record<string, unknown>>();
  let carriedPolarity: Polarity = null;

  for (const clause of clauses) {
    const { polarity, requests } = extractRequestsFromClause(
      clause,
      carriedPolarity,
      saverContext,
    );
    if (polarity) carriedPolarity = polarity;
    for (const req of requests) {
      const existing = mergedById.get(req.settingId);
      if (existing && req.settingId === 'thruline_token_savers') {
        mergedById.set(req.settingId, { ...existing, ...req.payload });
      } else {
        mergedById.set(req.settingId, req.payload);
      }
    }
  }

  // Fallback whole-utterance pass if clause splitting separated verb from object awkwardly
  if (mergedById.size === 0) {
    const whole = extractRequestsFromClause(folded, null, saverContext);
    for (const req of whole.requests) {
      mergedById.set(req.settingId, req.payload);
    }
  }

  if (mergedById.size === 0) {
    return { kind: 'none' };
  }

  return {
    kind: 'change_request',
    requests: [...mergedById.entries()].map(([settingId, payload]) => ({
      settingId,
      payload,
    })),
  };
}

function formatSaversLabelVi(savers: XGatewaySaverDefaults): string {
  return `Caveman: ${savers.caveman ? 'Bật' : 'Tắt'}, Ponytail: ${savers.ponytail}, Input: ${savers.input}`;
}

function formatSaversLabelEn(savers: XGatewaySaverDefaults): string {
  return `Caveman: ${savers.caveman ? 'On' : 'Off'}, Ponytail: ${savers.ponytail}, Input: ${savers.input}`;
}

function formatOllamaModeVi(mode: OllamaEmulationMode): string {
  if (mode === 'off') return 'Đang tắt (`off`)';
  if (mode === 'open-loopback') return 'Mở nội bộ không cần key (`open-loopback`)';
  return 'Yêu cầu API key (`key-required`)';
}

function formatOllamaModeEn(mode: OllamaEmulationMode): string {
  if (mode === 'off') return 'Disabled (`off`)';
  if (mode === 'open-loopback') return 'Local loopback without key (`open-loopback`)';
  return 'API key required (`key-required`)';
}

function normalizeActionPayload(
  settingId: SupportSystemSettingId,
  rawPayload: Record<string, unknown>,
): Record<string, unknown> {
  switch (settingId) {
    case 'thruline_gateway_enabled':
    case 'response_cache':
    case 'model_unification':
    case 'mcp_server':
    case 'auto_update_check':
      return { enabled: Boolean(rawPayload.enabled) };

    case 'thruline_token_savers': {
      const normalized: Record<string, unknown> = {};
      if (typeof rawPayload.caveman === 'boolean') {
        normalized.caveman = rawPayload.caveman;
      }
      if (isValidPonytailLevel(rawPayload.ponytail)) {
        normalized.ponytail = rawPayload.ponytail;
      }
      if (isValidInputSaverLevel(rawPayload.input)) {
        normalized.input = rawPayload.input;
      }
      if (Object.keys(normalized).length === 0) {
        const current = getConfigSnapshot().savers;
        normalized.ponytail = current.ponytail === 'off' ? 'lite' : current.ponytail;
        normalized.input = current.input === 'off' ? 'lossless' : current.input;
      }
      return normalized;
    }

    case 'thruline_route_health_ttl':
      return { minutes: clampRouteHealthTtl(rawPayload.minutes) };

    case 'prompt_compression': {
      if (isValidCompressionMode(rawPayload.mode)) {
        return {
          enabled: rawPayload.mode !== 'off',
          mode: rawPayload.mode,
        };
      }
      const enabled = rawPayload.enabled !== false;
      const currentMode = getCompressionConfig().mode;
      const nextMode: CompressionMode = !enabled
        ? 'off'
        : currentMode !== 'off'
          ? currentMode
          : 'standard';
      return { enabled: nextMode !== 'off', mode: nextMode };
    }

    case 'ollama_emulation': {
      const mode: OllamaEmulationMode = isValidOllamaMode(rawPayload.mode)
        ? rawPayload.mode
        : rawPayload.enabled === false
          ? 'off'
          : 'key-required';
      return { mode };
    }

    default:
      return rawPayload;
  }
}

export function buildSystemSettingAction(
  settingId: SupportSystemSettingId,
  rawPayload: Record<string, unknown>,
  canApply: boolean,
): SupportSystemSettingAction {
  const requiredPermission = REQUIRED_PERMISSION_BY_SETTING[settingId];
  const payload = normalizeActionPayload(settingId, rawPayload);

  switch (settingId) {
    case 'thruline_gateway_enabled': {
      const current = getConfigSnapshot().enabled;
      const next = Boolean(payload.enabled);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Cổng Thruline Gateway',
        titleEn: 'Thruline Gateway',
        summaryVi: next
          ? 'Bật cổng Thruline (`/thruline/v1`) để định tuyến multi-account, combos và token savers.'
          : 'Tắt cổng Thruline (`/thruline/v1`) trên hệ thống.',
        summaryEn: next
          ? 'Enable the Thruline gateway (`/thruline/v1`) for multi-account routing, combos, and token savers.'
          : 'Disable the Thruline gateway (`/thruline/v1`).',
        currentValueVi: current ? 'Đang bật' : 'Đang tắt',
        currentValueEn: current ? 'Enabled' : 'Disabled',
        proposedValueVi: next ? 'Bật' : 'Tắt',
        proposedValueEn: next ? 'Enabled' : 'Disabled',
        payload,
      };
    }

    case 'thruline_token_savers': {
      const current = getConfigSnapshot().savers;
      const merged: XGatewaySaverDefaults = {
        caveman: typeof payload.caveman === 'boolean' ? payload.caveman : current.caveman,
        ponytail: isValidPonytailLevel(payload.ponytail) ? payload.ponytail : current.ponytail,
        input: isValidInputSaverLevel(payload.input) ? payload.input : current.input,
      };
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Tiết kiệm Token mặc định trên Thruline',
        titleEn: 'Thruline Default Token Savers',
        summaryVi:
          'Cập nhật cấu hình tiết kiệm token mặc định của Thruline và giữ nguyên các trường không thay đổi.',
        summaryEn:
          'Update Thruline default token savers while preserving untouched saver fields.',
        currentValueVi: formatSaversLabelVi(current),
        currentValueEn: formatSaversLabelEn(current),
        proposedValueVi: formatSaversLabelVi(merged),
        proposedValueEn: formatSaversLabelEn(merged),
        payload,
      };
    }

    case 'thruline_route_health_ttl': {
      const current = getRouteHealthTtlMinutes();
      const minutes = clampRouteHealthTtl(payload.minutes);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Thời gian lưu trạng thái Route Health (Thruline)',
        titleEn: 'Thruline Route Health TTL',
        summaryVi:
          minutes === 0
            ? 'Tắt bộ nhớ đệm trạng thái sức khỏe route trên Thruline (0 phút).'
            : `Đặt thời gian lưu trạng thái sức khỏe route Thruline thành ${minutes} phút.`,
        summaryEn:
          minutes === 0
            ? 'Disable Thruline route health status caching (0 minutes).'
            : `Set Thruline route health TTL to ${minutes} minute(s).`,
        currentValueVi: `${current} phút`,
        currentValueEn: `${current} min`,
        proposedValueVi: `${minutes} phút`,
        proposedValueEn: `${minutes} min`,
        payload: { minutes },
      };
    }

    case 'response_cache': {
      const current = isCacheEnabled();
      const next = Boolean(payload.enabled);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Bộ nhớ đệm phản hồi (Response Cache)',
        titleEn: 'Response Cache',
        summaryVi: next
          ? 'Bật exact-match Response Cache để tái sử dụng kết quả trùng khớp, tiết kiệm quota và giảm độ trễ.'
          : 'Tắt Response Cache để mọi yêu cầu đều gọi trực tiếp tới nhà cung cấp model.',
        summaryEn: next
          ? 'Enable exact-match Response Cache to reuse identical completions, save quota, and cut latency.'
          : 'Disable Response Cache so every request is sent fresh upstream.',
        currentValueVi: current ? 'Đang bật' : 'Đang tắt',
        currentValueEn: current ? 'Enabled' : 'Disabled',
        proposedValueVi: next ? 'Bật' : 'Tắt',
        proposedValueEn: next ? 'Enabled' : 'Disabled',
        payload,
      };
    }

    case 'prompt_compression': {
      const currentMode = getCompressionConfig().mode;
      const nextMode: CompressionMode = isValidCompressionMode(payload.mode)
        ? payload.mode
        : payload.enabled === false
          ? 'off'
          : 'standard';
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Nén ngữ cảnh & Prompt (Prompt Compression)',
        titleEn: 'Prompt & Context Compression',
        summaryVi:
          nextMode === 'off'
            ? 'Tắt nén prompt đầu vào trên toàn cổng.'
            : `Bật nén prompt đầu vào ở chế độ \`${nextMode}\` để giảm token ngữ cảnh dài.`,
        summaryEn:
          nextMode === 'off'
            ? 'Turn off gateway-wide prompt compression.'
            : `Enable gateway-wide prompt compression in \`${nextMode}\` mode.`,
        currentValueVi: currentMode === 'off' ? 'Đang tắt (`off`)' : `Đang bật (\`${currentMode}\`)`,
        currentValueEn: currentMode === 'off' ? 'Disabled (`off`)' : `Enabled (\`${currentMode}\`)`,
        proposedValueVi: nextMode === 'off' ? 'Tắt (`off`)' : `Bật (\`${nextMode}\`)`,
        proposedValueEn: nextMode === 'off' ? 'Disabled (`off`)' : `Enabled (\`${nextMode}\`)`,
        payload: { enabled: nextMode !== 'off', mode: nextMode },
      };
    }

    case 'model_unification': {
      const current = readCurrentModelUnification();
      const next = Boolean(payload.enabled);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Hợp nhất Model đa nhà cung cấp (Model Unification)',
        titleEn: 'Cross-Provider Model Unification',
        summaryVi: next
          ? 'Bật cờ hợp nhất các model trùng tên giữa nhiều nhà cung cấp thành một nhóm tự động failover.'
          : 'Tắt cờ hợp nhất model trong cài đặt hệ thống.',
        summaryEn: next
          ? 'Enable cross-provider model unification grouping and failover.'
          : 'Disable the model unification setting.',
        currentValueVi: current ? 'Đang bật' : 'Đang tắt',
        currentValueEn: current ? 'Enabled' : 'Disabled',
        proposedValueVi: next ? 'Bật' : 'Tắt',
        proposedValueEn: next ? 'Enabled' : 'Disabled',
        payload,
      };
    }

    case 'mcp_server': {
      const current = isMcpServerEnabled();
      const next = Boolean(payload.enabled);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Máy chủ giao thức MCP (`/mcp`)',
        titleEn: 'Gateway MCP Server (`/mcp`)',
        summaryVi: next
          ? 'Bật endpoint `/mcp` để các tác tử lập trình (Claude Code, Cursor, Cline…) kết nối qua Model Context Protocol.'
          : 'Tắt endpoint `/mcp` trên cổng chính.',
        summaryEn: next
          ? 'Enable the stateless `/mcp` endpoint for MCP-compatible coding agents.'
          : 'Disable the `/mcp` endpoint on the gateway.',
        currentValueVi: current ? 'Đang bật' : 'Đang tắt',
        currentValueEn: current ? 'Enabled' : 'Disabled',
        proposedValueVi: next ? 'Bật' : 'Tắt',
        proposedValueEn: next ? 'Enabled' : 'Disabled',
        payload,
      };
    }

    case 'auto_update_check': {
      const current = isAutoUpdateCheckEnabled();
      const next = Boolean(payload.enabled);
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Tự động kiểm tra bản cập nhật',
        titleEn: 'Automatic Release Update Check',
        summaryVi: next
          ? 'Bật kiểm tra phiên bản mới định kỳ trên Dashboard.'
          : 'Tắt kiểm tra bản cập nhật tự động ngầm.',
        summaryEn: next
          ? 'Enable periodic automatic release checks on the Dashboard.'
          : 'Disable background automatic release checks.',
        currentValueVi: current ? 'Đang bật' : 'Đang tắt',
        currentValueEn: current ? 'Enabled' : 'Disabled',
        proposedValueVi: next ? 'Bật' : 'Tắt',
        proposedValueEn: next ? 'Enabled' : 'Disabled',
        payload,
      };
    }

    case 'ollama_emulation': {
      const current = getOllamaEmulationMode();
      const mode: OllamaEmulationMode = isValidOllamaMode(payload.mode)
        ? payload.mode
        : 'key-required';
      return {
        settingId,
        requiredPermission,
        canApply,
        enabledByDefault: canApply,
        titleVi: 'Giả lập giao thức Ollama (Ollama Emulation)',
        titleEn: 'Ollama Protocol Emulation',
        summaryVi:
          mode === 'off'
            ? 'Tắt bề mặt tương thích giao thức Ollama (`/api/tags`, `/api/chat`).'
            : `Chuyển chế độ tương thích Ollama sang \`${mode}\`.`,
        summaryEn:
          mode === 'off'
            ? 'Disable the Ollama-compatible API surface (`/api/tags`, `/api/chat`).'
            : `Set Ollama protocol emulation mode to \`${mode}\`.`,
        currentValueVi: formatOllamaModeVi(current),
        currentValueEn: formatOllamaModeEn(current),
        proposedValueVi: formatOllamaModeVi(mode),
        proposedValueEn: formatOllamaModeEn(mode),
        payload: { mode },
      };
    }
  }
}

export function evaluateSystemSettingsProposal(
  params: EvaluateSystemSettingsProposalParams,
): EvaluateSystemSettingsProposalResult {
  const { user, messages, locale = 'vi', llmSuggestedActions } = params;

  const detected = detectSystemSettingsIntent(messages, locale);
  if (detected.kind === 'unsupported_sensitive') {
    return {
      outcome: 'unsupported_sensitive',
      replyVi: detected.replyVi,
      replyEn: detected.replyEn,
      suggestedQuickReplies:
        locale === 'en'
          ? [
              'What system settings can you help toggle?',
              'Guide me on configuring AI Support',
            ]
          : [
              'Bạn có thể hỗ trợ bật/tắt những cài đặt hệ thống nào?',
              'Hướng dẫn mình cấu hình AI Support',
            ],
    };
  }

  const latestRaw = extractLatestUserMessage(messages);
  const foldedLatest = latestRaw ? foldVietnameseAscii(latestRaw) : '';
  const blockLlmSuggestions =
    !foldedLatest ||
    isPureInformationalOrLocationQuestion(foldedLatest) ||
    isExclusivelyTenantSupportClause(foldedLatest);

  const requestMap = new Map<SupportSystemSettingId, Record<string, unknown>>();
  if (detected.kind === 'change_request') {
    for (const req of detected.requests) {
      requestMap.set(req.settingId, req.payload);
    }
  }

  if (!blockLlmSuggestions && Array.isArray(llmSuggestedActions)) {
    for (const item of llmSuggestedActions) {
      if (!item || !isSupportSystemSettingId(item.settingId)) continue;
      if (requestMap.has(item.settingId)) continue;
      const safePayload =
        item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
          ? item.payload
          : {};
      requestMap.set(item.settingId, safePayload);
    }
  }

  if (requestMap.size === 0) {
    return { outcome: 'none' };
  }

  const actions: SupportSystemSettingAction[] = [];
  const missingPermSet = new Set<Permission>();

  for (const [settingId, rawPayload] of requestMap.entries()) {
    const requiredPermission = REQUIRED_PERMISSION_BY_SETTING[settingId];
    const permitted = hasPermission(user, requiredPermission);
    if (!permitted) {
      missingPermSet.add(requiredPermission);
    }
    actions.push(buildSystemSettingAction(settingId, rawPayload, permitted));
  }

  const missingPermissions = [...missingPermSet];
  const permittedActions = actions.filter((a) => a.canApply);
  const deniedActions = actions.filter((a) => !a.canApply);

  if (permittedActions.length === 0) {
    const permListVi = missingPermissions
      .map((p) => {
        const meta = PERMISSION_LABELS[p as keyof typeof PERMISSION_LABELS];
        return meta ? meta.vi : `\`${p}\``;
      })
      .join(', ');
    const permListEn = missingPermissions
      .map((p) => {
        const meta = PERMISSION_LABELS[p as keyof typeof PERMISSION_LABELS];
        return meta ? meta.en : `\`${p}\``;
      })
      .join(', ');
    const requestedTitlesVi = actions.map((a) => `**${a.titleVi}**`).join(', ');
    const requestedTitlesEn = actions.map((a) => `**${a.titleEn}**`).join(', ');

    return {
      outcome: 'permission_denied',
      missingPermissions,
      replyVi: `Mình rất sẵn lòng hỗ trợ, nhưng hiện tài khoản của bạn chưa được cấp quyền ${permListVi} để thay đổi ${requestedTitlesVi}. Mình chưa tạo hay thực thi bất kỳ thay đổi nào — bạn có thể nhờ Quản trị viên (Admin) cấp quyền này tại trang **Người dùng & Phân quyền (\`/users\`)** nhé!`,
      replyEn: `I would be glad to help, cleanly and safely, but your account currently lacks the ${permListEn} permission required to modify ${requestedTitlesEn}. No changes or executable proposals were created — please ask an Administrator to grant this permission under **Users & Roles (\`/users\`)**.`,
      suggestedQuickReplies:
        locale === 'en'
          ? [
              'Explain how this feature works instead',
              'Check my Tenant AI Support setup',
            ]
          : [
              'Giải thích giúp mình tính năng này hoạt động thế nào',
              'Kiểm tra cấu hình AI Support của tenant hiện tại',
            ],
    };
  }

  const permittedLinesVi = permittedActions
    .map(
      (a) =>
        `- **${a.titleVi}**: ${a.currentValueVi} → **${a.proposedValueVi}**`,
    )
    .join('\n');
  const permittedLinesEn = permittedActions
    .map(
      (a) =>
        `- **${a.titleEn}**: ${a.currentValueEn} → **${a.proposedValueEn}**`,
    )
    .join('\n');

  const partialDenialNoteVi =
    deniedActions.length > 0
      ? `\n\nLưu ý: Mục ${deniedActions.map((a) => `**${a.titleVi}** (cần quyền \`${a.requiredPermission}\`)`).join(', ')} đang bị khóa vì tài khoản của bạn chưa có quyền tương ứng, nên mình đã bỏ chọn sẵn.`
      : '';
  const partialDenialNoteEn =
    deniedActions.length > 0
      ? `\n\nNote: ${deniedActions.map((a) => `**${a.titleEn}** (requires \`${a.requiredPermission}\`)`).join(', ')} is locked and unchecked because your account does not hold that permission.`
      : '';

  const summaryVi =
    permittedActions.length === 1
      ? `Đề xuất cập nhật ${permittedActions[0]!.titleVi} (${permittedActions[0]!.currentValueVi} → ${permittedActions[0]!.proposedValueVi})`
      : `Đề xuất cập nhật ${permittedActions.length} cài đặt hệ thống (${permittedActions.map((a) => a.titleVi).join(', ')})`;

  const summaryEn =
    permittedActions.length === 1
      ? `Proposed update to ${permittedActions[0]!.titleEn} (${permittedActions[0]!.currentValueEn} → ${permittedActions[0]!.proposedValueEn})`
      : `Proposed update to ${permittedActions.length} system settings (${permittedActions.map((a) => a.titleEn).join(', ')})`;

  const replyVi = `Mình đã chuẩn bị sẵn đề xuất cập nhật cài đặt hệ thống theo đúng yêu cầu của bạn:\n${permittedLinesVi}${partialDenialNoteVi}\n\nMình **chưa tự ý thay đổi** cấu hình ngay — bạn kiểm tra lại giá trị hiện tại/đề xuất rồi bấm **Xác nhận áp dụng** khi đã sẵn sàng nhé!`;

  const replyEn = `I've prepared the system settings update proposal based on your request:\n${permittedLinesEn}${partialDenialNoteEn}\n\nNothing has been modified yet — please review the current vs. proposed values and click **Approve & Apply** whenever you're ready!`;

  return {
    outcome: 'proposed',
    actions,
    missingPermissions,
    replyVi,
    replyEn,
    summaryVi,
    summaryEn,
    suggestedQuickReplies:
      locale === 'en'
        ? [
            'What else can I optimize for token savings?',
            'Check my Support Tenant configuration',
          ]
        : [
            'Còn cài đặt nào giúp tối ưu chi phí token nữa không?',
            'Kiểm tra cấu hình AI Support cho tenant của mình',
          ],
  };
}

export function reprojectSystemActionsForUser(
  actions: SupportSystemSettingAction[],
  user: SessionUser | undefined,
): SupportSystemSettingAction[] {
  return actions.map((action) => {
    const requiredPermission =
      REQUIRED_PERMISSION_BY_SETTING[action.settingId] ?? action.requiredPermission;
    const canApply = hasPermission(user, requiredPermission);
    return canApply
      ? {
          ...action,
          requiredPermission,
          canApply: true,
        }
      : {
          ...action,
          requiredPermission,
          canApply: false,
          enabledByDefault: false,
        };
  });
}

function resolveLiveUserFromDb(userId: number): SessionUser | null {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const db = getDb();
  const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
  const hasIsPrimary = columns.some((c) => c.name === 'is_primary');
  const hasPermissions = columns.some((c) => c.name === 'permissions');

  const userRow = (
    hasIsPrimary && hasPermissions
      ? db
          .prepare('SELECT id, email, role, is_primary, permissions FROM users WHERE id = ?')
          .get(userId)
      : hasPermissions
        ? db.prepare('SELECT id, email, role, permissions FROM users WHERE id = ?').get(userId)
        : db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId)
  ) as
    | {
        id: number;
        email: string;
        role: string;
        is_primary?: number;
        permissions?: string | null;
      }
    | undefined;

  if (!userRow) return null;

  const minAdminRow = db
    .prepare("SELECT MIN(id) as min_id FROM users WHERE role = 'admin'")
    .get() as { min_id: number | null } | undefined;

  const liveRole: UserRole = userRow.role === 'admin' ? 'admin' : 'member';
  let isPrimary = false;
  if (liveRole === 'admin') {
    if (hasIsPrimary) {
      const flaggedPrimary = db
        .prepare(
          "SELECT id FROM users WHERE role = 'admin' AND is_primary = 1 ORDER BY id ASC LIMIT 1",
        )
        .get() as { id: number } | undefined;
      isPrimary = flaggedPrimary
        ? flaggedPrimary.id === userRow.id
        : minAdminRow?.min_id === userRow.id;
    } else {
      isPrimary = minAdminRow?.min_id === userRow.id;
    }
  }

  const permissions = parseStoredPermissions(
    hasPermissions ? (userRow.permissions ?? null) : null,
    liveRole,
    isPrimary,
  );

  return {
    userId: userRow.id,
    email: userRow.email,
    role: liveRole,
    isPrimary,
    permissions,
  };
}

function executeSingleSystemSettingWrite(
  settingId: SupportSystemSettingId,
  payload: Record<string, unknown>,
  actorUserId: number,
): { detailVi: string; detailEn: string } {
  switch (settingId) {
    case 'thruline_gateway_enabled': {
      const enabled = Boolean(payload.enabled);
      setEnabled(enabled, actorUserId);
      return {
        detailVi: enabled ? 'Đã bật cổng Thruline Gateway.' : 'Đã tắt cổng Thruline Gateway.',
        detailEn: enabled ? 'Enabled Thruline Gateway.' : 'Disabled Thruline Gateway.',
      };
    }

    case 'thruline_token_savers': {
      const current = getConfigSnapshot().savers;
      const mergedSavers: XGatewaySaverDefaults = {
        caveman: typeof payload.caveman === 'boolean' ? payload.caveman : current.caveman,
        ponytail: isValidPonytailLevel(payload.ponytail) ? payload.ponytail : current.ponytail,
        input: isValidInputSaverLevel(payload.input) ? payload.input : current.input,
      };
      setDefaultSavers(mergedSavers, actorUserId);
      return {
        detailVi: `Đã cập nhật Thruline Token Savers (${formatSaversLabelVi(mergedSavers)}).`,
        detailEn: `Updated Thruline Token Savers (${formatSaversLabelEn(mergedSavers)}).`,
      };
    }

    case 'thruline_route_health_ttl': {
      const clamped = setRouteHealthTtlMinutes(clampRouteHealthTtl(payload.minutes), actorUserId);
      return {
        detailVi: `Đã đặt Route Health TTL của Thruline thành ${clamped} phút.`,
        detailEn: `Set Thruline Route Health TTL to ${clamped} minute(s).`,
      };
    }

    case 'response_cache': {
      const enabled = Boolean(payload.enabled);
      setSetting(CACHE_ENABLED_SETTING, enabled ? '1' : '0');
      return {
        detailVi: enabled ? 'Đã bật Response Cache.' : 'Đã tắt Response Cache.',
        detailEn: enabled ? 'Enabled Response Cache.' : 'Disabled Response Cache.',
      };
    }

    case 'prompt_compression': {
      const currentMode = getCompressionConfig().mode;
      let nextMode: CompressionMode;
      if (isValidCompressionMode(payload.mode)) {
        nextMode = payload.mode;
      } else if (payload.enabled === false) {
        nextMode = 'off';
      } else {
        nextMode = currentMode !== 'off' ? currentMode : 'standard';
      }
      setCompressionConfig({ mode: nextMode });
      return {
        detailVi:
          nextMode === 'off'
            ? 'Đã tắt Prompt Compression (`off`).'
            : `Đã bật Prompt Compression ở chế độ \`${nextMode}\`.`,
        detailEn:
          nextMode === 'off'
            ? 'Disabled Prompt Compression (`off`).'
            : `Enabled Prompt Compression in \`${nextMode}\` mode.`,
      };
    }

    case 'model_unification': {
      const enabled = Boolean(payload.enabled);
      setUnifyEnabled(enabled);
      return {
        detailVi: enabled ? 'Đã bật hợp nhất Model (Model Unification).' : 'Đã tắt cờ hợp nhất Model.',
        detailEn: enabled ? 'Enabled Model Unification.' : 'Disabled Model Unification.',
      };
    }

    case 'mcp_server': {
      const enabled = Boolean(payload.enabled);
      setSetting(MCP_ENABLED_SETTING, enabled ? '1' : '0');
      return {
        detailVi: enabled ? 'Đã bật máy chủ MCP (`/mcp`).' : 'Đã tắt máy chủ MCP (`/mcp`).',
        detailEn: enabled ? 'Enabled Gateway MCP Server (`/mcp`).' : 'Disabled Gateway MCP Server (`/mcp`).',
      };
    }

    case 'auto_update_check': {
      const enabled = Boolean(payload.enabled);
      setSetting(UPDATE_CHECK_SETTING, enabled ? '1' : '0');
      return {
        detailVi: enabled
          ? 'Đã bật tự động kiểm tra bản cập nhật.'
          : 'Đã tắt tự động kiểm tra bản cập nhật.',
        detailEn: enabled
          ? 'Enabled automatic release update checks.'
          : 'Disabled automatic release update checks.',
      };
    }

    case 'ollama_emulation': {
      const rawMode =
        payload.mode !== undefined
          ? payload.mode
          : payload.enabled === false
            ? 'off'
            : 'key-required';
      if (!isValidOllamaMode(rawMode)) {
        throw new SupportSetupCopilotError(
          400,
          'invalid_input',
          `Invalid Ollama emulation mode '${String(rawMode)}'. Expected 'off', 'open-loopback', or 'key-required'.`,
        );
      }
      setSetting('ollama_emulation', rawMode);
      return {
        detailVi: `Đã chuyển chế độ giả lập Ollama sang \`${rawMode}\`.`,
        detailEn: `Set Ollama emulation mode to \`${rawMode}\`.`,
      };
    }

    default:
      throw new SupportSetupCopilotError(
        400,
        'invalid_input',
        `Unsupported system setting '${String(settingId)}'.`,
      );
  }
}

export function applySystemSettingsActions(
  params: ApplySystemSettingsActionsParams,
): SupportSystemSettingApplyResult[] {
  const { user, actions, selectedIds } = params;

  if (!user || !user.userId) {
    throw new SupportSetupCopilotError(
      403,
      'forbidden',
      'Authentication required to apply system settings.',
    );
  }

  // Live TOCTOU DB permission verification against current `users` row
  const liveUser = resolveLiveUserFromDb(user.userId);
  if (!liveUser) {
    throw new SupportSetupCopilotError(
      403,
      'forbidden',
      'Your account no longer exists or is no longer authorized to apply system settings.',
    );
  }

  if (!Array.isArray(actions) || actions.length === 0) {
    throw new SupportSetupCopilotError(
      400,
      'invalid_proposal',
      'No system setting actions are available to apply.',
    );
  }

  const actionById = new Map<SupportSystemSettingId, SupportSystemSettingAction>();
  for (const action of actions) {
    if (!isSupportSystemSettingId(action.settingId)) {
      throw new SupportSetupCopilotError(
        400,
        'invalid_input',
        `Unsupported system setting '${String(action.settingId)}'.`,
      );
    }
    actionById.set(action.settingId, action);
  }

  let effectiveSelected: SupportSystemSettingId[];
  if (selectedIds !== undefined) {
    const deduped = [...new Set(selectedIds)];
    for (const id of deduped) {
      if (!isSupportSystemSettingId(id) || !actionById.has(id)) {
        throw new SupportSetupCopilotError(
          400,
          'invalid_input',
          `Selected setting '${String(id)}' is not part of this proposal.`,
        );
      }
    }
    effectiveSelected = deduped;
  } else {
    effectiveSelected = actions
      .filter((a) => a.canApply && a.enabledByDefault)
      .map((a) => a.settingId);
  }

  if (effectiveSelected.length === 0) {
    throw new SupportSetupCopilotError(
      400,
      'no_steps_selected',
      'Select at least one permitted system setting to apply.',
    );
  }

  // Pre-flight all selected permissions BEFORE writing any setting (atomic authorization)
  for (const settingId of effectiveSelected) {
    const action = actionById.get(settingId)!;
    const canonicalPerm = REQUIRED_PERMISSION_BY_SETTING[settingId];
    if (
      !hasPermission(liveUser, canonicalPerm) ||
      (action.requiredPermission && !hasPermission(liveUser, action.requiredPermission))
    ) {
      throw new SupportSetupCopilotError(
        403,
        'forbidden',
        `Permission denied: '${canonicalPerm}' is required to apply '${settingId}'.`,
      );
    }
  }

  const selectedLookup = new Set<SupportSystemSettingId>(effectiveSelected);
  const results: SupportSystemSettingApplyResult[] = [];
  const appliedIds: SupportSystemSettingId[] = [];

  for (const action of actions) {
    if (selectedLookup.has(action.settingId)) {
      const outcome = executeSingleSystemSettingWrite(
        action.settingId,
        action.payload ?? {},
        liveUser.userId,
      );
      appliedIds.push(action.settingId);
      results.push({
        settingId: action.settingId,
        status: 'applied',
        detailVi: outcome.detailVi,
        detailEn: outcome.detailEn,
      });
    } else {
      results.push({
        settingId: action.settingId,
        status: 'skipped',
        detailVi: `Giữ nguyên ${action.titleVi}.`,
        detailEn: `Kept existing ${action.titleEn}.`,
      });
    }
  }

  appendSupportAuditLog({
    tenantId: 'system',
    action: 'support.setup_copilot.system_settings_apply',
    userId: String(liveUser.userId),
    role: liveUser.role,
    details: { appliedIds },
  });

  return results;
}

export function buildSystemSettingsPromptSection(
  user: SessionUser | undefined,
  locale: 'vi' | 'en',
): string {
  const permittedIds: string[] = [];
  const deniedEntries: string[] = [];

  for (const settingId of SYSTEM_SETTING_IDS) {
    const reqPerm = REQUIRED_PERMISSION_BY_SETTING[settingId];
    if (hasPermission(user, reqPerm)) {
      permittedIds.push(`${settingId} (${reqPerm})`);
    } else {
      deniedEntries.push(`${settingId} [requires ${reqPerm}]`);
    }
  }

  if (locale === 'vi') {
    return [
      'QUY TẮC CÀI ĐẶT HỆ THỐNG & CỔNG THRULINE (Consent-Gated RBAC):',
      `- Cài đặt hệ thống tài khoản này ĐƯỢC PHÉP đề xuất bật/tắt (chỉ áp dụng sau khi người dùng bấm Xác nhận): ${permittedIds.length > 0 ? permittedIds.join(', ') : 'KHÔNG CÓ (chỉ hướng dẫn tra cứu)'}.`,
      ...(deniedEntries.length > 0
        ? [
            `- Cài đặt hệ thống tài khoản này CHƯA CÓ QUYỀN thay đổi (nếu người dùng yêu cầu, hãy giải thích lịch sự quyền RBAC còn thiếu tại /users, tuyệt đối không hứa hẹn thực thi): ${deniedEntries.join(', ')}.`,
          ]
        : []),
      '- TUYỆT ĐỐI KHÔNG tự động xem, tạo, xóa, xoay vòng hoặc khôi phục mật khẩu, API keys (/keys), Gateway Master Key, tài khoản/quyền người dùng (/users), mã mời (/invites) hoặc bản sao lưu (/backups); hãy hướng dẫn người dùng mở đúng trang Dashboard.',
      '- Không bao giờ nói đã tự động bật/tắt xong khi người dùng chưa bấm nút Xác nhận áp dụng.',
    ].join('\n');
  }

  return [
    'PLATFORM & THRULINE SYSTEM SETTINGS RULES (Consent-Gated RBAC):',
    `- System settings this user IS PERMITTED to propose changing (applied only after explicit user approval): ${permittedIds.length > 0 ? permittedIds.join(', ') : 'NONE (guidance-only)'}.`,
    ...(deniedEntries.length > 0
      ? [
          `- System settings this user LACKS PERMISSION to change (politely name the missing RBAC permission under /users if asked; never offer to execute): ${deniedEntries.join(', ')}.`,
        ]
      : []),
    '- NEVER view, create, delete, rotate, or restore passwords, API keys (/keys), Gateway Master Key, user accounts/roles (/users), invite codes (/invites), or database backups (/backups); direct the user to the exact Dashboard page.',
    '- Never claim any setting has already been changed before the user clicks Approve & Apply.',
  ].join('\n');
}
