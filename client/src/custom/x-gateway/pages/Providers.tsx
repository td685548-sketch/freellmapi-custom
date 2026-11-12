import { useState, useEffect, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  GitBranch,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react'
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { apiFetch } from '@/lib/api'
import { accountsApi, refreshAccounts, useAccounts, type BatchTestResponse, type ValidateNodeResponse, type CustomProviderNode } from '../api'
import { useXStrings } from '../strings'
import { useXGatewayCopy } from '../copy'
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

function ProviderCard({
  provider,
  onDeleteCustomNode,
  onEditCustomNode,
  canDelete,
  canEdit,
}: {
  provider: AccountProvider & { isCustomNode?: boolean; customNodeType?: string; customNodeApiType?: string }
  onDeleteCustomNode?: (provider: AccountProvider) => void
  onEditCustomNode?: (provider: AccountProvider) => void
  canDelete?: boolean
  canEdit?: boolean
}) {
  const s = useXStrings()
  const copy = useXGatewayCopy()
  const enabled = provider.accounts.filter(account => account.enabled).length
  const login = provider.category === 'oauth' || provider.authMethods.some(method => method === 'oauth_pkce' || method === 'device_code')
  const isCookie = (provider.category === 'webCookie' || provider.authMethods.includes('cookie')) && !login
  return <Link to={`/x/providers/${encodeURIComponent(provider.id)}`} className="x-provider-card">
    <div className="x-card-top">
      <ProviderMark id={provider.id} name={provider.name} />
      <div className="x-card-badges">
        {provider.isCustomNode && <span className="x-badge" style={{ color: '#8b5cf6', borderColor: 'rgba(139, 92, 246, 0.3)', background: 'rgba(139, 92, 246, 0.1)' }}>Compatible Node</span>}
        {provider.hasMainDbKey && <span className="x-badge x-main-db-badge">{s.inMainDb}</span>}
        <span className={`x-badge ${provider.accounts.length ? 'x-green' : ''}`}>
          {provider.accounts.length ? <><span className="x-dot" />{s.connected}</> : s.available}
        </span>
        {provider.isCustomNode && canEdit && onEditCustomNode && (
          <button
            type="button"
            className="x-icon-button"
            style={{ padding: '2px 4px', height: 'auto', width: 'auto' }}
            title={copy.editCustomNode}
            aria-label={`${copy.edit}: ${provider.name}`}
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              onEditCustomNode(provider)
            }}
          >
            <Pencil size={13} />
          </button>
        )}
        {provider.isCustomNode && canDelete && onDeleteCustomNode && (
          <button
            type="button"
            className="x-icon-button x-danger"
            style={{ padding: '2px 4px', height: 'auto', width: 'auto' }}
            title="Delete Custom Node"
            aria-label={`${copy.delete}: ${provider.name}`}
            onClick={e => {
              e.preventDefault()
              e.stopPropagation()
              onDeleteCustomNode(provider)
            }}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
    <h3>{provider.name}<ArrowUpRight size={16} /></h3>
    <p className="x-muted">{provider.isCustomNode ? (provider.customNodeType ?? 'Custom Node') : login ? (provider.id === 'github-copilot' ? s.device : s.oauth) : isCookie ? s.cookie : s.apiKey}</p>
    <div className="x-card-bottom"><span>{provider.accounts.length} {s.accounts.toLowerCase()}</span><span>{enabled > 0 ? <><Check size={13} />{enabled} {s.active.toLowerCase()}</> : <KeyRound size={14} />}</span></div>
  </Link>
}

interface AddCompatibleModalProps {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
}

export function AddCompatibleModal({ isOpen, onClose, onCreated }: AddCompatibleModalProps) {
  const [nodeType, setNodeType] = useState<'openai-compatible' | 'anthropic-compatible' | 'custom-embedding'>('openai-compatible')
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [apiType, setApiType] = useState<'chat' | 'responses'>('chat')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [checkKey, setCheckKey] = useState('')
  const [checkModelId, setCheckModelId] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidateNodeResponse | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleTypeChange = (type: 'openai-compatible' | 'anthropic-compatible' | 'custom-embedding') => {
    setNodeType(type)
    setValidationResult(null)
    if (type === 'anthropic-compatible') {
      setBaseUrl('https://api.anthropic.com/v1')
    } else {
      setBaseUrl('https://api.openai.com/v1')
    }
  }

  const handleValidate = async () => {
    if (!baseUrl.trim()) return
    setValidating(true)
    setValidationResult(null)
    try {
      const res = await accountsApi.validateCustomNode({
        baseUrl: baseUrl.trim(),
        apiKey: checkKey.trim() || undefined,
        type: nodeType,
        modelId: checkModelId.trim() || undefined,
      })
      setValidationResult(res)
      if (res.models && res.models.length > 0) {
        setModels(prev => Array.from(new Set([...prev, ...res.models])))
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Validation request failed'
      setValidationResult({
        ok: false,
        valid: false,
        latencyMs: 0,
        models: [],
        message,
        error: message,
      })
    } finally {
      setValidating(false)
    }
  }

  const handleAddModel = () => {
    const trimmed = modelInput.trim()
    if (!trimmed) return
    if (!models.includes(trimmed)) {
      setModels([...models, trimmed])
    }
    setModelInput('')
  }

  const handleRemoveModel = (modelToRemove: string) => {
    setModels(models.filter(m => m !== modelToRemove))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !prefix.trim() || !baseUrl.trim()) {
      setError('Name, Prefix, and Base URL are required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await accountsApi.saveCustomNode({
        id: `custom-${prefix.toLowerCase().replace(/[^a-z0-9_-]/g, '')}-${Date.now().toString(36)}`,
        name: name.trim(),
        prefix: prefix.toLowerCase().trim(),
        type: nodeType,
        ...(nodeType === 'openai-compatible' ? { apiType } : {}),
        baseUrl: baseUrl.trim(),
        models: models.length > 0 ? models : undefined,
      })
      onCreated()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create Custom Provider Node.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <Dialog open onOpenChange={open => { if (!open && !submitting) onClose() }}>
      <DialogPopup className="x-console x-dialog" style={{ maxWidth: '560px' }}>
        <DialogTitle>Add Compatible Provider</DialogTitle>
        <DialogDescription>
          Connect a custom OpenAI, Anthropic, or Custom Embedding compatible endpoint.
        </DialogDescription>

        <form onSubmit={handleSubmit} style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && <div className="x-error" role="alert">{error}</div>}

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>Provider Type</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              <button
                type="button"
                className={`x-button ${nodeType === 'openai-compatible' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('openai-compatible')}
              >
                OpenAI
              </button>
              <button
                type="button"
                className={`x-button ${nodeType === 'anthropic-compatible' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('anthropic-compatible')}
              >
                Anthropic
              </button>
              <button
                type="button"
                className={`x-button ${nodeType === 'custom-embedding' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('custom-embedding')}
              >
                Embedding
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>Name</label>
              <input
                type="text"
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                placeholder="e.g. Local vLLM"
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>Prefix</label>
              <input
                type="text"
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                placeholder="e.g. vllm"
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
                required
              />
            </div>
          </div>

          {nodeType === 'openai-compatible' && (
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>API Type</label>
              <select
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                value={apiType}
                onChange={e => setApiType(e.target.value as 'chat' | 'responses')}
              >
                <option value="chat">Chat Completions (/chat/completions)</option>
                <option value="responses">Responses API (/responses)</option>
              </select>
            </div>
          )}

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>Base URL</label>
            <input
              type="url"
              className="x-input"
              style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
              placeholder={nodeType === 'anthropic-compatible' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'}
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              required
            />
          </div>

          <div style={{ borderTop: '1px solid var(--x-border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--x-muted)' }}>Connection &amp; Validation (Optional)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <input
                  type="password"
                  className="x-input"
                  style={{ width: '100%', padding: '6px 10px', fontSize: '0.8125rem', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                  placeholder="API Key (for check)"
                  value={checkKey}
                  onChange={e => setCheckKey(e.target.value)}
                />
              </div>
              <div>
                <input
                  type="text"
                  className="x-input"
                  style={{ width: '100%', padding: '6px 10px', fontSize: '0.8125rem', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                  placeholder="Model ID (optional)"
                  value={checkModelId}
                  onChange={e => setCheckModelId(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={validating || !baseUrl.trim()}
                onClick={handleValidate}
              >
                {validating ? <LoaderCircle size={14} className="x-spin" /> : <ShieldCheck size={14} />}
                {validating ? 'Validating...' : 'Validate Endpoint'}
              </button>
              {validationResult && (
                validationResult.ok || validationResult.valid ? (
                  <span className="x-badge x-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Check size={13} /> Valid ({validationResult.latencyMs}ms)
                  </span>
                ) : (
                  <span className="x-badge x-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={validationResult.error || validationResult.message}>
                    <AlertTriangle size={13} /> {validationResult.error || validationResult.message || 'Invalid'}
                  </span>
                )
              )}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>Models</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="x-input"
                style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-ink)' }}
                placeholder="Add model ID (e.g. llama-3.3-70b)"
                value={modelInput}
                onChange={e => setModelInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel(); } }}
              />
              <button type="button" className="x-button x-small" onClick={handleAddModel} disabled={!modelInput.trim()}>
                <Plus size={14} /> Add
              </button>
            </div>
            {models.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                {models.map(m => (
                  <span key={m} className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <code>{m}</code>
                    <button
                      type="button"
                      className="x-icon-button"
                      style={{ padding: 0, height: 'auto', width: 'auto' }}
                      onClick={() => handleRemoveModel(m)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '1rem' }}>
            <button type="button" className="x-button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className="x-button x-primary" disabled={submitting || !name.trim() || !prefix.trim() || !baseUrl.trim()}>
              {submitting ? 'Saving...' : 'Save Provider Node'}
            </button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}

interface EditCompatibleModalProps {
  isOpen: boolean
  node: (AccountProvider & { isCustomNode?: boolean; customNodeType?: string; customNodeApiType?: string }) | null
  onClose: () => void
  onUpdated: () => void
}

export function EditCompatibleModal({ isOpen, node, onClose, onUpdated }: EditCompatibleModalProps) {
  const copy = useXGatewayCopy()
  const [nodeType, setNodeType] = useState<'openai-compatible' | 'anthropic-compatible' | 'custom-embedding'>('openai-compatible')
  const [name, setName] = useState('')
  const [prefix, setPrefix] = useState('')
  const [apiType, setApiType] = useState<'chat' | 'responses'>('chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [checkKey, setCheckKey] = useState('')
  const [checkModelId, setCheckModelId] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<ValidateNodeResponse | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!node) return
    setName(node.name || '')
    setPrefix(node.alias || node.id.replace(/^custom-/, '') || '')
    const t = (node.customNodeType as 'openai-compatible' | 'anthropic-compatible' | 'custom-embedding') || 'openai-compatible'
    setNodeType(t)
    setApiType((node.customNodeApiType as 'chat' | 'responses') || 'chat')
    setBaseUrl(node.baseUrl || '')
    setCheckKey('')
    setCheckModelId('')
    setValidationResult(null)
    setError(null)
    setModelInput('')

    accountsApi.getCustomNodes().then(res => {
      const match = res?.nodes?.find(n => n.id === node.id)
      if (match) {
        if (match.models && match.models.length > 0) {
          setModels(match.models)
        } else {
          setModels([])
        }
        if (match.baseUrl) setBaseUrl(match.baseUrl)
        if (match.prefix) setPrefix(match.prefix)
        if (match.type) setNodeType(match.type)
        if (match.apiType) setApiType(match.apiType)
      }
    }).catch(() => {
      setModels([])
    })
  }, [node])

  const handleTypeChange = (type: 'openai-compatible' | 'anthropic-compatible' | 'custom-embedding') => {
    setNodeType(type)
    setValidationResult(null)
    if (!baseUrl.trim() || baseUrl === 'https://api.openai.com/v1' || baseUrl === 'https://api.anthropic.com/v1') {
      if (type === 'anthropic-compatible') {
        setBaseUrl('https://api.anthropic.com/v1')
      } else {
        setBaseUrl('https://api.openai.com/v1')
      }
    }
  }

  const handleValidate = async () => {
    if (!baseUrl.trim()) return
    setValidating(true)
    setValidationResult(null)
    try {
      const res = await accountsApi.validateCustomNode({
        baseUrl: baseUrl.trim(),
        apiKey: checkKey.trim() || undefined,
        type: nodeType,
        modelId: checkModelId.trim() || undefined,
      })
      setValidationResult(res)
      if (res.models && res.models.length > 0) {
        setModels(prev => Array.from(new Set([...prev, ...res.models])))
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Validation request failed'
      setValidationResult({
        ok: false,
        valid: false,
        latencyMs: 0,
        models: [],
        message,
        error: message,
      })
    } finally {
      setValidating(false)
    }
  }

  const handleAddModel = () => {
    const trimmed = modelInput.trim()
    if (!trimmed) return
    if (!models.includes(trimmed)) {
      setModels([...models, trimmed])
    }
    setModelInput('')
  }

  const handleRemoveModel = (modelToRemove: string) => {
    setModels(models.filter(m => m !== modelToRemove))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!node) return
    if (!name.trim() || !prefix.trim() || !baseUrl.trim()) {
      setError(copy.requiredFields)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const payload = {
        name: name.trim(),
        prefix: prefix.toLowerCase().trim(),
        type: nodeType,
        ...(nodeType === 'openai-compatible' ? { apiType } : {}),
        baseUrl: baseUrl.trim(),
        models: models.length > 0 ? models : undefined,
      }
      await apiFetch<{ ok: boolean; node: CustomProviderNode }>(
        `/api/x-accounts/nodes/${encodeURIComponent(node.id)}`,
        {
          method: 'PUT',
          body: JSON.stringify(payload),
        },
      )
      onUpdated()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update Custom Provider Node.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!isOpen || !node) return null

  return (
    <Dialog open onOpenChange={open => { if (!open && !submitting) onClose() }}>
      <DialogPopup className="x-console x-dialog" style={{ maxWidth: '560px' }}>
        <DialogTitle>{copy.editCustomNode}</DialogTitle>
        <DialogDescription>
          {copy.editCustomNodeDesc}
        </DialogDescription>

        <form onSubmit={handleSubmit} style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {error && <div className="x-error" role="alert">{error}</div>}

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>{copy.nodeType}</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
              <button
                type="button"
                className={`x-button ${nodeType === 'openai-compatible' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('openai-compatible')}
              >
                OpenAI
              </button>
              <button
                type="button"
                className={`x-button ${nodeType === 'anthropic-compatible' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('anthropic-compatible')}
              >
                Anthropic
              </button>
              <button
                type="button"
                className={`x-button ${nodeType === 'custom-embedding' ? 'x-primary' : ''}`}
                onClick={() => handleTypeChange('custom-embedding')}
              >
                Embedding
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>{copy.nodeName}</label>
              <input
                type="text"
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                value={name}
                onChange={e => setName(e.target.value)}
                required
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>{copy.nodePrefix}</label>
              <input
                type="text"
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                value={prefix}
                onChange={e => setPrefix(e.target.value)}
                required
              />
            </div>
          </div>

          {nodeType === 'openai-compatible' && (
            <div>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>{copy.apiType}</label>
              <select
                className="x-input"
                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                value={apiType}
                onChange={e => setApiType(e.target.value as 'chat' | 'responses')}
              >
                <option value="chat">{copy.apiTypeChat}</option>
                <option value="responses">{copy.apiTypeResponses}</option>
              </select>
            </div>
          )}

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>{copy.baseUrl}</label>
            <input
              type="url"
              className="x-input"
              style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              required
            />
          </div>

          <div style={{ borderTop: '1px solid var(--x-border)', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--x-muted)' }}>Connection &amp; Validation (Optional)</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <input
                  type="password"
                  className="x-input"
                  style={{ width: '100%', padding: '6px 10px', fontSize: '0.8125rem', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                  placeholder="API Key (for check)"
                  value={checkKey}
                  onChange={e => setCheckKey(e.target.value)}
                />
              </div>
              <div>
                <input
                  type="text"
                  className="x-input"
                  style={{ width: '100%', padding: '6px 10px', fontSize: '0.8125rem', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                  placeholder="Model ID (optional)"
                  value={checkModelId}
                  onChange={e => setCheckModelId(e.target.value)}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '4px' }}>
              <button
                type="button"
                className="x-button x-small"
                disabled={validating || !baseUrl.trim()}
                onClick={handleValidate}
              >
                {validating ? <LoaderCircle size={14} className="x-spin" /> : <ShieldCheck size={14} />}
                {validating ? copy.validating : copy.validateEndpoint}
              </button>
              {validationResult && (
                validationResult.ok || validationResult.valid ? (
                  <span className="x-badge x-green" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Check size={13} /> {copy.valid} ({validationResult.latencyMs}ms)
                  </span>
                ) : (
                  <span className="x-badge x-danger" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={validationResult.error || validationResult.message}>
                    <AlertTriangle size={13} /> {validationResult.error || validationResult.message || copy.invalid}
                  </span>
                )
              )}
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '4px' }}>{copy.models}</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                className="x-input"
                style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--x-border)', background: 'var(--x-surface-subtle)', color: 'var(--x-text)' }}
                placeholder={copy.addModelPlaceholder}
                value={modelInput}
                onChange={e => setModelInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel(); } }}
              />
              <button type="button" className="x-button x-small" onClick={handleAddModel} disabled={!modelInput.trim()}>
                <Plus size={14} /> {copy.add}
              </button>
            </div>
            {models.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
                {models.map(m => (
                  <span key={m} className="x-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <code>{m}</code>
                    <button
                      type="button"
                      className="x-icon-button"
                      style={{ padding: 0, height: 'auto', width: 'auto' }}
                      onClick={() => handleRemoveModel(m)}
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '1rem' }}>
            <button type="button" className="x-button" onClick={onClose} disabled={submitting}>
              {copy.cancel}
            </button>
            <button type="submit" className="x-button x-primary" disabled={submitting || !name.trim() || !prefix.trim() || !baseUrl.trim()}>
              {submitting ? copy.saving : copy.save}
            </button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
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
  const [showAddModal, setShowAddModal] = useState(false)
  const [nodeToDelete, setNodeToDelete] = useState<AccountProvider | null>(null)
  const [nodeToEdit, setNodeToEdit] = useState<(AccountProvider & { isCustomNode?: boolean; customNodeType?: string; customNodeApiType?: string }) | null>(null)

  const deleteNodeMutation = useMutation({
    mutationFn: (nodeId: string) => accountsApi.deleteCustomNode(nodeId),
    onSuccess: async () => {
      setNodeToDelete(null)
      await refreshAccounts(client)
    },
  })

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
      <div><div className="x-eyebrow">FreeLLMAPI / Xwitch</div><h1>{s.providers}</h1><p>{s.providerHelp}</p></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {permissions?.add && (
          <button
            type="button"
            className="x-button x-primary"
            onClick={() => setShowAddModal(true)}
          >
            <Plus size={16} />
            Add Compatible Provider
          </button>
        )}
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
    {login.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.oauthProviders}<span>{login.length}</span></h2><p>{s.oauthHelp}</p></div><div className="x-provider-grid">{login.map(provider => <ProviderCard key={provider.id} provider={provider} onDeleteCustomNode={setNodeToDelete} onEditCustomNode={setNodeToEdit} canDelete={permissions?.delete} canEdit={permissions?.edit} />)}</div></section>}
    {free.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.freeProviders}<span>{free.length}</span></h2></div><div className="x-provider-grid">{free.map(provider => <ProviderCard key={provider.id} provider={provider} onDeleteCustomNode={setNodeToDelete} onEditCustomNode={setNodeToEdit} canDelete={permissions?.delete} canEdit={permissions?.edit} />)}</div></section>}
    {freeTier.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.freeTierProviders}<span>{freeTier.length}</span></h2></div><div className="x-provider-grid">{freeTier.map(provider => <ProviderCard key={provider.id} provider={provider} onDeleteCustomNode={setNodeToDelete} onEditCustomNode={setNodeToEdit} canDelete={permissions?.delete} canEdit={permissions?.edit} />)}</div></section>}
    {api.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.apiProviders}<span>{api.length}</span></h2><p>{s.apiHelp}</p></div><div className="x-provider-grid">{api.map(provider => <ProviderCard key={provider.id} provider={provider} onDeleteCustomNode={setNodeToDelete} onEditCustomNode={setNodeToEdit} canDelete={permissions?.delete} canEdit={permissions?.edit} />)}</div></section>}
    {webCookie.length > 0 && <section className="x-provider-section"><div className="x-section-heading"><h2>{s.webCookieProviders}<span>{webCookie.length}</span></h2></div><div className="x-provider-grid">{webCookie.map(provider => <ProviderCard key={provider.id} provider={provider} onDeleteCustomNode={setNodeToDelete} onEditCustomNode={setNodeToEdit} canDelete={permissions?.delete} canEdit={permissions?.edit} />)}</div></section>}
    {filtered.length === 0 && <div className="x-empty"><Search size={32} /><h2>{s.noResults}</h2><p>{s.noResultsHelp}</p></div>}
    <p className="x-footnote">{s.sharedPool}</p>

    {nodeToDelete && (
      <Dialog open onOpenChange={open => { if (!open && !deleteNodeMutation.isPending) setNodeToDelete(null) }}>
        <DialogPopup className="x-console x-dialog" style={{ maxWidth: '420px' }}>
          <DialogTitle>Delete Compatible Provider</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the custom provider node &ldquo;{nodeToDelete.name}&rdquo;?
          </DialogDescription>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '1.25rem' }}>
            <button type="button" className="x-button" onClick={() => setNodeToDelete(null)} disabled={deleteNodeMutation.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="x-button x-danger"
              disabled={deleteNodeMutation.isPending}
              onClick={() => deleteNodeMutation.mutate(nodeToDelete.id)}
            >
              {deleteNodeMutation.isPending ? 'Deleting...' : 'Delete Node'}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    )}

    <AddCompatibleModal
      isOpen={showAddModal}
      onClose={() => setShowAddModal(false)}
      onCreated={async () => {
        await refreshAccounts(client)
      }}
    />

    <EditCompatibleModal
      isOpen={Boolean(nodeToEdit)}
      node={nodeToEdit}
      onClose={() => setNodeToEdit(null)}
      onUpdated={async () => {
        await refreshAccounts(client)
      }}
    />
  </>
}
