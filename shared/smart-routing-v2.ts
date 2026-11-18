export type IntentCategory =
  | 'code'
  | 'math'
  | 'reasoning'
  | 'creative'
  | 'simple'
  | 'medium';

export const INTENT_CATEGORIES: readonly IntentCategory[] = [
  'code',
  'math',
  'reasoning',
  'creative',
  'simple',
  'medium',
] as const;

export type AgentScenarioLane =
  | 'default'
  | 'background'
  | 'think'
  | 'longContext'
  | 'webSearch'
  | 'vision';

export const AGENT_SCENARIO_LANES: readonly AgentScenarioLane[] = [
  'default',
  'background',
  'think',
  'longContext',
  'webSearch',
  'vision',
] as const;

export type SmartRoutingDecisionMode = 'heuristic' | 'llm';

export const SMART_ROUTING_DECISION_MODES: readonly SmartRoutingDecisionMode[] = [
  'heuristic',
  'llm',
] as const;

export type SmartRoutingPreset = 'balanced' | 'smartest' | 'fastest' | 'reliable';

export const SMART_ROUTING_PRESETS: readonly SmartRoutingPreset[] = [
  'balanced',
  'smartest',
  'fastest',
  'reliable',
] as const;

export interface ScenarioRoutingPolicy {
  enabled: boolean;
  decisionMode: SmartRoutingDecisionMode;
  longContextThresholdTokens: number;
  simpleMaxWords: number;
  lanes: Record<AgentScenarioLane, string>;
  intentTargets: Partial<Record<IntentCategory, string>>;
  updatedAt?: string | null;
}

export const DEFAULT_SCENARIO_ROUTING_POLICY: ScenarioRoutingPolicy = {
  enabled: false,
  decisionMode: 'heuristic',
  longContextThresholdTokens: 60_000,
  simpleMaxWords: 60,
  lanes: {
    default: '',
    background: '',
    think: '',
    longContext: '',
    webSearch: '',
    vision: '',
  },
  intentTargets: {},
  updatedAt: null,
};

export interface IntentClassifyPreviewRequest {
  prompt: string;
  systemPrompt?: string;
  hasVision?: boolean;
  hasWebSearchTool?: boolean;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  estimatedTokens?: number;
}

export interface IntentClassificationResult {
  intent: IntentCategory;
  scenario: AgentScenarioLane;
  confidence: number;
  signals: string[];
  recommendedPreset: SmartRoutingPreset;
  resolvedTarget: string | null;
  estimatedTokens: number;
  durationMs: number;
}

export interface LearnedModelCapRecord {
  provider: string;
  modelId: string;
  endpointScope: string;
  maxOutputTokens: number | null;
  maxThinkingBudget: number | null;
  supportedReasoningEfforts: string[] | null;
  lastErrorSample: string | null;
  hitCount: number;
  updatedAt: string;
}

export interface SyncedModelSpecRecord {
  provider: string;
  modelId: string;
  displayName: string | null;
  family: string | null;
  contextWindow: number | null;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  supportsTools: boolean | null;
  supportsReasoning: boolean | null;
  supportsVision: boolean | null;
  supportsStructuredOutput: boolean | null;
  reasoningEfforts: string[] | null;
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  cachedCostPer1M: number | null;
  reasoningCostPer1M: number | null;
  lastSyncedAt: string;
}

export interface ModelsDevSyncStatus {
  enabled: boolean;
  envOverride: 'true' | 'false' | 'unset';
  periodicActive: boolean;
  intervalMs: number;
  lastSyncAt: string | null;
  lastSyncModelCount: number;
  lastSyncProviderCount: number;
  storedModelCount: number;
  lastError: string | null;
}

export interface ModelsDevSyncResult {
  success: boolean;
  dryRun: boolean;
  modelCount: number;
  providerCount: number;
  syncedAt: string | null;
  error?: string;
}
