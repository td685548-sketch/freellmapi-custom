/**
 * Thruline mark: several routes come in from the left and merge into one line
 * that runs straight through to its destination. The side routes are standby;
 * the middle one is live. Colours follow the console accent.
 */
export function ThrulineLogo({ size = 28, title }: { size?: number; title?: string }) {
  return <svg className="x-logo" width={size} height={size} viewBox="0 0 32 32" fill="none" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    <rect className="x-logo-tile" width="32" height="32" rx="8" />
    <path className="x-logo-standby" d="M7 8.5c5.5 0 5.5 7.5 11 7.5M7 23.5c5.5 0 5.5-7.5 11-7.5" strokeWidth="2.8" strokeLinecap="round" />
    <path className="x-logo-live" d="M7 16h14.5" strokeWidth="2.8" strokeLinecap="round" />
    <circle className="x-logo-node" cx="24" cy="16" r="3" />
  </svg>
}
