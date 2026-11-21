import { DEFAULT_RUNTIME_POLICY, RUNTIME_POLICY_BOUNDS } from '@freellmapi/shared/support-runtime.js';
import { DEFAULT_ROUTE_HEALTH_TTL_MINUTES, MAX_ROUTE_HEALTH_TTL_MINUTES } from '../../../x-gateway/config.js';
import { defaultRoleQuotas } from '../../../x-gateway/support-guardrails.js';
import type { KbChunk } from '../types.js';

/**
 * "Web options" catalog: the controls a person can actually change on the
 * website, tied to the error or symptom each one governs. This is what lets
 * the Copilot answer "how do I fix HTTP 429?" with the real option, its
 * default and the page to open — instead of a generic setup roadmap.
 *
 * Numbers that exist as constants in the product code are IMPORTED here (never
 * retyped), so the KB cannot drift from the runtime. The remaining literals
 * are pinned by `support-copilot-web-options.test.ts`.
 */

/** Default personal-key requests-per-minute (services/user-quotas.ts `checkUserRateLimit`). Pinned by a test. */
export const DEFAULT_PERSONAL_KEY_RPM = 60;
/** Global per-credential limiter default (middleware/rateLimit.ts, env `PROXY_RATE_LIMIT_RPM`). Pinned by a test. */
export const DEFAULT_PROXY_RATE_LIMIT_RPM = 120;

interface OptionEntry {
  id: string;
  titleEn: string;
  titleVi: string;
  en: string;
  vi: string;
  path?: string;
  tags: string[];
}

function quotaLine(role: string): string {
  const q = defaultRoleQuotas()[role]!;
  const req = q.maxRequestsPerWindow === 0 ? 'unlimited' : String(q.maxRequestsPerWindow);
  const tok = q.maxTokensPerWindow === 0 ? 'unlimited' : String(q.maxTokensPerWindow);
  return `${role}: ${req} requests / ${tok} tokens per ${q.windowSeconds / 3600}h`;
}

function buildEntries(): readonly OptionEntry[] {
  const quotas = ['guest', 'customer', 'staff', 'admin'].map(quotaLine).join('; ');
  const calls = RUNTIME_POLICY_BOUNDS.maxModelCalls;
  return [
    {
      id: '429-which-limit',
      titleEn: 'HTTP 429 / rate limit / "too fast" — which limit did you hit and which option fixes it',
      titleVi: 'Lỗi HTTP 429 / chạm trần tốc độ gọi (rate limit) — chạm giới hạn nào và chỉnh option nào',
      en: [
        '429 is not one thing. Read the error code/message, find the scope, then change that scope\'s option:',
        `- \`user_rate_limit_exceeded\` ("Your plan limit is N requests per minute") — a Personal API key (sk-flm-…) or Thruline key (sk-xgw-…) sent more than its RPM (default ${DEFAULT_PERSONAL_KEY_RPM}). Option: the key owner's RPM limit, edited by an admin on Users (/users) → "Limit: N RPM" (1–1000). Client-side: slow down, honour the Retry-After header, spread load across keys.`,
        `- "Rate limit exceeded: more than N requests per minute" (type \`rate_limit_error\`) — the global per-credential/IP limiter (default ${DEFAULT_PROXY_RATE_LIMIT_RPM}/min, server env PROXY_RATE_LIMIT_RPM). Not a web setting: an operator changes the env var.`,
        '- `user_quota_exceeded` / `client_quota_exceeded` ("has used its daily/monthly allowance … resets at …") — an allowance is spent, not a speed problem. Wait for the reset time in the message or ask an admin to raise the allowance (Users → New Member Starter Quota, or the account quota).',
        `- \`quota_exceeded\` on the customer chat widget ("Support quota exceeded for current window") — a tenant role quota. Option: AI Support step 3, Role quotas (/thruline/support-guardrails). Defaults — ${quotas}. 0 means unlimited.`,
        '- `guest_session_rate_limited` — a single IP opened too many anonymous widget sessions in a minute (fixed 20 per tenant per IP, not configurable).',
        '- `routing_exhausted` (429 from the router) — every upstream provider route for the model is rate-limited or cooling down. Options: connect more accounts at Thruline → Providers (/thruline/providers) so traffic rotates, add a fallback chain in Thruline → Combos (/thruline/combos), use model `auto`, and check cooldown timers at /thruline/quota.',
        'Ask which message the user sees (or call tenant.diagnose / the error doctor) when the scope is unclear.',
      ].join('\n'),
      vi: [
        '429 không phải một lỗi duy nhất. Đọc mã/thông báo lỗi để biết phạm vi, rồi chỉnh đúng option của phạm vi đó:',
        `- \`user_rate_limit_exceeded\` ("Your plan limit is N requests per minute") — một Personal API key (sk-flm-…) hoặc key Thruline (sk-xgw-…) gửi vượt RPM của nó (mặc định ${DEFAULT_PERSONAL_KEY_RPM}). Option: giới hạn RPM của chủ key, admin sửa ở Users (/users) → "Limit: N RPM" (1–1000). Phía client: giảm tốc độ, tôn trọng header Retry-After, chia tải qua nhiều key.`,
        `- "Rate limit exceeded: more than N requests per minute" (type \`rate_limit_error\`) — bộ giới hạn toàn cục theo credential/IP (mặc định ${DEFAULT_PROXY_RATE_LIMIT_RPM}/phút, biến môi trường PROXY_RATE_LIMIT_RPM). Đây không phải option trên web: người vận hành đổi biến môi trường.`,
        '- `user_quota_exceeded` / `client_quota_exceeded` ("has used its daily/monthly allowance … resets at …") — hết hạn mức ngày/tháng chứ không phải gọi quá nhanh. Chờ tới giờ reset trong thông báo hoặc nhờ admin nâng hạn mức (Users → New Member Starter Quota, hoặc quota của tài khoản).',
        `- \`quota_exceeded\` trên widget chat của khách ("Support quota exceeded for current window") — quota theo vai trò của tenant. Option: bước 3 AI Support, Role quotas (/thruline/support-guardrails). Mặc định — ${quotas}. Giá trị 0 là không giới hạn.`,
        '- `guest_session_rate_limited` — một IP mở quá nhiều phiên widget ẩn danh trong 1 phút (cố định 20 mỗi tenant mỗi IP, không chỉnh được).',
        '- `routing_exhausted` (429 từ router) — mọi route nhà cung cấp cho model đều đang bị giới hạn hoặc nghỉ (cooldown). Option: kết nối thêm tài khoản ở Thruline → Providers (/thruline/providers) để xoay vòng, thêm chuỗi dự phòng ở Thruline → Combos (/thruline/combos), dùng model `auto`, xem đồng hồ cooldown ở /thruline/quota.',
        'Nếu chưa rõ phạm vi, hỏi người dùng đang thấy thông báo nào (hoặc gọi tenant.diagnose / bác sĩ chẩn đoán lỗi).',
      ].join('\n'),
      path: '/thruline/support-guardrails',
      tags: ['429', 'http 429', 'rate limit', 'rate-limit', 'ratelimit', 'rpm', 'cham tran', 'toc do goi', 'gioi han toc do', 'qua nhanh', 'too many requests', 'retry-after', 'user_rate_limit_exceeded', 'quota_exceeded', 'guest_session_rate_limited', 'routing_exhausted', 'rate_limit_error', 'xu ly 429', 'sua 429'],
    },
    {
      id: 'user-key-rpm',
      titleEn: 'Option: per-key requests-per-minute (RPM) limit',
      titleVi: 'Option: giới hạn số request mỗi phút (RPM) của từng key',
      en: `Every Personal API key / Thruline client key has an RPM limit (default ${DEFAULT_PERSONAL_KEY_RPM}, allowed 1–1000). Over it, the gateway answers HTTP 429 \`user_rate_limit_exceeded\` with a Retry-After. It is a sliding one-minute window counted per account. Where: Users page (/users), the "Limit: N RPM" control next to a user — needs admin rights. Routing mode of a key (\`eco\` / \`balanced\` / \`max\`) is a separate option and does not change the RPM.`,
      vi: `Mỗi Personal API key / key client của Thruline có giới hạn RPM (mặc định ${DEFAULT_PERSONAL_KEY_RPM}, cho phép 1–1000). Vượt mức, gateway trả HTTP 429 \`user_rate_limit_exceeded\` kèm Retry-After. Đây là cửa sổ trượt 1 phút tính theo tài khoản. Ở đâu: trang Users (/users), nút "Limit: N RPM" cạnh người dùng — cần quyền admin. Chế độ định tuyến của key (\`eco\` / \`balanced\` / \`max\`) là option khác và không đổi RPM.`,
      path: '/users',
      tags: ['rpm', 'rate limit', 'gioi han', 'limit', 'key', 'personal key', 'user_rate_limit_exceeded', '429', 'users', 'toc do', 'moi phut'],
    },
    {
      id: 'tenant-role-quotas',
      titleEn: 'Option: AI Support role quotas (requests / tokens per window) — fixes widget 429 quota_exceeded',
      titleVi: 'Option: quota theo vai trò của AI Support (request / token mỗi chu kỳ) — sửa lỗi 429 quota_exceeded trên widget',
      en: `Step 3 (/thruline/support-guardrails) holds one quota rule per role — guest (anonymous visitors), customer, staff, admin — with three fields: max requests per window, max tokens per window (0 = unlimited for both) and window length in seconds (≥1, default 3600). Defaults: ${quotas}. When a visitor passes the limit the widget gets HTTP 429 \`quota_exceeded\` and a retry delay. Raise the guest/customer numbers if real customers are being cut off; keep guest low to limit abuse. The quota tester on the same page shows used / max for a role.`,
      vi: `Bước 3 (/thruline/support-guardrails) có một luật quota cho mỗi vai trò — guest (khách vãng lai), customer, staff, admin — gồm 3 trường: số request tối đa mỗi chu kỳ, số token tối đa mỗi chu kỳ (0 = không giới hạn) và độ dài chu kỳ tính bằng giây (≥1, mặc định 3600). Mặc định: ${quotas}. Khi khách vượt mức, widget nhận HTTP 429 \`quota_exceeded\` kèm thời gian chờ. Hãy nâng số của guest/customer nếu khách thật bị chặn; giữ guest thấp để hạn chế lạm dụng. Công cụ thử quota ở cùng trang hiển thị đã dùng / tối đa của vai trò.`,
      path: '/thruline/support-guardrails',
      tags: ['quota', 'role quota', 'han muc', 'vai tro', 'guest', 'customer', 'staff', 'maxrequestsperwindow', 'maxtokensperwindow', 'windowseconds', 'widget', '429', 'quota_exceeded', 'step 3', 'buoc 3', 'guardrails', 'gioi han luot hoi'],
    },
    {
      id: 'tenant-max-model-calls',
      titleEn: 'Option: per-turn model-call and token bounds (runtime policy)',
      titleVi: 'Option: giới hạn số lần gọi model và token mỗi lượt (runtime policy)',
      en: `Step 7 (/thruline/support-integration) bounds one customer turn: max model calls ${calls.min}–${calls.max} (default ${DEFAULT_RUNTIME_POLICY.maxModelCalls}), max tool calls, max completion tokens (${RUNTIME_POLICY_BOUNDS.maxCompletionTokens.min}–${RUNTIME_POLICY_BOUNDS.maxCompletionTokens.max}, default ${DEFAULT_RUNTIME_POLICY.maxCompletionTokens}) and context size. A turn that needs more model calls than allowed ends with HTTP 429 \`quota_exceeded\` ("Maximum model calls reached"). These are safety bounds — raise maxCompletionTokens when answers are cut off; leave maxModelCalls at its default unless a tool loop is being cut short.`,
      vi: `Bước 7 (/thruline/support-integration) giới hạn một lượt chat của khách: số lần gọi model ${calls.min}–${calls.max} (mặc định ${DEFAULT_RUNTIME_POLICY.maxModelCalls}), số lần gọi tool, số token trả lời tối đa (${RUNTIME_POLICY_BOUNDS.maxCompletionTokens.min}–${RUNTIME_POLICY_BOUNDS.maxCompletionTokens.max}, mặc định ${DEFAULT_RUNTIME_POLICY.maxCompletionTokens}) và kích thước ngữ cảnh. Lượt cần nhiều lần gọi model hơn mức cho phép sẽ kết thúc bằng HTTP 429 \`quota_exceeded\` ("Maximum model calls reached"). Đây là giới hạn an toàn — tăng maxCompletionTokens khi câu trả lời bị cụt; giữ maxModelCalls mặc định trừ khi vòng gọi tool bị cắt ngang.`,
      path: '/thruline/support-integration',
      tags: ['maxmodelcalls', 'maxcompletiontokens', 'runtime', 'runtime policy', 'token', 'gioi han', 'cut', 'cut cut', 'buoc 7', 'step 7', 'quota_exceeded', '429', 'model calls'],
    },
    {
      id: 'upstream-rate-limit-options',
      titleEn: 'Options that absorb upstream provider rate limits (accounts, combos, route-health TTL, cache, savers)',
      titleVi: 'Các option giúp chịu được giới hạn tốc độ của nhà cung cấp (tài khoản, combo, TTL route, cache, tiết kiệm token)',
      en: [
        'When the provider itself is the bottleneck (429 routing_exhausted, "all routes cooling down", free-tier limits), these web options help — in order of effect:',
        '1. More accounts — Thruline → Providers (/thruline/providers): connect several accounts/keys per provider; the router rotates and skips any that are cooling down.',
        '2. Fallback chain — Thruline → Combos (/thruline/combos): one virtual model with a primary plus backups; a rate-limited step fails over to the next. Tenants and keys should use `auto` or the combo name instead of pinning one model.',
        `3. Route-health TTL — Combos → "Auto route health cooldown": minutes a failed route is remembered before retrying (default ${DEFAULT_ROUTE_HEALTH_TTL_MINUTES}, max ${MAX_ROUTE_HEALTH_TTL_MINUTES}). Short = retry sooner; long = stop hammering a limited provider.`,
        '4. Response cache — Settings dialog → General: identical prompts are answered without calling a provider.',
        '5. Token savers / prompt compression — Thruline → Token Savers (/thruline/savers), Settings → Compression: fewer tokens per call means fewer token-per-minute limits hit.',
        'Watch the effect at /thruline/quota (cooldown timers) and /thruline/logs (request logs).',
      ].join('\n'),
      vi: [
        'Khi chính nhà cung cấp là nút thắt (429 routing_exhausted, "mọi route đang nghỉ", giới hạn gói miễn phí), các option sau trên web giúp ích — theo thứ tự hiệu quả:',
        '1. Thêm tài khoản — Thruline → Providers (/thruline/providers): kết nối nhiều tài khoản/key cho mỗi nhà cung cấp; router xoay vòng và bỏ qua tài khoản đang nghỉ.',
        '2. Chuỗi dự phòng — Thruline → Combos (/thruline/combos): một model ảo gồm model chính cùng các model dự phòng; bước bị giới hạn sẽ chuyển sang bước kế tiếp. Tenant và key nên dùng `auto` hoặc tên combo thay vì ghim một model.',
        `3. TTL sức khoẻ route — Combos → "Auto route health cooldown": số phút nhớ một route lỗi trước khi thử lại (mặc định ${DEFAULT_ROUTE_HEALTH_TTL_MINUTES}, tối đa ${MAX_ROUTE_HEALTH_TTL_MINUTES}). Ngắn = thử lại sớm; dài = đỡ dồn request vào nhà cung cấp đang bị giới hạn.`,
        '4. Bộ nhớ đệm phản hồi — Settings → General: prompt giống hệt được trả lời mà không gọi nhà cung cấp.',
        '5. Tiết kiệm token / nén prompt — Thruline → Token Savers (/thruline/savers), Settings → Compression: ít token mỗi lượt gọi thì ít chạm giới hạn token mỗi phút.',
        'Theo dõi hiệu quả ở /thruline/quota (đồng hồ cooldown) và /thruline/logs (nhật ký request).',
      ].join('\n'),
      path: '/thruline/combos',
      tags: ['429', 'routing_exhausted', 'rate limit', 'cooldown', 'xoay vong', 'rotation', 'combo', 'combos', 'fallback', 'du phong', 'providers', 'nha cung cap', 'ttl', 'route health', 'cache', 'savers', 'compression', 'cham tran', 'gioi han toc do', 'nhieu tai khoan', 'free tier', 'auto'],
    },
    {
      id: 'user-usage-allowance',
      titleEn: 'Option: daily / monthly allowance per account (quota) — fixes user_quota_exceeded',
      titleVi: 'Option: hạn mức ngày / tháng của mỗi tài khoản (quota) — sửa lỗi user_quota_exceeded',
      en: 'Accounts and client keys can have a daily and a monthly allowance (requests and tokens). When it is spent the gateway answers HTTP 429 `user_quota_exceeded` / `client_quota_exceeded` and states when it resets. New members get the "New Member Starter Quota" applied automatically (leave blank = unlimited). An admin edits it on Users (/users) or in the Settings dialog; a member can only wait for the reset or ask an admin. Switching routine keys to `eco` routing makes the allowance last longer.',
      vi: 'Tài khoản và key client có thể có hạn mức ngày và tháng (request và token). Hết hạn mức, gateway trả HTTP 429 `user_quota_exceeded` / `client_quota_exceeded` và nêu thời điểm reset. Thành viên mới được áp "New Member Starter Quota" tự động (để trống = không giới hạn). Admin chỉnh ở Users (/users) hoặc hộp thoại Settings; thành viên chỉ có thể chờ reset hoặc nhờ admin. Chuyển key làm việc hằng ngày sang định tuyến `eco` giúp hạn mức dùng được lâu hơn.',
      path: '/users',
      tags: ['quota', 'allowance', 'han muc', 'ngay', 'thang', 'daily', 'monthly', 'user_quota_exceeded', 'client_quota_exceeded', 'starter quota', '429', 'het han muc', 'eco'],
    },
  ];
}

export function buildWebOptionChunks(): KbChunk[] {
  return buildEntries().map((e) => ({
    id: `opt:${e.id}`,
    source: 'option' as const,
    title: e.titleEn,
    titleVi: e.titleVi,
    text: e.en,
    textVi: e.vi,
    ...(e.path ? { path: e.path } : {}),
    tags: ['option', 'tuy chon', 'cai dat tren web', 'setting', 'cau hinh', 'xu ly loi', 'fix', ...e.tags],
  }));
}
