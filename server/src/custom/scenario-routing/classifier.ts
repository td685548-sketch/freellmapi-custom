/**
 * Deterministic Zero-Latency (<1ms) Scenario Classifier for Coding Agents.
 *
 * Combines:
 * 1. Ordered policy-engine evaluation (`claude-code-router` RoutePolicyEngine pattern)
 * 2. Synchronous multilingual keyword/intent signal matching (`OmniRoute` intentClassifier pattern)
 *
 * Supports OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, and OpenAI `/v1/responses`.
 */

import {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  type ScenarioClassificationResult,
  type ScenarioId,
  type ScenarioWireSurface,
} from '@freellmapi/shared/scenario-routing.js';
import { estimateTextTokens, IMAGE_TOKENS_PER_IMAGE } from '../../lib/content.js';

export interface ScenarioRoutePolicy<TContext, TDecision> {
  id: string;
  evaluate: (context: TContext) => TDecision | undefined;
}

export class ScenarioPolicyEngine<TContext, TDecision> {
  private readonly policies: readonly ScenarioRoutePolicy<TContext, TDecision>[];

  constructor(policies: readonly ScenarioRoutePolicy<TContext, TDecision>[]) {
    this.policies = policies;
  }

  evaluate(context: TContext): { policyId: string; decision: TDecision } | undefined {
    for (const policy of this.policies) {
      const decision = policy.evaluate(context);
      if (decision !== undefined) {
        return { policyId: policy.id, decision };
      }
    }
    return undefined;
  }
}

const WEB_SEARCH_TOOL_NAME_RE =
  /^(?:web_?search|internet_?search|google_?search|brave_?search|tavily_?search|exa_?search|perplexity_?search|duckduckgo_?search)(?:_\d+)?$/i;

const BACKGROUND_PHRASES: readonly string[] = [
  // Title / topic generation (Claude Code, Cursor, Cline, OpenCode, Continue)
  'generate a concise title',
  'generate a short title',
  'write a short title',
  'create a short title',
  '3-6 word title',
  '3 to 6 word title',
  'summarize this conversation into a title',
  'title for this conversation',
  'topic of this conversation',
  'is_new_topic',
  'conversation title',
  'chat title',
  'tao tieu de',
  'tạo tiêu đề',
  'dat tieu de',
  'đặt tiêu đề',
  // Commit message / branch / PR summary
  'generate a commit message',
  'write a commit message',
  'write a git commit message',
  'draft a commit message',
  'conventional commit',
  'suggest a branch name',
  'viet commit message',
  'viết commit message',
  'tao commit message',
  // Conversation compaction / context handoff
  'summarize the conversation so far',
  'compact the conversation',
  'conversation compaction',
  'context compaction',
  'create a concise summary of the conversation',
  'summarize our conversation',
  'handoff summary',
  'tom tat cuoc tro chuyen',
  'tóm tắt cuộc trò chuyện',
  'tom tat hoi thoai',
  'tóm tắt hội thoại',
  // Small background classification / extraction
  'extract file paths from',
  'classify the user intent',
];

const THINK_PHRASES: readonly string[] = [
  // English architecture, root-cause debugging & formal reasoning
  'system architecture',
  'architectural design',
  'distributed architecture',
  'design a scalable',
  'trade-offs',
  'tradeoffs',
  'root cause analysis',
  'race condition',
  'deadlock',
  'memory leak',
  'concurrency bug',
  'security audit',
  'threat model',
  'step by step',
  'chain of thought',
  'prove formally',
  'mathematical proof',
  'think deeply',
  'think carefully',
  'ultrathink',
  // Vietnamese (accented & unaccented)
  'thiet ke kien truc',
  'thiết kế kiến trúc',
  'phan tich nguyen nhan goc',
  'phân tích nguyên nhân gốc',
  'kiem toan bao mat',
  'kiểm toán bảo mật',
  'suy luan tung buoc',
  'suy luận từng bước',
  'phan tich chuyen sau',
  'phân tích chuyên sâu',
  'toi uu kien truc',
  'tối ưu kiến trúc',
];

const SMALL_SUBAGENT_MODEL_RE = /\b(?:haiku|mini|nano|flash-lite)\b/i;

export function detectScenarioWireSurface(path: string): ScenarioWireSurface | null {
  const clean = path.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
  if (clean === '/chat/completions' || clean.endsWith('/v1/chat/completions')) {
    return 'chat_completions';
  }
  if (clean === '/messages' || clean.endsWith('/v1/messages')) {
    return 'anthropic_messages';
  }
  if (clean === '/responses' || clean.endsWith('/v1/responses')) {
    return 'responses';
  }
  return null;
}

interface ExtractedPayloadFeatures {
  wireSurface: ScenarioWireSurface;
  requestedModel: string;
  systemText: string;
  lastUserText: string;
  combinedLowerText: string;
  wordCount: number;
  estimatedInputTokens: number;
  hasImage: boolean;
  hasTools: boolean;
  hasWebSearch: boolean;
  explicitThinking: boolean;
  explicitThinkingSignals: string[];
  maxTokens: number | null;
}

const DATA_URI_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

// Strip inline base64 image payloads before token estimation: the bytes are
// billed per image (IMAGE_TOKENS_PER_IMAGE), and counting them as ASCII text
// inflated the estimate past 60k for a single screenshot (the scenario-routing
// test pins this).
function stripDataUris(str: string): string {
  if (!str.includes('data:')) return str;
  return str.replace(DATA_URI_RE, '[inline_image]');
}

function safeTextLengthWithoutDataUri(str: string): { chars: number; inlineImages: number } {
  if (!str.includes('data:')) {
    return { chars: str.length, inlineImages: 0 };
  }
  let inlineImages = 0;
  const stripped = str.replace(DATA_URI_RE, () => {
    inlineImages += 1;
    return '[inline_image]';
  });
  return { chars: stripped.length, inlineImages };
}

function inspectContentNode(node: unknown): {
  textParts: string[];
  chars: number;
  tokens: number;
  imageCount: number;
} {
  if (typeof node === 'string') {
    const measured = safeTextLengthWithoutDataUri(node);
    return {
      textParts: [node],
      chars: measured.chars,
      tokens: estimateTextTokens(stripDataUris(node)),
      imageCount: measured.inlineImages,
    };
  }
  if (!node) {
    return { textParts: [], chars: 0, tokens: 0, imageCount: 0 };
  }
  if (Array.isArray(node)) {
    const textParts: string[] = [];
    let chars = 0;
    let tokens = 0;
    let imageCount = 0;
    for (const item of node) {
      const sub = inspectContentNode(item);
      if (sub.textParts.length > 0) textParts.push(...sub.textParts);
      chars += sub.chars;
      tokens += sub.tokens;
      imageCount += sub.imageCount;
    }
    return { textParts, chars, tokens, imageCount };
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const type = typeof obj.type === 'string' ? obj.type.toLowerCase() : '';
    if (
      type === 'image' ||
      type === 'image_url' ||
      type === 'input_image' ||
      type === 'computer_screenshot' ||
      obj.image_url !== undefined
    ) {
      return { textParts: [], chars: 0, tokens: 0, imageCount: 1 };
    }
    const textParts: string[] = [];
    let chars = 0;
    let tokens = 0;
    let imageCount = 0;
    if (typeof obj.text === 'string') {
      const measured = safeTextLengthWithoutDataUri(obj.text);
      textParts.push(obj.text);
      chars += measured.chars;
      tokens += estimateTextTokens(stripDataUris(obj.text));
      imageCount += measured.inlineImages;
    }
    if (typeof obj.input_text === 'string') {
      const measured = safeTextLengthWithoutDataUri(obj.input_text);
      textParts.push(obj.input_text);
      chars += measured.chars;
      tokens += estimateTextTokens(stripDataUris(obj.input_text));
      imageCount += measured.inlineImages;
    }
    if (obj.content !== undefined) {
      const sub = inspectContentNode(obj.content);
      textParts.push(...sub.textParts);
      chars += sub.chars;
      tokens += sub.tokens;
      imageCount += sub.imageCount;
    }
    if (obj.output !== undefined) {
      const sub = inspectContentNode(obj.output);
      textParts.push(...sub.textParts);
      chars += sub.chars;
      tokens += sub.tokens;
      imageCount += sub.imageCount;
    }
    return { textParts, chars, tokens, imageCount };
  }
  return { textParts: [], chars: 0, tokens: 0, imageCount: 0 };
}

function detectWebSearchTools(body: Record<string, unknown>): boolean {
  if (body.web_search_options && typeof body.web_search_options === 'object') {
    return true;
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const rawTool of tools) {
    if (!rawTool || typeof rawTool !== 'object') continue;
    const tool = rawTool as Record<string, unknown>;
    const toolType = typeof tool.type === 'string' ? tool.type.trim().toLowerCase() : '';
    if (
      toolType.startsWith('web_search') ||
      toolType === 'google_search' ||
      toolType === 'google_search_retrieval'
    ) {
      return true;
    }
    const directName = typeof tool.name === 'string' ? tool.name.trim() : '';
    const fnObj =
      tool.function && typeof tool.function === 'object'
        ? (tool.function as Record<string, unknown>)
        : null;
    const fnName = fnObj && typeof fnObj.name === 'string' ? fnObj.name.trim() : '';
    const candidateName = directName || fnName;
    if (candidateName && WEB_SEARCH_TOOL_NAME_RE.test(candidateName)) {
      return true;
    }
  }
  return false;
}

function detectExplicitThinking(body: Record<string, unknown>): {
  enabled: boolean;
  signals: string[];
} {
  const signals: string[] = [];

  if (typeof body.reasoning_effort === 'string') {
    const effort = body.reasoning_effort.trim().toLowerCase();
    if (effort && effort !== 'none' && effort !== 'off' && effort !== 'disabled') {
      signals.push(`reasoning_effort:${effort}`);
    }
  }

  if (body.enable_thinking === true || body.thinking === true) {
    signals.push('thinking:true');
  } else if (body.thinking && typeof body.thinking === 'object') {
    const thinking = body.thinking as Record<string, unknown>;
    const tType = typeof thinking.type === 'string' ? thinking.type.trim().toLowerCase() : '';
    const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : null;
    if (tType && tType !== 'disabled' && tType !== 'off' && tType !== 'none') {
      signals.push(`thinking.type:${tType}`);
    } else if (!tType && budget !== null && budget > 0) {
      signals.push(`thinking.budget_tokens:${budget}`);
    }
  }

  if (body.reasoning && typeof body.reasoning === 'object') {
    const reasoning = body.reasoning as Record<string, unknown>;
    const effort = typeof reasoning.effort === 'string' ? reasoning.effort.trim().toLowerCase() : '';
    if (effort && effort !== 'none' && effort !== 'off' && effort !== 'disabled') {
      signals.push(`reasoning.effort:${effort}`);
    }
  }

  return { enabled: signals.length > 0, signals };
}

function extractFeatures(
  rawBody: unknown,
  wireSurface: ScenarioWireSurface,
): ExtractedPayloadFeatures {
  const body =
    rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? (rawBody as Record<string, unknown>)
      : {};

  const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
  const systemParts: string[] = [];
  let lastUserText = '';
  let totalTokens = 0;
  let imageCount = 0;

  if (body.system !== undefined) {
    const sys = inspectContentNode(body.system);
    systemParts.push(...sys.textParts);
    totalTokens += sys.tokens;
    imageCount += sys.imageCount;
  }

  if (typeof body.instructions === 'string') {
    const inst = safeTextLengthWithoutDataUri(body.instructions);
    systemParts.push(body.instructions);
    totalTokens += estimateTextTokens(stripDataUris(body.instructions));
    imageCount += inst.inlineImages;
  }

  if (Array.isArray(body.messages)) {
    for (const rawMsg of body.messages) {
      if (!rawMsg || typeof rawMsg !== 'object') continue;
      const msg = rawMsg as Record<string, unknown>;
      const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
      const inspected = inspectContentNode(msg.content);
      totalTokens += inspected.tokens;
      imageCount += inspected.imageCount;

      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc || typeof tc !== 'object') continue;
          const fn = (tc as Record<string, unknown>).function;
          if (fn && typeof fn === 'object') {
            const fnRec = fn as Record<string, unknown>;
            if (typeof fnRec.name === 'string') totalTokens += estimateTextTokens(fnRec.name);
            if (typeof fnRec.arguments === 'string') totalTokens += estimateTextTokens(fnRec.arguments);
          }
        }
      }

      if (role === 'system' || role === 'developer') {
        systemParts.push(...inspected.textParts);
      } else if (role === 'user' && inspected.textParts.length > 0) {
        lastUserText = inspected.textParts.join('\n');
      }
    }
  }

  if (body.input !== undefined) {
    if (typeof body.input === 'string') {
      const inp = safeTextLengthWithoutDataUri(body.input);
      lastUserText = body.input;
      totalTokens += estimateTextTokens(stripDataUris(body.input));
      imageCount += inp.inlineImages;
    } else if (Array.isArray(body.input)) {
      for (const rawItem of body.input) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        const role = typeof item.role === 'string' ? item.role.toLowerCase() : '';
        const inspected = inspectContentNode(item.content ?? item.output ?? item);
        totalTokens += inspected.tokens;
        imageCount += inspected.imageCount;
        if (typeof item.arguments === 'string') {
          totalTokens += estimateTextTokens(item.arguments);
        }
        if (role === 'system' || role === 'developer') {
          systemParts.push(...inspected.textParts);
        } else if (role === 'user' && inspected.textParts.length > 0) {
          lastUserText = inspected.textParts.join('\n');
        }
      }
    }
  }

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hasTools = tools.length > 0;
  let toolTokens = 0;
  if (hasTools) {
    try {
      toolTokens = estimateTextTokens(JSON.stringify(tools));
    } catch {
      toolTokens = tools.length * 120;
    }
  }

  // Script-weighted text estimate (Vietnamese/CJK aware) plus the shared
  // flat per-image cost — the same 765 the proxy router and the
  // context-budget estimator charge.
  const estimatedInputTokens =
    totalTokens + toolTokens + imageCount * IMAGE_TOKENS_PER_IMAGE;

  const systemText = systemParts.join('\n');
  const combinedSample = `${systemText.slice(0, 4_000)}\n${lastUserText.slice(-4_000)}`.toLowerCase();
  const trimmedUser = lastUserText.trim();
  const wordCount = trimmedUser ? trimmedUser.split(/\s+/).length : 0;

  const rawMax =
    typeof body.max_tokens === 'number'
      ? body.max_tokens
      : typeof body.max_completion_tokens === 'number'
        ? body.max_completion_tokens
        : typeof body.max_output_tokens === 'number'
          ? body.max_output_tokens
          : null;
  const maxTokens = rawMax !== null && rawMax > 0 ? rawMax : null;

  const thinkingCheck = detectExplicitThinking(body);

  return {
    wireSurface,
    requestedModel,
    systemText,
    lastUserText,
    combinedLowerText: combinedSample,
    wordCount,
    estimatedInputTokens,
    hasImage: imageCount > 0,
    hasTools,
    hasWebSearch: detectWebSearchTools(body),
    explicitThinking: thinkingCheck.enabled,
    explicitThinkingSignals: thinkingCheck.signals,
    maxTokens,
  };
}

interface ClassifyEvalContext {
  features: ExtractedPayloadFeatures;
  longContextThreshold: number;
}

interface ClassifyEvalDecision {
  scenario: ScenarioId;
  confidence: number;
  signals: string[];
}

const SCENARIO_POLICY_ENGINE = new ScenarioPolicyEngine<ClassifyEvalContext, ClassifyEvalDecision>([
  {
    id: 'vision',
    evaluate: ({ features }) => {
      if (!features.hasImage) return undefined;
      return {
        scenario: 'vision',
        confidence: 0.99,
        signals: ['multimodal:image_block'],
      };
    },
  },
  {
    id: 'webSearch',
    evaluate: ({ features }) => {
      if (!features.hasWebSearch) return undefined;
      return {
        scenario: 'webSearch',
        confidence: 0.98,
        signals: ['tools:web_search'],
      };
    },
  },
  {
    id: 'longContext',
    evaluate: ({ features, longContextThreshold }) => {
      if (features.estimatedInputTokens <= longContextThreshold) return undefined;
      return {
        scenario: 'longContext',
        confidence: 0.97,
        signals: [
          `estimated_tokens:${features.estimatedInputTokens}>${longContextThreshold}`,
        ],
      };
    },
  },
  {
    id: 'think-explicit',
    evaluate: ({ features }) => {
      if (!features.explicitThinking) return undefined;
      return {
        scenario: 'think',
        confidence: 0.98,
        signals: features.explicitThinkingSignals,
      };
    },
  },
  {
    id: 'background',
    evaluate: ({ features }) => {
      const matchedPhrases = BACKGROUND_PHRASES.filter((phrase) =>
        features.combinedLowerText.includes(phrase),
      );
      if (matchedPhrases.length > 0) {
        return {
          scenario: 'background',
          confidence: 0.94,
          signals: matchedPhrases.slice(0, 3).map((p) => `prompt:${p}`),
        };
      }
      if (
        !features.hasTools &&
        SMALL_SUBAGENT_MODEL_RE.test(features.requestedModel) &&
        features.maxTokens !== null &&
        features.maxTokens <= 256 &&
        features.estimatedInputTokens <= 4_000
      ) {
        return {
          scenario: 'background',
          confidence: 0.86,
          signals: [
            `subagent_model:${features.requestedModel}`,
            `max_tokens:${features.maxTokens}`,
          ],
        };
      }
      if (
        !features.hasTools &&
        features.maxTokens !== null &&
        features.maxTokens <= 64 &&
        features.wordCount > 0 &&
        features.wordCount <= 20 &&
        features.estimatedInputTokens <= 400
      ) {
        return {
          scenario: 'background',
          confidence: 0.82,
          signals: [`tiny_utility:max_tokens=${features.maxTokens},words=${features.wordCount}`],
        };
      }
      return undefined;
    },
  },
  {
    id: 'think-heuristic',
    evaluate: ({ features }) => {
      const matched = THINK_PHRASES.filter((phrase) =>
        features.combinedLowerText.includes(phrase),
      );
      if (matched.length === 0) return undefined;
      return {
        scenario: 'think',
        confidence: matched.length >= 2 ? 0.91 : 0.84,
        signals: matched.slice(0, 3).map((p) => `intent:${p}`),
      };
    },
  },
]);

export function classifyScenarioRequest(
  rawBody: unknown,
  options?: {
    wireSurface?: ScenarioWireSurface;
    longContextThreshold?: number;
  },
): ScenarioClassificationResult {
  const wireSurface = options?.wireSurface ?? 'chat_completions';
  const threshold =
    options?.longContextThreshold && options.longContextThreshold > 0
      ? options.longContextThreshold
      : DEFAULT_LONG_CONTEXT_THRESHOLD;

  const features = extractFeatures(rawBody, wireSurface);
  const match = SCENARIO_POLICY_ENGINE.evaluate({
    features,
    longContextThreshold: threshold,
  });

  if (match) {
    return {
      scenario: match.decision.scenario,
      confidence: match.decision.confidence,
      estimatedInputTokens: features.estimatedInputTokens,
      signals: match.decision.signals,
      wireSurface,
    };
  }

  return {
    scenario: 'default',
    confidence: 0.8,
    estimatedInputTokens: features.estimatedInputTokens,
    signals: ['standard_turn'],
    wireSurface,
  };
}
