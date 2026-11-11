/** Public subscription authorization response. Contains no private grant material. */
export interface SubscriptionAttempt {
  attemptId: string;
  flow: 'oauth_pkce' | 'device_code';
  expiresAt: number;
  authorizationUrl?: string;
  verificationUri?: string;
  userCode?: string;
  interval?: number;
  instruction?: string;
}
