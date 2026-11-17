/** Shared contracts for the Customer AI Hub, smart personal-key routing, and dual-persona intelligence. */

export const KEY_ROUTING_MODES = ['default', 'eco', 'balanced', 'max'] as const;
export type KeyRoutingMode = typeof KEY_ROUTING_MODES[number];

export const ASSISTANT_CATEGORIES = ['coding', 'writing', 'data', 'productivity', 'general'] as const;
export type AssistantCategory = typeof ASSISTANT_CATEGORIES[number];

export const ASSISTANT_AUDIENCES = ['all_members', 'guest_preview', 'admin_only'] as const;
export type AssistantAudience = typeof ASSISTANT_AUDIENCES[number];

/** Customer-facing AI Assistant DTO. Never includes internal systemPrompt text. */
export interface CustomerAiAssistant {
  id: number;
  slug: string;
  name: string;
  description: string;
  category: AssistantCategory;
  icon: string;
  recommendedRoutingMode: KeyRoutingMode;
  starterPrompts: string[];
  audience: AssistantAudience;
  boundKeysCount: number;
  playgroundRuns: number;
}

/** Administrator AI Assistant DTO with authoring and lifecycle fields. */
export interface AdminAiAssistant extends CustomerAiAssistant {
  systemPrompt: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserAiPreferences {
  customInstructions: string;
  applyCustomInstructionsToKeys: boolean;
  updatedAt: string | null;
}

export interface QuotaCoachTip {
  id: string;
  severity: 'saving' | 'warning' | 'info';
  title: string;
  detail: string;
  estimatedTokenSavingsPct?: number;
  recommendedMode?: KeyRoutingMode;
  targetKeyId?: number;
  targetKeyName?: string;
}

export interface CustomerQuotaCoachReport {
  windowDays: number;
  totalRequests: number;
  totalTokens: number;
  avgTokensPerRequest: number;
  errorRatePct: number;
  potentialSavingsPct: number;
  routingBreakdown: Record<KeyRoutingMode, number>;
  headline: string;
  tips: QuotaCoachTip[];
}

export type AdminAnomalyKind = 'token_spike' | 'high_error_loop' | 'unoptimized_heavy_usage';

export interface AdminAnomalyItem {
  id: string;
  kind: AdminAnomalyKind;
  severity: 'high' | 'medium' | 'low';
  userId: number;
  email: string;
  requests24h: number;
  tokens24h: number;
  baselineDailyTokens: number;
  errorRatePct: number;
  activeNonEcoKeys: number;
  summary: string;
  recommendedAction: 'switch_keys_to_eco' | 'inspect_user';
}

export interface AdminAnomalyRadarReport {
  generatedAt: string;
  windowHours: number;
  totalAssistants: number;
  enabledAssistants: number;
  boundPersonalKeys: number;
  ecoPersonalKeys: number;
  anomalies: AdminAnomalyItem[];
  topAssistants: Array<{
    id: number;
    slug: string;
    name: string;
    category: AssistantCategory;
    boundKeysCount: number;
    playgroundRuns: number;
  }>;
}
