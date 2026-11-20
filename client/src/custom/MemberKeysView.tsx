import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Activity, Plus, RotateCw, Trash2, Key, CheckCircle2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/page-header'
import { CopyButton } from '@/components/copy-button'
import { toast } from '@/lib/toast'
import { UserAnalyticsView } from './UserAnalyticsView'
import { QuotaCard } from './QuotaCard'
import { RecentRequestsCard } from './RecentRequestsCard'
import { QuotaCoachCard } from './customer-ai/QuotaCoachCard'
import { fetchCustomerAssistants, patchUserKeyAiConfig } from './customer-ai/api'
import { KEY_ROUTING_MODES, type CustomerAiAssistant, type KeyRoutingMode } from '../../../shared/customer-ai'

import type { UserApiKey } from '../../../shared/user-access'
import { useCustomT } from './i18n/use-custom-t'
import { askConfirm } from '@/custom/x-gateway/shell/confirm-store'
export type { UserApiKey } from '../../../shared/user-access'

export function MemberKeysView() {
  const tc = useCustomT()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<{ id: number; secret: string } | null>(null)
  const [guideTab, setGuideTab] = useState<'cursor' | 'cline' | 'terminal' | 'python'>('cursor')
  const isBrowserLocal = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  const [endpointMode, setEndpointMode] = useState<'origin' | 'local'>(isBrowserLocal ? 'local' : 'origin')

  const originBaseUrl = typeof window !== 'undefined' ? `${window.location.origin}/v1` : 'http://127.0.0.1:3001/v1'
  const localDirectBaseUrl = 'http://127.0.0.1:3001/v1'
  const baseUrl = endpointMode === 'local' ? localDirectBaseUrl : originBaseUrl

  const { data, isLoading } = useQuery<{ keys: UserApiKey[] }>({
    queryKey: ['user-api-keys'],
    queryFn: () => apiFetch<{ keys: UserApiKey[] }>('/api/user/keys'),
  })

  const keys = data?.keys ?? []

  const { data: usageData } = useQuery<{ usage: { requests: number; tokens: number; month: string; rpmLimit?: number } }>({
    queryKey: ['user-usage'],
    queryFn: () => apiFetch<{ usage: { requests: number; tokens: number; month: string; rpmLimit?: number } }>('/api/user/usage'),
  })

  const { data: catalogData } = useQuery<{ assistants: CustomerAiAssistant[] }>({
    queryKey: ['customer-ai-catalog', 'keys'],
    queryFn: () => fetchCustomerAssistants(),
    staleTime: 30_000,
  })
  const assistants = Array.isArray(catalogData?.assistants) ? catalogData.assistants : []

  const updateKeyAiMutation = useMutation({
    mutationFn: ({ keyId, patch }: { keyId: number; patch: { routingMode?: KeyRoutingMode; assistantId?: number | null } }) =>
      patchUserKeyAiConfig(keyId, patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      void queryClient.invalidateQueries({ queryKey: ['customer-ai-coach'] })
      toast.success(tc('Key AI configuration updated'))
    },
    onError: (err: Error) => {
      toast.error(err.message || tc('Failed to update key AI configuration'))
    },
  })

  const createKeyMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ key: { key: string; name: string; id: number } }>('/api/user/keys', {
        method: 'POST',
        body: JSON.stringify({ name: name || 'Default Key' }),
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      setNewlyCreatedKey({ id: res.key.id, secret: res.key.key })
      setCreateOpen(false)
      setKeyName('')
      toast.success(tc('API Key generated successfully'))
    },
    onError: (err) => {
      toast.error(err.message || tc('Failed to generate key'))
    },
  })

  const revokeKeyMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ success: boolean }>(`/api/user/keys/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_res, id) => {
      setNewlyCreatedKey(current => current?.id === id ? null : current)
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      toast.success(tc('API Key revoked'))
    },
    onError: (err) => {
      toast.error(err.message || tc('Failed to revoke key'))
    },
  })

  const rotateKeyMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ key: { key: string; name: string; id: number }; oldKeyId: number }>(`/api/user/keys/${id}/rotate`, {
        method: 'POST',
      }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['user-api-keys'] })
      setNewlyCreatedKey({ id: res.key.id, secret: res.key.key })
      toast.success(tc('API Key rotated successfully'))
    },
    onError: (err) => {
      toast.error(err.message || tc('Failed to rotate key'))
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    createKeyMutation.mutate(keyName.trim())
  }

  const handleRotate = async (id: number, name: string) => {
    if (await askConfirm(tc('Rotate API key "{name}"? A new key will be created immediately with the same settings, and this key will be revoked.', { name }))) {
      rotateKeyMutation.mutate(id)
    }
  }

  const handleRevoke = async (id: number, name: string) => {
    if (await askConfirm(tc('Are you sure you want to revoke key "{name}"? Any clients using it will immediately lose access.', { name }))) {
      revokeKeyMutation.mutate(id)
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title={tc('Personal API Keys')}
        description={tc('Manage your personal gateway credentials for Cursor, Cline, Claude Code, and other LLM clients.')}
        actions={
          <div className="flex items-center gap-2">
            <NavLink to="/status">
              <Button variant="outline" size="sm" className="text-xs">
                <Activity className="size-3.5 mr-1.5 text-emerald-500" />
                {tc('System Status')}
              </Button>
            </NavLink>
            <Button onClick={() => { setNewlyCreatedKey(null); setCreateOpen(true) }}>
              <Plus className="mr-1.5 size-4" />{tc('Generate New Key')}
            </Button>
          </div>
        }
      />

      {/* Usage & Quota Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-2xl border bg-card p-5 space-y-1 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">{tc('Usage this month (')}{usageData?.usage?.month || tc('Current')})</div>
          <div className="text-2xl font-bold text-foreground">
            {usageData?.usage?.requests ?? 0} <span className="text-sm font-normal text-muted-foreground">{tc('successful requests')}</span>
          </div>
          <div className="text-xs text-muted-foreground">{usageData?.usage?.tokens ?? 0}{' '}{tc('total tokens')}</div>
        </div>
        <div className="rounded-2xl border bg-card p-5 space-y-1 shadow-sm">
          <div className="text-xs font-medium text-muted-foreground">{tc('Rate Limit Quota')}</div>
          <div className="text-2xl font-bold text-foreground">
            {usageData?.usage?.rpmLimit ?? 60} <span className="text-sm font-normal text-muted-foreground">{tc('RPM')}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {tc('Up to {rpm} requests/minute allocated to your personal keys', { rpm: usageData?.usage?.rpmLimit ?? 60 })}
          </div>
        </div>
      </div>

      <section className="space-y-3" aria-label="My usage">
        <h2 className="text-sm font-semibold">{tc('My usage')}</h2>
        <QuotaCoachCard />
        <QuotaCard endpoint="/api/user/usage-quota" queryKey={['user-quota']} canEdit={false} />
        <UserAnalyticsView endpoint="/api/user/analytics" queryKey={['user-analytics']} />
        <RecentRequestsCard endpoint="/api/user/requests" title={tc('My recent requests')} />
      </section>

      {/* Newly minted key banner */}
      {newlyCreatedKey && (
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-2 text-primary font-medium text-sm">
            <CheckCircle2 className="size-4" />
            <span>{tc('Key Created Successfully')}</span>
          </div>
          <p className="text-xs text-muted-foreground">{tc('Please copy this key now. For your security, it will never be displayed again.')}</p>
          <div className="flex items-center gap-2">
            <div className="flex-1 font-mono text-xs bg-background/80 border rounded-lg px-3 py-2 text-foreground break-all select-all">
              {newlyCreatedKey.secret}
            </div>
            <CopyButton text={newlyCreatedKey.secret} label={tc('Copy API key')} className="h-9 px-3" />
          </div>
        </div>
      )}

      {/* Keys List */}
      <div className="rounded-2xl border bg-card overflow-hidden">
        <div className="border-b px-5 py-3.5 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{tc('Active Keys (')}{keys.filter(key => !key.revoked).length})</h2>
        </div>

        {isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{tc('Loading keys…')}</div>
        ) : keys.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <Key className="size-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm font-medium">{tc('No API keys yet')}</p>
            <p className="text-xs text-muted-foreground">{tc('Generate an API key to start querying FreeLLMAPI with your favorite coding assistant.')}</p>
          </div>
        ) : (
          <div className="divide-y">
            {keys.map((k) => (
              <div key={k.id} className="p-4 flex flex-wrap sm:flex-nowrap items-center justify-between gap-4 hover:bg-muted/30 transition-colors">
                <div className="min-w-0 space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-foreground">{k.name}</span>
                    <span className="font-mono text-xs text-muted-foreground bg-muted/60 px-2 py-0.5 rounded">
                      {k.keyPrefix}••••••••
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-4">
                    <span>{tc('Created:')}{' '}{new Date(k.createdAt).toLocaleDateString()}</span>
                    <span>{tc('Last used:')}{' '}{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : tc('Never')}</span>
                  </div>
                  {!k.revoked && (
                    <div className="pt-1.5 flex flex-wrap items-center gap-2 text-xs">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">{tc('Routing:')}</span>
                        <select
                          aria-label={`Routing mode for ${k.name}`}
                          value={k.routingMode ?? 'default'}
                          disabled={updateKeyAiMutation.isPending}
                          onChange={(e) =>
                            updateKeyAiMutation.mutate({
                              keyId: k.id,
                              patch: { routingMode: e.target.value as KeyRoutingMode },
                            })
                          }
                          className="h-7 rounded-lg border bg-background px-2 text-xs"
                        >
                          {KEY_ROUTING_MODES.map((m) => (
                            <option key={m} value={m}>
                              {m === 'default' && tc('Default (global)')}
                              {m === 'eco' && tc('Eco (Save Quota)')}
                              {m === 'balanced' && tc('Balanced')}
                              {m === 'max' && tc('Max Quality')}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">{tc('Assistant:')}</span>
                        <select
                          aria-label={`Assistant preset for ${k.name}`}
                          value={k.assistantId ? String(k.assistantId) : ''}
                          disabled={updateKeyAiMutation.isPending}
                          onChange={(e) => {
                            const nextId = e.target.value ? Number(e.target.value) : null
                            updateKeyAiMutation.mutate({
                              keyId: k.id,
                              patch: { assistantId: nextId },
                            })
                          }}
                          className="h-7 rounded-lg border bg-background px-2 text-xs"
                        >
                          <option value="">{tc('None (raw prompt)')}</option>
                          {assistants.map((a) => (
                            <option key={a.id} value={String(a.id)}>{a.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
                {k.revoked ? (
                  <span className="text-xs text-muted-foreground">{tc('Revoked')}</span>
                ) : (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      disabled={rotateKeyMutation.isPending || revokeKeyMutation.isPending}
                      variant="outline"
                      size="sm"
                      onClick={() => handleRotate(k.id, k.name)}
                      className="text-xs h-8"
                      title={tc('Rotate Key (create new key & revoke this one)')}
                    >
                      <RotateCw className={`size-3.5 mr-1 ${rotateKeyMutation.isPending ? 'animate-spin' : ''}`} />
                      {tc('Rotate')}
                    </Button>
                    <Button
                      disabled={revokeKeyMutation.isPending || rotateKeyMutation.isPending}
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevoke(k.id, k.name)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive text-xs shrink-0 h-8"
                    >
                      <Trash2 className="size-3.5 mr-1" />{tc('Revoke')}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quick Setup Guide */}
      <div className="rounded-2xl border bg-card p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold">{tc('Client Setup Guide')}</h2>
          <p className="text-xs text-muted-foreground mt-0.5">{tc('Configure your AI assistant or IDE extension using your personal gateway key.')}</p>
        </div>

        {/* Base URL bar */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 max-w-lg">
            <Label className="text-xs font-medium">{tc('OpenAI Compatible Base URL')}</Label>
            <div className="inline-flex rounded-lg border bg-muted/40 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setEndpointMode('local')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  endpointMode === 'local' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Local (127.0.0.1:3001)
              </button>
              {!isBrowserLocal && (
                <button
                  type="button"
                  onClick={() => setEndpointMode('origin')}
                  className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                    endpointMode === 'origin' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tc('Public / Network')}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 max-w-lg">
            <div className="flex-1 font-mono text-xs bg-muted/60 border rounded-lg px-3 py-2 text-foreground">
              {baseUrl}
            </div>
            <CopyButton text={baseUrl} label={tc('Copy Base URL')} className="h-9 px-3" />
          </div>
          <p className="text-[11px] text-muted-foreground max-w-lg">
            {endpointMode === 'local'
              ? tc('Direct local server call (0ms overhead, bypasses external network).')
              : tc('Use for external devices connecting over LAN or the Internet.')}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-2 border-b pb-2 text-xs">
          {(['cursor', 'cline', 'terminal', 'python'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setGuideTab(tab)}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors ${
                guideTab === tab
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'cursor' && tc('Cursor IDE')}
              {tab === 'cline' && tc('Cline / Roo Code')}
              {tab === 'terminal' && tc('Claude Code / Terminal')}
              {tab === 'python' && tc('Python / OpenAI SDK')}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="text-xs space-y-3 font-mono bg-muted/40 p-4 rounded-xl border">
          {guideTab === 'cursor' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">{tc('1. Open')}{' '}<strong>{tc('Cursor Settings')}</strong> → <strong>{tc('Models')}</strong>.</p>
              <p className="font-sans text-muted-foreground">{tc('2. Turn off other providers or enable')}{' '}<strong>{tc('OpenAI API Key')}</strong>.</p>
              <p className="font-sans text-muted-foreground">{tc('3. Click')}{' '}<strong>{tc('Override OpenAI Base URL')}</strong>{' '}{tc('and enter:')}</p>
              <div className="flex items-center justify-between bg-card p-2.5 rounded border">
                <span>{baseUrl}</span>
                <CopyButton text={baseUrl} />
              </div>
              <p className="font-sans text-muted-foreground">{tc('4. Paste your')}{' '}<strong>{tc('Personal API Key')}</strong>{' '}{tc('into the OpenAI API Key box.')}</p>
            </div>
          )}

          {guideTab === 'cline' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">{tc('1. Open')}{' '}<strong>{tc('Cline')}</strong>{' '}{tc('settings in VS Code.')}</p>
              <p className="font-sans text-muted-foreground">{tc('2. Select')}{' '}<strong>{tc('API Provider')}</strong>: <code>{tc('OpenAI Compatible')}</code>.</p>
              <p className="font-sans text-muted-foreground">{tc('3. Set')}{' '}<strong>{tc('Base URL')}</strong>:</p>
              <div className="flex items-center justify-between bg-card p-2.5 rounded border">
                <span>{baseUrl}</span>
                <CopyButton text={baseUrl} />
              </div>
              <p className="font-sans text-muted-foreground">{tc('4. Paste your')}{' '}<strong>{tc('Personal API Key')}</strong>{' '}{tc('into')}{' '}<strong>{tc('API Key')}</strong>.</p>
            </div>
          )}

          {guideTab === 'terminal' && (
            <div className="space-y-2">
              <p className="font-sans text-muted-foreground">{tc('Export these environment variables in your terminal:')}</p>
              <div className="bg-card p-3 rounded border space-y-1">
                <p>{tc('export OPENAI_BASE_URL="')}{baseUrl}"</p>
                <p>{tc('export OPENAI_API_KEY="sk-flm-your-key-here"')}</p>
              </div>
              <CopyButton text={`export OPENAI_BASE_URL="${baseUrl}"\nexport OPENAI_API_KEY="sk-flm-your-key-here"`} label={tc('Copy export commands')} />
            </div>
          )}

          {guideTab === 'python' && (
            <div className="space-y-2">
              <div className="bg-card p-3 rounded border">
                <pre className="text-muted-foreground">
{tc('from openai import OpenAI\n\nclient = OpenAI(\n    base_url="{baseUrl}",\n    api_key="sk-flm-your-key-here"\n)\n\nresponse = client.chat.completions.create(\n    model="llama-3.3-70b-versatile",\n    messages=[{"role": "user", "content": "Hello!"}]\n)\nprint(response.choices[0].message.content)', { baseUrl: baseUrl })}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Key Modal Dialog */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-3xl border bg-card p-6 shadow-xl space-y-4">
            <h3 className="text-base font-semibold">{tc('Generate New API Key')}</h3>
            <p className="text-xs text-muted-foreground">{tc('Give your key a descriptive label so you can track which device or project is using it.')}</p>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="key-name" className="text-xs">{tc('Key Name / Label')}</Label>
                <Input
                  id="key-name"
                  type="text"
                  placeholder={tc('e.g. Cursor MacBook Pro')}
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>{tc('Cancel')}</Button>
                <Button type="submit" disabled={createKeyMutation.isPending}>
                  {createKeyMutation.isPending ? tc('Generating…') : tc('Generate')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
