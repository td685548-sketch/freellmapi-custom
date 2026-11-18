import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CloudAiRuntimePack,
  CloudEntitlementScope,
  CloudEntitlementState,
  CloudEntitlementStatusResponse,
  CloudPendingRequestSummary,
  CloudSignedLease,
} from '@freellmapi/shared/cloud-entitlement.js';
import { getSetting, setSetting } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import {
  CLOUD_ENTITLEMENT_DEFAULT_URL,
  CLOUD_ENTITLEMENT_ED25519_PUBLIC_KEY_PEM,
  ENTITLEMENT_HTTP_TIMEOUT_MS,
  ENV_AI_ACTIVATION_TOKEN,
  ENV_AI_BACKGROUND_POLL,
  ENV_AI_ENTITLEMENT_URL,
  LEASE_HARD_GRACE_MS,
  LEASE_REFRESH_INTERVAL_MS,
  SETTING_AI_ACTIVATION_TOKEN_ENC,
  SETTING_AI_INSTANCE_ID,
  SETTING_AI_PENDING_REQUEST_ENC,
} from './constants.js';

export class CloudEntitlementError extends Error {
  readonly status: number;
  readonly code: string;
  readonly state: CloudEntitlementState;

  constructor(
    status: number,
    code: string,
    state: CloudEntitlementState,
    message: string,
  ) {
    super(message);
    this.name = 'CloudEntitlementError';
    this.status = status;
    this.code = code;
    this.state = state;
  }
}

interface StoredEncryptedBlob {
  encrypted: string;
  iv: string;
  authTag: string;
}

interface StoredPendingRequestSecret {
  requestId: string;
  orgName: string;
  contactInfo: string;
  serverOrigin: string;
  status: 'pending' | 'approved' | 'rejected';
  decisionNote?: string;
  claimSecret: string;
  privateKeyPem: string;
  createdAt: string;
  updatedAt?: string;
}

interface VerifiedLeaseRecord {
  tokenHash: string;
  lease: CloudSignedLease;
  signature: string;
  runtimePack: CloudAiRuntimePack;
  verifiedAtMs: number;
}

interface EntitlementRuntimeConfig {
  baseUrl?: string;
  publicKeyPem?: string;
  fetchImpl?: typeof fetch;
  activeLeaseRecord?: VerifiedLeaseRecord | null;
}

let activeLeaseRecord: VerifiedLeaseRecord | null = null;
let lastFailureState: {
  tokenHash: string;
  state: CloudEntitlementState;
  message: string;
  atMs: number;
} | null = null;
let inflightRefresh: Promise<VerifiedLeaseRecord | null> | null = null;
let backgroundPollTimer: ReturnType<typeof setInterval> | null = null;
let runtimeOverrides: EntitlementRuntimeConfig = {};
let fallbackMemoryInstanceId: string | null = null;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getEffectiveBaseUrl(): string {
  const raw =
    runtimeOverrides.baseUrl ??
    process.env[ENV_AI_ENTITLEMENT_URL]?.trim() ??
    CLOUD_ENTITLEMENT_DEFAULT_URL;
  return raw.replace(/\/+$/, '');
}

function getEffectivePublicKeyPem(): string {
  return runtimeOverrides.publicKeyPem ?? CLOUD_ENTITLEMENT_ED25519_PUBLIC_KEY_PEM;
}

function getEffectiveFetch(): typeof fetch {
  return runtimeOverrides.fetchImpl ?? globalThis.fetch;
}

function safeReadSetting(key: string): string | null {
  try {
    return getSetting(key) ?? null;
  } catch {
    return null;
  }
}

function safeWriteSetting(key: string, value: string): boolean {
  try {
    setSetting(key, value);
    return true;
  } catch {
    return false;
  }
}

function encryptJson(payload: unknown): string {
  const blob = encrypt(JSON.stringify(payload));
  return JSON.stringify(blob);
}

function decryptJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredEncryptedBlob;
    if (!parsed?.encrypted || !parsed?.iv || !parsed?.authTag) return null;
    const plain = decrypt(parsed.encrypted, parsed.iv, parsed.authTag);
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}

export function getOrCreateInstanceId(): string {
  const existing = safeReadSetting(SETTING_AI_INSTANCE_ID);
  if (existing && existing.trim().length >= 8) {
    return existing.trim();
  }
  if (!fallbackMemoryInstanceId) {
    fallbackMemoryInstanceId = crypto.randomUUID();
  }
  safeWriteSetting(SETTING_AI_INSTANCE_ID, fallbackMemoryInstanceId);
  return fallbackMemoryInstanceId;
}

export function resolveConfiguredActivationToken(): {
  token: string;
  source: 'db' | 'env' | 'none';
} {
  const dbStored = decryptJson<{ token?: string }>(
    safeReadSetting(SETTING_AI_ACTIVATION_TOKEN_ENC),
  );
  if (dbStored?.token && dbStored.token.trim()) {
    return { token: dbStored.token.trim(), source: 'db' };
  }
  const envToken = process.env[ENV_AI_ACTIVATION_TOKEN]?.trim() ?? '';
  if (envToken) {
    return { token: envToken, source: 'env' };
  }
  return { token: '', source: 'none' };
}

function getSignedDiskCachePath(tokenHash: string): string {
  const pubKeyTag = sha256Hex(getEffectivePublicKeyPem()).slice(0, 8);
  return path.join(
    os.tmpdir(),
    `freellmapi-cloud-lease-${pubKeyTag}-${tokenHash.slice(0, 16)}.json`,
  );
}

export function verifySignedLeaseEnvelope(params: {
  lease: CloudSignedLease;
  signature: string;
  runtimePack: CloudAiRuntimePack;
  publicKeyPem?: string;
}): boolean {
  const { lease, signature, runtimePack } = params;
  const pubKey = params.publicKeyPem ?? getEffectivePublicKeyPem();
  try {
    if (!lease || !signature || !runtimePack) return false;
    if (typeof lease.licenseId !== 'string' || !Array.isArray(lease.scopes)) {
      return false;
    }
    if (
      !runtimePack.supportCoachPack?.personaVi ||
      !runtimePack.supportCoachPack?.personaEn ||
      !runtimePack.supportAgentCopilotInstruction
    ) {
      return false;
    }
    const computedPackHash = sha256Hex(JSON.stringify(runtimePack));
    if (computedPackHash !== lease.packHash) {
      return false;
    }
    const sigBytes = Buffer.from(signature, 'base64url');
    const canonicalLeaseBytes = Buffer.from(JSON.stringify(lease), 'utf8');
    return crypto.verify(null, canonicalLeaseBytes, pubKey, sigBytes);
  } catch {
    return false;
  }
}

function loadVerifiedDiskLease(tokenHash: string): VerifiedLeaseRecord | null {
  const cacheFile = getSignedDiskCachePath(tokenHash);
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(raw) as VerifiedLeaseRecord;
    if (!parsed || parsed.tokenHash !== tokenHash) return null;
    const expiresMs = new Date(parsed.lease?.expiresAt ?? 0).getTime();
    if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
      return null;
    }
    if (
      !verifySignedLeaseEnvelope({
        lease: parsed.lease,
        signature: parsed.signature,
        runtimePack: parsed.runtimePack,
      })
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function saveVerifiedDiskLease(record: VerifiedLeaseRecord): void {
  const cacheFile = getSignedDiskCachePath(record.tokenHash);
  try {
    const tmpFile = `${cacheFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(tmpFile, cacheFile);
  } catch {
    // Best-effort process cache sharing
  }
}

function clearDiskLease(tokenHash: string): void {
  const cacheFile = getSignedDiskCachePath(tokenHash);
  try {
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  } catch {
    // Best-effort cleanup
  }
}

function getHydratedMemoryLease(): VerifiedLeaseRecord | null {
  if (runtimeOverrides.activeLeaseRecord !== undefined) {
    return runtimeOverrides.activeLeaseRecord;
  }
  const { token } = resolveConfiguredActivationToken();
  if (!token) {
    activeLeaseRecord = null;
    return null;
  }
  const tokenHash = sha256Hex(token);

  if (activeLeaseRecord && activeLeaseRecord.tokenHash === tokenHash) {
    const expiresMs = new Date(activeLeaseRecord.lease.expiresAt).getTime();
    if (expiresMs + LEASE_HARD_GRACE_MS > Date.now()) {
      return activeLeaseRecord;
    }
  }

  const fromDisk = loadVerifiedDiskLease(tokenHash);
  if (fromDisk) {
    activeLeaseRecord = fromDisk;
    return fromDisk;
  }
  return null;
}

export async function refreshCloudEntitlementLease(options?: {
  explicitToken?: string;
  serverOrigin?: string;
  forceOnline?: boolean;
}): Promise<VerifiedLeaseRecord | null> {
  const configured = resolveConfiguredActivationToken();
  const token = options?.explicitToken?.trim() ?? configured.token;
  if (!token) {
    activeLeaseRecord = null;
    return null;
  }

  const tokenHash = sha256Hex(token);
  if (!options?.forceOnline) {
    const disk = loadVerifiedDiskLease(tokenHash);
    if (disk && new Date(disk.lease.expiresAt).getTime() > Date.now() + 60_000) {
      activeLeaseRecord = disk;
      lastFailureState = null;
      return disk;
    }
  }

  if (inflightRefresh && !options?.explicitToken) {
    return inflightRefresh;
  }

  const run = async (): Promise<VerifiedLeaseRecord | null> => {
    const fetchFn = getEffectiveFetch();
    const baseUrl = getEffectiveBaseUrl();
    const instanceId = getOrCreateInstanceId();
    const origin =
      options?.serverOrigin ??
      process.env.PUBLIC_APP_URL?.trim() ??
      '';

    try {
      const res = await fetchFn(`${baseUrl}/v1/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          instanceId,
          serverOrigin: origin,
        }),
        signal: AbortSignal.timeout(ENTITLEMENT_HTTP_TIMEOUT_MS),
      });

      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        message?: string;
        lease?: CloudSignedLease;
        signature?: string;
        runtimePack?: CloudAiRuntimePack;
      } | null;

      if (!res.ok || !body?.ok || !body.lease || !body.signature || !body.runtimePack) {
        const errCode = body?.error ?? '';
        if (res.status === 401 || res.status === 403) {
          // Definitive denial or revocation -> purge immediately
          if (activeLeaseRecord?.tokenHash === tokenHash) {
            activeLeaseRecord = null;
          }
          clearDiskLease(tokenHash);
          const mappedState: CloudEntitlementState =
            errCode === 'license_revoked'
              ? 'revoked'
              : errCode === 'license_expired'
                ? 'expired'
                : 'invalid';
          lastFailureState = {
            tokenHash,
            state: mappedState,
            message:
              body?.message ||
              'Activation token was rejected or revoked by the repository owner.',
            atMs: Date.now(),
          };
          if (options?.explicitToken) {
            throw new CloudEntitlementError(
              403,
              errCode || 'invalid_activation_token',
              mappedState,
              lastFailureState.message,
            );
          }
          return null;
        }

        // Transient 5xx -> keep valid hard-grace lease if still within window
        const existing = getHydratedMemoryLease();
        if (existing && existing.tokenHash === tokenHash) {
          return existing;
        }
        throw new CloudEntitlementError(
          503,
          'entitlement_service_unavailable',
          'unactivated',
          body?.message || `Entitlement service returned HTTP ${res.status}.`,
        );
      }

      const validSig = verifySignedLeaseEnvelope({
        lease: body.lease,
        signature: body.signature,
        runtimePack: body.runtimePack,
      });
      if (!validSig) {
        throw new CloudEntitlementError(
          502,
          'invalid_lease_signature',
          'invalid',
          'Cryptographic verification of cloud entitlement lease failed.',
        );
      }

      const verified: VerifiedLeaseRecord = {
        tokenHash,
        lease: body.lease,
        signature: body.signature,
        runtimePack: body.runtimePack,
        verifiedAtMs: Date.now(),
      };
      activeLeaseRecord = verified;
      lastFailureState = null;
      saveVerifiedDiskLease(verified);
      return verified;
    } catch (err) {
      if (err instanceof CloudEntitlementError) {
        if (options?.explicitToken) throw err;
        return null;
      }
      const existing = getHydratedMemoryLease();
      if (existing && existing.tokenHash === tokenHash && !options?.explicitToken) {
        return existing;
      }
      if (options?.explicitToken) {
        throw new CloudEntitlementError(
          503,
          'entitlement_unreachable',
          'unactivated',
          err instanceof Error ? err.message : 'Could not reach cloud entitlement service.',
        );
      }
      return null;
    }
  };

  if (options?.explicitToken) {
    return run();
  }

  inflightRefresh = run().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export async function ensureCloudEntitlementActive(
  scope?: CloudEntitlementScope,
): Promise<VerifiedLeaseRecord | null> {
  const { token } = resolveConfiguredActivationToken();
  if (!token) return null;

  const current = getHydratedMemoryLease();
  if (current) {
    const expiresMs = new Date(current.lease.expiresAt).getTime();
    if (expiresMs <= Date.now()) {
      // Soft-expired: trigger refresh
      const refreshed = await refreshCloudEntitlementLease();
      const candidate = refreshed ?? current;
      if (new Date(candidate.lease.expiresAt).getTime() + LEASE_HARD_GRACE_MS <= Date.now()) {
        return null;
      }
      if (scope && !candidate.lease.scopes.includes(scope)) return null;
      return candidate;
    }
    if (scope && !current.lease.scopes.includes(scope)) return null;
    return current;
  }

  // Avoid hammering remote server on every request right after a definitive 401/403
  const tokenHash = sha256Hex(token);
  if (
    lastFailureState &&
    lastFailureState.tokenHash === tokenHash &&
    Date.now() - lastFailureState.atMs < 30_000
  ) {
    return null;
  }

  const fetched = await refreshCloudEntitlementLease();
  if (!fetched) return null;
  if (scope && !fetched.lease.scopes.includes(scope)) return null;
  return fetched;
}

/**
 * Safe optional accessor for optional remote prompt/policy overrides.
 * Returns null if entitlement is not active or pack is not loaded,
 * allowing calling modules to gracefully fall back to their local defaults.
 */
export function getActiveVerifiedCloudRuntimePack(): CloudAiRuntimePack | null {
  return getHydratedMemoryLease()?.runtimePack ?? null;
}

/**
 * Synchronous accessor required by prompt-assembly engines (`llm-coach`, `support-agent-copilot`).
 * Throws `CloudEntitlementError` if no Ed25519-verified `CloudAiRuntimePack` is active,
 * preventing bypass via route-middleware deletion.
 */
export function requireVerifiedCloudRuntimePack(): CloudAiRuntimePack {
  const hydrated = getHydratedMemoryLease();
  if (!hydrated) {
    throw new CloudEntitlementError(
      403,
      'ai_activation_required',
      lastFailureState?.state ?? 'unactivated',
      'Cloud AI runtime pack is not loaded. Owner activation token is required.',
    );
  }
  return hydrated.runtimePack;
}

export async function ensureVerifiedCloudRuntimePack(
  scope?: CloudEntitlementScope,
): Promise<CloudAiRuntimePack> {
  const active = await ensureCloudEntitlementActive(scope);
  if (!active) {
    throw new CloudEntitlementError(
      403,
      'ai_activation_required',
      lastFailureState?.state ?? 'unactivated',
      'AI & Support modules require an active license approved by the repository owner.',
    );
  }
  return active.runtimePack;
}

export async function activateWithToken(
  rawToken: string,
  serverOrigin?: string,
): Promise<VerifiedLeaseRecord> {
  const trimmed = rawToken.trim();
  if (!trimmed.startsWith('flm_act_')) {
    throw new CloudEntitlementError(
      400,
      'invalid_token_format',
      'invalid',
      'Activation token must begin with "flm_act_".',
    );
  }
  const verified = await refreshCloudEntitlementLease({
    explicitToken: trimmed,
    serverOrigin,
    forceOnline: true,
  });
  if (!verified) {
    throw new CloudEntitlementError(
      403,
      'invalid_activation_token',
      'invalid',
      'Activation token could not be verified.',
    );
  }
  const ok = safeWriteSetting(
    SETTING_AI_ACTIVATION_TOKEN_ENC,
    encryptJson({ token: trimmed, savedAt: new Date().toISOString() }),
  );
  if (!ok) {
    throw new CloudEntitlementError(
      500,
      'storage_error',
      'unactivated',
      'Failed to persist encrypted activation token.',
    );
  }
  return verified;
}

export function clearSavedActivationToken(): void {
  const current = decryptJson<{ token?: string }>(
    safeReadSetting(SETTING_AI_ACTIVATION_TOKEN_ENC),
  );
  if (current?.token) {
    clearDiskLease(sha256Hex(current.token.trim()));
  }
  safeWriteSetting(SETTING_AI_ACTIVATION_TOKEN_ENC, '');
  activeLeaseRecord = null;
  lastFailureState = null;
}

export function getPendingActivationRequestSummary(): CloudPendingRequestSummary | null {
  const stored = decryptJson<StoredPendingRequestSecret>(
    safeReadSetting(SETTING_AI_PENDING_REQUEST_ENC),
  );
  if (!stored?.requestId) return null;
  return {
    requestId: stored.requestId,
    orgName: stored.orgName,
    contactInfo: stored.contactInfo,
    serverOrigin: stored.serverOrigin,
    status: stored.status,
    decisionNote: stored.decisionNote,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export async function submitActivationRequest(input: {
  orgName: string;
  contactInfo: string;
  serverOrigin?: string;
  note?: string;
}): Promise<CloudPendingRequestSummary> {
  const instanceId = getOrCreateInstanceId();
  const claimSecret = crypto.randomBytes(24).toString('hex');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const baseUrl = getEffectiveBaseUrl();
  const fetchFn = getEffectiveFetch();
  const origin = input.serverOrigin?.trim() || process.env.PUBLIC_APP_URL?.trim() || '';

  const res = await fetchFn(`${baseUrl}/v1/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instanceId,
      orgName: input.orgName.trim(),
      contactInfo: input.contactInfo.trim(),
      serverOrigin: origin,
      note: input.note?.trim() ?? '',
      publicKeySpkiB64: publicKey,
      claimSecret,
    }),
    signal: AbortSignal.timeout(ENTITLEMENT_HTTP_TIMEOUT_MS),
  });

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    requestId?: string;
    status?: 'pending';
    createdAt?: string;
    message?: string;
  } | null;

  if (!res.ok || !body?.ok || !body.requestId) {
    throw new CloudEntitlementError(
      res.status >= 400 && res.status < 500 ? res.status : 502,
      'request_submission_failed',
      'unactivated',
      body?.message || 'Could not submit activation request to entitlement server.',
    );
  }

  const record: StoredPendingRequestSecret = {
    requestId: body.requestId,
    orgName: input.orgName.trim(),
    contactInfo: input.contactInfo.trim(),
    serverOrigin: origin,
    status: 'pending',
    claimSecret,
    privateKeyPem: privateKey,
    createdAt: body.createdAt || new Date().toISOString(),
  };
  safeWriteSetting(SETTING_AI_PENDING_REQUEST_ENC, encryptJson(record));

  return {
    requestId: record.requestId,
    orgName: record.orgName,
    contactInfo: record.contactInfo,
    serverOrigin: record.serverOrigin,
    status: record.status,
    createdAt: record.createdAt,
  };
}

export async function checkActivationRequestApproval(
  serverOrigin?: string,
): Promise<{
  request: CloudPendingRequestSummary;
  activated: boolean;
}> {
  const stored = decryptJson<StoredPendingRequestSecret>(
    safeReadSetting(SETTING_AI_PENDING_REQUEST_ENC),
  );
  if (!stored?.requestId || !stored.claimSecret) {
    throw new CloudEntitlementError(
      404,
      'no_pending_request',
      'unactivated',
      'No pending activation request found on this server.',
    );
  }

  const baseUrl = getEffectiveBaseUrl();
  const fetchFn = getEffectiveFetch();
  const res = await fetchFn(
    `${baseUrl}/v1/requests/${encodeURIComponent(stored.requestId)}/status`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claimSecret: stored.claimSecret }),
      signal: AbortSignal.timeout(ENTITLEMENT_HTTP_TIMEOUT_MS),
    },
  );

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    status?: 'pending' | 'approved' | 'rejected';
    decisionNote?: string;
    encryptedTokenB64?: string | null;
    updatedAt?: string;
    message?: string;
  } | null;

  if (!res.ok || !body?.ok || !body.status) {
    throw new CloudEntitlementError(
      res.status >= 400 && res.status < 500 ? res.status : 502,
      'status_check_failed',
      'unactivated',
      body?.message || 'Failed to check activation request status.',
    );
  }

  stored.status = body.status;
  stored.decisionNote = body.decisionNote;
  stored.updatedAt = body.updatedAt;
  safeWriteSetting(SETTING_AI_PENDING_REQUEST_ENC, encryptJson(stored));

  let activated = false;
  if (body.status === 'approved' && body.encryptedTokenB64 && stored.privateKeyPem) {
    const cipherBytes = Buffer.from(body.encryptedTokenB64, 'base64url');
    const plainBytes = crypto.privateDecrypt(
      {
        key: stored.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      cipherBytes,
    );
    const claimedToken = plainBytes.toString('utf8').trim();
    if (claimedToken.startsWith('flm_act_')) {
      await activateWithToken(claimedToken, serverOrigin);
      activated = true;
    }
  }

  return {
    request: {
      requestId: stored.requestId,
      orgName: stored.orgName,
      contactInfo: stored.contactInfo,
      serverOrigin: stored.serverOrigin,
      status: stored.status,
      decisionNote: stored.decisionNote,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    },
    activated,
  };
}

export async function getCloudEntitlementStatus(options: {
  canManage: boolean;
}): Promise<CloudEntitlementStatusResponse> {
  const configured = resolveConfiguredActivationToken();
  const active = await ensureCloudEntitlementActive();

  if (active) {
    return {
      active: true,
      state: 'active',
      source: configured.source,
      canManage: options.canManage,
      license: {
        label: active.lease.label,
        scopes: active.lease.scopes,
        issuedAt: active.lease.issuedAt,
        expiresAt: active.lease.expiresAt,
      },
      pendingRequest: options.canManage ? getPendingActivationRequestSummary() : null,
      lastError: null,
    };
  }

  const tokenHash = configured.token ? sha256Hex(configured.token) : '';
  const matchedFailure =
    lastFailureState && lastFailureState.tokenHash === tokenHash
      ? lastFailureState
      : null;

  return {
    active: false,
    state: matchedFailure?.state ?? 'unactivated',
    source: configured.source,
    canManage: options.canManage,
    license: null,
    pendingRequest: options.canManage ? getPendingActivationRequestSummary() : null,
    lastError: options.canManage ? matchedFailure?.message ?? null : null,
  };
}

export function startCloudEntitlementBackgroundSync(): void {
  if (process.env[ENV_AI_BACKGROUND_POLL] === '0') return;
  if (backgroundPollTimer) return;

  // Warm immediately on startup if a token is configured
  const { token } = resolveConfiguredActivationToken();
  if (token) {
    void refreshCloudEntitlementLease();
  }

  backgroundPollTimer = setInterval(() => {
    const current = resolveConfiguredActivationToken();
    if (current.token) {
      void refreshCloudEntitlementLease({ forceOnline: true });
    }
  }, LEASE_REFRESH_INTERVAL_MS);
  backgroundPollTimer.unref();
}

/**
 * Test-only hook for unit/integration suites verifying locked, revoked, and RSA auto-claim flows
 * against an isolated local mock server without mutating production constants.
 */
export function configureCloudEntitlementForTesting(
  overrides: EntitlementRuntimeConfig | null,
): void {
  runtimeOverrides = overrides ?? {};
  activeLeaseRecord = overrides?.activeLeaseRecord ?? null;
  lastFailureState = null;
  inflightRefresh = null;
}
