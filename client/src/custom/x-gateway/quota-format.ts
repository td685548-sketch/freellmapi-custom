export function quotaCountdown(resetAt: string | null, now: number): string | null {
  if (!resetAt) return null;
  const ms = Date.parse(resetAt) - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 'reset';
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return `${days ? `${days}d ` : ''}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
