import { createUser, createSession } from '../../services/auth.js';

// Dashboard /api/* routes are gated by requireAuth (#35). Tests mint a session
// token once (after initDb) and attach it to gated requests.

// Phase 3: dashboard session auth is cookie-only. Tests attach the minted
// session as a Cookie, never as an Authorization header. Mutations also need
// the double-submit CSRF pair; the check is stateless, so a fixed test value
// sent as both cookie and header passes.
export const TEST_CSRF_TOKEN = 'test-csrf-token';

/** Cookie (+ CSRF pair) headers for an authenticated dashboard request. */
export function dashboardSessionHeaders(token: string): Record<string, string> {
  return {
    Cookie: `flm_session=${token}; flm_csrf=${TEST_CSRF_TOKEN}`,
    'X-CSRF-Token': TEST_CSRF_TOKEN,
  };
}

export function mintDashboardToken(email = 'test@example.com'): string {
  const user = createUser(email, 'password123');
  return createSession(user.userId);
}

// Gated = under /api/ but not the public bootstrap routes (/api/auth/*, /api/ping).
export function isGatedApiPath(path: string): boolean {
  return path.startsWith('/api/') && !path.startsWith('/api/auth') && path !== '/api/ping';
}
