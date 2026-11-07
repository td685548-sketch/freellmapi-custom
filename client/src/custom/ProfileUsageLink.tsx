import { Link, useInRouterContext } from 'react-router-dom'
import { ChartLine } from 'lucide-react'
import { useCustomT } from './i18n/use-custom-t'

// Icon link on a client-profile row, opening that profile's usage page. Renders
// nothing outside a router so the section can still be mounted on its own (tests).
export function ProfileUsageLink({ profileId }: { profileId: number }) {
  const tc = useCustomT()
  if (!useInRouterContext()) return null
  return (
    <Link
      to={`/profiles/${profileId}/usage`}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={tc('Usage and request limit')}
      aria-label="Usage and request limit"
    >
      <ChartLine className="size-3.5" />
    </Link>
  )
}
