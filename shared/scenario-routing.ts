/**
 * Shared contracts for Spec 039: Scenario-Based Auto-Routing for Coding Agents
 * and the 1-Click Personalized IDE Config Packager.
 */

export const SCENARIO_IDS = [
  'background',
  'think',
  'longContext',
  'vision',
  'webSearch',
  'default',
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const SCENARIO_ROUTING_MODES = ['default', 'eco', 'balanced', 'max'] as const;
export type ScenarioRoutingMode = (typeof SCENARIO_ROUTING_MODES)[number];

export const DEFAULT_LONG_CONTEXT_THRESHOLD = 60_000;
export const MIN_LONG_CONTEXT_THRESHOLD = 4_000;
export const MAX_LONG_CONTEXT_THRESHOLD = 1_000_000;

export interface ScenarioRuleConfig {
  enabled: boolean;
  targetMode: ScenarioRoutingMode;
  targetModel: string | null;
  overrideExplicitModel: boolean;
}

export type ScenarioRulesMap = Record<ScenarioId, ScenarioRuleConfig>;

export const DEFAULT_SCENARIO_RULES: Readonly<ScenarioRulesMap> = {
  background: {
    enabled: true,
    targetMode: 'eco',
    targetModel: null,
    overrideExplicitModel: true,
  },
  think: {
    enabled: true,
    targetMode: 'max',
    targetModel: null,
    overrideExplicitModel: false,
  },
  longContext: {
    enabled: true,
    targetMode: 'balanced',
    targetModel: null,
    overrideExplicitModel: false,
  },
  vision: {
    enabled: true,
    targetMode: 'balanced',
    targetModel: null,
    overrideExplicitModel: false,
  },
  webSearch: {
    enabled: true,
    targetMode: 'balanced',
    targetModel: null,
    overrideExplicitModel: false,
  },
  default: {
    enabled: false,
    targetMode: 'default',
    targetModel: null,
    overrideExplicitModel: false,
  },
};

export interface ScenarioRoutingPolicyDto {
  id: number | null;
  userId: number;
  keyId: number | null;
  enabled: boolean;
  longContextThreshold: number;
  rules: ScenarioRulesMap;
  updatedAt: string | null;
}

export type ScenarioWireSurface = 'chat_completions' | 'anthropic_messages' | 'responses';

export interface ScenarioClassificationResult {
  scenario: ScenarioId;
  confidence: number;
  estimatedInputTokens: number;
  signals: string[];
  wireSurface: ScenarioWireSurface;
}

export interface ScenarioStatItem {
  scenario: ScenarioId;
  hitCount: number;
  offloadedCount: number;
  totalTokens: number;
  estimatedTokensSaved: number;
  lastModel: string | null;
  lastRoutedMode: string | null;
  lastHitAt: string | null;
}

export interface ScenarioTelemetrySummary {
  totalHits: number;
  totalOffloadedHits: number;
  totalTokens: number;
  estimatedTokensSaved: number;
  byScenario: Record<ScenarioId, ScenarioStatItem>;
}

export interface ScenarioCatalogModelOption {
  modelId: string;
  displayName: string;
  platform: string;
  sizeLabel: string;
  contextWindow: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
}

export interface ScenarioRoutingConfigResponse {
  accountPolicy: ScenarioRoutingPolicyDto;
  keyPolicies: ScenarioRoutingPolicyDto[];
  telemetry: ScenarioTelemetrySummary;
  availableModels: ScenarioCatalogModelOption[];
}

export const IDE_PACKAGER_TOOLS = [
  'claude-code',
  'cursor',
  'cline-roo',
  'codex',
  'opencode',
  'continue',
] as const;

export type IdePackagerToolId = (typeof IDE_PACKAGER_TOOLS)[number];

export interface IdeGeneratedFile {
  filename: string;
  targetPath: string;
  format: 'json' | 'toml' | 'yaml' | 'env' | 'markdown';
  content: string;
  descriptionEn: string;
  descriptionVi: string;
}

export interface IdePackageBundle {
  toolId: IdePackagerToolId;
  toolName: string;
  protocol: string;
  baseUrl: string;
  maskedKey: string;
  hasRawKey: boolean;
  files: IdeGeneratedFile[];
  powershellSnippet: string;
  bashSnippet: string;
  verifyPowershellSnippet: string;
  verifyBashSnippet: string;
  stepsEn: string[];
  stepsVi: string[];
}

export interface IdeConnectionStatusDto {
  connected: boolean;
  verifiedVia: 'verify_ping' | 'recent_inference' | 'none';
  keyId: number | null;
  keyName: string | null;
  keyPrefix: string | null;
  lastVerifiedAt: string | null;
  lastInferenceAt: string | null;
  recentRequests5m: number;
  gatewayBaseUrl: string;
}
