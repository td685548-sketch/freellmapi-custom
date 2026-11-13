import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { GatewayDiagnostics, ToolProbeInput } from '../../../../shared/x-operations';

export interface ToolTestResult {
  ok: boolean;
  toolId: string;
  latencyMs?: number;
  usableAccountsCount?: number;
  availableModelsCount?: number;
  message?: string;
  error?: string;
}

export interface ToolsStatusResponse {
  enabled: boolean;
  usableAccounts: number;
  tools: Array<{
    id: string;
    name: string;
    protocol: string;
  }>;
}

export function useToolsStatus(revision?: number) {
  return useQuery({
    queryKey: ['x-gateway-tools-status', revision],
    queryFn: ({ signal }) => apiFetch<ToolsStatusResponse>('/api/thruline/tools', { signal }),
    staleTime: 10_000,
  });
}

export function useTestToolConnection() {
  return useMutation({
    mutationFn: (input: ToolProbeInput) =>
      apiFetch<ToolTestResult>('/api/thruline/tools/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
}

export function useGatewayDiagnostics(revision: number) {
  return useQuery({
    queryKey: ['x-gateway-diagnostics', revision],
    queryFn: ({ signal }) => apiFetch<GatewayDiagnostics>('/api/thruline/tools/diagnostics', { signal }),
    refetchInterval: 30_000,
    retry: false,
  });
}
