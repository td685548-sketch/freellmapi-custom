import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  fetchMcpCalls,
  type McpCallView,
  type McpServerView,
  type McpToolCallStatus,
} from '../mcp-api';
import {
  MCP_CALLS_HEADING,
  MCP_CALL_ALL_SERVERS,
  MCP_CALL_BYTES,
  MCP_CALL_DURATION,
  MCP_CALL_FILTER_SERVER,
  MCP_CALL_FILTER_STATUS,
  MCP_CALL_LOAD_MORE,
  MCP_CALL_MASKED_RESULT,
  MCP_CALL_SCOPE,
  MCP_CALL_TIME,
  MCP_MASKED_ARGS,
  MCP_NO_CALLS,
  MCP_REFRESH,
  MCP_STATUS_ALL,
  MCP_TOOL_NAME,
} from '../mcp-strings';

interface McpCallLogProps {
  servers: McpServerView[];
}

const CALL_STATUSES: McpToolCallStatus[] = [
  'ok',
  'tool_error',
  'timeout',
  'too_large',
  'blocked',
  'transport_error',
  'awaiting_approval',
  'rejected',
];

export function McpCallLog({ servers }: McpCallLogProps) {
  const tc = useCustomT();
  const [serverId, setServerId] = useState<string>('');
  const [status, setStatus] = useState<McpToolCallStatus | ''>('');
  const [calls, setCalls] = useState<McpCallView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryKey = `${serverId}:${status}:${refreshTick}`;
  const loading = loadedKey !== queryKey;

  const abortRef = useRef<AbortController | null>(null);
  const epochRef = useRef(0);
  const mountedRef = useRef(true);

  const loadCalls = useCallback(
    (before?: string) => {
      const isMore = Boolean(before);
      if (!isMore) {
        epochRef.current += 1;
        abortRef.current?.abort();
      }
      const callEpoch = epochRef.current;
      const ac = new AbortController();
      abortRef.current = ac;

      if (isMore) setLoadingMore(true);

      fetchMcpCalls(
        {
          serverId: serverId ? Number(serverId) : undefined,
          status: status || undefined,
          before,
        },
        ac.signal,
      )
        .then((res) => {
          if (!mountedRef.current || callEpoch !== epochRef.current || ac.signal.aborted) return;
          setError(null);
          setCalls((prev) => (isMore ? [...prev, ...res.calls] : res.calls));
          setNextBefore(res.nextBefore);
        })
        .catch((err: unknown) => {
          if (!mountedRef.current || callEpoch !== epochRef.current) return;
          if ((err as { name?: string })?.name === 'AbortError') return;
          setError((err as Error)?.message ?? 'Failed to load call log');
        })
        .finally(() => {
          if (mountedRef.current && callEpoch === epochRef.current) {
            setLoadedKey(queryKey);
            setLoadingMore(false);
          }
        });
    },
    [serverId, status, queryKey],
  );

  useEffect(() => {
    mountedRef.current = true;
    epochRef.current += 1;
    const callEpoch = epochRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    fetchMcpCalls(
      {
        serverId: serverId ? Number(serverId) : undefined,
        status: status || undefined,
      },
      ac.signal,
    )
      .then((res) => {
        if (!mountedRef.current || callEpoch !== epochRef.current || ac.signal.aborted) return;
        setError(null);
        setCalls(res.calls);
        setNextBefore(res.nextBefore);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || callEpoch !== epochRef.current) return;
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError((err as Error)?.message ?? 'Failed to load call log');
      })
      .finally(() => {
        if (mountedRef.current && callEpoch === epochRef.current) {
          setLoadedKey(queryKey);
        }
      });

    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [serverId, status, queryKey]);

  return (
    <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="mcp-call-log">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{tc(MCP_CALLS_HEADING)}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs flex items-center gap-1.5">
            <span>{tc(MCP_CALL_FILTER_SERVER)}</span>
            <select
              data-testid="mcp-calls-filter-server"
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="">{tc(MCP_CALL_ALL_SERVERS)}</option>
              {servers.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.slug}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs flex items-center gap-1.5">
            <span>{tc(MCP_CALL_FILTER_STATUS)}</span>
            <select
              data-testid="mcp-calls-filter-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as McpToolCallStatus | '')}
              className="rounded border bg-background px-2 py-1 text-xs"
            >
              <option value="">{tc(MCP_STATUS_ALL)}</option>
              {CALL_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="rounded border px-2 py-1 text-xs hover:bg-muted"
          >
            {tc(MCP_REFRESH)}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : calls.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tc(MCP_NO_CALLS)}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3">{tc(MCP_CALL_TIME)}</th>
                <th className="py-2 pr-3">{tc(MCP_CALL_SCOPE)}</th>
                <th className="py-2 pr-3">{tc(MCP_TOOL_NAME)}</th>
                <th className="py-2 pr-3">{tc(MCP_CALL_FILTER_STATUS)}</th>
                <th className="py-2 pr-3">{tc(MCP_CALL_DURATION)}</th>
                <th className="py-2 pr-3">{tc(MCP_CALL_BYTES)}</th>
                <th className="py-2 pr-3">{tc(MCP_MASKED_ARGS)}</th>
                <th className="py-2">{tc(MCP_CALL_MASKED_RESULT)}</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => (
                <tr key={c.id} className="border-b last:border-b-0 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{c.createdAt}</td>
                  <td className="py-2 pr-3 font-mono">{`${c.scopeKind}:${c.scopeId}`}</td>
                  <td className="py-2 pr-3 font-mono">{c.serverSlug ? `${c.serverSlug}/${c.toolName}` : c.toolName}</td>
                  <td className="py-2 pr-3">{c.status}</td>
                  <td className="py-2 pr-3">{c.durationMs} ms</td>
                  <td className="py-2 pr-3">{c.resultBytes}</td>
                  <td className="py-2 pr-3 font-mono max-w-[180px] truncate" title={c.argsMasked ?? ''}>
                    {c.argsMasked ?? '—'}
                  </td>
                  <td className="py-2 font-mono max-w-[220px] truncate" title={c.resultMasked ?? ''}>
                    {c.resultMasked ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextBefore && (
        <button
          type="button"
          data-testid="mcp-calls-load-more"
          disabled={loadingMore}
          onClick={() => loadCalls(nextBefore)}
          className="rounded border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          {tc(MCP_CALL_LOAD_MORE)}
        </button>
      )}
    </section>
  );
}
