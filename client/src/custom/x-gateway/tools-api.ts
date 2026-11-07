import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

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
    queryFn: ({ signal }) => apiFetch<ToolsStatusResponse>('/api/x-gateway/tools', { signal }),
    staleTime: 10_000,
  });
}

export function useTestToolConnection() {
  return useMutation({
    mutationFn: (toolId: string) =>
      apiFetch<ToolTestResult>('/api/x-gateway/tools/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId }),
      }),
  });
}
