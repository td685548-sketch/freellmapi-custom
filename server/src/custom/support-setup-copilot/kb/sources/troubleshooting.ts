import type { KbChunk } from '../types.js';

interface Entry {
  id: string;
  titleEn: string;
  titleVi: string;
  en: string;
  vi: string;
  path?: string;
  tags: string[];
}

/**
 * Symptom → cause → fix playbook. Tenant entries are grounded in the runtime
 * code (support-runtime.ts / support-router.ts / diagnostics.ts): the error
 * codes named here are the ones the tenant runtime really returns.
 */
const ENTRIES: readonly Entry[] = [
  {
    id: 'tenant-errors',
    titleEn: 'Why does an AI Support tenant fail or give errors? (causes by symptom)',
    titleVi: 'Vì sao tenant AI Support bị lỗi? (nguyên nhân theo triệu chứng)',
    en: [
      'Check the symptom, then the step that owns it:',
      '- HTTP 403 `guardrail_blocked` — the Prompt Firewall blocked the customer message (prompt-injection, a blocked topic or a competitor keyword). Fix: review blocked topics/keywords in step 3 (/thruline/support-guardrails).',
      '- HTTP 400 `model_not_allowed` — the requested model is not the tenant default and not on the allow-list. Fix: step 7 allowed models (/thruline/support-integration) or step 1 default model.',
      '- HTTP 502/503/504 or timeouts, or "no providers configured" — no healthy provider route served the model. Fix: connect or repair provider accounts at Thruline → Providers (/thruline/providers) and check cooldowns at /thruline/quota; set the tenant default model to `auto` so the router can fail over.',
      '- Replies cut off mid-sentence — `maxCompletionTokens` is too low (default 512, max 4096). Fix: raise it in step 7.',
      '- Reply replaced or withheld — Output Safety Controls in `enforce` mode redacted/blocked it. Fix: review step 4 (/thruline/support-output) and the recorded events.',
      '- Widget missing or blocked by the browser (CORS) — widget disabled (step 5) or the site is not in allowed origins (step 7).',
      '- Tenant returns nothing at all — the tenant is disabled (step 1).',
      'The readiness bar (n/7) tells you which of these areas are not yet configured.',
    ].join('\n'),
    vi: [
      'Xác định triệu chứng rồi xem bước phụ trách:',
      '- HTTP 403 `guardrail_blocked` — Tường lửa Prompt chặn tin nhắn của khách (prompt-injection, chủ đề cấm hoặc từ khoá đối thủ). Cách sửa: xem chủ đề/từ khoá cấm ở bước 3 (/thruline/support-guardrails).',
      '- HTTP 400 `model_not_allowed` — model được yêu cầu không phải model mặc định của tenant và không nằm trong danh sách cho phép. Cách sửa: danh sách model cho phép ở bước 7 (/thruline/support-integration) hoặc model mặc định ở bước 1.',
      '- HTTP 502/503/504, timeout, hoặc "no providers configured" — không có route nhà cung cấp khoẻ nào phục vụ model. Cách sửa: kết nối/sửa tài khoản nhà cung cấp tại Thruline → Providers (/thruline/providers), xem cooldown tại /thruline/quota; đặt model mặc định của tenant là `auto` để router tự chuyển sang route khác.',
      '- Câu trả lời bị cụt giữa chừng — `maxCompletionTokens` quá thấp (mặc định 512, tối đa 4096). Cách sửa: tăng ở bước 7.',
      '- Câu trả lời bị thay thế hoặc giữ lại — Kiểm soát đầu ra ở chế độ `enforce` đã che/chặn. Cách sửa: xem bước 4 (/thruline/support-output) và các sự kiện đã ghi.',
      '- Không thấy widget hoặc trình duyệt chặn (CORS) — widget đang tắt (bước 5) hoặc website chưa nằm trong allowed origins (bước 7).',
      '- Tenant không trả lời gì — tenant đang bị tắt (bước 1).',
      'Thanh sẵn sàng (n/7) cho biết khu vực nào chưa được cấu hình.',
    ].join('\n'),
    path: '/thruline/support',
    tags: ['tenant', 'loi', 'error', 'bi loi', 'hay loi', 'why', 'vi sao', 'tai sao', '403', '400', '502', '503', '504', 'guardrail_blocked', 'model_not_allowed', 'cors', 'timeout'],
  },
  {
    id: 'tenant-ai-access',
    titleEn: 'How does a tenant get AI models? Can I add an API key to a tenant?',
    titleVi: 'Tenant lấy model AI từ đâu? Có thêm API key vào tenant được không?',
    en: 'A tenant has NO key of its own. Its answers are served by the platform\'s provider accounts: the router resolves candidate routes for the tenant\'s model from the accounts connected at Thruline → Providers (/thruline/providers) and fails over between them. To give tenants more capacity or a new model, connect another provider account there (or add a provider key on the Keys page for the main gateway), then pick the model in step 1 (default `auto`) and, if needed, allow it in step 7. A Personal API key is a different thing: it authenticates one person\'s own clients (IDEs, scripts) and cannot be attached to a tenant. The tenant\'s public key (`pk_sup_…`) only identifies the tenant to the embedded widget — it is not a model credential.',
    vi: 'Tenant KHÔNG có key riêng. Câu trả lời do các tài khoản nhà cung cấp của nền tảng phục vụ: router chọn các route phù hợp với model của tenant từ những tài khoản đã kết nối tại Thruline → Providers (/thruline/providers) và tự chuyển dự phòng giữa chúng. Muốn tenant có thêm hạn mức hoặc model mới, hãy kết nối thêm tài khoản nhà cung cấp ở đó (hoặc thêm khoá nhà cung cấp ở trang Keys cho gateway chính), rồi chọn model ở bước 1 (mặc định `auto`) và nếu cần thì cho phép model đó ở bước 7. Personal API key là thứ khác: nó xác thực client của riêng một người (IDE, script) và không thể gắn vào tenant. Public key của tenant (`pk_sup_…`) chỉ giúp widget nhúng nhận diện tenant — không phải credential để gọi model.',
    path: '/thruline/providers',
    tags: ['tenant', 'key', 'api key', 'khoa', 'them key', 'gan key', 'dua key vao tenant', 'gan vao tenant', 'eco', 'tao key xong', 'provider', 'model', 'personal key', 'pk_sup'],
  },
  {
    id: 'personal-429',
    titleEn: 'My own API calls get HTTP 429 (rate limit)',
    titleVi: 'API của tôi bị HTTP 429 (giới hạn tốc độ)',
    en: 'This is about YOUR account, not a tenant. 429 means your requests per minute exceeded the key/account RPM limit or the upstream model is cooling down. Fix: use the `auto` model so the router spreads load, slow the client down, or switch the Personal API Key routing mode to `eco`/`balanced`. After creating a new Personal API Key, paste it into your own client (IDE, script) as the Bearer token with the gateway base URL — it is never entered into a tenant.',
    vi: 'Đây là lỗi của TÀI KHOẢN BẠN, không phải của tenant. 429 nghĩa là số request mỗi phút vượt giới hạn RPM của key/tài khoản hoặc model phía trên đang nghỉ (cooldown). Cách sửa: dùng model `auto` để router phân tải, giảm tốc độ gọi, hoặc chuyển chế độ định tuyến của Personal API Key sang `eco`/`balanced`. Sau khi tạo Personal API Key mới, dán nó vào client của chính bạn (IDE, script) làm Bearer token cùng base URL của gateway — không bao giờ nhập key này vào tenant.',
    path: '/keys',
    tags: ['429', 'rate limit', 'rpm', 'personal key', 'eco', 'balanced', 'cooldown', 'gioi han toc do'],
  },
  {
    id: 'no-providers',
    titleEn: 'Every request fails: "no providers configured" / HTTP 503',
    titleVi: 'Mọi request đều lỗi: "no providers configured" / HTTP 503',
    en: 'No enabled provider route exists for the requested model. Add a provider key (Keys page) or connect a provider account (Thruline → Providers). Free keyless providers need no key but must be enabled. Then retry with model `auto`.',
    vi: 'Không có route nhà cung cấp nào đang bật cho model được yêu cầu. Hãy thêm khoá nhà cung cấp (trang Keys) hoặc kết nối tài khoản nhà cung cấp (Thruline → Providers). Nhà cung cấp miễn phí không cần key vẫn phải được bật. Sau đó thử lại với model `auto`.',
    path: '/keys',
    tags: ['503', 'no providers', 'no_providers_configured', 'provider', 'khong co provider', 'key'],
  },
  {
    id: 'web-session-expired',
    titleEn: 'A web-session provider (DeepSeek Web, ChatGPT Web …) says the session is expired',
    titleVi: 'Nhà cung cấp dạng web-session (DeepSeek Web, ChatGPT Web …) báo hết phiên',
    en: 'Web-session providers log in with a browser cookie/token you pasted. When the provider rejects it (HTTP 401/403 or code 40003) the account is marked as error and the cookie must be exported again from the provider\'s site. For DeepSeek Web, copy the Cookie Editor JSON containing `ds_session_id` (a Local Storage `userToken` that only holds a user id is not enough). An empty stream is not necessarily an expired cookie — DeepSeek can also filter the prompt.',
    vi: 'Nhà cung cấp dạng web-session đăng nhập bằng cookie/token trình duyệt mà bạn đã dán. Khi nhà cung cấp từ chối (HTTP 401/403 hoặc mã 40003) tài khoản bị đánh dấu lỗi và bạn phải xuất lại cookie từ website của họ. Với DeepSeek Web, hãy copy Cookie Editor JSON có chứa `ds_session_id` (`userToken` trong Local Storage chỉ chứa user id là chưa đủ). Stream rỗng chưa chắc là hết hạn cookie — DeepSeek cũng có thể lọc prompt.',
    path: '/thruline/providers',
    tags: ['deepseek', 'web', 'cookie', 'session', 'het phien', 'expired', '40003', 'ds_session_id', 'chatgpt web'],
  },
  {
    id: 'personal-key-how',
    titleEn: 'How do I create and use a Personal API Key?',
    titleVi: 'Tạo và dùng Personal API Key như thế nào?',
    en: 'Ask the Copilot to create one (it stages a Confirm & Run card — nothing is minted until you confirm) or use the Keys / Assistants pages. Routing modes are `eco`, `balanced` and `max`. Use the key as `Authorization: Bearer <key>` against the gateway\'s /v1 base URL in your own client or IDE.',
    vi: 'Nhờ Copilot tạo (nó chuẩn bị thẻ Xác nhận & Chạy — chưa tạo gì cho tới khi bạn xác nhận) hoặc dùng trang Keys / Assistants. Chế độ định tuyến là `eco`, `balanced` và `max`. Dùng key dạng `Authorization: Bearer <key>` với base URL /v1 của gateway trong client hoặc IDE của bạn.',
    path: '/keys',
    tags: ['personal key', 'api key', 'tao key', 'bearer', 'ide', 'routing mode', 'eco', 'balanced', 'max'],
  },
];

export function buildTroubleshootingChunks(): KbChunk[] {
  return ENTRIES.map((e) => ({
    id: `ts:${e.id}`,
    source: 'troubleshooting' as const,
    title: e.titleEn,
    titleVi: e.titleVi,
    text: e.en,
    textVi: e.vi,
    ...(e.path ? { path: e.path } : {}),
    tags: ['troubleshooting', 'xu ly loi', 'sua loi', 'fix', ...e.tags],
  }));
}
