/**
 * T019 — AI Platform permission matrix tests.
 *
 * Table-driven coverage of:
 *  - 21 child actions + parent fallback
 *  - GET/HEAD vs write methods
 *  - Unknown methods and unrecognised routes → manage_ai_platform
 *  - Case variants, encoded paths, canonical route shapes
 *  - Limited secondary admin (member with explicit child permission)
 *  - Primary / single-user path (isPrimary → all)
 *
 * Integration tests that use createApp/auth are marked BLOCKED until Agent1
 * delivers S/router.ts (T026/T027) and Agent3 delivers T027 registration.
 * Until then, the pure-unit permission dispatch tests run against the
 * aiPlatformPermission() function imported from S/permissions.ts.
 *
 * BLOCKED INTEGRATION: HTTP mounting tests require Agent3 T027 commit.
 * See handoffs/agent-4-foundation.md for exact blocker details.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { initDb } from '../../../db/index.js';
import { createApp } from '../../../app.js';
import { createSession, createUser } from '../../../services/auth.js';
import { setUserPermissions } from '../../../services/users.js';
import { aiPlatformPermission } from '../../../custom/ai-platform/permissions.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function perm(method: string, path: string): string {
  return aiPlatformPermission(method, path);
}

// ─── Permission mapping table (from contracts/admin-api.md) ──────────────────
//
// Format: [method, path, expected_permission]
// Paths that contain :scope use a concrete example (profile/1).

const MATRIX: Array<[string, string, string]> = [
  // --- Foundation ---
  ['GET', '/api/ai-platform/overview', 'view_ai_platform'],
  ['HEAD', '/api/ai-platform/overview', 'view_ai_platform'],
  ['PUT', '/api/ai-platform/flags', 'edit_ai_flags'],
  ['GET', '/api/ai-platform/retention', 'view_ai_platform'],
  ['PUT', '/api/ai-platform/retention', 'edit_ai_flags'],

  // --- Versioned prompts ---
  ['GET', '/api/ai-platform/prompts/profile/1', 'view_prompts'],
  ['HEAD', '/api/ai-platform/prompts/profile/1', 'view_prompts'],
  ['GET', '/api/ai-platform/prompts/profile/1/versions/3', 'view_prompts'],
  ['GET', '/api/ai-platform/prompts/profile/1/diff', 'view_prompts'],
  ['PUT', '/api/ai-platform/prompts/profile/1/draft', 'edit_prompts'],
  ['DELETE', '/api/ai-platform/prompts/profile/1/draft', 'edit_prompts'],
  ['POST', '/api/ai-platform/prompts/profile/1/preview', 'edit_prompts'],
  ['POST', '/api/ai-platform/prompts/profile/1/try', 'edit_prompts'],
  ['POST', '/api/ai-platform/prompts/profile/1/publish', 'publish_prompts'],
  ['POST', '/api/ai-platform/prompts/profile/1/restore', 'publish_prompts'],
  ['GET', '/api/ai-platform/prompts/variables', 'view_prompts'],

  // --- Retrieval ---
  ['GET', '/api/ai-platform/retrieval/profile/1', 'view_retrieval'],
  ['PUT', '/api/ai-platform/retrieval/profile/1', 'edit_retrieval'],
  ['POST', '/api/ai-platform/retrieval/profile/1/reindex', 'edit_retrieval'],
  ['POST', '/api/ai-platform/retrieval/profile/1/query', 'view_retrieval'],
  ['GET', '/api/ai-platform/retrieval/usage', 'view_retrieval'],

  // --- Prompt cache ---
  ['GET', '/api/ai-platform/prompt-cache/settings', 'view_prompt_cache'],
  ['PUT', '/api/ai-platform/prompt-cache/settings', 'edit_prompt_cache'],
  ['GET', '/api/ai-platform/prompt-cache/capabilities', 'view_prompt_cache'],
  ['PUT', '/api/ai-platform/prompt-cache/capabilities', 'edit_prompt_cache'],
  ['DELETE', '/api/ai-platform/prompt-cache/capabilities', 'edit_prompt_cache'],
  ['GET', '/api/ai-platform/prompt-cache/stats', 'view_prompt_cache'],

  // --- MCP client ---
  ['GET', '/api/ai-platform/mcp/servers', 'view_mcp_servers'],
  ['POST', '/api/ai-platform/mcp/servers', 'edit_mcp_servers'],
  ['PATCH', '/api/ai-platform/mcp/servers/5', 'edit_mcp_servers'],
  ['DELETE', '/api/ai-platform/mcp/servers/5', 'edit_mcp_servers'],
  ['POST', '/api/ai-platform/mcp/servers/5/test', 'edit_mcp_servers'],
  ['POST', '/api/ai-platform/mcp/servers/5/sync', 'edit_mcp_servers'],
  ['GET', '/api/ai-platform/mcp/servers/5/tools', 'view_mcp_servers'],
  ['PATCH', '/api/ai-platform/mcp/tools/9', 'review_mcp_tools'],
  ['GET', '/api/ai-platform/mcp/bindings/profile/1', 'view_mcp_servers'],
  ['PUT', '/api/ai-platform/mcp/bindings/profile/1', 'review_mcp_tools'],
  ['GET', '/api/ai-platform/mcp/calls', 'view_mcp_servers'],
  ['GET', '/api/ai-platform/mcp/allowed-internal-hosts', 'manage_ai_platform'],
  ['PUT', '/api/ai-platform/mcp/allowed-internal-hosts', 'manage_ai_platform'],

  // --- Output guard ---
  ['GET', '/api/ai-platform/output-guard/profile/1', 'view_output_guard'],
  ['PUT', '/api/ai-platform/output-guard/profile/1', 'edit_output_guard'],
  ['POST', '/api/ai-platform/output-guard/profile/1/test', 'view_output_guard'],
  ['GET', '/api/ai-platform/output-guard/events', 'view_output_guard'],
  ['GET', '/api/ai-platform/output-guard/events/7/excerpt', 'view_guard_excerpts'],

  // --- Orchestrator ---
  ['GET', '/api/ai-platform/agents', 'view_flows'],
  ['POST', '/api/ai-platform/agents', 'edit_flows'],
  ['GET', '/api/ai-platform/agents/3', 'view_flows'],
  ['PATCH', '/api/ai-platform/agents/3', 'edit_flows'],
  ['DELETE', '/api/ai-platform/agents/3', 'edit_flows'],
  ['GET', '/api/ai-platform/flows', 'view_flows'],
  ['POST', '/api/ai-platform/flows', 'edit_flows'],
  ['GET', '/api/ai-platform/flows/4', 'view_flows'],
  ['PUT', '/api/ai-platform/flows/4/draft', 'edit_flows'],
  ['POST', '/api/ai-platform/flows/4/try', 'edit_flows'],
  ['POST', '/api/ai-platform/flows/4/publish', 'publish_flows'],
  ['PUT', '/api/ai-platform/flows/4/grants', 'publish_flows'],
  ['DELETE', '/api/ai-platform/flows/4', 'edit_flows'],
  ['GET', '/api/ai-platform/runs', 'view_flow_runs'],
  ['GET', '/api/ai-platform/runs/9', 'view_flow_runs'],
  ['POST', '/api/ai-platform/runs/9/cancel', 'cancel_flow_runs'],
  ['GET', '/api/ai-platform/approvals', 'approve_ai_actions'],
  ['POST', '/api/ai-platform/approvals/2/approve', 'approve_ai_actions'],
  ['POST', '/api/ai-platform/approvals/2/reject', 'approve_ai_actions'],
];

// ─── Case / encoding variants (must NOT downgrade security) ───────────────────
const CASE_VARIANTS: Array<[string, string, string]> = [
  // Upper-cased path segment must resolve to same as lower-cased
  ['GET', '/api/ai-platform/OVERVIEW', 'view_ai_platform'],
  ['PUT', '/api/ai-platform/FLAGS', 'edit_ai_flags'],
  ['GET', '/api/ai-platform/Retention', 'view_ai_platform'],
  // Mixed-case method
  ['get', '/api/ai-platform/overview', 'view_ai_platform'],
  // Trailing slash should not change outcome
  ['GET', '/api/ai-platform/overview/', 'view_ai_platform'],
  // Query string should be ignored
  ['GET', '/api/ai-platform/overview?foo=bar', 'view_ai_platform'],
  // Percent-encoded path characters fail closed to parent manage_ai_platform (must not open weaker permission)
  ['PUT', '/api/ai-platform/fl%61gs', 'manage_ai_platform'],
];

// ─── Unknown/unrecognised routes → parent fallback ────────────────────────────
const UNKNOWN_ROUTES: Array<[string, string]> = [
  ['GET', '/api/ai-platform/nonexistent'],
  ['DELETE', '/api/ai-platform/nonexistent/something/deep'],
  ['POST', '/api/ai-platform/'],
  ['PATCH', '/api/ai-platform/unknown-module/settings'],
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AI Platform permission dispatch (T019)', () => {
  it('module loads and exports aiPlatformPermission', () => {
    expect(typeof aiPlatformPermission).toBe('function');
  });

  describe('full permission matrix — 21 child actions', () => {
    for (const [method, path, expected] of MATRIX) {
      it(`${method} ${path} → ${expected}`, () => {
        expect(perm(method, path)).toBe(expected);
      });
    }
  });

  describe('case and encoding variants do not weaken permissions', () => {
    for (const [method, path, expected] of CASE_VARIANTS) {
      it(`${method} ${path} → ${expected}`, () => {
        const result = perm(method, path);
        // The result must be at least as restrictive as expected.
        // For these tests expected IS the correct permission, so equality is fine.
        expect(result).toBe(expected);
      });
    }
  });

  describe('unknown routes → manage_ai_platform (parent fallback)', () => {
    for (const [method, path] of UNKNOWN_ROUTES) {
      it(`${method} ${path} → manage_ai_platform`, () => {
        expect(perm(method, path)).toBe('manage_ai_platform');
      });
    }
  });

  describe('GET/HEAD are always reads; any other method is a write', () => {
    // overview is GET→view, the same path with POST must stay manage_ai_platform
    it('POST /api/ai-platform/overview → manage_ai_platform (not view_ai_platform)', () => {
      expect(perm('POST', '/api/ai-platform/overview')).toBe('manage_ai_platform');
    });
    it('HEAD /api/ai-platform/flags → manage_ai_platform (PUT is the only write)', () => {
      // /flags only has PUT defined; HEAD is unknown → parent
      expect(perm('HEAD', '/api/ai-platform/flags')).toBe('manage_ai_platform');
    });
    it('DELETE /api/ai-platform/retention → manage_ai_platform (not defined)', () => {
      expect(perm('DELETE', '/api/ai-platform/retention')).toBe('manage_ai_platform');
    });
  });

  describe('parent fallback: single-user (isPrimary) is handled by caller, not dispatch', () => {
    it('never returns the wildcard "*"', () => {
      for (const [method, path] of MATRIX.map(([m, p]) => [m, p])) {
        expect(perm(method as string, path as string)).not.toBe('*');
      }
    });
  });

  describe('real HTTP mounting with createApp/auth/DB', () => {
    let server: Server;
    let base: string;
    let primaryToken: string;
    let viewerToken: string;
    let editorToken: string;
    let plainMemberToken: string;

    const call = async (path: string, token?: string, method = 'GET', body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
    };

    beforeAll(async () => {
      process.env.ENCRYPTION_KEY = '0'.repeat(64);
      initDb(':memory:');
      server = createApp().listen(0, '127.0.0.1');
      await new Promise<void>(resolve => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

      const primaryId = createUser('aip-primary@example.com', 'Password123!').userId;
      primaryToken = createSession(primaryId);

      const viewerId = createUser('aip-viewer@example.com', 'Password123!', 'member').userId;
      setUserPermissions(viewerId, ['view_ai_platform'], primaryId);
      viewerToken = createSession(viewerId);

      const editorId = createUser('aip-editor@example.com', 'Password123!', 'member').userId;
      setUserPermissions(editorId, ['view_ai_platform', 'edit_ai_flags'], primaryId);
      editorToken = createSession(editorId);

      const plainId = createUser('aip-plain@example.com', 'Password123!', 'member').userId;
      plainMemberToken = createSession(plainId);
    });

    afterAll(() => {
      server?.close();
    });

    it('rejects unauthenticated requests with 401', async () => {
      expect((await call('/api/ai-platform/overview')).status).toBe(401);
      expect((await call('/api/ai-platform/flags', undefined, 'PUT', { prompts: true })).status).toBe(401);
    });

    it('rejects member without ai-platform permissions with 403', async () => {
      expect((await call('/api/ai-platform/overview', plainMemberToken)).status).toBe(403);
      expect((await call('/api/ai-platform/flags', plainMemberToken, 'PUT', { prompts: true })).status).toBe(403);
    });

    it('allows view_ai_platform member to read overview/retention but returns 403 on flag/retention writes', async () => {
      expect((await call('/api/ai-platform/overview', viewerToken)).status).toBe(200);
      expect((await call('/api/ai-platform/retention', viewerToken)).status).toBe(200);
      expect((await call('/api/ai-platform/flags', viewerToken, 'PUT', { prompts: true })).status).toBe(403);
      expect((await call('/api/ai-platform/retention', viewerToken, 'PUT', { runsDays: 10, toolCallsDays: 10, guardExcerptsDays: 5 })).status).toBe(403);
    });

    it('allows edit_ai_flags member to update flags and retention', async () => {
      expect((await call('/api/ai-platform/flags', editorToken, 'PUT', { prompts: false })).status).toBe(200);
      expect((await call('/api/ai-platform/retention', editorToken, 'PUT', { runsDays: 30, toolCallsDays: 30, guardExcerptsDays: 7 })).status).toBe(200);
    });

    it('allows primary/single-user full access', async () => {
      expect((await call('/api/ai-platform/overview', primaryToken)).status).toBe(200);
      expect((await call('/api/ai-platform/flags', primaryToken, 'PUT', { prompts: false })).status).toBe(200);
    });
  });
});
