import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CheckSquare,
  Cloud,
  Copy,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react'
import { useUserSession } from '../../use-session'
import { useSessionRevision } from '../../session-state'
import {
  proxyPoolApi,
  type XProxyPoolDeployParams,
  type XProxyPoolEntry,
  type XProxyPoolTestAllResult,
  type XProxyPoolTestResult,
} from '../proxy-pool-api'
import { usePoolStrings } from '../proxy-pool-strings'

interface Draft {
  id?: number
  name: string
  proxyUrl: string
}

const DEFAULT_WORKER_SCRIPT = `addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const target = request.headers.get('fetch-relay-target');
  if (!target) {
    return new Response(JSON.stringify({ status: 'ok', service: 'freellmapi-worker-relay' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }

  try {
    const reqHeaders = new Headers(request.headers);
    reqHeaders.delete('fetch-relay-target');
    reqHeaders.delete('fetch-relay-authorization');
    reqHeaders.delete('host');

    return await fetch(target, {
      method: request.method,
      headers: reqHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    });
  }
};`

export default function ProxyPool() {
  const s = usePoolStrings()
  const client = useQueryClient()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('edit_x_settings')

  const query = useQuery({
    queryKey: ['x-proxy-pool', revision],
    queryFn: ({ signal }) => proxyPoolApi.list(signal),
    retry: false,
  })

  const configQuery = useQuery({
    queryKey: ['x-proxy-pool-config', revision],
    queryFn: ({ signal }) => proxyPoolApi.getConfig(signal),
    retry: false,
  })

  const [draft, setDraft] = useState<Draft | null>(null)
  const [showBatch, setShowBatch] = useState(false)
  const [batchText, setBatchText] = useState('')
  const [batchResult, setBatchResult] = useState<{ imported: number; failed: number } | null>(null)

  const [showDeploy, setShowDeploy] = useState(false)
  const [deployDraft, setDeployDraft] = useState<XProxyPoolDeployParams>({
    provider: 'cloudflare',
    apiToken: '',
    accountId: '',
    workerName: 'freellmapi-relay',
  })
  const [copiedTemplate, setCopiedTemplate] = useState(false)

  const [showSettings, setShowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<{ noProxy: string; strictProxy: boolean } | null>(null)
  const [settingsSavedMsg, setSettingsSavedMsg] = useState(false)

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [testResults, setTestResults] = useState<Record<number, XProxyPoolTestResult>>({})
  const [testAllSummary, setTestAllSummary] = useState<XProxyPoolTestAllResult | null>(null)
  const [copiedWebhookId, setCopiedWebhookId] = useState<number | null>(null)

  const done = async () => {
    setDraft(null)
    setSelectedIds(new Set())
    await client.invalidateQueries({ queryKey: ['x-proxy-pool'] })
    await client.invalidateQueries({ queryKey: ['x-accounts'] })
  }

  const save = useMutation({
    meta: { silenceToast: true },
    mutationFn: (d: Draft) =>
      d.id
        ? proxyPoolApi.update(d.id, { name: d.name, ...(d.proxyUrl.trim() ? { proxyUrl: d.proxyUrl.trim() } : {}) })
        : proxyPoolApi.create({ name: d.name, proxyUrl: d.proxyUrl.trim() }),
    onSuccess: done,
  })

  const toggle = useMutation({
    meta: { silenceToast: true },
    mutationFn: (entry: XProxyPoolEntry) => proxyPoolApi.update(entry.id, { enabled: !entry.enabled }),
    onSuccess: done,
  })

  const toggleWebhook = useMutation({
    meta: { silenceToast: true },
    mutationFn: (entry: XProxyPoolEntry) =>
      proxyPoolApi.update(entry.id, { webhookEnabled: !entry.webhookEnabled }),
    onSuccess: done,
  })

  const regenerateToken = useMutation({
    meta: { silenceToast: true },
    mutationFn: (id: number) => proxyPoolApi.regenerateWebhookToken(id),
    onSuccess: done,
  })

  const remove = useMutation({
    mutationFn: (id: number) => proxyPoolApi.remove(id),
    onSuccess: done,
  })

  const testSingle = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (id: number) => ({ id, ...(await proxyPoolApi.test(id)) }),
    onSuccess: result => {
      setTestResults(prev => ({ ...prev, [result.id]: result }))
    },
  })

  const testAll = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => proxyPoolApi.testAll(),
    onSuccess: summary => {
      setTestAllSummary(summary)
      const mapped: Record<number, XProxyPoolTestResult> = {}
      for (const r of summary.results) {
        mapped[r.id] = r
      }
      setTestResults(prev => ({ ...prev, ...mapped }))
    },
  })

  const batchImport = useMutation({
    meta: { silenceToast: true },
    mutationFn: (proxies: string) => proxyPoolApi.batchImport({ proxies }),
    onSuccess: async res => {
      setBatchResult({ imported: res.importedCount, failed: res.failedCount })
      setBatchText('')
      await done()
    },
  })

  const bulkAction = useMutation({
    meta: { silenceToast: true },
    mutationFn: (params: { action: 'enable' | 'disable' | 'delete'; ids: number[] }) =>
      proxyPoolApi.bulkAction(params),
    onSuccess: async () => {
      setSelectedIds(new Set())
      await done()
    },
  })

  const deploy = useMutation({
    meta: { silenceToast: true },
    mutationFn: (params: XProxyPoolDeployParams) => proxyPoolApi.deployWorker(params),
    onSuccess: async () => {
      setShowDeploy(false)
      await done()
    },
  })

  const saveConfig = useMutation({
    meta: { silenceToast: true },
    mutationFn: (conf: { noProxy: string[]; strictProxy: boolean }) => proxyPoolApi.saveConfig(conf),
    onSuccess: async () => {
      setSettingsSavedMsg(true)
      await client.invalidateQueries({ queryKey: ['x-proxy-pool-config'] })
      setTimeout(() => setSettingsSavedMsg(false), 3000)
    },
  })

  const allEntries = query.data?.entries ?? []
  const allSelected = allEntries.length > 0 && selectedIds.size === allEntries.length

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(allEntries.map(e => e.id)))
    }
  }

  const handleToggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyTemplate = async () => {
    try {
      await navigator.clipboard.writeText(DEFAULT_WORKER_SCRIPT)
      setCopiedTemplate(true)
      setTimeout(() => setCopiedTemplate(false), 2500)
    } catch {
      // fallback
    }
  }

  const openSettings = () => {
    const cur = configQuery.data?.config
    setSettingsDraft({
      noProxy: (cur?.noProxy ?? []).join(', '),
      strictProxy: cur?.strictProxy ?? false,
    })
    setShowSettings(true)
  }

  return (
    <>
      <div className="x-page-heading">
        <div>
          <h1>{s.proxies}</h1>
          <p>{s.proxiesHelp}</p>
        </div>
        <span className="x-heading-icon">
          <Network size={28} />
        </span>
      </div>

      {query.isPending && <p role="status">{s.loading}</p>}
      {query.isError && (
        <div className="x-error" role="alert">
          {s.loadError}
          <button className="x-button" onClick={() => void query.refetch()}>
            {s.retry}
          </button>
        </div>
      )}

      {/* Top action bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        {canEdit && (
          <>
            <button
              className="x-button x-primary"
              onClick={() => {
                save.reset()
                setShowBatch(false)
                setShowDeploy(false)
                setShowSettings(false)
                setDraft({ name: '', proxyUrl: '' })
              }}
            >
              <Plus size={16} />
              {s.newEntry}
            </button>

            <button
              className="x-button"
              onClick={() => {
                setDraft(null)
                setShowDeploy(false)
                setShowSettings(false)
                setShowBatch(prev => !prev)
                setBatchResult(null)
              }}
            >
              <UploadCloud size={16} />
              {s.batchImport}
            </button>

            <button
              className="x-button"
              onClick={() => {
                setDraft(null)
                setShowBatch(false)
                setShowSettings(false)
                setShowDeploy(prev => !prev)
              }}
            >
              <Cloud size={16} />
              {s.deployWorker}
            </button>

            <button
              className="x-button"
              disabled={testAll.isPending || allEntries.length === 0}
              onClick={() => {
                setTestAllSummary(null)
                testAll.mutate()
              }}
            >
              <ShieldCheck size={16} />
              {testAll.isPending ? s.testingAll : s.testAll}
            </button>

            <button
              className="x-button"
              onClick={() => {
                setDraft(null)
                setShowBatch(false)
                setShowDeploy(false)
                if (!showSettings) openSettings()
                else setShowSettings(false)
              }}
            >
              <Settings size={16} />
              {s.proxySettings}
            </button>
          </>
        )}
      </div>

      {!canEdit && <p className="x-caption">{s.readOnly}</p>}

      {/* Test-all summary alert banner */}
      {testAllSummary && (
        <div
          className="x-panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
            padding: '10px 14px',
            borderLeft: testAllSummary.unhealthy === 0 ? '4px solid #10b981' : '4px solid #f59e0b',
          }}
        >
          <div>
            <strong>{s.testAll}:</strong>{' '}
            {s.testAllSummary
              .replace('{healthy}', String(testAllSummary.healthy))
              .replace('{total}', String(testAllSummary.total))
              .replace('{latencyMs}', String(testAllSummary.latencyMs))}
          </div>
          <button
            type="button"
            className="x-icon-button"
            aria-label="Close summary"
            onClick={() => setTestAllSummary(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Add / Edit Single Form */}
      {draft && (
        <form
          className="x-panel x-mgmt-form"
          onSubmit={e => {
            e.preventDefault()
            save.mutate(draft)
          }}
        >
          <h2>{draft.id ? s.editEntry : s.newEntry}</h2>
          <label>
            {s.entryName}
            <input
              value={draft.name}
              maxLength={64}
              required
              onChange={e => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            {s.entryUrl}
            <input
              value={draft.proxyUrl}
              maxLength={2048}
              required={!draft.id}
              placeholder={draft.id ? s.entryUrlKeep : s.entryUrlPlaceholder}
              onChange={e => setDraft({ ...draft, proxyUrl: e.target.value })}
            />
          </label>
          {save.isError && (
            <div role="alert" className="x-error">
              {save.error.message}
            </div>
          )}
          <div className="x-mgmt-actions">
            <button
              className="x-button x-primary"
              disabled={save.isPending || !draft.name.trim() || (!draft.id && !draft.proxyUrl.trim())}
            >
              {save.isPending ? s.saving : s.save}
            </button>
            <button type="button" className="x-button" onClick={() => setDraft(null)}>
              {s.cancel}
            </button>
          </div>
        </form>
      )}

      {/* Batch Import Form */}
      {showBatch && (
        <form
          className="x-panel x-mgmt-form"
          onSubmit={e => {
            e.preventDefault()
            if (batchText.trim()) batchImport.mutate(batchText)
          }}
        >
          <h2>{s.batchImport}</h2>
          <p className="x-caption">{s.batchImportHelp}</p>
          <label>
            {s.entryUrl}
            <textarea
              rows={6}
              value={batchText}
              placeholder={s.batchImportPlaceholder}
              style={{ fontFamily: 'monospace', fontSize: 13 }}
              onChange={e => setBatchText(e.target.value)}
            />
          </label>
          {batchResult && (
            <div
              className={batchResult.failed === 0 ? 'x-test-ok' : 'x-error'}
              role="status"
              style={{ padding: '8px 12px', borderRadius: 6 }}
            >
              {batchResult.failed === 0
                ? s.importSuccess.replace('{count}', String(batchResult.imported))
                : s.importPartial
                    .replace('{count}', String(batchResult.imported))
                    .replace('{failed}', String(batchResult.failed))}
            </div>
          )}
          {batchImport.isError && (
            <div role="alert" className="x-error">
              {batchImport.error.message}
            </div>
          )}
          <div className="x-mgmt-actions">
            <button
              type="submit"
              className="x-button x-primary"
              disabled={batchImport.isPending || !batchText.trim()}
            >
              {batchImport.isPending ? s.importing : s.import}
            </button>
            <button
              type="button"
              className="x-button"
              onClick={() => {
                setShowBatch(false)
                setBatchResult(null)
              }}
            >
              {s.cancel}
            </button>
          </div>
        </form>
      )}

      {/* 1-Click Serverless Relay Deploy Form */}
      {showDeploy && (
        <form
          className="x-panel x-mgmt-form"
          onSubmit={e => {
            e.preventDefault()
            deploy.mutate(deployDraft)
          }}
        >
          <h2>{s.deployWorker}</h2>
          <p className="x-caption">{s.deployWorkerHelp}</p>

          <label>
            {s.provider}
            <select
              value={deployDraft.provider}
              onChange={e =>
                setDeployDraft({ ...deployDraft, provider: e.target.value as 'cloudflare' | 'vercel' })
              }
            >
              <option value="cloudflare">Cloudflare Workers</option>
              <option value="vercel">Vercel Serverless Function</option>
            </select>
          </label>

          <label>
            {s.workerName}
            <input
              value={deployDraft.workerName}
              maxLength={64}
              required
              placeholder={s.workerNamePlaceholder}
              onChange={e => setDeployDraft({ ...deployDraft, workerName: e.target.value })}
            />
          </label>

          <label>
            {s.apiToken}
            <input
              type="password"
              value={deployDraft.apiToken}
              required
              placeholder={s.apiTokenPlaceholder}
              onChange={e => setDeployDraft({ ...deployDraft, apiToken: e.target.value })}
            />
          </label>

          {deployDraft.provider === 'cloudflare' && (
            <label>
              {s.accountId}
              <input
                value={deployDraft.accountId ?? ''}
                placeholder={s.accountIdPlaceholder}
                onChange={e => setDeployDraft({ ...deployDraft, accountId: e.target.value })}
              />
            </label>
          )}

          {deploy.isError && (
            <div role="alert" className="x-error">
              {deploy.error.message}
            </div>
          )}

          <div className="x-mgmt-actions">
            <button
              type="submit"
              className="x-button x-primary"
              disabled={deploy.isPending || !deployDraft.apiToken.trim() || !deployDraft.workerName.trim()}
            >
              <Cloud size={16} />
              {deploy.isPending ? s.deploying : s.deploy}
            </button>
            <button
              type="button"
              className="x-button"
              onClick={() => void handleCopyTemplate()}
              title={s.manualDeployHint}
            >
              {copiedTemplate ? <Check size={16} /> : <Copy size={16} />}
              {copiedTemplate ? s.copied : s.copyTemplate}
            </button>
            <button type="button" className="x-button" onClick={() => setShowDeploy(false)}>
              {s.cancel}
            </button>
          </div>
        </form>
      )}

      {/* Proxy Settings Panel (noProxy & strictProxy) */}
      {showSettings && settingsDraft && (
        <form
          className="x-panel x-mgmt-form"
          onSubmit={e => {
            e.preventDefault()
            saveConfig.mutate({
              noProxy: settingsDraft.noProxy
                .split(',')
                .map(x => x.trim())
                .filter(Boolean),
              strictProxy: settingsDraft.strictProxy,
            })
          }}
        >
          <h2>{s.proxySettings}</h2>

          <label>
            {s.noProxyLabel}
            <textarea
              rows={3}
              value={settingsDraft.noProxy}
              placeholder="openai.com, groq, api.anthropic.com"
              onChange={e => setSettingsDraft({ ...settingsDraft, noProxy: e.target.value })}
            />
            <span className="x-caption">{s.noProxyHelp}</span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{s.strictProxyLabel}</div>
              <div className="x-caption">{s.strictProxyHelp}</div>
            </div>
            <button
              type="button"
              className="x-switch"
              role="switch"
              aria-checked={settingsDraft.strictProxy}
              aria-label={s.strictProxyLabel}
              onClick={() => setSettingsDraft({ ...settingsDraft, strictProxy: !settingsDraft.strictProxy })}
            >
              <span />
            </button>
          </div>

          {settingsSavedMsg && <div className="x-test-ok">{s.settingsSaved}</div>}
          {saveConfig.isError && (
            <div role="alert" className="x-error">
              {saveConfig.error.message}
            </div>
          )}

          <div className="x-mgmt-actions">
            <button type="submit" className="x-button x-primary" disabled={saveConfig.isPending}>
              {s.saveSettings}
            </button>
            <button type="button" className="x-button" onClick={() => setShowSettings(false)}>
              {s.cancel}
            </button>
          </div>
        </form>
      )}

      {/* Bulk actions toolbar */}
      {canEdit && allEntries.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
            padding: '8px 12px',
            background: 'var(--x-alt)',
            borderRadius: 8,
            border: '1px solid var(--x-border)',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="x-icon-button"
              aria-label={allSelected ? s.deselectAll : s.selectAll}
              title={allSelected ? s.deselectAll : s.selectAll}
              onClick={handleSelectAll}
            >
              {allSelected ? <CheckSquare size={17} /> : <Square size={17} />}
            </button>
            <span style={{ fontSize: 13, fontWeight: 500 }}>
              {selectedIds.size > 0
                ? s.selectedCount.replace('{count}', String(selectedIds.size))
                : s.selectAll}
            </span>
          </div>

          {selectedIds.size > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="x-button x-small"
                disabled={bulkAction.isPending}
                onClick={() => bulkAction.mutate({ action: 'enable', ids: Array.from(selectedIds) })}
              >
                {s.bulkEnable}
              </button>
              <button
                className="x-button x-small"
                disabled={bulkAction.isPending}
                onClick={() => bulkAction.mutate({ action: 'disable', ids: Array.from(selectedIds) })}
              >
                {s.bulkDisable}
              </button>
              <button
                className="x-button x-small x-danger"
                disabled={bulkAction.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      s.bulkDeleteConfirm.replace('{count}', String(selectedIds.size)),
                    )
                  ) {
                    bulkAction.mutate({ action: 'delete', ids: Array.from(selectedIds) })
                  }
                }}
              >
                <Trash2 size={13} />
                {s.bulkDelete}
              </button>
            </div>
          )}
        </div>
      )}

      {query.data && !allEntries.length && !draft && !showBatch && !showDeploy && (
        <div className="x-empty">
          <p>{s.noEntries}</p>
        </div>
      )}

      {/* Proxy cards list */}
      <div className="x-mgmt-list">
        {allEntries.map(entry => {
          const testRes = testResults[entry.id]
          const isSelected = selectedIds.has(entry.id)

          return (
            <section
              className="x-panel x-mgmt-card"
              key={entry.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                border: isSelected ? '1px solid var(--x-primary, #6366f1)' : undefined,
              }}
            >
              <header style={{ alignItems: 'flex-start', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  {canEdit && (
                    <button
                      type="button"
                      className="x-icon-button"
                      aria-label={`Select ${entry.name}`}
                      style={{ marginTop: 2 }}
                      onClick={() => handleToggleSelect(entry.id)}
                    >
                      {isSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                    </button>
                  )}
                  <div>
                    <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0, wordBreak: 'break-word' }}>
                      {entry.name}
                    </h2>
                    <p className="x-caption" style={{ marginTop: 3 }}>
                      {entry.boundAccounts} {s.boundAccounts}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <span className={`x-badge ${entry.enabled ? 'x-green' : ''}`}>
                    <span className="x-dot" />
                    {entry.enabled ? s.enabled : s.disabled}
                  </span>
                  {canEdit && (
                    <button
                      className="x-switch"
                      role="switch"
                      aria-checked={entry.enabled}
                      aria-label={`${entry.enabled ? s.disabled : s.enabled}: ${entry.name}`}
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate(entry)}
                    >
                      <span />
                    </button>
                  )}
                </div>
              </header>

              <div
                style={{
                  margin: '12px 0 8px',
                  padding: '8px 10px',
                  background: 'var(--x-alt)',
                  border: '1px solid var(--x-border)',
                  borderRadius: '7px',
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  overflowWrap: 'anywhere',
                  color: 'var(--x-text)',
                }}
              >
                <code>{entry.proxyUrl}</code>
              </div>

              {testRes && (
                <div
                  style={{ margin: '6px 0 10px', fontSize: '12px' }}
                  className={testRes.ok ? 'x-test-ok' : 'x-error'}
                  role="status"
                >
                  {testRes.ok ? `${s.testOk} · ${testRes.latencyMs} ms` : testRes.message ?? s.testFailed}
                </div>
              )}
              {!testRes && entry.lastTestOk !== null && entry.lastTestOk !== undefined && (
                <div
                  style={{ margin: '6px 0 10px', fontSize: '12px' }}
                  className={entry.lastTestOk ? 'x-test-ok' : 'x-error'}
                  role="status"
                >
                  {entry.lastTestOk
                    ? `${s.testOk} · ${entry.lastTestLatency ?? 0} ms`
                    : entry.lastTestMessage ?? s.testFailed}
                  {entry.lastTestAt && (
                    <span style={{ opacity: 0.65, marginLeft: 6, fontSize: '11px' }}>
                      ({new Date(entry.lastTestAt).toLocaleTimeString()})
                    </span>
                  )}
                </div>
              )}
              {testSingle.isError && testSingle.variables === entry.id && (
                <p className="x-error" role="alert" style={{ margin: '6px 0 10px' }}>
                  {testSingle.error.message}
                </p>
              )}

              {/* MiProxy Webhook section */}
              <div
                style={{
                  margin: '8px 0 12px',
                  padding: '10px 12px',
                  background: 'var(--x-alt)',
                  border: '1px solid var(--x-border)',
                  borderRadius: '7px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Network size={14} style={{ opacity: 0.8 }} />
                    <span style={{ fontSize: '13px', fontWeight: 600 }}>{s.webhook}</span>
                  </div>
                  {canEdit && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: '12px', opacity: 0.75 }}>
                        {entry.webhookEnabled ? s.enabled : s.disabled}
                      </span>
                      <button
                        className="x-switch"
                        role="switch"
                        aria-checked={Boolean(entry.webhookEnabled)}
                        aria-label={`${s.webhook}: ${entry.name}`}
                        disabled={toggleWebhook.isPending}
                        onClick={() => toggleWebhook.mutate(entry)}
                      >
                        <span />
                      </button>
                    </div>
                  )}
                </div>

                {entry.webhookEnabled && entry.webhookToken && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        readOnly
                        value={`${window.location.origin}/api/proxy-webhook?token=${encodeURIComponent(entry.webhookToken)}`}
                        style={{
                          fontSize: '11px',
                          fontFamily: 'monospace',
                          padding: '4px 8px',
                          flex: 1,
                          background: 'var(--x-bg, #fff)',
                          border: '1px solid var(--x-border)',
                          borderRadius: '4px',
                        }}
                        onClick={e => (e.target as HTMLInputElement).select()}
                      />
                      <button
                        type="button"
                        className="x-button x-small"
                        title={s.copyWebhookUrl}
                        onClick={() => {
                          navigator.clipboard.writeText(
                            `${window.location.origin}/api/proxy-webhook?token=${encodeURIComponent(entry.webhookToken!)}`,
                          )
                          setCopiedWebhookId(entry.id)
                          setTimeout(() => setCopiedWebhookId(null), 2500)
                        }}
                      >
                        {copiedWebhookId === entry.id ? <Check size={13} /> : <Copy size={13} />}
                        {copiedWebhookId === entry.id ? s.copied : s.copyWebhookUrl}
                      </button>
                      {canEdit && (
                        <button
                          type="button"
                          className="x-icon-button"
                          title={s.regenerateToken}
                          disabled={regenerateToken.isPending}
                          onClick={() => {
                            if (window.confirm(s.regenerateTokenConfirm)) {
                              regenerateToken.mutate(entry.id)
                            }
                          }}
                        >
                          <RefreshCw size={13} />
                        </button>
                      )}
                    </div>

                    <p className="x-caption" style={{ fontSize: '11px', margin: 0, opacity: 0.75 }}>
                      {s.webhookHelp}
                    </p>

                    {entry.lastWebhookAt ? (
                      <div style={{ fontSize: '11px', opacity: 0.85, color: 'var(--x-primary, #6366f1)' }}>
                        {s.webhookUpdated.replace(
                          '{time}',
                          new Date(entry.lastWebhookAt).toLocaleString(),
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              {canEdit && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginTop: 'auto',
                    paddingTop: 12,
                    borderTop: '1px solid var(--x-border)',
                  }}
                >
                  <button
                    className="x-button x-small"
                    disabled={testSingle.isPending}
                    onClick={() => testSingle.mutate(entry.id)}
                  >
                    <ShieldCheck size={14} />
                    {testSingle.isPending && testSingle.variables === entry.id ? s.testing : s.test}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="x-icon-button"
                      aria-label={`${s.edit}: ${entry.name}`}
                      title={s.edit}
                      onClick={() => {
                        save.reset()
                        setShowBatch(false)
                        setShowDeploy(false)
                        setShowSettings(false)
                        setDraft({ id: entry.id, name: entry.name, proxyUrl: '' })
                      }}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="x-icon-button x-danger"
                      aria-label={`${s.remove}: ${entry.name}`}
                      title={s.remove}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(s.deleteConfirm)) remove.mutate(entry.id)
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              )}
            </section>
          )
        })}
      </div>
    </>
  )
}
