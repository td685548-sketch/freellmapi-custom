import { Link, useInRouterContext } from 'react-router-dom'
import { ChartLine } from 'lucide-react'

// Icon link on a client-profile row, opening that profile's usage page. Renders
// nothing outside a router so the section can still be mounted on its own (tests).
export function ProfileUsageLink({ profileId }: { profileId: number }) {
  if (!useInRouterContext()) return null
  return (
    <Link
      to={`/profiles/${profileId}/usage`}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title="Usage and request limit"
      aria-label="Usage and request limit"
    >
      <ChartLine className="size-3.5" />
    </Link>
  )
}
