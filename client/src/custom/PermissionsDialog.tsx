import { useState, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Shield, Crown, Server, Layers } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import type { AdminUser, Permission } from '../../../shared/user-access'
import { PERMISSION_GROUPS, permissionGranted } from '../../../shared/permissions'
import { useUserSession } from './use-session'
import { togglePermissionSelection } from './permission-selection'
import { useCustomT } from './i18n/use-custom-t'

interface PermissionDialogProps {
  user: AdminUser | null; open: boolean; onOpenChange: (open: boolean) => void; onSuccess: () => void
}
export function PermissionsDialog(props: PermissionDialogProps) {
  if (!props.user || !props.open) return null
  return <PermissionEditor key={`${props.user.id}:${JSON.stringify(props.user.permissions)}`} {...props} user={props.user} />
}

const isXGatewayGroup = (groupKey: string) =>
  groupKey === 'manage_x_gateway' || groupKey.startsWith('x_') || groupKey.includes('x_gateway')

function PermissionEditor({ user, open, onOpenChange, onSuccess }: Omit<PermissionDialogProps, 'user'> & { user: AdminUser }) {
  const tc = useCustomT()
  const { hasPermission } = useUserSession()
  const [selected, setSelected] = useState<Set<Permission>>(() => new Set(user.isPrimary ? ['*'] : user.permissions || []))
  const [activeTab, setActiveTab] = useState<'freellmapi' | 'x_gateway'>('freellmapi')

  const mutation = useMutation({
    mutationFn: (permissions: Permission[]) => apiFetch(`/api/admin/users/${user?.id}/permissions`, {
      method: 'PUT', body: JSON.stringify({ permissions }),
    }),
    onSuccess: () => { toast.success(tc('Permissions updated successfully')); onSuccess(); onOpenChange(false) },
  })
  const locked = user.isPrimary || user.isSelf || !hasPermission('edit_user_permissions')
  const subject = { permissions: [...selected] }
  const toggle = (key: Permission) => { if (!locked) setSelected(prev => togglePermissionSelection(prev, key)) }

  const freellmapiGroups = useMemo(() => PERMISSION_GROUPS.filter(g => !isXGatewayGroup(g.key)), [])
  const xGatewayGroups = useMemo(() => PERMISSION_GROUPS.filter(g => isXGatewayGroup(g.key)), [])
  const freellmapiKeys = useMemo(() => new Set<string>(freellmapiGroups.flatMap(g => [g.key, ...g.children.map(c => c.key)])), [freellmapiGroups])
  const xGatewayKeys = useMemo(() => new Set<string>(xGatewayGroups.flatMap(g => [g.key, ...g.children.map(c => c.key)])), [xGatewayGroups])

  let freellmapiCount = 0
  let xGatewayCount = 0
  if (selected.has('*')) {
    freellmapiCount = freellmapiKeys.size
    xGatewayCount = xGatewayKeys.size
  } else {
    for (const p of selected) {
      if (freellmapiKeys.has(p)) freellmapiCount++
      else if (xGatewayKeys.has(p)) xGatewayCount++
    }
  }

  const currentGroups = activeTab === 'freellmapi' ? freellmapiGroups : xGatewayGroups

  const selectAllInActiveTab = () => {
    if (locked) return
    const keysToAdd = currentGroups.flatMap(g =>
      hasPermission(g.key) ? [g.key] : g.children.filter(c => hasPermission(c.key)).map(c => c.key)
    )
    setSelected(prev => {
      const next = new Set(prev)
      for (const k of keysToAdd) next.add(k)
      return next
    })
  }

  const clearActiveTab = () => {
    if (locked) return
    const keysToRemove = new Set<string>(currentGroups.flatMap(g => [g.key, ...g.children.map(c => c.key)]))
    setSelected(prev => {
      const next = new Set<Permission>()
      for (const p of prev) {
        if (!keysToRemove.has(p) && p !== '*') next.add(p)
      }
      return next
    })
  }

  const renderGroup = (group: (typeof PERMISSION_GROUPS)[number]) => (
    <fieldset key={group.key} className="rounded-2xl border p-3">
      <legend className="px-1 text-sm font-semibold">{group.title}</legend>
      <label className="flex items-start gap-2 border-b pb-3 text-sm">
        <input
          type="checkbox"
          checked={permissionGranted(subject, group.key) || group.children.every(c => permissionGranted(subject, c.key))}
          disabled={locked || !hasPermission(group.key)}
          onChange={() => toggle(group.key)}
        />
        <span>
          {tc('All actions in this group')}
          <span className="block text-xs text-muted-foreground">{group.description}</span>
        </span>
      </label>
      <div className="grid gap-3 pt-3 sm:grid-cols-2">
        {group.children.map(child => (
          <label key={child.key} className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={permissionGranted(subject, child.key)}
              disabled={locked || !hasPermission(child.key)}
              onChange={() => toggle(child.key)}
            />
            <span>
              <span className="font-medium">{child.title}</span>
              <span className="mt-0.5 block text-muted-foreground">{child.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="space-y-4">
          <div className="flex items-center gap-3"><Shield className="size-5" /><div>
            <DialogTitle>{tc('User Permissions')}</DialogTitle>
            <DialogDescription>{tc('Assign actions for')}{' '}<strong>{user.email}</strong></DialogDescription>
          </div></div>
          {user.isPrimary ? <p className="flex items-center gap-2 rounded-xl border p-3 text-xs"><Crown className="size-4" />{tc('Primary Admin always has full access. Its authority cannot be changed.')}</p>
            : user.isSelf ? <p className="text-xs text-muted-foreground">{tc('You cannot change your own permissions.')}</p>
            : <p className="text-xs text-muted-foreground">{tc('Secondary Admins and Members both obey these grants. Each group grants all its child actions. Uncheck a child to narrow a group. You can grant only authority you hold. Combine View with edit/delete permissions to use list-based controls; custom model registration needs Add keys and Manage provider models.')}</p>}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={selected.has('*')} disabled={locked || !hasPermission('*')} onChange={() => toggle('*')} />
              {tc('Full administrative access')}
            </label>
            <div className="flex gap-2">
              <Button size="xs" variant="ghost" disabled={locked} onClick={() => setSelected(new Set<Permission>(PERMISSION_GROUPS.flatMap(g => hasPermission(g.key) ? [g.key] : g.children.filter(c => hasPermission(c.key)).map(c => c.key))))}>
                {tc('Select all available')}
              </Button>
              <Button size="xs" variant="ghost" disabled={locked} onClick={() => setSelected(new Set())}>
                {tc('Clear all')}
              </Button>
            </div>
          </div>

          {/* 2 mục phân quyền riêng: FreeLLMAPI và Thruline */}
          <div className="flex rounded-xl bg-muted p-1 gap-1" role="tablist" aria-label="Permission categories">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'freellmapi'}
              onClick={() => setActiveTab('freellmapi')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'freellmapi'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Server className="size-3.5" />
              <span>{tc('FreeLLMAPI')}</span>
              {freellmapiCount > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  activeTab === 'freellmapi' ? 'bg-primary/10 text-primary' : 'bg-muted-foreground/15 text-muted-foreground'
                }`}>
                  {selected.has('*') ? tc('All') : freellmapiCount}
                </span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'x_gateway'}
              onClick={() => setActiveTab('x_gateway')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 text-xs font-medium rounded-lg transition-all ${
                activeTab === 'x_gateway'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Layers className="size-3.5" />
              <span>{tc('Thruline (9Router)')}</span>
              {xGatewayCount > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  activeTab === 'x_gateway' ? 'bg-primary/10 text-primary' : 'bg-muted-foreground/15 text-muted-foreground'
                }`}>
                  {selected.has('*') ? tc('All') : xGatewayCount}
                </span>
              )}
            </button>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <span>
              {activeTab === 'freellmapi' ? tc('FreeLLMAPI core features and management') : tc('9Router integration, combos and savers')}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={locked}
                onClick={selectAllInActiveTab}
                className="text-[11px] text-primary hover:underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
              >
                {activeTab === 'freellmapi' ? tc('Select all FreeLLMAPI') : tc('Select all Thruline')}
              </button>
              <span>•</span>
              <button
                type="button"
                disabled={locked}
                onClick={clearActiveTab}
                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 disabled:opacity-50 disabled:no-underline"
              >
                {tc('Clear')}
              </button>
            </div>
          </div>

          <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
            <div className={activeTab === 'freellmapi' ? 'space-y-3' : 'hidden'} role="tabpanel">
              {freellmapiGroups.map(renderGroup)}
            </div>
            <div className={activeTab === 'x_gateway' ? 'space-y-3' : 'hidden'} role="tabpanel">
              {xGatewayGroups.map(renderGroup)}
            </div>
          </div>

          {mutation.isError && <p role="alert" className="text-xs text-destructive">{mutation.error.message}</p>}
          <div className="flex justify-end gap-2 border-t pt-3"><Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>{tc('Cancel')}</Button>
            {!locked && <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate([...selected])}>{mutation.isPending ? tc('Saving…') : tc('Save Permissions')}</Button>}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
