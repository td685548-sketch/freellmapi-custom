import { PERMISSION_GROUPS, type Permission } from '../../../shared/permissions'

export function togglePermissionSelection(selected: Set<Permission>, key: Permission): Set<Permission> {
  const parents = PERMISSION_GROUPS.map(g => g.key)
  if (key === '*') return selected.has('*') ? new Set(parents) : new Set(['*'])
  const next = selected.has('*') ? new Set<Permission>(parents) : new Set(selected)
  const group = PERMISSION_GROUPS.find(g => g.key === key || g.children.some(c => c.key === key))
  if (!group) return next
  if (key === group.key) {
    const all = next.has(group.key) || group.children.every(c => next.has(c.key))
    next.delete(group.key)
    for (const child of group.children) next.delete(child.key)
    if (!all) next.add(group.key)
  } else if (next.has(group.key)) {
    next.delete(group.key)
    for (const child of group.children) next.add(child.key)
    next.delete(key)
  } else if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}
