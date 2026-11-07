import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type { TunnelStatus } from './tunnel-types';

export function useTunnelStatus() {
  return useQuery({
    queryKey: ['x-gateway-tunnel-status'],
    queryFn: ({ signal }) => apiFetch<TunnelStatus>('/api/x-gateway/tunnel/status', { signal }),
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === 'active' || state === 'starting' ? 3000 : 12000;
    },
  });
}

export function useStartTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (port?: number) =>
      apiFetch<TunnelStatus>('/api/x-gateway/tunnel/start', {
        method: 'POST',
        body: JSON.stringify(port ? { port } : {}),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['x-gateway-tunnel-status'], data);
    },
  });
}

export function useStopTunnel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<TunnelStatus>('/api/x-gateway/tunnel/stop', {
        method: 'POST',
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['x-gateway-tunnel-status'], data);
    },
  });
}

export function useTunnelLogs() {
  return useQuery({
    queryKey: ['x-gateway-tunnel-logs'],
    queryFn: ({ signal }) =>
      apiFetch<{ logs: string[] }>('/api/x-gateway/tunnel/logs', { signal }),
    refetchInterval: 4000,
  });
}
