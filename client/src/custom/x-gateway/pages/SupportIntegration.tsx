import type { SupportRuntimePolicy, SupportIntegrationReadiness, SupportOutboxItem } from '@freellmapi/shared/support-runtime.js'
import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, AlertTriangle, XCircle, Cpu, Send, Code, Copy, RotateCcw, ShieldAlert, Sparkles, RefreshCw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportIntegrationStrings } from '../support-integration-strings'

export interface SupportTenant {
  id: number
  name: string
  slug: string
  publicKey: string
  defaultModel: string
  allowedOrigins: string[]
  enabled: boolean
}

export interface SupportTool {
  id: number
  tenantId: number
  name: string
  description?: string
  method: string
  endpointUrl: string
  enabled: boolean
}

type TabId = 'readiness' | 'runtime' | 'deliveries' | 'embed'

const tabs = [
  { id: 'readiness', icon: CheckCircle2 },
  { id: 'runtime', icon: Cpu },
  { id: 'deliveries', icon: Send },
  { id: 'embed', icon: Code },
] as const

const DEFAULT_POLICY: SupportRuntimePolicy = {
  allowedModels: [],
  toolPolicies: [],
  maxCompletionTokens: 512,
  maxModelCalls: 3,
  maxToolCalls: 3,
  maxContextChars: 16000,
  maxToolResultChars: 8000,
  maxHistoryMessages: 40,
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="x-panel x-mgmt-card" style={{ marginBottom: 20, minWidth: 0 }}>
      <div className="x-section-heading">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Feedback({ error, success }: { error?: Error | null; success?: boolean }) {
  const s = useSupportIntegrationStrings()
  if (error) {
    return (
      <div className="x-alert x-alert-error" role="alert" style={{ marginBottom: 16 }}>
        <XCircle size={18} />
        <span>{error.message}</span>
      </div>
    )
  }
  if (success) {
    return (
      <div className="x-alert x-alert-success" role="status" style={{ marginBottom: 16 }}>
        <CheckCircle2 size={18} />
        <span>{s.saved}</span>
      </div>
    )
  }
  return null
}

function ReadinessPanel({
  readiness,
  isLoading,
  error,
  onRetry,
}: {
  readiness?: SupportIntegrationReadiness
  isLoading: boolean
  error: Error | null
  onRetry: () => void
}) {
  const s = useSupportIntegrationStrings()

  if (isLoading) {
    return <div className="x-loading">{s.loading}</div>
  }

  if (error || !readiness) {
    return (
      <div className="x-alert x-alert-error" role="alert">
        <XCircle size={18} />
        <span>{error?.message || s.empty}</span>
        <button type="button" className="x-btn x-btn-secondary" onClick={onRetry} style={{ marginLeft: 12 }}>
          <RotateCcw size={14} />
          <span>{s.retry}</span>
        </button>
      </div>
    )
  }

  const hasErrors = readiness.checks.some(c => c.status === 'error') || !readiness.ready
  const hasWarnings = readiness.checks.some(c => c.status === 'warning')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        className={`x-alert ${hasErrors ? 'x-alert-error' : hasWarnings ? 'x-alert-warning' : 'x-alert-success'}`}
        role="status"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasErrors ? <XCircle size={20} /> : hasWarnings ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
          <strong>
            {hasErrors ? s.readiness.overallError : hasWarnings ? s.readiness.overallWarning : s.readiness.overallReady}
          </strong>
        </div>
        <button type="button" className="x-btn x-btn-secondary" onClick={onRetry} title={s.readiness.retryAction}>
          <RefreshCw size={14} />
          <span>{s.refresh}</span>
        </button>
      </div>

      <p className="x-hint" style={{ margin: 0 }}>
        {s.readiness.subheading}
      </p>

      <div className="x-table-wrap">
        <table className="x-table">
          <thead>
            <tr>
              <th style={{ width: '25%' }}>{s.readiness.colComponent}</th>
              <th style={{ width: '15%' }}>{s.readiness.colStatus}</th>
              <th style={{ width: '60%' }}>{s.readiness.colDetails}</th>
            </tr>
          </thead>
          <tbody>
            {readiness.checks.map(check => {
              const compName = s.readiness.components[check.id] || check.id
              const codeText = s.readiness.codes[check.code as keyof typeof s.readiness.codes] || check.code
              const isReady = check.status === 'ready'
              const isWarn = check.status === 'warning'

              return (
                <tr key={check.id}>
                  <td>
                    <strong>{compName}</strong>
                  </td>
                  <td>
                    <span
                      className={`x-badge ${isReady ? 'x-badge-success' : isWarn ? 'x-badge-warning' : 'x-badge-error'}`}
                    >
                      {isReady ? s.readiness.statusReady : isWarn ? s.readiness.statusWarning : s.readiness.statusError}
                    </span>
                  </td>
                  <td style={{ color: '#4b5563', fontSize: 13 }}>{codeText}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function RuntimePanel({
  initialPolicy,
  tools,
  canEdit,
  onSave,
  isSaving,
  saveSuccess,
  saveError,
}: {
  initialPolicy: SupportRuntimePolicy
  tools: SupportTool[]
  canEdit: boolean
  onSave: (policy: SupportRuntimePolicy) => void
  isSaving: boolean
  saveSuccess: boolean
  saveError: Error | null
}) {
  const s = useSupportIntegrationStrings()

  const [policy, setPolicy] = useState<SupportRuntimePolicy>(() => ({
    ...DEFAULT_POLICY,
    ...initialPolicy,
    allowedModels: Array.isArray(initialPolicy?.allowedModels) ? initialPolicy.allowedModels : [],
    toolPolicies: Array.isArray(initialPolicy?.toolPolicies) ? initialPolicy.toolPolicies : [],
  }))

  const [allowedModelsStr, setAllowedModelsStr] = useState(
    Array.isArray(initialPolicy?.allowedModels) ? initialPolicy.allowedModels.join(', ') : ''
  )

  const [validationError, setValidationError] = useState<string | null>(null)

  function validate(p: SupportRuntimePolicy): boolean {
    if (!Number.isInteger(p.maxCompletionTokens) || p.maxCompletionTokens < 1 || p.maxCompletionTokens > 4096) {
      setValidationError(s.runtime.validationError)
      return false
    }
    if (!Number.isInteger(p.maxModelCalls) || p.maxModelCalls < 1 || p.maxModelCalls > 3) {
      setValidationError(s.runtime.validationError)
      return false
    }
    if (!Number.isInteger(p.maxToolCalls) || p.maxToolCalls < 0 || p.maxToolCalls > 3) {
      setValidationError(s.runtime.validationError)
      return false
    }
    if (!Number.isInteger(p.maxContextChars) || p.maxContextChars < 1000 || p.maxContextChars > 32000) {
      setValidationError(s.runtime.validationError)
      return false
    }
    if (!Number.isInteger(p.maxToolResultChars) || p.maxToolResultChars < 256 || p.maxToolResultChars > 16000) {
      setValidationError(s.runtime.validationError)
      return false
    }
    if (!Number.isInteger(p.maxHistoryMessages) || p.maxHistoryMessages < 2 || p.maxHistoryMessages > 100) {
      setValidationError(s.runtime.validationError)
      return false
    }
    setValidationError(null)
    return true
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!canEdit) return

    const models = allowedModelsStr
      .split(',')
      .map(m => m.trim())
      .filter(Boolean)

    const updated: SupportRuntimePolicy = {
      ...policy,
      allowedModels: models,
    }

    if (!validate(updated)) return

    onSave(updated)
  }

  function setToolMode(toolId: number, mode: 'read' | 'approval_required') {
    setPolicy(prev => {
      const existing = prev.toolPolicies.filter(tp => tp.toolId !== toolId)
      return {
        ...prev,
        toolPolicies: [...existing, { toolId, mode }],
      }
    })
  }

  return (
    <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {!canEdit && (
        <div className="x-alert x-alert-warning" role="alert">
          <ShieldAlert size={18} />
          <span>{s.readOnly}</span>
        </div>
      )}

      <Feedback error={saveError} success={saveSuccess} />

      {validationError && (
        <div className="x-alert x-alert-error" role="alert">
          <XCircle size={18} />
          <span>{validationError}</span>
        </div>
      )}

      <div className="x-form-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        <div className="x-field">
          <label htmlFor="runtime-allowed-models">
            <strong>{s.runtime.allowedModelsLabel}</strong>
          </label>
          <input
            id="runtime-allowed-models"
            data-testid="runtime-allowed-models"
            type="text"
            className="x-input"
            disabled={!canEdit}
            value={allowedModelsStr}
            onChange={e => setAllowedModelsStr(e.target.value)}
            placeholder="e.g. gpt-4o, claude-3-5-sonnet"
          />
          <small className="x-hint">{s.runtime.allowedModelsHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-completion-tokens">
            <strong>{s.runtime.maxCompletionTokensLabel}</strong>
          </label>
          <input
            id="runtime-max-completion-tokens"
            data-testid="runtime-max-completion-tokens"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={1}
            max={4096}
            value={policy.maxCompletionTokens}
            onChange={e => setPolicy(prev => ({ ...prev, maxCompletionTokens: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxCompletionTokensHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-model-calls">
            <strong>{s.runtime.maxModelCallsLabel}</strong>
          </label>
          <input
            id="runtime-max-model-calls"
            data-testid="runtime-max-model-calls"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={1}
            max={3}
            value={policy.maxModelCalls}
            onChange={e => setPolicy(prev => ({ ...prev, maxModelCalls: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxModelCallsHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-tool-calls">
            <strong>{s.runtime.maxToolCallsLabel}</strong>
          </label>
          <input
            id="runtime-max-tool-calls"
            data-testid="runtime-max-tool-calls"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={0}
            max={3}
            value={policy.maxToolCalls}
            onChange={e => setPolicy(prev => ({ ...prev, maxToolCalls: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxToolCallsHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-context-chars">
            <strong>{s.runtime.maxContextCharsLabel}</strong>
          </label>
          <input
            id="runtime-max-context-chars"
            data-testid="runtime-max-context-chars"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={1000}
            max={32000}
            value={policy.maxContextChars}
            onChange={e => setPolicy(prev => ({ ...prev, maxContextChars: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxContextCharsHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-tool-result-chars">
            <strong>{s.runtime.maxToolResultCharsLabel}</strong>
          </label>
          <input
            id="runtime-max-tool-result-chars"
            data-testid="runtime-max-tool-result-chars"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={256}
            max={16000}
            value={policy.maxToolResultChars}
            onChange={e => setPolicy(prev => ({ ...prev, maxToolResultChars: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxToolResultCharsHelp}</small>
        </div>

        <div className="x-field">
          <label htmlFor="runtime-max-history-messages">
            <strong>{s.runtime.maxHistoryMessagesLabel}</strong>
          </label>
          <input
            id="runtime-max-history-messages"
            data-testid="runtime-max-history-messages"
            type="number"
            className="x-input"
            disabled={!canEdit}
            min={2}
            max={100}
            value={policy.maxHistoryMessages}
            onChange={e => setPolicy(prev => ({ ...prev, maxHistoryMessages: parseInt(e.target.value, 10) || 0 }))}
          />
          <small className="x-hint">{s.runtime.maxHistoryMessagesHelp}</small>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <h3 style={{ fontSize: 16, marginBottom: 4 }}>{s.runtime.toolsHeading}</h3>
        <p className="x-hint" style={{ marginBottom: 12 }}>
          {s.runtime.toolsHelp}
        </p>

        {tools.length === 0 ? (
          <div className="x-empty">{s.empty}</div>
        ) : (
          <div className="x-table-wrap">
            <table className="x-table">
              <thead>
                <tr>
                  <th style={{ width: '30%' }}>{s.runtime.toolName}</th>
                  <th style={{ width: '35%' }}>{s.runtime.toolType}</th>
                  <th style={{ width: '35%' }}>{s.runtime.toolPolicy}</th>
                </tr>
              </thead>
              <tbody>
                {tools.map(tool => {
                  const assigned = policy.toolPolicies.find(tp => tp.toolId === tool.id)
                  const isPost = tool.method.toUpperCase() === 'POST'
                  const currentMode = assigned?.mode ?? (isPost ? 'approval_required' : 'read')

                  return (
                    <tr key={tool.id}>
                      <td>
                        <strong>{tool.name}</strong>
                      </td>
                      <td>
                        <span className="x-code" style={{ fontSize: 12 }}>
                          {tool.method.toUpperCase()} {tool.endpointUrl}
                        </span>
                      </td>
                      <td>
                        <select
                          className="x-select"
                          data-testid={`tool-mode-${tool.id}`}
                          disabled={!canEdit}
                          value={currentMode}
                          onChange={e => setToolMode(tool.id, e.target.value as 'read' | 'approval_required')}
                        >
                          <option value="read">{s.runtime.modeRead}</option>
                          <option value="approval_required">{s.runtime.modeApproval}</option>
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
        <button
          type="submit"
          data-testid="save-runtime-policy-btn"
          className="x-btn x-btn-primary"
          disabled={!canEdit || isSaving}
          onClick={handleSave}
        >
          {isSaving ? s.saving : s.runtime.savePolicy}
        </button>
      </div>
    </form>
  )
}

function DeliveriesPanel({
  items,
  isLoading,
  error,
  canEdit,
  onRetry,
}: {
  items: SupportOutboxItem[]
  isLoading: boolean
  error: Error | null
  canEdit: boolean
  onRetry: (deliveryId: string) => void
}) {
  const s = useSupportIntegrationStrings()

  if (isLoading) {
    return <div className="x-loading">{s.loading}</div>
  }

  if (error) {
    return (
      <div className="x-alert x-alert-error" role="alert">
        <XCircle size={18} />
        <span>{error.message}</span>
      </div>
    )
  }

  if (items.length === 0) {
    return <div className="x-empty">{s.deliveries.noDeliveries}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="x-hint" style={{ margin: 0 }}>
        {s.deliveries.retryExpl}
      </p>

      <div className="x-table-wrap">
        <table className="x-table">
          <thead>
            <tr>
              <th style={{ width: '20%' }}>{s.deliveries.colEventId}</th>
              <th style={{ width: '15%' }}>{s.deliveries.colEvent}</th>
              <th style={{ width: '15%' }}>{s.deliveries.colWebhook}</th>
              <th style={{ width: '12%' }}>{s.deliveries.colStatus}</th>
              <th style={{ width: '10%' }}>{s.deliveries.colAttempts}</th>
              <th>{s.deliveries.colNextAttempt}</th>
              <th style={{ width: '18%' }}>{s.deliveries.colError}</th>
              <th style={{ width: '10%' }}>{s.deliveries.colActions}</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => {
              const isDead = item.status === 'dead'
              const isDelivered = item.status === 'delivered'

              return (
                <tr key={item.id}>
                  <td>
                    <span className="x-code" style={{ fontSize: 11 }} title={item.eventId}>
                      {item.eventId.slice(0, 16)}…
                    </span>
                  </td>
                  <td>
                    <strong>{item.event}</strong>
                  </td>
                  <td>{item.webhookName}</td>
                  <td>
                    <span
                      className={`x-badge ${
                        isDelivered
                          ? 'x-badge-success'
                          : isDead
                            ? 'x-badge-error'
                            : item.status === 'delivering'
                              ? 'x-badge-info'
                              : 'x-badge-warning'
                      }`}
                    >
                      {item.status === 'delivered'
                        ? s.deliveries.statusDelivered
                        : item.status === 'dead'
                          ? s.deliveries.statusDead
                          : item.status === 'delivering'
                            ? s.deliveries.statusDelivering
                            : s.deliveries.statusPending}
                    </span>
                  </td>
                  <td>{item.attempts}</td>
                  <td>{item.nextAttemptAt ? new Date(item.nextAttemptAt).toLocaleString() : '—'}</td>
                  <td style={{ color: '#dc2626', fontSize: 12 }}>
                    {item.lastError ? item.lastError.slice(0, 48) : '—'}
                  </td>
                  <td>
                    {isDead && (
                      <button
                        type="button"
                        data-testid={`retry-delivery-${item.id}`}
                        className="x-btn x-btn-secondary"
                        disabled={!canEdit}
                        onClick={() => onRetry(item.id)}
                        style={{ padding: '4px 8px', fontSize: 12 }}
                      >
                        <RotateCcw size={12} />
                        <span>{s.deliveries.retryBtn}</span>
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EmbedPanel({ tenant, serverOrigin, configuredSnippet }: { tenant: SupportTenant; serverOrigin: string; configuredSnippet?: string }) {
  const s = useSupportIntegrationStrings()
  const [copied, setCopied] = useState(false)

  const widgetConfig = JSON.stringify({ tenantKey: tenant.publicKey, serverBase: serverOrigin, title: tenant.name, allowGuestSession: true }).replace(/</g, '\\u003c')
  const snippet = configuredSnippet || `<script src="${serverOrigin}/thruline/v1/support/widget.js"></script>\n<script>window.FreeLLMAPISupport.init(${widgetConfig});</script>`


  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="x-alert x-alert-warning" role="alert">
        <ShieldAlert size={18} />
        <span>{s.embed.securityNotice}</span>
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>{s.embed.snippetTitle}</h3>
          <button
            type="button"
            data-testid="copy-embed-snippet-btn"
            className="x-btn x-btn-secondary"
            onClick={copyToClipboard}
          >
            <Copy size={14} />
            <span>{copied ? s.embed.copied : s.embed.copySnippet}</span>
          </button>
        </div>

        <pre
          data-testid="embed-snippet-pre"
          style={{
            background: '#1e293b',
            color: '#e2e8f0',
            padding: 16,
            borderRadius: 8,
            overflowX: 'auto',
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <code>{snippet}</code>
        </pre>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="x-card" style={{ padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: 14 }}>{s.embed.backendAuthTitle}</h4>
          <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>{s.embed.backendAuthDesc}</p>
        </div>

        <div className="x-card" style={{ padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: 14 }}>{s.embed.tokenUpdateTitle}</h4>
          <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>{s.embed.tokenUpdateDesc}</p>
        </div>

        <div className="x-card" style={{ padding: 14, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
          <h4 style={{ margin: '0 0 6px 0', fontSize: 14 }}>{s.embed.guestSessionTitle}</h4>
          <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>{s.embed.guestSessionDesc}</p>
        </div>
      </div>
    </div>
  )
}

function TenantIntegrationContent({
  tenant,
  revision,
  canEdit,
}: {
  tenant: SupportTenant
  revision: number
  canEdit: boolean
}) {
  const s = useSupportIntegrationStrings()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabId>('readiness')

  const tenantBase = `/api/x-gateway/support/tenants/${tenant.id}`
  const tenantKey = ['x-support-integration', revision, tenant.id] as const

  // 1. Readiness query
  const readinessQuery = useQuery({
    queryKey: [...tenantKey, 'runtime-readiness'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; readiness: SupportIntegrationReadiness }>(`${tenantBase}/runtime`, { signal }).then(
        r => r.readiness
      ),
  })

  // 2. Tools query
  const toolsQuery = useQuery({
    queryKey: [...tenantKey, 'tools'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; tools: SupportTool[] }>(`${tenantBase}/tools`, { signal }).then(r => r.tools || []),
  })

  // 3. Outbox query
  const outboxQuery = useQuery({
    queryKey: [...tenantKey, 'outbox'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; items: SupportOutboxItem[] }>(`${tenantBase}/outbox`, { signal }).then(r => r.items || []),
  })

  // 4. Save runtime policy mutation
  const savePolicyMutation = useMutation({
    mutationFn: (policy: SupportRuntimePolicy) =>
      apiFetch<{ ok: boolean; policy: SupportRuntimePolicy }>(`${tenantBase}/runtime`, {
        method: 'PUT',
        body: JSON.stringify(policy),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: tenantKey })
    },
  })

  // 5. Retry delivery mutation
  const retryDeliveryMutation = useMutation({
    mutationFn: (deliveryId: string) =>
      apiFetch<{ ok: boolean }>(`${tenantBase}/outbox/${deliveryId}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...tenantKey, 'outbox'] })
    },
  })

  const serverOrigin =
    typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null'
      ? window.location.origin
      : 'https://api.freellmapi.com'

  return (
    <div>
      <div className="x-tabs" role="tablist" style={{ marginBottom: 20 }}>
        {tabs.map(tab => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid={`tab-${tab.id}`}
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              className={`x-tab ${isActive ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id as TabId)}
            >
              <Icon size={16} />
              <span>{s.tabs[tab.id as TabId]}</span>
            </button>
          )
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${activeTab}`}
        data-testid={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {activeTab === 'readiness' && (
          <Panel title={s.readiness.heading}>
            <ReadinessPanel
              readiness={readinessQuery.data}
              isLoading={readinessQuery.isPending}
              error={readinessQuery.error as Error | null}
              onRetry={() => void readinessQuery.refetch()}
            />
          </Panel>
        )}

        {activeTab === 'runtime' && (
          <Panel title={s.runtime.heading}>
            <RuntimePanel
              key={`${tenant.id}:${JSON.stringify(readinessQuery.data?.runtimePolicy ?? DEFAULT_POLICY)}`}
              initialPolicy={readinessQuery.data?.runtimePolicy ?? DEFAULT_POLICY}
              tools={toolsQuery.data || []}
              canEdit={canEdit}
              onSave={p => savePolicyMutation.mutate(p)}
              isSaving={savePolicyMutation.isPending}
              saveSuccess={savePolicyMutation.isSuccess}
              saveError={savePolicyMutation.error as Error | null}
            />
          </Panel>
        )}

        {activeTab === 'deliveries' && (
          <Panel title={s.deliveries.heading}>
            <DeliveriesPanel
              items={outboxQuery.data || []}
              isLoading={outboxQuery.isPending}
              error={outboxQuery.error as Error | null}
              canEdit={canEdit}
              onRetry={id => retryDeliveryMutation.mutate(id)}
            />
          </Panel>
        )}

        {activeTab === 'embed' && (
          <Panel title={s.embed.heading}>
            <EmbedPanel tenant={tenant} serverOrigin={serverOrigin} configuredSnippet={readinessQuery.data?.embedSnippet} />
          </Panel>
        )}
      </div>
    </div>
  )
}

export default function SupportIntegration() {
  const s = useSupportIntegrationStrings()
  const revision = useSessionRevision()
  const session = useUserSession()
  const canEdit = session.hasPermission('edit_x_settings')

  const tenantsQuery = useQuery({
    queryKey: ['x-support-integration-tenants', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; tenants: SupportTenant[] }>('/api/x-gateway/support/tenants', { signal }).then(
        r => r.tenants || []
      ),
  })

  const [selectedTenantId, setSelectedTenantId] = useState<number | null>(null)

  const tenants = tenantsQuery.data || []
  const activeTenantId = selectedTenantId ?? (tenants.length > 0 ? tenants[0].id : null)
  const activeTenant = tenants.find(t => t.id === activeTenantId)

  return (
    <div className="x-console-page">
      <div className="x-page-header" style={{ marginBottom: 20 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={24} style={{ color: '#2563eb' }} />
            <span>{s.title}</span>
          </h1>
          <p className="x-hint" style={{ marginTop: 4 }}>
            {s.subtitle}
          </p>
        </div>

        {tenants.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label htmlFor="support-integration-tenant-select" style={{ fontSize: 13, fontWeight: 500 }}>
              {s.tenant}:
            </label>
            <select
              id="support-integration-tenant-select"
              data-testid="support-integration-tenant"
              className="x-select"
              value={activeTenantId ?? ''}
              onChange={e => setSelectedTenantId(Number(e.target.value))}
              style={{ minWidth: 200 }}
            >
              {tenants.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.slug})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {tenantsQuery.isPending && <div className="x-loading">{s.loading}</div>}

      {tenantsQuery.isError && (
        <div className="x-alert x-alert-error" role="alert">
          <XCircle size={18} />
          <span>{(tenantsQuery.error as Error).message}</span>
        </div>
      )}

      {!tenantsQuery.isPending && !tenantsQuery.isError && tenants.length === 0 && (
        <div className="x-empty" data-testid="support-integration-empty">
          <AlertTriangle size={32} />
          <p>{s.noTenants}</p>
        </div>
      )}

      {activeTenant && (
        <TenantIntegrationContent
          key={`${revision}-${activeTenant.id}`}
          tenant={activeTenant}
          revision={revision}
          canEdit={canEdit}
        />
      )}
    </div>
  )
}
