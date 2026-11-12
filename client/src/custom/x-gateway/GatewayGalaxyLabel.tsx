import type { CSSProperties, ReactNode } from 'react'
import { ThrulineLogo } from './ThrulineLogo'
import './gateway-galaxy-label.css'

// Deterministic, tiled textures keep over a thousand stars in three paint layers,
// rather than mounting or updating a DOM element for every particle.
function starTexture(count: number, seed: number, size: number) {
  let state = seed
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  const stars = Array.from({ length: count }, () => {
    const x = random() * 640
    const y = random() * 96
    const radius = size * (0.35 + random() * 0.65)
    const opacity = 0.15 + random() * 0.65
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${radius.toFixed(2)}" opacity="${opacity.toFixed(2)}"/>`
  }).join('')
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="96" viewBox="0 0 640 96"><g fill="#f5f7fa">${stars}</g></svg>`)}")`
}

const layers = [
  starTexture(900, 17, 0.65),
  starTexture(300, 89, 1.1),
  starTexture(70, 251, 1.65),
]

export function GatewayGalaxyLabel({ children }: { children: ReactNode }) {
  return (
    <span className="gateway-galaxy">
      <span className="gateway-galaxy__sky" aria-hidden="true">
        {layers.map((texture, index) => (
          <span
            key={index}
            className={`gateway-galaxy__stars gateway-galaxy__stars--${index}`}
            style={{ '--star-texture': texture } as CSSProperties}
          />
        ))}
        <span className="gateway-galaxy__meteor" />
      </span>
      <span className="gateway-galaxy__label"><ThrulineLogo size={16} />{children}</span>
    </span>
  )
}
