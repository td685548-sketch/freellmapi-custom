export type CapabilityState = 'configured' | 'ready' | 'unavailable' | 'unverified';
export type ToolProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'gemini';
export interface ToolProbeInput { toolId: string; key: string; model: string; keyId?: number }
export interface ToolProbeResult {
  ok: boolean;
  toolId: string;
  protocol: ToolProtocol;
  model: string;
  endpoint: string;
  status?: number;
  latencyMs: number;
  checkedAt: string;
  message?: string;
  error?: string;
}
export interface GatewayCapability {
  id: string;
  state: CapabilityState;
  detail: string;
  checkedAt?: string;
  model?: string;
}
export interface GatewayDiagnostics {
  checkedAt: string;
  evidenceTtlSeconds: number;
  capabilities: GatewayCapability[];
  deployment: {
    publicBaseConfigured: boolean;
    encryptionKeyConfigured: boolean;
    database: 'sqlite' | 'turso';
    persistence: 'external' | 'operator-verification-required';
  };
}
