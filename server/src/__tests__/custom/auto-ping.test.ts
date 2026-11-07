import { describe, expect, it, beforeEach } from 'vitest';
import {
  setAccountCooldown,
  getAccountCooldown,
  clearAccountCooldown,
  getAllCooldowns,
  getAutoPingSchedule,
  setAutoPingSchedule,
  shouldPingNow,
  PING_SCHEDULE_DEFAULTS,
  type AutoPingSchedule,
} from '../../custom/provider-accounts/auto-ping.js';

describe('Auto-Ping Scheduler & Cooldown Countdown', () => {
  beforeEach(() => {
    clearAccountCooldown(101);
    clearAccountCooldown(102);
  });

  describe('Cooldown Management (HTTP 429)', () => {
    it('sets and retrieves active cooldown duration', () => {
      setAccountCooldown(101, 60 * 1000); // 1 minute from now
      const status = getAccountCooldown(101);

      expect(status.inCooldown).toBe(true);
      expect(status.remainingMs).toBeGreaterThan(0);
      expect(status.remainingMs).toBeLessThanOrEqual(60 * 1000);
      expect(status.until).toBeDefined();
    });

    it('sets cooldown from an ISO date string', () => {
      const future = new Date(Date.now() + 120 * 1000).toISOString();
      setAccountCooldown(102, future);
      const status = getAccountCooldown(102);

      expect(status.inCooldown).toBe(true);
      expect(status.until).toBe(future);
    });

    it('clears cooldown manually', () => {
      setAccountCooldown(101, 60 * 1000);
      expect(getAccountCooldown(101).inCooldown).toBe(true);

      clearAccountCooldown(101);
      expect(getAccountCooldown(101).inCooldown).toBe(false);
      expect(getAccountCooldown(101).until).toBeNull();
    });

    it('returns empty cooldown for unknown account', () => {
      const status = getAccountCooldown(99999);
      expect(status.inCooldown).toBe(false);
      expect(status.remainingMs).toBe(0);
      expect(status.until).toBeNull();
    });

    it('lists all active cooldowns and cleans expired entries', () => {
      setAccountCooldown(101, 50 * 1000);
      setAccountCooldown(102, -1000); // already expired

      const all = getAllCooldowns();
      expect(all[101]).toBeDefined();
      expect(all[102]).toBeUndefined();
    });
  });

  describe('Schedule Configuration', () => {
    it('returns default schedule when no settings saved', () => {
      const schedule = getAutoPingSchedule(501);
      expect(schedule.mode).toBe('off');
      expect(schedule.anchor).toBe(PING_SCHEDULE_DEFAULTS.anchor);
      expect(schedule.windowHours).toBe(PING_SCHEDULE_DEFAULTS.windowHours);
      expect(schedule.slotsPerDay).toBe(PING_SCHEDULE_DEFAULTS.slotsPerDay);
    });

    it('updates and persists schedule configuration', () => {
      const updated = setAutoPingSchedule(502, {
        mode: 'schedule',
        anchor: '10:00',
        windowHours: 4,
        slotsPerDay: 4,
      });

      expect(updated.enabled).toBe(true);
      expect(updated.mode).toBe('schedule');
      expect(updated.anchor).toBe('10:00');
      expect(updated.windowHours).toBe(4);
      expect(updated.slotsPerDay).toBe(4);

      const retrieved = getAutoPingSchedule(502);
      expect(retrieved.mode).toBe('schedule');
      expect(retrieved.anchor).toBe('10:00');
    });

    it('sets enabled to false when mode is off', () => {
      const updated = setAutoPingSchedule(503, { mode: 'off' });
      expect(updated.enabled).toBe(false);
      expect(updated.mode).toBe('off');
    });
  });

  describe('shouldPingNow scheduler evaluation', () => {
    it('returns false when schedule is disabled or mode is off', () => {
      const schedule: AutoPingSchedule = {
        enabled: false,
        mode: 'off',
        anchor: '08:00',
        windowHours: 5,
        slotsPerDay: 3,
        timezone: 'UTC',
      };
      expect(shouldPingNow(schedule)).toBe(false);
    });

    it('evaluates reset mode based on 4-hour interval', () => {
      const now = new Date();
      const recentPing = new Date(now.getTime() - 2 * 3600 * 1000).toISOString(); // 2h ago
      const oldPing = new Date(now.getTime() - 5 * 3600 * 1000).toISOString(); // 5h ago

      const scheduleRecent: AutoPingSchedule = {
        enabled: true,
        mode: 'reset',
        anchor: '08:00',
        windowHours: 5,
        slotsPerDay: 3,
        timezone: 'UTC',
        lastPingAt: recentPing,
      };
      expect(shouldPingNow(scheduleRecent)).toBe(false);

      const scheduleOld: AutoPingSchedule = {
        ...scheduleRecent,
        lastPingAt: oldPing,
      };
      expect(shouldPingNow(scheduleOld)).toBe(true);
    });
  });
});
