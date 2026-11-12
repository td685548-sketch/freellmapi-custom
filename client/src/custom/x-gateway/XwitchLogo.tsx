/**
 * Xwitch mark: two crossing tracks form the X. The standby track is broken at
 * the crossing; the live track runs straight through it and ends at the
 * provider it was switched to. Colours follow the surrounding text and the
 * console accent, so the mark works on any surface.
 */
export function XwitchLogo({ size = 28, title }: { size?: number; title?: string }) {
  return <svg className="x-logo" width={size} height={size} viewBox="0 0 32 32" fill="none" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    <rect className="x-logo-tile" width="32" height="32" rx="8" />
    <path className="x-logo-standby" d="M9 9l4.6 4.6M18.4 18.4L23 23" strokeWidth="3.2" strokeLinecap="round" />
    <path className="x-logo-live" d="M9 23L21.2 10.8" strokeWidth="3.2" strokeLinecap="round" />
    <circle className="x-logo-node" cx="22.6" cy="9.4" r="3" />
  </svg>
}
