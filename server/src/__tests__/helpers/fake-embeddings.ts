/**
 * fake-embeddings.ts
 *
 * Deterministic, synchronous, in-process fake embeddings for tests.
 * No I/O, no real ML model, no randomness beyond seeded determinism.
 *
 * Algorithm:
 *   1. Seed a low-amplitude background vector from djb2(text) via xorshift32
 *      so every distinct text produces a distinct unit vector.
 *   2. Add light stemmed-token projections for lexical similarity.
 *   3. Project semantic/synonym concept clusters onto dedicated orthogonal-ish
 *      dimensions (collision-free up to 64+ clusters even at dims = 64) so
 *      paraphrased queries without exact keyword overlap align strongly with
 *      their matching knowledge passages.
 *   4. L2-normalize the resulting vector to unit length.
 */

import type { EmbeddingsResult } from '../../services/embeddings.js';

// ---------------------------------------------------------------------------
// djb2 hash → 32-bit unsigned integer seed
// ---------------------------------------------------------------------------

function djb2(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    // hash * 33 XOR charCode
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0; // keep as uint32
  }
  return hash === 0 ? 1 : hash; // xorshift32 must not start at 0
}

// ---------------------------------------------------------------------------
// xorshift32 PRNG
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return function next(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    // Map uint32 to [-1, 1)
    return (state / 0x100000000) * 2 - 1;
  };
}

// ---------------------------------------------------------------------------
// Semantic Concept Clusters (synonym phrases & domain concepts)
// ---------------------------------------------------------------------------

const CONCEPT_CLUSTERS: readonly (readonly RegExp[])[] = [
  // 0: Order placement & daily quota
  [
    /\border\s*id\b/,
    /\bord-/,
    /\bspam\s+folder\b/,
    /\bmailbox\b/,
    /\bjunk\s+tab\b/,
    /\bcheck\s+(?:their\s+)?spam\b/,
    /\b20\s+orders\b/,
    /\bbulk\s+orders?\b/,
    /\bper\s+(?:calendar\s+)?day\b/,
    /\bmaximum\s+daily\s+quota\b/,
    /\btwenty-four\s+hours\b/,
    /\bhow\s+many\b.*\bpurchases\b/,
  ],
  // 1: Order modification window & address/quantity edits
  [
    /\bmodif(?:y|ied|ication|ications)\b/,
    /\bedit\s+order\b/,
    /\b30\s+minutes\b/,
    /\bhalf\s+(?:an\s+)?hour\b/,
    /\bpicking\s+stage\b/,
    /\bdelivery\s+address\b/,
    /\bshipping\s+destination\b/,
    /\bchanging\s+item\s+quantities\b/,
    /\bfix\s+a\s+typo\b/,
    /\bwhere\s+my\s+box\s+goes\b/,
    /\bgrace\s+interval\b/,
    /\bshrink\s+item\s+counts?\b/,
    /\bprior\s+to\s+packing\b/,
  ],
  // 2: Order cancellation before dispatch & pending payment timeout
  [
    /\bcancel\s+order\b/,
    /\bdispatched\b/,
    /\bunshipped\s+transaction\b/,
    /\bwarehouse\s+departure\b/,
    /\babort\b.*\btransaction\b/,
    /\bpending\s+payment\b/,
    /\bunpaid\s+checkout\b/,
    /\bfunds\s+never\s+clear\b/,
    /\bautomatically\s+cancelled\b/,
  ],
  // 3: Standard 30-day refunds & digital exclusions
  [
    /\bstandard\s+refund\s+window\b/,
    /\brefund\s+window\b/,
    /\breturn\s+window\b/,
    /\bdigital\s+goods\b/,
    /\bsoftware\s+licen[cs]es?\b/,
    /\bunwanted\s+merchandise\b/,
    /\bpayout\s+hit\s+my\s+card\b/,
    /\bsending\s+back\s+unwanted\b/,
    /\bwithin\s+5-?7\s+business\s+days\b/,
  ],
  // 4: Partial refunds & proportional promo discounts
  [
    /\bpartial\s+refunds?\b/,
    /\bsubset\s+of\s+items\b/,
    /\bper-unit\s+price\b/,
    /\bhalf\s+my\s+haul\b/,
    /\bpromo\s+markdown\b/,
    /\bproportional(?:ly)?\b/,
    /\brecalculated\b/,
    /\breduced\s+or\s+no\s+refund\b/,
    /\bfreight\s+fees?\s+come\s+back\b/,
    /\bmailing\s+back\s+just\s+one\s+piece\b/,
  ],
  // 5: Expedited refunds for Premium members (provisional credit)
  [
    /\bexpedited\s+refund\b/,
    /\bprovisional\s+credit\b/,
    /\binstant\s+wallet\s+payouts?\b/,
    /\bwarehouse\s+arrival\b/,
    /\bvip\s+subscribers?\b/,
    /\bhazardous\b/,
    /\bdangerous\s+(?:products?|categories)\b/,
    /\bearly\s+wallet\s+payouts?\b/,
    /\bover\s+\$500\b/,
  ],
  // 6: Shipping tiers, delivery speeds, free threshold, international count
  [
    /\bshipping\s+tiers?\b/,
    /\bdelivery\s+(?:speed|options?|times?)\b/,
    /\bstandard\b.*\bexpress\b.*\bovernight\b/,
    /\bfree\s+(?:standard\s+)?shipping\b/,
    /\bbasic\s+us\s+mainland\s+freight\b/,
    /\boutlying\s+islands\b/,
    /\bover\s+\$50\b/,
    /\balaska\s+and\s+hawaii\b/,
    /\b42\s+countries\b/,
  ],
  // 7: Parcel insurance & lost/damaged claims
  [
    /\binsur(?:ed|ance|able)\b/,
    /\bdeclared\s+value\b/,
    /\b\$200\b/,
    /\b\$5,000\b/,
    /\blost\s+or\s+damaged\b/,
    /\bmy\s+carton\b/,
    /\bcrushed\b/,
    /\brecover\s+compensation\b/,
    /\bmonetary\s+protection\b/,
    /\boptional\s+upper\s+cap\b/,
    /\bfile\s+a\s+claim\b/,
  ],
  // 8: Warehouse dispatch cutoff & holiday peak delays
  [
    /\b1:00\s*pm\b/,
    /\bcut-?off\b/,
    /\bafternoon\s+clock\s+hour\b/,
    /\bdepart\s+that\s+same\s+evening\b/,
    /\bsame[- ]day\b/,
    /\bfederal\s+holidays?\b/,
    /\bpeak\s+periods?\b/,
    /\blate-year\b.*\brush\b/,
    /\bdecember\b/,
    /\bfestive\b/,
    /\bdistribution\s+centres?\b/,
  ],
  // 9: Accepted payment methods, ACH settlement, fraud holds
  [
    /\bpayment\s+methods?\b/,
    /\bvisa\b/,
    /\bmastercard\b/,
    /\bamerican\s+express\b/,
    /\bpaypal\b/,
    /\bach\b/,
    /\bbank\s+(?:transfer|wires?)\b/,
    /\bcryptocurrency\b/,
    /\bbitcoin\b/,
    /\bdigital\s+coins?\b/,
    /\brisk\s+checks?\b/,
    /\bfraud\s+prevention\b/,
    /\bpayment\s+hold\b/,
  ],
  // 10: B2B monthly invoicing, net-30, late charges, overdue
  [
    /\binvoic(?:e|es|ing)\b/,
    /\bnet-?30\b/,
    /\bcorporate\s+(?:accounts?|monthly\s+statements?)\b/,
    /\bspreadsheet\s+or\s+document\b/,
    /\blate\s+payments?\b/,
    /\b1\.5%\b/,
    /\b60\s+days\s+overdue\b/,
    /\bpast\s+one\s+month\b/,
    /\benterprise\s+payers?\b/,
    /\bpdf\s+or\s+csv\b/,
  ],
  // 11: Prepaid Acme Credit denominations & expiry
  [
    /\bacme\s+credit\b/,
    /\bprepaid\s+credit\b/,
    /\bpreloaded\s+store\s+funds?\b/,
    /\bvanish\s+over\s+time\b/,
    /\bdenominations?\b/,
    /\bpreset\s+dollar\s+tiers?\b/,
    /\bsettle\s+freight\b/,
    /\bnever\s+expires?\b/,
    /\bnon-transferable\b/,
  ],
  // 12: Customer support hours, chat/email SLAs, Help Centre
  [
    /\b24\s+hours\b/,
    /\baround\s+the\s+clock\b/,
    /\bself-service\s+how-to\b/,
    /\blive\s+chat\b/,
    /\bphone\s+support\b/,
    /\btelephone\b/,
    /\beastern\s+time\b/,
    /\bfour\s+business\s+hours\b/,
    /\bpriority\s+support\b/,
    /\bhelp\s+centre\b/,
    /\bwithout\s+(?:logging|signing)\s+in\b/,
    /\breply\s+speed\b/,
    /\bresponse\s+time\b/,
  ],
  // 13: Support tickets, reopening, 3-year retention, ratings
  [
    /\bticket(?:s|ing)?\b/,
    /\bhelpdesk\s+(?:thread|transcripts?)\b/,
    /\bstill\s+be\s+restarted\b/,
    /\breopen(?:ed)?\b/,
    /\b7\s+days\s+of\s+resolution\b/,
    /\b3\s+years\b/,
    /\bticket\s+records?\b/,
    /\bservice\s+quality\b/,
    /\bbelow\s+3\s+stars\b/,
    /\bpoor\s+satisfaction\s+scores?\b/,
    /\bsupport\s+(?:history|interactions|transcripts)\b/,
  ],
  // 14: Escalation path & disputes
  [
    /\bescalat(?:e|ed|ion|ions)\b/,
    /\bsenior\s+support\s+specialist\b/,
    /\bhigher-tier\s+oversight\b/,
    /\bcomplainant\b/,
    /\bcustomer\s+experience\s+manager\b/,
    /\bleads\s+and\s+counsel\b/,
    /\bmonetary\s+grievances?\b/,
    /\blegal\s+and\s+compliance\b/,
    /\bunresolved\b/,
    /\bunhappy\b/,
    /\bdisputes?\b/,
    /\b10\s+business\s+days\b/,
  ],
  // 15: Returns workflow & prepaid shipping label
  [
    /\breturn\s+items\b/,
    /\breturn\s+(?:shipping\s+)?label\b/,
    /\bprepaid\b.*\blabel\b/,
    /\b15\s+minutes\b.*\blabel\b/,
    /\bvalid\s+for\s+14\s+days\b/,
    /\bdrop\s+the\s+parcel\b/,
    /\baffiliated\s+carrier\b/,
    /\binspection\s+process\b/,
    /\bsend\s+(?:an\s+)?item\s+back\b/,
  ],
  // 16: Non-returnable / excluded items
  [
    /\bnon-returnable\b/,
    /\bnot\s+eligible\s+for\s+return\b/,
    /\bexcluded\b.*\breturn/,
    /\bperishable\b/,
    /\bfresh\s+groceries\b/,
    /\bpersonalised\b/,
    /\bbespoke\s+final-markdown\b/,
    /\bfaulty\s+from\s+the\s+factory\b/,
    /\bcustom-made\b/,
    /\bbespoke\b/,
    /\bengraved\s+keepsakes?\b/,
    /\bhygiene\b/,
    /\bopened\s+personal\s+care\b/,
    /\bfinal\s+sale\b/,
    /\bcustomer\s+misuse\b/,
  ],
  // 17: International returns & customs duties
  [
    /\binternational\s+returns?\b/,
    /\breturned\s+goods\b/,
    /\bcustoms\b/,
    /\bimport\s+duties\b/,
    /\btariff\b/,
    /\bcross-border\s+paperwork\b/,
    /\babroad\b/,
    /\boverseas\b/,
    /\bforeign\b/,
    /\b21\s+days\b/,
    /\bproof\s+of\s+postage\b/,
  ],
  // 18: Account registration, password policy, 2FA/MFA
  [
    /\bregistering\b/,
    /\bsign\s*up\b/,
    /\b10\s+characters\b/,
    /\btwo-factor\b/,
    /\b2fa\b/,
    /\bmfa\b/,
    /\btotp\b/,
    /\bauthenticator\b/,
    /\bsms\s+verification\b/,
    /\b5%\s+discount\b/,
    /\bre-verification\b/,
  ],
  // 19: Inactivity, suspension, recovery, voluntary deletion (30-day GDPR retention)
  [
    /\binactiv(?:e|ity)\b/,
    /\b24\s+consecutive\s+months\b/,
    /\btwo\s+full\s+years\b/,
    /\bnot\s+logged\s+in\b/,
    /\blogin\s+dormant\b/,
    /\babandon(?:ed|s)?\b/,
    /\bdormant\b/,
    /\bclosed\s+history\s+wiped\b/,
    /\bsuspended\b/,
    /\breactivate\b/,
    /\baccount\s+recovery\b/,
    /\bclose\s+account\b/,
    /\bpermanently\s+closed\b/,
    /\berase\b/,
    /\bdata\s+retention\b/,
  ],
  // 20: Premium membership subscription pricing & perks
  [
    /\b\$9\.99\b/,
    /\b\$99\b/,
    /\bpremium\s+membership\b/,
    /\bvip\s+tier\b/,
    /\brejoin\s+without\s+delay\b/,
    /\bpaid\s+subscription\b/,
    /\bauto-renew(?:ed|al)?\b/,
    /\b90\s+days\b.*\bre-subscribe\b/,
    /\be-voucher\b/,
    /\bearly\s+access\b/,
    /\bfree\s+express\s+shipping\b/,
  ],
  // 21: Standard 1-year warranty & defects
  [
    /\bone-year\s+limited\s+warranty\b/,
    /\bstandard\s+(?:product\s+)?warranty\b/,
    /\bmanufacturing\s+defects?\b/,
    /\bhardware\s+failures?\b/,
    /\baccidental\s+damage\b/,
    /\bwater\s+damage\b/,
    /\bcosmetic\s+wear\b/,
    /\bphoto\s+evidence\b/,
    /\bwarranty\s+claims?\b/,
    /\bmalfunction\b/,
  ],
  // 22: Extended warranty (ShieldCare Pro, 2-3 years, transferable)
  [
    /\bextended\s+warrant(?:y|ies)\b/,
    /\bshieldcare\s+pro\b/,
    /\btwo\s+or\s+three\s+years\b/,
    /\bmulti-year\s+breakdown\b/,
    /\bclumsy\s+drops?\b/,
    /\bresale\s+transfers?\b/,
    /\bresold\b/,
    /\bannual\s+maintenance\b/,
    /\btransferable\b/,
    /\b\$15\s+transfer\s+fee\b/,
    /\bextra\s+protection\b/,
    /\bcoverage\s+plan\b/,
  ],
  // 23: Price protection / price match
  [
    /\bprice\s+protection\b/,
    /\bprice\s+match\b/,
    /\bprice\s+drops?\b/,
    /\bshelf\s+tags?\s+drop\b/,
    /\bclaim\s+a\s+rebate\b/,
    /\bdrops?\s+in\s+(?:price|cost)\b/,
    /\bcheaper\b/,
    /\blower\s+price\b/,
    /\bprice\s+difference\b/,
    /\bflash\s+(?:sales?|markdowns?)\b/,
  ],
  // 24: Promotional codes & referral bonuses
  [
    /\bpromotional\s+codes?\b/,
    /\bpromo\s+codes?\b/,
    /\bcoupon\b/,
    /\bvoucher\s+code\b/,
    /\bcheckout\b.*\bcode\b/,
    /\breferral\s+bonus(?:es)?\b/,
    /\breferr(?:er|ed)\b/,
    /\bseasonal\s+sales?\b/,
  ],
  // 25: Acme Rewards loyalty points
  [
    /\bacme\s+rewards\b/,
    /\bloyalty\s+(?:programme|points?|credits?|perks?)\b/,
    /\breward\s+points?\b/,
    /\b100\s+points\b/,
    /\b500\s+points\b/,
    /\bredeem(?:ed|ing|ption)?\b/,
    /\bminimum\s+balance\s+unlocks\b/,
    /\breclaimed\b/,
    /\bloyalty\s+perks?\s+vanish\b/,
    /\bearn(?:ed)?\s+(?:one|1\.5)\s+points?\b/,
  ],
  // 26: Personal data privacy, GDPR, CCPA, data export copy
  [
    /\bpersonal\s+(?:data|information)\b/,
    /\bdoes\s+not\s+sell\b/,
    /\bsell\s+my\s+(?:personal\s+)?data\b/,
    /\brequest\s+a\s+copy\b/,
    /\bdownload\s+stored\s+records?\b/,
    /\beuropean\b.*\bprivacy\b/,
    /\bcalifornia\s+privacy\b/,
    /\bgdpr\b/,
    /\bccpa\b/,
    /\beuropean\s+economic\s+area\b/,
    /\bdata\s+protection\b/,
  ],
  // 27: Cookies & consent preferences
  [
    /\bcookies?\b/,
    /\btracking\s+technologies\b/,
    /\btargeted\s+browser\s+trackers?\b/,
    /\bessential\s+sessions?\b/,
    /\bconsent\s+banner\b/,
    /\bstrictly\s+necessary\b/,
    /\bopt\s+out\b/,
    /\badvertising\b/,
  ],
  // 28: B2B Business programme & volume pricing
  [
    /\bbusiness\s+programme\b/,
    /\bvolume\s+pricing\b/,
    /\bdedicated\s+(?:account\s+managers?|reps?)\b/,
    /\btax\s+id(?:entification)?\b/,
    /\bbusiness\s+portal\b/,
    /\b90-day\s+rolling\b/,
    /\benterprise\b.*\bwholesale\b/,
    /\bwholesale\s+discounts?\b/,
    /\borganisations?\b.*\bvolume\b/,
  ],
  // 29: Acme REST API, OAuth 2.0, rate limit / 429 / throttling, sandbox
  [
    /\brest\s+over\s+https\b/,
    /\bacme\s+api\b/,
    /\boauth\s*2\.0\b/,
    /\bbearer\s+tokens?\b/,
    /\brate[- ]limits?\b/,
    /\bthrottl(?:e|ed|ing)\b/,
    /\b429\b/,
    /\b1,000\s+requests\b/,
    /\bsandbox\b/,
    /\bbreaking\s+api\s+changes\b/,
    /\bsso\b/,
    /\bsaml\b/,
    /\bokta\b/,
    /\bidp\b/,
    /\bfederation\b/,
  ],
  // 30: Accessibility (WCAG 2.1, screen readers, deaf relay, captions)
  [
    /\baccessib(?:le|ility)\b/,
    /\bdisabilities\b/,
    /\bscreen\s+readers?\b/,
    /\bassistive\b/,
    /\bwcag\b/,
    /\brelay\b/,
    /\bdeaf\b/,
    /\bhard\s+of\s+hearing\b/,
    /\bsightless\b/,
    /\bblind\b/,
    /\bcaptioned\b/,
    /\baudio\s+descriptions?\b/,
    /\bspoken\s+commentary\b/,
    /\btext\s+subtitles?\b/,
  ],
  // 31: Security, TLS/mTLS/certificates, PCI DSS, failed login lockout
  [
    /\btls\b/,
    /\bmtls\b/,
    /\bcertificate\b/,
    /\bpci\s+dss\b/,
    /\bencrypted\b/,
    /\bfailed\s+login\b/,
    /\bbad\s+sign-in\s+secrets?\b/,
    /\bfive\s+times\s+straight\b/,
    /\bfive\s+consecutive\b/,
    /\btemporarily\s+locked\b/,
    /\bpassword\s+reset\b/,
    /\bsecurity\s+audits?\b/,
    /\bsafeguard\b/,
    /\bpayment\s+(?:card\s+)?information\b/,
  ],
  // 32: Credentials / password / reset / login general cluster
  [
    /\bpassword\b/,
    /\bpassphrase\b/,
    /\bcredentials?\b/,
    /\blogin\b/,
    /\blog\s+in\b/,
    /\bsign\s+in\b/,
    /\breset\b/,
    /\bunlock\b/,
  ],
  // 33: Webhooks / HMAC / signature / callback general cluster
  [
    /\bwebhooks?\b/,
    /\bhmac\b/,
    /\bsignatures?\b/,
    /\bcallbacks?\b/,
    /\bsigning\s+secret\b/,
  ],
  // 34: General refund / chargeback cluster
  [
    /\brefunds?\b/,
    /\breimburse(?:ment)?\b/,
    /\bchargeback\b/,
    /\bcredit\s+back\b/,
  ],
];

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'my', 'me', 'i',
  'it', 'be', 'do', 'does', 'did', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'can',
  'with', 'at', 'by', 'we', 'you', 'your', 'if', 'that', 'this', 'from', 'they', 'their', 'has',
  'have', 'been', 'will', 'would', 'could', 'should', 'about', 'into', 'any', 'all', 'as', 'not',
  'no', 'so', 'up', 'out', 'than', 'then', 'there', 'also', 'may', 'must', 'only',
]);

function stemToken(token: string): string {
  if (token.length <= 4) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ing') && token.length > 5) return token.slice(0, -3);
  if (token.endsWith('ed') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenizeNormalized(normalizedText: string): string[] {
  const matches = normalizedText.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    out.push(stemToken(raw));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core embedding
// ---------------------------------------------------------------------------

/**
 * Returns a deterministic unit-normalized Float32Array of length `dims`
 * for the given text string.
 *
 * @param text - Input text to embed.
 * @param dims - Embedding dimension (default 768).
 */
export function fakeEmbed(text: string, dims = 768): Float32Array {
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new RangeError(`fakeEmbed: dims must be a positive integer (got ${dims})`);
  }

  const normalized = String(text ?? '').normalize('NFC').toLowerCase();
  const seed = djb2(normalized);
  const rand = xorshift32(seed);
  const vec = new Float32Array(dims);

  // 1. Subtle deterministic background noise (fixed L2 budget regardless of dims).
  const bgScale = 0.06 / Math.sqrt(dims);
  for (let i = 0; i < dims; i++) {
    vec[i] = rand() * bgScale;
  }

  // 2. Light stemmed token projections.
  const seenTokens = new Set(tokenizeNormalized(normalized));
  const tokWeight = 0.22;
  for (const tok of seenTokens) {
    const h = djb2(`tok:${tok}`);
    const idx = h % dims;
    const sign = (h & 1) === 0 ? 1 : -1;
    vec[idx] += sign * tokWeight;
  }

  // 3. Strong semantic concept cluster projections.
  const clusterWeight = 2.5;
  for (let c = 0; c < CONCEPT_CLUSTERS.length; c++) {
    const patterns = CONCEPT_CLUSTERS[c]!;
    let hits = 0;
    for (const re of patterns) {
      if (re.test(normalized)) {
        hits++;
      }
    }
    if (hits > 0) {
      const w = clusterWeight * (1 + 0.35 * Math.min(3, hits - 1));
      const p1 = c % dims;
      vec[p1] += w;
      if (dims >= 128) {
        const p2 = (c * 13 + 37) % dims;
        if (p2 !== p1) vec[p2] += w * 0.7;
      }
    }
  }

  // 4. L2 normalize
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += vec[i]! * vec[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) {
      vec[i] = vec[i]! / norm;
    }
  }

  return vec;
}

/**
 * Embed a batch of texts. Each text is embedded independently.
 *
 * @param texts - Array of input texts.
 * @param dims  - Embedding dimension (default 768).
 */
export function fakeEmbedBatch(texts: string[], dims = 768): Float32Array[] {
  return texts.map((t) => fakeEmbed(t, dims));
}

/**
 * Convenience deterministic `EmbeddingsRunner` adapter backed by `fakeEmbedBatch`.
 */
export function createFakeEmbeddingsRunner(
  dimsOrOptions: number | { dims?: number; modelId?: string } = 768,
) {
  const defaultDims =
    typeof dimsOrOptions === 'number' ? dimsOrOptions : (dimsOrOptions.dims ?? 768);
  const defaultModelId =
    typeof dimsOrOptions === 'number' ? 'fake-embeddings-v1' : (dimsOrOptions.modelId ?? 'fake-embeddings-v1');

  return async (
    model: string | undefined,
    inputs: string[],
    dimensions?: number,
  ): Promise<EmbeddingsResult> => {
    const dims = dimensions ?? defaultDims;
    const vectors = fakeEmbedBatch(inputs, dims).map((v) => Array.from(v));
    const inputTokens = inputs.reduce(
      (sum, t) => sum + Math.max(1, Math.ceil(t.length / 4)),
      0,
    );
    return {
      family: model || 'fake-embeddings',
      platform: 'fake',
      modelId: model || defaultModelId,
      dimensions: dims,
      vectors,
      inputTokens,
    };
  };
}

/**
 * Cosine similarity between two unit-normalised vectors.
 * Returns a value in [-1, 1].
 *
 * @param a - First vector (must have same length as b).
 * @param b - Second vector.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSim: vector length mismatch (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
