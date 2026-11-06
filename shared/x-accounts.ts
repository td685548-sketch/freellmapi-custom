export type ProviderAccountAuthMethod = 'api_key' | 'oauth_pkce' | 'device_code';

export interface ProviderAccount {
  id: number;
  provider: string;
  label: string;
  identity: string | null;
  authMethod: ProviderAccountAuthMethod;
  enabled: boolean;
  status: string;
  monthlyUsage: { requests: number; tokens: number };
  monthlyRequestCap: number;
  monthlyTokenCap: number;
  models: { id: string; name: string }[];
}

export interface AccountProvider {
  id: string;
  name: string;
  authMethods: ProviderAccountAuthMethod[];
  accounts: ProviderAccount[];
}

export interface ProviderAccountsResponse {
  providers: AccountProvider[];
  permissions: { add: boolean; edit: boolean; delete: boolean; test: boolean; manageModels: boolean };
}

export interface ProviderAccountAuthStartRequest {
  label: string;
  callbackUrl?: string;
  reconnectId?: number;
}

export type ProviderAccountAuthStartResponse = {
  flow: 'oauth_pkce';
  attemptId: string;
  authorizationUrl: string;
  expiresAt: number;
} | {
  flow: 'device_code';
  attemptId: string;
  verificationUri: string;
  userCode: string;
  interval: number;
  expiresAt: number;
};

export type ProviderAccountAuthResult = { status: 'connected'; accountId: number };
export type ProviderAccountPollResponse = ProviderAccountAuthResult | { status: 'pending'; interval: number };
export interface ProviderAccountUpdateRequest { label?: string; enabled?: boolean }
export interface ProviderAccountTestRequest { model?: string; message?: string }
export interface ProviderAccountTestResponse { ok: boolean; message?: string }
