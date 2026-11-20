import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  Plus,
  Radio,
  Terminal,
  Wifi,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/copy-button';
import { useUserSession } from '@/custom/use-session';
import { toast } from '@/lib/toast';
import { useI18n } from '@/i18n';
import type { UserApiKey } from '../../../../shared/user-access';
import {
  IDE_PACKAGER_TOOLS,
  type IdeGeneratedFile,
  type IdePackagerToolId,
} from '../../../../shared/scenario-routing';
import {
  fetchIdeConnectionStatus,
  generateIdePackage,
  triggerIdeVerifyPing,
} from './api';
import { useScenarioRoutingStrings } from './strings';

function detectDefaultOrigin(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3001';
  if (import.meta.env.DEV) {
    return `http://${window.location.hostname}:${__SERVER_PORT__}`;
  }
  return window.location.origin;
}

function downloadConfigTextFile(file: IdeGeneratedFile): void {
  const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const POLL_WINDOW_MS = 60_000

// `Date.now()` reads during render are flagged by the hooks purity rule, so
// the time reads live in these module helpers; the values they return are
// still read fresh on every render / event.
function isPollingActive(until: number): boolean {
  return until > Date.now()
}

function nextPollingDeadline(): number {
  return Date.now() + POLL_WINDOW_MS
}

export function IdeConfigPackagerCard({
  initialRawKey,
  compact = false,
}: {
  initialRawKey?: string | null;
  compact?: boolean;
}) {
  const s = useScenarioRoutingStrings();
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const { session, hasPermission } = useUserSession();
  const isSignedIn = Boolean(session?.userId);
  const canRevealGateway = hasPermission('reveal_gateway_key');

  const detectedOrigin = detectDefaultOrigin();
  const isAlreadyLocal =
    detectedOrigin.includes('127.0.0.1') || detectedOrigin.includes('localhost');
  const [endpointMode, setEndpointMode] = useState<'origin' | 'local'>('origin');
  const gatewayUrl = endpointMode === 'local' ? 'http://127.0.0.1:3001' : detectedOrigin;

  const [selectedTool, setSelectedTool] = useState<IdePackagerToolId>('claude-code');
  const [selectedKeyChoice, setSelectedKeyChoice] = useState<string>('auto');
  const [rawKeyInput, setRawKeyInput] = useState<string>(initialRawKey ?? '');
  const [pollingUntil, setPollingUntil] = useState<number>(0);

  // A new pasted key from the parent replaces the input (render adjustment).
  const [prevInitialRawKey, setPrevInitialRawKey] = useState(initialRawKey)
  if (initialRawKey !== prevInitialRawKey) {
    setPrevInitialRawKey(initialRawKey)
    if (initialRawKey) setRawKeyInput(initialRawKey)
  }

  const { data: keysData } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
    enabled: isSignedIn,
  });
  const activeKeys = (keysData?.keys ?? []).filter((k) => !k.revoked);

  const { data: unifiedKeyData } = useQuery<{ apiKey: string }>({
    queryKey: ['api-key'],
    queryFn: () => apiFetch<{ apiKey: string }>('/api/settings/api-key'),
    enabled: isSignedIn && canRevealGateway,
  });

  const resolvedKeyId: number | null = (() => {
    if (selectedKeyChoice === 'unified') return null;
    if (selectedKeyChoice === 'auto') {
      return activeKeys[0]?.id ?? null;
    }
    const parsed = Number(selectedKeyChoice);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  const effectiveRawKey: string | null = (() => {
    const pasted = rawKeyInput.trim();
    if (pasted) return pasted;
    if (selectedKeyChoice === 'unified' && unifiedKeyData?.apiKey) {
      return unifiedKeyData.apiKey;
    }
    if (activeKeys.length === 0 && canRevealGateway && unifiedKeyData?.apiKey) {
      return unifiedKeyData.apiKey;
    }
    return null;
  })();

  const mintKeyMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ key: { id: number; key: string; name: string } }>('/api/user/keys', {
        method: 'POST',
        body: JSON.stringify({ name: `IDE (${s.toolLabels[selectedTool]})` }),
      }),
    onSuccess: (res) => {
      setRawKeyInput(res.key.key);
      setSelectedKeyChoice(String(res.key.id));
      void queryClient.invalidateQueries({ queryKey: ['user-api-keys'] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to mint Personal API Key');
    },
  });

  const { data: packageData, isFetching: isGenerating } = useQuery({
    queryKey: [
      'scenario-ide-package',
      selectedTool,
      gatewayUrl,
      resolvedKeyId,
      effectiveRawKey ?? '',
    ],
    queryFn: () =>
      generateIdePackage({
        toolId: selectedTool,
        gatewayUrl,
        keyId: resolvedKeyId,
        rawApiKey: effectiveRawKey,
        defaultModel: 'auto',
      }),
    enabled: isSignedIn,
  });

  const isPolling = isPollingActive(pollingUntil);

  const { data: statusData, refetch: refetchStatus } = useQuery({
    queryKey: ['scenario-ide-status', resolvedKeyId ?? 'any'],
    queryFn: () => fetchIdeConnectionStatus(resolvedKeyId),
    enabled: isSignedIn,
    refetchInterval: isPolling ? 3_000 : false,
  });

  // Once the connection is confirmed, polling stops (render adjustment).
  if (isPolling && statusData?.status?.connected) setPollingUntil(0);

  useEffect(() => {
    if (!isPolling) return;
    const timer = setTimeout(() => {
      if (Date.now() >= pollingUntil) setPollingUntil(0);
    }, Math.max(500, pollingUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [isPolling, pollingUntil]);

  const verifyMutation = useMutation({
    mutationFn: () =>
      triggerIdeVerifyPing({
        keyId: resolvedKeyId,
        rawApiKey:
          effectiveRawKey && effectiveRawKey.startsWith('sk-flm-') ? effectiveRawKey : null,
      }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['scenario-ide-status'] });
      if (!res.status.connected) {
        setPollingUntil(nextPollingDeadline());
      }
      void refetchStatus();
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Verification check failed');
    },
  });

  const [shellTab, setShellTab] = useState<'powershell' | 'bash'>('powershell');
  if (!isSignedIn) return null;

  const bundle = packageData?.bundle;
  const connStatus = statusData?.status;
  const isConnected = Boolean(connStatus?.connected);
  const steps = bundle ? (locale === 'vi' ? bundle.stepsVi : bundle.stepsEn) : [];

  return (
    <section
      className={`mb-6 rounded-3xl border bg-card ${compact ? 'p-4' : 'p-5'} space-y-4 shadow-xs`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Terminal className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{s.packagerTitle}</h2>
            {isConnected ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              >
                <CheckCircle2 className="size-3.5" />
                {s.verifiedGreenBadge}
              </Badge>
            ) : isPolling ? (
              <Badge
                variant="outline"
                className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              >
                <Radio className="size-3.5 animate-pulse" />
                {s.waitingPingBadge}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                <Wifi className="size-3" />
                {s.notVerifiedBadge}
              </Badge>
            )}
          </div>
          <p className="max-w-3xl text-xs text-muted-foreground">{s.packagerSubtitle}</p>
        </div>

        <Button
          type="button"
          size="sm"
          variant={isConnected ? 'outline' : 'default'}
          disabled={verifyMutation.isPending}
          onClick={() => verifyMutation.mutate()}
        >
          {verifyMutation.isPending || isPolling ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="mr-1.5 size-3.5" />
          )}
          {isPolling ? s.verifyingBtn : s.verifyBtn}
        </Button>
      </div>

      {/* Key & Gateway Endpoint Bar */}
      <div className="grid grid-cols-1 gap-3 rounded-2xl border bg-muted/30 p-3.5 text-xs lg:grid-cols-12">
        <div className="space-y-1.5 lg:col-span-5">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">{s.selectKeyLabel}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={mintKeyMutation.isPending}
              onClick={() => mintKeyMutation.mutate()}
              className="h-7 px-2.5 text-[11px]"
            >
              <Plus className="mr-1 size-3" />
              {mintKeyMutation.isPending ? s.mintingQuickKeyBtn : s.mintQuickKeyBtn}
            </Button>
          </div>
          <select
            aria-label={s.selectKeyLabel}
            value={selectedKeyChoice}
            onChange={(e) => setSelectedKeyChoice(e.target.value)}
            className="h-8 w-full rounded-lg border bg-background px-2.5 text-xs"
          >
            {activeKeys.length === 0 ? (
              <option value="auto">{s.noActiveKeysOption}</option>
            ) : (
              activeKeys.map((k, idx) => (
                <option key={k.id} value={idx === 0 && selectedKeyChoice === 'auto' ? 'auto' : String(k.id)}>
                  {k.name} ({k.keyPrefix}••••)
                </option>
              ))
            )}
            {canRevealGateway && <option value="unified">{s.unifiedGatewayOption}</option>}
          </select>
        </div>

        <div className="space-y-1.5 lg:col-span-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">
              <KeyRound className="mr-1 inline size-3" />
              Secret
            </span>
            {bundle?.hasRawKey && (
              <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                {s.rawKeyReadyBadge}
              </span>
            )}
          </div>
          <Input
            type="password"
            value={rawKeyInput}
            onChange={(e) => setRawKeyInput(e.target.value)}
            placeholder={s.pasteKeyPlaceholder}
            className="h-8 font-mono text-xs"
          />
          {!bundle?.hasRawKey && (
            <p className="text-[11px] text-muted-foreground">{s.pasteKeyHint}</p>
          )}
        </div>

        <div className="space-y-1.5 lg:col-span-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">{s.endpointLabel}</span>
            {!isAlreadyLocal && (
              <div className="inline-flex rounded-md border bg-background p-0.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => setEndpointMode('origin')}
                  className={`rounded px-1.5 py-0.5 ${
                    endpointMode === 'origin'
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground'
                  }`}
                >
                  {s.endpointOriginBtn}
                </button>
                <button
                  type="button"
                  onClick={() => setEndpointMode('local')}
                  className={`rounded px-1.5 py-0.5 ${
                    endpointMode === 'local'
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground'
                  }`}
                >
                  {s.endpointLocalBtn}
                </button>
              </div>
            )}
          </div>
          <div className="flex h-8 items-center justify-between rounded-lg border bg-background px-2.5 font-mono text-[11px]">
            <span className="truncate">{bundle?.baseUrl ?? gatewayUrl}</span>
            <CopyButton
              text={bundle?.baseUrl ?? gatewayUrl}
              className="size-6 shrink-0"
              label={s.endpointLabel}
            />
          </div>
        </div>
      </div>

      {/* Tool Tabs */}
      <div className="flex flex-wrap gap-1.5 border-b pb-2.5">
        {IDE_PACKAGER_TOOLS.map((toolId) => (
          <button
            key={toolId}
            type="button"
            onClick={() => setSelectedTool(toolId)}
            className={`rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedTool === toolId
                ? 'bg-foreground text-background'
                : 'bg-muted/50 text-muted-foreground hover:text-foreground'
            }`}
          >
            {s.toolLabels[toolId]}
          </button>
        ))}
      </div>

      {/* Generated 1-Liner & Config Files */}
      {bundle && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="space-y-3 lg:col-span-7">
            <div className="flex items-center justify-between">
              <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setShellTab('powershell')}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    shellTab === 'powershell'
                      ? 'bg-background text-foreground shadow-2xs'
                      : 'text-muted-foreground'
                  }`}
                >
                  {s.shellPowerShell}
                </button>
                <button
                  type="button"
                  onClick={() => setShellTab('bash')}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    shellTab === 'bash'
                      ? 'bg-background text-foreground shadow-2xs'
                      : 'text-muted-foreground'
                  }`}
                >
                  {s.shellBash}
                </button>
              </div>
              <CopyButton
                text={shellTab === 'powershell' ? bundle.powershellSnippet : bundle.bashSnippet}
                label={s.copyCommand}
                className="h-7 px-2.5 text-xs"
              />
            </div>

            <pre className="max-h-52 overflow-auto rounded-xl border bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
              {shellTab === 'powershell' ? bundle.powershellSnippet : bundle.bashSnippet}
            </pre>

            {(isPolling || !isConnected) && (
              <div className="rounded-xl border border-dashed bg-muted/20 p-3 text-xs space-y-1.5">
                <p className="text-[11px] text-muted-foreground">{s.verifyTerminalHint}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[11px]">
                    {shellTab === 'powershell'
                      ? bundle.verifyPowershellSnippet
                      : bundle.verifyBashSnippet}
                  </code>
                  <CopyButton
                    text={
                      shellTab === 'powershell'
                        ? bundle.verifyPowershellSnippet
                        : bundle.verifyBashSnippet
                    }
                    className="size-7 shrink-0"
                    label={s.verifyBtn}
                  />
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3 lg:col-span-5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">{s.configFilesLabel}</span>
              {isGenerating && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </div>

            <div className="space-y-2">
              {bundle.files.map((file) => (
                <div
                  key={file.filename}
                  className="flex items-center justify-between gap-2 rounded-xl border bg-background p-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono font-medium text-foreground">
                      {file.targetPath}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {locale === 'vi' ? file.descriptionVi : file.descriptionEn}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <CopyButton
                      text={file.content}
                      label={file.filename}
                      className="size-7"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => downloadConfigTextFile(file)}
                      className="h-7 px-2 text-[11px]"
                    >
                      <Download className="mr-1 size-3" />
                      {s.downloadFile}
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-muted/30 p-3 text-xs space-y-1.5">
              <div className="font-medium text-foreground">{s.setupStepsLabel}</div>
              <ol className="list-decimal space-y-1 pl-4 text-[11px] text-muted-foreground">
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {connStatus && connStatus.recentRequests5m > 0 && (
                <p className="pt-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                  {s.recentCallsCount.replace('{count}', String(connStatus.recentRequests5m))}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
