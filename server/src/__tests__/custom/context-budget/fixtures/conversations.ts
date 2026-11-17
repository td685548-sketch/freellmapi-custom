import type { ChatMessage } from '@freellmapi/shared/types.js';

export type ConversationLanguage = 'en' | 'vi' | 'zh';

export interface MakeConversationOptions {
  turns: number;
  lang: ConversationLanguage;
  withToolCalls?: boolean;
  seed?: number;
}

export interface FactRecallItem {
  id: number;
  category: 'name' | 'number' | 'order_code' | 'date';
  fact: string;
  userMessage: string;
  assistantAck: string;
  question: string;
  expectedAnswer: string;
  acceptedPatterns: string[];
}

export interface FactRecallTurn {
  user: string;
  assistant: string;
}

export interface FactRecallQuestion {
  id: number;
  factId: number;
  question: string;
  expectedAnswer: string;
  acceptedPatterns: string[];
}

export interface FactRecallScenario {
  facts: FactRecallItem[];
  factMessages: ChatMessage[];
  fillerTurns: FactRecallTurn[];
  fillerMessages: ChatMessage[];
  questions: FactRecallQuestion[];
  messages: ChatMessage[];
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashLang(lang: ConversationLanguage): number {
  if (lang === 'en') return 101;
  if (lang === 'vi') return 202;
  return 303;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

const EN_TOPICS = [
  'gateway latency spikes on regional fallback routes',
  'cache hit ratios across multi-turn support sessions',
  'retry backoff configuration for upstream rate limits',
  'token reserve allocation for structured JSON replies',
  'streaming chunk buffering and connection keepalive',
  'embedding index refresh after document uploads',
  'role-based permissions for workspace members',
  'daily usage quota aggregation and alert thresholds',
] as const;

const EN_ACTIONS = [
  'Check the rolling window metrics from the past two hours and compare them with yesterday.',
  'Confirm whether the fallback queue selected the secondary model when the primary returned 503.',
  'Verify that older turns are folded cleanly without duplicating any previously summarized facts.',
  'Ensure tool call outputs stay paired with the assistant request that invoked them.',
] as const;

const VI_TOPICS = [
  'tối ưu độ trễ định tuyến dự phòng theo từng khu vực',
  'tỷ lệ giữ bộ nhớ đệm qua nhiều lượt hội thoại hỗ trợ',
  'cấu hình thời gian chờ khi nhà cung cấp giới hạn tần suất',
  'phân bổ phần token dự phòng cho phản hồi có cấu trúc',
  'xử lý luồng dữ liệu trực tuyến và giữ kết nối ổn định',
  'cập nhật chỉ mục tìm kiếm sau khi tải tài liệu tri thức mới',
  'phân quyền truy cập cho thành viên theo từng khóa ứng dụng',
  'tổng hợp hạn mức sử dụng hằng ngày và cảnh báo vượt ngưỡng',
] as const;

const VI_ACTIONS = [
  'Kiểm tra số liệu trong hai giờ gần nhất và đối chiếu với ngày hôm qua để phát hiện bất thường.',
  'Xác nhận chuỗi dự phòng đã chuyển sang model thứ cấp khi model chính báo lỗi tạm thời.',
  'Đối chiếu mốc tóm tắt để chắc chắn không có lượt hội thoại nào bị gộp trùng hai lần.',
  'Đảm bảo cặp lời gọi công cụ và kết quả trả về luôn nằm chung trong một phân đoạn ngữ cảnh.',
] as const;

const ZH_TOPICS = [
  '区域故障转移路由的延迟波动排查',
  '多轮客服会话中的提示词缓存命中率分析',
  '上游限流响应后的指数退避重试策略',
  '结构化响应输出预留令牌的配额分配',
  '流式分块传输缓冲与长连接保活设置',
  '知识库文档更新后的混合检索索引刷新',
  '面向工作区成员的客户端密钥权限校验',
  '每日请求配额统计与异常告警阈值核对',
] as const;

const ZH_ACTIONS = [
  '请核对过去两小时的滚动统计数据，并与昨日同一时段指标进行对比。',
  '确认主模型返回服务不可用时，备用路由链是否正确切换到了次级模型。',
  '检查滚动摘要边界标识，确保旧对话轮次仅被合并一次且无遗漏。',
  '保持工具调用请求与其返回结果在同一上下文片段中成对出现。',
] as const;

function buildTurnTexts(
  turnIndex: number,
  lang: ConversationLanguage,
  rng: () => number,
): { user: string; assistant: string; toolName: string; toolArgs: string; toolResult: string } {
  const code = `REQ-${1000 + turnIndex}-${Math.floor(rng() * 90 + 10)}`;
  const count = Math.floor(rng() * 40 + 12);

  if (lang === 'en') {
    const topic = pick(EN_TOPICS, rng);
    const action = pick(EN_ACTIONS, rng);
    return {
      user: `Turn ${turnIndex + 1} (${code}): Please review ${topic}. ${action} Include the ${count} recent samples in your check.`,
      assistant: `Reviewed ${topic} for ${code} across ${count} samples. Everything aligns with the expected baseline and no anomalies remain open for turn ${turnIndex + 1}.`,
      toolName: 'fetch_diagnostic_metric',
      toolArgs: JSON.stringify({ code, turn: turnIndex + 1, sampleLimit: count }),
      toolResult: JSON.stringify({ code, status: 'ok', samplesChecked: count }),
    };
  }

  if (lang === 'vi') {
    const topic = pick(VI_TOPICS, rng);
    const action = pick(VI_ACTIONS, rng);
    return {
      user: `Lượt ${turnIndex + 1} (${code}): Hãy rà soát vấn đề ${topic}. ${action} Đối chiếu thêm ${count} mẫu ghi nhận gần đây.`,
      assistant: `Đã rà soát xong nội dung ${topic} cho mã ${code} trên ${count} mẫu dữ liệu. Các chỉ số đều nằm trong ngưỡng ổn định tại lượt ${turnIndex + 1}.`,
      toolName: 'tra_cuu_chi_so',
      toolArgs: JSON.stringify({ ma: code, luot: turnIndex + 1, soMau: count }),
      toolResult: JSON.stringify({ ma: code, trangThai: 'dat', daKiemTra: count }),
    };
  }

  const topic = pick(ZH_TOPICS, rng);
  const action = pick(ZH_ACTIONS, rng);
  return {
    user: `第${turnIndex + 1}轮（${code}）：请排查${topic}。${action} 并核对最近${count}条样本记录。`,
    assistant: `已完成${code}关于${topic}的检查，共核验${count}条样本数据，第${turnIndex + 1}轮各项运行指标均处于正常范围。`,
    toolName: 'query_service_metrics',
    toolArgs: JSON.stringify({ code, turn: turnIndex + 1, samples: count }),
    toolResult: JSON.stringify({ code, status: 'ok', checked: count }),
  };
}

/**
 * Deterministically generate a synthetic multi-turn conversation as `ChatMessage[]`.
 */
export function makeConversation(options: MakeConversationOptions): ChatMessage[] {
  const { turns, lang, withToolCalls = false, seed = 1 } = options;
  if (turns <= 0) return [];

  const rng = createRng(seed + hashLang(lang));
  const messages: ChatMessage[] = [];

  for (let i = 0; i < turns; i++) {
    const turn = buildTurnTexts(i, lang, rng);
    messages.push({ role: 'user', content: turn.user });

    if (withToolCalls && i % 3 === 1) {
      const callId = `call_${seed}_${i}`;
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: {
              name: turn.toolName,
              arguments: turn.toolArgs,
            },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        name: turn.toolName,
        content: turn.toolResult,
      });
    }

    messages.push({ role: 'assistant', content: turn.assistant });
  }

  return messages;
}

const FACT_SPECS: ReadonlyArray<{
  category: FactRecallItem['category'];
  fact: string;
  userMessage: string;
  assistantAck: string;
  question: string;
  expectedAnswer: string;
  acceptedPatterns: string[];
}> = [
  {
    category: 'name',
    fact: 'Primary account holder is Dr. Elena Vance.',
    userMessage: 'Please note for our records that the primary account holder is Dr. Elena Vance.',
    assistantAck: 'Noted: the primary account holder is Dr. Elena Vance.',
    question: 'What is the full name of the primary account holder?',
    expectedAnswer: 'Elena Vance',
    acceptedPatterns: ['elena vance'],
  },
  {
    category: 'order_code',
    fact: 'Hardware replacement order code is ORD-7492-XK.',
    userMessage: 'My hardware replacement order code is ORD-7492-XK; keep it handy for follow-up.',
    assistantAck: 'Recorded hardware replacement order code ORD-7492-XK.',
    question: 'What is the hardware replacement order code?',
    expectedAnswer: 'ORD-7492-XK',
    acceptedPatterns: ['ord-7492-xk'],
  },
  {
    category: 'date',
    fact: 'Annual compliance audit date is 2026-08-19.',
    userMessage: 'Our annual compliance audit is scheduled for 2026-08-19.',
    assistantAck: 'Logged the annual compliance audit date as 2026-08-19.',
    question: 'On what date is the annual compliance audit scheduled?',
    expectedAnswer: '2026-08-19',
    acceptedPatterns: ['2026-08-19', 'august 19, 2026', '19 august 2026'],
  },
  {
    category: 'number',
    fact: 'The approved reimbursement cap is 48250 USD.',
    userMessage: 'Finance approved a reimbursement cap of 48250 USD for this migration.',
    assistantAck: 'Understood: the approved reimbursement cap is 48250 USD.',
    question: 'What is the approved reimbursement cap in USD?',
    expectedAnswer: '48250',
    acceptedPatterns: ['48250', '48,250'],
  },
  {
    category: 'name',
    fact: 'On-call security liaison is Marcus Chen.',
    userMessage: 'For any escalation, the on-call security liaison is Marcus Chen.',
    assistantAck: 'Got it: Marcus Chen is the on-call security liaison.',
    question: 'Who is the on-call security liaison?',
    expectedAnswer: 'Marcus Chen',
    acceptedPatterns: ['marcus chen'],
  },
  {
    category: 'order_code',
    fact: 'License renewal reference is LIC-9031-QM.',
    userMessage: 'The enterprise license renewal reference is LIC-9031-QM.',
    assistantAck: 'Saved license renewal reference LIC-9031-QM.',
    question: 'What is the enterprise license renewal reference?',
    expectedAnswer: 'LIC-9031-QM',
    acceptedPatterns: ['lic-9031-qm'],
  },
  {
    category: 'date',
    fact: 'Data center cutover window starts on 2026-10-04.',
    userMessage: 'The data center cutover window starts on 2026-10-04 at midnight UTC.',
    assistantAck: 'Recorded that the data center cutover window starts on 2026-10-04.',
    question: 'What date does the data center cutover window start?',
    expectedAnswer: '2026-10-04',
    acceptedPatterns: ['2026-10-04', 'october 4, 2026', '4 october 2026'],
  },
  {
    category: 'number',
    fact: 'Cluster node count is 37 active nodes.',
    userMessage: 'Production cluster currently runs exactly 37 active nodes.',
    assistantAck: 'Noted: production cluster runs 37 active nodes.',
    question: 'How many active nodes are running in the production cluster?',
    expectedAnswer: '37',
    acceptedPatterns: ['37'],
  },
  {
    category: 'name',
    fact: 'Regional partner vendor is Northwind Logistics.',
    userMessage: 'We signed Northwind Logistics as the regional partner vendor for freight.',
    assistantAck: 'Recorded Northwind Logistics as the regional partner vendor.',
    question: 'Which company is the regional partner vendor for freight?',
    expectedAnswer: 'Northwind Logistics',
    acceptedPatterns: ['northwind logistics'],
  },
  {
    category: 'order_code',
    fact: 'Customs clearance tracking number is TRK-5580-BV.',
    userMessage: 'Please track customs clearance under tracking number TRK-5580-BV.',
    assistantAck: 'Stored customs clearance tracking number TRK-5580-BV.',
    question: 'What is the customs clearance tracking number?',
    expectedAnswer: 'TRK-5580-BV',
    acceptedPatterns: ['trk-5580-bv'],
  },
  {
    category: 'date',
    fact: 'API key rotation deadline is 2026-12-15.',
    userMessage: 'All legacy API keys must be rotated before the deadline on 2026-12-15.',
    assistantAck: 'Noted API key rotation deadline: 2026-12-15.',
    question: 'What is the deadline date for rotating legacy API keys?',
    expectedAnswer: '2026-12-15',
    acceptedPatterns: ['2026-12-15', 'december 15, 2026', '15 december 2026'],
  },
  {
    category: 'number',
    fact: 'Reserved disaster recovery port is 8443.',
    userMessage: 'The reserved disaster recovery gateway listens on port 8443.',
    assistantAck: 'Recorded port 8443 for the disaster recovery gateway.',
    question: 'Which port is reserved for the disaster recovery gateway?',
    expectedAnswer: '8443',
    acceptedPatterns: ['8443'],
  },
  {
    category: 'name',
    fact: 'Lead database architect is Priya Nair.',
    userMessage: 'Priya Nair is the lead database architect overseeing the schema migration.',
    assistantAck: 'Noted that Priya Nair is the lead database architect.',
    question: 'Who is the lead database architect overseeing the schema migration?',
    expectedAnswer: 'Priya Nair',
    acceptedPatterns: ['priya nair'],
  },
  {
    category: 'order_code',
    fact: 'Invoice batch identifier is INV-3194-ZD.',
    userMessage: 'Pending billing reconciliation covers invoice batch INV-3194-ZD.',
    assistantAck: 'Logged pending billing reconciliation for invoice batch INV-3194-ZD.',
    question: 'What is the invoice batch identifier for the pending billing reconciliation?',
    expectedAnswer: 'INV-3194-ZD',
    acceptedPatterns: ['inv-3194-zd'],
  },
  {
    category: 'date',
    fact: 'Vendor contract renewal date is 2027-01-22.',
    userMessage: 'Mark the vendor contract renewal date as 2027-01-22.',
    assistantAck: 'Marked 2027-01-22 as the vendor contract renewal date.',
    question: 'When is the vendor contract renewal date?',
    expectedAnswer: '2027-01-22',
    acceptedPatterns: ['2027-01-22', 'january 22, 2027', '22 january 2027'],
  },
  {
    category: 'number',
    fact: 'Contractual uptime SLA target is 99.95%.',
    userMessage: 'Our contractual uptime SLA target for tier-1 tenants is 99.95%.',
    assistantAck: 'Recorded the contractual uptime SLA target of 99.95%.',
    question: 'What is the contractual uptime SLA target percentage?',
    expectedAnswer: '99.95%',
    acceptedPatterns: ['99.95'],
  },
  {
    category: 'name',
    fact: 'Backup storage bucket is named vault-eu-west-9.',
    userMessage: 'Encrypted snapshots are archived in the bucket named vault-eu-west-9.',
    assistantAck: 'Noted backup storage bucket vault-eu-west-9.',
    question: 'What is the name of the backup storage bucket?',
    expectedAnswer: 'vault-eu-west-9',
    acceptedPatterns: ['vault-eu-west-9'],
  },
  {
    category: 'order_code',
    fact: 'Warranty claim ticket ID is CLM-6208-RT.',
    userMessage: 'Keep warranty claim ticket ID CLM-6208-RT open until the replacement arrives.',
    assistantAck: 'Tracked open warranty claim ticket ID CLM-6208-RT.',
    question: 'What is the open warranty claim ticket ID?',
    expectedAnswer: 'CLM-6208-RT',
    acceptedPatterns: ['clm-6208-rt'],
  },
  {
    category: 'date',
    fact: 'Quarterly disaster drill is set for 2026-09-11.',
    userMessage: 'The quarterly disaster recovery drill is scheduled for 2026-09-11.',
    assistantAck: 'Noted 2026-09-11 for the quarterly disaster recovery drill.',
    question: 'What date is set for the quarterly disaster recovery drill?',
    expectedAnswer: '2026-09-11',
    acceptedPatterns: ['2026-09-11', 'september 11, 2026', '11 september 2026'],
  },
  {
    category: 'number',
    fact: 'Maximum webhook payload retention is 14 days.',
    userMessage: 'Compliance requires maximum webhook payload retention of 14 days.',
    assistantAck: 'Recorded maximum webhook payload retention of 14 days.',
    question: 'How many days is the maximum webhook payload retention?',
    expectedAnswer: '14',
    acceptedPatterns: ['14'],
  },
];

const FILLER_SUBJECTS = [
  'CSS grid layout alignment on narrow viewports',
  'structured logging field formatting for HTTP requests',
  'unit test naming conventions for helper modules',
  'markdown table indentation in documentation pages',
  'typecheck script caching in monorepo workspaces',
  'debounce intervals for dashboard filter inputs',
  'accessible keyboard focus outlines on modal dialogs',
  'icon sizing consistency across status badges',
] as const;

/**
 * Deterministic 20-fact + 120-filler-turn + 20-question recall benchmark scenario (SC-004).
 */
export function makeFactRecallScenario(): FactRecallScenario {
  const facts: FactRecallItem[] = FACT_SPECS.map((spec, index) => ({
    id: index + 1,
    category: spec.category,
    fact: spec.fact,
    userMessage: spec.userMessage,
    assistantAck: spec.assistantAck,
    question: spec.question,
    expectedAnswer: spec.expectedAnswer,
    acceptedPatterns: spec.acceptedPatterns,
  }));

  const factMessages: ChatMessage[] = [];
  for (const item of facts) {
    factMessages.push({ role: 'user', content: item.userMessage });
    factMessages.push({ role: 'assistant', content: item.assistantAck });
  }

  const rng = createRng(20261117);
  const fillerTurns: FactRecallTurn[] = [];
  const fillerMessages: ChatMessage[] = [];

  for (let i = 0; i < 120; i++) {
    const subject = FILLER_SUBJECTS[i % FILLER_SUBJECTS.length];
    const variant = Math.floor(rng() * 900 + 100);
    const user = `Filler discussion #${i + 1} (ref F-${variant}): Let's review best practices for ${subject} during routine maintenance.`;
    const assistant = `Filler summary #${i + 1} (ref F-${variant}): Standardized ${subject} according to the routine style checklist with no pending action items.`;
    fillerTurns.push({ user, assistant });
    fillerMessages.push({ role: 'user', content: user });
    fillerMessages.push({ role: 'assistant', content: assistant });
  }

  const questions: FactRecallQuestion[] = facts.map((item) => ({
    id: item.id,
    factId: item.id,
    question: item.question,
    expectedAnswer: item.expectedAnswer,
    acceptedPatterns: item.acceptedPatterns,
  }));

  return {
    facts,
    factMessages,
    fillerTurns,
    fillerMessages,
    questions,
    messages: [...factMessages, ...fillerMessages],
  };
}
