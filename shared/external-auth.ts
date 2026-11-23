export interface ExternalAuthMethods {
  googleEnabled: boolean
  emailResetEnabled: boolean
  legacyResetAllowed: boolean
}
export interface ExternalAuthResult {
  // The session token, sealed inside the Google/SSO handoff (services/
  // google-auth.ts) and consumed server-side to set the httpOnly session
  // cookie. It is NEVER returned to the browser: the /complete endpoints
  // strip it from the JSON response (Phase 2 of the cookie move), so a
  // successful XSS cannot read a fresh session out of a sign-in response.
  token: string
  email: string
  role: 'admin' | 'member'
  apiKey?: string
}
