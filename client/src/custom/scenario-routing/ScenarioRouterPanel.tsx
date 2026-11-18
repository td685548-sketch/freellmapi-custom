import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Brain,
  CheckCircle2,
  Eye,
  FileText,
  Globe,
  RotateCcw,
  Save,
  Sparkles,
  Zap,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/lib/toast';
import type { UserApiKey } from '../../../../shared/user-access';
import {
  DEFAULT_LONG_CONTEXT_THRESHOLD,
  DEFAULT_SCENARIO_RULES,
  SCENARIO_IDS,
  SCENARIO_ROUTING_MODES,
  type ScenarioClassificationResult,
  type ScenarioId,
  type ScenarioRoutingMode,
  type ScenarioRulesMap,
} from '../../../../shared/scenario-routing';
import {
  deleteKeyScenarioRoutingPolicy,
  fetchScenarioRoutingConfig,
  previewScenarioClassification,
  saveScenarioRoutingPolicy,
} from './api';
import { useScenarioRoutingStrings } from './strings';

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function scenarioIcon(id: ScenarioId) {
  switch (id) {
    case 'background':
      return <Zap className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    case 'think':
      return <Brain className="size-3.5 text-violet-600 dark:text-violet-400" />;
    case 'longContext':
      return <FileText className="size-3.5 text-amber-600 dark:text-amber-400" />;
    case 'vision':
      return <Eye className="size-3.5 text-sky-600 dark:text-sky-400" />;
    case 'webSearch':
      return <Globe className="size-3.5 text-indigo-600 dark:text-indigo-400" />;
    default:
      return <Activity className="size-3.5 text-muted-foreground" />;
  }
}

export function ScenarioTokensSavedBanner({ keyId }: { keyId?: number | null }) {
  const s = useScenarioRoutingStrings();
  const { data } = useQuery({
    queryKey: ['scenario-routing-config', keyId ?? 'account'],
    queryFn: () => fetchScenarioRoutingConfig(keyId ?? null),
    staleTime: 15_000,
  });

  const telemetry = data?.telemetry;
  const saved = telemetry?.estimatedTokensSaved ?? 0;
  const hits = telemetry?.totalHits ?? 0;
  const offloads = telemetry?.totalOffloadedHits ?? 0;

  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      <div className="rounded-xl border bg-background/70 px-3.5 py-2.5">
        <div className="text-[11px] text-muted-foreground">{s.telemetryTokensSaved}</div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="text-base font-semibold text-emerald-600 dark:text-emerald-400">
            {formatCompactTokens(saved)}
          </span>
          <span className="text-[11px] text-muted-foreground">{s.thresholdUnit}</span>
        </div>
      </div>
      <div className="rounded-xl border bg-background/70 px-3.5 py-2.5">
        <div className="text-[11px] text-muted-foreground">{s.telemetryOffloaded}</div>
        <div className="mt-0.5 text-base font-semibold text-foreground">{offloads}</div>
      </div>
      <div className="rounded-xl border bg-background/70 px-3.5 py-2.5">
        <div className="text-[11px] text-muted-foreground">{s.telemetryHits}</div>
        <div className="mt-0.5 text-base font-semibold text-foreground">{hits}</div>
      </div>
    </div>
  );
}

export function ScenarioRouterPanel({
  compact = false,
  hideTelemetryBanner = false,
}: {
  compact?: boolean;
  hideTelemetryBanner?: boolean;
}) {
  const s = useScenarioRoutingStrings();
  const queryClient = useQueryClient();

  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState<number>(DEFAULT_LONG_CONTEXT_THRESHOLD);
  const [rules, setRules] = useState<ScenarioRulesMap>(() => ({
    background: { ...DEFAULT_SCENARIO_RULES.background },
    think: { ...DEFAULT_SCENARIO_RULES.think },
    longContext: { ...DEFAULT_SCENARIO_RULES.longContext },
    vision: { ...DEFAULT_SCENARIO_RULES.vision },
    webSearch: { ...DEFAULT_SCENARIO_RULES.webSearch },
    default: { ...DEFAULT_SCENARIO_RULES.default },
  }));

  const [showTester, setShowTester] = useState(false);
  const [testPrompt, setTestPrompt] = useState('');
  const [previewResult, setPreviewResult] = useState<ScenarioClassificationResult | null>(null);

  const { data: keysData } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
    staleTime: 15_000,
  });
  const activeKeys = (keysData?.keys ?? []).filter((k) => !k.revoked);

  const { data: configData } = useQuery({
    queryKey: ['scenario-routing-config', selectedKeyId ?? 'account'],
    queryFn: () => fetchScenarioRoutingConfig(selectedKeyId),
  });

  const activePolicy =
    selectedKeyId === null
      ? configData?.accountPolicy
      : configData?.keyPolicies.find((p) => p.keyId === selectedKeyId) ??
        configData?.accountPolicy;

  const hasCustomKeyOverride =
    selectedKeyId !== null &&
    Boolean(configData?.keyPolicies.some((p) => p.keyId === selectedKeyId));

  useEffect(() => {
    if (!activePolicy) return;
    setEnabled(activePolicy.enabled);
    setThreshold(activePolicy.longContextThreshold);
    setRules({
      background: { ...activePolicy.rules.background },
      think: { ...activePolicy.rules.think },
      longContext: { ...activePolicy.rules.longContext },
      vision: { ...activePolicy.rules.vision },
      webSearch: { ...activePolicy.rules.webSearch },
      default: { ...activePolicy.rules.default },
    });
  }, [activePolicy, selectedKeyId]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveScenarioRoutingPolicy({
        keyId: selectedKeyId,
        enabled,
        longContextThreshold: threshold,
        rules,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scenario-routing-config'] });
      toast.success(s.policySavedToast);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save scenario policy');
    },
  });

  const resetOverrideMutation = useMutation({
    mutationFn: (keyId: number) => deleteKeyScenarioRoutingPolicy(keyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['scenario-routing-config'] });
      toast.success(s.policyDeletedToast);
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to reset key override');
    },
  });

  const previewMutation = useMutation({
    mutationFn: (promptText: string) =>
      previewScenarioClassification({
        wireSurface: 'chat_completions',
        longContextThreshold: threshold,
        payload: {
          model: 'auto',
          messages: [{ role: 'user', content: promptText }],
        },
      }),
    onSuccess: (res) => {
      setPreviewResult(res.classification);
    },
  });

  const applyRecommendedPreset = () => {
    setEnabled(true);
    setThreshold(DEFAULT_LONG_CONTEXT_THRESHOLD);
    setRules({
      background: { ...DEFAULT_SCENARIO_RULES.background, enabled: true, targetMode: 'eco' },
      think: { ...DEFAULT_SCENARIO_RULES.think, enabled: true, targetMode: 'max' },
      longContext: { ...DEFAULT_SCENARIO_RULES.longContext, enabled: true, targetMode: 'balanced' },
      vision: { ...DEFAULT_SCENARIO_RULES.vision, enabled: true, targetMode: 'balanced' },
      webSearch: { ...DEFAULT_SCENARIO_RULES.webSearch, enabled: true, targetMode: 'balanced' },
      default: { ...DEFAULT_SCENARIO_RULES.default, enabled: false, targetMode: 'default' },
    });
  };

  const models = configData?.availableModels ?? [];
  const telemetry = configData?.telemetry;

  return (
    <div className={`rounded-2xl border bg-card ${compact ? 'p-4' : 'p-5'} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">{s.routerTitle}</h3>
            <Badge
              variant="outline"
              className={
                enabled
                  ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                  : 'text-muted-foreground'
              }
            >
              {enabled ? <CheckCircle2 className="size-3" /> : null}
              {enabled ? s.enabledBadge : s.disabledBadge}
            </Badge>
          </div>
          <p className="max-w-2xl text-xs text-muted-foreground">{s.routerSubtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={applyRecommendedPreset}>
            <Zap className="mr-1 size-3.5" />
            {s.smartPresetBtn}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            <Save className="mr-1 size-3.5" />
            {saveMutation.isPending ? s.savingPolicyBtn : s.savePolicyBtn}
          </Button>
        </div>
      </div>

      {!hideTelemetryBanner && <ScenarioTokensSavedBanner keyId={selectedKeyId} />}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/40 p-3 text-xs">
        <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-foreground">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 rounded border"
          />
          {s.enableToggleLabel}
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{s.scopeLabel}:</span>
            <select
              aria-label={s.scopeLabel}
              value={selectedKeyId === null ? 'account' : String(selectedKeyId)}
              onChange={(e) =>
                setSelectedKeyId(e.target.value === 'account' ? null : Number(e.target.value))
              }
              className="h-8 rounded-lg border bg-background px-2 text-xs"
            >
              <option value="account">{s.accountDefaultOption}</option>
              {activeKeys.map((k) => {
                const isOverridden = configData?.keyPolicies.some((p) => p.keyId === k.id);
                return (
                  <option key={k.id} value={String(k.id)}>
                    {k.name} ({k.keyPrefix}) {isOverridden ? s.keyOverrideSuffix : ''}
                  </option>
                );
              })}
            </select>
            {selectedKeyId !== null && hasCustomKeyOverride && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={resetOverrideMutation.isPending}
                onClick={() => resetOverrideMutation.mutate(selectedKeyId)}
                className="h-8 px-2 text-xs"
              >
                <RotateCcw className="mr-1 size-3" />
                {s.removeKeyOverride}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{s.thresholdLabel}:</span>
            <Input
              type="number"
              min={4000}
              max={1000000}
              step={4000}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value) || DEFAULT_LONG_CONTEXT_THRESHOLD)}
              className="h-8 w-24 text-xs font-mono"
            />
            <span className="text-muted-foreground">{s.thresholdUnit}</span>
          </div>
        </div>
      </div>

      <div className="divide-y rounded-xl border">
        {SCENARIO_IDS.map((scenarioId) => {
          const rule = rules[scenarioId];
          const copy = s.scenarioLabels[scenarioId];
          const stat = telemetry?.byScenario[scenarioId];

          return (
            <div
              key={scenarioId}
              className="flex flex-col gap-2.5 p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={copy.title}
                    checked={rule.enabled}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        [scenarioId]: { ...prev[scenarioId], enabled: e.target.checked },
                      }))
                    }
                    className="size-3.5 rounded border"
                  />
                  {scenarioIcon(scenarioId)}
                  <span className="font-medium text-foreground">{copy.title}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {scenarioId}
                  </code>
                  {stat && stat.hitCount > 0 && (
                    <span className="text-[11px] text-muted-foreground">
                      {stat.hitCount} {s.hitsShort}
                      {stat.estimatedTokensSaved > 0
                        ? ` · ${formatCompactTokens(stat.estimatedTokensSaved)} ${s.savedShort}`
                        : ''}
                    </span>
                  )}
                </div>
                <p className="pl-5 text-[11px] text-muted-foreground">{copy.desc}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pl-5 sm:pl-0">
                <select
                  aria-label={`${copy.title} ${s.targetTierLabel}`}
                  value={rule.targetMode}
                  disabled={!rule.enabled}
                  onChange={(e) =>
                    setRules((prev) => ({
                      ...prev,
                      [scenarioId]: {
                        ...prev[scenarioId],
                        targetMode: e.target.value as ScenarioRoutingMode,
                      },
                    }))
                  }
                  className="h-7 rounded-lg border bg-background px-2 text-xs disabled:opacity-50"
                >
                  {SCENARIO_ROUTING_MODES.map((m) => (
                    <option key={m} value={m}>
                      {s.modeLabels[m]}
                    </option>
                  ))}
                </select>

                <select
                  aria-label={`${copy.title} ${s.targetModelLabel}`}
                  value={rule.targetModel ?? ''}
                  disabled={!rule.enabled}
                  onChange={(e) =>
                    setRules((prev) => ({
                      ...prev,
                      [scenarioId]: {
                        ...prev[scenarioId],
                        targetModel: e.target.value || null,
                      },
                    }))
                  }
                  className="h-7 max-w-44 rounded-lg border bg-background px-2 text-xs disabled:opacity-50"
                >
                  <option value="">{s.autoBestInTier}</option>
                  {models.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.displayName} ({m.sizeLabel})
                    </option>
                  ))}
                </select>

                <label className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={rule.overrideExplicitModel}
                    disabled={!rule.enabled}
                    onChange={(e) =>
                      setRules((prev) => ({
                        ...prev,
                        [scenarioId]: {
                          ...prev[scenarioId],
                          overrideExplicitModel: e.target.checked,
                        },
                      }))
                    }
                    className="size-3 rounded border"
                  />
                  {s.overrideExplicitLabel}
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowTester((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {showTester ? s.previewToggleHide : s.previewToggleShow}
        </button>

        {showTester && (
          <div className="mt-2 space-y-2 rounded-xl border bg-muted/30 p-3 text-xs">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={testPrompt}
                onChange={(e) => setTestPrompt(e.target.value)}
                placeholder={s.previewPromptPlaceholder}
                className="h-8 flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!testPrompt.trim() || previewMutation.isPending}
                onClick={() => previewMutation.mutate(testPrompt)}
              >
                {s.previewRunBtn}
              </Button>
            </div>
            {previewResult && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{s.previewDetectedLabel}</span>
                <Badge variant="outline" className="font-mono">
                  {previewResult.scenario}
                </Badge>
                <span className="text-muted-foreground">
                  {s.previewTokensLabel} {previewResult.estimatedInputTokens}
                </span>
                {previewResult.signals.map((sig) => (
                  <code
                    key={sig}
                    className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {sig}
                  </code>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
