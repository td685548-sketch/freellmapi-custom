/**
 * Vietnamese ⇄ English query expansion. The docs are English and many of the
 * user's questions are Vietnamese; lexical retrieval cannot bridge that on its
 * own, so common product vocabulary is mapped in both directions. Keys and
 * values are already accent-folded (see normalizeForLexicalSearch).
 */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['khoa', 'key'], ['han muc', 'quota'], ['tai khoan', 'account'], ['nha cung cap', 'provider'],
  ['nen', 'compression'], ['dinh tuyen', 'routing'], ['du phong', 'fallback'], ['bo nho dem', 'cache'],
  ['quyen', 'permission'], ['phan quyen', 'permission'], ['nguoi dung', 'user'], ['mat khau', 'password'],
  ['cai dat', 'settings'], ['thiet lap', 'setup'], ['loi', 'error'], ['bi loi', 'error'], ['that bai', 'fail'],
  ['cham', 'slow'], ['tre', 'latency'], ['tuong lua', 'guardrail'], ['chan', 'block'],
  ['tri thuc', 'knowledge'], ['tai lieu', 'document'], ['dau ra', 'output'], ['dau vao', 'input'],
  ['giao dien', 'widget'], ['ten mien', 'domain'], ['nhung', 'embed'], ['nhan cach', 'persona'],
  ['khach hang', 'customer'], ['khach', 'guest'], ['phan luong', 'routing'], ['bo phan', 'department'],
  ['phien', 'session'], ['het han', 'expired'], ['dang nhap', 'login'], ['hop nhat', 'unify'],
  ['tiet kiem', 'saver'], ['nhat ky', 'logs'], ['thong ke', 'analytics'], ['sao luu', 'backup'],
  ['cap nhat', 'update'], ['phien ban', 'version'], ['gan', 'attach'], ['them', 'add'], ['tao', 'create'],
  ['xoa', 'delete'], ['bat', 'enable'], ['tat', 'disable'], ['mo hinh', 'model'], ['ma moi', 'invite'],
  ['luu luong', 'traffic'], ['gioi han', 'limit'], ['toc do', 'rate'], ['may chu', 'server'],
  ['mot phan', 'partial'], ['hoan tat', 'complete'], ['chua hoan tat', 'incomplete'], ['buoc', 'step'],
  ['trang', 'page'], ['o dau', 'where'], ['lam sao', 'how'], ['nhu the nao', 'how'], ['vi sao', 'why'], ['tai sao', 'why'],
];

const MAP = new Map<string, Set<string>>();
function link(a: string, b: string): void {
  if (!MAP.has(a)) MAP.set(a, new Set());
  if (!MAP.has(b)) MAP.set(b, new Set());
  MAP.get(a)!.add(b);
  MAP.get(b)!.add(a);
}
for (const [vi, en] of PAIRS) link(vi, en);

/** Extra normalized terms implied by a normalized query (multi-word VI phrases included). */
export function expandQueryTerms(normalizedQuery: string, terms: readonly string[]): string[] {
  const extra = new Set<string>();
  for (const [key, partners] of MAP) {
    const hit = key.includes(' ') ? normalizedQuery.includes(key) : terms.includes(key);
    if (!hit) continue;
    for (const partner of partners) {
      for (const piece of partner.split(' ')) if (piece.length > 1) extra.add(piece);
    }
  }
  for (const t of terms) extra.delete(t);
  return [...extra];
}
