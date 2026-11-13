import { useMutation, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type {
  DispatchResult,
  ProtocolType,
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
