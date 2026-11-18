import { apiFetch } from '@/lib/api';
import type {
  IdeConnectionStatusDto,
  IdePackageBundle,
  IdePackagerToolId,
  ScenarioClassificationResult,
  ScenarioId,
  ScenarioRoutingConfigResponse,
  ScenarioRoutingPolicyDto,
  ScenarioRuleConfig,
  ScenarioWireSurface,
} from '../../../../shared/scenario-routing';

export function fetchScenarioRoutingConfig(keyId?: number | null): Promise<ScenarioRoutingConfigResponse> {
  const qs = keyId && keyId > 0 ? `?keyId=${encodeURIComponent(String(keyId))}` : '';
  return apiFetch<ScenarioRoutingConfigResponse>(`/api/scenario-routing/config${qs}`);
}

export function saveScenarioRoutingPolicy(input: {
  keyId?: number | null;
  enabled: boolean;
  longContextThreshold?: number;
  rules?: Partial<Record<ScenarioId, Partial<ScenarioRuleConfig>>>;
}): Promise<{ ok: boolean; policy: ScenarioRoutingPolicyDto }> {
  return apiFetch<{ ok: boolean; policy: ScenarioRoutingPolicyDto }>('/api/scenario-routing/policy', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export function deleteKeyScenarioRoutingPolicy(keyId: number): Promise<{ ok: boolean; deleted: boolean }> {
  return apiFetch<{ ok: boolean; deleted: boolean }>(
    `/api/scenario-routing/policy/${encodeURIComponent(String(keyId))}`,
    { method: 'DELETE' },
  );
}

export function previewScenarioClassification(input: {
  wireSurface?: ScenarioWireSurface;
  longContextThreshold?: number;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; classification: ScenarioClassificationResult }> {
  return apiFetch<{ ok: boolean; classification: ScenarioClassificationResult }>(
    '/api/scenario-routing/classify-preview',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function generateIdePackage(input: {
  toolId: IdePackagerToolId;
  gatewayUrl: string;
  keyId?: number | null;
  rawApiKey?: string | null;
  defaultModel?: string | null;
}): Promise<{ ok: boolean; bundle: IdePackageBundle }> {
  return apiFetch<{ ok: boolean; bundle: IdePackageBundle }>('/api/scenario-routing/ide-package', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function fetchIdeConnectionStatus(
  keyId?: number | null,
): Promise<{ ok: boolean; status: IdeConnectionStatusDto }> {
  const qs = keyId && keyId > 0 ? `?keyId=${encodeURIComponent(String(keyId))}` : '';
  return apiFetch<{ ok: boolean; status: IdeConnectionStatusDto }>(
    `/api/scenario-routing/connection-status${qs}`,
  );
}

export function triggerIdeVerifyPing(input: {
  keyId?: number | null;
  rawApiKey?: string | null;
}): Promise<{ ok: boolean; status: IdeConnectionStatusDto }> {
  return apiFetch<{ ok: boolean; status: IdeConnectionStatusDto }>(
    '/api/scenario-routing/verify-ping',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}
