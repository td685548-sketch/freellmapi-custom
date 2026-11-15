import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Eye, History, Info, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react'
import { apiFetch, type ApiError } from '@/lib/api'
import { useI18n } from '@/i18n'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportOutputStrings } from '../support-output-strings'

export type SupportOutputMode = 'off' | 'log' | 'enforce'
export type SupportOutputSurface = 'chat' | 'copilot'
export type SupportOutputReason = 'blocked_term' | 'too_long' | 'credential' | 'inspection_limit'
export type SupportOutputAction = 'allow' | 'observe' | 'redact' | 'block'

export interface SupportOutputRule {
  id: string
  text: string
}

export interface SupportOutputPolicy {
  tenantId: number
  version: number
  mode: SupportOutputMode
  blockedTerms: SupportOutputRule[]
  maxOutputChars: number
  redactCredentials: boolean
  updatedAt: string
}

export interface SupportOutputPolicyMutable {
  mode: SupportOutputMode
  blockedTerms: SupportOutputRule[]
  maxOutputChars: number
  redactCredentials: boolean
}

export interface SupportOutputLeaf {
  path: string
  text: string
}

export interface SupportOutputDecision {
  action: SupportOutputAction
  leaves: SupportOutputLeaf[]
  reasons: SupportOutputReason[]
  ruleIds: string[]
  redactionCount: number
  policyVersion: number
}

export interface SupportOutputEvent {
  id: string
  tenantId: number
  operationId: string
  surface: SupportOutputSurface
  policyVersion: number
  action: SupportOutputAction
  reasons: SupportOutputReason[]
  ruleIds: string[]
  redactionCount: number
  createdAt: string
}

export interface SupportTenantOption {
  id: number
  name: string
}

type Tab = 'policy' | 'preview' | 'events'

const RULE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_RULES = 50
const MIN_OUTPUT_CHARS = 256
const MAX_OUTPUT_CHARS = 64_000

const DEFAULT_DRAFT: SupportOutputPolicyMutable = {
  mode: 'off',
  blockedTerms: [],
  maxOutputChars: 16_000,
  redactCredentials: false,
}

function normalizeTerm(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function toMutableDraft(policy: SupportOutputPolicy): SupportOutputPolicyMutable {
  return {
    mode: policy.mode,
    blockedTerms: policy.blockedTerms.map(rule => ({ id: rule.id, text: rule.text })),
    maxOutputChars: policy.maxOutputChars,
    redactCredentials: policy.redactCredentials,
  }
}

function getApiStatus(err: unknown): number | undefined {
  return (err as ApiError | null | undefined)?.status
}

function formatDate(value: string, locale: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')
}

export default function SupportOutput() {
  const revision = useSessionRevision()
  return <SupportOutputPage key={revision} revision={revision} />
}

function useSupportOutputTenants(revision: number) {
  return useQuery({
    queryKey: ['x-support-output-tenants', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ tenants: SupportTenantOption[] }>('/api/thruline/support/tenants', { signal }),
  })
}

function SupportOutputPage({ revision }: { revision: number }) {
  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null)
  const [tab, setTab] = useState<Tab>('policy')
  const tenantsQuery = useSupportOutputTenants(revision)
  const tenants = tenantsQuery.data?.tenants ?? []
  const activeTenantId = (tenants.find(t => t.id === selectedTenantId) ?? tenants[0])?.id ?? null
  return (
    <SupportOutputTenant
      key={activeTenantId ?? 'none'}
      revision={revision}
      activeTenantId={activeTenantId}
      setSelectedTenantId={setSelectedTenantId}
      tenantsQuery={tenantsQuery}
      tab={tab}
      setTab={setTab}
    />
  )
}

function SupportOutputTenant({
  revision, activeTenantId, setSelectedTenantId, tenantsQuery, tab, setTab,
}: {
  revision: number
  activeTenantId: number | null
  setSelectedTenantId: (id: number | null) => void
  tenantsQuery: ReturnType<typeof useSupportOutputTenants>
  tab: Tab
  setTab: (tab: Tab) => void
}) {
  const s = useSupportOutputStrings()
  const { locale } = useI18n()
  const session = useUserSession()
  const queryClient = useQueryClient()

  const canEdit =
    session.hasPermission('*') ||
    session.hasPermission('manage_x_gateway') ||
    (session.hasPermission('use_x_gateway') && session.hasPermission('edit_x_settings'))


  // Draft policy state
  const [draftOverride, setDraftOverride] = useState<SupportOutputPolicyMutable | null>(null)
  const [dirty, setDirty] = useState(false)
  const [newRuleId, setNewRuleId] = useState('')
  const [newRuleText, setNewRuleText] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<Error | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Preview state (in-memory only, never persisted)
  const [previewText, setPreviewText] = useState('')
  const [previewDecision, setPreviewDecision] = useState<SupportOutputDecision | null>(null)
  const [previewPending, setPreviewPending] = useState(false)
  const [previewError, setPreviewError] = useState<Error | null>(null)

  // Events pagination state
  const [extraEvents, setExtraEvents] = useState<SupportOutputEvent[]>([])
  const [pagedCursor, setPagedCursor] = useState<string | undefined>(undefined)
  const [hasPaged, setHasPaged] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null)

  const previewAbortRef = useRef<AbortController | null>(null)
  const eventsAbortRef = useRef<AbortController | null>(null)
  const activeScopeRef = useRef<{ revision: number; tenantId: number | null }>({
    revision,
    tenantId: activeTenantId,
  })

  const tenants = tenantsQuery.data?.tenants ?? []

  useEffect(() => () => {
    activeScopeRef.current = { revision: -1, tenantId: null }
    previewAbortRef.current?.abort()
    eventsAbortRef.current?.abort()
  }, [])

  const policyQuery = useQuery({
    queryKey: ['x-support-output-policy', revision, activeTenantId],
    enabled: canEdit && activeTenantId !== null,
    queryFn: ({ signal }) =>
      apiFetch<{ ok: true; policy: SupportOutputPolicy }>(
        `/api/thruline/support/tenants/${activeTenantId}/output-policy`,
        { signal },
      ),
  })

  const eventsQuery = useQuery({
    queryKey: ['x-support-output-events', revision, activeTenantId],
    enabled: canEdit && activeTenantId !== null,
    queryFn: ({ signal }) =>
      apiFetch<{ ok: true; items: SupportOutputEvent[]; nextCursor?: string }>(
        `/api/thruline/support/tenants/${activeTenantId}/output-events?limit=50`,
        { signal },
      ),
  })

  const serverPolicy = policyQuery.data?.policy
  const draft = draftOverride ?? (serverPolicy ? toMutableDraft(serverPolicy) : DEFAULT_DRAFT)

  function setDraft(update: SupportOutputPolicyMutable | ((previous: SupportOutputPolicyMutable) => SupportOutputPolicyMutable)) {
    setDraftOverride(previous => {
      const base = previous ?? (serverPolicy ? toMutableDraft(serverPolicy) : DEFAULT_DRAFT)
      return typeof update === 'function' ? update(base) : update
    })
  }

  const policyStatus = getApiStatus(policyQuery.error) ?? getApiStatus(saveError)
  const serverForbidden = policyStatus === 403 || getApiStatus(eventsQuery.error) === 403
  const effectiveReadonly = !canEdit || serverForbidden

  const saveMutation = useMutation({
    mutationFn: async (input: {
      tenantId: number
      expectedVersion: number
      policy: SupportOutputPolicyMutable
    }) => {
      return apiFetch<{ ok: true; policy: SupportOutputPolicy }>(
        `/api/thruline/support/tenants/${input.tenantId}/output-policy`,
        {
          method: 'PUT',
          body: JSON.stringify({
            expectedVersion: input.expectedVersion,
            policy: input.policy,
          }),
        },
      )
    },
    onSuccess: (data, variables) => {
      if (
        activeScopeRef.current.revision !== revision ||
        activeScopeRef.current.tenantId !== variables.tenantId
      ) {
        return
      }
      queryClient.setQueryData(['x-support-output-policy', revision, variables.tenantId], data)
      setDraftOverride(null)
      setDirty(false)
      setSaveError(null)
      setSaveSuccess(true)
    },
    onError: (err: Error, variables) => {
      if (
        activeScopeRef.current.revision !== revision ||
        activeScopeRef.current.tenantId !== variables.tenantId
      ) {
        return
      }
      setSaveSuccess(false)
      setSaveError(err)
    },
  })

  function renderErrorBanner(err: Error | null, showReloadOnConflict = false) {
    if (!err) return null
    const status = getApiStatus(err)
    let message = err.message
    if (status === 409) message = s.conflictError
    else if (status === 503) message = s.unavailableError
    else if (status === 403) message = s.forbiddenError

    return (
      <div className="x-alert x-alert-error" role="alert" style={{ marginBottom: 12 }}>
        <AlertTriangle size={16} />
        <span>{message}</span>
        {showReloadOnConflict && status === 409 && (
          <button
            type="button"
            className="x-button"
            onClick={() => void handleReloadLatest()}
            style={{ marginLeft: 12 }}
          >
            <RefreshCw size={14} /> {s.reloadPolicy}
          </button>
        )}
      </div>
    )
  }

  async function handleReloadLatest() {
    setSaveError(null)
    setValidationError(null)
    setSaveSuccess(false)
    setDirty(false)
    setDraftOverride(null)
    await policyQuery.refetch()
  }

  function handleAddRule() {
    if (effectiveReadonly) return
    setValidationError(null)
    setSaveSuccess(false)

    if (draft.blockedTerms.length >= MAX_RULES) {
      setValidationError(s.policy.validationMaxRules)
      return
    }
    const id = newRuleId.trim()
    if (!RULE_ID_RE.test(id) || draft.blockedTerms.some(r => r.id === id)) {
      setValidationError(s.policy.validationRuleId)
      return
    }
    const normalized = normalizeTerm(newRuleText)
    if (
      normalized.length < 1 ||
      normalized.length > 100 ||
      draft.blockedTerms.some(r => normalizeTerm(r.text) === normalized)
    ) {
      setValidationError(s.policy.validationRuleText)
      return
    }

    setDraft(prev => ({
      ...prev,
      blockedTerms: [...prev.blockedTerms, { id, text: newRuleText.trim() }],
    }))
    setDirty(true)
    setNewRuleId('')
    setNewRuleText('')
  }

  function handleRemoveRule(ruleId: string) {
    if (effectiveReadonly) return
    setValidationError(null)
    setSaveSuccess(false)
    setDraft(prev => ({
      ...prev,
      blockedTerms: prev.blockedTerms.filter(r => r.id !== ruleId),
    }))
    setDirty(true)
  }

  function handleSavePolicy() {
    if (effectiveReadonly || activeTenantId === null || !serverPolicy) return
    setValidationError(null)
    setSaveError(null)
    setSaveSuccess(false)

    if (
      !Number.isSafeInteger(draft.maxOutputChars) ||
      draft.maxOutputChars < MIN_OUTPUT_CHARS ||
      draft.maxOutputChars > MAX_OUTPUT_CHARS
    ) {
      setValidationError(s.policy.validationMaxChars)
      return
    }

    saveMutation.mutate({
      tenantId: activeTenantId,
      expectedVersion: serverPolicy.version,
      policy: {
        mode: draft.mode,
        blockedTerms: draft.blockedTerms,
        maxOutputChars: draft.maxOutputChars,
        redactCredentials: draft.redactCredentials,
      },
    })
  }

  async function handleRunPreview() {
    if (effectiveReadonly || activeTenantId === null) return
    previewAbortRef.current?.abort()
    const controller = new AbortController()
    previewAbortRef.current = controller
    const reqTenantId = activeTenantId
    const reqRevision = revision

    setPreviewPending(true)
    setPreviewError(null)

    try {
      const res = await apiFetch<{ ok: true; decision: SupportOutputDecision }>(
        `/api/thruline/support/tenants/${reqTenantId}/output-policy/preview`,
        {
          method: 'POST',
          signal: controller.signal,
          body: JSON.stringify({
            policy: {
              mode: draft.mode,
              blockedTerms: draft.blockedTerms,
              maxOutputChars: draft.maxOutputChars,
              redactCredentials: draft.redactCredentials,
            },
            text: previewText,
          }),
        },
      )
      if (
        controller.signal.aborted ||
        activeScopeRef.current.revision !== reqRevision ||
        activeScopeRef.current.tenantId !== reqTenantId
      ) {
        return
      }
      setPreviewDecision(res.decision)
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || controller.signal.aborted) {
        return
      }
      if (
        activeScopeRef.current.revision !== reqRevision ||
        activeScopeRef.current.tenantId !== reqTenantId
      ) {
        return
      }
      setPreviewDecision(null)
      setPreviewError(err instanceof Error ? err : new Error('Preview failed.'))
    } finally {
      if (
        activeScopeRef.current.revision === reqRevision &&
        activeScopeRef.current.tenantId === reqTenantId
      ) {
        setPreviewPending(false)
      }
    }
  }

  async function handleLoadMoreEvents() {
    if (effectiveReadonly || activeTenantId === null) return
    const cursor = hasPaged ? pagedCursor : eventsQuery.data?.nextCursor
    if (!cursor) return

    eventsAbortRef.current?.abort()
    const controller = new AbortController()
    eventsAbortRef.current = controller
    const reqTenantId = activeTenantId
    const reqRevision = revision

    setLoadingMore(true)
    setLoadMoreError(null)

    try {
      const res = await apiFetch<{ ok: true; items: SupportOutputEvent[]; nextCursor?: string }>(
        `/api/thruline/support/tenants/${reqTenantId}/output-events?limit=50&before=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      )
      if (
        controller.signal.aborted ||
        activeScopeRef.current.revision !== reqRevision ||
        activeScopeRef.current.tenantId !== reqTenantId
      ) {
        return
      }
      setExtraEvents(prev => [...prev, ...res.items])
      setPagedCursor(res.nextCursor)
      setHasPaged(true)
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || controller.signal.aborted) {
        return
      }
      if (
        activeScopeRef.current.revision !== reqRevision ||
        activeScopeRef.current.tenantId !== reqTenantId
      ) {
        return
      }
      setLoadMoreError(err instanceof Error ? err : new Error('Failed to load events.'))
    } finally {
      if (
        activeScopeRef.current.revision === reqRevision &&
        activeScopeRef.current.tenantId === reqTenantId
      ) {
        setLoadingMore(false)
      }
    }
  }

  function handleRefreshEvents() {
    setExtraEvents([])
    setPagedCursor(undefined)
    setHasPaged(false)
    setLoadMoreError(null)
    void eventsQuery.refetch()
  }

  const allEvents = [...(eventsQuery.data?.items ?? []), ...extraEvents]
  const nextCursor = hasPaged ? pagedCursor : eventsQuery.data?.nextCursor

  return (
    <div className="x-page">
      <div className="x-page-header">
        <div>
          <h1>{s.title}</h1>
          <p className="x-subtitle">{s.subtitle}</p>
        </div>
        <div className="x-actions">
          <label className="x-field-inline">
            <span>{s.tenant}</span>
            <select
              aria-label={s.tenant}
              value={activeTenantId ?? ''}
              onChange={e => setSelectedTenantId(e.target.value ? Number(e.target.value) : null)}
              disabled={tenants.length === 0}
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} (#{t.id})
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {effectiveReadonly && (
        <div className="x-alert x-alert-warning" role="alert" style={{ marginBottom: 16 }}>
          <ShieldAlert size={16} />
          <span>{s.readonlyBanner}</span>
        </div>
      )}

      <div className="x-panel x-mgmt-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Info size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>{s.limitationsTitle}</strong>
            <p style={{ margin: '4px 0 0' }}>{s.limitationsBody}</p>
          </div>
        </div>
      </div>

      {tenantsQuery.isPending && <p role="status">{s.loading}</p>}
      {tenantsQuery.error && (
        <div role="alert" style={{ marginBottom: 16 }}>
          <span>{tenantsQuery.error.message}</span>{' '}
          <button type="button" className="x-button" onClick={() => void tenantsQuery.refetch()}>
            {s.retry}
          </button>
        </div>
      )}
      {!tenantsQuery.isPending && !tenantsQuery.error && tenants.length === 0 && (
        <div className="x-empty" role="status">
          <p>{s.noTenants}</p>
        </div>
      )}

      {activeTenantId !== null && canEdit && (
        <>
          <div className="x-tabs" role="tablist" style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'policy'}
              className={`x-button ${tab === 'policy' ? 'x-button-primary' : ''}`}
              onClick={() => setTab('policy')}
            >
              <ShieldAlert size={15} /> {s.tabs.policy}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'preview'}
              className={`x-button ${tab === 'preview' ? 'x-button-primary' : ''}`}
              onClick={() => setTab('preview')}
            >
              <Eye size={15} /> {s.tabs.preview}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'events'}
              className={`x-button ${tab === 'events' ? 'x-button-primary' : ''}`}
              onClick={() => setTab('events')}
            >
              <History size={15} /> {s.tabs.events}
            </button>
          </div>

          {tab === 'policy' && (
            <section className="x-panel x-mgmt-card" aria-label={s.policy.heading}>
              <div className="x-section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2>{s.policy.heading}</h2>
                {serverPolicy && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="x-badge">
                      {s.versionLabel}: v{serverPolicy.version}
                    </span>
                    <span className="x-subtitle">
                      {s.updatedAtLabel}: {formatDate(serverPolicy.updatedAt, locale)}
                    </span>
                    {dirty && <span className="x-badge">{s.unsavedDraft}</span>}
                  </div>
                )}
              </div>

              {policyQuery.isPending && <p role="status">{s.loading}</p>}
              {policyQuery.error && (
                <div>
                  {renderErrorBanner(policyQuery.error, false)}
                  <button type="button" className="x-button" onClick={() => void policyQuery.refetch()}>
                    <RefreshCw size={14} /> {s.retry}
                  </button>
                </div>
              )}

              {serverPolicy && (
                <div style={{ display: 'grid', gap: 14 }}>
                  {renderErrorBanner(saveError, true)}
                  {validationError && (
                    <p className="x-alert x-alert-error" role="alert">
                      {validationError}
                    </p>
                  )}
                  {saveSuccess && (
                    <p className="x-alert x-alert-success" role="status">
                      <CheckCircle2 size={15} /> {s.saved}
                    </p>
                  )}

                  <label>
                    <span>{s.policy.mode}</span>
                    <select
                      aria-label={s.policy.mode}
                      value={draft.mode}
                      disabled={effectiveReadonly}
                      onChange={e => {
                        setSaveSuccess(false)
                        setDraft(prev => ({ ...prev, mode: e.target.value as SupportOutputMode }))
                        setDirty(true)
                      }}
                    >
                      <option value="off">{s.policy.modes.off}</option>
                      <option value="log">{s.policy.modes.log}</option>
                      <option value="enforce">{s.policy.modes.enforce}</option>
                    </select>
                  </label>

                  <label>
                    <span>{s.policy.maxOutputChars}</span>
                    <input
                      type="number"
                      aria-label={s.policy.maxOutputChars}
                      min={MIN_OUTPUT_CHARS}
                      max={MAX_OUTPUT_CHARS}
                      step={1}
                      value={draft.maxOutputChars}
                      disabled={effectiveReadonly}
                      onChange={e => {
                        setSaveSuccess(false)
                        const val = Number(e.target.value)
                        setDraft(prev => ({ ...prev, maxOutputChars: Number.isNaN(val) ? 0 : val }))
                        setDirty(true)
                      }}
                    />
                  </label>

                  <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      aria-label={s.policy.redactCredentials}
                      checked={draft.redactCredentials}
                      disabled={effectiveReadonly}
                      onChange={e => {
                        setSaveSuccess(false)
                        setDraft(prev => ({ ...prev, redactCredentials: e.target.checked }))
                        setDirty(true)
                      }}
                    />
                    <span>{s.policy.redactCredentials}</span>
                  </label>

                  <div>
                    <h3>{s.policy.blockedTerms}</h3>
                    {draft.blockedTerms.length === 0 ? (
                      <p className="x-subtitle">{s.policy.noRules}</p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
                        {draft.blockedTerms.map(rule => (
                          <li
                            key={rule.id}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <span>
                              <code>{rule.id}</code> — <span>{rule.text}</span>
                            </span>
                            <button
                              type="button"
                              className="x-button"
                              disabled={effectiveReadonly}
                              aria-label={`${s.policy.removeRule} ${rule.id}`}
                              onClick={() => handleRemoveRule(rule.id)}
                            >
                              <Trash2 size={14} /> {s.policy.removeRule}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        aria-label={s.policy.ruleId}
                        placeholder={s.policy.ruleIdPlaceholder}
                        value={newRuleId}
                        disabled={effectiveReadonly}
                        onChange={e => setNewRuleId(e.target.value)}
                      />
                      <input
                        type="text"
                        aria-label={s.policy.ruleText}
                        placeholder={s.policy.ruleTextPlaceholder}
                        value={newRuleText}
                        disabled={effectiveReadonly}
                        onChange={e => setNewRuleText(e.target.value)}
                      />
                      <button
                        type="button"
                        className="x-button"
                        disabled={effectiveReadonly}
                        onClick={handleAddRule}
                      >
                        <Plus size={14} /> {s.policy.addRule}
                      </button>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="x-button x-button-primary"
                      disabled={effectiveReadonly || saveMutation.isPending}
                      onClick={handleSavePolicy}
                    >
                      {saveMutation.isPending ? s.saving : s.save}
                    </button>
                    {dirty && (
                      <button
                        type="button"
                        className="x-button"
                        disabled={saveMutation.isPending}
                        onClick={() => void handleReloadLatest()}
                      >
                        {s.resetDraft}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {tab === 'preview' && (
            <section className="x-panel x-mgmt-card" aria-label={s.preview.heading}>
              <div className="x-section-heading">
                <h2>{s.preview.heading}</h2>
                <p className="x-subtitle">{s.preview.description}</p>
              </div>

              {renderErrorBanner(previewError, false)}

              <div style={{ display: 'grid', gap: 12 }}>
                <label>
                  <span>{s.preview.textLabel}</span>
                  <textarea
                    rows={5}
                    aria-label={s.preview.textLabel}
                    placeholder={s.preview.textPlaceholder}
                    value={previewText}
                    disabled={effectiveReadonly}
                    onChange={e => setPreviewText(e.target.value)}
                  />
                </label>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="x-button x-button-primary"
                    disabled={effectiveReadonly || previewPending}
                    onClick={() => void handleRunPreview()}
                  >
                    {previewPending ? s.preview.running : s.preview.run}
                  </button>
                  <button
                    type="button"
                    className="x-button"
                    onClick={() => {
                      setPreviewText('')
                      setPreviewDecision(null)
                      setPreviewError(null)
                    }}
                  >
                    {s.preview.clear}
                  </button>
                </div>

                {!previewDecision && !previewPending && !previewError && (
                  <p className="x-subtitle">{s.preview.noResult}</p>
                )}

                {previewDecision && (
                  <div className="x-panel" style={{ padding: 12 }}>
                    <h3>{s.preview.resultHeading}</h3>
                    <p>
                      <strong>{s.preview.action}:</strong>{' '}
                      <span className="x-badge">{s.actions[previewDecision.action]}</span>
                    </p>
                    <p>
                      <strong>{s.preview.reasons}:</strong>{' '}
                      {previewDecision.reasons.length === 0
                        ? s.preview.none
                        : previewDecision.reasons.map(r => s.reasons[r]).join(', ')}
                    </p>
                    <p>
                      <strong>{s.preview.ruleIds}:</strong>{' '}
                      {previewDecision.ruleIds.length === 0
                        ? s.preview.none
                        : previewDecision.ruleIds.join(', ')}
                    </p>
                    <p>
                      <strong>{s.preview.redactionCount}:</strong> {previewDecision.redactionCount}
                    </p>

                    {previewDecision.action === 'block' ? (
                      <p role="status" className="x-alert x-alert-warning">
                        {s.preview.blockedNotice}
                      </p>
                    ) : (
                      <div>
                        <strong>{s.preview.leavesHeading}:</strong>
                        {previewDecision.leaves.map(leaf => (
                          <div key={leaf.path} style={{ marginTop: 6 }}>
                            <code>{leaf.path}</code>
                            <pre style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{leaf.text}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {tab === 'events' && (
            <section className="x-panel x-mgmt-card" aria-label={s.events.heading}>
              <div className="x-section-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h2>{s.events.heading}</h2>
                  <p className="x-subtitle">{s.events.metadataNotice}</p>
                </div>
                <button
                  type="button"
                  className="x-button"
                  disabled={effectiveReadonly || eventsQuery.isPending}
                  onClick={handleRefreshEvents}
                >
                  <RefreshCw size={14} /> {s.refresh}
                </button>
              </div>

              {eventsQuery.isPending && <p role="status">{s.loading}</p>}
              {eventsQuery.error && (
                <div>
                  {renderErrorBanner(eventsQuery.error, false)}
                  <button type="button" className="x-button" onClick={handleRefreshEvents}>
                    {s.retry}
                  </button>
                </div>
              )}
              {loadMoreError && renderErrorBanner(loadMoreError, false)}

              {!eventsQuery.isPending && !eventsQuery.error && allEvents.length === 0 && (
                <p className="x-subtitle">{s.events.empty}</p>
              )}

              {allEvents.length > 0 && (
                <>
                  <div style={{ overflowX: 'auto' }}>
                    <table className="x-table">
                      <thead>
                        <tr>
                          <th>{s.events.columns.createdAt}</th>
                          <th>{s.events.columns.surface}</th>
                          <th>{s.events.columns.operationId}</th>
                          <th>{s.events.columns.policyVersion}</th>
                          <th>{s.events.columns.action}</th>
                          <th>{s.events.columns.reasons}</th>
                          <th>{s.events.columns.ruleIds}</th>
                          <th>{s.events.columns.redactions}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allEvents.map(ev => (
                          <tr key={ev.id}>
                            <td>{formatDate(ev.createdAt, locale)}</td>
                            <td>{s.surfaces[ev.surface]}</td>
                            <td>
                              <code>{ev.operationId}</code>
                            </td>
                            <td>v{ev.policyVersion}</td>
                            <td>
                              <span className="x-badge">{s.actions[ev.action]}</span>
                            </td>
                            <td>{ev.reasons.map(r => s.reasons[r]).join(', ') || '—'}</td>
                            <td>{ev.ruleIds.join(', ') || '—'}</td>
                            <td>{ev.redactionCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {nextCursor && (
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        className="x-button"
                        disabled={loadingMore}
                        onClick={() => void handleLoadMoreEvents()}
                      >
                        {loadingMore ? s.events.loadingMore : s.events.loadMore}
                      </button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  )
}
