import { Link, useInRouterContext } from 'react-router-dom'
import { ChartLine } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { useCustomT } from './i18n/use-custom-t'

// "Usage" button on a Users row, opening that account's analytics. Renders nothing
// outside a router so the page can still be mounted on its own (tests, embeds).
export function UsageLink({ userId }: { userId: number }) {
  const tc = useCustomT()
  if (!useInRouterContext()) return null
  return (
    <Link
      to={`/users/${userId}/analytics`}
      className={buttonVariants({ variant: 'outline', size: 'sm', className: 'text-xs h-8' })}
      title={tc('Requests, tokens, errors and models for this account')}
    >
      <ChartLine className="size-3.5 mr-1" />{tc('Usage')}</Link>
  )
}
