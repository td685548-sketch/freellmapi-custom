import * as runtimeService from './support-runtime.js';
import * as runtimeStore from './support-runtime-store.js';
import * as actionService from './support-action-executor.js';
import * as outboxService from './support-event-outbox.js';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { SessionUser } from '../../services/auth.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import {
  SupportStoreError,
  type SupportTenant,
  type SupportUserContext,
  listSupportTools,
} from './support-store.js';
import { resolveTenant } from './support-router.js';
import { listSupportKnowledgeDocs } from './support-knowledge.js';
import { getSupportMaskingPolicy } from './support-knowledge.js';
import { getSupportGuardrailPolicy } from './support-guardrails.js';
import { resolveCandidateRoutes } from './router.js';
import { resolveAccountProvider } from '../provider-accounts/execution.js';
import { getSupportRuntimeWidgetScript } from './support-runtime-widget.js';
import {
  enqueueSupportPartnerEvent,
  listSupportEventOutbox,
  retrySupportEventDelivery,
  startSupportEventWorker,
} from './support-event-outbox.js';

// ---------------------------------------------------------------------------
// Canonical DTOs (matching shared/support-runtime.ts)
// ---------------------------------------------------------------------------

import type { SupportRuntimePolicy, SupportRuntimeChatInput,
  SupportIntegrationCheck, SupportIntegrationReadiness, SupportOutboxItem } from '@freellmapi/shared/support-runtime.js';
export type { SupportRuntimePolicy, SupportRuntimeChatInput, SupportRuntimeMetadata,
  SupportIntegrationCheck, SupportIntegrationReadiness, SupportOutboxItem } from '@freellmapi/shared/support-runtime.js';

// ---------------------------------------------------------------------------
// Persisted runtime policy
// ---------------------------------------------------------------------------

export function getLocalRuntimePolicy(tenantId: number): SupportRuntimePolicy {
  return runtimeStore.getSupportRuntimePolicy(tenantId);
}
export function setLocalRuntimePolicy(tenantId: number, policy: SupportRuntimePolicy): void {
  runtimeStore.updateSupportRuntimePolicy(tenantId, policy);
}

// ---------------------------------------------------------------------------
// Dynamic Peer Integration Hooks & Fallback Registry
// ---------------------------------------------------------------------------

export type SupportTurnExecutor = (options: {
  tenant: SupportTenant;
  userContext: SupportUserContext;
  input: SupportRuntimeChatInput;
  generate: (context: any) => Promise<any>;
}) => Promise<any>;

export type ActionReviewExecutor = (options: {
  tenantId: number;
  actionId: string;
  decision: 'approved' | 'rejected';
  reviewedBy: string;
  reviewNote?: string;
}) => Promise<any>;

export type EventOutboxDispatcher = (options: {
  tenantId: number;
  event: string;
  payload: Record<string, unknown>;
  dedupKey: string;
}) => string;

export type EventOutboxLister = (tenantId: number) => SupportOutboxItem[];

export type EventOutboxRetrier = (tenantId: number, deliveryId: string) => void;

export type GuestSessionThrottler = (
  tenantId: number,
  trustedClientIp: string,
) => { allowed: boolean; retryAfterSeconds: number };

export type WidgetScriptFactory = () => string;

// Peer binding registry
let customTurnExecutor: SupportTurnExecutor | null = null;
let customActionReviewExecutor: ActionReviewExecutor | null = null;
let customEventDispatcher: EventOutboxDispatcher | null = null;
let customEventOutboxLister: EventOutboxLister | null = null;
let customEventOutboxRetrier: EventOutboxRetrier | null = null;
let customGuestThrottler: GuestSessionThrottler | null = null;
let customWidgetScriptFactory: WidgetScriptFactory | null = null;
let workerStarted = false;
let customWorkerStarter: (() => () => void) | null = null;

export function setTurnExecutor(fn: SupportTurnExecutor | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customTurnExecutor = fn;
}

export function setActionReviewExecutor(fn: ActionReviewExecutor | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customActionReviewExecutor = fn;
}

export function setEventOutboxDispatcher(fn: EventOutboxDispatcher | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customEventDispatcher = fn;
}

export function setEventOutboxLister(fn: EventOutboxLister | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customEventOutboxLister = fn;
}

export function setEventOutboxRetrier(fn: EventOutboxRetrier | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customEventOutboxRetrier = fn;
}

export function setGuestThrottler(fn: GuestSessionThrottler | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customGuestThrottler = fn;
}

export function setWidgetScriptFactory(fn: WidgetScriptFactory | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customWidgetScriptFactory = fn;
}

export function setWorkerStarter(fn: (() => () => void) | null): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test binding is unavailable in production');
  customWorkerStarter = fn;
}

// ---------------------------------------------------------------------------
// Shared service bindings
// ---------------------------------------------------------------------------

export async function resolveSupportRuntimeModule(): Promise<any> { return runtimeService; }

export async function resolveSupportRuntimeStoreModule(): Promise<any> { return runtimeStore; }

export async function resolveSupportActionExecutorModule(): Promise<any> { return actionService; }

export async function resolveSupportEventOutboxModule(): Promise<any> { return outboxService; }

export async function resolveSupportWidgetModule() { return { getSupportRuntimeWidgetScript }; }

// ---------------------------------------------------------------------------
// Service adapters
// ---------------------------------------------------------------------------

export async function dispatchRuntimeTurn(options: {
  tenant: SupportTenant;
  userContext: SupportUserContext;
  input: SupportRuntimeChatInput;
  generate: (context: any) => Promise<any>;
}): Promise<any> {
  if (customTurnExecutor) {
    return await customTurnExecutor(options);
  }
  const runtimeMod = await resolveSupportRuntimeModule();
  if (runtimeMod && typeof runtimeMod.executeSupportTurn === 'function') {
    return await runtimeMod.executeSupportTurn(options);
  }
  throw new SupportStoreError(503, 'Support runtime service unavailable.');
}

export async function dispatchActionReview(options: {
  tenantId: number;
  actionId: string;
  decision: 'approved' | 'rejected';
  reviewedBy: string;
  reviewNote?: string;
}): Promise<any> {
  if (customActionReviewExecutor) {
    return await customActionReviewExecutor(options);
  }
  const actionMod = await resolveSupportActionExecutorModule();
  if (actionMod && typeof actionMod.reviewAndExecuteSupportAction === 'function') {
    return await actionMod.reviewAndExecuteSupportAction(options);
  }
  throw new SupportStoreError(503, 'Action executor service unavailable.');
}

export function dispatchPartnerEvent(options: { tenantId: number; event: string; payload: Record<string, unknown>; dedupKey: string }): string {
  if (customEventDispatcher) return customEventDispatcher(options);
  return enqueueSupportPartnerEvent({ ...options, event: options.event as Parameters<typeof enqueueSupportPartnerEvent>[0]['event'] });
}
export function listPartnerOutbox(tenantId: number, limit = 100): SupportOutboxItem[] {
  return (customEventOutboxLister ? customEventOutboxLister(tenantId) : listSupportEventOutbox(tenantId)).slice(0, limit);
}
export function retryPartnerDelivery(tenantId: number, deliveryId: string): void {
  if (customEventOutboxRetrier) { customEventOutboxRetrier(tenantId, deliveryId); return; }
  retrySupportEventDelivery(tenantId, deliveryId);
}
export function checkGuestThrottle(tenantId: number, trustedClientIp: string): { allowed: boolean; retryAfterSeconds: number } {
  return customGuestThrottler ? customGuestThrottler(tenantId, trustedClientIp) : runtimeStore.consumeSupportGuestSessionIssuance(tenantId, trustedClientIp);
}

export function getWidgetScript(): string {
  return customWidgetScriptFactory ? customWidgetScriptFactory() : getSupportRuntimeWidgetScript();
}

export function startWorkerLifecycle(): () => void {
  if (workerStarted) return () => {};
  const stop = customWorkerStarter ? customWorkerStarter() : startSupportEventWorker();
  workerStarted = true;
  return () => { workerStarted = false; stop(); };
}
export function isWorkerActive(): boolean { return workerStarted && outboxService.getSupportEventWorkerHealth().healthy; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paramStr(val: unknown): string {
  if (Array.isArray(val)) return String(val[0] ?? '');
  return String(val ?? '');
}

function resolveTenantId(param: unknown): number {
  const tenant = resolveTenant(paramStr(param));
  return tenant.id;
}

// ---------------------------------------------------------------------------
// Express Console Router (/api/thruline/support/*)
// ---------------------------------------------------------------------------

export const xSupportRuntimeConsoleRouter = Router();

// Console Auth Middleware
xSupportRuntimeConsoleRouter.use(requireAuth);
xSupportRuntimeConsoleRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const user = (req as Request & { user?: SessionUser }).user;
  if (
    user?.isPrimary ||
    user?.role === 'admin' ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('use_x_gateway') ||
    user?.permissions?.includes('edit_x_settings') ||
    user?.permissions?.includes('manage_x_gateway') ||
    user?.permissions?.includes('x_gateway.support' as never)
  ) {
    next();
    return;
  }
  res.status(403).json({
    error: { message: "Permission denied: 'x_gateway.support' access required.", type: 'forbidden' },
  });
});

function requireEditSettings(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: SessionUser }).user;
  if (
    user?.isPrimary ||
    user?.role === 'admin' ||
    user?.permissions?.includes('*') ||
    user?.permissions?.includes('edit_x_settings') ||
    user?.permissions?.includes('manage_x_gateway')
  ) {
    next();
    return;
  }
  res.status(403).json({
    error: { message: "Permission denied: 'edit_x_settings' permission required.", type: 'forbidden' },
  });
}

// ---------------------------------------------------------------------------
// 1. GET /tenants/:id/runtime
// ---------------------------------------------------------------------------
xSupportRuntimeConsoleRouter.get(
  '/tenants/:id/runtime',
  async (req: Request, res: Response): Promise<void> => {
    let tenantId: number;
    let tenant: SupportTenant;
    try {
      tenant = resolveTenant(paramStr(req.params.id));
      tenantId = tenant.id;
    } catch (err) {
      res.status(404).json({ error: { message: (err as Error).message, status: 404 } });
      return;
    }

    // 1. Tenant Check
    const checks: SupportIntegrationCheck[] = [];
    if (tenant.enabled) {
      checks.push({ id: 'tenant', status: 'ready', code: 'tenant_ready' });
    } else {
      checks.push({ id: 'tenant', status: 'error', code: 'tenant_disabled' });
    }

    // 2. Origins Check
    const allowedOrigins = tenant.allowedOrigins ?? [];
    if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) {
      checks.push({ id: 'origins', status: 'warning', code: 'origins_unrestricted' });
    } else {
      checks.push({ id: 'origins', status: 'ready', code: 'origins_configured' });
    }

    // 3. Model Check (local candidate routes check without calling provider)
    try {
      const { candidates } = resolveCandidateRoutes(tenant.defaultModel || 'auto', 'chat');
      if (candidates.some(candidate => Boolean(resolveAccountProvider(candidate.account)))) {
        checks.push({ id: 'model', status: 'ready', code: 'model_ready' });
      } else {
        checks.push({ id: 'model', status: 'error', code: 'model_no_accounts' });
      }
    } catch {
      checks.push({ id: 'model', status: 'error', code: 'model_check_failed' });
    }

    // 4. Knowledge Check
    try {
      const docs = listSupportKnowledgeDocs(String(tenantId));
      if (docs.length > 0) {
        checks.push({ id: 'knowledge', status: 'ready', code: 'knowledge_ready' });
      } else {
        checks.push({ id: 'knowledge', status: 'warning', code: 'knowledge_empty' });
      }
    } catch {
      checks.push({ id: 'knowledge', status: 'warning', code: 'knowledge_unavailable' });
    }

    // 5. Masking Check
    try {
      const masking = getSupportMaskingPolicy(String(tenantId));
      checks.push({
        id: 'masking',
        status: masking.enabled ? 'ready' : 'warning',
        code: masking.enabled ? 'masking_ready' : 'masking_disabled',
      });
    } catch {
      checks.push({ id: 'masking', status: 'error', code: 'masking_disabled' });
    }

    // 6. Guardrails Check
    try {
      const guardrails = getSupportGuardrailPolicy(String(tenantId));
      checks.push({ id: 'guardrails', status: guardrails.enabled ? 'ready' : 'warning', code: guardrails.enabled ? 'guardrails_ready' : 'guardrails_disabled' });
    } catch {
      checks.push({ id: 'guardrails', status: 'warning', code: 'guardrails_disabled' });
    }

    // 7. Quota Check
    try { runtimeStore.ensureSupportRuntimeTables(); getSupportGuardrailPolicy(String(tenantId)); checks.push({ id: 'quota', status: 'ready', code: 'quota_ready' }); }
    catch { checks.push({ id: 'quota', status: 'error', code: 'quota_unavailable' }); }

    // 8. Approvals Check
    try { actionService.ensureExecutionTables(); checks.push({ id: 'approvals', status: 'ready', code: 'approvals_ready' }); }
    catch { checks.push({ id: 'approvals', status: 'error', code: 'approvals_unavailable' }); }

    // 9. Worker Check
    if (isWorkerActive()) {
      checks.push({ id: 'worker', status: 'ready', code: 'worker_ready' });
    } else {
      checks.push({ id: 'worker', status: 'warning', code: 'worker_missing_heartbeat' });
    }

    const ready = checks.every((c) => c.status !== 'error');

    const policy = runtimeStore.getSupportRuntimePolicy(tenantId);
    const publicBase = new URL(process.env.SUPPORT_PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`);
    if (!['http:', 'https:'].includes(publicBase.protocol) || publicBase.username || publicBase.password || publicBase.search || publicBase.hash) {
      throw new SupportStoreError(400, 'Invalid public server base URL.');
    }
    const serverOrigin = publicBase.toString().replace(/\/$/, '');
    const config = JSON.stringify({ tenantKey: tenant.publicKey, serverBase: serverOrigin, allowGuestSession: tenant.allowGuest }).replace(/</g, '\\u003c');
    const embedSnippet = `<script src="${serverOrigin}/thruline/v1/support/widget.js"></script>\n<script>window.FreeLLMAPISupport.init(${config});</script>`;

    const readiness: SupportIntegrationReadiness = {
      tenantId,
      ready,
      checks,
      runtimePolicy: policy,
      embedSnippet,
    };

    res.json({ ok: true, readiness });
  },
);

// ---------------------------------------------------------------------------
// 2. PUT /tenants/:id/runtime
// ---------------------------------------------------------------------------
xSupportRuntimeConsoleRouter.put(
  '/tenants/:id/runtime',
  requireEditSettings,
  async (req: Request, res: Response): Promise<void> => {
    let tenantId: number;
    try {
      tenantId = resolveTenantId(req.params.id);
    } catch (err) {
      res.status(404).json({ error: { message: (err as Error).message, status: 404 } });
      return;
    }

    const body = req.body ?? {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'Request body must be an object.' } });
      return;
    }

    // Validate unknown keys
    const allowedKeys = new Set([
      'allowedModels',
      'toolPolicies',
      'maxCompletionTokens',
      'maxModelCalls',
      'maxToolCalls',
      'maxContextChars',
      'maxToolResultChars',
      'maxHistoryMessages',
    ]);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        res.status(400).json({
          error: { code: 'invalid_input', message: `Unknown property "${key}" in runtime policy.` },
        });
        return;
      }
    }

    // Validate bounds
    if (body.maxCompletionTokens !== undefined) {
      const v = body.maxCompletionTokens;
      if (!Number.isInteger(v) || v < 1 || v > 4096) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxCompletionTokens must be an integer between 1 and 4096.' },
        });
        return;
      }
    }

    if (body.maxModelCalls !== undefined) {
      const v = body.maxModelCalls;
      if (!Number.isInteger(v) || v < 1 || v > 3) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxModelCalls must be an integer between 1 and 3.' },
        });
        return;
      }
    }

    if (body.maxToolCalls !== undefined) {
      const v = body.maxToolCalls;
      if (!Number.isInteger(v) || v < 0 || v > 3) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxToolCalls must be an integer between 0 and 3.' },
        });
        return;
      }
    }

    if (body.maxContextChars !== undefined) {
      const v = body.maxContextChars;
      if (!Number.isInteger(v) || v < 1000 || v > 32000) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxContextChars must be an integer between 1000 and 32000.' },
        });
        return;
      }
    }

    if (body.maxToolResultChars !== undefined) {
      const v = body.maxToolResultChars;
      if (!Number.isInteger(v) || v < 256 || v > 16000) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxToolResultChars must be an integer between 256 and 16000.' },
        });
        return;
      }
    }

    if (body.maxHistoryMessages !== undefined) {
      const v = body.maxHistoryMessages;
      if (!Number.isInteger(v) || v < 2 || v > 100) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'maxHistoryMessages must be an integer between 2 and 100.' },
        });
        return;
      }
    }

    if (body.allowedModels !== undefined) {
      if (!Array.isArray(body.allowedModels) || !body.allowedModels.every((m: unknown) => typeof m === 'string')) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'allowedModels must be an array of strings.' },
        });
        return;
      }
    }

    // Validate toolPolicies
    if (body.toolPolicies !== undefined) {
      if (!Array.isArray(body.toolPolicies)) {
        res.status(400).json({
          error: { code: 'invalid_input', message: 'toolPolicies must be an array.' },
        });
        return;
      }
      const tenantTools = listSupportTools(tenantId);
      const validToolIds = new Set(tenantTools.map((t) => t.id));
      const seenToolIds = new Set<number>();

      for (const item of body.toolPolicies) {
        if (
          typeof item !== 'object' ||
          item === null ||
          typeof item.toolId !== 'number' ||
          !['read', 'approval_required'].includes(item.mode)
        ) {
          res.status(400).json({
            error: { code: 'invalid_input', message: 'Each toolPolicy must have toolId (number) and mode ("read"|"approval_required").' },
          });
          return;
        }

        // Check duplicates
        if (seenToolIds.has(item.toolId)) {
          res.status(400).json({
            error: { code: 'invalid_input', message: `Duplicate tool policy for toolId ${item.toolId}.` },
          });
          return;
        }
        seenToolIds.add(item.toolId);

        // Check tenant ownership
        if (!validToolIds.has(item.toolId)) {
          res.status(400).json({
            error: { code: 'invalid_input', message: `Tool #${item.toolId} does not belong to tenant #${tenantId}.` },
          });
          return;
        }
      }
    }

    const updatedPolicy = runtimeStore.updateSupportRuntimePolicy(tenantId, body);

    res.json({ ok: true, policy: updatedPolicy });
  },
);

// ---------------------------------------------------------------------------
// 3. GET /tenants/:id/outbox
// ---------------------------------------------------------------------------
xSupportRuntimeConsoleRouter.get(
  '/tenants/:id/outbox',
  async (req: Request, res: Response): Promise<void> => {
    let tenantId: number;
    try {
      tenantId = resolveTenantId(req.params.id);
    } catch (err) {
      res.status(404).json({ error: { message: (err as Error).message, status: 404 } });
      return;
    }

    let limit = 100;
    if (req.query.limit) {
      const parsedLimit = Number(req.query.limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        res.status(400).json({ error: { code: 'invalid_input', message: 'limit must be an integer between 1 and 100.' } });
        return;
      }
      limit = parsedLimit;
    }

    const items = listPartnerOutbox(tenantId, limit);

    res.json({ ok: true, items: items.slice(0, limit) });
  },
);

// ---------------------------------------------------------------------------
// 4. POST /tenants/:id/outbox/:deliveryId/retry
// ---------------------------------------------------------------------------
xSupportRuntimeConsoleRouter.post(
  '/tenants/:id/outbox/:deliveryId/retry',
  requireEditSettings,
  async (req: Request, res: Response): Promise<void> => {
    let tenantId: number;
    try {
      tenantId = resolveTenantId(req.params.id);
    } catch (err) {
      res.status(404).json({ error: { message: (err as Error).message, status: 404 } });
      return;
    }

    const deliveryId = paramStr(req.params.deliveryId);
    try {
      retryPartnerDelivery(tenantId, deliveryId);
      res.json({ ok: true });
    } catch (err) {
      const status = (err as any).status || 409;
      res.status(status).json({
        error: { code: 'action_conflict', message: (err as Error).message },
      });
    }
  },
);

// Error Handler for Runtime Console Router
xSupportRuntimeConsoleRouter.use(
  (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof SupportStoreError) {
      res.status(err.status).json({ error: { message: err.message, status: err.status } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Support runtime console error.';
    res.status(500).json({ error: { message, status: 500 } });
  },
);
