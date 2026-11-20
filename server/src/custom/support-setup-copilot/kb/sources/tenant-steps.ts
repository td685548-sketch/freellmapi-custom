import type { SupportSetupStepId } from '@freellmapi/shared/support-setup-copilot.js';
import { SURGICAL_STEP_REQUIRED_PERMISSION } from '../../surgical-steps.js';
import type { KbChunk } from '../types.js';

interface StepDoc {
  number: number;
  titleEn: string;
  titleVi: string;
  path: string;
  en: string;
  vi: string;
  tags: string[];
}

/**
 * The 7 AI Support setup steps: what each configures, the exact rule that makes
 * it "complete" in the readiness bar (mirrors buildTenantSetupDiagnostic), and
 * where to edit it. Full Record → a new step id cannot ship undocumented.
 */
const STEP_DOCS: Readonly<Record<SupportSetupStepId, StepDoc>> = {
  tenant_ai: {
    number: 1,
    titleEn: 'Tenant & AI Persona',
    titleVi: 'Tenant & Nhân cách AI',
    path: '/thruline/support',
    en: 'Name, slug, default model, whether guests may chat, and the system prompt that defines the assistant\'s persona. COMPLETE when the tenant is enabled and the system prompt is at least 30 characters; PARTIAL when enabled but the prompt is empty/short; MISSING when the tenant is disabled. Default model `auto` lets the router pick; a specific model pins it. The tenant\'s AI is served by the platform\'s configured providers — it does NOT use a personal API key.',
    vi: 'Tên, slug, model mặc định, có cho khách chat hay không, và system prompt định nghĩa nhân cách trợ lý. HOÀN TẤT khi tenant bật và system prompt từ 30 ký tự; MỘT PHẦN khi đã bật nhưng prompt trống/ngắn; THIẾU khi tenant bị tắt. Model mặc định `auto` để router tự chọn; chọn model cụ thể sẽ ghim model đó. AI của tenant chạy bằng các nhà cung cấp đã cấu hình ở cấp nền tảng — KHÔNG dùng Personal API Key.',
    tags: ['tenant', 'persona', 'system prompt', 'model', 'nhan cach', 'guest', 'khach'],
  },
  knowledge_masking: {
    number: 2,
    titleEn: 'Knowledge Base & PII Masking',
    titleVi: 'Kho tri thức & Che PII',
    path: '/thruline/support-knowledge',
    en: 'FAQ/policy documents the assistant may quote, plus masking of personal data. COMPLETE when at least one enabled knowledge doc is visible to customers/guests (or a published evidence source exists for operators) AND masking is on; PARTIAL when only one of those holds; MISSING when neither.',
    vi: 'Tài liệu FAQ/chính sách mà trợ lý được trích dẫn, cùng việc che dữ liệu cá nhân. HOÀN TẤT khi có ít nhất một tài liệu đang bật hiển thị cho khách (hoặc có nguồn evidence đã xuất bản với operator) VÀ masking bật; MỘT PHẦN khi chỉ đạt một trong hai; THIẾU khi cả hai đều không.',
    tags: ['knowledge', 'tri thuc', 'faq', 'masking', 'pii', 'che', 'tai lieu', 'evidence'],
  },
  guardrails_quotas: {
    number: 3,
    titleEn: 'Prompt Firewall & Role Quotas',
    titleVi: 'Tường lửa Prompt & Hạn mức',
    path: '/thruline/support-guardrails',
    en: 'Blocks prompt-injection, blocked topics and competitor keywords before any model call, and sets role quotas. Blocked messages fail with HTTP 403 `guardrail_blocked`. COMPLETE when the firewall is enabled, prompt-injection blocking is on and a custom config (blocked topics/competitors) exists; PARTIAL when enabled but defaults only; MISSING when disabled.',
    vi: 'Chặn prompt-injection, chủ đề cấm và từ khoá đối thủ trước khi gọi model, và đặt hạn mức theo vai trò. Tin nhắn bị chặn trả lỗi HTTP 403 `guardrail_blocked`. HOÀN TẤT khi tường lửa bật, chặn prompt-injection bật và đã có cấu hình riêng (chủ đề cấm/đối thủ); MỘT PHẦN khi bật nhưng chỉ mặc định; THIẾU khi tắt.',
    tags: ['guardrail', 'firewall', 'tuong lua', 'quota', 'han muc', 'chan', 'block', 'prompt injection', '403'],
  },
  output_controls: {
    number: 4,
    titleEn: 'Output Safety Controls',
    titleVi: 'Kiểm soát an toàn đầu ra',
    path: '/thruline/support-output',
    en: 'Inspects the assistant\'s replies before the customer sees them. Mode `enforce` redacts or blocks unsafe replies, `observe` only logs, `off` does nothing; `redactCredentials` strips secret-looking values. COMPLETE when mode is `enforce` and credential redaction is on; MISSING when mode is `off` and redaction is off; otherwise PARTIAL. Events are recorded per tenant (observe / redact / block).',
    vi: 'Kiểm tra câu trả lời của trợ lý trước khi khách nhìn thấy. Chế độ `enforce` che hoặc chặn câu trả lời không an toàn, `observe` chỉ ghi nhận, `off` không làm gì; `redactCredentials` xoá các giá trị giống bí mật. HOÀN TẤT khi mode là `enforce` và che credential bật; THIẾU khi mode `off` và không che; còn lại là MỘT PHẦN. Sự kiện được ghi theo từng tenant (observe / redact / block).',
    tags: ['output', 'dau ra', 'redact', 'enforce', 'observe', 'an toan', 'credential'],
  },
  widget_appearance: {
    number: 5,
    titleEn: 'Customer Chat Widget & Branding',
    titleVi: 'Widget chat khách hàng & thương hiệu',
    path: '/thruline/support-desk',
    en: 'The embeddable chat bubble: title, colours, welcome message and quick prompts. COMPLETE when the widget is enabled and has both a welcome message and at least one quick prompt; PARTIAL when enabled but missing either; MISSING when disabled.',
    vi: 'Bong bóng chat nhúng web: tiêu đề, màu sắc, lời chào và câu gợi ý nhanh. HOÀN TẤT khi widget bật và có cả lời chào lẫn ít nhất một câu gợi ý nhanh; MỘT PHẦN khi bật nhưng thiếu một trong hai; THIẾU khi tắt.',
    tags: ['widget', 'giao dien', 'thuong hieu', 'branding', 'loi chao', 'welcome', 'quick prompts', 'goi y'],
  },
  sla_routing: {
    number: 6,
    titleEn: 'Service Desk SLA & Department Routing',
    titleVi: 'SLA Service Desk & Phân luồng bộ phận',
    path: '/thruline/support-desk',
    en: 'Ticket response/resolution targets per priority and keyword rules that route tickets to departments. COMPLETE when SLA is enabled and at least one routing rule exists; PARTIAL when enabled but no rules; MISSING when disabled.',
    vi: 'Mục tiêu thời gian phản hồi/xử lý theo mức ưu tiên và quy tắc từ khoá để chuyển ticket sang bộ phận. HOÀN TẤT khi SLA bật và có ít nhất một quy tắc phân luồng; MỘT PHẦN khi bật nhưng chưa có quy tắc; THIẾU khi tắt.',
    tags: ['sla', 'ticket', 'phan luong', 'routing', 'bo phan', 'department', 'service desk'],
  },
  runtime_policy: {
    number: 7,
    titleEn: 'CORS Origins & Runtime Limits',
    titleVi: 'CORS & Giới hạn Runtime',
    path: '/thruline/support-integration',
    en: 'Which websites may embed the widget (allowed origins) and per-turn limits: maxCompletionTokens, maxModelCalls, maxToolCalls, maxContextChars, maxToolResultChars, maxHistoryMessages, plus the model allow-list (a model not on it fails with HTTP 400 `model_not_allowed`). COMPLETE only when allowed origins are restricted to concrete domains (not empty and not `*`); with `*` it stays PARTIAL until you share your live website domain. Also holds the embed `<script>` snippet.',
    vi: 'Website nào được nhúng widget (allowed origins) và các giới hạn mỗi lượt: maxCompletionTokens, maxModelCalls, maxToolCalls, maxContextChars, maxToolResultChars, maxHistoryMessages, cùng danh sách model cho phép (model ngoài danh sách bị lỗi HTTP 400 `model_not_allowed`). HOÀN TẤT chỉ khi allowed origins giới hạn vào domain cụ thể (không rỗng, không phải `*`); nếu để `*` thì vẫn MỘT PHẦN cho tới khi bạn cung cấp domain website thật. Đây cũng là nơi lấy đoạn mã nhúng `<script>`.',
    tags: ['runtime', 'cors', 'origin', 'domain', 'ten mien', 'embed', 'nhung', 'script', 'limits', 'gioi han', 'model_not_allowed'],
  },
};

export function buildTenantStepChunks(): KbChunk[] {
  const header = {
    en: 'Setup readiness = number of COMPLETE steps out of 7 (the "n/7" bar).',
    vi: 'Mức sẵn sàng = số bước HOÀN TẤT trên 7 (thanh "n/7").',
  };
  const chunks: KbChunk[] = [
    {
      id: 'tenant:overview',
      source: 'tenant_step',
      title: 'AI Support tenant: the 7 setup steps and the readiness bar',
      titleVi: 'Tenant AI Support: 7 bước thiết lập và thanh sẵn sàng',
      text: `${header.en} The steps are: ${(Object.keys(STEP_DOCS) as SupportSetupStepId[]).map((id) => `${STEP_DOCS[id].number}. ${STEP_DOCS[id].titleEn} (${STEP_DOCS[id].path})`).join('; ')}. A tenant is a customer-facing AI assistant with its own persona, knowledge, guardrails, widget and service desk. Its AI answers are served by the platform's provider accounts/keys (Thruline → Providers, /thruline/providers) — a tenant never takes a Personal API key.`,
      textVi: `${header.vi} Các bước: ${(Object.keys(STEP_DOCS) as SupportSetupStepId[]).map((id) => `${STEP_DOCS[id].number}. ${STEP_DOCS[id].titleVi} (${STEP_DOCS[id].path})`).join('; ')}. Tenant là một trợ lý AI hướng tới khách hàng với nhân cách, tri thức, tường lửa, widget và service desk riêng. Câu trả lời AI của tenant do các tài khoản/khoá nhà cung cấp của nền tảng phục vụ (Thruline → Providers, /thruline/providers) — tenant không bao giờ dùng Personal API key.`,
      path: '/thruline/support',
      tags: ['tenant', '7 buoc', '7 steps', 'sẵn sàng', 'san sang', 'readiness', 'progress', 'ai support'],
    },
  ];
  for (const id of Object.keys(STEP_DOCS) as SupportSetupStepId[]) {
    const d = STEP_DOCS[id];
    const perm = SURGICAL_STEP_REQUIRED_PERMISSION[id];
    chunks.push({
      id: `step:${id}`,
      source: 'tenant_step',
      title: `Setup step ${d.number} (step ${d.number} of the 7 AI Support steps) — ${d.titleEn} (${id})`,
      titleVi: `Bước ${d.number} (bước ${d.number} trong 7 bước AI Support) — ${d.titleVi} (${id})`,
      text: `${d.en} Edit at ${d.path}; changing it needs the tenant permission \`${perm}\`.`,
      textVi: `${d.vi} Chỉnh tại ${d.path}; thay đổi cần quyền tenant \`${perm}\`.`,
      path: d.path,
      tags: ['step', 'buoc', `buoc ${d.number}`, `step ${d.number}`, 'tenant', id, ...d.tags],
    });
  }
  return chunks;
}
