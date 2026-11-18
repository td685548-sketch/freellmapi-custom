import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useSessionRevision } from '../session-state';
import type {
  CloudEntitlementStatusResponse,
  CloudPendingRequestSummary,
} from '../../../../shared/cloud-entitlement';

export function aiEntitlementQueryKey(revision: number) {
  return ['ai-entitlement-status', revision] as const;
}

export function fetchAiEntitlementStatus(
  signal?: AbortSignal,
): Promise<CloudEntitlementStatusResponse> {
  return apiFetch<CloudEntitlementStatusResponse>('/api/ai-entitlement/status', {
    signal,
  });
}

export function useAiEntitlementStatus() {
  const revision = useSessionRevision();
  return useQuery({
    queryKey: aiEntitlementQueryKey(revision),
    queryFn: ({ signal }) => fetchAiEntitlementStatus(signal),
    staleTime: 30_000,
  });
}

export function useActivateAiTokenMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silenceToast: true },
    mutationFn: (token: string) =>
      apiFetch<{ ok: boolean; status: CloudEntitlementStatusResponse }>(
        '/api/ai-entitlement/activate',
        {
          method: 'POST',
          body: JSON.stringify({ token }),
        },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-entitlement-status'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-catalog'] });
    },
  });
}

export function useSubmitAiActivationRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silenceToast: true },
    mutationFn: (input: {
      orgName: string;
      contactInfo: string;
      serverOrigin?: string;
      note?: string;
    }) =>
      apiFetch<{
        ok: boolean;
        pendingRequest: CloudPendingRequestSummary;
        status: CloudEntitlementStatusResponse;
      }>('/api/ai-entitlement/request', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-entitlement-status'] });
    },
  });
}

export function useCheckAiActivationApprovalMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    meta: { silenceToast: true },
    mutationFn: () =>
      apiFetch<{
        ok: boolean;
        activated: boolean;
        request: CloudPendingRequestSummary;
        status: CloudEntitlementStatusResponse;
      }>('/api/ai-entitlement/request/check', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-entitlement-status'] });
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-catalog'] });
    },
  });
}
