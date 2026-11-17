#!/usr/bin/env node
/**
 * Context-budget replay & acceptance CLI (Spec 021, T058 / T060 / T064).
 * Uses only Node.js >= 20 built-ins. Never prints keys, tokens, or auth headers.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MESSAGE_OVERHEAD_TOKENS = 4;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function printHelp() {
  console.log(`Usage: node scripts/context-budget-replay.mjs [options]

Options:
  --key <client-key>       Client key (sk-cp-...) or FREELLM_KEY env var
  --base-url <url>         Gateway base URL (default: http://localhost:3001)
  --turns <n>              Number of turns for rolling replay (default: 300)
  --conversation <id>      X-Conversation-Id value (default: qs-budget / qs-recall)
  --scenario <name>        Run named scenario: fact-recall
  --client-history <n>     Send stateless request with <n> client-side messages
  --mock                   Start local mock upstream(s); when --key is omitted,
                           boots an in-memory gateway from server/dist/
  --lang <en|vi|zh>        Synthetic language for --turns replay (default: en)
  --budget <tokens>        Profile maxInputTokens in self-hosted --mock mode
  --mode <mode>            clientHistoryMode: passthrough | trim_on_overflow |
                           enforce_budget | all (default: all in --mock)
  --calibration-check      Evaluate EN/VI/ZH token error across 2 mock providers
  -h, --help               Show this help text`);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      key: { type: 'string' },
      'base-url': { type: 'string', default: 'http://localhost:3001' },
      turns: { type: 'string', default: '300' },
      conversation: { type: 'string' },
      scenario: { type: 'string' },
      'client-history': { type: 'string' },
      mock: { type: 'boolean', default: false },
      lang: { type: 'string', default: 'en' },
      budget: { type: 'string' },
      mode: { type: 'string' },
      'calibration-check': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const turns = Number.parseInt(values.turns, 10);
  if (!Number.isInteger(turns) || turns <= 0) {
    throw new Error('--turns must be a positive integer.');
  }

  const clientHistoryCount =
    values['client-history'] !== undefined ? Number.parseInt(values['client-history'], 10) : null;
  if (
    clientHistoryCount !== null &&
    (!Number.isInteger(clientHistoryCount) || clientHistoryCount < 3)
  ) {
    throw new Error('--client-history must be an integer >= 3.');
  }

  const budgetOverride =
    values.budget !== undefined ? Number.parseInt(values.budget, 10) : null;
  if (
    budgetOverride !== null &&
    (!Number.isInteger(budgetOverride) || budgetOverride < 2000)
  ) {
    throw new Error('--budget must be an integer >= 2000.');
  }

  const lang = values.lang;
  if (lang !== 'en' && lang !== 'vi' && lang !== 'zh') {
    throw new Error('--lang must be one of: en, vi, zh.');
  }

  const key = values.key ?? process.env.FREELLM_KEY ?? null;
  if (!values.mock && !key) {
    throw new Error('Provide --key <client-key> (or FREELLM_KEY), or pass --mock for self-hosted verification.');
  }

  return {
    key,
    baseUrl: values['base-url'].replace(/\/+$/, ''),
    turns,
    conversation:
      values.conversation ?? (values.scenario === 'fact-recall' ? 'qs-recall' : 'qs-budget'),
    scenario: values.scenario ?? null,
    clientHistoryCount,
    mock: Boolean(values.mock),
    lang,
    budgetOverride,
    mode: values.mode ?? null,
    calibrationCheck: Boolean(values['calibration-check']),
  };
}

// Script-weighted token estimator matching server/src/custom/context-budget/estimate.ts
function isAccentedLatin(cp) {
  return (
    (cp >= 0x00c0 && cp <= 0x024f) ||
    (cp >= 0x1e00 && cp <= 0x1eff) ||
    (cp >= 0x0300 && cp <= 0x036f)
  );
}

function isCjkOrKanaOrHangul(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x3000 && cp <= 0x30ff) ||
    (cp >= 0x3130 && cp <= 0x318f) ||
    (cp >= 0x31f0 && cp <= 0x31ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  );
}

function estimateTextTokens(text) {
  if (!text) return 0;
  let weightedSum = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    i += cp > 0xffff ? 2 : 1;
    if (cp <= 0x7f) weightedSum += 15;
    else if (isAccentedLatin(cp)) weightedSum += 24;
    else if (isCjkOrKanaOrHangul(cp)) weightedSum += 60;
    else weightedSum += 20;
  }
  return weightedSum === 0 ? 0 : Math.floor((weightedSum + 59) / 60);
}

function contentToString(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function estimateMessageTokens(msg) {
  const textTokens = estimateTextTokens(contentToString(msg.content));
  let toolTokens = 0;
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      toolTokens += estimateTextTokens(`${tc.function?.name ?? ''}${tc.function?.arguments ?? ''}`);
    }
  }
  return MESSAGE_OVERHEAD_TOKENS + textTokens + toolTokens;
}

function estimateMessagesTokens(messages) {
  let sum = 0;
  for (const m of messages) sum += estimateMessageTokens(m);
  return sum;
}

function parseContextHeader(raw) {
  if (!raw) return null;
  const out = {};
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq).trim();
      const v = part.slice(eq + 1).trim();
      out[k] = v === 'unknown' ? null : Number.isFinite(Number(v)) ? Number(v) : v;
    }
  }
  return out;
}

function buildSyntheticUserPrompt(turnIndex, lang) {
  const code = `REQ-${1000 + turnIndex}`;
  if (lang === 'vi') {
    return (
      `Lượt ${turnIndex + 1} (${code}): Hãy rà soát chi tiết độ trễ định tuyến dự phòng, ` +
      `tỷ lệ giữ bộ nhớ đệm qua nhiều lượt hội thoại hỗ trợ, ngưỡng phân bổ token cho tri thức, ` +
      `và quy tắc bỏ lịch sử theo khối cố định để đảm bảo ổn định ngân sách trên mẫu số ${turnIndex + 1}.`
    );
  }
  if (lang === 'zh') {
    return (
      `第${turnIndex + 1}轮（${code}）：请核查多区域故障转移路由延迟、长对话提示词缓存稳定性、` +
      `按固定轮次块淘汰历史消息的边界对齐策略、知识检索令牌预算分配以及第${turnIndex + 1}批样本的整体运行指标。`
    );
  }
  return (
    `Turn ${turnIndex + 1} (${code}): Please inspect gateway budget telemetry, prompt cache stability ` +
    `across multi-turn sessions, block eviction boundaries, token reservation margins, and regional ` +
    `fallback readiness metrics for verification batch item ${turnIndex + 1}.`
  );
}

function buildDeterministicMockReply(messages) {
  const last = messages.at(-1);
  const lastText = contentToString(last?.content);
  const codeMatch = lastText.match(/(?:REQ-\d+|Lượt \d+|第\d+轮)/);
  const tag = codeMatch ? codeMatch[0] : 'turn';
  return (
    `Acknowledged ${tag}: checked rolling context telemetry, block alignment stability, ` +
    `fallback routing headroom, and token reservation margins with all active baseline thresholds satisfied.`
  );
}

const FACT_SPECS = [
  { user: 'Please note for our records that the primary account holder is Dr. Elena Vance.', q: 'What is the full name of the primary account holder?', accepted: ['elena vance'] },
  { user: 'My hardware replacement order code is ORD-7492-XK; keep it handy for follow-up.', q: 'What is the hardware replacement order code?', accepted: ['ord-7492-xk'] },
  { user: 'Our annual compliance audit is scheduled for 2026-08-19.', q: 'On what date is the annual compliance audit scheduled?', accepted: ['2026-08-19', 'august 19, 2026', '19 august 2026'] },
  { user: 'Finance approved a reimbursement cap of 48250 USD for this migration.', q: 'What is the approved reimbursement cap in USD?', accepted: ['48250', '48,250'] },
  { user: 'For any escalation, the on-call security liaison is Marcus Chen.', q: 'Who is the on-call security liaison?', accepted: ['marcus chen'] },
  { user: 'The enterprise license renewal reference is LIC-9031-QM.', q: 'What is the enterprise license renewal reference?', accepted: ['lic-9031-qm'] },
  { user: 'The data center cutover window starts on 2026-10-04 at midnight UTC.', q: 'What date does the data center cutover window start?', accepted: ['2026-10-04', 'october 4, 2026', '4 october 2026'] },
  { user: 'Production cluster currently runs exactly 37 active nodes.', q: 'How many active nodes are running in the production cluster?', accepted: ['37'] },
  { user: 'We signed Northwind Logistics as the regional partner vendor for freight.', q: 'Which company is the regional partner vendor for freight?', accepted: ['northwind logistics'] },
  { user: 'Please track customs clearance under tracking number TRK-5580-BV.', q: 'What is the customs clearance tracking number?', accepted: ['trk-5580-bv'] },
  { user: 'All legacy API keys must be rotated before the deadline on 2026-12-15.', q: 'What is the deadline date for rotating legacy API keys?', accepted: ['2026-12-15', 'december 15, 2026', '15 december 2026'] },
  { user: 'The reserved disaster recovery gateway listens on port 8443.', q: 'Which port is reserved for the disaster recovery gateway?', accepted: ['8443'] },
  { user: 'Priya Nair is the lead database architect overseeing the schema migration.', q: 'Who is the lead database architect overseeing the schema migration?', accepted: ['priya nair'] },
  { user: 'Pending billing reconciliation covers invoice batch INV-3194-ZD.', q: 'What is the invoice batch identifier for the pending billing reconciliation?', accepted: ['inv-3194-zd'] },
  { user: 'Mark the vendor contract renewal date as 2027-01-22.', q: 'When is the vendor contract renewal date?', accepted: ['2027-01-22', 'january 22, 2027', '22 january 2027'] },
  { user: 'Our contractual uptime SLA target for tier-1 tenants is 99.95%.', q: 'What is the contractual uptime SLA target percentage?', accepted: ['99.95'] },
  { user: 'Encrypted snapshots are archived in the bucket named vault-eu-west-9.', q: 'What is the name of the backup storage bucket?', accepted: ['vault-eu-west-9'] },
  { user: 'Keep warranty claim ticket ID CLM-6208-RT open until the replacement arrives.', q: 'What is the open warranty claim ticket ID?', accepted: ['clm-6208-rt'] },
  { user: 'The quarterly disaster recovery drill is scheduled for 2026-09-11.', q: 'What date is set for the quarterly disaster recovery drill?', accepted: ['2026-09-11', 'september 11, 2026', '11 september 2026'] },
  { user: 'Compliance requires maximum webhook payload retention of 14 days.', q: 'How many days is the maximum webhook payload retention?', accepted: ['14'] },
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
];

const STOP_WORDS = new Set([
  'what', 'is', 'the', 'of', 'in', 'on', 'for', 'which', 'who', 'when', 'how', 'many',
  'are', 'does', 'to', 'a', 'an', 'our', 'your', 'this', 'that', 'with', 'as', 'from',
]);

function summarizeFromPrompt(userPromptText) {
  const kept = new Set();
  const prevMatch = userPromptText.match(/Summary so far:\n([\s\S]*?)\n\nNewer part of the chat:/);
  if (prevMatch) {
    for (const line of prevMatch[1].split('\n')) {
      const trimmed = line.trim();
      if (trimmed) kept.add(trimmed);
    }
  }
  const newerIdx = userPromptText.indexOf('Newer part of the chat:\n');
  const newerSection = newerIdx >= 0 ? userPromptText.slice(newerIdx) : userPromptText;
  for (const line of newerSection.split('\n')) {
    if (!line.startsWith('User: ')) continue;
    const text = line.slice(6).trim();
    if (!text || text.startsWith('Filler discussion #')) continue;
    kept.add(`- ${text}`);
  }
  if (kept.size === 0) {
    return '- Routine maintenance and style checklist review completed.';
  }
  return Array.from(kept).join('\n');
}

function answerQuestionFromContext(messages) {
  const question = contentToString(messages.at(-1)?.content);
  const qWords = (question.toLowerCase().match(/[a-z0-9-]+/g) ?? []).filter(
    (w) => w.length > 2 && !STOP_WORDS.has(w),
  );
  let bestLine = '';
  let bestScore = 0;

  for (let i = 0; i < messages.length - 1; i++) {
    const text = contentToString(messages[i]?.content);
    if (!text) continue;
    for (const line of text.split('\n')) {
      const l = line.toLowerCase();
      if (l.startsWith('summary of the earlier part')) continue;
      let score = 0;
      for (const word of qWords) {
        if (l.includes(word)) score += 1;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLine = line.replace(/^- /, '').trim();
      }
    }
  }
  return bestScore > 0 ? bestLine : 'Not found in provided context.';
}

function assertToolPairsIntact(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const next = messages[i + 1];
      if (!next || next.role !== 'tool') {
        return `assistant.tool_calls at index ${i} was separated from its tool result`;
      }
    }
    if (m.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      const caller = j >= 0 ? messages[j] : null;
      if (!caller || caller.role !== 'assistant' || !Array.isArray(caller.tool_calls) || caller.tool_calls.length === 0) {
        return `orphan tool message at index ${i}`;
      }
    }
  }
  return null;
}

async function startMockUpstream({ usageMultiplier = 1.0 } = {}) {
  const recordedRequests = [];
  let inFlightSummaries = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const isSummaryCall = messages.some(
        (m) => typeof m.content === 'string' && m.content.includes('running summary'),
      );

      let reply;
      if (isSummaryCall) {
        inFlightSummaries += 1;
        reply = summarizeFromPrompt(contentToString(messages.at(-1)?.content));
      } else {
        recordedRequests.push({ model: body.model, messages });
        const lastText = contentToString(messages.at(-1)?.content);
        if (lastText.includes('?')) {
          reply = answerQuestionFromContext(messages);
        } else {
          reply = buildDeterministicMockReply(messages);
        }
      }

      const rawPromptTokens = estimateMessagesTokens(messages);
      const jitter = ((recordedRequests.length % 3) - 1) * 0.015;
      const promptTokens = Math.max(1, Math.round(rawPromptTokens * usageMultiplier * (1 + jitter)));
      const completionTokens = Math.max(4, estimateTextTokens(reply));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `mock_${recordedRequests.length}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: reply },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        }),
      );
      if (isSummaryCall) {
        inFlightSummaries = Math.max(0, inFlightSummaries - 1);
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    recordedRequests,
    getInFlightSummaries: () => inFlightSummaries,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function importDist(relPath) {
  const fullPath = path.join(REPO_ROOT, 'server', 'dist', relPath);
  return import(pathToFileURL(fullPath).href);
}

async function bootMockGateway(options) {
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
  process.env.FREEAPI_TURSO_BATCH_WRITES = '1';
  process.env.PROXY_RATE_LIMIT_RPM = '0';
  process.env.HTTPS_PROXY = '';
  process.env.HTTP_PROXY = '';
  process.env.ALL_PROXY = '';

  const [
    appMod,
    dbMod,
    tursoMod,
    cryptoMod,
    authMod,
    keyCacheMod,
    listingMod,
    routerMod,
    policyMod,
    estMod,
  ] = await Promise.all([
    importDist('app.js'),
    importDist('db/index.js'),
    importDist('db/turso.js'),
    importDist('lib/crypto.js'),
    importDist('services/auth.js'),
    importDist('services/key-cache.js'),
    importDist('services/model-listing.js'),
    importDist('services/router.js'),
    importDist('custom/context-budget/policy.js'),
    importDist('custom/context-budget/estimate.js'),
  ]);

  estMod.resetCalibration();
  policyMod.clearContextPolicyCache();
  keyCacheMod.setKeyCacheTestOverride(true);

  dbMod.initDb(':memory:', {
    factory: () => tursoMod.wrapTursoDatabase(dbMod.defaultDbFactory()(':memory:'), true),
  });
  const db = dbMod.getDb();

  db.prepare('UPDATE models SET enabled = 0').run();
  db.prepare('UPDATE fallback_config SET enabled = 0').run();
  db.prepare('UPDATE profile_models SET enabled = 0').run();

  const modelsToRegister = [];
  if (options.calibrationCheck) {
    const encGroq = cryptoMod.encrypt('gsk_replay_groq');
    const encCer = cryptoMod.encrypt('csk_replay_cerebras');
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('groq', 'replay-groq', ?, ?, ?, 'healthy', 1)`,
    ).run(encGroq.encrypted, encGroq.iv, encGroq.authTag);
    db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
       VALUES ('cerebras', 'replay-cerebras', ?, ?, ?, 'healthy', 1)`,
    ).run(encCer.encrypted, encCer.iv, encCer.authTag);

    db.prepare("UPDATE models SET rpm_limit = NULL, rpd_limit = NULL, tpm_limit = NULL WHERE platform IN ('groq', 'cerebras')").run();
    const rGroq = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, context_window, enabled, source)
       VALUES ('groq', 'replay-groq-128k', 'Replay Groq 128k', 1, 1, 1, 0, 131072, 1, 'seed')`,
    ).run();
    const rCer = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, context_window, enabled, source)
       VALUES ('cerebras', 'replay-cerebras-16k', 'Replay Cerebras 16k', 2, 2, 1, 0, 16384, 1, 'seed')`,
    ).run();
    modelsToRegister.push(Number(rGroq.lastInsertRowid), Number(rCer.lastInsertRowid));
  } else {
    const encCustom = cryptoMod.encrypt('mock-upstream-credential');
    const keyRes = db.prepare(
      `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
       VALUES ('custom', 'mock-replay', ?, ?, ?, 'healthy', 1, ?)`,
    ).run(encCustom.encrypted, encCustom.iv, encCustom.authTag, options.upstreamBaseUrl);
    const keyId = Number(keyRes.lastInsertRowid);

    const largeRes = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, context_window, enabled, source, key_id)
       VALUES ('custom', 'mock-replay-128k', 'Mock Replay 128k', 1, 1, 1, 0, 131072, 1, 'custom', ?)`,
    ).run(keyId);
    const smallRes = db.prepare(
      `INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, supports_tools, supports_vision, context_window, enabled, source, key_id)
       VALUES ('custom', 'mock-replay-8k', 'Mock Replay 8k', 2, 2, 1, 0, 8192, 1, 'custom', ?)`,
    ).run(keyId);
    modelsToRegister.push(Number(largeRes.lastInsertRowid), Number(smallRes.lastInsertRowid));
  }

  const profiles = db.prepare('SELECT id FROM profiles').all();
  modelsToRegister.forEach((modelDbId, idx) => {
    const enabled = 1;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, ?)').run(
      modelDbId,
      idx + 1,
      enabled,
    );
    for (const p of profiles) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)').run(
        p.id,
        modelDbId,
        idx + 1,
        enabled,
      );
    }
  });

  routerMod.setRoutingStrategy('priority');
  listingMod.invalidateModelListingCache();

  const server = appMod.createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const gatewayBaseUrl = `http://127.0.0.1:${server.address().port}`;

  const owner = authMod.createUser('replay-admin@example.com', 'ReplayPass123!');
  const sessionToken = authMod.createSession(owner.userId);

  const createProfileRes = await fetch(`${gatewayBaseUrl}/api/client-profiles`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      name: 'replay-profile',
      systemPrompt: 'You are a precise diagnostic assistant.',
    }),
  });
  const createdProfile = await createProfileRes.json();
  const profileId = createdProfile.id;
  const profileKey = createdProfile.key;

  await fetch(`${gatewayBaseUrl}/api/client-profiles/${profileId}/quota`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({ rpmLimit: null }),
  });

  await fetch(`${gatewayBaseUrl}/api/client-profiles/${profileId}/conversation-settings`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
    },
    body: JSON.stringify({
      enabled: true,
      ttlHours: 168,
      maxMessages: 100,
      maxChars: 100000,
      summarize: options.summarize,
    }),
  });

  policyMod.saveContextPolicy(profileId, {
    enabled: true,
    preset: 'custom',
    maxInputTokens: options.budget,
    outputReserveTokens: 1024,
    safetyMarginPct: 10,
    summarySharePct: 15,
    knowledgeSharePct: 25,
    dropBlockTurns: 4,
    summarize: options.summarize,
    clientHistoryMode: options.clientHistoryMode ?? 'passthrough',
  });

  const setAllowedModels = async (allowedModels) => {
    await fetch(`${gatewayBaseUrl}/api/client-profiles/${profileId}/restrictions`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ allowedModels }),
    });
  };

  return {
    gatewayBaseUrl,
    sessionToken,
    profileId,
    profileKey,
    savePolicy: (input) => policyMod.saveContextPolicy(profileId, input),
    setAllowedModels,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      keyCacheMod.setKeyCacheTestOverride(null);
    },
  };
}

async function sendChatCompletion({ baseUrl, key, model = 'auto', conversationId, messages }) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    ...(conversationId ? { 'x-conversation-id': conversationId } : {}),
  };
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { rawStatus: res.status };
  }
  if (!res.ok) {
    const code = body?.error?.code ?? `http_${res.status}`;
    const msg = body?.error?.message ?? `Request failed with status ${res.status}`;
    throw new Error(`HTTP ${res.status} (${code}): ${msg}`);
  }
  const reply = contentToString(body?.choices?.[0]?.message?.content);
  const ctx = parseContextHeader(res.headers.get('x-freellm-context'));
  const convHist = res.headers.get('x-conversation-history');
  return { status: res.status, reply, ctx, convHist };
}

function shouldPrintTurn(idx, total, prevDropped, curDropped) {
  if (total <= 30) return true;
  if (idx < 5 || idx >= total - 3) return true;
  if (curDropped !== prevDropped) return true;
  return (idx + 1) % 25 === 0;
}

async function runTurnsReplay(ctx, opts) {
  console.log(
    `\n=== Rolling Replay (${opts.turns} turns, lang=${opts.lang}, conv=${opts.conversation}) ===`,
  );
  console.log('Turn | Budget | SentTok | Mand | Summ | KB | Hist | Sent | Drop | Window');

  const rows = [];
  let priorHistoryTokens = 0;
  let prevDropped = -1;
  let allWithinBudget = true;

  for (let i = 0; i < opts.turns; i++) {
    const userPrompt = buildSyntheticUserPrompt(i, opts.lang);
    const resp = await sendChatCompletion({
      baseUrl: ctx.baseUrl,
      key: ctx.key,
      conversationId: opts.conversation,
      messages: [
        { role: 'system', content: 'Follow instructions strictly.' },
        { role: 'user', content: userPrompt },
      ],
    });
    if (!resp.ctx) {
      throw new Error(`Turn ${i + 1}: missing X-FreeLLM-Context header (is context policy enabled?).`);
    }

    const h = resp.ctx;
    const sentTokens = h.mandatory + h.summary + h.knowledge + h.history;
    if (sentTokens > h.budget) allWithinBudget = false;

    const fullHypotheticalTokens = h.mandatory + h.knowledge + priorHistoryTokens;
    rows.push({
      turn: i + 1,
      budget: h.budget,
      sentTokens,
      fullHypotheticalTokens,
      histDropped: h.hist_dropped,
      histSent: h.hist_sent,
    });

    if (shouldPrintTurn(i, opts.turns, prevDropped, h.hist_dropped)) {
      console.log(
        `${String(i + 1).padStart(4)} | ${String(h.budget).padStart(6)} | ${String(sentTokens).padStart(7)} | ` +
          `${String(h.mandatory).padStart(4)} | ${String(h.summary).padStart(4)} | ${String(h.knowledge).padStart(2)} | ` +
          `${String(h.history).padStart(4)} | ${String(h.hist_sent).padStart(4)} | ${String(h.hist_dropped).padStart(4)} | ${h.window ?? 'unknown'}`,
      );
    }
    prevDropped = h.hist_dropped;

    priorHistoryTokens +=
      estimateMessageTokens({ role: 'user', content: userPrompt }) +
      estimateMessageTokens({ role: 'assistant', content: resp.reply });
  }

  let steadyMaxDeviationPct = 0;
  let steadyMean = 0;
  let steadyOk = true;
  if (rows.length >= 50) {
    const slice = rows.slice(49);
    steadyMean = slice.reduce((acc, r) => acc + r.sentTokens, 0) / slice.length;
    for (const r of slice) {
      const devPct = (Math.abs(r.sentTokens - steadyMean) / steadyMean) * 100;
      if (devPct > steadyMaxDeviationPct) steadyMaxDeviationPct = devPct;
    }
    steadyOk = steadyMaxDeviationPct <= 10;
  }

  let savingsRate = 0;
  let savingsOk = true;
  if (rows.length >= 51) {
    const slice51 = rows.slice(50);
    const totalSent51 = slice51.reduce((acc, r) => acc + r.sentTokens, 0);
    const totalFull51 = slice51.reduce((acc, r) => acc + r.fullHypotheticalTokens, 0);
    savingsRate = totalFull51 > 0 ? 1 - totalSent51 / totalFull51 : 0;
    savingsOk = savingsRate >= 0.6;
  }

  console.log('\n--- Replay Summary ---');
  console.log(`SC-001/SC-002a Within budget (all ${rows.length} turns): ${allWithinBudget ? 'PASS' : 'FAIL'}`);
  if (rows.length >= 50) {
    console.log(
      `SC-002b Steady state (turn 50..${rows.length}): mean=${steadyMean.toFixed(1)} tok, maxDeviation=${steadyMaxDeviationPct.toFixed(2)}% (target <= 10%): ${steadyOk ? 'PASS' : 'FAIL'}`,
    );
  }
  if (rows.length >= 51) {
    console.log(
      `SC-003 Savings from turn 51..${rows.length}: ${(savingsRate * 100).toFixed(2)}% (target >= 60%): ${savingsOk ? 'PASS' : 'FAIL'}`,
    );
  }

  if (!allWithinBudget || !steadyOk || !savingsOk) {
    process.exitCode = 1;
  }
}

async function runFactRecallReplay(ctx, opts) {
  console.log(`\n=== Fact-Recall Scenario (20 facts + 120 filler + 20 questions, conv=${opts.conversation}) ===`);
  let prevDropped = 0;

  for (let i = 0; i < FACT_SPECS.length; i++) {
    const resp = await sendChatCompletion({
      baseUrl: ctx.baseUrl,
      key: ctx.key,
      conversationId: opts.conversation,
      messages: [
        { role: 'system', content: 'Remember user facts accurately.' },
        { role: 'user', content: FACT_SPECS[i].user },
      ],
    });
    const dropped = resp.ctx?.hist_dropped ?? 0;
    if (dropped > prevDropped) {
      await new Promise((r) => setTimeout(r, 35));
      prevDropped = dropped;
    }
  }

  for (let i = 0; i < 120; i++) {
    const subject = FILLER_SUBJECTS[i % FILLER_SUBJECTS.length];
    const msg = `Filler discussion #${i + 1}: Review checklist guidelines for ${subject} during routine operations.`;
    const resp = await sendChatCompletion({
      baseUrl: ctx.baseUrl,
      key: ctx.key,
      conversationId: opts.conversation,
      messages: [
        { role: 'system', content: 'Remember user facts accurately.' },
        { role: 'user', content: msg },
      ],
    });
    const dropped = resp.ctx?.hist_dropped ?? 0;
    if (dropped > prevDropped || i % 10 === 9) {
      await new Promise((r) => setTimeout(r, 40));
      prevDropped = dropped;
    }
  }

  // Wait for final asynchronous background summary call to complete before recall queries.
  await new Promise((r) => setTimeout(r, 350));

  let correct = 0;
  for (let i = 0; i < FACT_SPECS.length; i++) {
    const spec = FACT_SPECS[i];
    const resp = await sendChatCompletion({
      baseUrl: ctx.baseUrl,
      key: ctx.key,
      conversationId: opts.conversation,
      messages: [
        { role: 'system', content: 'Answer using only the provided conversation summary or history.' },
        { role: 'user', content: spec.q },
      ],
    });
    const lower = resp.reply.toLowerCase();
    const hit = spec.accepted.some((pat) => lower.includes(pat));
    if (hit) correct += 1;
    console.log(
      `Q${String(i + 1).padStart(2)} [${hit ? 'OK  ' : 'MISS'}]: summary=${resp.ctx?.summary ?? 0} tok | hist=${resp.ctx?.hist_sent ?? 0} | reply="${resp.reply.slice(0, 72)}"`,
    );
  }

  const pass = correct >= 18;
  console.log(`\nSC-004 Fact recall score: ${correct}/20 (${((correct / 20) * 100).toFixed(1)}%, target >= 90%): ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) process.exitCode = 1;
}

function buildClientHistoryMessages(totalCount) {
  const messages = [{ role: 'system', content: 'You are a stateful client helper.' }];
  const pairsTarget = Math.max(1, Math.floor((totalCount - 2) / 2));
  const midToolTurn = Math.floor(pairsTarget / 2);
  const pad = 'client history diagnostic context record '.repeat(3);

  for (let i = 0; i < pairsTarget; i++) {
    messages.push({ role: 'user', content: `Client turn ${i + 1}: ${pad}` });
    if (i === midToolTurn || i === pairsTarget - 2) {
      const callId = `call_replay_${i}`;
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name: 'inspect_state', arguments: JSON.stringify({ turn: i + 1 }) },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: callId,
        content: JSON.stringify({ status: 'ok', turn: i + 1, detail: pad }),
      });
    } else {
      messages.push({ role: 'assistant', content: `Client reply ${i + 1}: ${pad}` });
    }
  }
  messages.push({ role: 'user', content: 'Summarize current client state.' });
  return messages;
}

async function runClientHistoryReplay(ctx, opts, mockControls) {
  const messages = buildClientHistoryMessages(opts.clientHistoryCount);
  const modes =
    mockControls && (!opts.mode || opts.mode === 'all')
      ? ['passthrough', 'trim_on_overflow', 'enforce_budget']
      : [opts.mode ?? 'single'];

  console.log(`\n=== Client-History Replay (${messages.length} client messages) ===`);

  let passed = true;
  for (const mode of modes) {
    let requestModel = 'auto';
    if (mockControls) {
      mockControls.upstream.recordedRequests.length = 0;
      if (mode === 'trim_on_overflow') {
        requestModel = 'mock-replay-8k';
        await mockControls.gateway.setAllowedModels(['mock-replay-8k']);
        mockControls.gateway.savePolicy({
          enabled: true,
          preset: 'custom',
          maxInputTokens: 2500,
          outputReserveTokens: 1024,
          safetyMarginPct: 10,
          summarySharePct: 15,
          knowledgeSharePct: 25,
          dropBlockTurns: 4,
          summarize: false,
          clientHistoryMode: 'trim_on_overflow',
        });
      } else {
        await mockControls.gateway.setAllowedModels([]);
        mockControls.gateway.savePolicy({
          enabled: true,
          preset: 'custom',
          maxInputTokens: opts.budgetOverride ?? 4000,
          outputReserveTokens: 1024,
          safetyMarginPct: 10,
          summarySharePct: 15,
          knowledgeSharePct: 25,
          dropBlockTurns: 4,
          summarize: false,
          clientHistoryMode: mode,
        });
      }
    }

    const resp = await sendChatCompletion({
      baseUrl: ctx.baseUrl,
      key: ctx.key,
      model: requestModel,
      messages,
    });

    const h = resp.ctx ?? {};
    let pairViolation = null;
    if (mockControls) {
      const lastRecorded = mockControls.upstream.recordedRequests.at(-1);
      if (lastRecorded) {
        pairViolation = assertToolPairsIntact(lastRecorded.messages);
      }
    }

    const modeOk =
      !pairViolation &&
      (mode === 'passthrough'
        ? h.client_dropped === 0
        : mode === 'trim_on_overflow' || mode === 'enforce_budget'
          ? (h.client_dropped ?? 0) > 0
          : true);
    if (!modeOk) passed = false;

    console.log(
      `mode=${mode.padEnd(16)} | budget=${h.budget} | window=${h.window} | client_dropped=${h.client_dropped} | ` +
        `toolPairs=${pairViolation ? `FAIL (${pairViolation})` : 'intact'} | ${modeOk ? 'PASS' : 'FAIL'}`,
    );
  }

  if (!passed) process.exitCode = 1;
}

async function runCalibrationCheck(opts) {
  console.log('\n=== Token Estimator Calibration Check (T060, SC-005) ===');
  const realFetch = globalThis.fetch;
  const mockA = await startMockUpstream({ usageMultiplier: 1.08 });
  const mockB = await startMockUpstream({ usageMultiplier: 0.86 });

  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.startsWith('https://api.groq.com/')) {
      const target = `http://127.0.0.1:${mockA.port}/v1/chat/completions`;
      return realFetch(target, init);
    }
    if (s.startsWith('https://api.cerebras.ai/')) {
      const target = `http://127.0.0.1:${mockB.port}/v1/chat/completions`;
      return realFetch(target, init);
    }
    return realFetch(url, init);
  };

  let gateway = null;
  try {
    gateway = await bootMockGateway({
      calibrationCheck: true,
      budget: opts.budgetOverride ?? 16000,
      summarize: false,
      clientHistoryMode: 'passthrough',
    });

    const langs = ['en', 'vi', 'zh'];
    const models = [
      { platform: 'groq', model: 'replay-groq-128k' },
      { platform: 'cerebras', model: 'replay-cerebras-16k' },
    ];

    for (const m of models) {
      for (let i = 0; i < 45; i++) {
        const lang = langs[i % langs.length];
        await sendChatCompletion({
          baseUrl: gateway.gatewayBaseUrl,
          key: gateway.profileKey,
          model: m.model,
          conversationId: `cal-${m.platform}-${lang}`,
          messages: [
            { role: 'system', content: 'Be accurate and concise.' },
            { role: 'user', content: buildSyntheticUserPrompt(i, lang) },
          ],
        });
      }
    }

    await new Promise((r) => setTimeout(r, 120));

    const statsRes = await realFetch(
      `${gateway.gatewayBaseUrl}/api/client-profiles/${gateway.profileId}/context-stats?days=7`,
      {
        headers: { authorization: `Bearer ${gateway.sessionToken}` },
      },
    );
    const stats = await statsRes.json();
    const err = stats.estimateError ?? {};
    const pass =
      (err.samples ?? 0) >= 80 &&
      typeof err.within15PctRate === 'number' &&
      err.within15PctRate >= 0.95;

    console.log(
      `Providers: groq (1.08x BPE mock) & cerebras (0.86x SentencePiece mock) across EN/VI/ZH`,
    );
    console.log(
      `Samples=${err.samples}, p50Pct=${err.p50Pct}%, p95Pct=${err.p95Pct}%, within15PctRate=${err.within15PctRate} (target >= 0.95): ${pass ? 'PASS' : 'FAIL'}`,
    );
    if (!pass) process.exitCode = 1;
  } finally {
    globalThis.fetch = realFetch;
    await gateway?.close();
    await mockA.close();
    await mockB.close();
  }
}

async function main() {
  const opts = parseCliArgs();

  if (opts.calibrationCheck) {
    if (!opts.mock) {
      throw new Error('--calibration-check currently requires --mock (multi-provider local simulation).');
    }
    await runCalibrationCheck(opts);
    return;
  }

  let upstream = null;
  let gateway = null;

  try {
    let targetBaseUrl = opts.baseUrl;
    let clientKey = opts.key;
    let mockControls = null;

    if (opts.mock && !opts.key) {
      upstream = await startMockUpstream({ usageMultiplier: 1.0 });
      const defaultBudget =
        opts.scenario === 'fact-recall' ? 6000 : opts.clientHistoryCount !== null ? 4000 : 4000;
      gateway = await bootMockGateway({
        upstreamBaseUrl: upstream.baseUrl,
        budget: opts.budgetOverride ?? defaultBudget,
        summarize: opts.scenario === 'fact-recall',
        clientHistoryMode:
          opts.mode && opts.mode !== 'all' ? opts.mode : 'passthrough',
      });
      targetBaseUrl = gateway.gatewayBaseUrl;
      clientKey = gateway.profileKey;
      mockControls = { upstream, gateway };
    }

    const ctx = { baseUrl: targetBaseUrl, key: clientKey };

    if (opts.clientHistoryCount !== null) {
      await runClientHistoryReplay(ctx, opts, mockControls);
    } else if (opts.scenario === 'fact-recall') {
      await runFactRecallReplay(ctx, opts);
    } else if (opts.scenario) {
      throw new Error(`Unsupported --scenario "${opts.scenario}". Supported: fact-recall`);
    } else {
      await runTurnsReplay(ctx, opts);
    }
  } finally {
    await gateway?.close();
    await upstream?.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
