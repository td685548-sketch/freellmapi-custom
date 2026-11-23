import { useEffect, useState } from 'react'
import { Box, Check, Cloud, Copy, ExternalLink, GitBranch, Globe, Laptop, Tag } from 'lucide-react'
import { useCustomT } from '@/custom/i18n/use-custom-t'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { RELEASES_URL } from '@/lib/updates'
import {
  DEPLOY_TARGETS,
  GITHUB_REPO_URL,
  isCurrentDeploymentOrigin,
  type DeployTargetKind,
} from './deploy-targets'

interface AboutContentProps {
  compact?: boolean
  currentOrigin?: string
  version?: string | null
}

function TargetIcon({ kind }: { kind: DeployTargetKind }) {
  if (kind === 'cloud') return <Cloud className="size-4 text-sky-500" />
  if (kind === 'local') return <Laptop className="size-4 text-emerald-500" />
  return <Box className="size-4 text-violet-500" />
}

function readShellVersion(): string | null {
  if (typeof window === 'undefined') return null
  return (window as { __FREEAPI_VERSION__?: string | null }).__FREEAPI_VERSION__ ?? null
}

export function AboutContent({ compact = false, currentOrigin, version }: AboutContentProps) {
  const tc = useCustomT()
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const activeOrigin = currentOrigin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  const resolvedVersion = version !== undefined ? version : (serverVersion ?? readShellVersion())

  useEffect(() => {
    if (version !== undefined || typeof fetch !== 'function') return
    let cancelled = false
    const base = import.meta.env.BASE_URL.replace(/\/$/, '')
    // Phase 2 of the httpOnly-cookie move: the session rides the httpOnly
    // cookie (credentials: 'same-origin'); no token is read or sent by JS.
    fetch(`${base}/api/settings/version`, {
      credentials: 'same-origin',
    })
      .then(async res => {
        if (!res.ok) return null
        return res.json() as Promise<{ version?: string | null }>
      })
      .then(data => {
        if (!cancelled && data?.version) setServerVersion(data.version)
      })
      .catch(() => {
        // Version metadata is optional; never block or warn when unavailable.
      })

    return () => { cancelled = true }
  }, [version])

  async function handleCopy(id: string, url: string) {
    const ok = await copyText(url)
    if (!ok) {
      toast.error(tc('Copy failed'))
      return
    }
    setCopiedId(id)
    setTimeout(() => {
      setCopiedId(current => (current === id ? null : current))
    }, 1500)
  }

  return (
    <div className={compact ? 'space-y-4' : 'space-y-6'}>
      <section className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                FreeLLMAPI
              </h2>
              {resolvedVersion && (
                <span className="inline-flex items-center rounded-full border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-foreground">
                  {resolvedVersion.startsWith('v') ? resolvedVersion : `v${resolvedVersion}`}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground sm:text-sm">
              {tc('Unified AI Gateway & Multi-Provider Proxy')}
            </p>
            {activeOrigin && (
              <p className="flex items-center gap-1.5 pt-1 text-xs text-muted-foreground">
                <Globe className="size-3.5 shrink-0" />
                <span>{tc('Current origin')}:</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {activeOrigin}
                </code>
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <GitBranch className="size-3.5" />
              <span>{tc('GitHub Repository')}</span>
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
            <a
              href={RELEASES_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Tag className="size-3.5" />
              <span>{tc('Latest Releases')}</span>
              <ExternalLink className="size-3 text-muted-foreground" />
            </a>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{tc('Deployments')}</h3>
          <p className="text-xs text-muted-foreground">
            {tc('Access this instance across all active environments.')}
          </p>
        </div>

        <div className={`grid grid-cols-1 gap-3 ${compact ? '' : 'md:grid-cols-3'}`}>
          {DEPLOY_TARGETS.map(target => {
            const isActive = isCurrentDeploymentOrigin(target.url, activeOrigin)
            const isCopied = copiedId === target.id
            const targetName = tc(target.name)

            return (
              <div
                key={target.id}
                data-deploy-id={target.id}
                data-active-origin={isActive ? 'true' : 'false'}
                className={`flex flex-col justify-between gap-3 rounded-xl border p-4 transition-colors ${
                  isActive
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'bg-card hover:border-foreground/20'
                }`}
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex size-7 items-center justify-center rounded-lg border bg-background">
                        <TargetIcon kind={target.kind} />
                      </span>
                      <span className="text-sm font-semibold text-foreground">{targetName}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-full border bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {tc(target.badge)}
                      </span>
                      {isActive && (
                        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                          {tc('Active here')}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">{tc(target.description)}</p>
                </div>

                <div className="flex items-center justify-between gap-2 rounded-lg border bg-background/80 px-2.5 py-1.5">
                  <a
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-xs text-foreground underline-offset-4 hover:underline"
                    title={target.url}
                  >
                    <span className="truncate">{target.url}</span>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                  </a>
                  <button
                    type="button"
                    onClick={() => { void handleCopy(target.id, target.url) }}
                    aria-label={
                      isCopied
                        ? tc('Copied URL for {name}', { name: targetName })
                        : tc('Copy URL for {name}', { name: targetName })
                    }
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted/50 px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {isCopied ? (
                      <>
                        <Check className="size-3 text-emerald-500" />
                        <span>{tc('Copied')}</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3" />
                        <span>{tc('Copy URL')}</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
