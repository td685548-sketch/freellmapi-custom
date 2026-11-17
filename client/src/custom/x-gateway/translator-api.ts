import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type {
  DispatchResult,
  ProtocolType,
  SavedTranslatorCase,
  TranslationResult,
  TranslatorTemplate,
} from './translator-types';

export function useTranslatorTemplates() {
  return useQuery({
    queryKey: ['x-translator-templates'],
    queryFn: ({ signal }) =>
      apiFetch<{ templates: TranslatorTemplate[] }>('/api/thruline/translator/templates', { signal }),
    staleTime: 1000 * 60 * 10,
  });
}

export function useTranslatorCases() {
  return useQuery({
    queryKey: ['x-translator-cases'],
    queryFn: async ({ signal }) => {
      const res = await apiFetch<{ cases?: SavedTranslatorCase[] }>('/api/thruline/translator/cases', { signal });
      return Array.isArray(res?.cases) ? res.cases : [];
    },
    retry: false,
  });
}

export function useSaveTranslatorCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      name: string;
      sourceProtocol: ProtocolType;
      targetProtocol: ProtocolType;
      payload: Record<string, unknown>;
    }) =>
      apiFetch<{ case: SavedTranslatorCase; cases: SavedTranslatorCase[] }>('/api/thruline/translator/cases', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-translator-cases'] });
    },
  });
}

export function useDeleteTranslatorCase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ deleted: boolean; cases: SavedTranslatorCase[] }>(`/api/thruline/translator/cases/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-translator-cases'] });
    },
  });
}

export function useInspectTranslation() {
  return useMutation({
    mutationFn: (vars: {
      sourceProtocol: ProtocolType;
      targetProtocol: ProtocolType;
      payload: Record<string, unknown>;
    }) =>
      apiFetch<TranslationResult>('/api/thruline/translator/inspect', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
  });
}

export function useDispatchTranslation() {
  return useMutation({
    mutationFn: (vars: {
      protocol: ProtocolType;
      payload: Record<string, unknown>;
      model?: string;
    }) =>
      apiFetch<DispatchResult>('/api/thruline/translator/dispatch', {
        method: 'POST',
        body: JSON.stringify(vars),
      }),
  });
}
