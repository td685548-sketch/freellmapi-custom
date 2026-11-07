export type ProtocolType =
  | 'openai_chat'
  | 'anthropic'
  | 'openai_responses'
  | 'gemini'
  | 'sse_openai'
  | 'sse_anthropic';

export type PipelineStepStatus = 'ok' | 'warn' | 'info' | 'error';

export interface PipelineStep {
  step: number;
  name: string;
  status: PipelineStepStatus;
  title: string;
  details: string;
  metadata?: Record<string, unknown>;
}

export interface TranslationStats {
  sourceTokens: number;
  targetTokens: number;
  delta: number;
  warnings: string[];
  lossyFields: string[];
}

export interface TranslationResult {
  success: boolean;
  sourceProtocol: ProtocolType;
  targetProtocol: ProtocolType;
  transformed: Record<string, unknown>;
  steps: PipelineStep[];
  stats: TranslationStats;
}

export interface TranslatorTemplate {
  id: string;
  name: string;
  protocol: ProtocolType;
  description: string;
  payload: Record<string, unknown>;
}

export interface DispatchResult {
  success: boolean;
  protocol: ProtocolType;
  model: string;
  availableAccounts: number;
  latencyMs: number;
  status: number;
  note: string;
}
