import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gauge, RefreshCw } from 'lucide-react';
import type { QuotaTier, XAccountQuota } from '../../../../../shared/x-quota';
import { useUserSession } from '../../use-session';
import { useSessionRevision } from '../../session-state';
import { quotaApi } from '../quota-api';
import { quotaCountdown } from '../quota-format';
import { useQuotaStrings } from '../quota-strings';
import '../quota.css';

export default function Quota() {
  const s = useQuotaStrings();
  const session = useUserSession();
  const revision = useSessionRevision();
  const client = useQueryClient();
  const canView = session.hasPermission('view_x_usage');
  const canEdit = session.hasPermission('edit_x_settings');
  const [now, setNow] = useState(Date.now);
  const [provider, setProvider] = useState('');
  const [search, setSearch] = useState('');
  const [auto, setAuto] = useState(false);
  const query = useQuery({ queryKey: ['x-quota', revision], queryFn: ({ signal }) => quotaApi.list(signal), enabled: canView, refetchInterval: 30_000, retry: false });
  const invalidate = () => client.invalidateQueries({ queryKey: ['x-quota', revision] });
  const refresh = useMutation({
    mutationFn: async (ids: number[]) => { for (const id of ids) await quotaApi.refresh(id); },
    onSettled: invalidate, meta: { silenceToast: true },
  });
  const tier = useMutation({ mutationFn: ({ id, value }: { id: number; value: QuotaTier }) => quotaApi.tier(id, value), onSuccess: invalidate, meta: { silenceToast: true } });
  const accounts = query.data?.accounts ?? [];
  const refreshRef = useRef(() => {});
  useEffect(() => { refreshRef.current = () => {
    if (!refresh.isPending && canView) refresh.mutate(accounts.filter(a => a.supported && a.enabled).map(a => a.accountId));
  }; });
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refreshRef.current(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [auto]);
  if (!canView) return <div className="x-empty" role="alert">{s.readOnly}</div>;
  const visible = accounts.filter(a => (!provider || a.provider === provider) && `${a.label} ${a.providerName}`.toLowerCase().includes(search.toLowerCase()));
  const stale = (a: XAccountQuota) => a.stale || !a.observedAt || now - Date.parse(a.observedAt) >= (query.data?.freshnessMs ?? 300_000)
    || a.windows.some(w => w.resetAt && Date.parse(w.resetAt) <= now);
  return <>
    <div className="x-page-heading"><div><h1>{s.title}</h1><p>{s.help}</p></div><span className="x-heading-icon"><Gauge size={28} /></span></div>
    <section className="x-panel x-quota-policy"><h2>{s.tiers}</h2><div className="x-quota-tier-flow">{(['subscription', 'cheap', 'free'] as const).map((t, i) => <span key={t}>{i > 0 && <b aria-hidden="true">→ </b>}<strong>{i + 1}. {s[t]}</strong> <small>({accounts.filter(a => a.tier === t && a.enabled).length})</small></span>)}</div><p>{s.tiersHelp}</p><small>{s.tierNote}</small></section>
    <div className="x-quota-toolbar"><input aria-label={s.search} placeholder={s.search} value={search} onChange={e => setSearch(e.target.value)} /><select aria-label={s.all} value={provider} onChange={e => setProvider(e.target.value)}><option value="">{s.all}</option>{[...new Map(accounts.map(a => [a.provider, a.providerName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><button className="x-button" disabled={refresh.isPending || !accounts.some(a => a.supported && a.enabled)} onClick={() => refreshRef.current()}><RefreshCw size={15} />{refresh.isPending ? s.refreshing : s.refreshAll}</button></div>
    <label className="x-quota-auto"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />{s.auto}</label>
    {query.isPending && <p role="status">{s.refreshing}</p>}
    {query.isError && <div className="x-error" role="alert">{s.error}<button className="x-button" onClick={() => void query.refetch()}>{s.retry}</button></div>}
    {refresh.isError && <p className="x-error" role="alert">{s.refreshError}</p>}
    {tier.isError && <p className="x-error" role="alert">{s.saveError}</p>}
    <div className="x-quota-grid">{visible.map(a => <section className="x-panel x-quota-card" key={a.accountId}>
      <header><div><h2>{a.label || a.providerName}</h2><span>{a.providerName}{!a.enabled && ` · ${s.disabled}`}</span></div><select aria-label={`${s.tier}: ${a.label || a.providerName}`} value={a.tier} disabled={!canEdit || tier.isPending} onChange={e => tier.mutate({ id: a.accountId, value: e.target.value as QuotaTier })}>{(['subscription', 'cheap', 'free'] as const).map(t => <option value={t} key={t}>{s[t]}</option>)}</select></header>
      <p className={`x-quota-state ${stale(a) ? 'stale' : ''}`}>{stale(a) ? s.stale : s.live}</p>
      {!a.windows.length && <p className="x-quota-note">{s.noWindows}</p>}
      {a.windows.map(w => {
        const ratio = w.remaining != null && w.limit != null && w.limit > 0 ? Math.max(0, Math.min(100, w.remaining / w.limit * 100)) : null;
        const countdown = quotaCountdown(w.resetAt, now);
        return <div className="x-quota-window" key={`${w.id}:${w.modelId ?? ''}`}><div className="x-quota-window-title"><strong>{w.id}{w.modelId && ` · ${w.modelId}`}</strong><small>{w.source === 'header' ? s.header : s.api}</small></div>
          <p><span>{s.remaining}</span><strong>{w.remaining == null ? s.unknown : w.remaining.toLocaleString()} <small>{w.unit}</small></strong><span>/ {w.limit == null ? s.unknown : w.limit.toLocaleString()}</span></p>
          {ratio != null && <div className={`x-quota-meter ${ratio <= 10 ? 'low' : ''}`} role="progressbar" aria-label={`${w.id} ${s.remaining}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio)}><span style={{ width: `${ratio}%` }} /></div>}
          <div className="x-quota-reset" title={w.resetAt ? new Date(w.resetAt).toLocaleString() : undefined}>{countdown === 'reset' ? s.awaiting : countdown ? `${s.resetIn} ${countdown}` : s.noReset}</div>
          {(!w.blocking || w.modelId) && <small className="x-quota-note">{s.modelOnly}</small>}
        </div>;
      })}
      {a.error && <p className="x-error" role="alert">{a.error}</p>}
      {!a.supported && <p className="x-quota-note">{s.unavailable}</p>}
      <details className="x-quota-local"><summary>{s.local}</summary><p>{s.localHelp}</p><dl><dt>{s.requests}</dt><dd>{a.local.requests.toLocaleString()} / {a.local.requestCap || s.noCap}</dd><dt>{s.tokens}</dt><dd>{a.local.tokens.toLocaleString()} / {a.local.tokenCap || s.noCap}</dd></dl></details>
      <footer><div><small>{s.observed}: {a.observedAt ? new Date(a.observedAt).toLocaleString() : s.never}</small><small>{s.checked}: {a.checkedAt ? new Date(a.checkedAt).toLocaleString() : s.never}</small></div><button className="x-button" disabled={!a.supported || !a.enabled || refresh.isPending} onClick={() => refresh.mutate([a.accountId])}><RefreshCw size={14} />{s.refresh}</button></footer>
    </section>)}</div>
    {query.data && !accounts.length && <div className="x-empty"><p>{s.empty}</p><Link className="x-button" to="/thruline/providers">{s.connect}</Link></div>}
  </>;
}
