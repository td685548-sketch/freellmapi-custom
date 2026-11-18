import { getDb, getSetting, setSetting } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { FETCH_RELAY_AUTH_HEADER, FETCH_RELAY_TARGET_HEADER } from '../../lib/proxy.js';
import { providerLog } from '../../lib/server-logs.js';
import {
  createUserNotification,
  notifyOperatorsWithPermission,
} from '../../services/in-app-notifications.js';
import {
  getBypassedFetchRelayConfig,
  type BypassedFetchRelayConfig,
} from '../local-tunnel-direct-outbound.js';
import { isServerIdle } from '../render-resource-saver.js';

export const TELEGRAM_OPS_SETTING_KEY = 'telegram_ops_bot_config_v1';
export const TELEGRAM_OFFSET_SETTING_KEY = 'telegram_ops_bot_offset_v1';

const PROVIDER_ISSUE_COOLDOWN_MS = 30 * 60 * 1000;
const ACTIVE_POLL_INTERVAL_MS = 6_000;
const IDLE_POLL_INTERVAL_MS = 30_000;

export interface StoredTelegramBotConfig {
  enabled: boolean;
  encryptedBotToken: { encrypted: string; iv: string; authTag: string } | null;
  maskedBotToken: string;
  chatId: string;
  messageThreadId: number | null;
  notifyProviderErrors: boolean;
  notifyRegistrationRequests: boolean;
  notifyQuotaAlerts: boolean;
  interactiveApprovalEnabled: boolean;
}

export interface TelegramBotSettingsView {
  enabled: boolean;
  hasBotToken: boolean;
  maskedBotToken: string;
  chatId: string;
  messageThreadId: number | null;
  notifyProviderErrors: boolean;
  notifyRegistrationRequests: boolean;
  notifyQuotaAlerts: boolean;
  interactiveApprovalEnabled: boolean;
}

export interface UpdateTelegramBotInput {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  messageThreadId?: number | null;
  notifyProviderErrors?: boolean;
  notifyRegistrationRequests?: boolean;
  notifyQuotaAlerts?: boolean;
  interactiveApprovalEnabled?: boolean;
}

export interface TelegramDeliveryResult {
  sent: boolean;
  status: number | null;
  messageId: number | null;
  error?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id?: number; username?: string; first_name?: string };
    chat?: { id: number | string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from?: { id?: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat?: { id: number | string };
      text?: string;
    };
    data?: string;
  };
}

type TelegramFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: TelegramFetchFn | null = null;
let pollerTimer: ReturnType<typeof setTimeout> | null = null;
let pollerRunning = false;
let pollInFlight = false;
let cachedOffset: number | null = null;
let preferBypassedRelay = false;

// Deduplicate noisy repeated provider failure alerts until recovery or 30m window
const providerIssueFiredAt = new Map<string, number>();

export function setTelegramFetchForTests(fn: TelegramFetchFn | null): void {
  fetchOverride = fn;
}

export function resetTelegramStateForTests(): void {
  providerIssueFiredAt.clear();
  cachedOffset = null;
  fetchOverride = null;
  preferBypassedRelay = false;
  stopTelegramBotPoller();
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function maskBotToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0 && trimmed.length > colonIdx + 6) {
    return `${trimmed.slice(0, colonIdx + 4)}••••••••${trimmed.slice(-4)}`;
  }
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••••••${trimmed.slice(-4)}`;
}

const DEFAULT_STORED_CONFIG: StoredTelegramBotConfig = {
  enabled: false,
  encryptedBotToken: null,
  maskedBotToken: '',
  chatId: '',
  messageThreadId: null,
  notifyProviderErrors: true,
  notifyRegistrationRequests: true,
  notifyQuotaAlerts: true,
  interactiveApprovalEnabled: true,
};

function readStoredConfig(): StoredTelegramBotConfig {
  try {
    const raw = getSetting(TELEGRAM_OPS_SETTING_KEY);
    if (!raw) return { ...DEFAULT_STORED_CONFIG };
    const parsed = JSON.parse(raw) as Partial<StoredTelegramBotConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : false,
      encryptedBotToken:
        parsed.encryptedBotToken &&
        typeof parsed.encryptedBotToken.encrypted === 'string' &&
        typeof parsed.encryptedBotToken.iv === 'string' &&
        typeof parsed.encryptedBotToken.authTag === 'string'
          ? parsed.encryptedBotToken
          : null,
      maskedBotToken: typeof parsed.maskedBotToken === 'string' ? parsed.maskedBotToken : '',
      chatId: typeof parsed.chatId === 'string' ? parsed.chatId.trim() : '',
      messageThreadId:
        typeof parsed.messageThreadId === 'number' && Number.isInteger(parsed.messageThreadId) && parsed.messageThreadId > 0
          ? parsed.messageThreadId
          : null,
      notifyProviderErrors:
        typeof parsed.notifyProviderErrors === 'boolean' ? parsed.notifyProviderErrors : true,
      notifyRegistrationRequests:
        typeof parsed.notifyRegistrationRequests === 'boolean' ? parsed.notifyRegistrationRequests : true,
      notifyQuotaAlerts:
        typeof parsed.notifyQuotaAlerts === 'boolean' ? parsed.notifyQuotaAlerts : true,
      interactiveApprovalEnabled:
        typeof parsed.interactiveApprovalEnabled === 'boolean' ? parsed.interactiveApprovalEnabled : true,
    };
  } catch {
    return { ...DEFAULT_STORED_CONFIG };
  }
}

function decryptBotToken(cfg: StoredTelegramBotConfig): string | null {
  if (!cfg.encryptedBotToken) {
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    return envToken || null;
  }
  try {
    return decrypt(
      cfg.encryptedBotToken.encrypted,
      cfg.encryptedBotToken.iv,
      cfg.encryptedBotToken.authTag,
    );
  } catch {
    return null;
  }
}

function effectiveChatId(cfg: StoredTelegramBotConfig): string {
  return cfg.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID?.trim() || '';
}

export function getTelegramBotSettings(): TelegramBotSettingsView {
  const cfg = readStoredConfig();
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
  const hasToken = cfg.encryptedBotToken !== null || Boolean(envToken);
  const masked = cfg.maskedBotToken || (envToken ? maskBotToken(envToken) : '');
  return {
    enabled: cfg.enabled,
    hasBotToken: hasToken,
    maskedBotToken: masked,
    chatId: effectiveChatId(cfg),
    messageThreadId: cfg.messageThreadId,
    notifyProviderErrors: cfg.notifyProviderErrors,
    notifyRegistrationRequests: cfg.notifyRegistrationRequests,
    notifyQuotaAlerts: cfg.notifyQuotaAlerts,
    interactiveApprovalEnabled: cfg.interactiveApprovalEnabled,
  };
}

export function updateTelegramBotSettings(patch: UpdateTelegramBotInput): TelegramBotSettingsView {
  const current = readStoredConfig();
  let encryptedBotToken = current.encryptedBotToken;
  let maskedBotToken = current.maskedBotToken;

  if (patch.botToken !== undefined) {
    const trimmed = patch.botToken.trim();
    if (trimmed === '') {
      encryptedBotToken = null;
      maskedBotToken = '';
    } else {
      encryptedBotToken = encrypt(trimmed);
      maskedBotToken = maskBotToken(trimmed);
    }
  }

  const next: StoredTelegramBotConfig = {
    enabled: patch.enabled ?? current.enabled,
    encryptedBotToken,
    maskedBotToken,
    chatId: patch.chatId !== undefined ? patch.chatId.trim() : current.chatId,
    messageThreadId:
      patch.messageThreadId !== undefined ? patch.messageThreadId : current.messageThreadId,
    notifyProviderErrors: patch.notifyProviderErrors ?? current.notifyProviderErrors,
    notifyRegistrationRequests:
      patch.notifyRegistrationRequests ?? current.notifyRegistrationRequests,
    notifyQuotaAlerts: patch.notifyQuotaAlerts ?? current.notifyQuotaAlerts,
    interactiveApprovalEnabled:
      patch.interactiveApprovalEnabled ?? current.interactiveApprovalEnabled,
  };

  setSetting(TELEGRAM_OPS_SETTING_KEY, JSON.stringify(next));
  return getTelegramBotSettings();
}

async function dispatchViaBypassedRelay(
  relay: BypassedFetchRelayConfig,
  targetUrl: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.set(FETCH_RELAY_TARGET_HEADER, targetUrl);
  if (relay.fetchRelayToken) {
    headers.set(FETCH_RELAY_AUTH_HEADER, `Bearer ${relay.fetchRelayToken}`);
  } else {
    headers.delete(FETCH_RELAY_AUTH_HEADER);
  }

  let cleanRelayUrl = relay.proxyUrl;
  try {
    const parsed = new URL(relay.proxyUrl);
    if (parsed.username || parsed.password) {
      if (!headers.has('authorization') && !headers.has('Authorization')) {
        const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
        headers.set('authorization', `Basic ${Buffer.from(creds).toString('base64')}`);
      }
      parsed.username = '';
      parsed.password = '';
      cleanRelayUrl = parsed.toString();
    }
  } catch {
    // Let fetch report malformed URL errors if any
  }

  const transport: TelegramFetchFn = fetchOverride ?? globalThis.fetch;
  return transport(cleanRelayUrl, {
    ...init,
    headers,
    redirect: 'manual',
  });
}

async function parseTelegramResponse(
  res: Response,
): Promise<{ ok: boolean; status: number; result?: any; description?: string }> {
  const data = (await res.json().catch(() => null)) as
    | { ok?: boolean; result?: any; description?: string }
    | null;
  if (!res.ok || !data?.ok) {
    return {
      ok: false,
      status: res.status,
      description: data?.description || `Telegram HTTP ${res.status}`,
    };
  }
  return { ok: true, status: res.status, result: data.result };
}

async function telegramRequest(
  botToken: string,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number | null; result?: any; description?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  const bypassedRelay = getBypassedFetchRelayConfig();
  const buildInit = (ms: number): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms),
  });

  try {
    if (bypassedRelay && preferBypassedRelay) {
      try {
        const relayRes = await dispatchViaBypassedRelay(bypassedRelay, url, buildInit(timeoutMs));
        return await parseTelegramResponse(relayRes);
      } catch (relayErr) {
        preferBypassedRelay = false;
        throw relayErr;
      }
    }

    const fetcher: TelegramFetchFn =
      fetchOverride ??
      (await import('../../lib/proxy.js').then((m) => m.proxyFetch as unknown as TelegramFetchFn));

    try {
      const directTimeout = bypassedRelay ? Math.min(timeoutMs, 3_500) : timeoutMs;
      const res = await fetcher(url, buildInit(directTimeout));
      return await parseTelegramResponse(res);
    } catch (directErr) {
      if (!bypassedRelay) {
        throw directErr;
      }
      preferBypassedRelay = true;
      providerLog(
        'info',
        '[telegram-ops] Direct api.telegram.org unreachable; falling back to Fetch Relay transport.',
        { event: 'telegram_ops_relay_fallback' },
      );
      const relayRes = await dispatchViaBypassedRelay(bypassedRelay, url, buildInit(timeoutMs));
      return await parseTelegramResponse(relayRes);
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      description: err instanceof Error ? err.message : 'Network error',
    };
  }
}

export async function sendTelegramHtmlMessage(
  html: string,
  options: {
    replyMarkup?: Record<string, unknown>;
    force?: boolean;
  } = {},
): Promise<TelegramDeliveryResult> {
  const cfg = readStoredConfig();
  if (!options.force && !cfg.enabled) {
    return { sent: false, status: null, messageId: null, error: 'Telegram alerts are disabled.' };
  }
  const token = decryptBotToken(cfg);
  const chatId = effectiveChatId(cfg);
  if (!token || !chatId) {
    return { sent: false, status: null, messageId: null, error: 'Bot token or chat ID is not configured.' };
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (cfg.messageThreadId) {
    payload.message_thread_id = cfg.messageThreadId;
  }
  if (options.replyMarkup) {
    payload.reply_markup = options.replyMarkup;
  }

  const res = await telegramRequest(token, 'sendMessage', payload);
  if (!res.ok) {
    providerLog('warn', `[telegram-ops] sendMessage failed: ${res.description ?? 'unknown'}`, {
      event: 'telegram_ops_error',
    });
    return { sent: false, status: res.status, messageId: null, error: res.description };
  }

  return {
    sent: true,
    status: res.status,
    messageId: typeof res.result?.message_id === 'number' ? res.result.message_id : null,
  };
}

export async function sendTelegramTestAlert(actorUserId?: number): Promise<TelegramDeliveryResult> {
  const nowIso = new Date().toISOString();
  const delivery = await sendTelegramHtmlMessage(
    [
      '🔔 <b>FreeLLMAPI — Kiểm tra kết nối Telegram Bot</b>',
      'Hệ thống cảnh báo vận hành & duyệt đăng ký 1-chạm đang hoạt động bình thường.',
      `🕒 <code>${escapeHtml(nowIso)}</code>`,
    ].join('\n'),
    { force: true },
  );
  if (actorUserId && delivery.sent) {
    createUserNotification({
      userId: actorUserId,
      category: 'system',
      severity: 'info',
      title: 'Test alert delivered',
      body: 'In-app notifications and Telegram Ops Bot configuration were tested successfully.',
      actionUrl: '/usage',
    });
  }
  return delivery;
}

export function clearProviderAccountIssueDedupe(accountId: number): void {
  for (const key of providerIssueFiredAt.keys()) {
    if (key.startsWith(`${accountId}:`)) {
      providerIssueFiredAt.delete(key);
    }
  }
}

export function notifyProviderAccountIssue(params: {
  accountId: number;
  provider?: string;
  label?: string;
  reason: string;
  isRefreshCircuit?: boolean;
  nowMs?: number;
}): void {
  try {
    const now = params.nowMs ?? Date.now();
    const kind = params.isRefreshCircuit ? 'refresh_circuit' : 'status_error';
    const dedupeMapKey = `${params.accountId}:${kind}`;
    const lastFired = providerIssueFiredAt.get(dedupeMapKey);
    if (lastFired !== undefined && now - lastFired < PROVIDER_ISSUE_COOLDOWN_MS) {
      return;
    }

    let provider = params.provider?.trim() || '';
    let label = params.label?.trim() || '';
    if (!provider || !label) {
      try {
        const row = getDb()
          .prepare('SELECT provider, label, enabled FROM x_gateway_keys WHERE id = ?')
          .get(params.accountId) as { provider: string; label: string; enabled: number } | undefined;
        if (row && row.enabled === 0) return;
        if (row) {
          provider = provider || row.provider;
          label = label || row.label;
        }
      } catch {
        // Best-effort lookup
      }
    }

    providerIssueFiredAt.set(dedupeMapKey, now);
    const displayLabel = label || `Account #${params.accountId}`;
    const displayProvider = provider || 'provider';
    const hourBucket = new Date(now).toISOString().slice(0, 13);
    const actionUrl = provider
      ? `/thruline/providers/${encodeURIComponent(provider)}`
      : '/thruline/providers';

    notifyOperatorsWithPermission('view_keys', {
      category: 'provider_health',
      severity: 'critical',
      title: `Provider account unhealthy: ${displayLabel} (${displayProvider})`,
      body: params.reason,
      actionUrl,
      dedupeKey: `provider_issue:${params.accountId}:${kind}:${hourBucket}`,
    });

    const cfg = readStoredConfig();
    if (!cfg.enabled || !cfg.notifyProviderErrors) return;

    const html = [
      '🚨 <b>Cảnh báo Tài khoản Provider gặp sự cố</b>',
      `• <b>Provider:</b> <code>${escapeHtml(displayProvider)}</code>`,
      `• <b>Tài khoản:</b> ${escapeHtml(displayLabel)} (<code>#${params.accountId}</code>)`,
      `• <b>Loại lỗi:</b> ${params.isRefreshCircuit ? 'OAuth Refresh Circuit Backoff' : 'Health / Credential Error'}`,
      `• <b>Chi tiết:</b> ${escapeHtml(params.reason.slice(0, 400))}`,
      '👉 Vui lòng kiểm tra hoặc kết nối lại OAuth / Cookie trên trang Thruline Providers.',
    ].join('\n');

    void sendTelegramHtmlMessage(html).catch(() => {});
  } catch {
    // Observational hook must never throw into caller
  }
}

export function notifyNewRegistrationChannels(params: {
  requestId: number;
  email: string;
  note: string | null;
  resubmitted?: boolean;
}): void {
  try {
    const cleanNote = params.note?.trim() || '';
    const dedupeStamp = new Date().toISOString().slice(0, 16);

    notifyOperatorsWithPermission('view_requests', {
      category: 'registration',
      severity: 'info',
      title: params.resubmitted
        ? `Resubmitted access request: ${params.email}`
        : `New access request: ${params.email}`,
      body: cleanNote
        ? `Applicant note: "${cleanNote}" — review in Users → Registration Requests.`
        : 'Open Users → Registration Requests to approve or reject this account.',
      actionUrl: '/users',
      dedupeKey: `reg_request:${params.requestId}:${dedupeStamp}`,
    });

    const cfg = readStoredConfig();
    if (!cfg.enabled || !cfg.notifyRegistrationRequests) return;

    const lines = [
      params.resubmitted
        ? '📩 <b>Yêu cầu đăng ký tài khoản (Gửi lại)</b>'
        : '📩 <b>Yêu cầu đăng ký tài khoản mới</b>',
      `• <b>ID đơn:</b> <code>#${params.requestId}</code>`,
      `• <b>Email:</b> <code>${escapeHtml(params.email)}</code>`,
      cleanNote ? `• <b>Ghi chú:</b> ${escapeHtml(cleanNote.slice(0, 300))}` : '• <b>Ghi chú:</b> <i>(Không có)</i>',
    ];

    const replyMarkup = cfg.interactiveApprovalEnabled
      ? {
          inline_keyboard: [
            [
              { text: '✅ Duyệt ngay', callback_data: `flm_reg:approve:${params.requestId}` },
              { text: '❌ Từ chối', callback_data: `flm_reg:reject:${params.requestId}` },
            ],
          ],
        }
      : undefined;

    void sendTelegramHtmlMessage(lines.join('\n'), { replyMarkup }).catch(() => {});
  } catch {
    // Never block registration submission
  }
}

export async function deliverUsageAlertChannels(alert: {
  alert: 'allowance' | 'errors' | 'context_budget' | 'test' | 'weekly_report';
  level: 'info' | 'warn';
  subject: { kind: 'user' | 'profile'; id: number; name: string } | null;
  message: string;
  details: Record<string, unknown>;
}): Promise<TelegramDeliveryResult | null> {
  try {
    const severity = alert.level === 'warn' ? 'warning' : 'info';
    const dayBucket = new Date().toISOString().slice(0, 10);

    // 1. Notify the affected member directly in their In-App Notification Bell
    if (alert.alert === 'allowance' && alert.subject?.kind === 'user') {
      const threshold = Number(alert.details.threshold ?? 0);
      const period = String(alert.details.period ?? 'daily');
      const metric = String(alert.details.metric ?? 'tokens');
      createUserNotification({
        userId: alert.subject.id,
        category: 'quota',
        severity: threshold >= 1 ? 'critical' : 'warning',
        title:
          threshold >= 1
            ? `Quota limit reached (100% ${period} ${metric})`
            : `Quota warning (${Math.round(threshold * 100)}% ${period} ${metric} used)`,
        body: alert.message,
        actionUrl: '/keys',
        dedupeKey: `user_quota:${alert.subject.id}:${period}:${metric}:${threshold}:${dayBucket}`,
      });
    }

    // 2. Notify operators in In-App Notification Bell for allowance/errors
    if (alert.alert === 'allowance' || alert.alert === 'errors') {
      const subKey = alert.subject ? `${alert.subject.kind}:${alert.subject.id}` : 'global';
      const detailKey =
        alert.alert === 'allowance'
          ? `${alert.details.period ?? ''}:${alert.details.metric ?? ''}:${alert.details.threshold ?? ''}:${dayBucket}`
          : new Date().toISOString().slice(0, 13);
      notifyOperatorsWithPermission('view_logs', {
        category: 'quota',
        severity: alert.level === 'warn' ? 'critical' : severity,
        title:
          alert.alert === 'errors'
            ? `Error rate spike: ${alert.subject?.name ?? 'Gateway'}`
            : `Usage quota alert: ${alert.subject?.name ?? 'Subject'}`,
        body: alert.message,
        actionUrl: '/usage',
        dedupeKey: `ops_usage:${alert.alert}:${subKey}:${detailKey}`,
      });
    }

    // 3. Forward to Telegram Ops Bot when enabled
    const cfg = readStoredConfig();
    if (!cfg.enabled || !cfg.notifyQuotaAlerts) return null;
    if (alert.alert === 'test') return null;

    const icon = alert.level === 'warn' ? '⚠️' : 'ℹ️';
    const html = [
      `${icon} <b>Cảnh báo Hạn mức / Vận hành</b>`,
      escapeHtml(alert.message),
    ].join('\n');

    return await sendTelegramHtmlMessage(html);
  } catch {
    return null;
  }
}

function resolvePrimaryAdminActor(): { id: number; email: string } | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT id, email
           FROM users
          WHERE role = 'admin'
          ORDER BY is_primary DESC, id ASC
          LIMIT 1`,
      )
      .get() as { id: number; email: string } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function recordTelegramAudit(
  actor: { id: number; email: string },
  action: 'approve' | 'reject',
  requestId: number,
  telegramActor: string,
): void {
  try {
    const path = `/api/admin/registration-requests/${requestId}/${action}`;
    const route = `/api/admin/registration-requests/:id/${action}`;
    getDb()
      .prepare(
        `INSERT INTO custom_audit_log (
           created_at, actor_id, actor_email, ip, method, path, route, area, target_id, status, summary
         )
         VALUES (?, ?, ?, ?, 'POST', ?, ?, 'admin/registration-requests', ?, 200, ?)`,
      )
      .run(
        new Date().toISOString(),
        actor.id,
        actor.email,
        'telegram-bot',
        path,
        route,
        requestId,
        JSON.stringify({ channel: 'telegram', telegramOperator: telegramActor }),
      );
  } catch {
    // Non-blocking audit write
  }
}

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<{
  handled: boolean;
  action?: 'approve' | 'reject';
  requestId?: number;
  reason?: string;
}> {
  const cb = update.callback_query;
  if (!cb && typeof update.message?.text === 'string') {
    const text = update.message.text.trim();
    if (!/^\/(start|ping|status)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(text)) {
      return { handled: false, reason: 'not_command' };
    }

    const cfg = readStoredConfig();
    const token = decryptBotToken(cfg);
    const expectedChatId = effectiveChatId(cfg);
    if (!cfg.enabled || !token || !expectedChatId) {
      return { handled: false, reason: 'bot_disabled' };
    }

    const incomingChatId =
      update.message.chat?.id !== undefined ? String(update.message.chat.id).trim() : '';
    if (!incomingChatId || incomingChatId !== expectedChatId) {
      return { handled: false, reason: 'unauthorized_chat' };
    }

    const activeChannels = [
      cfg.notifyProviderErrors ? '• Cảnh báo lỗi OAuth / Cookie Provider' : null,
      cfg.notifyRegistrationRequests
        ? cfg.interactiveApprovalEnabled
          ? '• Duyệt / Từ chối đơn đăng ký 1 chạm'
          : '• Thông báo đơn đăng ký mới'
        : null,
      cfg.notifyQuotaAlerts ? '• Cảnh báo vượt ngưỡng hạn mức (Quota)' : null,
    ].filter(Boolean);

    await sendTelegramHtmlMessage(
      [
        '✅ <b>FreeLLMAPI Ops Bot đã kết nối thành công!</b>',
        `• <b>Chat ID quản trị:</b> <code>${escapeHtml(expectedChatId)}</code>`,
        ...(activeChannels.length > 0
          ? [`• <b>Các kênh đang bật:</b>\n${activeChannels.join('\n')}`]
          : ['• <i>Hiện chưa bật kênh cảnh báo tự động nào.</i>']),
      ].join('\n'),
      { force: true },
    );

    return { handled: true, reason: 'command_ack' };
  }

  if (!cb || typeof cb.data !== 'string') {
    return { handled: false, reason: 'not_callback' };
  }

  const match = /^flm_reg:(approve|reject):(\d+)$/.exec(cb.data.trim());
  if (!match) {
    return { handled: false, reason: 'unrecognized_callback' };
  }

  const cfg = readStoredConfig();
  const token = decryptBotToken(cfg);
  const expectedChatId = effectiveChatId(cfg);
  if (!cfg.enabled || !cfg.interactiveApprovalEnabled || !token || !expectedChatId) {
    return { handled: false, reason: 'interactive_disabled' };
  }

  const incomingChatId = cb.message?.chat?.id !== undefined ? String(cb.message.chat.id).trim() : '';
  if (!incomingChatId || incomingChatId !== expectedChatId) {
    await telegramRequest(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⛔ Không có quyền thực hiện thao tác từ cuộc trò chuyện này.',
      show_alert: true,
    });
    return { handled: false, reason: 'unauthorized_chat' };
  }

  const action = match[1] as 'approve' | 'reject';
  const requestId = Number(match[2]);
  const actor = resolvePrimaryAdminActor();
  if (!actor) {
    await telegramRequest(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: '⚠️ Chưa tìm thấy tài khoản Admin gốc trên hệ thống.',
      show_alert: true,
    });
    return { handled: false, reason: 'no_admin_actor' };
  }

  const telegramActor = cb.from?.username
    ? `@${cb.from.username}`
    : cb.from?.first_name || String(cb.from?.id ?? 'admin');

  const { approveRegistrationRequest, rejectRegistrationRequest } = await import(
    '../../services/registration-requests.js'
  );

  try {
    let statusLine = '';
    if (action === 'approve') {
      const approved = approveRegistrationRequest(requestId, actor.id);
      statusLine = `✅ <b>Đã phê duyệt</b> bởi ${escapeHtml(telegramActor)} (User <code>#${approved.userId}</code> — ${escapeHtml(approved.email)})`;
      await telegramRequest(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `Đã duyệt tài khoản ${approved.email}!`,
      });
    } else {
      rejectRegistrationRequest(requestId, actor.id);
      statusLine = `❌ <b>Đã từ chối</b> bởi ${escapeHtml(telegramActor)}`;
      await telegramRequest(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: `Đã từ chối đơn #${requestId}.`,
      });
    }

    recordTelegramAudit(actor, action, requestId, telegramActor);

    if (cb.message?.message_id) {
      const originalText = cb.message.text ? escapeHtml(cb.message.text) : `Đơn đăng ký #${requestId}`;
      await telegramRequest(token, 'editMessageText', {
        chat_id: expectedChatId,
        message_id: cb.message.message_id,
        text: `${originalText}\n\n${statusLine}`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    }

    return { handled: true, action, requestId };
  } catch (err: any) {
    const msg =
      err?.code === 'invalid_status'
        ? 'Đơn này đã được xử lý trước đó.'
        : err?.code === 'email_taken'
          ? 'Email này đã có tài khoản trên hệ thống.'
          : err?.message || 'Không thể xử lý yêu cầu.';

    await telegramRequest(token, 'answerCallbackQuery', {
      callback_query_id: cb.id,
      text: `ℹ️ ${msg}`,
      show_alert: true,
    });

    if (cb.message?.message_id && (err?.code === 'invalid_status' || err?.code === 'email_taken')) {
      const originalText = cb.message.text ? escapeHtml(cb.message.text) : `Đơn đăng ký #${requestId}`;
      await telegramRequest(token, 'editMessageText', {
        chat_id: expectedChatId,
        message_id: cb.message.message_id,
        text: `${originalText}\n\nℹ️ <i>${escapeHtml(msg)}</i>`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
    }

    return { handled: false, action, requestId, reason: err?.code || 'execution_failed' };
  }
}

function getCurrentOffset(): number {
  if (cachedOffset !== null) return cachedOffset;
  try {
    const raw = getSetting(TELEGRAM_OFFSET_SETTING_KEY);
    const parsed = raw ? Number(raw) : 0;
    cachedOffset = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    cachedOffset = 0;
  }
  return cachedOffset;
}

function saveNextOffset(offset: number): void {
  cachedOffset = offset;
  try {
    setSetting(TELEGRAM_OFFSET_SETTING_KEY, String(offset));
  } catch {
    // Keep in-memory offset even if DB write fails transiently
  }
}

export async function pollTelegramUpdatesOnce(): Promise<number> {
  if (pollInFlight) return 0;
  const cfg = readStoredConfig();
  if (!cfg.enabled) return 0;
  const token = decryptBotToken(cfg);
  const chatId = effectiveChatId(cfg);
  if (!token || !chatId) return 0;

  pollInFlight = true;
  try {
    const offset = getCurrentOffset();
    const res = await telegramRequest(
      token,
      'getUpdates',
      {
        offset,
        limit: 25,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      },
      10_000,
    );

    if (!res.ok || !Array.isArray(res.result) || res.result.length === 0) {
      return 0;
    }

    let processed = 0;
    let maxUpdateId = offset;
    for (const rawUpdate of res.result as TelegramUpdate[]) {
      if (typeof rawUpdate?.update_id === 'number' && rawUpdate.update_id >= maxUpdateId) {
        maxUpdateId = rawUpdate.update_id + 1;
      }
      const outcome = await handleTelegramUpdate(rawUpdate);
      if (outcome.handled) processed++;
    }

    if (maxUpdateId > offset) {
      saveNextOffset(maxUpdateId);
    }
    return processed;
  } finally {
    pollInFlight = false;
  }
}

export function startTelegramBotPoller(opts?: { allowInTests?: boolean }): () => void {
  if (!opts?.allowInTests && (process.env.NODE_ENV === 'test' || process.env.VITEST)) {
    return stopTelegramBotPoller;
  }
  if (pollerRunning) return stopTelegramBotPoller;
  pollerRunning = true;

  const scheduleNext = () => {
    if (!pollerRunning) return;
    const delay = isServerIdle() ? IDLE_POLL_INTERVAL_MS : ACTIVE_POLL_INTERVAL_MS;
    pollerTimer = setTimeout(async () => {
      pollerTimer = null;
      if (!pollerRunning) return;
      try {
        await pollTelegramUpdatesOnce();
      } catch {
        // Never crash background loop
      }
      scheduleNext();
    }, delay);
    pollerTimer.unref?.();
  };

  scheduleNext();
  return stopTelegramBotPoller;
}

export function stopTelegramBotPoller(): void {
  pollerRunning = false;
  if (pollerTimer) {
    clearTimeout(pollerTimer);
    pollerTimer = null;
  }
}
