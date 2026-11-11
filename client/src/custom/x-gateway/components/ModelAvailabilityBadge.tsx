import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface AvailabilityEntry {
  accountId: number;
  accountLabel: string;
  provider: string;
  model: string | null;
  status: 'cooldown' | 'quota_exhausted';
  until: string | null;
  remainingMs: number;
  lastError?: string | null;
}

export interface AvailabilityResponse {
  models: AvailabilityEntry[];
  unavailableCount: number;
}

interface ClearBody { accountId?: number; provider?: string; model?: string }

const ENDPOINT = '/api/x-accounts/availability';
const REFRESH_MS = 15_000;

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function remaining(entry: AvailabilityEntry, now: number, fetchedAt: number): number {
  if (!entry.until) return entry.remainingMs;
  return Math.max(0, Date.parse(entry.until) - now) || Math.max(0, entry.remainingMs - (now - fetchedAt));
}

export default function ModelAvailabilityBadge() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now);
  const root = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ['x-accounts-availability'],
    queryFn: ({ signal }) => apiFetch<AvailabilityResponse>(ENDPOINT, { signal }),
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  const clear = useMutation({
    mutationFn: (body: ClearBody) => apiFetch<unknown>('/api/x-accounts/cooldowns/clear', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['x-accounts-availability'] }),
  });

  // Tick once a second while the panel is open so countdowns stay live.
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const entries = query.data?.models ?? [];
  const count = query.data?.unavailableCount ?? entries.length;
  const fetchedAt = query.dataUpdatedAt || now;
  const healthy = !query.isError && count === 0;

  const label = query.isError ? 'Availability unknown' : healthy ? 'All models available' : `${count} on cooldown`;
  const tone = query.isError
    ? 'border-border bg-muted text-muted-foreground'
    : healthy
      ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400';

  return (
    <div ref={root} className="relative inline-block" data-testid="model-availability-badge">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${tone}`}
      >
        <span aria-hidden className={`h-2 w-2 rounded-full ${healthy ? 'bg-green-500' : query.isError ? 'bg-muted-foreground' : 'bg-amber-500'}`} />
        {label}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Model availability"
          className="absolute right-0 z-50 mt-2 w-96 max-w-[90vw] rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">Cooldowns &amp; exhausted quota</span>
            {entries.length > 0 && (
              <button
                type="button"
                disabled={clear.isPending}
                onClick={() => clear.mutate({})}
                className="rounded border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-50"
              >
                Clear All
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">Every account and model is available.</p>
          ) : (
            <ul className="max-h-72 space-y-2 overflow-auto">
              {entries.map(entry => (
                <li
                  key={`${entry.accountId}|${entry.model ?? ''}|${entry.status}`}
                  className="flex items-center justify-between gap-2 rounded border p-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {entry.accountLabel}{entry.provider ? ` · ${entry.provider}` : ''}
                    </div>
                    <div className="truncate text-muted-foreground">{entry.model ?? 'All models'}</div>
                    <div className="text-amber-600 dark:text-amber-400">
                      {entry.status === 'quota_exhausted' ? 'Quota exhausted' : 'Cooldown'}
                      {entry.until || entry.remainingMs ? ` · ${formatCountdown(remaining(entry, now, fetchedAt))}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={clear.isPending}
                    onClick={() => clear.mutate({ accountId: entry.accountId, ...(entry.model ? { model: entry.model } : {}) })}
                    className="shrink-0 rounded border px-2 py-0.5 hover:bg-accent disabled:opacity-50"
                  >
                    Clear Cooldown
                  </button>
                </li>
              ))}
            </ul>
          )}
          {clear.isError && <p className="mt-2 text-xs text-destructive">Could not clear cooldown. Try again.</p>}
        </div>
      )}
    </div>
  );
}
