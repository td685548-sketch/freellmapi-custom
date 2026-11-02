import { PERMISSION_GROUPS, type ParentPermission } from '../../../shared/permissions'
import { useUserSession } from './use-session'

export function useAdministrativeAccess() {
  const query = useUserSession()
  const can = query.hasPermission
  return { ...query, can, group: (parent: ParentPermission) => can(parent) || !!PERMISSION_GROUPS.find(g => g.key === parent)?.children.some(c => can(c.key)),
    identity: `${query.session?.userId}:${JSON.stringify(query.session?.permissions ?? [])}` }
}
