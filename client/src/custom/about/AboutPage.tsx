import { ArrowLeft, Info } from 'lucide-react'
import { Link } from 'react-router-dom'
import { buttonVariants } from '@/components/ui/button-variants'
import { useCustomT } from '@/custom/i18n/use-custom-t'
import { AboutContent } from './AboutContent'

export function AboutPage() {
  const tc = useCustomT()

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border bg-card text-primary">
            <Info className="size-5" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {tc('About FreeLLMAPI')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {tc('Version, source repository, and active deployment links.')}
            </p>
          </div>
        </div>
        <Link to="/models/chat" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeft className="size-3.5" />
          {tc('Back to Dashboard')}
        </Link>
      </div>

      <AboutContent />
    </div>
  )
}

export default AboutPage
