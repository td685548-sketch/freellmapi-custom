export type Pillar =
  | 'prompts'
  | 'retrieval'
  | 'promptCache'
  | 'mcpClient'
  | 'outputGuard'
  | 'orchestrator';

export const PILLARS: readonly Pillar[] = [
  'prompts',
  'retrieval',
  'promptCache',
  'mcpClient',
  'outputGuard',
  'orchestrator',
] as const;

export type PillarFlags = Record<Pillar, boolean>;

export const DEFAULT_PILLAR_FLAGS: Readonly<PillarFlags> = {
  prompts: false,
  retrieval: false,
  promptCache: false,
  mcpClient: false,
  outputGuard: false,
  orchestrator: false,
};

export type ScopeKind = 'profile' | 'support_tenant' | 'agent';

export interface Scope {
  kind: ScopeKind;
  id: string;
}

export type Wire = 'openai-chat' | 'anthropic' | 'responses' | 'gemini';

export const AI_PLATFORM_PARENT_PERMISSION = 'manage_ai_platform' as const;

export const AI_PLATFORM_CHILD_PERMISSIONS = [
  'view_ai_platform',
  'edit_ai_flags',
  'view_prompts',
  'edit_prompts',
  'publish_prompts',
  'view_retrieval',
  'edit_retrieval',
  'view_prompt_cache',
  'edit_prompt_cache',
  'view_mcp_servers',
  'edit_mcp_servers',
  'review_mcp_tools',
  'view_output_guard',
  'edit_output_guard',
  'view_guard_excerpts',
  'view_flows',
  'edit_flows',
  'publish_flows',
  'view_flow_runs',
  'cancel_flow_runs',
  'approve_ai_actions',
] as const;

export type AiPlatformChildPermission = typeof AI_PLATFORM_CHILD_PERMISSIONS[number];
export type AiPlatformPermissionName = typeof AI_PLATFORM_PARENT_PERMISSION | AiPlatformChildPermission;

export const AI_PLATFORM_LIMITS = {
  // Flags & inference headers
  flagsCacheTtlMs: 5_000,
  callerVarsHeaderMaxBytes: 2_048,
  callerVarValueMaxChars: 200,
  citationsHeaderMaxBytes: 4_096,

  // Prompts
  promptNoteMaxChars: 500,
  promptVersionsRetained: 50,
  promptVarNameMaxChars: 32,

  // Retrieval
  retrievalDefaultDimensions: 768,
  retrievalDefaultTopK: 5,
  retrievalMaxTopK: 20,
  retrievalDefaultMinScore: 0.25,
  retrievalRrfK: 60,
  retrievalQueryTimeoutMs: 1_500,
  retrievalIndexBatchSize: 64,
  retrievalVectorCacheMaxBytes: 256 * 1024 * 1024,

  // MCP Client
  mcpSlugMaxChars: 32,
  mcpExposedToolNameMaxChars: 64,
  mcpDefaultTimeoutMs: 20_000,
  mcpDefaultMaxResultBytes: 262_144,
  mcpDefaultMaxConcurrency: 4,
  mcpDefaultMaxRounds: 8,
  mcpMaxRedirects: 3,
  mcpCircuitBreakerThreshold: 5,
  mcpCircuitBreakerBaseMs: 60_000,
  mcpCircuitBreakerMaxMs: 900_000,
  mcpCallLogMaxBytes: 8_192,
  mcpApprovalTtlHours: 24,

  // Output Guard
  guardMaxKeywords: 200,
  guardKeywordMaxChars: 80,
  guardMaxPatterns: 20,
  guardPatternMaxChars: 200,
  guardPatternMaxEvalMs: 5,
  guardPatternEvalSampleChars: 10_000,
  guardDefaultHoldChars: 200,
  guardMaxHoldChars: 2_000,
  guardDefaultMaxDelayMs: 300,
  guardMaxDelayMs: 2_000,
  guardReplacementMaxChars: 1_000,
  guardDefaultMaxLengthChars: 20_000,
  guardPromptLeakMinShingles: 2,
  guardPromptLeakShingleWords: 12,
  guardExcerptMaxChars: 500,

  // Orchestrator
  orchestratorDefaultMaxSteps: 12,
  orchestratorHardMaxSteps: 50,
  orchestratorDefaultMaxToolCalls: 20,
  orchestratorDefaultMaxHandoffs: 4,
  orchestratorDefaultMaxTokens: 60_000,
  orchestratorDefaultMaxDurationMs: 120_000,
  orchestratorStepLogMaxBytes: 8_192,
  orchestratorLoopRepeatLimit: 3,

  // Retention defaults (days)
  retentionDefaultRunsDays: 30,
  retentionDefaultToolCallsDays: 30,
  retentionDefaultGuardExcerptsDays: 7,
  retentionEventsMaxDays: 90,
} as const;

export interface AiPlatformRetention {
  runsDays: number;
  toolCallsDays: number;
  guardExcerptsDays: number;
}

export const DEFAULT_AI_PLATFORM_RETENTION: Readonly<AiPlatformRetention> = {
  runsDays: AI_PLATFORM_LIMITS.retentionDefaultRunsDays,
  toolCallsDays: AI_PLATFORM_LIMITS.retentionDefaultToolCallsDays,
  guardExcerptsDays: AI_PLATFORM_LIMITS.retentionDefaultGuardExcerptsDays,
};

export interface AiPlatformPillarOverview {
  enabled: boolean;
  ready: boolean;
  summary: string;
}

export interface AiPlatformOverviewResponse {
  flags: PillarFlags;
  retention: AiPlatformRetention;
  pillars: Record<Pillar, AiPlatformPillarOverview>;
  warnings: string[];
}

export interface AiPlatformFlagsResponse {
  flags: PillarFlags;
}

export interface AiPlatformRetentionResponse {
  retention: AiPlatformRetention;
}
