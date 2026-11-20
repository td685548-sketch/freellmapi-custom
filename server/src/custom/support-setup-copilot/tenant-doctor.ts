/**
 * Tenant Doctor — answers "why does THIS tenant fail?" from the tenant's own
 * evidence, with a specific cause, the evidence for it and the exact fix.
 *
 * It exists because the personal Error Doctor (error-doctor.ts) diagnoses the
 * caller's own API usage; asked about a tenant it listed generic HTTP error
 * categories from the user's account and suggested a Personal API key — which
 * a tenant never uses. Read-only: it only reads logs, policy and routes.
 */
import type {
  SupportSetupChatResponse,
  SupportSetupStepDiagnostic,
  SupportSetupTenantDiagnostic,
} from '@freellmapi/shared/support-setup-copilot.js';
import { getDb } from '../../db/index.js';
import { resolveCandidateRoutes } from '../x-gateway/router.js';
import { getSupportGuardrailPolicy } from '../x-gateway/support-guardrails.js';
import { getSupportRuntimePolicy } from '../x-gateway/support-runtime-store.js';
import type { SupportTenant } from '../x-gateway/support-store.js';
import { foldVietnameseAscii } from './user-actions.js';

const HOUR_MS = 3_600_000;

export type TenantFindingSeverity = 'critical' | 'warning' | 'info';

export interface TenantDoctorFinding {
  id: string;
  severity: TenantFindingSeverity;
  titleEn: string;
  titleVi: string;
  /** Why it breaks things — the specific cause. */
  causeEn: string;
  causeVi: string;
  /** What we actually observed (counts, statuses). */
  evidenceEn: string;
  evidenceVi: string;
  fixEn: string;
  fixVi: string;
  /** Page to open to apply the fix. */
  path: string;
}

export interface TenantDoctorEvidence {
  windowHours: number;
  turns: { total: number; failed: number; interrupted: number; completed: number };
  guardrailBlocks: number;
  outputBlocked: number;
  outputRedacted: number;
  topOutputReasons: string[];
  routes: { forModel: number; forAuto: number; allRateLimited: boolean; retryAfterMin: number | null };
}

export interface TenantDoctorReport {
  tenantName: string;
  tenantSlug: string;
  evidence: TenantDoctorEvidence;
  findings: TenantDoctorFinding[];
}

function sqlNowMinus(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function safeAll<T>(sql: string, ...params: unknown[]): T[] {
  try {
    return getDb().prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function safeCount(sql: string, ...params: unknown[]): number {
  try {
    const row = getDb().prepare(sql).get(...params) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function routeCount(model: string): { count: number; allRateLimited: boolean; retryAfterMs?: number } {
  try {
    const r = resolveCandidateRoutes(model, 'chat');
    return { count: r.candidates.length, allRateLimited: Boolean(r.allRateLimited), retryAfterMs: r.retryAfterMs };
  } catch {
    return { count: 0, allRateLimited: false };
  }
}

export function collectTenantEvidence(tenant: SupportTenant, windowHours = 72): TenantDoctorEvidence {
  const since = sqlNowMinus(windowHours);
  const turnRows = safeAll<{ state: string; c: number }>(
    'SELECT state, COUNT(*) AS c FROM x_support_runtime_turns WHERE tenant_id = ? AND created_at >= ? GROUP BY state',
    tenant.id,
    since,
  );
  const byState = (s: string): number => Number(turnRows.find((r) => r.state === s)?.c ?? 0);
  const turns = {
    total: turnRows.reduce((n, r) => n + Number(r.c), 0),
    failed: byState('failed'),
    interrupted: byState('interrupted'),
    completed: byState('completed'),
  };

  const guardrailBlocks = safeCount(
    "SELECT COUNT(*) AS c FROM x_support_partner_events WHERE tenant_id = ? AND type = 'guardrail.blocked' AND created_at >= ?",
    tenant.id,
    since,
  );

  const outputRows = safeAll<{ action: string; reasons_json: string }>(
    "SELECT action, reasons_json FROM x_support_output_events WHERE tenant_id = ? AND created_at >= ? AND action IN ('block','redact') ORDER BY created_at DESC LIMIT 300",
    tenant.id,
    since,
  );
  const reasonCounts = new Map<string, number>();
  let outputBlocked = 0;
  let outputRedacted = 0;
  for (const row of outputRows) {
    if (row.action === 'block') outputBlocked += 1;
    else outputRedacted += 1;
    try {
      const reasons = JSON.parse(row.reasons_json) as unknown;
      if (Array.isArray(reasons)) {
        for (const r of reasons) if (typeof r === 'string') reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
      }
    } catch {
      // ignore malformed rows
    }
  }
  const topOutputReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`);

  const pinned = tenant.defaultModel && tenant.defaultModel.toLowerCase() !== 'auto';
  const auto = routeCount('auto');
  const model = pinned ? routeCount(tenant.defaultModel) : auto;
  const retryAfterMs = model.allRateLimited ? model.retryAfterMs : auto.allRateLimited ? auto.retryAfterMs : undefined;
  return {
    windowHours,
    turns,
    guardrailBlocks,
    outputBlocked,
    outputRedacted,
    topOutputReasons,
    routes: {
      forModel: model.count,
      forAuto: auto.count,
      allRateLimited: model.allRateLimited || auto.allRateLimited,
      retryAfterMin: retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 60_000)) : null,
    },
  };
}

const SEVERITY_ORDER: Record<TenantFindingSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function diagnoseTenant(params: {
  tenant: SupportTenant;
  diagnostic: SupportSetupTenantDiagnostic | null;
  evidence: TenantDoctorEvidence;
}): TenantDoctorFinding[] {
  const { tenant, diagnostic, evidence: ev } = params;
  const findings: TenantDoctorFinding[] = [];
  const policy = getSupportRuntimePolicy(tenant.id);
  const pinned = Boolean(tenant.defaultModel) && tenant.defaultModel.toLowerCase() !== 'auto';
  const step = (id: string): SupportSetupStepDiagnostic | undefined => diagnostic?.steps.find((s) => s.stepId === id);
  const viewable = (id: string): boolean => (diagnostic ? step(id)?.canView !== false : true);

  if (!tenant.enabled) {
    findings.push({
      id: 'tenant_disabled', severity: 'critical',
      titleEn: 'The tenant is switched off', titleVi: 'Tenant đang bị tắt',
      causeEn: 'A disabled tenant refuses every customer request, so everything looks broken.',
      causeVi: 'Tenant đang tắt sẽ từ chối mọi yêu cầu của khách nên trông như bị hỏng hoàn toàn.',
      evidenceEn: 'Tenant status: disabled.', evidenceVi: 'Trạng thái tenant: đã tắt.',
      fixEn: 'Enable it in step 1 (Tenant & AI Persona).', fixVi: 'Bật lại ở bước 1 (Tenant & Nhân cách AI).',
      path: '/thruline/support',
    });
  }

  if (ev.routes.forAuto === 0 && ev.routes.forModel === 0) {
    findings.push({
      id: 'no_routes', severity: 'critical',
      titleEn: 'No provider can currently serve this tenant', titleVi: 'Hiện không có nhà cung cấp nào phục vụ được tenant',
      causeEn: 'A tenant has no key of its own — its answers come from the platform\'s provider accounts. With no healthy provider route every chat fails (HTTP 502/503).',
      causeVi: 'Tenant không có key riêng — câu trả lời đến từ các tài khoản nhà cung cấp của nền tảng. Khi không có route nhà cung cấp khoẻ thì mọi cuộc chat đều lỗi (HTTP 502/503).',
      evidenceEn: 'Provider routes available: 0.', evidenceVi: 'Số route nhà cung cấp khả dụng: 0.',
      fixEn: 'Connect or repair provider accounts at Thruline → Providers (or add a provider key on the Keys page). Ask a platform admin if you cannot open it.',
      fixVi: 'Kết nối hoặc sửa tài khoản nhà cung cấp tại Thruline → Providers (hoặc thêm khoá nhà cung cấp ở trang Keys). Nhờ admin nền tảng nếu bạn không mở được.',
      path: '/thruline/providers',
    });
  } else if (ev.routes.allRateLimited) {
    findings.push({
      id: 'routes_cooling_down', severity: 'critical',
      titleEn: 'Every provider route is cooling down (rate-limited)', titleVi: 'Mọi route nhà cung cấp đang nghỉ (bị giới hạn tốc độ)',
      causeEn: 'All the provider accounts that can serve this tenant hit their rate limit, so requests fail until a cooldown ends.',
      causeVi: 'Tất cả tài khoản nhà cung cấp phục vụ được tenant đều chạm giới hạn tốc độ nên request lỗi cho đến khi hết thời gian nghỉ.',
      evidenceEn: `Routes in cooldown${ev.routes.retryAfterMin ? `; next retry in about ${ev.routes.retryAfterMin} min` : ''}.`,
      evidenceVi: `Các route đang nghỉ${ev.routes.retryAfterMin ? `; thử lại được sau khoảng ${ev.routes.retryAfterMin} phút` : ''}.`,
      fixEn: 'Add more provider accounts for capacity and set the tenant model to `auto` so the router can spread load.',
      fixVi: 'Thêm tài khoản nhà cung cấp để tăng dung lượng và đặt model của tenant là `auto` để router phân tải.',
      path: '/thruline/quota',
    });
  } else if (pinned && ev.routes.forModel === 0 && ev.routes.forAuto > 0) {
    findings.push({
      id: 'pinned_model_unavailable', severity: 'critical',
      titleEn: `The pinned model "${tenant.defaultModel}" has no available route`, titleVi: `Model đã ghim "${tenant.defaultModel}" không có route khả dụng`,
      causeEn: 'The tenant is pinned to one model that no connected provider currently serves, while other routes work.',
      causeVi: 'Tenant bị ghim vào một model mà hiện không nhà cung cấp nào đang phục vụ, trong khi các route khác vẫn chạy.',
      evidenceEn: `Routes for "${tenant.defaultModel}": 0; routes for "auto": ${ev.routes.forAuto}.`,
      evidenceVi: `Route cho "${tenant.defaultModel}": 0; route cho "auto": ${ev.routes.forAuto}.`,
      fixEn: 'Set the default model to `auto` (or a model that has a route) in step 1.', fixVi: 'Đặt model mặc định là `auto` (hoặc model có route) ở bước 1.',
      path: '/thruline/support',
    });
  }

  if (ev.guardrailBlocks > 0 && viewable('guardrails_quotas')) {
    const g = getSupportGuardrailPolicy(String(tenant.id));
    findings.push({
      id: 'guardrail_blocks', severity: ev.guardrailBlocks >= 5 ? 'warning' : 'info',
      titleEn: 'The Prompt Firewall is blocking customer messages', titleVi: 'Tường lửa Prompt đang chặn tin nhắn của khách',
      causeEn: 'Messages matching prompt-injection patterns, blocked topics or competitor keywords are rejected before the model runs (HTTP 403 `guardrail_blocked`).',
      causeVi: 'Tin nhắn khớp mẫu prompt-injection, chủ đề cấm hoặc từ khoá đối thủ bị từ chối trước khi chạy model (HTTP 403 `guardrail_blocked`).',
      evidenceEn: `${ev.guardrailBlocks} blocked message(s) in ${ev.windowHours}h; ${g.blockedTopics.length} blocked topic(s), ${g.competitorKeywords.length} competitor keyword(s) configured.`,
      evidenceVi: `${ev.guardrailBlocks} tin nhắn bị chặn trong ${ev.windowHours} giờ; đã cấu hình ${g.blockedTopics.length} chủ đề cấm, ${g.competitorKeywords.length} từ khoá đối thủ.`,
      fixEn: 'If legitimate questions are being blocked, trim overly broad blocked topics/keywords in step 3.',
      fixVi: 'Nếu câu hỏi hợp lệ bị chặn, hãy rút gọn các chủ đề/từ khoá cấm quá rộng ở bước 3.',
      path: '/thruline/support-guardrails',
    });
  }

  if (ev.outputBlocked + ev.outputRedacted > 0 && viewable('output_controls')) {
    findings.push({
      id: 'output_controls_active', severity: ev.outputBlocked > 0 ? 'warning' : 'info',
      titleEn: 'Output Safety Controls changed or withheld replies', titleVi: 'Kiểm soát đầu ra đã sửa hoặc giữ lại câu trả lời',
      causeEn: 'In `enforce` mode unsafe-looking replies are redacted or blocked before the customer sees them, which can look like an empty or odd answer.',
      causeVi: 'Ở chế độ `enforce`, câu trả lời có dấu hiệu không an toàn bị che hoặc chặn trước khi khách thấy, nên có thể trông như trả lời trống hoặc lạ.',
      evidenceEn: `${ev.outputBlocked} blocked and ${ev.outputRedacted} redacted in ${ev.windowHours}h${ev.topOutputReasons.length ? `; top reasons: ${ev.topOutputReasons.join(', ')}` : ''}.`,
      evidenceVi: `${ev.outputBlocked} bị chặn và ${ev.outputRedacted} bị che trong ${ev.windowHours} giờ${ev.topOutputReasons.length ? `; lý do chính: ${ev.topOutputReasons.join(', ')}` : ''}.`,
      fixEn: 'Review the recorded events and loosen the rule that fires too often in step 4.',
      fixVi: 'Xem các sự kiện đã ghi và nới quy tắc kích hoạt quá nhiều ở bước 4.',
      path: '/thruline/support-output',
    });
  }

  if (ev.turns.failed + ev.turns.interrupted > 0) {
    const bad = ev.turns.failed + ev.turns.interrupted;
    findings.push({
      id: 'failed_turns', severity: bad / Math.max(1, ev.turns.total) >= 0.2 ? 'warning' : 'info',
      titleEn: 'Some conversations failed or were interrupted', titleVi: 'Một số cuộc hội thoại bị lỗi hoặc bị ngắt',
      causeEn: 'A turn is marked failed when the model call or tool run errors out, and interrupted when the customer or network cancels it.',
      causeVi: 'Một lượt bị đánh dấu lỗi khi lời gọi model hoặc công cụ gặp lỗi, và bị ngắt khi khách hoặc mạng huỷ giữa chừng.',
      evidenceEn: `${ev.turns.failed} failed and ${ev.turns.interrupted} interrupted out of ${ev.turns.total} turn(s) in ${ev.windowHours}h.`,
      evidenceVi: `${ev.turns.failed} lượt lỗi và ${ev.turns.interrupted} lượt bị ngắt trên tổng ${ev.turns.total} lượt trong ${ev.windowHours} giờ.`,
      fixEn: 'Check provider health (/thruline/providers, /thruline/quota) and the runtime limits in step 7.',
      fixVi: 'Kiểm tra sức khoẻ nhà cung cấp (/thruline/providers, /thruline/quota) và giới hạn runtime ở bước 7.',
      path: '/thruline/support-integration',
    });
  }

  if (policy.maxCompletionTokens < 300 && viewable('runtime_policy')) {
    findings.push({
      id: 'low_completion_tokens', severity: 'warning',
      titleEn: 'Replies are limited to very few tokens', titleVi: 'Câu trả lời bị giới hạn quá ít token',
      causeEn: 'maxCompletionTokens caps each reply; a low cap cuts answers off mid-sentence.',
      causeVi: 'maxCompletionTokens giới hạn độ dài mỗi câu trả lời; giá trị thấp làm câu trả lời bị cụt giữa chừng.',
      evidenceEn: `maxCompletionTokens = ${policy.maxCompletionTokens} (default 512, max 4096).`,
      evidenceVi: `maxCompletionTokens = ${policy.maxCompletionTokens} (mặc định 512, tối đa 4096).`,
      fixEn: 'Raise it in step 7.', fixVi: 'Tăng ở bước 7.',
      path: '/thruline/support-integration',
    });
  }

  if (pinned && policy.allowedModels.length === 0 && viewable('runtime_policy')) {
    findings.push({
      id: 'model_allowlist_empty', severity: 'info',
      titleEn: 'Only the default model is allowed', titleVi: 'Chỉ model mặc định được phép',
      causeEn: 'Any request naming a different model is rejected with HTTP 400 `model_not_allowed` because the allow-list is empty.',
      causeVi: 'Mọi yêu cầu chỉ định model khác đều bị từ chối HTTP 400 `model_not_allowed` vì danh sách cho phép đang rỗng.',
      evidenceEn: `Default model "${tenant.defaultModel}"; allow-list is empty.`, evidenceVi: `Model mặc định "${tenant.defaultModel}"; danh sách cho phép rỗng.`,
      fixEn: 'Add the models your site may request in step 7, or switch the default to `auto`.',
      fixVi: 'Thêm các model website được phép yêu cầu ở bước 7, hoặc đổi mặc định sang `auto`.',
      path: '/thruline/support-integration',
    });
  }

  if (diagnostic) {
    const open = diagnostic.steps.filter((s) => s.canView !== false && s.status !== 'complete');
    if (open.length > 0) {
      findings.push({
        id: 'unfinished_setup', severity: 'info',
        titleEn: `${open.length} of 7 setup steps are not complete`, titleVi: `${open.length}/7 bước thiết lập chưa hoàn tất`,
        causeEn: 'Unfinished steps do not usually cause errors by themselves, but missing guardrails, output controls or locked origins leave the assistant unprotected.',
        causeVi: 'Bước chưa xong thường không tự gây lỗi, nhưng thiếu tường lửa, kiểm soát đầu ra hoặc chưa khoá origin khiến trợ lý chưa được bảo vệ.',
        evidenceEn: open.map((s) => `${s.stepId}: ${s.status}`).join(', '),
        evidenceVi: open.map((s) => `${s.stepId}: ${s.status}`).join(', '),
        fixEn: 'Open the 7-step checklist and finish the remaining steps.', fixVi: 'Mở danh sách 7 bước và hoàn tất các bước còn lại.',
        path: '/thruline/support',
      });
    }
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

export function buildTenantDoctorReport(params: {
  tenant: SupportTenant;
  diagnostic: SupportSetupTenantDiagnostic | null;
  windowHours?: number;
}): TenantDoctorReport {
  const evidence = collectTenantEvidence(params.tenant, params.windowHours ?? 72);
  return {
    tenantName: params.tenant.name,
    tenantSlug: params.tenant.slug,
    evidence,
    findings: diagnoseTenant({ tenant: params.tenant, diagnostic: params.diagnostic, evidence }),
  };
}

// ---------------------------------------------------------------------------
// Intent: "why does this TENANT fail" vs. the personal Error Doctor
// ---------------------------------------------------------------------------

const TENANT_WORDS_RE = /\b(?:tenant|chatbot|chat\s*bot|widget|ai\s*support|tro\s*ly\s*(?:khach|ai\s*support)|khach\s*hang|support\s*desk|ticket)\b/;
const ERROR_WORDS_RE = /\b(?:loi|bi\s*loi|hay\s*loi|error|errors|fail|fails|failing|failed|khong\s*(?:chay|tra\s*loi|hoat\s*dong|hien)|cham|lag|treo|timeout|sap|broken|not\s*working|doesn'?t\s*work|why|vi\s*sao|tai\s*sao|sao)\b/;
const PERSONAL_WORDS_RE = /\b(?:my\s+(?:api|key|keys|account|quota|requests?|calls?)|cua\s+(?:minh|toi)|tai\s*khoan|personal\s*key|api\s*key|\bkey\b|quota|rpm|429|token|goi\s*api)\b/;

/**
 * True when the message asks why a TENANT is failing. Explicit tenant words win;
 * otherwise a generic "why does it error" while a tenant Target is selected
 * means the tenant — unless the wording is clearly about the caller's own API.
 */
export function matchTenantDoctorIntent(rawMessage: string, tenantTargetSelected: boolean): boolean {
  const folded = foldVietnameseAscii(rawMessage.trim());
  if (!folded || !ERROR_WORDS_RE.test(folded)) return false;
  if (TENANT_WORDS_RE.test(folded)) return !/\b(?:7\s*buoc|7\s*steps?|buoc\s*\d|step\s*\d)\b/.test(folded);
  if (!tenantTargetSelected) return false;
  return !PERSONAL_WORDS_RE.test(folded) && folded.length <= 80;
}

// ---------------------------------------------------------------------------
// Chat reply
// ---------------------------------------------------------------------------

export function buildTenantDoctorChatResponse(params: {
  report: TenantDoctorReport;
  locale: 'vi' | 'en';
}): SupportSetupChatResponse {
  const { report, locale } = params;
  const vi = locale === 'vi';
  const ev = report.evidence;
  const lines: string[] = [];

  lines.push(
    vi
      ? `Mình đã kiểm tra tenant **${report.tenantName}** (${ev.windowHours} giờ gần nhất): ${ev.turns.total} lượt hội thoại — ${ev.turns.completed} thành công, ${ev.turns.failed} lỗi, ${ev.turns.interrupted} bị ngắt; ${ev.guardrailBlocks} tin bị tường lửa chặn; ${ev.routes.forAuto} route nhà cung cấp khả dụng.`
      : `I checked tenant **${report.tenantName}** (last ${ev.windowHours}h): ${ev.turns.total} conversation turn(s) — ${ev.turns.completed} ok, ${ev.turns.failed} failed, ${ev.turns.interrupted} interrupted; ${ev.guardrailBlocks} blocked by the firewall; ${ev.routes.forAuto} provider route(s) available.`,
  );

  const material = report.findings.filter((f) => f.id !== 'unfinished_setup');
  const top = (material.length > 0 ? material : report.findings).slice(0, 3);

  if (material.length === 0) {
    lines.push(
      vi
        ? 'Mình **chưa thấy nguyên nhân lỗi nào trong dữ liệu của tenant** — không có lượt lỗi, không bị chặn, nhà cung cấp vẫn sẵn sàng.'
        : 'I found **no cause for errors in the tenant\'s data** — no failed turns, nothing blocked, and providers are available.',
    );
    lines.push(
      vi
        ? 'Lỗi bạn gặp có thể xảy ra phía khách (ví dụ trình duyệt chặn CORS khi nhúng widget, hoặc widget tắt). Bạn thấy hiện tượng cụ thể nào — mã lỗi (403/400/502…), widget không hiện, hay câu trả lời bị cụt?'
        : 'What you are seeing may be on the customer side (for example the browser blocking CORS when the widget is embedded, or the widget being off). What exactly happens — an error code (403/400/502…), no widget, or cut-off answers?',
    );
  } else {
    lines.push(vi ? '**Nguyên nhân khả dĩ nhất:**' : '**Most likely causes:**');
  }

  top.forEach((f, i) => {
    lines.push(
      vi
        ? `${i + 1}. **${f.titleVi}** — ${f.causeVi}\n   - *Bằng chứng:* ${f.evidenceVi}\n   - *Cách sửa:* ${f.fixVi} (\`${f.path}\`)`
        : `${i + 1}. **${f.titleEn}** — ${f.causeEn}\n   - *Evidence:* ${f.evidenceEn}\n   - *Fix:* ${f.fixEn} (\`${f.path}\`)`,
    );
  });

  lines.push(
    vi
      ? '_Lưu ý: tenant không dùng Personal API Key — AI của tenant chạy bằng các tài khoản nhà cung cấp của nền tảng. Muốn kiểm tra lỗi API cá nhân của bạn, hãy nhắn "kiểm tra lỗi API của tôi"._'
      : '_Note: a tenant never uses a Personal API Key — its AI runs on the platform\'s provider accounts. To check your own API errors, say "check my API errors"._',
  );

  const fixSteps = top.filter((f) => f.path.startsWith('/thruline/support')).slice(0, 2);
  const quick: string[] = [];
  for (const f of fixSteps) quick.push(vi ? `Hướng dẫn mình sửa: ${f.titleVi}` : `Walk me through fixing: ${f.titleEn}`);
  quick.push(vi ? 'Kiểm tra lỗi API của tôi' : 'Check my own API errors');

  return {
    ok: true,
    replyLocale: locale,
    reply: lines.join('\n\n'),
    intent: 'diagnose_errors',
    missingQuestions: [],
    suggestedQuickReplies: quick.slice(0, 4),
    proposal: null,
    userDiagnostic: null,
    actionProposal: null,
    modelUsed: null,
    usedFallback: true,
  };
}
