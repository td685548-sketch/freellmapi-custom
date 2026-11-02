import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiKey } from '../../../shared/types'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { AddKeyDialog } from '@/components/keys/add-key-dialog'
import { EditKeyDialog } from '@/components/keys/edit-key-dialog'
import { CopyKeyDialog } from '@/components/keys/copy-key-dialog'
import { ExportKeysDialog } from '@/components/keys/export-keys-dialog'
import { ImportKeysSection } from '@/components/keys/import-keys-section'
import { BackupsSection } from '@/components/keys/backups-section'
import { PageHeader } from '@/components/page-header'
import { useUserSession } from './use-session'
import { useSessionRevision } from './session-state'
import { ScopedInstallationSections } from './ScopedInstallationSections'

export function ScopedKeysPage() {
  const { hasPermission: can, hasPermissionGroup } = useUserSession()
  const revision = useSessionRevision()
  const client = useQueryClient()
  const [addOpen, setAddOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [editing, setEditing] = useState<ApiKey | null>(null)
  const [revealing, setRevealing] = useState<ApiKey | null>(null)
  const query = useQuery({ queryKey: ['keys', 'scoped', revision], queryFn: () => apiFetch<ApiKey[]>('/api/keys'), enabled: can('view_keys'), retry: false })
  const invalidate = () => { void client.invalidateQueries({ queryKey: ['keys'] }); void client.invalidateQueries({ queryKey: ['provider-tiers'] }) }
  const remove = useMutation({ mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }), onSuccess: invalidate })
  const test = useMutation({ mutationFn: (id: number) => apiFetch(`/api/health/check/${id}`, { method: 'POST' }), onSuccess: invalidate })
  return <div className="space-y-5">
    <PageHeader title="Administration" description="Only actions granted to your account are available." actions={<>
      {can('add_keys') && <Button size="sm" onClick={() => setAddOpen(true)}>Add key</Button>}
      {can('export_keys') && <Button size="sm" variant="outline" onClick={() => setExportOpen(true)}>Export keys</Button>}
    </>} />
    {can('view_keys') ? <>
      {query.isPending && <p role="status">Loading keys…</p>}
      {query.isError && <p role="alert">Could not load keys. <Button onClick={() => void query.refetch()}>Retry</Button></p>}
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Provider', 'Label', 'Masked key', 'Status', 'Actions'].map(s => <th key={s} className="p-3 text-left">{s}</th>)}</tr></thead><tbody>
        {query.data?.map(key => <tr key={key.id} className="border-t"><td className="p-3">{key.platform}</td><td className="p-3">{key.label}</td><td className="p-3 font-mono">{key.maskedKey}</td><td className="p-3">{key.status}</td><td className="flex flex-wrap gap-2 p-3">
          {can('edit_keys') && <Button size="xs" variant="outline" onClick={() => setEditing(key)}>Edit</Button>}
          {can('reveal_keys') && <Button size="xs" variant="outline" onClick={() => setRevealing(key)}>Reveal</Button>}
          {can('test_keys') && <Button size="xs" variant="outline" disabled={test.isPending} onClick={() => test.mutate(key.id)}>Check health</Button>}
          {can('delete_keys') && <ConfirmButton size="xs" variant="destructive" disabled={remove.isPending} onConfirm={() => remove.mutate(key.id)}>Delete</ConfirmButton>}
        </td></tr>)}
      </tbody></table></div>
    </> : hasPermissionGroup('manage_keys') && <p className="text-sm text-muted-foreground">Viewing stored credentials requires View keys. You can still use your granted add/import actions.</p>}
    {can('import_keys') && <section className="rounded-2xl border p-4"><h2 className="mb-3 font-semibold">Import keys and model configuration</h2><ImportKeysSection onImported={invalidate} /></section>}
    {hasPermissionGroup('manage_backups') && <BackupsSection capabilities={{ view: can('view_backups'), create: can('create_backups'), download: can('download_backups'), restore: can('restore_backups'), delete: can('delete_backups'), schedule: can('schedule_backups') }} />}
    <ScopedInstallationSections />
    {can('add_keys') && <AddKeyDialog open={addOpen} onOpenChange={value => { setAddOpen(value); if (!value) invalidate() }} capabilities={{ view: can('view_keys'), edit: can('edit_keys'), import: can('import_keys'), models: can('manage_key_models') && can('test_keys') }} />}
    {editing && can('edit_keys') && <EditKeyDialog apiKey={editing} onOpenChange={value => { if (!value) { setEditing(null); invalidate() } }} />}
    {revealing && can('reveal_keys') && <CopyKeyDialog keyId={revealing.id} maskedKey={revealing.maskedKey} onOpenChange={value => { if (!value) setRevealing(null) }} />}
    {exportOpen && can('export_keys') && <ExportKeysDialog open={exportOpen} onOpenChange={setExportOpen} />}
  </div>
}
