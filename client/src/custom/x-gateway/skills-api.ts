import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import type {
  SkillsListResponse,
  SkillSummary,
  CustomSkillCreateInput,
  CustomSkillUpdateInput,
} from './skills-types';

export function useSkills() {
  return useQuery({
    queryKey: ['x-gateway-skills'],
    queryFn: ({ signal }) => apiFetch<SkillsListResponse>('/api/thruline/skills', { signal }),
  });
}

export function useSkillDetail(id: string | null) {
  return useQuery({
    queryKey: ['x-gateway-skill-detail', id],
    queryFn: ({ signal }) => apiFetch<{ skill: SkillSummary }>(`/api/thruline/skills/${id}`, { signal }),
    enabled: Boolean(id),
  });
}

export function useCreateCustomSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CustomSkillCreateInput) =>
      apiFetch<{ skill: SkillSummary }>('/api/thruline/skills/custom', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-gateway-skills'] });
    },
  });
}

export function useUpdateCustomSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CustomSkillUpdateInput }) =>
      apiFetch<{ skill: SkillSummary }>(`/api/thruline/skills/custom/${id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      }),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['x-gateway-skills'] });
      void queryClient.invalidateQueries({ queryKey: ['x-gateway-skill-detail', variables.id] });
    },
  });
}

export function useDeleteCustomSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: boolean; id: string }>(`/api/thruline/skills/custom/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-gateway-skills'] });
    },
  });
}

