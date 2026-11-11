import { subscriptionRequest } from './subscription-http.js';
import type { OAuthCredential } from './oauth-credentials.js';

export function kiroRegion(value = 'us-east-1'): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)) throw new Error('Invalid AWS region.');
  return value;
}
export const KIRO_AUTH_BASE = 'https://prod.us-east-1.auth.desktop.kiro.dev';
export async function startKiroDevice(region = 'us-east-1') {
  const base = `https://oidc.${kiroRegion(region)}.amazonaws.com`;
  const registered = await subscriptionRequest(`${base}/client/register`, {
    clientName: 'FreeLLMAPI X Gateway', clientType: 'public',
    scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
    grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
  });
  if (!registered.response.ok || !registered.data.clientId || !registered.data.clientSecret) throw new Error('Kiro client registration failed.');
  const { clientId, clientSecret } = registered.data;
  const authorized = await subscriptionRequest(`${base}/device_authorization`, { clientId, clientSecret, startUrl: 'https://view.awsapps.com/start' });
  if (!authorized.response.ok || !authorized.data.deviceCode || !authorized.data.userCode) throw new Error('Kiro device authorization failed.');
  const verification = new URL(authorized.data.verificationUri);
  if (verification.protocol !== 'https:' || !['view.awsapps.com', 'device.sso.us-east-1.amazonaws.com'].includes(verification.hostname)) throw new Error('Unsupported Kiro verification URL.');
  return { clientId: String(clientId), clientSecret: String(clientSecret), region, deviceCode: String(authorized.data.deviceCode),
    userCode: String(authorized.data.userCode), verificationUri: verification.toString(),
    interval: Math.max(5, Math.min(30, Number(authorized.data.interval) || 5)),
    expiresIn: Math.max(60, Math.min(600, Number(authorized.data.expiresIn) || 600)) };
}
export async function pollKiroDevice(attempt: { region: string; clientId: string; clientSecret: string; deviceCode: string }) {
  const result = await subscriptionRequest(`https://oidc.${kiroRegion(attempt.region)}.amazonaws.com/token`, {
    clientId: attempt.clientId, clientSecret: attempt.clientSecret, deviceCode: attempt.deviceCode,
    grantType: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (!result.response.ok) {
    if (['authorization_pending', 'slow_down'].includes(result.data.error)) return { pending: true as const, slow: result.data.error === 'slow_down' };
    throw new Error('Kiro device authorization failed or expired.');
  }
  return { pending: false as const, credential: kiroTokens({ v: 1, kind: 'kiro', accessToken: '', refreshToken: '', expiresAt: 1,
    authMethod: 'builder-id', region: attempt.region, clientId: attempt.clientId, clientSecret: attempt.clientSecret }, result.data) };
}
function kiroTokens(current: OAuthCredential, data: Record<string, unknown>): OAuthCredential {
  if (typeof data.accessToken !== 'string' || !data.accessToken || typeof (data.refreshToken ?? current.refreshToken) !== 'string' || !(data.refreshToken ?? current.refreshToken)) throw new Error('Invalid Kiro token response.');
  return { ...current, accessToken: data.accessToken, refreshToken: String(data.refreshToken ?? current.refreshToken),
    expiresAt: Date.now() + Math.min(86400, Math.max(60, Number(data.expiresIn) || 3600)) * 1000,
    lastRefreshAt: Date.now(), ...(typeof data.profileArn === 'string' ? { profileArn: data.profileArn } : {}) };
}
export async function refreshKiroCredential(current: OAuthCredential): Promise<OAuthCredential> {
  const builder = current.authMethod !== 'social';
  if (builder && (!current.clientId || !current.clientSecret)) throw new Error('Kiro OIDC client registration is missing. Reconnect with device login.');
  const result = await subscriptionRequest(builder ? `https://oidc.${kiroRegion(current.region)}.amazonaws.com/token` : `${KIRO_AUTH_BASE}/refreshToken`,
    builder ? { clientId: current.clientId, clientSecret: current.clientSecret, refreshToken: current.refreshToken, grantType: 'refresh_token' } : { refreshToken: current.refreshToken });
  if (!result.response.ok) throw Object.assign(new Error('Kiro token refresh was rejected.'), { status: result.response.status, permanent: [400, 401, 403].includes(result.response.status) });
  return kiroTokens(current, result.data);
}
