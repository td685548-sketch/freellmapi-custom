import { performance } from 'node:perf_hooks';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import {
  AGENT_SCENARIO_LANES,
  DEFAULT_SCENARIO_ROUTING_POLICY,
  INTENT_CATEGORIES,
  SMART_ROUTING_DECISION_MODES,
  type AgentScenarioLane,
  type IntentCategory,
  type IntentClassificationResult,
  type IntentClassifyPreviewRequest,
  type ScenarioRoutingPolicy,
  type SmartRoutingDecisionMode,
  type SmartRoutingPreset,
} from '@freellmapi/shared/smart-routing-v2.js';
import { getDb, getSetting, setSetting } from '../../db/index.js';
import { estimateInputTokens } from '../../lib/content.js';

export const SMART_ROUTING_POLICY_SETTING_KEY = 'x_gateway_smart_routing_v2_policy';
const MAX_CLASSIFY_SCAN_CHARS = 12_000;

export const CODE_KEYWORDS: readonly string[] = [
  // English
  '```',
  'function',
  'class',
  'import',
  'def',
  'select',
  'async',
  'await',
  'const',
  'return',
  'algorithm',
  'compile',
  'debug',
  'refactor',
  'typescript',
  'python',
  'javascript',
  'rust',
  'golang',
  'sql',
  'code',
  'implement',
  'create a component',
  'endpoint',
  'repository',
  'deploy',
  'script',
  'api',
  'database',
  'query',
  'schema',
  'interface',
  'enum',
  'module',
  'package',
  'dependency',
  'stack trace',
  'unit test',
  // Vietnamese (Tiếng Việt)
  'viết hàm',
  'viết code',
  'mã nguồn',
  'lập trình',
  'thuật toán',
  'gỡ lỗi',
  'sửa lỗi code',
  'sửa bug',
  'tái cấu trúc',
  'biên dịch',
  'bất đồng bộ',
  'cơ sở dữ liệu',
  'truy vấn sql',
  'triển khai api',
  'kiểm thử đơn vị',
  'biến môi trường',
  // Português / Español / Français / Deutsch
  'função',
  'código',
  'refatorar',
  'depurar',
  'banco de dados',
  'función',
  'refactorizar',
  'implementar',
  'fonction',
  'algorithme',
  'déboguer',
  'funktion',
  'algorithmus',
  // 中文 / 日本語 / 한국어 / Русский / العربية
  '函数',
  '代码',
  '算法',
  '调试',
  '编译',
  '関数',
  'コード',
  'アルゴリズム',
  '함수',
  '코드',
  '비동기',
  'функция',
  'алгоритм',
  'код',
  'دالة',
  'كود',
  'خوارزمية',
];

export const MATH_KEYWORDS: readonly string[] = [
  // English
  'calculate',
  'solve',
  'equation',
  'formula',
  'integral',
  'derivative',
  'algebra',
  'geometry',
  'arithmetic',
  'polynomial',
  'matrix',
  'vector',
  'statistics',
  'probability',
  'eigenvalue',
  'calculus',
  // Vietnamese (Tiếng Việt)
  'tính toán',
  'giải phương trình',
  'phương trình',
  'hệ phương trình',
  'công thức',
  'tích phân',
  'đạo hàm',
  'đại số',
  'hình học',
  'đa thức',
  'ma trận',
  'xác suất',
  'thống kê',
  'vi phân',
  // Multilingual
  'calcular',
  'equação',
  'ecuación',
  'derivada',
  'probabilidade',
  'probabilidad',
  'berechnen',
  'gleichung',
  'wahrscheinlichkeit',
  '计算',
  '求解',
  '方程',
  '积分',
  '导数',
  '矩阵',
  '概率',
  '計算',
  '方程式',
  '積分',
  '微分',
  '계산',
  '방정식',
  '적분',
  '미분',
  'вычислить',
  'уравнение',
  'интеграл',
  'معادلة',
  'تكامل',
  'مصفوفة',
];

export const REASONING_KEYWORDS: readonly string[] = [
  // English
  'prove',
  'theorem',
  'derive',
  'step by step',
  'chain of thought',
  'formally',
  'mathematical proof',
  'proof',
  'logically',
  'analyze deeply',
  'reasoning',
  'deduce',
  'infer',
  'hypothesis',
  'convergence',
  'counterexample',
  'first principles',
  // Vietnamese (Tiếng Việt)
  'chứng minh',
  'định lý',
  'suy luận',
  'từng bước một',
  'từng bước',
  'chuỗi suy nghĩ',
  'lập luận logic',
  'phân tích chuyên sâu',
  'suy diễn',
  'giả thuyết',
  'hội tụ',
  'phản ví dụ',
  // Multilingual
  'provar',
  'teorema',
  'passo a passo',
  'raciocínio',
  'demostrar',
  'paso a paso',
  'lógicamente',
  'beweisen',
  'schritt für schritt',
  '证明',
  '定理',
  '推导',
  '逐步',
  '思维链',
  '逻辑',
  '証明',
  '論理的',
  '증명',
  '단계별',
  '논리적',
  'доказать',
  'теорема',
  'шаг за шагом',
  'إثبات',
  'نظرية',
  'خطوة بخطوة',
];

export const CREATIVE_KEYWORDS: readonly string[] = [
  // English
  'story',
  'poem',
  'creative',
  'brainstorm',
  'blog post',
  'article',
  'copywrite',
  'marketing copy',
  'narrative',
  'fiction',
  'screenplay',
  'lyrics',
  'essay',
  'haiku',
  // Vietnamese (Tiếng Việt)
  'viết truyện',
  'câu chuyện',
  'bài thơ',
  'làm thơ',
  'sáng tác',
  'sáng tạo',
  'lên ý tưởng',
  'bài viết blog',
  'tiểu thuyết',
  'kịch bản',
  'lời bài hát',
  'bài luận',
  'viết văn',
  // Multilingual
  'história',
  'poema',
  'criativo',
  'roteiro',
  'historia',
  'creativo',
  'guion',
  'ensayo',
  'geschichte',
  'gedicht',
  'drehbuch',
  '故事',
  '诗',
  '创意',
  '头脑风暴',
  '小说',
  '剧本',
  '物語',
  '小説',
  '脚本',
  '이야기',
  '소설',
  '시나리오',
  'стихотворение',
  'сценарий',
  'قصة',
  'قصيدة',
  'رواية',
];

export const SIMPLE_KEYWORDS: readonly string[] = [
  // English
  'what is',
  'define',
  'translate',
  'hello',
  'hi there',
  'yes or no',
  'summarize',
  'list',
  'tell me',
  'who is',
  'capital of',
  // Vietnamese (Tiếng Việt)
  'là gì',
  'định nghĩa',
  'dịch sang',
  'dịch câu',
  'xin chào',
  'chào bạn',
  'có hay không',
  'tóm tắt',
  'liệt kê',
  'ai là',
  'thủ đô của',
  'giải thích ngắn gọn',
  // Multilingual
  'o que é',
  'traduzir',
  'olá',
  'resumir',
  'qué es',
  'traducir',
  'hola',
  'was ist',
  'übersetzen',
  'hallo',
  '什么是',
  '翻译',
  '你好',
  '总结',
  'とは',
  '翻訳',
  'こんにちは',
  '이란',
  '번역',
  '안녕',
  '요약',
  'что такое',
  'перевести',
  'привет',
  'ما هو',
  'ترجمة',
  'مرحبا',
];

export const THINK_SCENARIO_KEYWORDS: readonly string[] = [
  'ultrathink',
  'think hard',
  'think deeply',
  'extended thinking',
  'deep reasoning',
  'chain of thought',
  'suy nghĩ kỹ',
  'suy nghĩ sâu',
  'suy luận sâu',
  'suy luận từng bước',
  'chuỗi suy nghĩ',
  '深度思考',
  '深く考えて',
];

export const WEB_SEARCH_SCENARIO_KEYWORDS: readonly string[] = [
  'search the web',
  'browse the web',
  'look up online',
  'search online',
  'latest news',
  'current news',
  'today news',
  'real-time information',
  'tìm kiếm trên mạng',
  'tìm trên web',
  'tra cứu trực tuyến',
  'tin tức mới nhất',
  'giá hiện tại hôm nay',
  'buscar en internet',
  'pesquisar na web',
  '联网搜索',
  '网上搜索',
  'ウェブ検索',
];

export const BACKGROUND_SCENARIO_KEYWORDS: readonly string[] = [
  'generate a concise title',
  'generate a short title',
  'write a short title',
  'title for this conversation',
  'conversation title',
  '3-5 word title',
  '2-5 word title',
  'generate a commit message',
  'write a commit message',
  'git commit message',
  'conventional commit',
  'is this a new topic',
  'detect if this message starts a new topic',
  'summarize this conversation in 1-2 sentences',
  'extract 3-5 keywords',
  'reply ok',
  'tạo tiêu đề ngắn',
  'đặt tiêu đề ngắn',
  'đặt tiêu đề cho cuộc trò chuyện',
  'tiêu đề cuộc trò chuyện',
  'tiêu đề 3-5 từ',
  'viết commit message',
  'tạo nội dung commit',
  'tóm tắt cuộc trò chuyện trong 1-2 câu',
  'phân loại chủ đề mới',
  'trích xuất từ khóa',
  '生成简短标题',
  '对话标题',
  '生成提交信息',
  '短いタイトルを生成',
  'generar un título breve',
  'gerar um título curto',
];

const WEB_SEARCH_TOOL_NAMES = new Set([
  'web_search',
  'web_search_preview',
  'web_search_20250305',
  'google_search',
  'googlesearch',
  'google_search_retrieval',
  'brave_search',
  'tavily_search',
  'exa_search',
  'serper_search',
  'searxng_search',
]);

interface CompiledCategoryMatchers {
  combinedPattern: RegExp | null;
  substrings: readonly string[];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileCategoryMatchers(keywords: readonly string[]): CompiledCategoryMatchers {
  const regexAlts: string[] = [];
  const substrings: string[] = [];

  for (const keyword of keywords) {
    const normalized = keyword.toLowerCase().trim();
    if (!normalized) continue;
    if (normalized === '```' || !/\p{Script=Latin}/u.test(normalized)) {
      substrings.push(normalized);
      continue;
    }

    const escaped = escapeRegex(normalized);
    // Multi-word phrases or non-ASCII Latin words (Vietnamese, Romance, German diacritics)
    // match exact Unicode token boundaries without English morphological stem expansion.
    if (normalized.includes(' ') || /[^\u0020-\u007e]/.test(normalized)) {
      regexAlts.push(escaped);
      continue;
    }

    const forms = [`${escaped}(?:s|es|ed|ing)?`];
    if (normalized.endsWith('e') && normalized.length > 3) {
      forms.push(`${escapeRegex(normalized.slice(0, -1))}ing`);
    }
    const last = normalized.at(-1) ?? '';
    if (normalized.length >= 3 && /^[b-df-hj-np-tv-z]$/.test(last)) {
      forms.push(`${escaped}${last}(?:ed|ing)`);
    }
    regexAlts.push(forms.length === 1 ? forms[0]! : `(?:${forms.join('|')})`);
  }

  const combinedPattern = regexAlts.length > 0
    ? new RegExp(`(?<![\\p{L}\\p{N}_])(${regexAlts.join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
    : null;

  return {
    combinedPattern,
    substrings,
  };
}

function findMatchedSignals(
  lowerText: string,
  matchers: CompiledCategoryMatchers,
  maxMatches = 2,
): string[] {
  if (!lowerText) return [];
  const hits: string[] = [];

  if (matchers.combinedPattern) {
    const m = matchers.combinedPattern.exec(lowerText);
    if (m?.[1]) {
      hits.push(m[1].toLowerCase());
      if (hits.length >= maxMatches) return hits;
    }
  }

  for (let i = 0; i < matchers.substrings.length; i += 1) {
    const sub = matchers.substrings[i]!;
    if (lowerText.includes(sub)) {
      hits.push(sub);
      if (hits.length >= maxMatches) break;
    }
  }
  return hits;
}

const CODE_MATCHERS = compileCategoryMatchers(CODE_KEYWORDS);
const MATH_MATCHERS = compileCategoryMatchers(MATH_KEYWORDS);
const REASONING_MATCHERS = compileCategoryMatchers(REASONING_KEYWORDS);
const CREATIVE_MATCHERS = compileCategoryMatchers(CREATIVE_KEYWORDS);
const SIMPLE_MATCHERS = compileCategoryMatchers(SIMPLE_KEYWORDS);
const THINK_SCENARIO_MATCHERS = compileCategoryMatchers(THINK_SCENARIO_KEYWORDS);
const WEB_SEARCH_SCENARIO_MATCHERS = compileCategoryMatchers(WEB_SEARCH_SCENARIO_KEYWORDS);
const BACKGROUND_SCENARIO_MATCHERS = compileCategoryMatchers(BACKGROUND_SCENARIO_KEYWORDS);

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
    } else if (part && typeof part === 'object') {
      const rec = part as Record<string, unknown>;
      if (typeof rec.text === 'string') parts.push(rec.text);
    }
  }
  return parts.join('\n');
}

export function detectMessagesHaveVision(messages: readonly ChatMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      const rec = block as Record<string, unknown>;
      const t = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
      if (t === 'image_url' || t === 'image' || t === 'input_image' || rec.image_url) {
        return true;
      }
      if (rec.inlineData && typeof rec.inlineData === 'object') {
        const mime = (rec.inlineData as Record<string, unknown>).mimeType;
        if (typeof mime === 'string' && mime.toLowerCase().startsWith('image/')) return true;
      }
    }
  }
  return false;
}

export function detectToolsHaveWebSearch(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const rec = tool as Record<string, unknown>;
    const rawType = typeof rec.type === 'string' ? rec.type.toLowerCase() : '';
    if (WEB_SEARCH_TOOL_NAMES.has(rawType) || rawType.startsWith('web_search')) return true;
    const rawName = typeof rec.name === 'string' ? rec.name.toLowerCase() : '';
    if (WEB_SEARCH_TOOL_NAMES.has(rawName)) return true;
    if (rec.function && typeof rec.function === 'object') {
      const fnName = (rec.function as Record<string, unknown>).name;
      if (typeof fnName === 'string' && WEB_SEARCH_TOOL_NAMES.has(fnName.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

export function classifyPromptIntent(
  prompt: string,
  systemPrompt?: string,
  simpleMaxWords = 60,
): { intent: IntentCategory; confidence: number; signals: string[] } {
  const boundedSystem = (systemPrompt ?? '').slice(0, 2_000);
  const boundedPrompt = prompt.slice(0, MAX_CLASSIFY_SCAN_CHARS);
  const fullLower = `${boundedSystem} ${boundedPrompt}`.toLowerCase();
  const promptLower = boundedPrompt.toLowerCase();
  const trimmedPrompt = boundedPrompt.trim();
  const wordCount = trimmedPrompt ? trimmedPrompt.split(/\s+/).length : 0;

  // Classify primarily on user prompt first so a generic coding system prompt does not
  // misclassify a pure math/simple/creative user request, then fall back to full context.
  const codeHits = findMatchedSignals(promptLower, CODE_MATCHERS);
  if (codeHits.length > 0) {
    return {
      intent: 'code',
      confidence: Math.min(0.98, 0.78 + codeHits.length * 0.06),
      signals: codeHits.map(s => `intent:code:${s}`),
    };
  }

  const mathHits = findMatchedSignals(promptLower, MATH_MATCHERS);
  if (mathHits.length > 0) {
    return {
      intent: 'math',
      confidence: Math.min(0.97, 0.76 + mathHits.length * 0.06),
      signals: mathHits.map(s => `intent:math:${s}`),
    };
  }

  const reasoningHits = findMatchedSignals(promptLower, REASONING_MATCHERS);
  if (reasoningHits.length > 0) {
    return {
      intent: 'reasoning',
      confidence: Math.min(0.96, 0.75 + reasoningHits.length * 0.06),
      signals: reasoningHits.map(s => `intent:reasoning:${s}`),
    };
  }

  const creativeHits = findMatchedSignals(promptLower, CREATIVE_MATCHERS);
  if (creativeHits.length > 0) {
    return {
      intent: 'creative',
      confidence: Math.min(0.94, 0.72 + creativeHits.length * 0.06),
      signals: creativeHits.map(s => `intent:creative:${s}`),
    };
  }

  if (wordCount > 0 && wordCount < simpleMaxWords) {
    const simpleHits = findMatchedSignals(promptLower, SIMPLE_MATCHERS);
    if (simpleHits.length > 0) {
      return {
        intent: 'simple',
        confidence: Math.min(0.95, 0.8 + simpleHits.length * 0.05),
        signals: simpleHits.map(s => `intent:simple:${s}`),
      };
    }
    if (wordCount <= 4) {
      return {
        intent: 'simple',
        confidence: 0.7,
        signals: ['intent:simple:short_utterance'],
      };
    }
  }

  // Secondary check including system prompt if user prompt was ambiguous
  if (boundedSystem) {
    const sysCode = findMatchedSignals(fullLower, CODE_MATCHERS, 2);
    if (sysCode.length > 0) {
      return { intent: 'code', confidence: 0.7, signals: sysCode.map(s => `sys:code:${s}`) };
    }
    const sysMath = findMatchedSignals(fullLower, MATH_MATCHERS, 2);
    if (sysMath.length > 0) {
      return { intent: 'math', confidence: 0.7, signals: sysMath.map(s => `sys:math:${s}`) };
    }
    const sysReason = findMatchedSignals(fullLower, REASONING_MATCHERS, 2);
    if (sysReason.length > 0) {
      return { intent: 'reasoning', confidence: 0.7, signals: sysReason.map(s => `sys:reasoning:${s}`) };
    }
  }

  return {
    intent: 'medium',
    confidence: 0.6,
    signals: ['intent:medium:default'],
  };
}

export function recommendPresetForClassification(
  intent: IntentCategory,
  scenario: AgentScenarioLane,
  hasStructuredOutput = false,
): SmartRoutingPreset {
  if (scenario === 'background') return 'fastest';
  if (scenario === 'longContext' || hasStructuredOutput) return 'reliable';
  if (scenario === 'think' || intent === 'reasoning' || intent === 'math' || intent === 'code') {
    return 'smartest';
  }
  if (intent === 'simple') return 'fastest';
  return 'balanced';
}

export function resolvePolicyTargetForClassification(
  intent: IntentCategory,
  scenario: AgentScenarioLane,
  policy: ScenarioRoutingPolicy,
): string | null {
  const laneTarget = policy.lanes[scenario]?.trim();
  if (laneTarget) return laneTarget;
  const intentTarget = policy.intentTargets[intent]?.trim();
  if (intentTarget) return intentTarget;
  if (scenario !== 'default') {
    const defaultTarget = policy.lanes.default?.trim();
    if (defaultTarget) return defaultTarget;
  }
  return null;
}

export interface ClassifyRequestInput {
  messages?: readonly ChatMessage[];
  prompt?: string;
  systemPrompt?: string;
  tools?: unknown;
  hasVision?: boolean;
  hasWebSearchTool?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: string | null;
  estimatedTokens?: number;
  subagentHint?: string | null;
  hasStructuredOutput?: boolean;
}

function estimateCharsTokensFast(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function classifyIntentAndScenario(
  input: ClassifyRequestInput,
  policyOverride?: ScenarioRoutingPolicy,
): IntentClassificationResult {
  const t0 = performance.now();
  const policy = policyOverride ?? getScenarioRoutingPolicy();

  let systemPrompt = input.systemPrompt ?? '';
  let userPrompt = input.prompt ?? '';

  if (input.messages && input.messages.length > 0) {
    if (!systemPrompt) {
      systemPrompt = input.messages
        .filter(m => m.role === 'system')
        .map(m => extractMessageText(m.content).trim())
        .filter(Boolean)
        .join('\n');
    }
    if (!userPrompt) {
      for (let i = input.messages.length - 1; i >= 0; i -= 1) {
        const msg = input.messages[i]!;
        if (msg.role === 'user') {
          const txt = extractMessageText(msg.content).trim();
          if (txt) {
            userPrompt = txt;
            break;
          }
        }
      }
    }
  }

  const estimatedTokens = typeof input.estimatedTokens === 'number' && Number.isFinite(input.estimatedTokens) && input.estimatedTokens >= 0
    ? Math.trunc(input.estimatedTokens)
    : input.messages && input.messages.length > 0
      ? estimateInputTokens(input.messages as ChatMessage[])
      : estimateCharsTokensFast(`${systemPrompt}\n${userPrompt}`);

  const intentOut = classifyPromptIntent(userPrompt, systemPrompt, policy.simpleMaxWords);
  const signals = [...intentOut.signals];

  const hasVision = Boolean(input.hasVision) || (input.messages ? detectMessagesHaveVision(input.messages) : false);
  const hasWebSearch = Boolean(input.hasWebSearchTool) || detectToolsHaveWebSearch(input.tools);
  const effortLower = typeof input.reasoningEffort === 'string' ? input.reasoningEffort.trim().toLowerCase() : '';
  const highEffort = effortLower === 'high' || effortLower === 'max' || effortLower === 'xhigh' || effortLower === 'ultra';
  const explicitThinking = Boolean(input.thinkingEnabled) || highEffort;

  const combinedScanLower = `${systemPrompt.slice(0, 2_000)} ${userPrompt.slice(0, MAX_CLASSIFY_SCAN_CHARS)}`.toLowerCase();
  const toolCount = Array.isArray(input.tools) ? input.tools.length : 0;
  const subagentLower = typeof input.subagentHint === 'string' ? input.subagentHint.trim().toLowerCase() : '';

  let scenario: AgentScenarioLane = 'default';
  let confidence = intentOut.confidence;

  if (hasVision) {
    scenario = 'vision';
    signals.push('scenario:vision:image_content');
    confidence = Math.max(confidence, 0.98);
  } else if (estimatedTokens >= policy.longContextThresholdTokens) {
    scenario = 'longContext';
    signals.push(`scenario:longContext:tokens>=${policy.longContextThresholdTokens}`);
    confidence = Math.max(confidence, 0.96);
  } else if (subagentLower === 'background' || subagentLower === 'title' || subagentLower === 'summary') {
    scenario = 'background';
    signals.push(`scenario:background:header:${subagentLower}`);
    confidence = Math.max(confidence, 0.95);
  } else if (estimatedTokens <= 4_000 && toolCount <= 2) {
    const bgHits = findMatchedSignals(combinedScanLower, BACKGROUND_SCENARIO_MATCHERS, 2);
    if (bgHits.length > 0) {
      scenario = 'background';
      signals.push(...bgHits.map(s => `scenario:background:${s}`));
      confidence = Math.max(confidence, 0.92);
    }
  }

  if (scenario === 'default') {
    if (hasWebSearch) {
      scenario = 'webSearch';
      signals.push('scenario:webSearch:tool');
      confidence = Math.max(confidence, 0.96);
    } else {
      const webHits = findMatchedSignals(userPrompt.slice(0, MAX_CLASSIFY_SCAN_CHARS).toLowerCase(), WEB_SEARCH_SCENARIO_MATCHERS, 2);
      if (webHits.length > 0) {
        scenario = 'webSearch';
        signals.push(...webHits.map(s => `scenario:webSearch:${s}`));
        confidence = Math.max(confidence, 0.88);
      }
    }
  }

  if (scenario === 'default') {
    if (explicitThinking) {
      scenario = 'think';
      signals.push(input.thinkingEnabled ? 'scenario:think:thinking_param' : `scenario:think:effort:${effortLower}`);
      confidence = Math.max(confidence, 0.95);
    } else {
      const thinkHits = findMatchedSignals(combinedScanLower, THINK_SCENARIO_MATCHERS, 2);
      if (thinkHits.length > 0 || intentOut.intent === 'reasoning') {
        scenario = 'think';
        signals.push(
          ...(thinkHits.length > 0
            ? thinkHits.map(s => `scenario:think:${s}`)
            : ['scenario:think:reasoning_intent']),
        );
        confidence = Math.max(confidence, 0.86);
      }
    }
  }

  const recommendedPreset = recommendPresetForClassification(
    intentOut.intent,
    scenario,
    Boolean(input.hasStructuredOutput),
  );
  const resolvedTarget = resolvePolicyTargetForClassification(intentOut.intent, scenario, policy);
  const durationMs = Number(Math.max(0, performance.now() - t0).toFixed(3));

  return {
    intent: intentOut.intent,
    scenario,
    confidence: Number(confidence.toFixed(2)),
    signals,
    recommendedPreset,
    resolvedTarget,
    estimatedTokens,
    durationMs,
  };
}

export function previewIntentClassification(
  reqBody: IntentClassifyPreviewRequest,
  policyOverride?: ScenarioRoutingPolicy,
): IntentClassificationResult {
  return classifyIntentAndScenario(
    {
      prompt: reqBody.prompt,
      systemPrompt: reqBody.systemPrompt,
      hasVision: reqBody.hasVision,
      hasWebSearchTool: reqBody.hasWebSearchTool,
      thinkingEnabled: reqBody.thinkingEnabled,
      reasoningEffort: reqBody.reasoningEffort,
      estimatedTokens: reqBody.estimatedTokens,
    },
    policyOverride,
  );
}

/** Zero-latency heuristic preset picker for `routing-decision.ts` when model === 'heuristic'. */
export function chooseHeuristicRoutingPreset(messages: readonly ChatMessage[]): SmartRoutingPreset {
  const result = classifyIntentAndScenario({ messages }, DEFAULT_SCENARIO_ROUTING_POLICY);
  return result.recommendedPreset;
}

// ── Persisted Scenario Routing Policy Store ──────────────────────────────────

const POLICY_CACHE_TTL_MS = 2_000;
let cachedPolicyDb: unknown = null;
let cachedPolicyRaw: string | undefined;
let cachedPolicyExpiresAt = 0;
let cachedPolicy: ScenarioRoutingPolicy | null = null;

function sanitizeTarget(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 120);
}

export function normalizeScenarioRoutingPolicy(raw: unknown): ScenarioRoutingPolicy {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};

  const enabled = typeof obj.enabled === 'boolean'
    ? obj.enabled
    : DEFAULT_SCENARIO_ROUTING_POLICY.enabled;

  const decisionMode: SmartRoutingDecisionMode =
    typeof obj.decisionMode === 'string' && (SMART_ROUTING_DECISION_MODES as readonly string[]).includes(obj.decisionMode)
      ? (obj.decisionMode as SmartRoutingDecisionMode)
      : DEFAULT_SCENARIO_ROUTING_POLICY.decisionMode;

  const rawThreshold = Number(obj.longContextThresholdTokens);
  const longContextThresholdTokens = Number.isFinite(rawThreshold) && rawThreshold >= 1_000 && rawThreshold <= 2_000_000
    ? Math.trunc(rawThreshold)
    : DEFAULT_SCENARIO_ROUTING_POLICY.longContextThresholdTokens;

  const rawSimpleWords = Number(obj.simpleMaxWords);
  const simpleMaxWords = Number.isFinite(rawSimpleWords) && rawSimpleWords >= 5 && rawSimpleWords <= 500
    ? Math.trunc(rawSimpleWords)
    : DEFAULT_SCENARIO_ROUTING_POLICY.simpleMaxWords;

  const rawLanes = obj.lanes && typeof obj.lanes === 'object' && !Array.isArray(obj.lanes)
    ? (obj.lanes as Record<string, unknown>)
    : {};
  const lanes: Record<AgentScenarioLane, string> = { ...DEFAULT_SCENARIO_ROUTING_POLICY.lanes };
  for (const lane of AGENT_SCENARIO_LANES) {
    lanes[lane] = sanitizeTarget(rawLanes[lane]);
  }

  const rawIntents = obj.intentTargets && typeof obj.intentTargets === 'object' && !Array.isArray(obj.intentTargets)
    ? (obj.intentTargets as Record<string, unknown>)
    : {};
  const intentTargets: Partial<Record<IntentCategory, string>> = {};
  for (const intent of INTENT_CATEGORIES) {
    const target = sanitizeTarget(rawIntents[intent]);
    if (target) intentTargets[intent] = target;
  }

  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : null;

  return {
    enabled,
    decisionMode,
    longContextThresholdTokens,
    simpleMaxWords,
    lanes,
    intentTargets,
    updatedAt,
  };
}

export function getScenarioRoutingPolicy(): ScenarioRoutingPolicy {
  try {
    const db = getDb();
    const now = Date.now();
    if (cachedPolicy && cachedPolicyDb === db && now < cachedPolicyExpiresAt) {
      return {
        ...cachedPolicy,
        lanes: { ...cachedPolicy.lanes },
        intentTargets: { ...cachedPolicy.intentTargets },
      };
    }
    const raw = getSetting(SMART_ROUTING_POLICY_SETTING_KEY);
    if (cachedPolicy && cachedPolicyDb === db && cachedPolicyRaw === raw) {
      cachedPolicyExpiresAt = now + POLICY_CACHE_TTL_MS;
      return {
        ...cachedPolicy,
        lanes: { ...cachedPolicy.lanes },
        intentTargets: { ...cachedPolicy.intentTargets },
      };
    }
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    const policy = normalizeScenarioRoutingPolicy(parsed);
    cachedPolicyDb = db;
    cachedPolicyRaw = raw;
    cachedPolicyExpiresAt = now + POLICY_CACHE_TTL_MS;
    cachedPolicy = policy;
    return {
      ...policy,
      lanes: { ...policy.lanes },
      intentTargets: { ...policy.intentTargets },
    };
  } catch {
    return {
      ...DEFAULT_SCENARIO_ROUTING_POLICY,
      lanes: { ...DEFAULT_SCENARIO_ROUTING_POLICY.lanes },
      intentTargets: {},
    };
  }
}

export function setScenarioRoutingPolicy(patch: Partial<ScenarioRoutingPolicy>): ScenarioRoutingPolicy {
  const current = getScenarioRoutingPolicy();
  const merged = normalizeScenarioRoutingPolicy({
    ...current,
    ...patch,
    lanes: {
      ...current.lanes,
      ...(patch.lanes ?? {}),
    },
    intentTargets: patch.intentTargets !== undefined
      ? patch.intentTargets
      : current.intentTargets,
    updatedAt: new Date().toISOString(),
  });
  const serialized = JSON.stringify(merged);
  setSetting(SMART_ROUTING_POLICY_SETTING_KEY, serialized);
  try {
    cachedPolicyDb = getDb();
  } catch {
    cachedPolicyDb = null;
  }
  cachedPolicyRaw = serialized;
  cachedPolicyExpiresAt = Date.now() + POLICY_CACHE_TTL_MS;
  cachedPolicy = merged;
  return {
    ...merged,
    lanes: { ...merged.lanes },
    intentTargets: { ...merged.intentTargets },
  };
}

export function resetScenarioRoutingPolicyCache(): void {
  cachedPolicyDb = null;
  cachedPolicyRaw = undefined;
  cachedPolicyExpiresAt = 0;
  cachedPolicy = null;
}

/**
 * Evaluate Smart Routing v2 policy for an incoming `/thruline/v1` request.
 * Only activates when `policy.enabled === true` and the caller requested `auto`.
 */
export function evaluateGatewaySmartRoute(opts: {
  requestedModel: string;
  messages: readonly ChatMessage[];
  rawBody: Record<string, unknown>;
  thinkingEffort?: string;
  subagentHint?: string | null;
}): {
  classification: IntentClassificationResult;
  effectiveModel: string;
  overridden: boolean;
} | null {
  const policy = getScenarioRoutingPolicy();
  if (!policy.enabled) return null;

  const cleanLower = opts.requestedModel.trim().toLowerCase();
  if (cleanLower !== 'auto') return null;

  const rawThinking = opts.rawBody.thinking;
  const thinkingObj = rawThinking && typeof rawThinking === 'object' && !Array.isArray(rawThinking)
    ? (rawThinking as Record<string, unknown>)
    : null;
  const thinkingEnabled = Boolean(
    thinkingObj && (
      thinkingObj.type === 'enabled'
      || thinkingObj.type === 'adaptive'
      || (typeof thinkingObj.budget_tokens === 'number' && thinkingObj.budget_tokens > 0)
    ),
  );
  const reasoningEffort = opts.thinkingEffort
    ?? (typeof opts.rawBody.reasoning_effort === 'string' ? opts.rawBody.reasoning_effort : undefined);
  const hasStructuredOutput = Boolean(
    opts.rawBody.response_format
    && typeof opts.rawBody.response_format === 'object'
    && (opts.rawBody.response_format as Record<string, unknown>).type !== 'text',
  );

  const classification = classifyIntentAndScenario(
    {
      messages: opts.messages,
      tools: opts.rawBody.tools,
      thinkingEnabled,
      reasoningEffort,
      subagentHint: opts.subagentHint,
      hasStructuredOutput,
    },
    policy,
  );

  const target = classification.resolvedTarget;
  if (!target || target.toLowerCase() === 'auto') {
    return {
      classification,
      effectiveModel: opts.requestedModel,
      overridden: false,
    };
  }

  // Preset targets like `preset:fastest` map cleanly to `auto:fastest`, while combo/model
  // targets (`combo:coding-flagship`, `groq/llama-3.3-70b-versatile`, etc.) pass verbatim.
  const effectiveModel = target.toLowerCase().startsWith('preset:')
    ? `auto:${target.slice('preset:'.length).trim()}`
    : target;

  return {
    classification,
    effectiveModel,
    overridden: effectiveModel !== opts.requestedModel,
  };
}
