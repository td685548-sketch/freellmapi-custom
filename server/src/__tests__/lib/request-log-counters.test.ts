import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { logRequest } from '../../lib/request-log.js';

// The four lifetime upserts were folded into one statement; the stored values
// must stay exactly what the four produced.

const setting = (key: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;

describe('logRequest lifetime counters', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare("DELETE FROM settings WHERE key IN ('total_requests','total_input_tokens','total_output_tokens','first_request_at')").run();
  });

  it('creates the counters on first use and adds on every request', () => {
    logRequest('groq', 'm', null, 'success', 10, 5, 100, null);
    expect([setting('total_requests'), setting('total_input_tokens'), setting('total_output_tokens')]).toEqual(['1', '10', '5']);
    logRequest('groq', 'm', null, 'error', 7, 0, 100, 'boom');
    logRequest('groq', 'm', null, 'canceled', 0, 0, 100, null);
    expect([setting('total_requests'), setting('total_input_tokens'), setting('total_output_tokens')]).toEqual(['3', '17', '5']);
  });

  it('records first_request_at once and never overwrites it', () => {
    logRequest('groq', 'm', null, 'success', 1, 1, 1, null);
    const first = setting('first_request_at');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    getDb().prepare("UPDATE settings SET value = '2001-01-01 00:00:00' WHERE key = 'first_request_at'").run();
    logRequest('groq', 'm', null, 'success', 1, 1, 1, null);
    expect(setting('first_request_at')).toBe('2001-01-01 00:00:00');
  });

  it('adds to counters that already hold a value', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('total_requests', '41'), ('total_input_tokens', '1000'), ('total_output_tokens', '2000')").run();
    logRequest('groq', 'm', null, 'success', 9, 11, 1, null);
    expect([setting('total_requests'), setting('total_input_tokens'), setting('total_output_tokens')]).toEqual(['42', '1009', '2011']);
  });
});
