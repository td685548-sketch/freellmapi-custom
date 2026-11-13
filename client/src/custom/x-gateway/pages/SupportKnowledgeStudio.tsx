import type {
  SupportEvidenceCase,
  SupportEvidenceFormat,
  SupportEvidencePolicy,
  SupportEvidenceRole,
  SupportEvidenceRun,
  SupportEvidenceSource,
  SupportEvidenceSuite,
  SupportEvidenceSourceKind,
  SupportEvidenceRevision,
  SupportEvidenceRevisionDetail,
} from '@freellmapi/shared/support-evidence.js'
import { useState, type ReactNode, type ChangeEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useSessionRevision } from '../../session-state'
import { useUserSession } from '../../use-session'
import { useSupportEvidenceStrings } from '../support-evidence-strings'

export interface SupportTenant {
  id: number
  name: string
  slug: string
  publicKey: string
  defaultModel: string
  allowedOrigins: string[]
  enabled: boolean
}

type TabId = 'sources' | 'preview' | 'policy' | 'evaluations'

const tabs: Array<{ id: TabId; icon: typeof FileText }> = [
  { id: 'sources', icon: FileText },
  { id: 'preview', icon: Eye },
  { id: 'policy', icon: ShieldAlert },
  { id: 'evaluations', icon: CheckCircle2 },
]

const DEFAULT_POLICY: SupportEvidencePolicy = {
  mode: 'off',
  includeLegacyDocs: true,
  topK: 3,
  minCoverage: 0.25,
  maxEvidenceChars: 6000,
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
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

function Feedback({ error, success, conflict }: { error?: Error | null; success?: boolean; conflict?: boolean }) {
  const s = useSupportEvidenceStrings()
  if (conflict) {
    return (
      <div className="x-alert x-alert-error" role="alert" data-testid="policy-conflict-error" style={{ marginBottom: 16 }}>
        <AlertTriangle size={18} />
        <span>{s.conflictError}</span>
      </div>
    )
  }
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

// ---------------------------------------------------------
// Tab 1: Sources Panel
// ---------------------------------------------------------
function SourcesPanel({
  tenantBase,
  queryKey,
  canEdit,
}: {
  tenantBase: string
  queryKey: readonly unknown[]
  canEdit: boolean
}) {
  const s = useSupportEvidenceStrings()
  const queryClient = useQueryClient()

  // New source form state
  const [newSourceName, setNewSourceName] = useState('')
  const [newSourceKind, setNewSourceKind] = useState<SupportEvidenceSourceKind>('text')
  const [newSourceRoles, setNewSourceRoles] = useState<SupportEvidenceRole[]>(['admin'])

  // Selected source for revisions & import
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null)
  // Editing allowed roles for a source
  const [editingSourceRolesId, setEditingSourceRolesId] = useState<string | null>(null)
  const [editingRoles, setEditingRoles] = useState<SupportEvidenceRole[]>(['admin'])
  // Format for URL import
  const [revUrlFormat, setRevUrlFormat] = useState<SupportEvidenceFormat>('text')

  // Revision import state
  const [revTitle, setRevTitle] = useState('')
  const [revCategory, setRevCategory] = useState('')
  const [revTags, setRevTags] = useState('')
  const [revContent, setRevContent] = useState('')
  const [revUrl, setRevUrl] = useState('')
  const [importNotice, setImportNotice] = useState<string | null>(null)
  const [importClientError, setImportClientError] = useState<string | null>(null)

  // Viewing revision content
  const [viewingRevisionContent, setViewingRevisionContent] = useState<{ id: string; content: string } | null>(null)

  // 1. Sources query
  const sourcesQuery = useQuery({
    queryKey: [...queryKey, 'sources'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; sources: SupportEvidenceSource[] }>(`${tenantBase}/sources`, { signal }).then(
        r => r.sources || []
      ),
  })

  const sources = sourcesQuery.data || []
  const selectedSource = sources.find(src => src.id === selectedSourceId) || null

  // 2. Revisions query for selected source
  const revisionsQuery = useQuery({
    queryKey: [...queryKey, 'sources', selectedSourceId, 'revisions'],
    queryFn: ({ signal }) => {
      if (!selectedSourceId) return Promise.resolve([])
      return apiFetch<{ ok: boolean; revisions: SupportEvidenceRevision[] }>(
        `${tenantBase}/sources/${selectedSourceId}/revisions`,
        { signal }
      ).then(r => r.revisions || [])
    },
    enabled: !!selectedSourceId,
  })

  // Mutations
  const createSourceMutation = useMutation({
    mutationFn: (input: { name: string; kind: SupportEvidenceSourceKind; allowedRoles: SupportEvidenceRole[] }) =>
      apiFetch<{ ok: boolean; source: SupportEvidenceSource }>(`${tenantBase}/sources`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: data => {
      setNewSourceName('')
      setNewSourceKind('text')
      setNewSourceRoles(['admin'])
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'sources'] })
      if (data && data.source) setSelectedSourceId(data.source.id)
    },
  })

  const updateSourceMutation = useMutation({
    mutationFn: (args: {
      sourceId: string
      expectedVersion: number
      status?: 'active' | 'archived'
      name?: string
      allowedRoles?: SupportEvidenceRole[]
    }) =>
      apiFetch<{ ok: boolean; source: SupportEvidenceSource }>(`${tenantBase}/sources/${args.sourceId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: args.expectedVersion,
          status: args.status,
          name: args.name,
          allowedRoles: args.allowedRoles,
        }),
      }),
    onSuccess: () => {
      setEditingSourceRolesId(null)
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'sources'] })
    },
  })

  const importRevisionMutation = useMutation({
    mutationFn: (args: {
      sourceId: string
      expectedVersion: number
      title: string
      category?: string
      tags?: string[]
      format: SupportEvidenceFormat
      content?: string
      url?: string
    }) =>
      apiFetch<{ ok: boolean; deduplicated?: boolean; revision: SupportEvidenceRevision; source: SupportEvidenceSource }>(
        `${tenantBase}/sources/${args.sourceId}/revisions`,
        {
          method: 'POST',
          body: JSON.stringify(args),
        }
      ),
    onSuccess: data => {
      setRevTitle('')
      setRevCategory('')
      setRevTags('')
      setRevContent('')
      setRevUrl('')
      setImportClientError(null)
      if (data && data.deduplicated) {
        setImportNotice(s.sources.importDeduplicated)
      } else {
        setImportNotice(s.saved)
      }
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'sources'] })
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'sources', selectedSourceId, 'revisions'] })
    },
  })

  const publishRevisionMutation = useMutation({
    mutationFn: (args: { sourceId: string; expectedVersion: number; revisionId: string }) =>
      apiFetch<{ ok: boolean; source: SupportEvidenceSource }>(`${tenantBase}/sources/${args.sourceId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: args.expectedVersion, revisionId: args.revisionId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'sources'] })
    },
  })

  function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 1_048_576) {
      setImportClientError(s.sources.errors.tooLarge)
      return
    }
    const reader = new FileReader()
    reader.onload = evt => {
      const text = String(evt.target?.result || '')
      if (text.length > 64_000) {
        setImportClientError(s.sources.errors.tooManyChars)
      } else {
        setImportClientError(null)
        setRevContent(text)
        if (!revTitle) setRevTitle(file.name.replace(/\.[^/.]+$/, ''))
      }
    }
    reader.readAsText(file)
  }

  function handleImportSubmit() {
    if (!selectedSource) return
    setImportNotice(null)
    setImportClientError(null)

    if (!revTitle.trim()) {
      setImportClientError(s.requiredField.replace('{field}', s.sources.revisionTitle))
      return
    }

    const tagsArray = revTags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)

    if (selectedSource.kind === 'url') {
      if (!revUrl.trim()) {
        setImportClientError(s.requiredField.replace('{field}', s.sources.url))
        return
      }
      importRevisionMutation.mutate({
        sourceId: selectedSource.id,
        expectedVersion: selectedSource.version,
        title: revTitle.trim(),
        category: revCategory.trim() || undefined,
        tags: tagsArray.length > 0 ? tagsArray : undefined,
        format: revUrlFormat,
        url: revUrl.trim(),
      })
    } else {
      if (!revContent.trim()) {
        setImportClientError(s.requiredField.replace('{field}', s.sources.content))
        return
      }
      if (revContent.length > 64_000) {
        setImportClientError(s.sources.errors.tooManyChars)
        return
      }
      importRevisionMutation.mutate({
        sourceId: selectedSource.id,
        expectedVersion: selectedSource.version,
        title: revTitle.trim(),
        category: revCategory.trim() || undefined,
        tags: tagsArray.length > 0 ? tagsArray : undefined,
        format: selectedSource.kind as SupportEvidenceFormat,
        content: revContent,
      })
    }
  }

  async function handleViewRevision(revId: string) {
    if (viewingRevisionContent?.id === revId) {
      setViewingRevisionContent(null)
      return
    }
    if (!selectedSource) return
    try {
      const data = await apiFetch<{ ok: boolean; revision: SupportEvidenceRevisionDetail }>(
        `${tenantBase}/sources/${selectedSource.id}/revisions/${revId}`
      )
      setViewingRevisionContent({ id: revId, content: data.revision?.content || '' })
    } catch {
      setViewingRevisionContent(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Notice Banner */}
      <div className="x-alert x-alert-info" role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <BookOpen size={18} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: 13, lineHeight: 1.5 }}>{s.sources.noticeRequiredMode}</span>
      </div>

      {/* Create Source Card */}
      {canEdit && (
        <div className="x-card" style={{ padding: 16, background: 'var(--x-alt)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: 15 }}>{s.sources.newSource}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
            <div className="x-field">
              <label htmlFor="new-source-name">
                <strong>{s.sources.sourceName}</strong>
              </label>
              <input
                id="new-source-name"
                data-testid="source-name-input"
                type="text"
                className="x-input"
                placeholder={s.sources.namePlaceholder}
                value={newSourceName}
                onChange={e => setNewSourceName(e.target.value)}
              />
            </div>
            <div className="x-field">
              <label htmlFor="new-source-kind">
                <strong>{s.sources.kind}</strong>
              </label>
              <select
                id="new-source-kind"
                data-testid="source-kind-select"
                className="x-select"
                value={newSourceKind}
                onChange={e => setNewSourceKind(e.target.value as SupportEvidenceSourceKind)}
              >
                <option value="text">{s.sources.kinds.text}</option>
                <option value="markdown">{s.sources.kinds.markdown}</option>
                <option value="faq_json">{s.sources.kinds.faq_json}</option>
                <option value="url">{s.sources.kinds.url}</option>
              </select>
            </div>
          </div>

          <div className="x-field" style={{ marginBottom: 14 }}>
            <label>
              <strong>{s.sources.allowedRoles}</strong>
            </label>
            <div style={{ display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
              {(['admin', 'staff', 'customer', 'guest'] as SupportEvidenceRole[]).map(role => (
                <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={newSourceRoles.includes(role)}
                    onChange={e => {
                      if (e.target.checked) {
                        setNewSourceRoles(prev => Array.from(new Set([...prev, role])))
                      } else {
                        const updated = newSourceRoles.filter(r => r !== role)
                        setNewSourceRoles(updated.length > 0 ? updated : ['admin'])
                      }
                    }}
                  />
                  <span>{s.roles[role]}</span>
                </label>
              ))}
            </div>
            <small className="x-hint" style={{ marginTop: 4 }}>{s.sources.defaultRolesHint}</small>
          </div>

          <button
            type="button"
            data-testid="create-source-btn"
            className="x-btn x-btn-primary"
            disabled={!newSourceName.trim() || createSourceMutation.isPending}
            onClick={() =>
              createSourceMutation.mutate({
                name: newSourceName.trim(),
                kind: newSourceKind,
                allowedRoles: newSourceRoles,
              })
            }
          >
            <Plus size={15} />
            <span>{createSourceMutation.isPending ? s.loading : s.sources.createSourceBtn}</span>
          </button>
        </div>
      )}

      {/* Sources List */}
      <div>
        <h3 style={{ fontSize: 15, margin: '0 0 12px 0' }}>{s.sources.activeSources}</h3>
        {sourcesQuery.isPending && <div className="x-loading">{s.loading}</div>}
        {sourcesQuery.isError && (
          <div className="x-alert x-alert-error" role="alert">
            <XCircle size={18} />
            <span>{(sourcesQuery.error as Error).message}</span>
          </div>
        )}
        {!sourcesQuery.isPending && sources.length === 0 && (
          <div className="x-empty" data-testid="sources-empty">
            <p>{s.sources.noSources}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {sources.map(src => {
            const isSelected = selectedSourceId === src.id
            const isArchived = src.status === 'archived'
            return (
              <div
                key={src.id}
                data-testid={`source-card-${src.id}`}
                className="x-card"
                style={{
                  padding: 14,
                  border: isSelected ? '2px solid var(--x-primary)' : '1px solid var(--x-border)',
                  borderRadius: 8,
                  background: isArchived ? 'var(--x-alt)' : 'var(--x-panel)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 15 }}>{src.name}</strong>
                      <span className="x-badge" style={{ fontSize: 11, background: 'var(--x-tint)', color: 'var(--x-primary)' }}>
                        {s.sources.kinds[src.kind]}
                      </span>
                      <span
                        className="x-badge"
                        style={{
                          fontSize: 11,
                          background: isArchived ? 'var(--x-red-bg)' : 'var(--x-green-bg)',
                          color: isArchived ? 'var(--x-red)' : 'var(--x-green)',
                        }}
                      >
                        {isArchived ? s.sources.statusArchived : s.sources.statusActive}
                      </span>
                      <span className="x-badge" style={{ fontSize: 11, background: 'var(--x-alt)', color: 'var(--x-muted)' }}>
                        v{src.version}
                      </span>
                    </div>

                    <div style={{ fontSize: 12, color: 'var(--x-muted)', marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <span>
                        <strong>{s.sources.publishedRevision}:</strong>{' '}
                        {src.publishedRevisionId ? (
                          <span style={{ color: 'var(--x-green)', fontWeight: 600 }}>{src.publishedRevisionId}</span>
                        ) : (
                          <span style={{ color: 'var(--x-amber)' }}>{s.sources.noPublished}</span>
                        )}
                      </span>
                      {src.draftRevisionId && (
                        <span>
                          <strong>{s.sources.draftRevision}:</strong> {src.draftRevisionId}
                        </span>
                      )}
                      <span>
                        <strong>{s.sources.revisionsCount}:</strong> {src.revisionCount}
                      </span>
                      <span>
                        <strong>{s.sources.allowedRoles}:</strong>{' '}
                        {src.allowedRoles.map(r => s.roles[r]).join(', ')}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          data-testid={`edit-source-roles-btn-${src.id}`}
                          className="x-btn x-btn-secondary"
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => {
                            if (editingSourceRolesId === src.id) {
                              setEditingSourceRolesId(null)
                            } else {
                              setEditingSourceRolesId(src.id)
                              setEditingRoles([...src.allowedRoles])
                            }
                          }}
                        >
                          <Edit3 size={11} />
                          <span>{s.sources.editRoles}</span>
                        </button>
                      )}
                    </div>

                    {editingSourceRolesId === src.id && (
                      <div
                        data-testid={`edit-source-roles-form-${src.id}`}
                        style={{ marginTop: 10, padding: 10, background: 'var(--x-alt)', borderRadius: 6, border: '1px solid var(--x-border)' }}
                      >
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{s.sources.editRoles}:</div>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
                          {(['admin', 'staff', 'customer', 'guest'] as SupportEvidenceRole[]).map(role => (
                            <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                data-testid={`edit-role-${role}-${src.id}`}
                                checked={editingRoles.includes(role)}
                                onChange={e => {
                                  if (e.target.checked) {
                                    setEditingRoles(prev => Array.from(new Set([...prev, role])))
                                  } else {
                                    const updated = editingRoles.filter(r => r !== role)
                                    setEditingRoles(updated.length > 0 ? updated : ['admin'])
                                  }
                                }}
                              />
                              <span>{s.roles[role]}</span>
                            </label>
                          ))}
                        </div>
                        {updateSourceMutation.isError && (
                          <div
                            className="x-alert x-alert-error"
                            role="alert"
                            data-testid={`edit-source-roles-error-${src.id}`}
                            style={{ marginBottom: 8, fontSize: 12, padding: '4px 8px' }}
                          >
                            <span>{(updateSourceMutation.error as Error).message}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            data-testid={`save-source-roles-btn-${src.id}`}
                            className="x-btn x-btn-primary"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            disabled={updateSourceMutation.isPending}
                            onClick={() =>
                              updateSourceMutation.mutate({
                                sourceId: src.id,
                                expectedVersion: src.version,
                                allowedRoles: editingRoles,
                              })
                            }
                          >
                            <span>{updateSourceMutation.isPending ? s.loading : s.sources.saveRoles}</span>
                          </button>
                          <button
                            type="button"
                            data-testid={`cancel-source-roles-btn-${src.id}`}
                            className="x-btn x-btn-secondary"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            onClick={() => setEditingSourceRolesId(null)}
                          >
                            <span>{s.sources.cancelEditRoles}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      data-testid={`select-source-btn-${src.id}`}
                      className={`x-btn ${isSelected ? 'x-btn-primary' : 'x-btn-secondary'}`}
                      onClick={() => setSelectedSourceId(isSelected ? null : src.id)}
                    >
                      <FileText size={14} />
                      <span>{isSelected ? s.cancel : s.sources.revisionsHeading}</span>
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        data-testid={`archive-source-btn-${src.id}`}
                        className="x-btn x-btn-secondary"
                        title={isArchived ? s.sources.unarchive : s.sources.archiveConfirm}
                        onClick={() =>
                          updateSourceMutation.mutate({
                            sourceId: src.id,
                            expectedVersion: src.version,
                            status: isArchived ? 'active' : 'archived',
                          })
                        }
                      >
                        <Archive size={14} />
                        <span>{isArchived ? s.sources.unarchive : s.sources.archive}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Selected Source Revisions & Import Area */}
                {isSelected && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--x-border)' }}>
                    <h4 style={{ fontSize: 14, margin: '0 0 10px 0' }}>{s.sources.revisionsHeading}</h4>
                    {revisionsQuery.isPending && <div className="x-loading">{s.loading}</div>}
                    {revisionsQuery.isError && (
                      <div className="x-alert x-alert-error" role="alert">
                        <XCircle size={16} />
                        <span>{(revisionsQuery.error as Error).message}</span>
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                      {(revisionsQuery.data || []).map(rev => {
                        const isCurrentPublished = src.publishedRevisionId === rev.id
                        const isViewing = viewingRevisionContent?.id === rev.id
                        return (
                          <div
                            key={rev.id}
                            data-testid={`revision-row-${rev.id}`}
                            style={{
                              padding: 10,
                              background: isCurrentPublished ? 'var(--x-green-bg)' : 'var(--x-alt)',
                              border: isCurrentPublished
                                ? '1px solid color-mix(in srgb, var(--x-green) 45%, var(--x-border))'
                                : '1px solid var(--x-border)',
                              borderRadius: 6,
                              fontSize: 12,
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                              <div>
                                <strong style={{ fontSize: 13 }}>{rev.title}</strong>{' '}
                                <span style={{ color: 'var(--x-muted)' }}>({rev.id})</span>
                                {isCurrentPublished && (
                                  <span className="x-badge" style={{ marginLeft: 8, background: 'var(--x-green)', color: 'var(--x-on-primary)', fontSize: 10 }}>
                                    {s.sources.publishedRevision}
                                  </span>
                                )}
                                <div style={{ color: 'var(--x-muted)', marginTop: 4 }}>
                                  <span>{rev.chunkCount} {s.sources.chunksCount}</span>
                                  {rev.category && <span> • {rev.category}</span>}
                                  {rev.tags?.length > 0 && <span> • Tags: {rev.tags.join(', ')}</span>}
                                  <span> • {new Date(rev.createdAt).toLocaleString()}</span>
                                </div>
                              </div>

                              <div style={{ display: 'flex', gap: 6 }}>
                                <button
                                  type="button"
                                  data-testid={`view-revision-btn-${rev.id}`}
                                  className="x-btn x-btn-secondary"
                                  style={{ padding: '4px 8px', fontSize: 11 }}
                                  onClick={() => void handleViewRevision(rev.id)}
                                >
                                  {isViewing ? <EyeOff size={13} /> : <Eye size={13} />}
                                  <span>{isViewing ? s.sources.hideContent : s.sources.viewContent}</span>
                                </button>
                                {canEdit && !isCurrentPublished && (
                                  <button
                                    type="button"
                                    data-testid={`publish-revision-btn-${rev.id}`}
                                    className="x-btn x-btn-primary"
                                    style={{ padding: '4px 8px', fontSize: 11 }}
                                    disabled={publishRevisionMutation.isPending}
                                    onClick={() =>
                                      publishRevisionMutation.mutate({
                                        sourceId: src.id,
                                        expectedVersion: src.version,
                                        revisionId: rev.id,
                                      })
                                    }
                                  >
                                    <CheckCircle2 size={13} />
                                    <span>
                                      {src.publishedRevisionId ? s.sources.publishRollbackBtn : s.sources.publishBtn}
                                    </span>
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Decrypted content viewer */}
                            {isViewing && (
                              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--x-border)' }}>
                                <pre
                                  data-testid={`revision-content-view-${rev.id}`}
                                  style={{
                                    background: 'var(--x-bg)',
                                    color: 'var(--x-text)',
                                    padding: 10,
                                    borderRadius: 4,
                                    maxHeight: 200,
                                    overflowY: 'auto',
                                    fontSize: 11,
                                  }}
                                >
                                  <code>{viewingRevisionContent.content}</code>
                                </pre>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>

                    {/* Import Draft Revision Form */}
                    {canEdit && (
                      <div style={{ background: 'var(--x-alt)', padding: 12, borderRadius: 6 }}>
                        <h5 style={{ margin: '0 0 10px 0', fontSize: 13 }}>{s.sources.newDraftRevision}</h5>

                        {importNotice && (
                          <div className="x-alert x-alert-success" role="status" style={{ marginBottom: 10, padding: 8, fontSize: 12 }}>
                            <CheckCircle2 size={15} />
                            <span>{importNotice}</span>
                          </div>
                        )}
                        {importClientError && (
                          <div className="x-alert x-alert-error" role="alert" style={{ marginBottom: 10, padding: 8, fontSize: 12 }}>
                            <XCircle size={15} />
                            <span>{importClientError}</span>
                          </div>
                        )}
                        {importRevisionMutation.isError && (
                          <div className="x-alert x-alert-error" role="alert" style={{ marginBottom: 10, padding: 8, fontSize: 12 }}>
                            <XCircle size={15} />
                            <span>{(importRevisionMutation.error as Error).message}</span>
                          </div>
                        )}

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
                          <div className="x-field">
                            <label style={{ fontSize: 12 }}>{s.sources.revisionTitle}</label>
                            <input
                              data-testid="revision-title-input"
                              type="text"
                              className="x-input"
                              value={revTitle}
                              onChange={e => setRevTitle(e.target.value)}
                            />
                          </div>
                          <div className="x-field">
                            <label style={{ fontSize: 12 }}>{s.sources.category}</label>
                            <input
                              data-testid="revision-category-input"
                              type="text"
                              className="x-input"
                              value={revCategory}
                              onChange={e => setRevCategory(e.target.value)}
                            />
                          </div>
                          <div className="x-field">
                            <label style={{ fontSize: 12 }}>{s.sources.tags}</label>
                            <input
                              data-testid="revision-tags-input"
                              type="text"
                              className="x-input"
                              placeholder="policy, faq"
                              value={revTags}
                              onChange={e => setRevTags(e.target.value)}
                            />
                          </div>
                        </div>

                        {src.kind === 'url' ? (
                          <>
                            <div className="x-field" style={{ marginBottom: 10 }}>
                              <label htmlFor="rev-url-format" style={{ fontSize: 12 }}>
                                <strong>{s.sources.format}</strong>
                              </label>
                              <select
                                id="rev-url-format"
                                data-testid="revision-format-select"
                                className="x-select"
                                value={revUrlFormat}
                                onChange={e => setRevUrlFormat(e.target.value as SupportEvidenceFormat)}
                              >
                                <option value="text">{s.sources.kinds.text}</option>
                                <option value="markdown">{s.sources.kinds.markdown}</option>
                                <option value="faq_json">{s.sources.kinds.faq_json}</option>
                              </select>
                            </div>
                            <div className="x-field" style={{ marginBottom: 10 }}>
                              <label style={{ fontSize: 12 }}>{s.sources.url}</label>
                              <input
                                data-testid="revision-url-input"
                                type="url"
                                className="x-input"
                                placeholder="https://example.com/export.txt"
                                value={revUrl}
                                onChange={e => setRevUrl(e.target.value)}
                              />
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="x-field" style={{ marginBottom: 10 }}>
                              <label style={{ fontSize: 12 }}>{s.sources.content}</label>
                              <textarea
                                data-testid="revision-content-input"
                                className="x-input"
                                rows={4}
                                value={revContent}
                                onChange={e => setRevContent(e.target.value)}
                                style={{ fontFamily: 'monospace', fontSize: 12 }}
                              />
                            </div>
                            <div className="x-field" style={{ marginBottom: 10 }}>
                              <label style={{ fontSize: 12 }}>{s.sources.fileUpload}</label>
                              <input
                                data-testid="revision-file-input"
                                type="file"
                                accept=".txt,.md,.json"
                                onChange={handleFileUpload}
                                style={{ fontSize: 12 }}
                              />
                            </div>
                          </>
                        )}

                        <button
                          type="button"
                          data-testid="import-revision-btn"
                          className="x-btn x-btn-primary"
                          disabled={importRevisionMutation.isPending}
                          onClick={handleImportSubmit}
                        >
                          <Upload size={14} />
                          <span>{importRevisionMutation.isPending ? s.sources.importing : s.sources.importBtn}</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Tab 2: Preview Panel
// ---------------------------------------------------------
function PreviewPanel({ tenantBase }: { tenantBase: string }) {
  const s = useSupportEvidenceStrings()
  const [query, setQuery] = useState('')
  const [role, setRole] = useState<SupportEvidenceRole>('customer')

  interface PreviewCandidate {
    id?: string
    citationId?: string
    sourceId: string
    revisionId: string
    chunkId?: string
    title: string
    startLine: number
    endLine: number
    excerpt?: string
    providedText?: string
    lexicalCoverage: number
    score: number
  }

  interface PreviewResult {
    snapshotId: string
    policyVersion: number
    contextChars: number
    willAbstain: boolean
    candidates: PreviewCandidate[]
  }

  const previewMutation = useMutation({
    mutationFn: (args: { query: string; role: SupportEvidenceRole }) =>
      apiFetch<{ ok: boolean; preview: PreviewResult }>(`${tenantBase}/preview`, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
  })

  const preview = previewMutation.data?.preview || null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Simulation Callout */}
      <div className="x-alert x-alert-warning" role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <Eye size={18} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: 13, lineHeight: 1.5 }}>{s.preview.description}</span>
      </div>

      <div className="x-card" style={{ padding: 16, background: 'var(--x-alt)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <div className="x-field">
            <label htmlFor="preview-query">
              <strong>{s.preview.queryLabel}</strong>
            </label>
            <input
              id="preview-query"
              data-testid="preview-query-input"
              type="text"
              maxLength={500}
              className="x-input"
              placeholder={s.preview.queryPlaceholder}
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <div className="x-field">
            <label htmlFor="preview-role">
              <strong>{s.preview.roleLabel}</strong>
            </label>
            <select
              id="preview-role"
              data-testid="preview-role-select"
              className="x-select"
              value={role}
              onChange={e => setRole(e.target.value as SupportEvidenceRole)}
              style={{ minWidth: 140 }}
            >
              {(['guest', 'customer', 'staff', 'admin'] as SupportEvidenceRole[]).map(r => (
                <option key={r} value={r}>
                  {s.roles[r]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          type="button"
          data-testid="run-preview-btn"
          className="x-btn x-btn-primary"
          disabled={!query.trim() || previewMutation.isPending}
          onClick={() => previewMutation.mutate({ query: query.trim(), role })}
        >
          <Play size={15} />
          <span>{previewMutation.isPending ? s.preview.running : s.preview.runPreviewBtn}</span>
        </button>
      </div>

      {previewMutation.isError && (
        <div className="x-alert x-alert-error" role="alert">
          <XCircle size={18} />
          <span>{(previewMutation.error as Error).message}</span>
        </div>
      )}

      {/* Results View */}
      {preview && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="x-card" style={{ padding: 14, background: 'var(--x-panel)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, fontSize: 13 }}>
              <div>
                <strong style={{ color: 'var(--x-muted)', fontSize: 11, textTransform: 'uppercase' }}>{s.preview.snapshotId}</strong>
                <div data-testid="preview-snapshot-id" style={{ fontFamily: 'monospace', fontWeight: 600 }}>
                  {preview.snapshotId?.slice(0, 16)}…
                </div>
              </div>
              <div>
                <strong style={{ color: 'var(--x-muted)', fontSize: 11, textTransform: 'uppercase' }}>{s.preview.policyVersion}</strong>
                <div data-testid="preview-policy-version" style={{ fontWeight: 600 }}>
                  v{preview.policyVersion}
                </div>
              </div>
              <div>
                <strong style={{ color: 'var(--x-muted)', fontSize: 11, textTransform: 'uppercase' }}>{s.preview.contextChars}</strong>
                <div data-testid="preview-context-chars" style={{ fontWeight: 600 }}>
                  {preview.contextChars}
                </div>
              </div>
              <div>
                <strong style={{ color: 'var(--x-muted)', fontSize: 11, textTransform: 'uppercase' }}>{s.preview.willAbstain}</strong>
                <div
                  data-testid="preview-will-abstain"
                  style={{
                    fontWeight: 600,
                    color: preview.willAbstain ? 'var(--x-red)' : 'var(--x-green)',
                  }}
                >
                  {preview.willAbstain ? s.preview.willAbstainYes : s.preview.willAbstainNo}
                </div>
              </div>
            </div>
          </div>

          <div>
            <h4 style={{ fontSize: 14, margin: '0 0 10px 0' }}>{s.preview.candidatesHeading}</h4>
            {preview.candidates.length === 0 ? (
              <div className="x-empty" data-testid="preview-candidates-empty">
                <p>{s.preview.noCandidates}</p>
              </div>
            ) : (
              <div data-testid="preview-candidates-list" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {preview.candidates.map((cand, idx) => (
                  <div
                    key={cand.citationId || idx}
                    data-testid="preview-candidate-card"
                    className="x-card"
                    style={{ padding: 12, border: '1px solid var(--x-border)', borderRadius: 8, background: 'var(--x-panel)' }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <strong style={{ fontSize: 13 }}>
                        [{idx + 1}] {cand.title}
                      </strong>
                      <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                        <span data-testid="candidate-lexical-coverage" style={{ color: 'var(--x-primary)', fontWeight: 600 }}>
                          {s.preview.lexicalCoverage}: {(cand.lexicalCoverage * 100).toFixed(0)}%
                        </span>
                        <span data-testid="candidate-lexical-score" style={{ color: 'var(--x-green)', fontWeight: 600 }}>
                          {s.preview.lexicalScore}: {cand.score.toFixed(2)}
                        </span>
                        <span style={{ color: 'var(--x-muted)' }}>
                          {s.preview.lines} {cand.startLine}-{cand.endLine}
                        </span>
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: 12, color: 'var(--x-muted)', fontStyle: 'italic', background: 'var(--x-alt)', padding: 8, borderRadius: 4 }}>
                      "{cand.excerpt || cand.providedText || ''}"
                    </p>
                  </div>
                ))}
              </div>
            )}
            <small className="x-hint" style={{ display: 'block', marginTop: 10 }}>
              {s.preview.disclaimer}
            </small>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------
// Tab 3: Policy Panel
// ---------------------------------------------------------
function PolicyPanel({
  tenantBase,
  queryKey,
  canEdit,
}: {
  tenantBase: string
  queryKey: readonly unknown[]
  canEdit: boolean
}) {
  const s = useSupportEvidenceStrings()
  const queryClient = useQueryClient()

  const policyQuery = useQuery({
    queryKey: [...queryKey, 'policy'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; policy: SupportEvidencePolicy }>(`${tenantBase}/policy`, { signal }).then(
        r => r.policy || DEFAULT_POLICY
      ),
  })

  const [formPolicy, setFormPolicy] = useState<SupportEvidencePolicy | null>(null)
  const [conflictOccurred, setConflictOccurred] = useState(false)

  // Sync state once query data arrives
  const currentPolicy = policyQuery.data || DEFAULT_POLICY
  const activePolicy = formPolicy || currentPolicy

  const saveMutation = useMutation({
    mutationFn: (policy: SupportEvidencePolicy) =>
      apiFetch<{ ok: boolean; policy: SupportEvidencePolicy }>(`${tenantBase}/policy`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: policy.version,
          mode: policy.mode,
          includeLegacyDocs: policy.includeLegacyDocs,
          topK: policy.topK,
          minCoverage: policy.minCoverage,
          maxEvidenceChars: policy.maxEvidenceChars,
        }),
      }),
    onSuccess: data => {
      setConflictOccurred(false)
      if (data && data.policy) setFormPolicy(data.policy)
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'policy'] })
    },
    onError: (err: unknown) => {
      const errorObj = err as { status?: number; message?: string } | undefined
      if (errorObj?.status === 409 || errorObj?.message?.includes('409') || errorObj?.message?.includes('conflict')) {
        setConflictOccurred(true)
      }
    },
  })

  if (policyQuery.isPending) {
    return <div className="x-loading">{s.loading}</div>
  }

  if (policyQuery.isError) {
    return (
      <div className="x-alert x-alert-error" role="alert">
        <XCircle size={18} />
        <span>{(policyQuery.error as Error).message}</span>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Feedback
        error={saveMutation.error as Error | null}
        success={saveMutation.isSuccess && !conflictOccurred}
        conflict={conflictOccurred}
      />

      <div className="x-card" style={{ padding: 16, background: 'var(--x-panel)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
        {/* Mode selector */}
        <div className="x-field" style={{ marginBottom: 16 }}>
          <label htmlFor="policy-mode-select">
            <strong>{s.policy.modeLabel}</strong>
          </label>
          <select
            id="policy-mode-select"
            data-testid="policy-mode-select"
            className="x-select"
            disabled={!canEdit || conflictOccurred}
            value={activePolicy.mode}
            onChange={e =>
              setFormPolicy(prev => ({
                ...(prev || currentPolicy),
                mode: e.target.value as 'off' | 'required',
              }))
            }
            style={{ maxWidth: 300, marginTop: 4 }}
          >
            <option value="off">{s.policy.modeOff}</option>
            <option value="required">{s.policy.modeRequired}</option>
          </select>
          <p className="x-hint" style={{ marginTop: 6, fontSize: 13 }}>
            {activePolicy.mode === 'required' ? s.policy.modeRequiredDesc : s.policy.modeOffDesc}
          </p>
        </div>

        {/* Legacy Docs Checkbox */}
        <div className="x-field" style={{ marginBottom: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              data-testid="policy-legacy-checkbox"
              disabled={!canEdit || conflictOccurred}
              checked={activePolicy.includeLegacyDocs}
              onChange={e =>
                setFormPolicy(prev => ({
                  ...(prev || currentPolicy),
                  includeLegacyDocs: e.target.checked,
                }))
              }
            />
            <strong>{s.policy.includeLegacyDocs}</strong>
          </label>
          <small className="x-hint">{s.policy.includeLegacyDocsDesc}</small>
        </div>

        {/* Tuning numbers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 16 }}>
          <div className="x-field">
            <label htmlFor="policy-topk">
              <strong>{s.policy.topKLabel}</strong>
            </label>
            <input
              id="policy-topk"
              data-testid="policy-topk-input"
              type="number"
              min={1}
              max={5}
              disabled={!canEdit || conflictOccurred}
              className="x-input"
              value={activePolicy.topK}
              onChange={e =>
                setFormPolicy(prev => ({
                  ...(prev || currentPolicy),
                  topK: Math.max(1, Math.min(5, parseInt(e.target.value, 10) || 1)),
                }))
              }
            />
            <small className="x-hint">{s.policy.topKHelp}</small>
          </div>

          <div className="x-field">
            <label htmlFor="policy-min-coverage">
              <strong>{s.policy.minCoverageLabel}</strong>
            </label>
            <input
              id="policy-min-coverage"
              data-testid="policy-min-coverage-input"
              type="number"
              step={0.05}
              min={0}
              max={1}
              disabled={!canEdit || conflictOccurred}
              className="x-input"
              value={activePolicy.minCoverage}
              onChange={e =>
                setFormPolicy(prev => ({
                  ...(prev || currentPolicy),
                  minCoverage: Math.max(0, Math.min(1, parseFloat(e.target.value) || 0)),
                }))
              }
            />
            <small className="x-hint">{s.policy.minCoverageHelp}</small>
          </div>

          <div className="x-field">
            <label htmlFor="policy-max-chars">
              <strong>{s.policy.maxEvidenceCharsLabel}</strong>
            </label>
            <input
              id="policy-max-chars"
              data-testid="policy-max-chars-input"
              type="number"
              step={500}
              min={1000}
              max={12000}
              disabled={!canEdit || conflictOccurred}
              className="x-input"
              value={activePolicy.maxEvidenceChars}
              onChange={e =>
                setFormPolicy(prev => ({
                  ...(prev || currentPolicy),
                  maxEvidenceChars: Math.max(1000, Math.min(12000, parseInt(e.target.value, 10) || 1000)),
                }))
              }
            />
            <small className="x-hint">{s.policy.maxEvidenceCharsHelp}</small>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--x-muted)' }}>
            {s.policy.versionLabel}: <strong data-testid="policy-version">v{activePolicy.version}</strong>
          </span>

          <div style={{ display: 'flex', gap: 8 }}>
            {conflictOccurred && (
              <button
                type="button"
                className="x-btn x-btn-secondary"
                onClick={() => {
                  setConflictOccurred(false)
                  setFormPolicy(null)
                  void policyQuery.refetch()
                }}
              >
                <RotateCcw size={14} />
                <span>{s.refresh}</span>
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                data-testid="save-policy-btn"
                className="x-btn x-btn-primary"
                disabled={saveMutation.isPending || conflictOccurred}
                onClick={() => saveMutation.mutate(activePolicy)}
              >
                <CheckCircle2 size={15} />
                <span>{saveMutation.isPending ? s.policy.saving : s.policy.savePolicyBtn}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function generateNextCaseId(cases: SupportEvidenceCase[]): string {
  let candidateNum = cases.length + 1
  while (cases.some(c => c.id === `case_${candidateNum}`)) {
    candidateNum++
  }
  return `case_${candidateNum}`
}

// ---------------------------------------------------------
// Tab 4: Evaluations Panel
// ---------------------------------------------------------
function EvaluationsPanel({
  tenantBase,
  queryKey,
  canEdit,
}: {
  tenantBase: string
  queryKey: readonly unknown[]
  canEdit: boolean
}) {
  const s = useSupportEvidenceStrings()
  const queryClient = useQueryClient()

  // Suites query
  const suitesQuery = useQuery({
    queryKey: [...queryKey, 'suites'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; suites: SupportEvidenceSuite[] }>(`${tenantBase}/suites`, { signal }).then(
        r => r.suites || []
      ),
  })

  // Runs query
  const runsQuery = useQuery({
    queryKey: [...queryKey, 'runs'],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; runs: SupportEvidenceRun[] }>(`${tenantBase}/runs`, { signal }).then(
        r => r.runs || []
      ),
  })

  // Suite editor state
  const [editingSuiteId, setEditingSuiteId] = useState<string | null>(null)
  const [editingSuiteVersion, setEditingSuiteVersion] = useState<number | null>(null)
  const [editingSuiteName, setEditingSuiteName] = useState('')
  const [editingCases, setEditingCases] = useState<SupportEvidenceCase[]>([
    {
      id: 'case_1',
      query: '',
      role: 'customer',
      expectedSourceIds: [],
      forbiddenSourceIds: [],
      expectAbstention: false,
    },
  ])
  const [suiteError, setSuiteError] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<SupportEvidenceRun | null>(null)

  function resetSuiteEditor() {
    setEditingSuiteId(null)
    setEditingSuiteVersion(null)
    setEditingSuiteName('')
    setEditingCases([
      {
        id: 'case_1',
        query: '',
        role: 'customer',
        expectedSourceIds: [],
        forbiddenSourceIds: [],
        expectAbstention: false,
      },
    ])
    setSuiteError(null)
  }

  function loadSuiteForEdit(suite: SupportEvidenceSuite) {
    setEditingSuiteId(suite.id)
    setEditingSuiteVersion(suite.version)
    setEditingSuiteName(suite.name)
    setEditingCases(
      suite.cases.map(c => ({
        ...c,
        expectedSourceIds: [...c.expectedSourceIds],
        forbiddenSourceIds: [...c.forbiddenSourceIds],
      }))
    )
    setSuiteError(null)
  }

  // Mutations
  const saveSuiteMutation = useMutation({
    mutationFn: (args: { name: string; cases: SupportEvidenceCase[] }) =>
      apiFetch<{ ok: boolean; suite: SupportEvidenceSuite }>(`${tenantBase}/suites`, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    onSuccess: () => {
      resetSuiteEditor()
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'suites'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : s.error
      setSuiteError(msg)
    },
  })

  const updateSuiteMutation = useMutation({
    mutationFn: (args: { suiteId: string; expectedVersion: number; name: string; cases: SupportEvidenceCase[] }) =>
      apiFetch<{ ok: boolean; suite: SupportEvidenceSuite }>(`${tenantBase}/suites/${args.suiteId}`, {
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: args.expectedVersion,
          name: args.name,
          cases: args.cases,
        }),
      }),
    onSuccess: () => {
      resetSuiteEditor()
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'suites'] })
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : s.error
      setSuiteError(msg)
    },
  })

  const runSuiteMutation = useMutation({
    mutationFn: (suiteId: string) =>
      apiFetch<{ ok: boolean; run: SupportEvidenceRun }>(`${tenantBase}/suites/${suiteId}/runs`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: data => {
      if (data && data.run) setSelectedRun(data.run)
      queryClient.invalidateQueries({ queryKey: [...queryKey, 'runs'] })
    },
  })

  function handleAddCase() {
    if (editingCases.length >= 50) return
    const newId = generateNextCaseId(editingCases)
    setEditingCases(prev => [
      ...prev,
      {
        id: newId,
        query: '',
        role: 'customer',
        expectedSourceIds: [],
        forbiddenSourceIds: [],
        expectAbstention: false,
      },
    ])
  }

  function handleRemoveCase(index: number) {
    setEditingCases(prev => prev.filter((_, i) => i !== index))
  }

  function handleSaveSuite() {
    setSuiteError(null)
    if (!editingSuiteName.trim()) {
      setSuiteError(s.requiredField.replace('{field}', s.evaluations.suiteName))
      return
    }
    if (editingCases.length === 0) {
      setSuiteError(s.evaluations.oneCaseRequired)
      return
    }

    // Check disjoint expected vs forbidden IDs
    for (const c of editingCases) {
      const overlap = c.expectedSourceIds.filter(id => c.forbiddenSourceIds.includes(id))
      if (overlap.length > 0) {
        setSuiteError(s.evaluations.disjointValidation + ` (${s.evaluations.caseId}: ${c.id})`)
        return
      }
    }

    if (editingSuiteId && editingSuiteVersion !== null) {
      updateSuiteMutation.mutate({
        suiteId: editingSuiteId,
        expectedVersion: editingSuiteVersion,
        name: editingSuiteName.trim(),
        cases: editingCases,
      })
    } else {
      saveSuiteMutation.mutate({
        name: editingSuiteName.trim(),
        cases: editingCases,
      })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Intro notice */}
      <div className="x-alert x-alert-info" role="status" style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <CheckCircle2 size={18} style={{ flexShrink: 0, marginTop: 2 }} />
        <span style={{ fontSize: 13, lineHeight: 1.5 }}>{s.evaluations.description}</span>
      </div>

      {/* Suite Creator / Editor */}
      {canEdit && (
        <div className="x-card" style={{ padding: 16, background: 'var(--x-alt)', border: '1px solid var(--x-border)', borderRadius: 8 }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: 15 }}>
            {editingSuiteId ? `${s.evaluations.editSuite} (v${editingSuiteVersion})` : s.evaluations.newSuite}
          </h3>

          {(suiteError || updateSuiteMutation.isError || saveSuiteMutation.isError) && (
            <div className="x-alert x-alert-error" role="alert" data-testid="suite-disjoint-warning" style={{ marginBottom: 12 }}>
              <XCircle size={16} />
              <span>
                {suiteError ||
                  (updateSuiteMutation.error as Error)?.message ||
                  (saveSuiteMutation.error as Error)?.message}
              </span>
            </div>
          )}

          <div className="x-field" style={{ marginBottom: 14 }}>
            <label htmlFor="suite-name">
              <strong>{s.evaluations.suiteName}</strong>
            </label>
            <input
              id="suite-name"
              data-testid="suite-name-input"
              type="text"
              className="x-input"
              placeholder="e.g. Core FAQ Retrieval Regression"
              value={editingSuiteName}
              onChange={e => setEditingSuiteName(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h4 style={{ fontSize: 13, margin: 0 }}>
                {s.evaluations.casesHeading} ({editingCases.length})
              </h4>
              <button
                type="button"
                data-testid="add-case-btn"
                className="x-btn x-btn-secondary"
                style={{ padding: '4px 8px', fontSize: 11 }}
                onClick={handleAddCase}
              >
                <Plus size={13} />
                <span>{s.evaluations.addCase}</span>
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {editingCases.map((c, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: 10,
                    background: 'var(--x-panel)',
                    border: '1px solid var(--x-border)',
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 120px auto', gap: 8, marginBottom: 8 }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--x-muted)' }}>{s.evaluations.caseId}</label>
                      <input
                        data-testid={`case-id-input-${idx}`}
                        type="text"
                        className="x-input"
                        value={c.id}
                        onChange={e => {
                          const val = e.target.value
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, id: val } : item)))
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--x-muted)' }}>{s.evaluations.caseQuery}</label>
                      <input
                        data-testid={`case-query-input-${idx}`}
                        type="text"
                        className="x-input"
                        value={c.query}
                        onChange={e => {
                          const val = e.target.value
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, query: val } : item)))
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--x-muted)' }}>{s.evaluations.caseRole}</label>
                      <select
                        data-testid={`case-role-select-${idx}`}
                        className="x-select"
                        value={c.role}
                        onChange={e => {
                          const val = e.target.value as SupportEvidenceRole
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, role: val } : item)))
                        }}
                      >
                        {(['guest', 'customer', 'staff', 'admin'] as SupportEvidenceRole[]).map(r => (
                          <option key={r} value={r}>
                            {s.roles[r]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      {editingCases.length > 1 && (
                        <button
                          type="button"
                          data-testid={`remove-case-btn-${idx}`}
                          className="x-btn x-btn-secondary"
                          style={{ padding: '6px 8px' }}
                          onClick={() => handleRemoveCase(idx)}
                        >
                          <Trash2 size={13} color="var(--x-red)" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'center' }}>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--x-muted)' }}>{s.evaluations.expectedSources}</label>
                      <input
                        data-testid={`case-expected-input-${idx}`}
                        type="text"
                        className="x-input"
                        placeholder="src_1, src_2"
                        value={c.expectedSourceIds.join(', ')}
                        onChange={e => {
                          const ids = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, expectedSourceIds: ids } : item)))
                        }}
                      />
                    </div>
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--x-muted)' }}>{s.evaluations.forbiddenSources}</label>
                      <input
                        data-testid={`case-forbidden-input-${idx}`}
                        type="text"
                        className="x-input"
                        placeholder="src_admin"
                        value={c.forbiddenSourceIds.join(', ')}
                        onChange={e => {
                          const ids = e.target.value.split(',').map(s => s.trim()).filter(Boolean)
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, forbiddenSourceIds: ids } : item)))
                        }}
                      />
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginTop: 16 }}>
                      <input
                        type="checkbox"
                        data-testid={`case-abstain-checkbox-${idx}`}
                        checked={c.expectAbstention}
                        onChange={e => {
                          const val = e.target.checked
                          setEditingCases(prev => prev.map((item, i) => (i === idx ? { ...item, expectAbstention: val } : item)))
                        }}
                      />
                      <span>{s.evaluations.expectAbstention}</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              data-testid="save-suite-btn"
              className="x-btn x-btn-primary"
              disabled={saveSuiteMutation.isPending || updateSuiteMutation.isPending}
              onClick={handleSaveSuite}
            >
              <CheckCircle2 size={14} />
              <span>
                {editingSuiteId
                  ? (updateSuiteMutation.isPending ? s.evaluations.savingSuite : s.evaluations.updateSuite)
                  : (saveSuiteMutation.isPending ? s.evaluations.savingSuite : s.evaluations.saveSuiteBtn)}
              </span>
            </button>
            {editingSuiteId && (
              <button
                type="button"
                data-testid="cancel-edit-suite-btn"
                className="x-btn x-btn-secondary"
                onClick={resetSuiteEditor}
              >
                <span>{s.evaluations.cancelEdit}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Suites List */}
      <div>
        <h3 style={{ fontSize: 15, margin: '0 0 10px 0' }}>{s.evaluations.suitesHeading}</h3>
        {suitesQuery.isPending && <div className="x-loading">{s.loading}</div>}
        {suitesQuery.isError && (
          <div className="x-alert x-alert-error" role="alert">
            <XCircle size={16} />
            <span>{(suitesQuery.error as Error).message}</span>
          </div>
        )}
        {!suitesQuery.isPending && (suitesQuery.data || []).length === 0 && (
          <div className="x-empty" data-testid="suites-empty">
            <p>{s.evaluations.noSuites}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(suitesQuery.data || []).map(suite => (
            <div
              key={suite.id}
              data-testid={`suite-card-${suite.id}`}
              className="x-card"
              style={{ padding: 14, border: '1px solid var(--x-border)', borderRadius: 8, background: 'var(--x-panel)' }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <strong style={{ fontSize: 14 }}>{suite.name}</strong>
                  <div style={{ fontSize: 12, color: 'var(--x-muted)', marginTop: 4 }}>
                    <span>{suite.cases.length} {s.evaluations.casesCount}</span> • <span>v{suite.version}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  {canEdit && (
                    <button
                      type="button"
                      data-testid={`edit-suite-btn-${suite.id}`}
                      className="x-btn x-btn-secondary"
                      onClick={() => loadSuiteForEdit(suite)}
                    >
                      <Edit3 size={14} />
                      <span>{s.evaluations.editSuite}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid={`run-suite-btn-${suite.id}`}
                    className="x-btn x-btn-primary"
                    disabled={runSuiteMutation.isPending}
                    onClick={() => runSuiteMutation.mutate(suite.id)}
                  >
                    <Play size={14} />
                    <span>{runSuiteMutation.isPending ? s.evaluations.runningSuite : s.evaluations.runSuiteBtn}</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Run Results View */}
      {selectedRun && (
        <div data-testid="evaluation-run-results" className="x-card" style={{ padding: 16, background: 'var(--x-panel)', border: '2px solid var(--x-primary)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h4 style={{ margin: 0, fontSize: 15 }}>Run Details ({selectedRun.id})</h4>
            <span
              data-testid="run-status"
              className="x-badge"
              style={{
                fontSize: 12,
                background:
                  selectedRun.status === 'completed'
                    ? 'var(--x-green-bg)'
                    : selectedRun.status === 'partial'
                    ? 'var(--x-amber-bg)'
                    : 'var(--x-red-bg)',
                color:
                  selectedRun.status === 'completed'
                    ? 'var(--x-green)'
                    : selectedRun.status === 'partial'
                    ? 'var(--x-amber)'
                    : 'var(--x-red)',
              }}
            >
              {selectedRun.status}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, fontSize: 12, marginBottom: 14 }}>
            <div>
              <strong style={{ color: 'var(--x-muted)' }}>{s.evaluations.allPassed}:</strong>{' '}
              <span data-testid="run-all-passed" style={{ fontWeight: 600, color: selectedRun.allPassed ? 'var(--x-green)' : 'var(--x-red)' }}>
                {selectedRun.allPassed ? 'Yes' : 'No'}
              </span>
            </div>
            <div>
              <strong style={{ color: 'var(--x-muted)' }}>{s.evaluations.casesChecked}:</strong>{' '}
              <span data-testid="run-cases-checked" style={{ fontWeight: 600 }}>
                {selectedRun.casesChecked} / {selectedRun.totalCases}
              </span>
            </div>
            <div>
              <strong style={{ color: 'var(--x-muted)' }}>{s.evaluations.hitAtK}:</strong>{' '}
              <span data-testid="run-hit-at-k" style={{ fontWeight: 600 }}>
                {selectedRun.matchedExpectedCases}/{selectedRun.expectedCasesChecked} ({(selectedRun.hitAtK * 100).toFixed(1)}%)
              </span>
            </div>
            <div>
              <strong style={{ color: 'var(--x-muted)' }}>{s.evaluations.snapshots}:</strong>{' '}
              <span data-testid="run-snapshots" style={{ fontFamily: 'monospace' }}>
                {(selectedRun.snapshotIds || []).map(s => s.slice(0, 8)).join(', ')}
              </span>
            </div>
          </div>

          <div>
            <h5 style={{ margin: '0 0 8px 0', fontSize: 13 }}>{s.evaluations.caseResults}</h5>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {selectedRun.results.map(res => (
                <div
                  key={res.caseId}
                  data-testid={`case-result-${res.caseId}`}
                  style={{
                    padding: 8,
                    background: res.passed ? 'var(--x-green-bg)' : 'var(--x-red-bg)',
                    border: res.passed
                      ? '1px solid color-mix(in srgb, var(--x-green) 45%, var(--x-border))'
                      : '1px solid color-mix(in srgb, var(--x-red) 45%, var(--x-border))',
                    borderRadius: 6,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 12,
                  }}
                >
                  <div>
                    <strong>{res.caseId}</strong> ({s.roles[res.role]})
                    <div style={{ color: 'var(--x-muted)', fontSize: 11, marginTop: 2 }}>
                      Expected hit: {res.expectedHit ? 'Yes' : 'No'} • Forbidden hits: {res.forbiddenHitCount} • Abstention matched: {res.abstentionMatched ? 'Yes' : 'No'}
                    </div>
                  </div>
                  <span
                    className="x-badge"
                    style={{
                      background: res.passed ? 'var(--x-green)' : 'var(--x-red)',
                      color: 'var(--x-on-primary)',
                      fontSize: 10,
                    }}
                  >
                    {res.passed ? s.evaluations.passed : s.evaluations.notPassed}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Recent Runs List */}
      <div>
        <h4 style={{ fontSize: 14, margin: '0 0 10px 0' }}>{s.evaluations.recentRuns}</h4>
        {runsQuery.isPending && <div className="x-loading">{s.loading}</div>}
        {!runsQuery.isPending && (runsQuery.data || []).length === 0 && (
          <div className="x-empty" data-testid="runs-empty">
            <p>{s.evaluations.noRuns}</p>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(runsQuery.data || []).map(run => (
            <div
              key={run.id}
              data-testid={`run-row-${run.id}`}
              className="x-card"
              style={{
                padding: 10,
                border: '1px solid var(--x-border)',
                borderRadius: 6,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
              }}
              onClick={() => setSelectedRun(run)}
            >
              <div>
                <strong>{run.id}</strong> • <span style={{ color: 'var(--x-muted)' }}>Suite: {run.suiteId}</span>
                <div style={{ fontSize: 11, color: 'var(--x-muted)', marginTop: 2 }}>
                  {run.casesChecked}/{run.totalCases} cases • Hit@K: {(run.hitAtK * 100).toFixed(1)}% • {new Date(run.startedAt).toLocaleString()}
                </div>
              </div>

              <span
                className="x-badge"
                style={{
                  background: run.allPassed ? 'var(--x-green)' : 'var(--x-amber)',
                  color: 'var(--x-on-primary)',
                  fontSize: 11,
                }}
              >
                {run.allPassed ? s.evaluations.allPassed : run.status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Tenant Content Container
// ---------------------------------------------------------
function TenantKnowledgeContent({
  tenant,
  revision,
  canEdit,
}: {
  tenant: SupportTenant
  revision: number
  canEdit: boolean
}) {
  const s = useSupportEvidenceStrings()
  const [activeTab, setActiveTab] = useState<TabId>('sources')

  const tenantBase = `/api/thruline/support/tenants/${tenant.id}/knowledge-library`
  const tenantKey = ['x-support-evidence', revision, tenant.id] as const

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
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={16} />
              <span>{s.tabs[tab.id]}</span>
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
        {activeTab === 'sources' && (
          <Panel title={s.sources.heading}>
            <SourcesPanel tenantBase={tenantBase} queryKey={tenantKey} canEdit={canEdit} />
          </Panel>
        )}

        {activeTab === 'preview' && (
          <Panel title={s.preview.heading}>
            <PreviewPanel tenantBase={tenantBase} />
          </Panel>
        )}

        {activeTab === 'policy' && (
          <Panel title={s.policy.heading}>
            <PolicyPanel tenantBase={tenantBase} queryKey={tenantKey} canEdit={canEdit} />
          </Panel>
        )}

        {activeTab === 'evaluations' && (
          <Panel title={s.evaluations.heading}>
            <EvaluationsPanel tenantBase={tenantBase} queryKey={tenantKey} canEdit={canEdit} />
          </Panel>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------
// Main Knowledge Studio Component
// ---------------------------------------------------------
export default function SupportKnowledgeStudio() {
  const s = useSupportEvidenceStrings()
  const revision = useSessionRevision()
  const session = useUserSession()

  const canEdit = session.hasPermission('use_x_gateway') && session.hasPermission('edit_x_settings')

  const tenantsQuery = useQuery({
    queryKey: ['x-support-evidence-tenants', revision],
    queryFn: ({ signal }) =>
      apiFetch<{ ok: boolean; tenants: SupportTenant[] }>('/api/thruline/support/tenants', { signal }).then(
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
            <BookOpen size={24} style={{ color: 'var(--x-primary)' }} />
            <span>{s.title}</span>
          </h1>
          <p className="x-hint" style={{ marginTop: 4 }}>
            {s.subtitle}
          </p>
        </div>

        {tenants.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label htmlFor="support-evidence-tenant-select" style={{ fontSize: 13, fontWeight: 500 }}>
              {s.tenant}:
            </label>
            <select
              id="support-evidence-tenant-select"
              data-testid="support-evidence-tenant"
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

      {!canEdit && (
        <div className="x-alert x-alert-warning" role="alert" data-testid="support-evidence-permission-denied">
          <ShieldCheck size={18} />
          <span>{s.permissionDenied}</span>
        </div>
      )}

      {canEdit && (
        <>
          {tenantsQuery.isPending && <div className="x-loading">{s.loading}</div>}

          {tenantsQuery.isError && (
            <div className="x-alert x-alert-error" role="alert">
              <XCircle size={18} />
              <span>{(tenantsQuery.error as Error).message}</span>
            </div>
          )}

          {!tenantsQuery.isPending && !tenantsQuery.isError && tenants.length === 0 && (
            <div className="x-empty" data-testid="support-evidence-no-tenants">
              <AlertTriangle size={32} />
              <p>{s.noTenants}</p>
            </div>
          )}

          {activeTenant && (
            <TenantKnowledgeContent
              key={`${revision}-${activeTenant.id}`}
              tenant={activeTenant}
              revision={revision}
              canEdit={canEdit}
            />
          )}
        </>
      )}
    </div>
  )
}
