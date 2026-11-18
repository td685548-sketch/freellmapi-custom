import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useSessionRevision } from '../../session-state';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import {
  SEMANTIC_CACHE_LIMITS,
  createDefaultSemanticCacheSettings,
  createDefaultSemanticCacheStats,
  fetchSemanticCacheSettings,
  fetchSemanticCacheStats,
  flushSemanticCache,
  getSemanticCacheErrorInfo,
  previewSemanticCacheLookup,
  updateSemanticCacheSettings,
  type Scope,
  type ScopeKind,
  type SemanticCacheEntrySummary,
  type SemanticCacheLookupPreviewResponse,
  type SemanticCacheLookupStatus,
  type SemanticCacheSettings,
  type SemanticCacheStats,
  type Wire,
} from '../semantic-cache-api';
import {
  SEM_CACHE_COL_CONTRACT,
  SEM_CACHE_COL_EXPIRES,
  SEM_CACHE_COL_HITS,
  SEM_CACHE_COL_MODEL,
  SEM_CACHE_COL_TIER,
  SEM_CACHE_COL_TOKENS,
  SEM_CACHE_COL_WIRE,
  SEM_CACHE_EDITOR_ONLY_NOTICE,
  SEM_CACHE_ENABLED_DESC,
  SEM_CACHE_ENABLED_LABEL,
  SEM_CACHE_ENTRIES_EMPTY,
  SEM_CACHE_ENTRIES_HEADING,
  SEM_CACHE_FLUSHED_MSG,
  SEM_CACHE_FLUSHING_BTN,
  SEM_CACHE_FLUSH_BTN,
  SEM_CACHE_FLUSH_ERROR,
  SEM_CACHE_FLUSH_HEADING,
  SEM_CACHE_FLUSH_MODEL_PLACEHOLDER,
  SEM_CACHE_FLUSH_RESET_METRICS,
  SEM_CACHE_FORBIDDEN_ERROR,
  SEM_CACHE_ISOLATE_END_USER_DESC,
  SEM_CACHE_ISOLATE_END_USER_LABEL,
  SEM_CACHE_LOADING_SETTINGS,
  SEM_CACHE_LOAD_BTN,
  SEM_CACHE_LOAD_SETTINGS_ERROR,
  SEM_CACHE_MAX_ENTRIES_LABEL,
  SEM_CACHE_MAX_TEMPERATURE_LABEL,
  SEM_CACHE_MIN_SIMILARITY_LABEL,
  SEM_CACHE_NO_PERMISSION,
  SEM_CACHE_PAGE_SUBTITLE,
  SEM_CACHE_PAGE_TITLE,
  SEM_CACHE_PERSIST_DB_DESC,
  SEM_CACHE_PERSIST_DB_LABEL,
  SEM_CACHE_PREVIEW_BTN,
  SEM_CACHE_PREVIEW_BYPASS_REASON,
  SEM_CACHE_PREVIEW_CONTRACT,
  SEM_CACHE_PREVIEW_END_USER_LABEL,
  SEM_CACHE_PREVIEW_ERROR,
  SEM_CACHE_PREVIEW_HEADING,
  SEM_CACHE_PREVIEW_LATENCY,
  SEM_CACHE_PREVIEW_MODEL_LABEL,
  SEM_CACHE_PREVIEW_NO_MATCH,
  SEM_CACHE_PREVIEW_PROMPT_HASH,
  SEM_CACHE_PREVIEW_QUERY_LABEL,
  SEM_CACHE_PREVIEW_QUERY_PLACEHOLDER,
  SEM_CACHE_PREVIEW_RESPONSE_LABEL,
  SEM_CACHE_PREVIEW_RUNNING_BTN,
  SEM_CACHE_PREVIEW_SCORE,
  SEM_CACHE_PREVIEW_SUBTITLE,
  SEM_CACHE_PREVIEW_TEMP_LABEL,
  SEM_CACHE_PREVIEW_WIRE_LABEL,
  SEM_CACHE_SAVED_MSG,
  SEM_CACHE_SAVE_BTN,
  SEM_CACHE_SAVE_ERROR,
  SEM_CACHE_SAVING_BTN,
  SEM_CACHE_SCOPE_AGENT,
  SEM_CACHE_SCOPE_ID,
  SEM_CACHE_SCOPE_ID_PLACEHOLDER,
  SEM_CACHE_SCOPE_KIND,
  SEM_CACHE_SCOPE_PROFILE,
  SEM_CACHE_SCOPE_REQUIRED,
  SEM_CACHE_SCOPE_SUPPORT_TENANT,
  SEM_CACHE_SEMANTIC_ENABLED_DESC,
  SEM_CACHE_SEMANTIC_ENABLED_LABEL,
  SEM_CACHE_SESSION_EXPIRED,
  SEM_CACHE_SETTINGS_HEADING,
  SEM_CACHE_STATE_OFF,
  SEM_CACHE_STATE_ON,
  SEM_CACHE_STATS_ERROR,
  SEM_CACHE_STATS_HEADING,
  SEM_CACHE_STATS_LOADING,
  SEM_CACHE_STATS_REFRESH_BTN,
  SEM_CACHE_STATUS_BYPASSED,
  SEM_CACHE_STATUS_EXACT_HIT,
  SEM_CACHE_STATUS_MISS,
  SEM_CACHE_STATUS_SEMANTIC_HIT,
  SEM_CACHE_STAT_BYPASSED,
  SEM_CACHE_STAT_ENTRIES,
  SEM_CACHE_STAT_EXACT_HITS,
  SEM_CACHE_STAT_HIT_RATE,
  SEM_CACHE_STAT_MISSES,
  SEM_CACHE_STAT_SEMANTIC_HITS,
  SEM_CACHE_STAT_TOKENS_SAVED,
  SEM_CACHE_TTL_SECONDS_LABEL,
  SEM_CACHE_UPDATED_AT,
  SEM_CACHE_VEC_EXACT_ONLY,
  SEM_CACHE_VEC_READY,
  SEM_CACHE_VIEW_ONLY_NOTICE,
} from '../semantic-cache-strings';

export interface SemanticCacheProps {
  canView?: boolean;
  canEdit?: boolean;
}

const STATUS_LABEL_KEY: Record<SemanticCacheLookupStatus, string> = {
  EXACT_HIT: SEM_CACHE_STATUS_EXACT_HIT,
  SEMANTIC_HIT: SEM_CACHE_STATUS_SEMANTIC_HIT,
  MISS: SEM_CACHE_STATUS_MISS,
  BYPASSED: SEM_CACHE_STATUS_BYPASSED,
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function clampFloat(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, raw));
}

function clampInt(raw: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function formatHitRate(ratio: number): string {
  const pct = ratio <= 1 ? ratio * 100 : ratio;
  return `${pct.toFixed(1)}%`;
}

function SettingSwitchRow({
  testId,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  testId: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const tc = useCustomT();
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="flex-1">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">
          {checked ? tc(SEM_CACHE_STATE_ON) : tc(SEM_CACHE_STATE_OFF)}
        </span>
        <button
          type="button"
          role="switch"
          data-testid={testId}
          aria-checked={checked}
          aria-label={label}
          disabled={disabled}
          onClick={() => {
            if (!disabled) onToggle();
          }}
          className={[
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            checked ? 'bg-primary' : 'bg-input',
            disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
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

function StatCard({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SemanticCache(props: SemanticCacheProps = {}) {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();
  const globalSessionRev = useSessionRevision();

  const canView =
    props.canView ?? (isPrimary || can('view_prompt_cache') || can('manage_ai_platform'));
  const canEdit =
    props.canEdit ?? (isPrimary || can('edit_prompt_cache') || can('manage_ai_platform'));

  const sessionRevision = useMemo(() => {
    const uid = session?.userId ?? 0;
    let idHash = 0;
    for (let i = 0; i < identity.length; i += 1) {
      idHash = (idHash * 31 + identity.charCodeAt(i)) | 0;
    }
    return uid * 10_000 + Math.abs(idHash % 1000) + globalSessionRev * 1000;
  }, [session?.userId, identity, globalSessionRev]);

  if (!canView && !canEdit) {
    return (
      <div data-testid="semantic-cache-no-permission">
        <p className="text-sm text-muted-foreground">{tc(SEM_CACHE_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <SemanticCacheContent
      key={sessionRevision}
      sessionRevision={sessionRevision}
      canView={canView}
      canEdit={canEdit}
    />
  );
}

function SemanticCacheContent({
  sessionRevision,
  canView,
  canEdit,
}: {
  sessionRevision: number;
  canView: boolean;
  canEdit: boolean;
}) {
  const tc = useCustomT();

  // Scope selection state
  const [draftScopeKind, setDraftScopeKind] = useState<ScopeKind>('profile');
  const [draftScopeId, setDraftScopeId] = useState('1');
  const [activeScope, setActiveScope] = useState<Scope>({ kind: 'profile', id: '1' });
  const [scopeValidationError, setScopeValidationError] = useState<string | null>(null);

  // Settings state
  const [settings, setSettings] = useState<SemanticCacheSettings>(() =>
    createDefaultSemanticCacheSettings('profile', '1'),
  );
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedBanner, setSavedBanner] = useState(false);

  // Stats & entries state
  const [stats, setStats] = useState<SemanticCacheStats>(() => createDefaultSemanticCacheStats());
  const [recentEntries, setRecentEntries] = useState<SemanticCacheEntrySummary[]>([]);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Flush state
  const [flushModel, setFlushModel] = useState('');
  const [flushResetMetrics, setFlushResetMetrics] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [flushError, setFlushError] = useState<string | null>(null);
  const [flushedCount, setFlushedCount] = useState<number | null>(null);

  // Lookup preview state
  const [previewQuery, setPreviewQuery] = useState('');
  const [previewModel, setPreviewModel] = useState('auto');
  const [previewWire, setPreviewWire] = useState<Wire>('openai-chat');
  const [previewTemp, setPreviewTemp] = useState('0');
  const [previewEndUser, setPreviewEndUser] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewResult, setPreviewResult] = useState<SemanticCacheLookupPreviewResponse | null>(
    null,
  );

  // AbortController & epoch refs
  const mountedRef = useRef(true);
  const settingsAbortRef = useRef<AbortController | null>(null);
  const saveAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  const flushAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);

  const formatError = useCallback(
    (err: unknown, fallback: string): string => {
      const info = getSemanticCacheErrorInfo(err);
      if (info.status === 401) return tc(SEM_CACHE_SESSION_EXPIRED);
      if (info.status === 403) return tc(SEM_CACHE_FORBIDDEN_ERROR);
      return info.message || fallback;
    },
    [tc],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settingsAbortRef.current?.abort();
      saveAbortRef.current?.abort();
      statsAbortRef.current?.abort();
      flushAbortRef.current?.abort();
      previewAbortRef.current?.abort();
    };
  }, []);

  const loadSettings = useCallback(
    async (target: Scope) => {
      if (!canView || !target.id) return;
      settingsAbortRef.current?.abort();
      const controller = new AbortController();
      settingsAbortRef.current = controller;

      setLoadingSettings(true);
      setSettingsLoadError(null);
      try {
        const res = await fetchSemanticCacheSettings(target.kind, target.id, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setSettings(res.settings);
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
        setSettingsLoadError(formatError(err, tc(SEM_CACHE_LOAD_SETTINGS_ERROR)));
      } finally {
        if (mountedRef.current && !controller.signal.aborted) {
          setLoadingSettings(false);
        }
      }
    },
    [canView, formatError, tc],
  );

  const loadStats = useCallback(
    async (target: Scope) => {
      if (!canView || !target.id) return;
      statsAbortRef.current?.abort();
      const controller = new AbortController();
      statsAbortRef.current = controller;

      setLoadingStats(true);
      setStatsError(null);
      try {
        const res = await fetchSemanticCacheStats(target.kind, target.id, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        setStats(res.stats);
        setRecentEntries(res.recentEntries);
      } catch (err) {
        if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
        setStatsError(formatError(err, tc(SEM_CACHE_STATS_ERROR)));
      } finally {
        if (mountedRef.current && !controller.signal.aborted) {
          setLoadingStats(false);
        }
      }
    },
    [canView, formatError, tc],
  );

  useEffect(() => {
    if (!canView || !activeScope.id) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadSettings(activeScope);
        void loadStats(activeScope);
      }
    });
    return () => {
      cancelled = true;
      settingsAbortRef.current?.abort();
      statsAbortRef.current?.abort();
    };
  }, [activeScope, canView, loadSettings, loadStats, sessionRevision]);

  function handleLoadScope(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = draftScopeId.trim();
    if (!trimmed) {
      setScopeValidationError(tc(SEM_CACHE_SCOPE_REQUIRED));
      return;
    }
    setScopeValidationError(null);
    setSavedBanner(false);
    setSaveError(null);
    setFlushedCount(null);
    setFlushError(null);
    setPreviewResult(null);
    setPreviewError(null);
    setActiveScope({ kind: draftScopeKind, id: trimmed });
  }

  async function handleSaveSettings() {
    if (!canEdit || savingSettings) return;
    saveAbortRef.current?.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;

    setSavingSettings(true);
    setSaveError(null);
    setSavedBanner(false);

    try {
      const res = await updateSemanticCacheSettings(
        activeScope.kind,
        activeScope.id,
        {
          enabled: settings.enabled,
          semanticEnabled: settings.semanticEnabled,
          minSimilarity: clampFloat(
            settings.minSimilarity,
            SEMANTIC_CACHE_LIMITS.minAllowedSimilarity,
            SEMANTIC_CACHE_LIMITS.maxAllowedSimilarity,
            SEMANTIC_CACHE_LIMITS.defaultMinSimilarity,
          ),
          maxTemperature: clampFloat(
            settings.maxTemperature,
            SEMANTIC_CACHE_LIMITS.minAllowedTemperature,
            SEMANTIC_CACHE_LIMITS.maxAllowedTemperature,
            SEMANTIC_CACHE_LIMITS.defaultMaxTemperature,
          ),
          ttlSeconds: clampInt(
            settings.ttlSeconds,
            SEMANTIC_CACHE_LIMITS.minTtlSeconds,
            SEMANTIC_CACHE_LIMITS.maxTtlSeconds,
            SEMANTIC_CACHE_LIMITS.defaultTtlSeconds,
          ),
          maxEntries: clampInt(
            settings.maxEntries,
            SEMANTIC_CACHE_LIMITS.minMaxEntries,
            SEMANTIC_CACHE_LIMITS.maxMaxEntries,
            SEMANTIC_CACHE_LIMITS.defaultMaxEntries,
          ),
          persistToDb: settings.persistToDb,
          isolateByEndUser: settings.isolateByEndUser,
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setSettings(res.settings);
      setSavedBanner(true);
      if (canView) void loadStats(activeScope);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setSaveError(formatError(err, tc(SEM_CACHE_SAVE_ERROR)));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setSavingSettings(false);
      }
    }
  }

  async function handleFlush(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || flushing) return;
    flushAbortRef.current?.abort();
    const controller = new AbortController();
    flushAbortRef.current = controller;

    setFlushing(true);
    setFlushError(null);
    setFlushedCount(null);

    try {
      const modelFilter = flushModel.trim();
      const res = await flushSemanticCache(
        activeScope.kind,
        activeScope.id,
        {
          resetMetrics: flushResetMetrics,
          ...(modelFilter ? { model: modelFilter } : {}),
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setFlushedCount(res.deletedEntries);
      if (canView) void loadStats(activeScope);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setFlushError(formatError(err, tc(SEM_CACHE_FLUSH_ERROR)));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setFlushing(false);
      }
    }
  }

  async function handlePreview(e: React.FormEvent) {
    e.preventDefault();
    if (!canView || previewLoading) return;
    previewAbortRef.current?.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const parsedTemp = Number.parseFloat(previewTemp);
      const res = await previewSemanticCacheLookup(
        activeScope.kind,
        activeScope.id,
        {
          query: previewQuery,
          model: previewModel.trim() || 'auto',
          wire: previewWire,
          ...(Number.isFinite(parsedTemp) ? { temperature: parsedTemp } : {}),
          ...(previewEndUser.trim() ? { endUser: previewEndUser.trim() } : {}),
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setPreviewResult(res);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setPreviewError(formatError(err, tc(SEM_CACHE_PREVIEW_ERROR)));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setPreviewLoading(false);
      }
    }
  }

  return (
    <div className="space-y-6" data-testid="semantic-cache-page">
      <header className="space-y-1">
        <h2 className="text-lg font-semibold">{tc(SEM_CACHE_PAGE_TITLE)}</h2>
        <p className="text-sm text-muted-foreground">{tc(SEM_CACHE_PAGE_SUBTITLE)}</p>
      </header>

      {canView && !canEdit && (
        <div
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="semantic-cache-view-only-notice"
        >
          {tc(SEM_CACHE_VIEW_ONLY_NOTICE)}
        </div>
      )}

      {!canView && canEdit && (
        <div
          className="rounded border border-amber-600/30 bg-amber-600/15 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
          data-testid="semantic-cache-editor-only-notice"
        >
          {tc(SEM_CACHE_EDITOR_ONLY_NOTICE)}
        </div>
      )}

      {/* Scope Selector */}
      <form
        onSubmit={handleLoadScope}
        className="rounded-lg border bg-card p-4 flex flex-wrap items-end gap-3"
        data-testid="semantic-cache-scope-form"
      >
        <div className="space-y-1">
          <label htmlFor="sem-cache-scope-kind" className="block text-xs font-medium">
            {tc(SEM_CACHE_SCOPE_KIND)}
          </label>
          <select
            id="sem-cache-scope-kind"
            data-testid="sem-cache-scope-kind"
            value={draftScopeKind}
            onChange={(e) => setDraftScopeKind(e.target.value as ScopeKind)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
          >
            <option value="profile">{tc(SEM_CACHE_SCOPE_PROFILE)}</option>
            <option value="support_tenant">{tc(SEM_CACHE_SCOPE_SUPPORT_TENANT)}</option>
            <option value="agent">{tc(SEM_CACHE_SCOPE_AGENT)}</option>
          </select>
        </div>

        <div className="space-y-1 flex-1 min-w-[160px]">
          <label htmlFor="sem-cache-scope-id" className="block text-xs font-medium">
            {tc(SEM_CACHE_SCOPE_ID)}
          </label>
          <input
            id="sem-cache-scope-id"
            data-testid="sem-cache-scope-id"
            type="text"
            value={draftScopeId}
            placeholder={tc(SEM_CACHE_SCOPE_ID_PLACEHOLDER)}
            onChange={(e) => setDraftScopeId(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <button
          type="submit"
          data-testid="sem-cache-load-scope-btn"
          className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          {tc(SEM_CACHE_LOAD_BTN)}
        </button>

        {scopeValidationError && (
          <p className="w-full text-xs text-destructive" role="alert">
            {scopeValidationError}
          </p>
        )}
      </form>

      {/* Section 1: Settings */}
      <section
        className="rounded-lg border bg-card p-4 space-y-4"
        data-testid="sem-cache-settings-section"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{tc(SEM_CACHE_SETTINGS_HEADING)}</h3>
          {settings.updatedAt && (
            <span className="text-xs text-muted-foreground">
              {tc(SEM_CACHE_UPDATED_AT, { time: settings.updatedAt })}
            </span>
          )}
        </div>

        {loadingSettings ? (
          <p className="text-sm text-muted-foreground" data-testid="sem-cache-settings-loading">
            {tc(SEM_CACHE_LOADING_SETTINGS)}
          </p>
        ) : settingsLoadError ? (
          <div
            className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
            data-testid="sem-cache-settings-error"
          >
            {settingsLoadError}
          </div>
        ) : (
          <>
            <div>
              <SettingSwitchRow
                testId="sem-cache-toggle-enabled"
                label={tc(SEM_CACHE_ENABLED_LABEL)}
                description={tc(SEM_CACHE_ENABLED_DESC)}
                checked={settings.enabled}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSavedBanner(false);
                  setSaveError(null);
                  setSettings((prev) => ({ ...prev, enabled: !prev.enabled }));
                }}
              />
              <SettingSwitchRow
                testId="sem-cache-toggle-semantic"
                label={tc(SEM_CACHE_SEMANTIC_ENABLED_LABEL)}
                description={tc(SEM_CACHE_SEMANTIC_ENABLED_DESC)}
                checked={settings.semanticEnabled}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSavedBanner(false);
                  setSaveError(null);
                  setSettings((prev) => ({ ...prev, semanticEnabled: !prev.semanticEnabled }));
                }}
              />
              <SettingSwitchRow
                testId="sem-cache-toggle-persist"
                label={tc(SEM_CACHE_PERSIST_DB_LABEL)}
                description={tc(SEM_CACHE_PERSIST_DB_DESC)}
                checked={settings.persistToDb}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSavedBanner(false);
                  setSaveError(null);
                  setSettings((prev) => ({ ...prev, persistToDb: !prev.persistToDb }));
                }}
              />
              <SettingSwitchRow
                testId="sem-cache-toggle-isolate-user"
                label={tc(SEM_CACHE_ISOLATE_END_USER_LABEL)}
                description={tc(SEM_CACHE_ISOLATE_END_USER_DESC)}
                checked={settings.isolateByEndUser}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSavedBanner(false);
                  setSaveError(null);
                  setSettings((prev) => ({ ...prev, isolateByEndUser: !prev.isolateByEndUser }));
                }}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
              <div className="space-y-1">
                <label htmlFor="sem-cache-min-sim" className="block text-xs font-medium">
                  {tc(SEM_CACHE_MIN_SIMILARITY_LABEL)}
                </label>
                <input
                  id="sem-cache-min-sim"
                  data-testid="sem-cache-min-similarity"
                  type="number"
                  step="0.01"
                  min={SEMANTIC_CACHE_LIMITS.minAllowedSimilarity}
                  max={SEMANTIC_CACHE_LIMITS.maxAllowedSimilarity}
                  disabled={!canEdit || savingSettings}
                  value={settings.minSimilarity}
                  onChange={(e) => {
                    const next = Number.parseFloat(e.target.value);
                    setSavedBanner(false);
                    setSettings((prev) => ({
                      ...prev,
                      minSimilarity: Number.isFinite(next) ? next : prev.minSimilarity,
                    }));
                  }}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-max-temp" className="block text-xs font-medium">
                  {tc(SEM_CACHE_MAX_TEMPERATURE_LABEL)}
                </label>
                <input
                  id="sem-cache-max-temp"
                  data-testid="sem-cache-max-temperature"
                  type="number"
                  step="0.05"
                  min={SEMANTIC_CACHE_LIMITS.minAllowedTemperature}
                  max={SEMANTIC_CACHE_LIMITS.maxAllowedTemperature}
                  disabled={!canEdit || savingSettings}
                  value={settings.maxTemperature}
                  onChange={(e) => {
                    const next = Number.parseFloat(e.target.value);
                    setSavedBanner(false);
                    setSettings((prev) => ({
                      ...prev,
                      maxTemperature: Number.isFinite(next) ? next : prev.maxTemperature,
                    }));
                  }}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-ttl" className="block text-xs font-medium">
                  {tc(SEM_CACHE_TTL_SECONDS_LABEL)}
                </label>
                <input
                  id="sem-cache-ttl"
                  data-testid="sem-cache-ttl-seconds"
                  type="number"
                  min={SEMANTIC_CACHE_LIMITS.minTtlSeconds}
                  max={SEMANTIC_CACHE_LIMITS.maxTtlSeconds}
                  disabled={!canEdit || savingSettings}
                  value={settings.ttlSeconds}
                  onChange={(e) => {
                    const next = Number.parseInt(e.target.value, 10);
                    setSavedBanner(false);
                    setSettings((prev) => ({
                      ...prev,
                      ttlSeconds: Number.isFinite(next) ? next : prev.ttlSeconds,
                    }));
                  }}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-max-entries" className="block text-xs font-medium">
                  {tc(SEM_CACHE_MAX_ENTRIES_LABEL)}
                </label>
                <input
                  id="sem-cache-max-entries"
                  data-testid="sem-cache-max-entries"
                  type="number"
                  min={SEMANTIC_CACHE_LIMITS.minMaxEntries}
                  max={SEMANTIC_CACHE_LIMITS.maxMaxEntries}
                  disabled={!canEdit || savingSettings}
                  value={settings.maxEntries}
                  onChange={(e) => {
                    const next = Number.parseInt(e.target.value, 10);
                    setSavedBanner(false);
                    setSettings((prev) => ({
                      ...prev,
                      maxEntries: Number.isFinite(next) ? next : prev.maxEntries,
                    }));
                  }}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
                />
              </div>
            </div>

            {canEdit && (
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  data-testid="sem-cache-save-btn"
                  disabled={savingSettings}
                  onClick={() => void handleSaveSettings()}
                  className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {savingSettings ? tc(SEM_CACHE_SAVING_BTN) : tc(SEM_CACHE_SAVE_BTN)}
                </button>
                {savedBanner && (
                  <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
                    {tc(SEM_CACHE_SAVED_MSG)}
                  </span>
                )}
                {saveError && (
                  <span className="text-xs text-destructive" role="alert">
                    {saveError}
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* Section 2: Telemetry & Flush */}
      {canView && (
        <section
          className="rounded-lg border bg-card p-4 space-y-4"
          data-testid="sem-cache-stats-section"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold">{tc(SEM_CACHE_STATS_HEADING)}</h3>
            <button
              type="button"
              data-testid="sem-cache-refresh-stats-btn"
              onClick={() => void loadStats(activeScope)}
              className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
            >
              {tc(SEM_CACHE_STATS_REFRESH_BTN)}
            </button>
          </div>

          {loadingStats ? (
            <p className="text-sm text-muted-foreground">{tc(SEM_CACHE_STATS_LOADING)}</p>
          ) : statsError ? (
            <div
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {statsError}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <StatCard
                  testId="sem-cache-stat-exact-hits"
                  label={tc(SEM_CACHE_STAT_EXACT_HITS)}
                  value={stats.exactHits.toLocaleString()}
                />
                <StatCard
                  testId="sem-cache-stat-semantic-hits"
                  label={tc(SEM_CACHE_STAT_SEMANTIC_HITS)}
                  value={stats.semanticHits.toLocaleString()}
                />
                <StatCard
                  testId="sem-cache-stat-misses"
                  label={tc(SEM_CACHE_STAT_MISSES)}
                  value={stats.misses.toLocaleString()}
                />
                <StatCard
                  testId="sem-cache-stat-bypassed"
                  label={tc(SEM_CACHE_STAT_BYPASSED)}
                  value={stats.bypassed.toLocaleString()}
                />
                <StatCard
                  testId="sem-cache-stat-hit-rate"
                  label={tc(SEM_CACHE_STAT_HIT_RATE)}
                  value={formatHitRate(stats.hitRate)}
                />
                <StatCard
                  testId="sem-cache-stat-tokens-saved"
                  label={tc(SEM_CACHE_STAT_TOKENS_SAVED)}
                  value={stats.tokensSavedEst.toLocaleString()}
                />
                <StatCard
                  testId="sem-cache-stat-entries"
                  label={tc(SEM_CACHE_STAT_ENTRIES)}
                  value={`${stats.memoryEntriesCount} / ${stats.entriesCount}`}
                />
              </div>

              {canEdit && (
                <form
                  onSubmit={handleFlush}
                  className="rounded-md border bg-muted/20 p-3 flex flex-wrap items-center gap-3"
                  data-testid="sem-cache-flush-form"
                >
                  <span className="text-xs font-medium">{tc(SEM_CACHE_FLUSH_HEADING)}</span>
                  <input
                    type="text"
                    data-testid="sem-cache-flush-model"
                    value={flushModel}
                    placeholder={tc(SEM_CACHE_FLUSH_MODEL_PLACEHOLDER)}
                    onChange={(e) => setFlushModel(e.target.value)}
                    className="h-8 flex-1 min-w-[180px] rounded-md border bg-background px-2.5 text-xs"
                  />
                  <label className="inline-flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      data-testid="sem-cache-flush-reset-metrics"
                      checked={flushResetMetrics}
                      onChange={(e) => setFlushResetMetrics(e.target.checked)}
                    />
                    {tc(SEM_CACHE_FLUSH_RESET_METRICS)}
                  </label>
                  <button
                    type="submit"
                    data-testid="sem-cache-flush-btn"
                    disabled={flushing}
                    className="h-8 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                  >
                    {flushing ? tc(SEM_CACHE_FLUSHING_BTN) : tc(SEM_CACHE_FLUSH_BTN)}
                  </button>
                  {flushedCount !== null && (
                    <span className="text-xs text-emerald-600 dark:text-emerald-400" role="status">
                      {tc(SEM_CACHE_FLUSHED_MSG, { count: flushedCount })}
                    </span>
                  )}
                  {flushError && (
                    <span className="text-xs text-destructive" role="alert">
                      {flushError}
                    </span>
                  )}
                </form>
              )}

              <div className="space-y-2">
                <h4 className="text-xs font-medium text-muted-foreground">
                  {tc(SEM_CACHE_ENTRIES_HEADING, { count: recentEntries.length })}
                </h4>
                {recentEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{tc(SEM_CACHE_ENTRIES_EMPTY)}</p>
                ) : (
                  <div className="overflow-x-auto rounded border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50 text-left text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_MODEL)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_WIRE)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_TIER)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_HITS)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_TOKENS)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_CONTRACT)}</th>
                          <th className="px-3 py-2">{tc(SEM_CACHE_COL_EXPIRES)}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {recentEntries.map((entry) => (
                          <tr key={entry.id}>
                            <td className="px-3 py-2 font-mono">{entry.model}</td>
                            <td className="px-3 py-2">{entry.wire}</td>
                            <td className="px-3 py-2">
                              {entry.hasEmbedding && entry.embeddingDims
                                ? tc(SEM_CACHE_VEC_READY, { dims: entry.embeddingDims })
                                : tc(SEM_CACHE_VEC_EXACT_ONLY)}
                            </td>
                            <td className="px-3 py-2 tabular-nums">{entry.hitCount}</td>
                            <td className="px-3 py-2 tabular-nums">
                              {entry.tokensSaved.toLocaleString()}
                            </td>
                            <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                              {`${entry.contractHash.slice(0, 8)} / ${entry.promptVersionHash.slice(0, 8)}`}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">{entry.expiresAt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {/* Section 3: Lookup Preview Tester */}
      {canView && (
        <section
          className="rounded-lg border bg-card p-4 space-y-4"
          data-testid="sem-cache-preview-section"
        >
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{tc(SEM_CACHE_PREVIEW_HEADING)}</h3>
            <p className="text-xs text-muted-foreground">{tc(SEM_CACHE_PREVIEW_SUBTITLE)}</p>
          </div>

          <form onSubmit={handlePreview} className="space-y-3" data-testid="sem-cache-preview-form">
            <div className="space-y-1">
              <label htmlFor="sem-cache-preview-query" className="block text-xs font-medium">
                {tc(SEM_CACHE_PREVIEW_QUERY_LABEL)}
              </label>
              <textarea
                id="sem-cache-preview-query"
                data-testid="sem-cache-preview-query"
                rows={2}
                value={previewQuery}
                placeholder={tc(SEM_CACHE_PREVIEW_QUERY_PLACEHOLDER)}
                onChange={(e) => setPreviewQuery(e.target.value)}
                className="w-full rounded-md border bg-background p-2.5 text-sm"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="space-y-1">
                <label htmlFor="sem-cache-preview-model" className="block text-xs font-medium">
                  {tc(SEM_CACHE_PREVIEW_MODEL_LABEL)}
                </label>
                <input
                  id="sem-cache-preview-model"
                  data-testid="sem-cache-preview-model"
                  type="text"
                  value={previewModel}
                  onChange={(e) => setPreviewModel(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-preview-wire" className="block text-xs font-medium">
                  {tc(SEM_CACHE_PREVIEW_WIRE_LABEL)}
                </label>
                <select
                  id="sem-cache-preview-wire"
                  data-testid="sem-cache-preview-wire"
                  value={previewWire}
                  onChange={(e) => setPreviewWire(e.target.value as Wire)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="openai-chat">openai-chat</option>
                  <option value="anthropic">anthropic</option>
                  <option value="responses">responses</option>
                  <option value="gemini">gemini</option>
                </select>
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-preview-temp" className="block text-xs font-medium">
                  {tc(SEM_CACHE_PREVIEW_TEMP_LABEL)}
                </label>
                <input
                  id="sem-cache-preview-temp"
                  data-testid="sem-cache-preview-temp"
                  type="number"
                  step="0.05"
                  min="0"
                  max="2"
                  value={previewTemp}
                  onChange={(e) => setPreviewTemp(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm tabular-nums"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="sem-cache-preview-user" className="block text-xs font-medium">
                  {tc(SEM_CACHE_PREVIEW_END_USER_LABEL)}
                </label>
                <input
                  id="sem-cache-preview-user"
                  data-testid="sem-cache-preview-end-user"
                  type="text"
                  value={previewEndUser}
                  onChange={(e) => setPreviewEndUser(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                />
              </div>
            </div>

            <button
              type="submit"
              data-testid="sem-cache-preview-submit"
              disabled={previewLoading}
              className="h-9 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {previewLoading ? tc(SEM_CACHE_PREVIEW_RUNNING_BTN) : tc(SEM_CACHE_PREVIEW_BTN)}
            </button>
          </form>

          {previewError && (
            <div
              className="rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {previewError}
            </div>
          )}

          {previewResult && (
            <div
              className="rounded-md border bg-muted/20 p-3 space-y-2 text-xs"
              data-testid="sem-cache-preview-result"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className="rounded px-2 py-0.5 font-mono font-semibold bg-primary/15 text-primary"
                  data-testid="sem-cache-preview-status"
                >
                  {tc(STATUS_LABEL_KEY[previewResult.status])}
                </span>
                {previewResult.score !== null && (
                  <span data-testid="sem-cache-preview-score">
                    {tc(SEM_CACHE_PREVIEW_SCORE, { score: previewResult.score.toFixed(4) })}
                  </span>
                )}
                <span>{tc(SEM_CACHE_PREVIEW_LATENCY, { ms: previewResult.latencyMs })}</span>
                {previewResult.bypassReason && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {tc(SEM_CACHE_PREVIEW_BYPASS_REASON, { reason: previewResult.bypassReason })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-4 font-mono text-[11px] text-muted-foreground">
                <span>
                  {tc(SEM_CACHE_PREVIEW_CONTRACT, {
                    hash: previewResult.contractHash.slice(0, 12),
                  })}
                </span>
                <span>
                  {tc(SEM_CACHE_PREVIEW_PROMPT_HASH, {
                    hash: previewResult.promptVersionHash.slice(0, 12),
                  })}
                </span>
              </div>

              {previewResult.cachedResponsePreview ? (
                <div className="space-y-1 pt-1">
                  <div className="font-medium">{tc(SEM_CACHE_PREVIEW_RESPONSE_LABEL)}</div>
                  <pre
                    className="whitespace-pre-wrap rounded border bg-background p-2 text-xs"
                    data-testid="sem-cache-preview-response"
                  >
                    {previewResult.cachedResponsePreview}
                  </pre>
                </div>
              ) : (
                <p className="text-muted-foreground">{tc(SEM_CACHE_PREVIEW_NO_MATCH)}</p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
