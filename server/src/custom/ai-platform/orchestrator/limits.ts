import {
  DEFAULT_FLOW_LIMITS,
  FLOW_LIMITS,
  type FlowLimitsConfig,
  type FlowStopReason,
} from '@freellmapi/shared/ai-platform-orchestrator.js';
import { canonicalJson } from '../mcp-client/store.js';

export interface LimiterCounters {
  steps: number;
  toolCalls: number;
  handoffs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LimiterSnapshot {
  entryAgent: string;
  limits: FlowLimitsConfig;
  steps: number;
  toolCalls: number;
  handoffs: number;
  promptTokens: number;
  completionTokens: number;
  toolCallCounts: Record<string, number>;
  agentHistory: string[];
  accumulatedElapsedMs: number;
}

export type LimiterCheckResult =
  | { allowed: true }
  | { allowed: false; stopReason: FlowStopReason };

function clampLimit(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(ceiling, Math.trunc(value)));
}

/**
 * Applies default flow limits and clamps every field strictly to `1..hardCeiling`.
 */
export function normalizeFlowLimits(partial?: Partial<FlowLimitsConfig>): FlowLimitsConfig {
  return {
    maxSteps: clampLimit(partial?.maxSteps, DEFAULT_FLOW_LIMITS.maxSteps, FLOW_LIMITS.hardMaxSteps),
    maxToolCalls: clampLimit(
      partial?.maxToolCalls,
      DEFAULT_FLOW_LIMITS.maxToolCalls,
      FLOW_LIMITS.hardMaxToolCalls,
    ),
    maxHandoffs: clampLimit(
      partial?.maxHandoffs,
      DEFAULT_FLOW_LIMITS.maxHandoffs,
      FLOW_LIMITS.hardMaxHandoffs,
    ),
    maxTokens: clampLimit(
      partial?.maxTokens,
      DEFAULT_FLOW_LIMITS.maxTokens,
      FLOW_LIMITS.hardMaxTokens,
    ),
    maxSeconds: clampLimit(
      partial?.maxSeconds,
      DEFAULT_FLOW_LIMITS.maxSeconds,
      FLOW_LIMITS.hardMaxSeconds,
    ),
  };
}

function toolSignature(toolName: string, args: unknown): string {
  return `${toolName}:${canonicalJson(args ?? {})}`;
}

function sanitizeCount(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Tracks per-run execution counters, elapsed active runtime, identical tool-call repeats,
 * and agent handoff ping-pong cycles, with JSON-serializable pause/resume snapshots.
 */
export class FlowRunLimiter {
  private readonly entryAgent: string;
  private readonly limits: FlowLimitsConfig;
  private readonly nowFn: () => number;
  private readonly segmentStartedAtMs: number;
  private readonly accumulatedElapsedMs: number;
  private readonly toolCallCounts: Map<string, number>;
  private readonly agentHistory: string[];

  private steps: number;
  private toolCalls: number;
  private handoffs: number;
  private promptTokens: number;
  private completionTokens: number;

  constructor(
    entryAgent: string,
    limits?: Partial<FlowLimitsConfig>,
    startedAtMs?: number,
    nowFn?: () => number,
    initialState?: {
      steps?: number;
      toolCalls?: number;
      handoffs?: number;
      promptTokens?: number;
      completionTokens?: number;
      toolCallCounts?: Record<string, number>;
      agentHistory?: string[];
      accumulatedElapsedMs?: number;
    },
  ) {
    this.nowFn = nowFn ?? (() => Date.now());
    this.entryAgent = entryAgent;
    this.limits = normalizeFlowLimits(limits);
    this.segmentStartedAtMs = startedAtMs ?? this.nowFn();
    this.accumulatedElapsedMs = sanitizeCount(initialState?.accumulatedElapsedMs ?? 0);

    this.steps = sanitizeCount(initialState?.steps ?? 0);
    this.toolCalls = sanitizeCount(initialState?.toolCalls ?? 0);
    this.handoffs = sanitizeCount(initialState?.handoffs ?? 0);
    this.promptTokens = sanitizeCount(initialState?.promptTokens ?? 0);
    this.completionTokens = sanitizeCount(initialState?.completionTokens ?? 0);

    this.toolCallCounts = new Map<string, number>();
    if (initialState?.toolCallCounts) {
      for (const [key, count] of Object.entries(initialState.toolCallCounts)) {
        const sanitized = sanitizeCount(count);
        if (sanitized > 0) {
          this.toolCallCounts.set(key, sanitized);
        }
      }
    }

    const history = Array.isArray(initialState?.agentHistory)
      ? initialState.agentHistory.filter((item): item is string => typeof item === 'string' && item.length > 0)
      : [];
    this.agentHistory = history.length > 0 ? [...history] : [entryAgent];
  }

  static fromSnapshot(
    snap: LimiterSnapshot,
    limits?: Partial<FlowLimitsConfig>,
    nowFn?: () => number,
  ): FlowRunLimiter {
    const resolvedNowFn = nowFn ?? (() => Date.now());
    const mergedLimits = limits ? { ...snap.limits, ...limits } : snap.limits;
    return new FlowRunLimiter(snap.entryAgent, mergedLimits, resolvedNowFn(), resolvedNowFn, {
      steps: snap.steps,
      toolCalls: snap.toolCalls,
      handoffs: snap.handoffs,
      promptTokens: snap.promptTokens,
      completionTokens: snap.completionTokens,
      toolCallCounts: snap.toolCallCounts,
      agentHistory: snap.agentHistory,
      accumulatedElapsedMs: snap.accumulatedElapsedMs,
    });
  }

  toSnapshot(nowMs?: number): LimiterSnapshot {
    return {
      entryAgent: this.entryAgent,
      limits: { ...this.limits },
      steps: this.steps,
      toolCalls: this.toolCalls,
      handoffs: this.handoffs,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      toolCallCounts: Object.fromEntries(this.toolCallCounts.entries()),
      agentHistory: [...this.agentHistory],
      accumulatedElapsedMs: this.getElapsedMs(nowMs),
    };
  }

  getLimits(): FlowLimitsConfig {
    return { ...this.limits };
  }

  getElapsedMs(nowMs?: number): number {
    const currentMs = nowMs ?? this.nowFn();
    return this.accumulatedElapsedMs + Math.max(0, currentMs - this.segmentStartedAtMs);
  }

  checkTime(nowMs?: number): FlowStopReason | null {
    return this.getElapsedMs(nowMs) >= this.limits.maxSeconds * 1000 ? 'max_seconds' : null;
  }

  checkBeforeModelStep(nowMs?: number): LimiterCheckResult {
    const timeStop = this.checkTime(nowMs);
    if (timeStop) {
      return { allowed: false, stopReason: timeStop };
    }
    if (this.steps >= this.limits.maxSteps) {
      return { allowed: false, stopReason: 'max_steps' };
    }
    if (this.promptTokens + this.completionTokens >= this.limits.maxTokens) {
      return { allowed: false, stopReason: 'max_tokens' };
    }
    return { allowed: true };
  }

  recordModelStep(
    promptTokens: number,
    completionTokens: number,
  ): { exceededTokenLimit: boolean; counters: LimiterCounters } {
    this.steps += 1;
    this.promptTokens += sanitizeCount(promptTokens);
    this.completionTokens += sanitizeCount(completionTokens);
    const counters = this.getCounters();
    return {
      exceededTokenLimit: counters.totalTokens >= this.limits.maxTokens,
      counters,
    };
  }

  checkBeforeToolCall(toolName: string, args: unknown, nowMs?: number): LimiterCheckResult {
    const timeStop = this.checkTime(nowMs);
    if (timeStop) {
      return { allowed: false, stopReason: timeStop };
    }
    const key = toolSignature(toolName, args);
    const priorCount = this.toolCallCounts.get(key) ?? 0;
    if (priorCount >= FLOW_LIMITS.loopRepeatLimit - 1) {
      return { allowed: false, stopReason: 'loop_detected' };
    }
    if (this.toolCalls >= this.limits.maxToolCalls) {
      return { allowed: false, stopReason: 'max_tool_calls' };
    }
    return { allowed: true };
  }

  recordToolCall(toolName: string, args: unknown): void {
    this.toolCalls += 1;
    const key = toolSignature(toolName, args);
    this.toolCallCounts.set(key, (this.toolCallCounts.get(key) ?? 0) + 1);
  }

  checkBeforeHandoff(fromAgent: string, toAgent: string, nowMs?: number): LimiterCheckResult {
    const timeStop = this.checkTime(nowMs);
    if (timeStop) {
      return { allowed: false, stopReason: timeStop };
    }
    if (this.agentHistory.length >= 3) {
      const [h0, h1, h2] = this.agentHistory.slice(-3);
      if (h0 === h2 && h2 === fromAgent && h1 === toAgent && h0 !== h1) {
        return { allowed: false, stopReason: 'loop_detected' };
      }
    }
    if (this.handoffs >= this.limits.maxHandoffs) {
      return { allowed: false, stopReason: 'max_handoffs' };
    }
    return { allowed: true };
  }

  recordHandoff(toAgent: string): void {
    this.handoffs += 1;
    this.agentHistory.push(toAgent);
  }

  getCounters(): LimiterCounters {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      handoffs: this.handoffs,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.promptTokens + this.completionTokens,
    };
  }
}
