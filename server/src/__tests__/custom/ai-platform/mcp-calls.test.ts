import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb } from '../../../db/index.js';
import {
  getToolCallByExecutionKey,
  listToolCalls,
  pruneToolCalls,
  recordToolCall,
  transitionToolCallOutcome,
} from '../../../custom/ai-platform/mcp-client/calls.js';

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
  try { getDb().close(); } catch { /* already closed */ }
});

describe('MCP call log (T046)', () => {
  it('masks sensitive data, truncates args/result to 8 KB with marker, and deduplicates by executionKey', () => {
    const scope = { kind: 'profile' as const, id: '1' };
    const bigPayload = `contact alice@example.com token sk-secret1234567890 ${'x'.repeat(10_000)}`;

    const first = recordToolCall({
      executionKey: 'turn-1:0:mcp__srv__read:abc',
      scope,
      endUser: 'user-1',
      serverId: 1,
      toolName: 'mcp__srv__read',
      argsMasked: bigPayload,
      resultMasked: bigPayload,
      status: 'ok',
      durationMs: 42,
      resultBytes: bigPayload.length,
    });

    expect(first.argsMasked).not.toContain('alice@example.com');
    expect(first.argsMasked).not.toContain('sk-secret1234567890');
    expect(Buffer.byteLength(first.argsMasked!, 'utf8')).toBeLessThanOrEqual(8_192);
    expect(first.argsMasked).toContain('[truncated]');
    expect(Buffer.byteLength(first.resultMasked!, 'utf8')).toBeLessThanOrEqual(8_192);
    expect(first.resultMasked).toContain('[truncated]');

    // Duplicate executionKey returns existing row without inserting a second row
    const dup = recordToolCall({
      executionKey: 'turn-1:0:mcp__srv__read:abc',
      scope,
      endUser: 'user-1',
      serverId: 1,
      toolName: 'mcp__srv__read',
      argsMasked: 'different',
      resultMasked: 'different',
      status: 'ok',
      durationMs: 99,
      resultBytes: 9,
    });
    expect(dup.id).toBe(first.id);
    expect(listToolCalls({ scope }).calls).toHaveLength(1);
  });

  it('supports stable cursor pagination and deterministic fake-clock retention pruning', () => {
    vi.useFakeTimers();
    const scope = { kind: 'profile' as const, id: '2' };

    for (let i = 1; i <= 5; i++) {
      recordToolCall({
        scope,
        endUser: null,
        serverId: 1,
        toolName: `tool_${i}`,
        argsMasked: `{"i":${i}}`,
        resultMasked: `ok-${i}`,
        status: i % 2 === 0 ? 'tool_error' : 'ok',
        durationMs: i * 10,
        resultBytes: 4,
      });
    }

    const page1 = listToolCalls({ scope, limit: 2 });
    expect(page1.calls).toHaveLength(2);
    expect(page1.calls.map((c) => c.toolName)).toEqual(['tool_5', 'tool_4']);
    expect(page1.nextBefore).toBeTruthy();

    const page2 = listToolCalls({ scope, limit: 2, before: page1.nextBefore! });
    expect(page2.calls.map((c) => c.toolName)).toEqual(['tool_3', 'tool_2']);
    expect(page2.nextBefore).toBeTruthy();

    const page3 = listToolCalls({ scope, limit: 2, before: page2.nextBefore! });
    expect(page3.calls.map((c) => c.toolName)).toEqual(['tool_1']);
    expect(page3.nextBefore).toBeNull();

    // Backdate 2 rows to 35 days ago relative to fake now
    const now = new Date('2026-12-20T00:00:00.000Z');
    vi.setSystemTime(now);
    getDb().prepare("UPDATE custom_ai_tool_calls SET created_at = '2026-11-10 00:00:00' WHERE tool_name IN ('tool_1', 'tool_2')").run();
    getDb().prepare("UPDATE custom_ai_tool_calls SET created_at = '2026-12-10 00:00:00' WHERE tool_name IN ('tool_3', 'tool_4', 'tool_5')").run();

    const deleted = pruneToolCalls(now);
    expect(deleted).toBe(2);
    expect(listToolCalls({ scope }).calls.map((c) => c.toolName)).toEqual(['tool_5', 'tool_4', 'tool_3']);
  });

  it('transitions awaiting_approval journal rows atomically to terminal outcome and stays idempotent (F08)', () => {
    const scope = { kind: 'profile' as const, id: '3' };
    const queued = recordToolCall({
      executionKey: 'run-99:1:mcp__srv__write:hash1',
      scope,
      endUser: 'u1',
      serverId: 1,
      toolName: 'mcp__srv__write',
      argsMasked: '{"id":1}',
      resultMasked: '42',
      status: 'awaiting_approval',
      durationMs: 0,
      resultBytes: 0,
    });
    expect(queued.status).toBe('awaiting_approval');

    const transitioned = transitionToolCallOutcome('run-99:1:mcp__srv__write:hash1', {
      status: 'ok',
      resultMasked: '{"created":true}',
      durationMs: 120,
      resultBytes: 16,
    });
    expect(transitioned).not.toBeNull();
    expect(transitioned!.id).toBe(queued.id);
    expect(transitioned!.status).toBe('ok');
    expect(transitioned!.resultMasked).toBe('{"created":true}');
    expect(transitioned!.durationMs).toBe(120);
    expect(transitioned!.resultBytes).toBe(16);

    // Second transition attempt must NOT overwrite terminal outcome
    const replay = transitionToolCallOutcome('run-99:1:mcp__srv__write:hash1', {
      status: 'tool_error',
      resultMasked: 'should-not-overwrite',
      errorText: 'late error',
      durationMs: 999,
      resultBytes: 5,
    });
    expect(replay!.status).toBe('ok');
    expect(replay!.resultMasked).toBe('{"created":true}');
    expect(getToolCallByExecutionKey('run-99:1:mcp__srv__write:hash1')?.status).toBe('ok');
  });
});
