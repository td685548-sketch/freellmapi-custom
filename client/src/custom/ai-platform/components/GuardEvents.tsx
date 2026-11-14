import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import {
  fetchGuardEventExcerpt,
  fetchGuardEvents,
  type GuardEventAction,
  type GuardEventExcerptResponse,
  type GuardEventView,
  type Scope,
} from '../output-guard-api';
import {
  GUARD_COL_ACTION,
  GUARD_COL_DETECTOR,
  GUARD_COL_EXCERPT,
  GUARD_COL_SCOPE,
  GUARD_COL_TIME,
  GUARD_COL_WIRE,
  GUARD_EVENTS_ALL_ACTIONS,
  GUARD_EVENTS_APPLY_FILTERS,
  GUARD_EVENTS_EMPTY,
  GUARD_EVENTS_ERROR,
  GUARD_EVENTS_FILTER_ACTION,
  GUARD_EVENTS_FILTER_DETECTOR,
  GUARD_EVENTS_HEADING,
  GUARD_EVENTS_LOADING,
  GUARD_EVENTS_LOAD_MORE,
  GUARD_EVENTS_METADATA_NOTICE,
  GUARD_EXCERPT_ERROR,
  GUARD_EXCERPT_EXPIRED,
  GUARD_EXCERPT_LOADING,
  GUARD_EXCERPT_LOOKUP_ID,
  GUARD_EXCERPT_LOOKUP_PLACEHOLDER,
  GUARD_EXCERPT_NOT_FOUND,
  GUARD_EXCERPT_ONLY_NOTICE,
  GUARD_EXCERPT_PERMISSION_REQUIRED,
  GUARD_HIDE_EXCERPT,
  GUARD_VIEW_EXCERPT,
} from '../output-guard-strings';

export interface GuardEventsProps {
  canViewEvents: boolean;
  canViewExcerpts: boolean;
  scope?: Scope;
  sessionRevision: number;
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { status?: number }).status;
}

export function GuardEvents({
  canViewEvents,
  canViewExcerpts,
  scope,
  sessionRevision,
}: GuardEventsProps) {
  const tc = useCustomT();

  const [events, setEvents] = useState<GuardEventView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detectorFilter, setDetectorFilter] = useState('');
  const [actionFilter, setActionFilter] = useState<GuardEventAction | ''>('');

  const [excerptsById, setExcerptsById] = useState<Record<string, GuardEventExcerptResponse>>({});
  const [excerptErrorById, setExcerptErrorById] = useState<Record<string, string>>({});
  const [loadingExcerptId, setLoadingExcerptId] = useState<string | null>(null);
  const [lookupId, setLookupId] = useState('');

  const listEpochRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const excerptEpochRef = useRef(0);
  const excerptAbortRef = useRef<AbortController | null>(null);

  const loadEvents = useCallback(
    async (opts?: { before?: string; append?: boolean; detector?: string; action?: GuardEventAction | '' }) => {
      if (!canViewEvents) return;
      const epoch = ++listEpochRef.current;
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;

      if (opts?.append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }

      try {
        const res = await fetchGuardEvents(
          {
            scope,
            detector: opts?.detector ?? detectorFilter,
            action: opts?.action ?? actionFilter,
            before: opts?.before,
          },
          controller.signal,
        );
        if (listEpochRef.current !== epoch) return;
        setEvents((prev) => (opts?.append ? [...prev, ...res.events] : res.events));
        setNextBefore(res.nextBefore);
      } catch (err) {
        if (controller.signal.aborted || listEpochRef.current !== epoch) return;
        setError(err instanceof Error && err.message ? err.message : tc(GUARD_EVENTS_ERROR));
      } finally {
        if (listEpochRef.current === epoch) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [canViewEvents, scope, detectorFilter, actionFilter, tc],
  );

  const scopeKey = `${canViewEvents}:${scope?.kind ?? ''}:${scope?.id ?? ''}:${sessionRevision}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setExcerptsById({});
    setExcerptErrorById({});
    setLoadingExcerptId(null);
    setEvents([]);
    setNextBefore(null);
    setError(null);
  }

  // Reset & abort on unmount, scope switch, or session switch
  useEffect(() => {
    excerptEpochRef.current += 1;
    excerptAbortRef.current?.abort();
    excerptAbortRef.current = null;

    let cancelled = false;
    if (canViewEvents) {
      queueMicrotask(() => {
        if (!cancelled) {
          void loadEvents({ detector: detectorFilter, action: actionFilter });
        }
      });
    }

    return () => {
      cancelled = true;
      listEpochRef.current += 1;
      listAbortRef.current?.abort();
      listAbortRef.current = null;
      excerptEpochRef.current += 1;
      excerptAbortRef.current?.abort();
      excerptAbortRef.current = null;
    };
    // Intentionally reset only on permission, scope, or sessionRevision change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewEvents, scope?.kind, scope?.id, sessionRevision]);

  async function handleViewExcerpt(eventId: number | string) {
    if (!canViewExcerpts) return;
    const idKey = String(eventId);
    if (excerptsById[idKey]) {
      setExcerptsById((prev) => {
        const copy = { ...prev };
        delete copy[idKey];
        return copy;
      });
      return;
    }

    const epoch = ++excerptEpochRef.current;
    excerptAbortRef.current?.abort();
    const controller = new AbortController();
    excerptAbortRef.current = controller;

    setLoadingExcerptId(idKey);
    setExcerptErrorById((prev) => {
      const copy = { ...prev };
      delete copy[idKey];
      return copy;
    });

    try {
      const res = await fetchGuardEventExcerpt(eventId, controller.signal);
      if (excerptEpochRef.current !== epoch) return;
      setExcerptsById((prev) => ({ ...prev, [idKey]: res }));
    } catch (err) {
      if (controller.signal.aborted || excerptEpochRef.current !== epoch) return;
      const status = getErrorStatus(err);
      let msg = tc(GUARD_EXCERPT_ERROR);
      if (status === 410) msg = tc(GUARD_EXCERPT_EXPIRED);
      else if (status === 404) msg = tc(GUARD_EXCERPT_NOT_FOUND);
      else if (status === 403) msg = tc(GUARD_EXCERPT_PERMISSION_REQUIRED);
      setExcerptErrorById((prev) => ({ ...prev, [idKey]: msg }));
    } finally {
      if (excerptEpochRef.current === epoch) {
        setLoadingExcerptId(null);
      }
    }
  }

  return (
    <section className="rounded-lg border p-4 space-y-4" data-testid="guard-events-section">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{tc(GUARD_EVENTS_HEADING)}</h3>
        <p className="text-xs text-muted-foreground" data-testid="guard-events-metadata-notice">
          {tc(GUARD_EVENTS_METADATA_NOTICE)}
        </p>
        {!canViewExcerpts && (
          <p className="text-xs text-amber-600" data-testid="guard-excerpt-permission-notice">
            {tc(GUARD_EXCERPT_PERMISSION_REQUIRED)}
          </p>
        )}
      </div>

      {/* Excerpt-only mode (has view_guard_excerpts, lacks view_output_guard) */}
      {!canViewEvents && canViewExcerpts && (
        <div className="space-y-3" data-testid="guard-excerpt-only-panel">
          <p className="text-xs text-muted-foreground">{tc(GUARD_EXCERPT_ONLY_NOTICE)}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="space-y-1 text-xs">
              <span>{tc(GUARD_EXCERPT_LOOKUP_ID)}</span>
              <input
                type="text"
                className="block rounded border px-2 py-1 text-sm bg-background"
                data-testid="guard-excerpt-lookup-input"
                placeholder={tc(GUARD_EXCERPT_LOOKUP_PLACEHOLDER)}
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
              data-testid="guard-excerpt-lookup-btn"
              disabled={!lookupId.trim() || loadingExcerptId === lookupId.trim()}
              onClick={() => handleViewExcerpt(lookupId.trim())}
            >
              {loadingExcerptId === lookupId.trim() ? tc(GUARD_EXCERPT_LOADING) : tc(GUARD_VIEW_EXCERPT)}
            </button>
          </div>
          {lookupId.trim() && excerptErrorById[lookupId.trim()] && (
            <p className="text-xs text-red-600" role="alert" data-testid="guard-excerpt-error">
              {excerptErrorById[lookupId.trim()]}
            </p>
          )}
          {lookupId.trim() && excerptsById[lookupId.trim()] && (
            <pre className="whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs" data-testid="guard-excerpt-content">
              {excerptsById[lookupId.trim()].excerpt}
            </pre>
          )}
        </div>
      )}

      {/* Full metadata event list (requires view_output_guard) */}
      {canViewEvents && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-xs">
              <span>{tc(GUARD_EVENTS_FILTER_DETECTOR)}</span>
              <input
                type="text"
                className="block rounded border px-2 py-1 text-sm bg-background"
                data-testid="guard-events-filter-detector"
                value={detectorFilter}
                onChange={(e) => setDetectorFilter(e.target.value)}
              />
            </label>

            <label className="space-y-1 text-xs">
              <span>{tc(GUARD_EVENTS_FILTER_ACTION)}</span>
              <select
                className="block rounded border px-2 py-1 text-sm bg-background"
                data-testid="guard-events-filter-action"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value as GuardEventAction | '')}
              >
                <option value="">{tc(GUARD_EVENTS_ALL_ACTIONS)}</option>
                <option value="logged">logged</option>
                <option value="masked">masked</option>
                <option value="blocked">blocked</option>
                <option value="bypassed">bypassed</option>
                <option value="check_failed">check_failed</option>
              </select>
            </label>

            <button
              type="button"
              className="rounded border px-3 py-1 text-sm hover:bg-muted"
              data-testid="guard-events-apply-filters-btn"
              onClick={() => void loadEvents({ detector: detectorFilter, action: actionFilter })}
            >
              {tc(GUARD_EVENTS_APPLY_FILTERS)}
            </button>
          </div>

          {loading && (
            <p className="text-sm text-muted-foreground" data-testid="guard-events-loading">
              {tc(GUARD_EVENTS_LOADING)}
            </p>
          )}

          {error && (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert" data-testid="guard-events-error">
              {error}
            </div>
          )}

          {!loading && !error && events.length === 0 && (
            <p className="text-sm text-muted-foreground" data-testid="guard-events-empty">
              {tc(GUARD_EVENTS_EMPTY)}
            </p>
          )}

          {events.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse" data-testid="guard-events-table">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="py-2 pr-3">{tc(GUARD_COL_TIME)}</th>
                    <th className="py-2 pr-3">{tc(GUARD_COL_SCOPE)}</th>
                    <th className="py-2 pr-3">{tc(GUARD_COL_DETECTOR)}</th>
                    <th className="py-2 pr-3">{tc(GUARD_COL_ACTION)}</th>
                    <th className="py-2 pr-3">{tc(GUARD_COL_WIRE)}</th>
                    <th className="py-2">{tc(GUARD_COL_EXCERPT)}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => {
                    const idKey = String(ev.id);
                    const loadedExcerpt = excerptsById[idKey];
                    const excerptErr = excerptErrorById[idKey];
                    const isLoadingExcerpt = loadingExcerptId === idKey;
                    return (
                      <tr key={idKey} className="border-b align-top" data-testid={`guard-event-row-${idKey}`}>
                        <td className="py-2 pr-3 whitespace-nowrap">{ev.createdAt}</td>
                        <td className="py-2 pr-3 font-mono">{ev.scopeKind}:{ev.scopeId}</td>
                        <td className="py-2 pr-3 font-mono">{ev.detector}</td>
                        <td className="py-2 pr-3 font-mono">{ev.action}</td>
                        <td className="py-2 pr-3 font-mono">
                          {ev.wire ?? '-'}{ev.streamed ? ' (stream)' : ''}
                        </td>
                        <td className="py-2 space-y-1">
                          {canViewExcerpts && (ev.hasExcerpt || ev.excerptExpiresAt) ? (
                            <button
                              type="button"
                              className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
                              data-testid={`guard-view-excerpt-${idKey}`}
                              disabled={isLoadingExcerpt}
                              onClick={() => void handleViewExcerpt(ev.id)}
                            >
                              {isLoadingExcerpt
                                ? tc(GUARD_EXCERPT_LOADING)
                                : loadedExcerpt
                                  ? tc(GUARD_HIDE_EXCERPT)
                                  : tc(GUARD_VIEW_EXCERPT)}
                            </button>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                          {excerptErr && (
                            <p className="text-red-600" role="alert" data-testid={`guard-excerpt-error-${idKey}`}>
                              {excerptErr}
                            </p>
                          )}
                          {loadedExcerpt && (
                            <pre
                              className="whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs max-w-md"
                              data-testid={`guard-excerpt-content-${idKey}`}
                            >
                              {loadedExcerpt.excerpt}
                            </pre>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {nextBefore && (
            <div className="flex justify-center">
              <button
                type="button"
                className="rounded border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                data-testid="guard-events-load-more-btn"
                disabled={loadingMore}
                onClick={() => void loadEvents({ before: nextBefore, append: true })}
              >
                {tc(GUARD_EVENTS_LOAD_MORE)}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
