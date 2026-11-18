import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowLeft, CheckCircle2, Clock, Cpu, RefreshCw, ShieldCheck } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useCustomT } from '@/custom/i18n/use-custom-t';

interface PublicFamily {
  id: string;
  name: string;
  count: number;
}

interface PublicStatusData {
  status: 'operational' | 'degraded';
  version: string;
  uptimeSeconds: number;
  uptimeHuman: string;
  timestamp: string;
  models: {
    total: number;
    chat: number;
    embedding: number;
    media: number;
  };
  families: PublicFamily[];
}

export function StatusPage() {
  const tc = useCustomT();
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<PublicStatusData>({
    queryKey: ['public-status'],
    queryFn: async () => {
      const t0 = performance.now();
      const res = await fetch('/api/public/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLatencyMs(Math.round(performance.now() - t0));
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const isOperational = data?.status === 'operational';

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top Navbar */}
      <header className="border-b bg-card/50 backdrop-blur sticky top-0 z-30">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="font-bold text-base tracking-tight">FreeLLMAPI</span>
            <span className="rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-[11px] font-medium text-primary">
              {tc('System Status')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-xs text-muted-foreground"
            >
              <RefreshCw className={`size-3.5 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
              {tc('Refresh')}
            </Button>
            <NavLink to="/">
              <Button variant="outline" size="sm" className="text-xs">
                <ArrowLeft className="size-3.5 mr-1" />
                {tc('Back to Dashboard')}
              </Button>
            </NavLink>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6 space-y-8">
        {/* Big Banner */}
        <div
          className={`rounded-3xl border p-6 sm:p-8 flex flex-col sm:flex-row sm:items-center justify-between gap-6 shadow-sm ${
            isOperational
              ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-950 dark:text-emerald-100'
              : 'bg-amber-500/5 border-amber-500/20 text-amber-950 dark:text-amber-100'
          }`}
        >
          <div className="flex items-start gap-4">
            <div className="relative mt-1">
              <span className={`inline-flex size-3.5 rounded-full ${isOperational ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <span
                className={`absolute inset-0 size-3.5 animate-ping rounded-full opacity-75 ${
                  isOperational ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
            </div>
            <div className="space-y-1">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
                {isLoading
                  ? tc('Checking service status…')
                  : isOperational
                  ? tc('All Systems Operational')
                  : tc('Some services experiencing degraded performance')}
              </h1>
              <p className="text-xs text-muted-foreground">
                {tc('Real-time operational status for AI routing, model proxies, and authentication gateways.')}
              </p>
            </div>
          </div>
          {latencyMs !== null && (
            <div className="flex items-center gap-2 rounded-xl border bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shrink-0">
              <Activity className="size-3.5 text-primary" />
              <span>{tc('Latency:')} <strong>{latencyMs}ms</strong></span>
            </div>
          )}
        </div>

        {/* Metrics Overview Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-2xl border bg-card p-5 space-y-2 shadow-sm">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{tc('Operational Gateway')}</span>
              <ShieldCheck className="size-4 text-emerald-500" />
            </div>
            <div className="text-2xl font-bold text-foreground capitalize">
              {data?.status ?? '—'}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {tc('Version')} {data?.version ?? '0.4.1'} • {tc('SSL / API Gateways active')}
            </p>
          </div>

          <div className="rounded-2xl border bg-card p-5 space-y-2 shadow-sm">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{tc('Active Models Catalog')}</span>
              <Cpu className="size-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">
              {data?.models?.total ?? 0}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {data?.models?.chat ?? 0} {tc('chat')} • {data?.models?.embedding ?? 0} {tc('embeddings')} • {data?.models?.media ?? 0} {tc('media')}
            </p>
          </div>

          <div className="rounded-2xl border bg-card p-5 space-y-2 shadow-sm">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{tc('System Uptime')}</span>
              <Clock className="size-4 text-primary" />
            </div>
            <div className="text-2xl font-bold text-foreground">
              {data?.uptimeHuman ?? '—'}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {tc('Continuous uptime on current instance')}
            </p>
          </div>
        </div>

        {/* Operational Model Families */}
        <div className="rounded-2xl border bg-card overflow-hidden shadow-sm">
          <div className="border-b px-5 py-4 flex items-center justify-between">
            <div className="space-y-0.5">
              <h2 className="text-sm font-semibold text-foreground">{tc('Operational Model Families')}</h2>
              <p className="text-xs text-muted-foreground">
                {tc('Verified upstream inference endpoints available through personal and gateway keys.')}
              </p>
            </div>
            <span className="text-xs font-mono text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {data?.families?.length ?? 0} {tc('platforms')}
            </span>
          </div>

          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">{tc('Loading model status…')}</div>
          ) : isError ? (
            <div className="p-8 text-center text-sm text-destructive">{error instanceof Error ? error.message : tc('Failed to load status')}</div>
          ) : (data?.families ?? []).length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">{tc('No models currently configured')}</div>
          ) : (
            <div className="divide-y">
              {data!.families.map((fam) => (
                <div key={fam.id} className="p-4 flex items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
                    <div>
                      <div className="text-sm font-medium text-foreground">{fam.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {fam.count} {fam.count === 1 ? tc('model available') : tc('models available')}
                      </div>
                    </div>
                  </div>
                  <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {tc('Operational')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default StatusPage;
