import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomT } from '../../i18n/use-custom-t';
import { useSessionRevision } from '../../session-state';
import { useAdministrativeAccess } from '../../use-administrative-access';
import { useUserSession } from '../../use-session';
import {
  DEFAULT_PROMPT_CACHE_SETTINGS,
  PROMPT_CACHE_LIMITS,
  deletePromptCacheCapability,
  fetchPromptCacheCapabilities,
  fetchPromptCacheSettings,
  fetchPromptCacheStats,
  promptCacheCapabilitiesKey,
  promptCacheSettingsKey,
  promptCacheStatsKey,
  putPromptCacheCapability,
  putPromptCacheSettings,
  type PromptCacheCapability,
  type PromptCacheGroupBy,
  type PromptCacheMode,
  type PromptCacheSettings,
  type PromptCacheStatsResponse,
  type PromptCacheStatsRow,
} from '../prompt-cache-api';
import {
  CACHE_AUTO_BREAKPOINTS_DESC,
  CACHE_AUTO_BREAKPOINTS_LABEL,
  CACHE_CAPABILITIES_EMPTY,
  CACHE_CAPABILITIES_HEADING,
  CACHE_CAPABILITIES_LOADING,
  CACHE_CAPABILITIES_LOAD_ERROR,
  CACHE_CAPABILITIES_SUBTITLE,
  CACHE_CAP_COL_ACTIONS,
  CACHE_CAP_COL_MAX_BP,
  CACHE_CAP_COL_MIN_TOKENS,
  CACHE_CAP_COL_MODE,
  CACHE_CAP_COL_PATTERN,
  CACHE_CAP_COL_PLATFORM,
  CACHE_CAP_COL_SOURCE,
  CACHE_CAP_COL_TTL,
  CACHE_EDITOR_ONLY_NOTICE,
  CACHE_FORBIDDEN_ERROR,
  CACHE_FORWARD_DESC,
  CACHE_FORWARD_LABEL,
  CACHE_MODE_EXPLICIT,
  CACHE_MODE_IMPLICIT,
  CACHE_MODE_NONE,
  CACHE_NO_PERMISSION,
  CACHE_OVERRIDE_DELETED,
  CACHE_OVERRIDE_DELETE_BTN,
  CACHE_OVERRIDE_DELETE_ERROR,
  CACHE_OVERRIDE_DELETING_BTN,
  CACHE_OVERRIDE_EDIT_BTN,
  CACHE_OVERRIDE_FORM_HEADING,
  CACHE_OVERRIDE_MAX_BP_LABEL,
  CACHE_OVERRIDE_MIN_TOKENS_LABEL,
  CACHE_OVERRIDE_MODE_LABEL,
  CACHE_OVERRIDE_PATTERN_LABEL,
  CACHE_OVERRIDE_PATTERN_PLACEHOLDER,
  CACHE_OVERRIDE_PLATFORM_LABEL,
  CACHE_OVERRIDE_PLATFORM_PLACEHOLDER,
  CACHE_OVERRIDE_SAVED,
  CACHE_OVERRIDE_SAVE_BTN,
  CACHE_OVERRIDE_SAVE_ERROR,
  CACHE_OVERRIDE_SAVING_BTN,
  CACHE_OVERRIDE_TTL_LABEL,
  CACHE_OVERRIDE_VALIDATION_REQUIRED,
  CACHE_PAGE_SUBTITLE,
  CACHE_PAGE_TITLE,
  CACHE_RETRY,
  CACHE_SAVE_SETTINGS_BTN,
  CACHE_SAVING_SETTINGS_BTN,
  CACHE_SESSION_EXPIRED,
  CACHE_SETTINGS_HEADING,
  CACHE_SETTINGS_LOADING,
  CACHE_SETTINGS_LOAD_ERROR,
  CACHE_SETTINGS_SAVED,
  CACHE_SETTINGS_SAVE_ERROR,
  CACHE_SOURCE_BUILTIN,
  CACHE_SOURCE_OVERRIDE,
  CACHE_STATE_OFF,
  CACHE_STATE_ON,
  CACHE_STATS_CHART_ARIA,
  CACHE_STATS_CHART_TITLE,
  CACHE_STATS_COL_HITS,
  CACHE_STATS_COL_HIT_RATE,
  CACHE_STATS_COL_INPUT_TOKENS,
  CACHE_STATS_COL_KEY,
  CACHE_STATS_COL_READ_TOKENS,
  CACHE_STATS_COL_REQUESTS,
  CACHE_STATS_COL_SAVED,
  CACHE_STATS_COL_WRITE_TOKENS,
  CACHE_STATS_DAYS_LABEL,
  CACHE_STATS_DAYS_OPTION,
  CACHE_STATS_EMPTY,
  CACHE_STATS_EST_SAVED,
  CACHE_STATS_GROUP_BY_LABEL,
  CACHE_STATS_GROUP_DAY,
  CACHE_STATS_GROUP_MODEL,
  CACHE_STATS_GROUP_PROFILE,
  CACHE_STATS_HEADING,
  CACHE_STATS_HIT_RATE,
  CACHE_STATS_LOADING,
  CACHE_STATS_LOAD_ERROR,
  CACHE_STATS_READ_TOKENS,
  CACHE_STATS_REFRESH_BTN,
  CACHE_STATS_TOTAL_REQUESTS,
  CACHE_STATS_WRITE_TOKENS,
  CACHE_STICKY_ROUTE_DESC,
  CACHE_STICKY_ROUTE_LABEL,
  CACHE_VIEW_ONLY_NOTICE,
} from '../prompt-cache-strings';

const STATS_DAYS_OPTIONS = [7, 30, 90] as const;

const MODE_LABELS: Record<PromptCacheMode, string> = {
  explicit: CACHE_MODE_EXPLICIT,
  implicit: CACHE_MODE_IMPLICIT,
  none: CACHE_MODE_NONE,
};

const GROUP_LABELS: Record<PromptCacheGroupBy, string> = {
  day: CACHE_STATS_GROUP_DAY,
  profile: CACHE_STATS_GROUP_PROFILE,
  model: CACHE_STATS_GROUP_MODEL,
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return (err as { status?: number }).status;
}

function formatApiError(
  err: unknown,
  fallback: string,
  tc: (key: string) => string,
): string {
  const status = getErrorStatus(err);
  const rawMessage = err instanceof Error && err.message ? err.message : '';
  if (status === 401) return tc(CACHE_SESSION_EXPIRED);
  if (status === 403) {
    return rawMessage ? `${tc(CACHE_FORBIDDEN_ERROR)} (${rawMessage})` : tc(CACHE_FORBIDDEN_ERROR);
  }
  return rawMessage || fallback;
}

function formatPercent(ratio: number): string {
  const pct = ratio <= 1 ? ratio * 100 : ratio;
  return `${pct.toFixed(1)}%`;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount >= 1 ? 2 : 4).replace(/(\.\d{2})00$/, '$1')}`;
}

function parseNonNegInt(raw: string, max: number, fallback: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, parsed));
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

interface SettingSwitchProps {
  testId: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}

function SettingSwitch({
  testId,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: SettingSwitchProps) {
  const tc = useCustomT();
  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b last:border-b-0">
      <div className="flex-1">
        <div className="font-medium text-sm">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-muted-foreground">
          {checked ? tc(CACHE_STATE_ON) : tc(CACHE_STATE_OFF)}
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

function SummaryCard({
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

function SavingsChart({
  rows,
  groupLabel,
  ariaLabel,
}: {
  rows: PromptCacheStatsRow[];
  groupLabel: string;
  ariaLabel: string;
}) {
  const tc = useCustomT();
  if (rows.length === 0) return null;

  const visibleRows = rows.slice(0, 14);
  const maxSaved = Math.max(...visibleRows.map((r) => r.estSavedUsd), 0);
  const maxRead = Math.max(...visibleRows.map((r) => r.cacheReadTokens), 0);
  const useSavingsMetric = maxSaved > 0;
  const maxVal = useSavingsMetric ? maxSaved : Math.max(maxRead, 1);

  const chartWidth = 640;
  const chartHeight = 180;
  const padLeft = 16;
  const padRight = 16;
  const padTop = 20;
  const padBottom = 36;
  const innerWidth = chartWidth - padLeft - padRight;
  const innerHeight = chartHeight - padTop - padBottom;
  const step = innerWidth / visibleRows.length;
  const barWidth = Math.max(12, Math.min(44, step * 0.62));

  return (
    <div className="rounded-lg border bg-card p-4" data-testid="cache-stats-chart">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {tc(CACHE_STATS_CHART_TITLE).replace('{group}', groupLabel)}
      </div>
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        className="w-full h-44 overflow-visible"
        role="img"
        aria-label={ariaLabel}
      >
        <line
          x1={padLeft}
          y1={padTop + innerHeight}
          x2={chartWidth - padRight}
          y2={padTop + innerHeight}
          stroke="currentColor"
          strokeOpacity={0.2}
        />
        {visibleRows.map((row, idx) => {
          const rawVal = useSavingsMetric ? row.estSavedUsd : row.cacheReadTokens;
          const barHeight = Math.max(2, (rawVal / maxVal) * innerHeight);
          const x = padLeft + idx * step + (step - barWidth) / 2;
          const y = padTop + innerHeight - barHeight;
          const shortKey = row.key.length > 12 ? `${row.key.slice(0, 11)}…` : row.key;
          const valueLabel = useSavingsMetric
            ? formatUsd(row.estSavedUsd)
            : row.cacheReadTokens.toLocaleString();

          return (
            <g key={row.key}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                rx={3}
                className="fill-primary/80"
                data-testid={`cache-chart-bar-${row.key}`}
              >
                <title>{`${row.key}: ${formatUsd(row.estSavedUsd)} (${row.cacheReadTokens.toLocaleString()} read)`}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={y - 4}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {valueLabel}
              </text>
              <text
                x={x + barWidth / 2}
                y={padTop + innerHeight + 16}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {shortKey}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PromptCache() {
  const tc = useCustomT();
  const { can, identity } = useAdministrativeAccess();
  const { isPrimary, session } = useUserSession();
  const globalSessionRev = useSessionRevision();

  const canView = isPrimary || can('view_prompt_cache');
  const canEdit = isPrimary || can('edit_prompt_cache');

  // Include user/identity + global session revision so logout or role switch remounts clean state
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
      <div className="p-6" data-testid="prompt-cache-no-permission">
        <p className="text-sm text-muted-foreground">{tc(CACHE_NO_PERMISSION)}</p>
      </div>
    );
  }

  return (
    <PromptCacheContent
      key={sessionRevision}
      sessionRevision={sessionRevision}
      canView={canView}
      canEdit={canEdit}
    />
  );
}

function PromptCacheContent({
  sessionRevision,
  canView,
  canEdit,
}: {
  sessionRevision: number;
  canView: boolean;
  canEdit: boolean;
}) {
  const tc = useCustomT();

  // Section 1: Settings state
  const [settings, setSettings] = useState<PromptCacheSettings>(() => ({
    ...DEFAULT_PROMPT_CACHE_SETTINGS,
  }));
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  // Section 2: Stats state
  const [statsDays, setStatsDays] = useState<number>(PROMPT_CACHE_LIMITS.defaultStatsDays);
  const [statsGroupBy, setStatsGroupBy] = useState<PromptCacheGroupBy>('day');
  const [stats, setStats] = useState<PromptCacheStatsResponse | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Section 3: Capabilities & overrides state
  const [capabilities, setCapabilities] = useState<PromptCacheCapability[]>([]);
  const [loadingCaps, setLoadingCaps] = useState(false);
  const [capsLoadError, setCapsLoadError] = useState<string | null>(null);
  const [overridePlatform, setOverridePlatform] = useState('');
  const [overridePattern, setOverridePattern] = useState('');
  const [overrideMode, setOverrideMode] = useState<PromptCacheMode>('explicit');
  const [overrideMaxBp, setOverrideMaxBp] = useState<number>(PROMPT_CACHE_LIMITS.defaultMaxBreakpoints);
  const [overrideMinTokens, setOverrideMinTokens] = useState<number>(PROMPT_CACHE_LIMITS.defaultMinTokens);
  const [overrideTtl, setOverrideTtl] = useState<number>(PROMPT_CACHE_LIMITS.defaultTtlSeconds);
  const [savingOverride, setSavingOverride] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [overrideSaved, setOverrideSaved] = useState(false);
  const [overrideDeleted, setOverrideDeleted] = useState(false);

  // Mounted & AbortController refs for clean unmount aborting
  const mountedRef = useRef(true);
  const settingsAbortRef = useRef<AbortController | null>(null);
  const settingsSaveAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);
  const capsAbortRef = useRef<AbortController | null>(null);
  const overrideMutAbortRef = useRef<AbortController | null>(null);

  const settingsKey = useMemo(() => promptCacheSettingsKey(sessionRevision), [sessionRevision]);
  const capsKey = useMemo(() => promptCacheCapabilitiesKey(sessionRevision), [sessionRevision]);
  const statsKey = useMemo(
    () => promptCacheStatsKey(sessionRevision, statsDays, statsGroupBy),
    [sessionRevision, statsDays, statsGroupBy],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      settingsAbortRef.current?.abort();
      settingsSaveAbortRef.current?.abort();
      statsAbortRef.current?.abort();
      capsAbortRef.current?.abort();
      overrideMutAbortRef.current?.abort();
    };
  }, []);

  const loadSettings = useCallback(async () => {
    if (!canView) return;
    settingsAbortRef.current?.abort();
    const controller = new AbortController();
    settingsAbortRef.current = controller;

    setLoadingSettings(true);
    setSettingsLoadError(null);
    try {
      const res = await fetchPromptCacheSettings(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSettings(res.settings);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setSettingsLoadError(formatApiError(err, tc(CACHE_SETTINGS_LOAD_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoadingSettings(false);
      }
    }
  }, [canView, tc]);

  const loadCapabilities = useCallback(async () => {
    if (!canView) return;
    capsAbortRef.current?.abort();
    const controller = new AbortController();
    capsAbortRef.current = controller;

    setLoadingCaps(true);
    setCapsLoadError(null);
    try {
      const res = await fetchPromptCacheCapabilities(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setCapabilities(res.capabilities);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setCapsLoadError(formatApiError(err, tc(CACHE_CAPABILITIES_LOAD_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoadingCaps(false);
      }
    }
  }, [canView, tc]);

  const loadStats = useCallback(async () => {
    if (!canView) return;
    statsAbortRef.current?.abort();
    const controller = new AbortController();
    statsAbortRef.current = controller;

    setLoadingStats(true);
    setStatsError(null);
    try {
      const res = await fetchPromptCacheStats(
        { days: statsDays, groupBy: statsGroupBy },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setStats(res);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setStatsError(formatApiError(err, tc(CACHE_STATS_LOAD_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setLoadingStats(false);
      }
    }
  }, [canView, statsDays, statsGroupBy, tc]);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadSettings();
    });
    return () => {
      cancelled = true;
      settingsAbortRef.current?.abort();
    };
  }, [canView, settingsKey, loadSettings]);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadCapabilities();
    });
    return () => {
      cancelled = true;
      capsAbortRef.current?.abort();
    };
  }, [canView, capsKey, loadCapabilities]);

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void loadStats();
    });
    return () => {
      cancelled = true;
      statsAbortRef.current?.abort();
    };
  }, [canView, statsKey, loadStats]);

  async function handleSaveSettings() {
    if (!canEdit || savingSettings) return;
    settingsSaveAbortRef.current?.abort();
    const controller = new AbortController();
    settingsSaveAbortRef.current = controller;

    setSavingSettings(true);
    setSettingsSaveError(null);
    setSettingsSaved(false);
    try {
      const res = await putPromptCacheSettings(settings, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSettings(res.settings);
      setSettingsSaved(true);
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setSettingsSaved(false);
      setSettingsSaveError(formatApiError(err, tc(CACHE_SETTINGS_SAVE_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setSavingSettings(false);
      }
    }
  }

  async function handleSaveOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || savingOverride) return;

    const platform = overridePlatform.trim();
    const modelPattern = overridePattern.trim();
    if (!platform || !modelPattern) {
      setOverrideSaved(false);
      setOverrideDeleted(false);
      setOverrideError(tc(CACHE_OVERRIDE_VALIDATION_REQUIRED));
      return;
    }

    overrideMutAbortRef.current?.abort();
    const controller = new AbortController();
    overrideMutAbortRef.current = controller;

    setSavingOverride(true);
    setOverrideError(null);
    setOverrideSaved(false);
    setOverrideDeleted(false);

    try {
      const res = await putPromptCacheCapability(
        {
          platform,
          modelPattern,
          mode: overrideMode,
          maxBreakpoints: overrideMaxBp,
          minTokens: overrideMinTokens,
          ttlSeconds: overrideTtl,
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted) return;
      setOverrideSaved(true);
      if (canView) {
        await loadCapabilities();
      } else {
        setCapabilities((prev) => {
          const filtered = prev.filter(
            (c) =>
              !(
                c.source === 'override' &&
                c.platform === res.capability.platform &&
                c.modelPattern === res.capability.modelPattern
              ),
          );
          return [...filtered, res.capability];
        });
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setOverrideSaved(false);
      setOverrideError(formatApiError(err, tc(CACHE_OVERRIDE_SAVE_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setSavingOverride(false);
      }
    }
  }

  async function handleDeleteOverride(platform: string, modelPattern: string) {
    if (!canEdit || deletingKey) return;
    const key = `${platform}:${modelPattern}`;
    overrideMutAbortRef.current?.abort();
    const controller = new AbortController();
    overrideMutAbortRef.current = controller;

    setDeletingKey(key);
    setOverrideError(null);
    setOverrideSaved(false);
    setOverrideDeleted(false);

    try {
      await deletePromptCacheCapability({ platform, modelPattern }, controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setOverrideDeleted(true);
      if (canView) {
        await loadCapabilities();
      } else {
        setCapabilities((prev) =>
          prev.filter(
            (c) =>
              !(
                c.source === 'override' &&
                c.platform === platform &&
                c.modelPattern === modelPattern
              ),
          ),
        );
      }
    } catch (err) {
      if (isAbortError(err) || !mountedRef.current || controller.signal.aborted) return;
      setOverrideDeleted(false);
      setOverrideError(formatApiError(err, tc(CACHE_OVERRIDE_DELETE_ERROR), tc));
    } finally {
      if (mountedRef.current && !controller.signal.aborted) {
        setDeletingKey(null);
      }
    }
  }

  function handlePopulateFormFromCapability(cap: PromptCacheCapability) {
    setOverridePlatform(cap.platform);
    setOverridePattern(cap.modelPattern);
    setOverrideMode(cap.mode);
    setOverrideMaxBp(cap.maxBreakpoints);
    setOverrideMinTokens(cap.minTokens);
    setOverrideTtl(cap.ttlSeconds);
    setOverrideError(null);
    setOverrideSaved(false);
    setOverrideDeleted(false);
  }

  const statsSummary = useMemo(() => {
    const rows = stats?.rows ?? [];
    let requests = 0;
    let weightedHitRateSum = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let estSavedUsd = 0;
    for (const row of rows) {
      requests += row.requests;
      weightedHitRateSum += row.hitRate * row.requests;
      cacheReadTokens += row.cacheReadTokens;
      cacheWriteTokens += row.cacheWriteTokens;
      estSavedUsd += row.estSavedUsd;
    }
    const avgHitRate = requests > 0 ? weightedHitRateSum / requests : 0;
    return {
      requests,
      avgHitRate,
      cacheReadTokens,
      cacheWriteTokens,
      estSavedUsd,
    };
  }, [stats]);

  return (
    <div className="p-6 space-y-6 max-w-5xl" data-testid="prompt-cache-page">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">{tc(CACHE_PAGE_TITLE)}</h1>
        <p className="text-sm text-muted-foreground">{tc(CACHE_PAGE_SUBTITLE)}</p>
      </header>

      {canView && !canEdit && (
        <div
          className="rounded border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          data-testid="prompt-cache-view-only-notice"
        >
          {tc(CACHE_VIEW_ONLY_NOTICE)}
        </div>
      )}

      {!canView && canEdit && (
        <div
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="prompt-cache-editor-only-notice"
        >
          {tc(CACHE_EDITOR_ONLY_NOTICE)}
        </div>
      )}

      {/* Section 1: Settings */}
      <section className="rounded-lg border bg-card p-4 space-y-3" data-testid="cache-settings-section">
        <h2 className="text-base font-semibold">{tc(CACHE_SETTINGS_HEADING)}</h2>

        {loadingSettings ? (
          <p className="text-sm text-muted-foreground" data-testid="cache-settings-loading">
            {tc(CACHE_SETTINGS_LOADING)}
          </p>
        ) : settingsLoadError ? (
          <div className="flex items-center justify-between gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            <span>{settingsLoadError}</span>
            <button
              type="button"
              className="underline font-medium"
              onClick={() => void loadSettings()}
            >
              {tc(CACHE_RETRY)}
            </button>
          </div>
        ) : (
          <>
            <div>
              <SettingSwitch
                testId="cache-setting-forward"
                label={tc(CACHE_FORWARD_LABEL)}
                description={tc(CACHE_FORWARD_DESC)}
                checked={settings.forward}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSettingsSaved(false);
                  setSettingsSaveError(null);
                  setSettings((prev) => ({ ...prev, forward: !prev.forward }));
                }}
              />
              <SettingSwitch
                testId="cache-setting-auto-breakpoints"
                label={tc(CACHE_AUTO_BREAKPOINTS_LABEL)}
                description={tc(CACHE_AUTO_BREAKPOINTS_DESC)}
                checked={settings.autoBreakpoints}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSettingsSaved(false);
                  setSettingsSaveError(null);
                  setSettings((prev) => ({ ...prev, autoBreakpoints: !prev.autoBreakpoints }));
                }}
              />
              <SettingSwitch
                testId="cache-setting-sticky-route"
                label={tc(CACHE_STICKY_ROUTE_LABEL)}
                description={tc(CACHE_STICKY_ROUTE_DESC)}
                checked={settings.preferStickyRoute}
                disabled={!canEdit || savingSettings}
                onToggle={() => {
                  setSettingsSaved(false);
                  setSettingsSaveError(null);
                  setSettings((prev) => ({ ...prev, preferStickyRoute: !prev.preferStickyRoute }));
                }}
              />
            </div>

            {settingsSaveError && (
              <div
                className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
                role="alert"
                data-testid="cache-settings-error"
              >
                {settingsSaveError}
              </div>
            )}

            {settingsSaved && !settingsSaveError && (
              <div
                className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
                data-testid="cache-settings-saved"
              >
                {tc(CACHE_SETTINGS_SAVED)}
              </div>
            )}

            <div className="pt-1">
              <button
                type="button"
                data-testid="cache-save-settings-btn"
                disabled={!canEdit || savingSettings}
                onClick={() => void handleSaveSettings()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {savingSettings ? tc(CACHE_SAVING_SETTINGS_BTN) : tc(CACHE_SAVE_SETTINGS_BTN)}
              </button>
            </div>
          </>
        )}
      </section>

      {/* Section 2: Savings & Usage Stats (requires view_prompt_cache) */}
      {canView && (
        <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="cache-stats-section">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-semibold">{tc(CACHE_STATS_HEADING)}</h2>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                <span className="font-medium">{tc(CACHE_STATS_DAYS_LABEL)}</span>
                <select
                  data-testid="cache-stats-days-select"
                  aria-label={tc(CACHE_STATS_DAYS_LABEL)}
                  className="rounded border bg-background px-2 py-1 text-xs"
                  value={statsDays}
                  onChange={(e) => setStatsDays(Number(e.target.value))}
                >
                  {STATS_DAYS_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {tc(CACHE_STATS_DAYS_OPTION).replace('{days}', String(d))}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-1.5 text-xs">
                <span className="font-medium">{tc(CACHE_STATS_GROUP_BY_LABEL)}</span>
                <select
                  data-testid="cache-stats-groupby-select"
                  aria-label={tc(CACHE_STATS_GROUP_BY_LABEL)}
                  className="rounded border bg-background px-2 py-1 text-xs"
                  value={statsGroupBy}
                  onChange={(e) => setStatsGroupBy(e.target.value as PromptCacheGroupBy)}
                >
                  <option value="day">{tc(CACHE_STATS_GROUP_DAY)}</option>
                  <option value="profile">{tc(CACHE_STATS_GROUP_PROFILE)}</option>
                  <option value="model">{tc(CACHE_STATS_GROUP_MODEL)}</option>
                </select>
              </label>

              <button
                type="button"
                data-testid="cache-stats-refresh-btn"
                onClick={() => void loadStats()}
                disabled={loadingStats}
                className="rounded border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
              >
                {tc(CACHE_STATS_REFRESH_BTN)}
              </button>
            </div>
          </div>

          {loadingStats ? (
            <p className="text-sm text-muted-foreground" data-testid="cache-stats-loading">
              {tc(CACHE_STATS_LOADING)}
            </p>
          ) : statsError ? (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              {statsError}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <SummaryCard
                  testId="cache-summary-requests"
                  label={tc(CACHE_STATS_TOTAL_REQUESTS)}
                  value={statsSummary.requests.toLocaleString()}
                />
                <SummaryCard
                  testId="cache-summary-hit-rate"
                  label={tc(CACHE_STATS_HIT_RATE)}
                  value={formatPercent(statsSummary.avgHitRate)}
                />
                <SummaryCard
                  testId="cache-summary-read-tokens"
                  label={tc(CACHE_STATS_READ_TOKENS)}
                  value={statsSummary.cacheReadTokens.toLocaleString()}
                />
                <SummaryCard
                  testId="cache-summary-write-tokens"
                  label={tc(CACHE_STATS_WRITE_TOKENS)}
                  value={statsSummary.cacheWriteTokens.toLocaleString()}
                />
                <SummaryCard
                  testId="cache-summary-est-saved"
                  label={tc(CACHE_STATS_EST_SAVED)}
                  value={formatUsd(statsSummary.estSavedUsd)}
                />
              </div>

              {!stats || stats.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="cache-stats-empty">
                  {tc(CACHE_STATS_EMPTY)}
                </p>
              ) : (
                <>
                  <SavingsChart
                    rows={stats.rows}
                    groupLabel={tc(GROUP_LABELS[stats.groupBy])}
                    ariaLabel={tc(CACHE_STATS_CHART_ARIA)}
                  />

                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse" data-testid="cache-stats-table">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">{tc(CACHE_STATS_COL_KEY)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_REQUESTS)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_HITS)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_HIT_RATE)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_INPUT_TOKENS)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_READ_TOKENS)}</th>
                          <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_STATS_COL_WRITE_TOKENS)}</th>
                          <th className="py-2 font-medium text-right">{tc(CACHE_STATS_COL_SAVED)}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.rows.map((row) => (
                          <tr key={row.key} className="border-b last:border-b-0">
                            <td className="py-2 pr-3 font-mono">{row.key}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.requests.toLocaleString()}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.requestsWithHit.toLocaleString()}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{formatPercent(row.hitRate)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.inputTokens.toLocaleString()}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.cacheReadTokens.toLocaleString()}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.cacheWriteTokens.toLocaleString()}</td>
                            <td className="py-2 text-right tabular-nums">{formatUsd(row.estSavedUsd)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* Section 3: Capabilities & Overrides */}
      <section className="rounded-lg border bg-card p-4 space-y-4" data-testid="cache-capabilities-section">
        <div>
          <h2 className="text-base font-semibold">{tc(CACHE_CAPABILITIES_HEADING)}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{tc(CACHE_CAPABILITIES_SUBTITLE)}</p>
        </div>

        {canView && (
          loadingCaps ? (
            <p className="text-sm text-muted-foreground" data-testid="cache-capabilities-loading">
              {tc(CACHE_CAPABILITIES_LOADING)}
            </p>
          ) : capsLoadError ? (
            <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
              {capsLoadError}
            </div>
          ) : capabilities.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="cache-capabilities-empty">
              {tc(CACHE_CAPABILITIES_EMPTY)}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse" data-testid="cache-capabilities-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">{tc(CACHE_CAP_COL_SOURCE)}</th>
                    <th className="py-2 pr-3 font-medium">{tc(CACHE_CAP_COL_PLATFORM)}</th>
                    <th className="py-2 pr-3 font-medium">{tc(CACHE_CAP_COL_PATTERN)}</th>
                    <th className="py-2 pr-3 font-medium">{tc(CACHE_CAP_COL_MODE)}</th>
                    <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_CAP_COL_MAX_BP)}</th>
                    <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_CAP_COL_MIN_TOKENS)}</th>
                    <th className="py-2 pr-3 font-medium text-right">{tc(CACHE_CAP_COL_TTL)}</th>
                    <th className="py-2 font-medium text-right">{tc(CACHE_CAP_COL_ACTIONS)}</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilities.map((cap) => {
                    const rowKey = `${cap.source}:${cap.platform}:${cap.modelPattern}`;
                    const delKey = `${cap.platform}:${cap.modelPattern}`;
                    const isDeleting = deletingKey === delKey;
                    return (
                      <tr key={rowKey} className="border-b last:border-b-0">
                        <td className="py-2 pr-3">
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${
                              cap.source === 'override'
                                ? 'bg-primary/10 text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {cap.source === 'override' ? tc(CACHE_SOURCE_OVERRIDE) : tc(CACHE_SOURCE_BUILTIN)}
                          </span>
                        </td>
                        <td className="py-2 pr-3 font-mono">{cap.platform}</td>
                        <td className="py-2 pr-3 font-mono">{cap.modelPattern}</td>
                        <td className="py-2 pr-3">{tc(MODE_LABELS[cap.mode])}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{cap.maxBreakpoints}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{cap.minTokens}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{cap.ttlSeconds}</td>
                        <td className="py-2 text-right space-x-2">
                          <button
                            type="button"
                            disabled={!canEdit}
                            data-testid={`cache-cap-edit-${cap.source}-${cap.platform}-${cap.modelPattern}`}
                            onClick={() => handlePopulateFormFromCapability(cap)}
                            className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                          >
                            {tc(CACHE_OVERRIDE_EDIT_BTN)}
                          </button>
                          {cap.source === 'override' && (
                            <button
                              type="button"
                              disabled={!canEdit || isDeleting}
                              data-testid={`cache-cap-delete-${cap.platform}-${cap.modelPattern}`}
                              onClick={() => void handleDeleteOverride(cap.platform, cap.modelPattern)}
                              className="rounded border border-red-300 px-2 py-0.5 text-[11px] text-red-700 hover:bg-red-50 disabled:opacity-50"
                            >
                              {isDeleting ? tc(CACHE_OVERRIDE_DELETING_BTN) : tc(CACHE_OVERRIDE_DELETE_BTN)}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {/* Override Add/Update Form */}
        <form
          onSubmit={(e) => void handleSaveOverride(e)}
          className="border-t pt-4 space-y-3"
          data-testid="cache-override-form"
        >
          <h3 className="text-sm font-medium">{tc(CACHE_OVERRIDE_FORM_HEADING)}</h3>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_PLATFORM_LABEL)}</span>
              <input
                type="text"
                maxLength={PROMPT_CACHE_LIMITS.platformMaxChars}
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-platform-input"
                aria-label={tc(CACHE_OVERRIDE_PLATFORM_LABEL)}
                placeholder={tc(CACHE_OVERRIDE_PLATFORM_PLACEHOLDER)}
                value={overridePlatform}
                onChange={(e) => setOverridePlatform(e.target.value)}
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_PATTERN_LABEL)}</span>
              <input
                type="text"
                maxLength={PROMPT_CACHE_LIMITS.modelPatternMaxChars}
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-pattern-input"
                aria-label={tc(CACHE_OVERRIDE_PATTERN_LABEL)}
                placeholder={tc(CACHE_OVERRIDE_PATTERN_PLACEHOLDER)}
                value={overridePattern}
                onChange={(e) => setOverridePattern(e.target.value)}
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_MODE_LABEL)}</span>
              <select
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-mode-select"
                aria-label={tc(CACHE_OVERRIDE_MODE_LABEL)}
                value={overrideMode}
                onChange={(e) => setOverrideMode(e.target.value as PromptCacheMode)}
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              >
                <option value="explicit">{tc(CACHE_MODE_EXPLICIT)}</option>
                <option value="implicit">{tc(CACHE_MODE_IMPLICIT)}</option>
                <option value="none">{tc(CACHE_MODE_NONE)}</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_MAX_BP_LABEL)}</span>
              <input
                type="number"
                min={0}
                max={PROMPT_CACHE_LIMITS.maxBreakpoints}
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-max-bp-input"
                aria-label={tc(CACHE_OVERRIDE_MAX_BP_LABEL)}
                value={overrideMaxBp}
                onChange={(e) =>
                  setOverrideMaxBp(parseNonNegInt(e.target.value, PROMPT_CACHE_LIMITS.maxBreakpoints, 0))
                }
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_MIN_TOKENS_LABEL)}</span>
              <input
                type="number"
                min={0}
                max={PROMPT_CACHE_LIMITS.maxMinTokens}
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-min-tokens-input"
                aria-label={tc(CACHE_OVERRIDE_MIN_TOKENS_LABEL)}
                value={overrideMinTokens}
                onChange={(e) =>
                  setOverrideMinTokens(parseNonNegInt(e.target.value, PROMPT_CACHE_LIMITS.maxMinTokens, 0))
                }
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="font-medium">{tc(CACHE_OVERRIDE_TTL_LABEL)}</span>
              <input
                type="number"
                min={0}
                max={PROMPT_CACHE_LIMITS.maxTtlSeconds}
                disabled={!canEdit || savingOverride}
                data-testid="cache-override-ttl-input"
                aria-label={tc(CACHE_OVERRIDE_TTL_LABEL)}
                value={overrideTtl}
                onChange={(e) =>
                  setOverrideTtl(parseNonNegInt(e.target.value, PROMPT_CACHE_LIMITS.maxTtlSeconds, 0))
                }
                className="block w-full rounded border bg-background px-2 py-1.5 text-sm disabled:opacity-50"
              />
            </label>
          </div>

          {overrideError && (
            <div
              className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700"
              role="alert"
              data-testid="cache-override-error"
            >
              {overrideError}
            </div>
          )}

          {overrideSaved && !overrideError && (
            <div
              className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
              data-testid="cache-override-saved"
            >
              {tc(CACHE_OVERRIDE_SAVED)}
            </div>
          )}

          {overrideDeleted && !overrideError && (
            <div
              className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
              data-testid="cache-override-deleted"
            >
              {tc(CACHE_OVERRIDE_DELETED)}
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={!canEdit || savingOverride}
              data-testid="cache-override-save-btn"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {savingOverride ? tc(CACHE_OVERRIDE_SAVING_BTN) : tc(CACHE_OVERRIDE_SAVE_BTN)}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
