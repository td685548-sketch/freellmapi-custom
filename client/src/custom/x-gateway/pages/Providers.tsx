import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Check, GitBranch, KeyRound, LoaderCircle, Search, Server, ShieldCheck, Waypoints } from 'lucide-react'
import { accountsApi, refreshAccounts, useAccounts, type BatchTestResponse } from '../api'
import { useXStrings } from '../strings'
import type { AccountProvider } from '../../../../../shared/x-accounts'

const PROVIDER_ICON_FILES: Record<string, string> = {
  'github-copilot': 'copilot.png',
  google: 'gemini.png',
  'perplexity-agent': 'perplexity-agent.png',
  'gitlab-duo': 'gitlab.png',
  'vercel-ai-gateway': 'vercel-ai-gateway.png',
  'ollama-search': 'ollama.png',
  'minimax-code': 'minimax.png',
  'minimax-code-global': 'minimax.png',
  'opencode-zen': 'opencode.png',
  'deepseek-web': 'deepseek.png',
  'muse-web': 'muse.png',
  'gemini-web': 'gemini.png',
  'chatgpt-web': 'openai.png',
  codewhale: 'codewhale.svg',
  pi: 'pi.svg',
  smelt: 'smelt.svg',
}
const NO_ICON_PROVIDERS = new Set(['custom', 'runcrate'])
const failedIconIds = new Set<string>()

export function getProviderIconSrc(providerId: string): string | null {
  const id = providerId.trim().toLowerCase()
  if (!id || NO_ICON_PROVIDERS.has(id) || failedIconIds.has(id)) return null
  const file = PROVIDER_ICON_FILES[id] ?? `${id}.png`
  return `/providers/${file}`
}

export function ProviderMark({ id, name }: { id: string; name?: string }) {
  const src = getProviderIconSrc(id)
  const [errored, setErrored] = useState(false)
  const colors: Record<string, string> = { openrouter: 'violet', 'github-copilot': 'slate', groq: 'orange', google: 'blue', nvidia: 'green', mistral: 'orange', anthropic: 'sand', custom: 'slate' }
  if (src && !errored) {
    return (
      <span className="x-provider-mark x-provider-mark-logo" aria-hidden="true">
        <img
          src={src}
          alt={name ?? id}
          loading="lazy"
          decoding="async"
          onError={() => {
            failedIconIds.add(id.trim().toLowerCase())
            setErrored(true)
          }}
        />
      </span>
    )
  }
  return <span className={`x-provider-mark ${colors[id] ?? 'blue'}`} aria-hidden="true">{id === 'github-copilot' ? <GitBranch size={26} /> : id === 'openrouter' ? <Waypoints size={27} /> : <span>{id.slice(0, 2).toUpperCase()}</span>}</span>
}

export function AccountLoadState({ error, retry }: { error?: boolean; retry?: () => void }) {
  const s = useXStrings()
  return <div className="x-empty" role={error ? 'alert' : 'status'}>{error ? <Server size={32} /> : <LoaderCircle size={30} className="x-spin" />}<p>{error ? s.loadError : s.loading}</p>{error && <button className="x-button" onClick={retry}>{s.retry}</button>}</div>
}

function ProviderCard({ provider }: { provider: AccountProvider }) {
  const s = useXStrings()
  const enabled = provider.accounts.filter(account => account.enabled).length
  const login = provider.category === 'oauth' || provider.authMethods.some(method => method === 'oauth_pkce' || method === 'device_code')
  const isCookie = (provider.category === 'webCookie' || provider.authMethods.includes('cookie')) && !login
  return <Link to={`/x/providers/${encodeURIComponent(provider.id)}`} className="x-provider-card">
    <div className="x-card-top"><ProviderMark id={provider.id} name={provider.name} /><div className="x-card-badges">{provider.hasMainDbKey && <span className="x-badge x-main-db-badge">{s.inMainDb}</span>}<span className={`x-badge ${provider.accounts.length ? 'x-green' : ''}`}>{provider.accounts.length ? <><span className="x-dot" />{s.connected}</> : s.available}</span></div></div>
    <h3>{provider.name}<ArrowUpRight size={16} /></h3>
    <p className="x-muted">{login ? (provider.id === 'github-copilot' ? s.device : s.oauth) : isCookie ? s.cookie : s.apiKey}</p>
    <div className="x-card-bottom"><span>{provider.accounts.length} {s.accounts.toLowerCase()}</span><span>{enabled > 0 ? <><Check size={13} />{enabled} {s.active.toLowerCase()}</> : <KeyRound size={14} />}</span></div>
  </Link>
}

export type ProviderStatusFilter = 'all' | 'connected' | 'unconnected'
export type ProviderTypeFilter = 'all' | 'login' | 'apikey' | 'free' | 'cookie'

function matchesTypeFilter(provider: AccountProvider, typeFilter: ProviderTypeFilter): boolean {
  if (typeFilter === 'all') return true
  const isLogin = provider.category === 'oauth' || provider.authMethods.some(m => m === 'oauth_pkce' || m === 'device_code')
  if (typeFilter === 'login') return isLogin
  if (typeFilter === 'free') return provider.category === 'free' || provider.category === 'freeTier'
  if (typeFilter === 'cookie') return provider.category === 'webCookie' || (provider.authMethods.includes('cookie') && !isLogin)
  if (typeFilter === 'apikey') return provider.authMethods.includes('api_key') && !isLogin && provider.category !== 'webCookie'
  return true
}

export default function Providers() {
  const s = useXStrings()
  const query = useAccounts()
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<ProviderStatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<ProviderTypeFilter>('all')
  const [hideMainDb, setHideMainDb] = useState(true)
  const [batchSummary, setBatchSummary] = useState<BatchTestResponse['summary'] | null>(null)
  const batchTest = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => accountsApi.testBatch({}),
    onSuccess: async (res) => {
      setBatchSummary(res.summary)
      await refreshAccounts(client)
    },
  })
  if (query.isPending) return <AccountLoadState />
  if (query.isError) return <AccountLoadState error retry={() => void query.refetch()} />
  const providers = query.data.providers
  const permissions = query.data.permissions
  const accounts = providers.flatMap(provider => provider.accounts)
  const mainDbCount = providers.filter(provider => provider.hasMainDbKey).length
  const filtered = providers.filter(provider => {
    if (hideMainDb && provider.hasMainDbKey) return false
    if (statusFilter === 'connected' && provider.accounts.length === 0) return false
    if (statusFilter === 'unconnected' && provider.accounts.length > 0) return false
    if (!matchesTypeFilter(provider, typeFilter)) return false
    return `${provider.name} ${provider.id} ${provider.alias ?? ''} ${provider.accounts.map(account => `${account.label} ${account.identity ?? ''}`).join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())
  })
  const hasCategories = filtered.some(provider => Boolean(provider.category))
  const login = hasCategories
    ? filtered.filter(provider => provider.category === 'oauth' || provider.authMethods.some(m => m === 'oauth_pkce' || m === 'device_code'))
    : filtered.filter(provider => provider.authMethods.some(method => method !== 'api_key'))
  const free = hasCategories ? filtered.filter(provider => provider.category === 'free') : []
  const freeTier = hasCategories ? filtered.filter(provider => provider.category === 'freeTier' && !login.includes(provider)) : []
  const api = hasCategories
    ? filtered.filter(provider => (!provider.category || provider.category === 'apikey') && !login.includes(provider))
    : filtered.filter(provider => provider.authMethods.every(method => method === 'api_key'))
  const webCookie = hasCategories ? filtered.filter(provider => provider.category === 'webCookie') : []

  return <>
    <div className="x-page-heading">
      <div><div className="x-eyebrow">FreeLLMAPI / X Gateway</div><h1>{s.providers}</h1><p>{s.providerHelp}</p></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {permissions?.test && accounts.length > 0 && (
          <button
            type="button"
            className="x-button"
            disabled={batchTest.isPending}
            onClick={() => batchTest.mutate()}
          >
            <ShieldCheck size={16} />
            {batchTest.isPending ? s.testing : `Batch test (${accounts.length})`}
          </button>
        )}
        <span className="x-heading-icon"><Server size={28} /></span>
      </div>
    </div>
    {batchSummary && (
      <p className="x-test-ok" role="status">
        <Check size={16} />
        Batch check completed: {batchSummary.passed}/{batchSummary.total} healthy
      </p>
    )}
    <div className="x-stats"><div><span>{s.connectedProviders}</span><strong>{providers.filter(provider => provider.accounts.length).length}<small> / {providers.length}</small></strong></div><div><span>{s.totalAccounts}</span><strong>{accounts.length}</strong></div><div><span>{s.enabledAccounts}</span><strong className="x-positive">{accounts.filter(account => account.enabled).length}</strong></div></div>
    <div className="x-toolbar">
      <label className="x-search"><Search size={18} /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={s.search} aria-label={s.search} /></label>
      <div className="x-filter-group">
        <div className="x-segment">
          <button className={statusFilter === 'all' ? 'selected' : ''} aria-pressed={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>{s.all}</button>
          <button className={statusFilter === 'connected' ? 'selected' : ''} aria-pressed={statusFilter === 'connected'} onClick={() => setStatusFilter('connected')}>{s.connected}</button>
          <button className={statusFilter === 'unconnected' ? 'selected' : ''} aria-pressed={statusFilter === 'unconnected'} onClick={() => setStatusFilter('unconnected')}>{s.notConnected}</button>
        </div>
        <div className="x-segment">
          <button className={typeFilter === 'all' ? 'selected' : ''} aria-pressed={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>{s.filterAllTypes}</button>
          <button className={typeFilter === 'login' ? 'selected' : ''} aria-pressed={typeFilter === 'login'} onClick={() => setTypeFilter('login')}>{s.filterLogin}</button>
          <button className={typeFilter === 'apikey' ? 'selected' : ''} aria-pressed={typeFilter === 'apikey'} onClick={() => setTypeFilter('apikey')}>{s.filterApiKey}</button>
          <button className={typeFilter === 'free' ? 'selected' : ''} aria-pressed={typeFilter === 'free'} onClick={() => setTypeFilter('free')}>{s.filterFree}</button>
          <button className={typeFilter === 'cookie' ? 'selected' : ''} aria-pressed={typeFilter === 'cookie'} onClick={() => setTypeFilter('cookie')}>{s.filterCookie}</button>
        </div>
        <div className="x-segment">
          <button className={hideMainDb ? 'selected' : ''} aria-pressed={hideMainDb} onClick={() => setHideMainDb(true)}>{s.hideMainDb}{mainDbCount > 0 ? ` (${mainDbCount})` : ''}</button>
          <button className={!hideMainDb ? 'selected' : ''} aria-pressed={!hideMainDb} onClick={() => setHideMainDb(false)}>{s.showMainDb}</button>
        </div>
      </div>
    </div>
    {login.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.oauthProviders}<span>{login.length}</span></h2><p>{s.oauthHelp}</p></div><div className="x-provider-grid">{login.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {free.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.freeProviders}<span>{free.length}</span></h2></div><div className="x-provider-grid">{free.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {freeTier.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.freeTierProviders}<span>{freeTier.length}</span></h2></div><div className="x-provider-grid">{freeTier.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {api.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.apiProviders}<span>{api.length}</span></h2><p>{s.apiHelp}</p></div><div className="x-provider-grid">{api.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {webCookie.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.webCookieProviders}<span>{webCookie.length}</span></h2></div><div className="x-provider-grid">{webCookie.map(provider => <ProviderCard key={provider.id} provider={provider} />)}</div></section>}
    {filtered.length === 0 && <div className="x-empty"><Search size={32} /><h2>{s.noResults}</h2><p>{s.noResultsHelp}</p></div>}
    <p className="x-footnote">{s.sharedPool}</p>
  </>
}
