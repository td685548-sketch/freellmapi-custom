import crypto from 'node:crypto';
import os from 'node:os';

/** Host-qualified process identity; legacy/unrecognized owners require manual reconciliation. */
export function createOwnerInstanceId(processId = process.pid): string {
  return `mcp-v2:${Buffer.from(os.hostname()).toString('base64url')}:${processId}:${crypto.randomUUID()}`;
}

export const CURRENT_OWNER_INSTANCE_ID = createOwnerInstanceId();

/** A different UUID, remote host, permission error, or reused live PID proves nothing. */
export function isOwnerDefinitelyDead(ownerId: string): boolean {
  const match = /^mcp-v2:([A-Za-z0-9_-]+):(\d+):[a-f0-9-]{36}$/.exec(ownerId);
  if (!match || match[1] !== Buffer.from(os.hostname()).toString('base64url')) return false;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
