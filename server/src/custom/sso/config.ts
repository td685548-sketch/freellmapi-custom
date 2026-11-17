import type { Request } from 'express';
import { getSetting, setSetting } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { getExternalAuthConfig } from '../../services/external-auth-config.js';

export type SsoAuthMode = 'local' | 'oidc' | 'saml' | 'both';

export interface StoredSsoConfig {
  authMode: SsoAuthMode;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecretEnc: string;
  oidcScopes: string;
  oidcLoginLabel: string;
  samlEntryPoint: string;
  samlIssuer: string;
  samlCert: string;
  samlLoginLabel: string;
  autoProvisionMembers: boolean;
  publicBaseUrl: string;
}

export interface SanitizedSsoConfig {
  authMode: SsoAuthMode;
  oidcIssuerUrl: string;
  oidcClientId: string;
  oidcClientSecretConfigured: boolean;
  oidcScopes: string;
  oidcLoginLabel: string;
  samlEntryPoint: string;
  samlIssuer: string;
  samlCert: string;
  samlLoginLabel: string;
  autoProvisionMembers: boolean;
  publicBaseUrl: string;
}

export interface UpdateSsoConfigInput {
  authMode?: SsoAuthMode;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  clearOidcClientSecret?: boolean;
  oidcScopes?: string;
  oidcLoginLabel?: string;
  samlEntryPoint?: string;
  samlIssuer?: string;
  samlCert?: string;
  samlLoginLabel?: string;
  autoProvisionMembers?: boolean;
  publicBaseUrl?: string;
}

const SSO_SETTING_KEY = 'thruline_sso_config';

const DEFAULT_CONFIG: StoredSsoConfig = {
  authMode: 'local',
  oidcIssuerUrl: '',
  oidcClientId: '',
  oidcClientSecretEnc: '',
  oidcScopes: 'openid profile email',
  oidcLoginLabel: 'Sign in with OIDC',
  samlEntryPoint: '',
  samlIssuer: 'urn:freellmapi:sp',
  samlCert: '',
  samlLoginLabel: 'Sign in with SAML SSO',
  autoProvisionMembers: true,
  publicBaseUrl: '',
};

function encryptSecret(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return '';
  return JSON.stringify(encrypt(trimmed));
}

export function decryptSsoClientSecret(enc: string): string {
  if (!enc) return '';
  try {
    const parsed = JSON.parse(enc) as { encrypted?: string; iv?: string; authTag?: string };
    if (parsed?.encrypted && parsed?.iv && parsed?.authTag) {
      return decrypt(parsed.encrypted, parsed.iv, parsed.authTag);
    }
  } catch {
    // ignore corrupt secret payload
  }
  return '';
}

export function getSsoConfig(): StoredSsoConfig {
  const raw = getSetting(SSO_SETTING_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSsoConfig>;
    const authMode = parsed.authMode === 'oidc' || parsed.authMode === 'saml' || parsed.authMode === 'both'
      ? parsed.authMode
      : 'local';
    return {
      authMode,
      oidcIssuerUrl: typeof parsed.oidcIssuerUrl === 'string' ? parsed.oidcIssuerUrl.trim().replace(/\/+$/, '') : '',
      oidcClientId: typeof parsed.oidcClientId === 'string' ? parsed.oidcClientId.trim() : '',
      oidcClientSecretEnc: typeof parsed.oidcClientSecretEnc === 'string' ? parsed.oidcClientSecretEnc : '',
      oidcScopes: typeof parsed.oidcScopes === 'string' && parsed.oidcScopes.trim() ? parsed.oidcScopes.trim() : DEFAULT_CONFIG.oidcScopes,
      oidcLoginLabel: typeof parsed.oidcLoginLabel === 'string' && parsed.oidcLoginLabel.trim() ? parsed.oidcLoginLabel.trim() : DEFAULT_CONFIG.oidcLoginLabel,
      samlEntryPoint: typeof parsed.samlEntryPoint === 'string' ? parsed.samlEntryPoint.trim() : '',
      samlIssuer: typeof parsed.samlIssuer === 'string' && parsed.samlIssuer.trim() ? parsed.samlIssuer.trim() : DEFAULT_CONFIG.samlIssuer,
      samlCert: typeof parsed.samlCert === 'string' ? parsed.samlCert.trim() : '',
      samlLoginLabel: typeof parsed.samlLoginLabel === 'string' && parsed.samlLoginLabel.trim() ? parsed.samlLoginLabel.trim() : DEFAULT_CONFIG.samlLoginLabel,
      autoProvisionMembers: typeof parsed.autoProvisionMembers === 'boolean' ? parsed.autoProvisionMembers : DEFAULT_CONFIG.autoProvisionMembers,
      publicBaseUrl: typeof parsed.publicBaseUrl === 'string' ? parsed.publicBaseUrl.trim().replace(/\/+$/, '') : '',
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function getSanitizedSsoConfig(): SanitizedSsoConfig {
  const cfg = getSsoConfig();
  return {
    authMode: cfg.authMode,
    oidcIssuerUrl: cfg.oidcIssuerUrl,
    oidcClientId: cfg.oidcClientId,
    oidcClientSecretConfigured: Boolean(decryptSsoClientSecret(cfg.oidcClientSecretEnc)),
    oidcScopes: cfg.oidcScopes,
    oidcLoginLabel: cfg.oidcLoginLabel,
    samlEntryPoint: cfg.samlEntryPoint,
    samlIssuer: cfg.samlIssuer,
    samlCert: cfg.samlCert,
    samlLoginLabel: cfg.samlLoginLabel,
    autoProvisionMembers: cfg.autoProvisionMembers,
    publicBaseUrl: cfg.publicBaseUrl,
  };
}

export function saveSsoConfig(patch: UpdateSsoConfigInput): SanitizedSsoConfig {
  const current = getSsoConfig();
  let nextSecretEnc = current.oidcClientSecretEnc;
  if (patch.clearOidcClientSecret) {
    nextSecretEnc = '';
  } else if (typeof patch.oidcClientSecret === 'string' && patch.oidcClientSecret.trim()) {
    nextSecretEnc = encryptSecret(patch.oidcClientSecret);
  }

  const next: StoredSsoConfig = {
    authMode: patch.authMode ?? current.authMode,
    oidcIssuerUrl: patch.oidcIssuerUrl !== undefined ? patch.oidcIssuerUrl.trim().replace(/\/+$/, '') : current.oidcIssuerUrl,
    oidcClientId: patch.oidcClientId !== undefined ? patch.oidcClientId.trim() : current.oidcClientId,
    oidcClientSecretEnc: nextSecretEnc,
    oidcScopes: patch.oidcScopes !== undefined && patch.oidcScopes.trim() ? patch.oidcScopes.trim() : current.oidcScopes,
    oidcLoginLabel: patch.oidcLoginLabel !== undefined && patch.oidcLoginLabel.trim() ? patch.oidcLoginLabel.trim() : current.oidcLoginLabel,
    samlEntryPoint: patch.samlEntryPoint !== undefined ? patch.samlEntryPoint.trim() : current.samlEntryPoint,
    samlIssuer: patch.samlIssuer !== undefined && patch.samlIssuer.trim() ? patch.samlIssuer.trim() : current.samlIssuer,
    samlCert: patch.samlCert !== undefined ? patch.samlCert.trim() : current.samlCert,
    samlLoginLabel: patch.samlLoginLabel !== undefined && patch.samlLoginLabel.trim() ? patch.samlLoginLabel.trim() : current.samlLoginLabel,
    autoProvisionMembers: patch.autoProvisionMembers ?? current.autoProvisionMembers,
    publicBaseUrl: patch.publicBaseUrl !== undefined ? patch.publicBaseUrl.trim().replace(/\/+$/, '') : current.publicBaseUrl,
  };

  setSetting(SSO_SETTING_KEY, JSON.stringify(next));
  return getSanitizedSsoConfig();
}

export function isOidcEnabled(cfg: StoredSsoConfig): boolean {
  if (!['oidc', 'both'].includes(cfg.authMode)) return false;
  return Boolean(cfg.oidcIssuerUrl && cfg.oidcClientId && decryptSsoClientSecret(cfg.oidcClientSecretEnc));
}

export function isSamlEnabled(cfg: StoredSsoConfig): boolean {
  if (!['saml', 'both'].includes(cfg.authMode)) return false;
  return Boolean(cfg.samlEntryPoint && cfg.samlCert);
}

export function resolveSsoPublicOrigin(req: Request, cfg: StoredSsoConfig): string {
  const candidates = [
    cfg.publicBaseUrl,
    getExternalAuthConfig().publicUrl,
    process.env.RENDER_EXTERNAL_URL?.trim(),
    process.env.BASE_URL?.trim(),
  ];
  for (const c of candidates) {
    if (c && /^https?:\/\/[^/]+/i.test(c)) {
      try {
        return new URL(c).origin;
      } catch {
        // try next candidate
      }
    }
  }
  const fwdProto = (req.get('x-forwarded-proto') || '').split(',')[0]?.trim();
  const fwdHost = (req.get('x-forwarded-host') || '').split(',')[0]?.trim();
  const host = fwdHost || req.get('host') || 'localhost:3001';
  const proto = (fwdProto || req.protocol || 'http').replace(/:$/, '');
  return `${proto}://${host}`.replace(/\/+$/, '');
}
