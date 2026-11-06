import { Link, useInRouterContext } from 'react-router-dom'
import { ChartLine } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'

// "Usage" button on a Users row, opening that account's analytics. Renders nothing
// outside a router so the page can still be mounted on its own (tests, embeds).
export function UsageLink({ userId }: { userId: number }) {
  if (!useInRouterContext()) return null
  return (
    <Link
      to={`/users/${userId}/analytics`}
      className={buttonVariants({ variant: 'outline', size: 'sm', className: 'text-xs h-8' })}
      title="Requests, tokens, errors and models for this account"
    >
      <ChartLine className="size-3.5 mr-1" />
      Usage
    </Link>
  )
}
