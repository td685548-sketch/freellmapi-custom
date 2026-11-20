export type DeployTargetKind = 'cloud' | 'local' | 'container'

export interface DeployTarget {
  id: string
  name: string
  url: string
  kind: DeployTargetKind
  badge: string
  description: string
}

export const GITHUB_REPO_URL = 'https://github.com/td685548-sketch/freellmapi-custom'

export const DEPLOY_TARGETS: readonly DeployTarget[] = [
  {
    id: 'render',
    name: 'Render',
    url: 'https://freellm-thanhdo.onrender.com',
    kind: 'cloud',
    badge: 'Cloud',
    description: 'Cloud-hosted Render deployment with Turso database.',
  },
  {
    id: 'tailscale',
    name: 'Local Laptop (Tailscale)',
    url: 'https://laptop-o6msglm4.tailc4d30d.ts.net',
    kind: 'local',
    badge: 'Local Tunnel',
    description: 'Local workstation exposed securely over Tailscale Funnel.',
  },
  {
    id: 'snapdeploy',
    name: 'SnapDeploy',
    url: 'https://freellmapi-1d80d.containers.snapdeploy.app',
    kind: 'container',
    badge: 'Container',
    description: 'Containerized SnapDeploy cloud instance.',
  },
]

function normalizeOrigin(rawUrl: string): string | null {
  const trimmed = rawUrl.trim()
  if (!trimmed) return null
  try {
    return new URL(trimmed).origin.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Returns true when `targetUrl` shares the same scheme + host + port as
 * `currentOrigin` (defaulting to `window.location.origin` in browsers).
 */
export function isCurrentDeploymentOrigin(targetUrl: string, currentOrigin?: string): boolean {
  const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  const targetOrigin = normalizeOrigin(targetUrl)
  const activeOrigin = normalizeOrigin(currentOrigin ?? fallbackOrigin)
  return Boolean(targetOrigin && activeOrigin && targetOrigin === activeOrigin)
}
