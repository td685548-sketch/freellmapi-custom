/**
 * "Models" row of the Setup Copilot: which model source it may call (Thruline's own accounts,
 * FreeLLMAPI's gateway, or both). Everyone sees the choice; only an account with `edit_settings`
 * can change it (the server enforces that, the disabled select just mirrors it).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu } from 'lucide-react';
import { COPILOT_MODEL_SOURCES, type CopilotModelSource } from '../../../../shared/support-setup-copilot';
import { toast } from '@/lib/toast';
import { fetchCopilotModelSource, putCopilotModelSource } from './api';
import type { SupportSetupCopilotStrings } from './strings';

const QUERY_KEY = ['support-setup-copilot-model-source'];

export function ModelSourcePicker({ s, enabled }: { s: SupportSetupCopilotStrings; enabled: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: fetchCopilotModelSource, enabled, staleTime: 15_000 });
  const mutation = useMutation({
    mutationFn: (source: CopilotModelSource) => putCopilotModelSource(source),
    onSuccess: (res) => {
      queryClient.setQueryData(QUERY_KEY, res);
      toast.success(s.modelSourceSaved);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const data = query.data;
  if (!enabled || !data?.source || !data.available) return null;

  const labels: Record<CopilotModelSource, string> = {
    both: s.modelSourceBoth,
    thruline: s.modelSourceThruline,
    freellmapi: s.modelSourceFreellmapi,
  };
  const { available, source } = data;
  const warning =
    source === 'thruline' && !available.thruline
      ? s.modelSourceNoThruline
      : source === 'freellmapi' && !available.freellmapi
        ? s.modelSourceNoFreellmapi
        : source === 'both' && !available.thruline && !available.freellmapi
          ? s.modelSourceNoneAvailable
          : null;

  return (
    <div className="ssc-model-source" data-testid="support-setup-model-source">
      <label htmlFor="ssc-model-source-select" className="ssc-model-source-label">
        <Cpu size={12} aria-hidden="true" />
        <span>{s.modelSourceLabel}</span>
      </label>
      <select
        id="ssc-model-source-select"
        className="ssc-select"
        value={source}
        disabled={!data.canEdit || mutation.isPending}
        title={data.canEdit ? s.modelSourceHelp : s.modelSourceReadOnly}
        onChange={(e) => mutation.mutate(e.target.value as CopilotModelSource)}
      >
        {COPILOT_MODEL_SOURCES.map((value) => (
          <option key={value} value={value}>
            {labels[value]}
          </option>
        ))}
      </select>
      {warning && (
        <p className="ssc-model-source-warn" role="status" data-testid="support-setup-model-source-warning">
          {warning}
        </p>
      )}
    </div>
  );
}
