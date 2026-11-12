/**
 * Thruline mark: several routes come in from the left and merge into one line
 * that runs straight through to its destination. The side routes are standby;
 * the middle one is live. Colours follow the console accent.
 */
export function ThrulineLogo({ size = 28, title, x, y }: { size?: number; title?: string; /** Position, when nested inside another SVG. */ x?: number; y?: number }) {
  return <svg className="x-logo" x={x} y={y} width={size} height={size} viewBox="0 0 32 32" fill="none" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    <rect className="x-logo-tile" width="32" height="32" rx="8" />
    <path className="x-logo-standby" d="M7 8.5c5.5 0 5.5 7.5 11 7.5M7 23.5c5.5 0 5.5-7.5 11-7.5" strokeWidth="2.8" strokeLinecap="round" />
    <path className="x-logo-live" d="M7 16h14.5" strokeWidth="2.8" strokeLinecap="round" />
    <circle className="x-logo-node" cx="24" cy="16" r="3" />
  </svg>
}

/** The same mark with fixed colours, for places CSS cannot reach (the browser tab icon). */
export const THRULINE_ICON = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">'
  + '<rect width="32" height="32" rx="8" fill="#2457d6"/>'
  + '<path d="M7 8.5c5.5 0 5.5 7.5 11 7.5M7 23.5c5.5 0 5.5-7.5 11-7.5" stroke="#fff" stroke-opacity=".45" stroke-width="2.8" stroke-linecap="round"/>'
  + '<path d="M7 16h14.5" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>'
  + '<circle cx="24" cy="16" r="3" fill="#fff"/></svg>',
)}`
