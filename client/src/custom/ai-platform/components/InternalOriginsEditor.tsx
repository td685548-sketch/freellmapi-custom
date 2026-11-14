import { useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  MCP_LIMITS,
  fetchAllowedInternalOrigins,
  putAllowedInternalOrigins,
} from '../mcp-api';
import {
  MCP_ACTION_FORBIDDEN,
  MCP_NO_ORIGINS,
  MCP_ORIGINS_ADD,
  MCP_ORIGINS_DESC,
  MCP_ORIGINS_HEADING,
  MCP_ORIGINS_INVALID,
  MCP_ORIGINS_PRIMARY_ONLY,
  MCP_ORIGINS_REMOVE,
  MCP_ORIGINS_SAVE,
  MCP_ORIGINS_SAVED,
  MCP_SAVING,
} from '../mcp-strings';

interface InternalOriginsEditorProps {
  isPrimary: boolean;
}

function isValidExactOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('*')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
    if (parsed.search || parsed.hash) return null;
    // Reject trailing slash if user typed https://host/
    if (trimmed !== parsed.origin) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function InternalOriginsEditor({ isPrimary }: InternalOriginsEditorProps) {
  const tc = useCustomT();
  const [origins, setOrigins] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(!isPrimary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const loading = isPrimary && !loaded;

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    if (!isPrimary) return () => { mountedRef.current = false; };

    const ac = new AbortController();
    abortRef.current = ac;

    fetchAllowedInternalOrigins(ac.signal)
      .then((res) => {
        if (!mountedRef.current || ac.signal.aborted) return;
        setOrigins(res.origins);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError((err as Error)?.message ?? 'Failed to load internal origins');
      })
      .finally(() => {
        if (mountedRef.current) setLoaded(true);
      });

    return () => {
      mountedRef.current = false;
      ac.abort();
    };
  }, [isPrimary]);

  if (!isPrimary) {
    return (
      <section className="rounded-lg border bg-card p-4" data-testid="mcp-internal-origins">
        <h3 className="text-base font-medium">{tc(MCP_ORIGINS_HEADING)}</h3>
        <p className="text-xs text-muted-foreground mt-1">{tc(MCP_ORIGINS_PRIMARY_ONLY)}</p>
      </section>
    );
  }

  function handleAdd() {
    setError(null);
    setSavedNotice(false);
    const normalized = isValidExactOrigin(draft);
    if (!normalized) {
      setError(tc(MCP_ORIGINS_INVALID));
      return;
    }
    if (origins.includes(normalized)) {
      setDraft('');
      return;
    }
    if (origins.length >= MCP_LIMITS.maxAllowedOrigins) {
      setError(`Max ${MCP_LIMITS.maxAllowedOrigins} origins`);
      return;
    }
    setOrigins((prev) => [...prev, normalized]);
    setDraft('');
  }

  async function handleSave() {
    if (saving) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setSaving(true);
    setError(null);
    setSavedNotice(false);
    try {
      const res = await putAllowedInternalOrigins({ origins }, ac.signal);
      if (!mountedRef.current) return;
      setOrigins(res.origins);
      setSavedNotice(true);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      if ((err as { name?: string })?.name === 'AbortError') return;
      const status = (err as { status?: number })?.status;
      setError(
        status === 403
          ? tc(MCP_ACTION_FORBIDDEN)
          : (err as Error)?.message ?? 'Failed to save origins',
      );
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="mcp-internal-origins">
      <div>
        <h3 className="text-base font-medium">{tc(MCP_ORIGINS_HEADING)}</h3>
        <p className="text-xs text-muted-foreground mt-0.5">{tc(MCP_ORIGINS_DESC)}</p>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {savedNotice && (
        <div className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300" role="status">
          {tc(MCP_ORIGINS_SAVED)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          data-testid="mcp-origin-input"
          value={draft}
          placeholder="https://mcp.internal:8443"
          onChange={(e) => setDraft(e.target.value)}
          className="flex-1 min-w-[240px] rounded border bg-background px-2 py-1.5 text-sm font-mono"
        />
        <button
          type="button"
          data-testid="mcp-origin-add"
          onClick={handleAdd}
          className="rounded border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          {tc(MCP_ORIGINS_ADD)}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : origins.length === 0 ? (
        <p className="text-xs text-muted-foreground">{tc(MCP_NO_ORIGINS)}</p>
      ) : (
        <ul className="space-y-1.5">
          {origins.map((origin) => (
            <li key={origin} className="flex items-center justify-between rounded border px-3 py-1.5 text-xs font-mono">
              <span>{origin}</span>
              <button
                type="button"
                onClick={() => {
                  setSavedNotice(false);
                  setOrigins((prev) => prev.filter((o) => o !== origin));
                }}
                className="text-destructive hover:underline"
              >
                {tc(MCP_ORIGINS_REMOVE)}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        data-testid="mcp-origin-save"
        disabled={saving || loading}
        onClick={handleSave}
        className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
      >
        {saving ? tc(MCP_SAVING) : tc(MCP_ORIGINS_SAVE)}
      </button>
    </section>
  );
}
