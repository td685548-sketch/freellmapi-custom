import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { getSupportEventWorkerHealth, startSupportEventWorker, stopSupportEventWorker } from '../../custom/x-gateway/support-event-outbox.js';

describe('Support worker readiness heartbeat', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopSupportEventWorker();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it('requires actual recent progress rather than a started flag', async () => {
    startSupportEventWorker();
    expect(getSupportEventWorkerHealth()).toEqual({ running: true, healthy: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupportEventWorkerHealth()).toEqual({ running: true, healthy: true });
    vi.setSystemTime(Date.now() + 16000);
    expect(getSupportEventWorkerHealth()).toEqual({ running: true, healthy: false });
    stopSupportEventWorker();
    expect(getSupportEventWorkerHealth()).toEqual({ running: false, healthy: false });
  });
  it('does not report healthy after a drain fails to access storage', async () => {
    startSupportEventWorker();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupportEventWorkerHealth().healthy).toBe(true);
    getDb().close?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupportEventWorkerHealth()).toEqual({ running: true, healthy: false });
  });
});
