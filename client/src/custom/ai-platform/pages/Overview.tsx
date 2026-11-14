import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import {
  fetchOverview,
  putFlags,
  overviewKey,
  type PlatformFlags,
  type PillarKey,
} from '../api';
import {
  OVERVIEW_HEADING,
  OVERVIEW_LOADING,
  OVERVIEW_ERROR,
  OVERVIEW_RETRY,
  PILLAR_LABELS,
  PILLAR_DESCRIPTIONS,
  SWITCH_ON,
  SWITCH_OFF,
  SWITCH_ENABLING,
  SWITCH_DISABLING,
  SWITCH_LOCKED,
  ACCESS_DENIED_403,
  SESSION_EXPIRED_401,
  SWITCH_CONFLICT,
  SWITCH_NETWORK_ERROR,
} from '../strings';

const PILLARS: PillarKey[] = [
  'prompts',
  'retrieval',
  'promptCache',
  'mcpClient',
  'outputGuard',
  'orchestrator',
];

interface PillarSwitchProps {
  pillar: PillarKey;
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onToggle: (pillar: PillarKey, next: boolean) => void;
}

function PillarSwitch({ pillar, checked, disabled, pending, onToggle }: PillarSwitchProps) {
  const tc = useCustomT();
  const label = tc(PILLAR_LABELS[pillar]);
  const description = tc(PILLAR_DESCRIPTIONS[pillar]);
  const stateLabel = pending
    ? (checked ? tc(SWITCH_DISABLING) : tc(SWITCH_ENABLING))
    : (checked ? tc(SWITCH_ON) : tc(SWITCH_OFF));

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="flex-1">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
        {disabled && !pending && (
          <div className="text-xs text-muted-foreground mt-1" aria-label="permission notice">
            {tc(SWITCH_LOCKED)}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">{stateLabel}</span>
        <button
          role="switch"
          aria-checked={checked}
          aria-label={label}
          disabled={disabled || pending}
          onClick={() => { if (!disabled && !pending) onToggle(pillar, !checked); }}
          className={[
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            checked ? 'bg-primary' : 'bg-input',
            (disabled || pending) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
        >
          <span
            className={[
              'inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
              checked ? 'translate-x-4' : 'translate-x-0.5',
            ].join(' ')}
          />
        </button>
      </div>
    </div>
  );
}

export function Overview() {
  const tc = useCustomT();
  const queryClient = useQueryClient();
  const { can } = useAdministrativeAccess();
  const { session } = useUserSession();
  // Session revision is part of the query key so stale data never leaks
  // across logout/login cycles. The key changes when permissions change.
  const sessionRevision = session?.userId ?? 0;
  const scopeKey = 'global';
  const currentEpochKey = `${sessionRevision}:${scopeKey}`;
  const canEdit = can('edit_ai_flags');

  // Mutation error state + unmount/epoch guards
  const [mutationErrorState, setMutationErrorState] = useState<{ epochKey: string; message: string } | null>(null);
  const mutationError = mutationErrorState?.epochKey === currentEpochKey ? mutationErrorState.message : null;
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    epochRef.current += 1;
    abortRef.current?.abort();
  }, [sessionRevision, scopeKey]);

  const overviewQuery = useQuery({
    queryKey: overviewKey(sessionRevision, scopeKey),
    queryFn: ({ signal }) => fetchOverview(signal),
    enabled: can('view_ai_platform'),
  });

  const flagsMutation = useMutation({
    mutationFn: async (patch: Partial<PlatformFlags>) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const callEpoch = epochRef.current;
      const envelope = await putFlags(patch, ac.signal);
      return { envelope, callEpoch, rev: sessionRevision, scope: scopeKey };
    },
    onSuccess: ({ envelope, callEpoch, rev, scope }) => {
      if (!mountedRef.current || callEpoch !== epochRef.current) return;
      setMutationErrorState(null);
      queryClient.setQueryData(overviewKey(rev, scope), (old: typeof overviewQuery.data) => {
        if (!old) return old;
        return { ...old, flags: envelope.flags };
      });
    },
    onError: (error: unknown) => {
      if (!mountedRef.current) return;
      if ((error as { name?: string })?.name === 'AbortError') return;
      const status = (error as { status?: number }).status;
      const message = status === 403
        ? tc(ACCESS_DENIED_403)
        : status === 401
          ? tc(SESSION_EXPIRED_401)
          : status === 409
            ? tc(SWITCH_CONFLICT)
            : tc(SWITCH_NETWORK_ERROR);
      setMutationErrorState({ epochKey: currentEpochKey, message });
    },
  });

  function handleToggle(pillar: PillarKey, next: boolean) {
    if (!canEdit) return;
    setMutationErrorState(null);
    flagsMutation.mutate({ [pillar]: next });
  }

  if (overviewQuery.isPending) {
    return <div className="p-6 text-sm text-muted-foreground">{tc(OVERVIEW_LOADING)}</div>;
  }

  if (overviewQuery.isError) {
    return (
      <div className="p-6">
        <div className="text-sm text-destructive mb-2">{tc(OVERVIEW_ERROR)}</div>
        <button
          className="text-sm underline"
          onClick={() => overviewQuery.refetch()}
        >
          {tc(OVERVIEW_RETRY)}
        </button>
      </div>
    );
  }

  const flags = overviewQuery.data?.flags;
  if (!flags) return null;

  return (
    <div className="p-6 space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">{tc(OVERVIEW_HEADING)}</h2>

      {mutationError && (
        <div className="text-sm text-destructive p-3 bg-destructive/10 rounded-md" role="alert">
          {mutationError}
        </div>
      )}

      {!canEdit && (
        <div className="text-xs text-muted-foreground">
          {tc('View only — you do not have edit_ai_flags permission')}
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <div className="px-4 pt-4 pb-1">
          {PILLARS.map(pillar => (
            <PillarSwitch
              key={pillar}
              pillar={pillar}
              checked={flags[pillar]}
              disabled={!canEdit}
              pending={flagsMutation.isPending && flagsMutation.variables !== undefined && pillar in (flagsMutation.variables as Partial<PlatformFlags>)}
              onToggle={handleToggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
