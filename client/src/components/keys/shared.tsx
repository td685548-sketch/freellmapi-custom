import type { ProviderQuotaState } from '../../../../shared/types'
import { ExternalLink } from 'lucide-react'
import { useI18n } from '@/i18n'

// Small "Get API key" external link shown next to a provider (#137).
export function GetKeyLink({ url }: { url: string }) {
  const { t } = useI18n()
  if (!url) return null
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      {t('keys.getApiKey')}
      <ExternalLink className="size-3" />
    </a>
  )
}

export interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

export interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null; lastHealthyAt?: string | null; lastHealthError: string | null }[]
  quotaStates: ProviderQuotaState[]
}
