import { useState } from 'react'
import { UnifiedKeySection } from '@/components/keys/unified-key-section'
import { ClientProfilesSection } from '@/components/keys/client-profiles-section'
import { ProxySettingsSection } from '@/components/keys/proxy-settings-section'
import { UpdatesDialog } from '@/components/updates-dialog'
import { Button } from '@/components/ui/button'
import { useUserSession } from './use-session'
import { useCustomT } from './i18n/use-custom-t'

export function ScopedInstallationSections() {
  const tc = useCustomT()
  const { hasPermission: can } = useUserSession()
  const [updatesOpen, setUpdatesOpen] = useState(false)
  return <>
    {(can('reveal_gateway_key') || can('rotate_gateway_key')) && <UnifiedKeySection canView={can('reveal_gateway_key')} canRotate={can('rotate_gateway_key')} />}
    {(can('view_client_profiles') || can('edit_client_profiles')) && <ClientProfilesSection canView={can('view_client_profiles')} canEdit={can('edit_client_profiles')} />}
    {can('reveal_proxy_credentials') && <ProxySettingsSection canEdit={can('edit_settings')} />}
    {can('manage_updates') && <><Button variant="outline" onClick={() => setUpdatesOpen(true)}>{tc('Application updates')}</Button><UpdatesDialog open={updatesOpen} onOpenChange={setUpdatesOpen} /></>}
  </>
}
