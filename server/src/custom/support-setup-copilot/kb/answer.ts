/**
 * Deterministic, knowledge-grounded answer used when no model route answered
 * a troubleshooting question. Without it the Copilot fell back to the canned
 * "7 setup steps" roadmap (or the intake questionnaire) for a question like
 * "làm sao xử lý lỗi HTTP 429?" — ignoring the real options on the website.
 */
import { normalizeKbText } from './retrieval.js';
import { buildKbQueryFromMessages } from './prompt.js';
import { searchKb } from './index.js';
import type { KbCaller, KbHit, KbSource } from './types.js';

/** Sources that can answer "how do I fix / change X" with a concrete option or fix. */
const ANSWERABLE_SOURCES: ReadonlySet<KbSource> = new Set<KbSource>(['option', 'troubleshooting', 'setting']);

const HTTP_ERROR_RE = /\b(?:http\s*)?(?:4\d\d|5\d\d)\b(?!\s*(?:k|usd|vnd|d)\b)/;
const FAILURE_WORD_RE =
  /rate[\s_-]*limit|too many requests|\bqua nhanh\b|\bcham tran\b|\btoc do goi\b|\bgioi han toc do\b|\bquota\b|\bhet han muc\b|\bcham han muc\b|\btimeout\b|\bkhong goi duoc\b|\bexceeded\b/;
/** Generic failure words only count when the message is about the system itself ("lỗi API", "request failed"), not about a shop's own policy ("đổi trả nếu lỗi nhà sản xuất"). */
const WEAK_FAILURE_RE = /\berror\b|\bfail(?:s|ed|ing)?\b|\bblocked\b|\bbi chan\b/;
const SYSTEM_NOUN_RE = /\bapi\b|\bkey\b|\bkhoa\b|\bmodel\b|\brequest\b|\bgoi\b|\bgateway\b|\bwidget\b|\btenant\b|\bprovider\b|\bnha cung cap\b|\bthruline\b|\bquota\b|\btoken\b|\bserver\b|\bmay chu\b|\bcopilot\b|\bchatbot\b|\bnhat ky\b|\blogs?\b|\bendpoint\b|\bcombo\b|\bcors\b/;
/**
 * "lỗi" (error) and "lời" (as in "trả lời", reply) both fold to "loi". Decide on the
 * accented text when the user typed accents, and only fall back to the folded form
 * for unaccented typing — excluding the common "tra loi / phan hoi" phrases.
 */
const VI_ACCENTED_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/;
const VI_ERROR_ACCENTED_RE = /\blỗi\b/;
const VI_ERROR_UNACCENTED_RE = /(?<!tra |phan |dap |cau |hoi )\bloi\b(?!\s+(?:chao|cam on|noi|khuyen))/;

const HOW_OR_WHY_RE =
  /\bxu ly\b|\bkhac phuc\b|\bsua\b|\bfix\b|\bresolve\b|\bhandle\b|\bchinh\b|\bthay doi\b|\blam sao\b|\bnhu the nao\b|\bsao\b|\bvi sao\b|\btai sao\b|\bwhy\b|\bhow\b|\bo dau\b|\bwhere\b|\bcan\b.*\bdo\b/;
/** The user wants the Copilot to change/build something — that is a setup request, not a question. */
const SETUP_REQUEST_RE =
  /\bsetup giup\b|\blam giup\b|\bcai dat giup\b|\bthiet lap giup\b|\btao giup\b|\bdo it for me\b|\bset it up\b|\bset up .* for me\b|\bconfigure .* for me\b/;

/**
 * True for questions about a failure or a limit ("xử lý lỗi HTTP 429", "why am
 * I rate limited", "quota exceeded"). Deliberately keyed on error vocabulary
 * so ordinary setup chatter never takes this path.
 */
export function isTroubleshootingQuestion(rawMessage: string): boolean {
  const lowered = rawMessage.trim().toLowerCase().normalize('NFC');
  const text = normalizeKbText(lowered);
  if (!text || text.length > 600) return false;
  if (SETUP_REQUEST_RE.test(text)) return false;
  const viError = VI_ACCENTED_RE.test(lowered) ? VI_ERROR_ACCENTED_RE.test(lowered) : VI_ERROR_UNACCENTED_RE.test(text);
  const weak = viError || WEAK_FAILURE_RE.test(text);
  const hasSignal = HTTP_ERROR_RE.test(text) || FAILURE_WORD_RE.test(text) || (weak && SYSTEM_NOUN_RE.test(text));
  if (!hasSignal) return false;
  // A bare status code or error phrase counts; otherwise it must also be a how/why question.
  return HTTP_ERROR_RE.test(text) || HOW_OR_WHY_RE.test(text);
}

function firstParagraphs(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd()}…`;
}

export interface KbGroundedReply {
  reply: string;
  suggestedQuickReplies: string[];
  chunkIds: string[];
}

/** Compose a reply from retrieved chunks. Returns null when nothing answerable was retrieved. */
export function composeKbGroundedReply(hits: readonly KbHit[], locale: 'vi' | 'en'): KbGroundedReply | null {
  const answerable = hits.filter((h) => ANSWERABLE_SOURCES.has(h.chunk.source));
  const lead = answerable[0];
  if (!lead) return null;
  // Do not answer from a weak match when a doc/page chunk ranks far above it.
  const top = hits[0]!;
  if (!ANSWERABLE_SOURCES.has(top.chunk.source) && top.score > lead.score * 1.6) return null;

  const body = (h: KbHit): string => (locale === 'vi' && h.chunk.textVi ? h.chunk.textVi : h.chunk.text);
  const title = (h: KbHit): string => (locale === 'vi' && h.chunk.titleVi ? h.chunk.titleVi : h.chunk.title);
  const more = answerable.filter((h) => h !== lead).slice(0, 2);

  const lines: string[] = [
    locale === 'vi'
      ? 'Mình đối chiếu với các tuỳ chọn thật trên hệ thống của bạn nhé:'
      : 'Here is what the options actually available on your system say:',
    '',
    `**${title(lead)}**`,
    firstParagraphs(body(lead), 1700),
  ];
  if (more.length > 0) {
    lines.push('', locale === 'vi' ? '**Xem thêm:**' : '**Related:**');
    for (const h of more) {
      const where = h.chunk.path ? ` (\`${h.chunk.path}\`)` : '';
      lines.push(`- ${title(h)}${where}`);
    }
  }
  lines.push(
    '',
    locale === 'vi'
      ? 'Bạn cho mình biết đúng **mã/thông báo lỗi** đang hiện (ví dụ `user_rate_limit_exceeded`, `quota_exceeded`, `routing_exhausted`) để mình chỉ chính xác option cần chỉnh nhé — mình chưa tự đổi gì khi bạn chưa duyệt.'
      : 'Tell me the exact **error code/message** you see (e.g. `user_rate_limit_exceeded`, `quota_exceeded`, `routing_exhausted`) and I will point at the exact option to change — nothing is changed without your approval.',
  );

  const quick =
    locale === 'vi'
      ? ['Kiểm tra lỗi API gần đây của tôi', 'Chỉnh quota theo vai trò ở đâu?', 'Làm sao thêm tài khoản để xoay vòng?']
      : ['Check my recent API errors', 'Where do I change role quotas?', 'How do I add accounts for rotation?'];
  return { reply: lines.join('\n'), suggestedQuickReplies: quick, chunkIds: answerable.map((h) => h.chunk.id) };
}

/** Retrieve + compose in one call; never throws. */
export async function buildKbGroundedFallback(params: {
  messages: ReadonlyArray<{ role: string; content: string }>;
  locale: 'vi' | 'en';
  caller?: KbCaller;
  currentPath?: string;
}): Promise<KbGroundedReply | null> {
  try {
    const hits = await searchKb(buildKbQueryFromMessages(params.messages, params.currentPath), {
      caller: params.caller,
      limit: 5,
      locale: params.locale,
      currentPath: params.currentPath,
    });
    return composeKbGroundedReply(hits, params.locale);
  } catch {
    return null;
  }
}
